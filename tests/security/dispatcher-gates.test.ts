/**
 * Phase 1 gate and release-blocking invariants for the central dispatcher (spec §16
 * Phase 1, §17 Security, §10):
 *
 * - The hard lock denies registered writes, including work that was already queued.
 * - Generic execution cannot reach an unregistered operation, path, URL or verb.
 * - Revocation and policy changes take effect for work already queued.
 * - No audited operation proceeds without its audit entry; a read result is withheld if
 *   its audit entry cannot be stored; a write outcome is never hidden by a late audit
 *   failure.
 * - Identity comes only from the verified principal, never from the request.
 */
import { OperationRegistry, renderPath, type OperationDescriptor } from '@unifi-local-mcp/core';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import { useTempDirs } from '../unit/storage/fixtures.ts';
import {
  CLIENT,
  CONSOLE,
  deferred,
  DEVICE_A,
  harness,
  inventory,
  listDevices,
  restartDevice,
  SITE,
  updateFirewallRule,
} from '../unit/core/fixtures.ts';

const tempDir = useTempDirs();

const RESTART = {
  operationId: 'network.devices.restart',
  consoleId: CONSOLE,
  siteId: SITE,
  arguments: { deviceId: DEVICE_A },
};

describe('hard read-only lock', () => {
  it('denies a registered write through generic execution, before anything is recorded or sent', async () => {
    const h = await harness({ dir: await tempDir(), forceReadOnly: true });
    const envelope = await h.dispatcher.execute(CLIENT, RESTART);
    expect(envelope).toMatchObject({ status: 'denied', error: { code: 'hard_read_only' } });
    expect(envelope.executionId).toBeUndefined();
    expect(h.executor.calls).toEqual([]);
    expect(h.storage.db.get('SELECT count(*) AS n FROM operation_executions')?.['n']).toBe(0);
    h.storage.close();
  });

  it('denies queued writes when read-only mode is switched on while they wait', async () => {
    const h = await harness({ dir: await tempDir() });
    const gate = deferred();
    h.executor.handler = async () => {
      await gate.promise;
      return { ok: true, data: { accepted: true } };
    };
    const first = h.dispatcher.execute(CLIENT, RESTART);
    const queued = h.dispatcher.execute(CLIENT, RESTART); // waits for the device lock
    await vi.waitFor(() => {
      expect(h.executor.calls).toHaveLength(1);
    });
    h.policyStore.setRuntimeMode('read_only', { type: 'cli' });
    gate.resolve();
    expect((await first).outcome).toBe('succeeded');
    const denied = await queued;
    expect(denied).toMatchObject({
      status: 'denied',
      outcome: 'denied',
      error: { code: 'runtime_read_only' },
    });
    expect(h.executions.get(denied.executionId ?? '')?.status).toBe('denied');
    expect(h.executor.calls).toHaveLength(1);
    h.storage.close();
  });
});

describe('generic execution cannot escape the registry', () => {
  it('rejects unregistered operations and smuggled URL, method, header or path arguments', async () => {
    const h = await harness({ dir: await tempDir() });
    const attempts = [
      {
        operationId: 'network.raw.request',
        consoleId: CONSOLE,
        arguments: { url: 'https://api.ui.com/' },
      },
      { ...RESTART, arguments: { deviceId: DEVICE_A, method: 'DELETE' } },
      { ...RESTART, arguments: { deviceId: DEVICE_A, headers: { 'x-api-key': 'k' } } },
      { ...RESTART, arguments: { deviceId: '../../../v2/admin' } },
      { ...RESTART, arguments: { deviceId: DEVICE_A, path: '/v1/anything' } },
      { ...RESTART, baseUrl: 'https://evil.invalid' },
    ];
    for (const attempt of attempts) {
      const envelope = await h.dispatcher.execute(CLIENT, attempt);
      expect(envelope.status, JSON.stringify(attempt)).toBe('error');
    }
    expect(h.executor.calls).toEqual([]);
    h.storage.close();
  });

  it('refuses to register an operation that is not in the official contract', () => {
    const registry = new OperationRegistry(inventory);
    expect(() => {
      registry.register({
        ...restartDevice,
        operationId: 'network.devices.wipe',
        pathTemplate: '/v1/sites/{siteId}/devices/{deviceId}/wipe',
      });
    }).toThrow(/not in the official network 1.0 contract/);
    expect(() => {
      registry.register({ ...restartDevice, httpMethod: 'DELETE' });
    }).toThrow(/not in the official/);
    expect(() => {
      registry.register({ ...restartDevice, inputSchema: z.object({ deviceId: z.string() }) });
    }).toThrow(/strict object schema/);
  });

  it('accepts a JSON body only as the single body argument (ADR 0018)', () => {
    const registry = new OperationRegistry(inventory);
    // Deliberately invalid descriptors, built without the type checker's help.
    const invalid = (changes: Record<string, unknown>, base: object): OperationDescriptor =>
      Object.fromEntries(
        Object.entries({ ...base, ...changes }).filter(([, value]) => value !== undefined),
      ) as unknown as OperationDescriptor;
    expect(() => {
      registry.register(
        invalid(
          { inputSchema: z.strictObject({ ruleId: z.uuid(), action: z.string() }) },
          updateFirewallRule,
        ),
      );
    }).toThrow(/needs a "body" argument.*argument action has no place/);
    expect(() => {
      registry.register(
        invalid(
          {
            requestBody: undefined,
            inputSchema: z.strictObject({ ruleId: z.uuid(), body: z.strictObject({}) }),
          },
          updateFirewallRule,
        ),
      );
    }).toThrow(/argument body has no place/);
    expect(() => {
      registry.register(
        invalid(
          { queryParameters: ['body'], inputSchema: z.strictObject({ body: z.string() }) },
          listDevices,
        ),
      );
    }).toThrow(/"body" is reserved/);
  });

  it('encodes every path value as exactly one segment', () => {
    expect(
      renderPath('/v1/sites/{siteId}/devices/{deviceId}', {
        siteId: 'a/b',
        deviceId: '..%2f?x=1#y',
      }),
    ).toBe('/v1/sites/a%2Fb/devices/..%252f%3Fx%3D1%23y');
    expect(() => renderPath('/v1/{id}', { id: '..' })).toThrow();
    expect(() => renderPath('/v1/{id}', {})).toThrow(/Missing/);
  });
});

describe('revocation', () => {
  it('stops a revoked client’s queued write before it is sent', async () => {
    const h = await harness({ dir: await tempDir() });
    const gate = deferred();
    h.executor.handler = async () => {
      await gate.promise;
      return { ok: true, data: { accepted: true } };
    };
    const first = h.dispatcher.execute(CLIENT, RESTART);
    const queued = h.dispatcher.execute(CLIENT, RESTART);
    await vi.waitFor(() => {
      expect(h.executor.calls).toHaveLength(1);
    });
    const client = h.clients.get(CLIENT.clientId);
    if (client) client.status = 'revoked';
    gate.resolve();
    await first;
    expect(await queued).toMatchObject({ status: 'denied', error: { code: 'client_inactive' } });
    expect(h.executor.calls).toHaveLength(1);
    h.storage.close();
  });

  it('stops a revoked client’s queued read before it is sent', async () => {
    const h = await harness({
      dir: await tempDir(),
      limits: {
        scheduler: {
          globalConcurrency: 1,
          perKeyConcurrency: 1,
          globalQueue: 10,
          perKeyQueue: 10,
          perClientQueued: 10,
        },
      },
    });
    const gate = deferred();
    h.executor.handler = async () => {
      await gate.promise;
      return { ok: true, data: { version: '1' } };
    };
    const info = { operationId: 'network.info.get', consoleId: CONSOLE };
    const running = h.dispatcher.execute(CLIENT, info);
    await vi.waitFor(() => {
      expect(h.executor.calls).toHaveLength(1);
    });
    const queued = h.dispatcher.execute(CLIENT, info);
    const client = h.clients.get(CLIENT.clientId);
    if (client) client.status = 'revoked';
    gate.resolve();
    await running;
    expect(await queued).toMatchObject({ status: 'denied', error: { code: 'client_inactive' } });
    expect(h.executor.calls).toHaveLength(1);
    h.storage.close();
  });

  it('cancels a client’s work waiting in the queue', async () => {
    const h = await harness({
      dir: await tempDir(),
      limits: {
        scheduler: {
          globalConcurrency: 1,
          perKeyConcurrency: 1,
          globalQueue: 10,
          perKeyQueue: 10,
          perClientQueued: 10,
        },
      },
    });
    const gate = deferred();
    h.executor.handler = async () => {
      await gate.promise;
      return { ok: true, data: { version: '1' } };
    };
    const running = h.dispatcher.execute(CLIENT, {
      operationId: 'network.info.get',
      consoleId: CONSOLE,
    });
    await vi.waitFor(() => {
      expect(h.executor.calls).toHaveLength(1);
    });
    const waiting = h.dispatcher.execute(CLIENT, RESTART);
    await vi.waitFor(() => {
      expect(h.dispatcher.cancelClient(CLIENT.clientId)).toBe(1);
    });
    const cancelled = await waiting;
    expect(cancelled).toMatchObject({
      status: 'error',
      outcome: 'cancelled',
      error: { code: 'cancelled' },
    });
    gate.resolve();
    await running;
    expect(h.executor.calls).toHaveLength(1);
    h.storage.close();
  });
});

describe('durable state transitions', () => {
  it('never sends a write whose record was closed elsewhere while it waited', async () => {
    const h = await harness({ dir: await tempDir() });
    const gate = deferred();
    h.executor.handler = async () => {
      await gate.promise;
      return { ok: true, data: { accepted: true } };
    };
    const first = h.dispatcher.execute(CLIENT, RESTART);
    const second = h.dispatcher.execute(CLIENT, RESTART); // waits for the device lock
    await vi.waitFor(() => {
      expect(h.executor.calls).toHaveLength(1);
    });
    // Another process (for example an administrator) closes the waiting execution.
    const waiting = h.storage.db.get("SELECT id FROM operation_executions WHERE status = 'queued'");
    const waitingId = String(waiting?.['id']);
    expect(h.executions.transition(waitingId, 'queued', 'cancelled', 'admin_cancelled')).toBe(true);
    gate.resolve();
    await first;
    expect(await second).toMatchObject({
      status: 'error',
      outcome: 'cancelled',
      executionId: waitingId,
    });
    expect(h.executor.calls).toHaveLength(1);
    expect(h.executions.get(waitingId)?.status).toBe('cancelled');
    h.storage.close();
  });
});

describe('audit before act', () => {
  it('does not send a write whose pending audit entry cannot be stored', async () => {
    const h = await harness({ dir: await tempDir() });
    h.audit.failWhen = (event) => event.action === 'operation.enqueue';
    const envelope = await h.dispatcher.execute(CLIENT, RESTART);
    expect(envelope).toMatchObject({ status: 'error', error: { code: 'audit_unavailable' } });
    expect(h.executor.calls).toEqual([]);
    expect(h.storage.db.get('SELECT count(*) AS n FROM operation_executions')?.['n']).toBe(0);
    h.storage.close();
  });

  it('withholds read data whose audit entry cannot be stored', async () => {
    const h = await harness({ dir: await tempDir() });
    h.audit.failWhen = () => true;
    const envelope = await h.dispatcher.execute(CLIENT, {
      operationId: 'network.devices.list',
      consoleId: CONSOLE,
      siteId: SITE,
    });
    expect(envelope).toMatchObject({ status: 'error', error: { code: 'audit_unavailable' } });
    expect(envelope.data).toBeUndefined();
    h.storage.close();
  });

  it('still reports a write that ran when only its final audit entry fails', async () => {
    const h = await harness({ dir: await tempDir() });
    h.audit.failWhen = (event) =>
      event.action === 'operation.execute' && event.outcome === 'success';
    const envelope = await h.dispatcher.execute(CLIENT, RESTART);
    expect(envelope).toMatchObject({ status: 'ok', outcome: 'succeeded' });
    expect(envelope.executionId).toBeDefined();
    expect(envelope.warnings?.[0]).toMatch(/audit entry could not be written/);
    expect(h.executions.get(envelope.executionId ?? '')?.status).toBe('succeeded');
    h.storage.close();
  });
});

describe('identity', () => {
  it('ignores nothing silently: a client id in the request is rejected outright', async () => {
    const h = await harness({ dir: await tempDir() });
    const envelope = await h.dispatcher.execute(CLIENT, { ...RESTART, clientId: 'admin' } as never);
    expect(envelope.error?.code).toBe('invalid_request');
    expect(h.executor.calls).toEqual([]);
    h.storage.close();
  });
});
