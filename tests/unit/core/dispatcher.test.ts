/**
 * The central dispatcher (spec §5.2, §6.1, §10; ADR 0010).
 */
import type { ExecutionEnvelope } from '@unifi-local-mcp/core';
import { describe, expect, it, vi } from 'vitest';
import { useTempDirs } from '../storage/fixtures.ts';
import {
  CLIENT,
  CONSOLE,
  deferred,
  DEVICE_A,
  DEVICE_B,
  harness,
  SITE,
  type HarnessOptions,
} from './fixtures.ts';

const tempDir = useTempDirs();

async function setup(options: Omit<HarnessOptions, 'dir'> = {}) {
  return harness({ ...options, dir: await tempDir() });
}

const LIST = { operationId: 'network.devices.list', consoleId: CONSOLE, siteId: SITE };
const RESTART = (deviceId = DEVICE_A, idempotencyKey?: string) => ({
  operationId: 'network.devices.restart',
  consoleId: CONSOLE,
  siteId: SITE,
  arguments: { deviceId },
  ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
});

function expectError(envelope: ExecutionEnvelope, code: string): void {
  expect(envelope.status === 'error' || envelope.status === 'denied').toBe(true);
  expect(envelope.error?.code).toBe(code);
  expect(envelope.data).toBeUndefined();
}

describe('reads', () => {
  it('validate, authorise, call upstream once, project and audit', async () => {
    const h = await setup();
    const envelope = await h.dispatcher.execute(CLIENT, { ...LIST, arguments: { limit: 5 } });
    expect(envelope).toMatchObject({
      status: 'ok',
      operationId: 'network.devices.list',
      consoleId: CONSOLE,
      siteId: SITE,
      data: [
        { id: DEVICE_A, name: 'Office AP' },
        { id: DEVICE_B, name: 'Lobby AP' },
      ],
    });
    expect(JSON.stringify(envelope)).not.toContain('macAddress');
    expect(h.executor.calls).toHaveLength(1);
    expect(h.executor.calls[0]).toMatchObject({
      arguments: { limit: 5 },
      target: { consoleId: CONSOLE, siteId: SITE },
      correlationId: envelope.correlationId,
      attempt: 1,
    });
    expect(h.audit.list({ limit: 1 })[0]).toMatchObject({
      action: 'operation.execute',
      outcome: 'success',
      actorType: 'mcp_client',
      actorId: CLIENT.clientId,
      consoleId: CONSOLE,
      application: 'network',
      operationId: 'network.devices.list',
      correlationId: envelope.correlationId,
    });
    h.storage.close();
  });

  it('refuse unknown operations, malformed requests, arguments and targets before upstream', async () => {
    const h = await setup();
    const cases: [object, string][] = [
      [{ operationId: 'network.devices.nuke', consoleId: CONSOLE }, 'unknown_operation'],
      [{ operationId: 'Not An Id', consoleId: CONSOLE }, 'unknown_operation'],
      [{ ...LIST, clientId: 'someone-else' }, 'invalid_request'],
      [{ ...LIST, arguments: { limit: 5, url: 'https://elsewhere.invalid' } }, 'invalid_arguments'],
      [{ ...LIST, arguments: { limit: 'all' } }, 'invalid_arguments'],
      [{ operationId: 'network.devices.list', siteId: SITE }, 'invalid_target'],
      [{ ...LIST, consoleId: '../../etc' }, 'invalid_target'],
      [{ operationId: 'network.info.get', consoleId: CONSOLE, siteId: SITE }, 'invalid_target'],
      [{ ...LIST, idempotencyKey: 'k1' }, 'invalid_request'],
    ];
    for (const [request, code] of cases) {
      expectError(await h.dispatcher.execute(CLIENT, request as never), code);
    }
    expect(h.executor.calls).toEqual([]);
    const issues = (await h.dispatcher.execute(CLIENT, { ...LIST, arguments: { limit: 0, x: 1 } }))
      .error?.issues;
    expect(issues?.map((issue) => issue.path).sort()).toEqual(['(root)', 'limit']);
    h.storage.close();
  });

  it('deny by policy and audit the denial', async () => {
    const h = await setup();
    const client = h.clients.get(CLIENT.clientId);
    if (client) client.allow = ['network.info.read'];
    const envelope = await h.dispatcher.execute(CLIENT, LIST);
    expect(envelope).toMatchObject({ status: 'denied', error: { code: 'not_granted_to_client' } });
    expect(h.executor.calls).toEqual([]);
    expect(h.audit.list({ limit: 1 })[0]).toMatchObject({
      outcome: 'denied',
      errorCode: 'not_granted_to_client',
      details: { stage: 6, effect: 'read' },
    });
    h.storage.close();
  });

  it('withhold responses that do not match the documented schema', async () => {
    const h = await setup();
    h.executor.handler = () => ({ ok: true, data: { data: [{ id: 1 }] } });
    expectError(await h.dispatcher.execute(CLIENT, LIST), 'upstream_contract_mismatch');
    h.storage.close();
  });

  it('retry transient failures with backoff, but not permanent ones', async () => {
    const h = await setup();
    let failures = 2;
    h.executor.handler = () =>
      failures-- > 0
        ? { ok: false, error: { code: 'busy', message: 'try later', transient: true } }
        : { ok: true, data: { version: '1' } };
    const ok = await h.dispatcher.execute(CLIENT, {
      operationId: 'network.info.get',
      consoleId: CONSOLE,
    });
    expect(ok.status).toBe('ok');
    expect(h.executor.calls.map((c) => c.attempt)).toEqual([1, 2, 3]);

    h.executor.calls.length = 0;
    h.executor.handler = () => ({
      ok: false,
      error: { code: 'api.not-found', message: 'Not found: Bearer abc123' },
    });
    const failed = await h.dispatcher.execute(CLIENT, {
      operationId: 'network.info.get',
      consoleId: CONSOLE,
    });
    expect(failed.error).toEqual({
      code: 'api.not-found',
      message: 'Not found: Bearer [REDACTED]',
    });
    expect(h.executor.calls).toHaveLength(1);
    h.storage.close();
  });

  it('time out a console that does not answer', async () => {
    const h = await setup({ limits: { readRetries: 0 } });
    h.executor.handler = (call) =>
      new Promise((_resolve, reject) => {
        call.signal.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    const started = Date.now();
    const envelope = await h.dispatcher.execute(CLIENT, {
      operationId: 'network.info.get',
      consoleId: CONSOLE,
    });
    expectError(envelope, 'upstream_timeout');
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(h.executor.calls[0]?.signal.aborted).toBe(true);
    h.storage.close();
  });
});

describe('writes', () => {
  it('record a durable execution, audit before and after, and report it to its client only', async () => {
    const h = await setup();
    const envelope = await h.dispatcher.execute(CLIENT, RESTART());
    expect(envelope).toMatchObject({
      status: 'ok',
      outcome: 'succeeded',
      data: { accepted: true },
    });
    const executionId = envelope.executionId ?? '';
    expect(h.executions.get(executionId)).toMatchObject({
      status: 'succeeded',
      clientId: CLIENT.clientId,
      operationId: 'network.devices.restart',
      policyVersion: 2,
    });
    expect(h.auditActions()).toEqual(['operation.enqueue:pending', 'operation.execute:success']);
    expect(h.dispatcher.status(CLIENT, executionId)).toMatchObject({ outcome: 'succeeded' });
    expect(h.dispatcher.status({ clientId: 'client-2' }, executionId)).toBeUndefined();
    expect(h.dispatcher.status(CLIENT, 'not-an-id')).toBeUndefined();
    h.storage.close();
  });

  it('report definite upstream failures as failed', async () => {
    const h = await setup();
    h.executor.handler = () => ({
      ok: false,
      error: { code: 'api.validation', message: 'Device is offline' },
    });
    const envelope = await h.dispatcher.execute(CLIENT, RESTART());
    expect(envelope).toMatchObject({
      status: 'error',
      outcome: 'failed',
      error: { code: 'api.validation', message: 'Device is offline' },
    });
    expect(h.executions.get(envelope.executionId ?? '')?.status).toBe('failed');
    h.storage.close();
  });

  it.each([
    [
      'an uncertain upstream error',
      () => ({
        ok: false,
        error: {
          code: 'http.502',
          message: 'Bad gateway',
          outcomeUncertain: true,
          transient: true,
        },
      }),
    ],
    ['an executor exception', () => Promise.reject(new Error('socket hang up'))],
  ])('record %s as outcome_unknown and never retry it', async (_name, handler) => {
    const h = await setup();
    h.executor.handler = handler as never;
    const envelope = await h.dispatcher.execute(CLIENT, RESTART());
    expect(envelope).toMatchObject({
      status: 'error',
      outcome: 'outcome_unknown',
      error: { code: 'outcome_unknown' },
    });
    expect(h.executor.calls).toHaveLength(1);
    expect(h.executions.get(envelope.executionId ?? '')?.status).toBe('outcome_unknown');
    expect(h.log.records().some((r) => r['msg'] === 'write outcome unknown; not retried')).toBe(
      true,
    );
    h.storage.close();
  });

  it('retry a write only when the request provably was not sent', async () => {
    const h = await setup();
    let first = true;
    h.executor.handler = () => {
      if (!first) return { ok: true, data: { accepted: true } };
      first = false;
      return {
        ok: false,
        error: { code: 'econnrefused', message: 'refused', requestNotSent: true },
      };
    };
    const envelope = await h.dispatcher.execute(CLIENT, RESTART());
    expect(envelope.outcome).toBe('succeeded');
    expect(h.executor.calls).toHaveLength(2);
    h.storage.close();
  });

  it('replay a repeated idempotency key instead of executing again', async () => {
    const h = await setup();
    const first = await h.dispatcher.execute(CLIENT, RESTART(DEVICE_A, 'restart-1'));
    const again = await h.dispatcher.execute(CLIENT, RESTART(DEVICE_A, 'restart-1'));
    expect(again).toMatchObject({
      status: 'ok',
      outcome: 'succeeded',
      executionId: first.executionId,
    });
    expect(again.warnings?.[0]).toMatch(/nothing was re-executed/);
    expect(h.executor.calls).toHaveLength(1);
    expectError(
      await h.dispatcher.execute(CLIENT, RESTART(DEVICE_B, 'restart-1')),
      'idempotency_key_conflict',
    );
    // Keys are per client.
    const original = h.clients.get(CLIENT.clientId);
    if (original === undefined) throw new Error('missing client');
    h.clients.set('client-2', { ...original, clientId: 'client-2' });
    const other = await h.dispatcher.execute(
      { clientId: 'client-2' },
      RESTART(DEVICE_A, 'restart-1'),
    );
    expect(other.executionId).not.toBe(first.executionId);
    h.storage.close();
  });

  it('collapses concurrent requests with the same idempotency key', async () => {
    const h = await setup();
    const gate = deferred();
    h.executor.handler = async () => {
      await gate.promise;
      return { ok: true, data: { accepted: true } };
    };
    const first = h.dispatcher.execute(CLIENT, RESTART(DEVICE_A, 'same'));
    const second = await h.dispatcher.execute(CLIENT, RESTART(DEVICE_A, 'same'));
    expect(second.status).toBe('pending');
    gate.resolve();
    expect((await first).outcome).toBe('succeeded');
    expect(h.executor.calls).toHaveLength(1);
    h.storage.close();
  });

  it('serialise conflicting writes on the same resource, not on different ones', async () => {
    const h = await setup();
    const gates = [deferred(), deferred(), deferred()];
    const order: string[] = [];
    h.executor.handler = async (call) => {
      const index = order.length;
      order.push(String(call.arguments['deviceId']));
      await gates[index]?.promise;
      return { ok: true, data: { accepted: true } };
    };
    const a1 = h.dispatcher.execute(CLIENT, RESTART(DEVICE_A));
    const a2 = h.dispatcher.execute(CLIENT, RESTART(DEVICE_A));
    const b1 = h.dispatcher.execute(CLIENT, RESTART(DEVICE_B));
    await vi.waitFor(() => {
      expect(order).toEqual([DEVICE_A, DEVICE_B]);
    });
    gates[0]?.resolve();
    await a1;
    await vi.waitFor(() => {
      expect(order).toEqual([DEVICE_A, DEVICE_B, DEVICE_A]);
    });
    gates[1]?.resolve();
    gates[2]?.resolve();
    await Promise.all([a2, b1]);
    h.storage.close();
  });

  it('route high-risk operations to the approval gate without executing them', async () => {
    const withoutGate = await setup();
    const denied = await withoutGate.dispatcher.execute(CLIENT, {
      operationId: 'network.gateway.reboot',
      consoleId: CONSOLE,
      siteId: SITE,
    });
    expect(denied).toMatchObject({ status: 'denied', error: { code: 'approval_unavailable' } });
    expect(withoutGate.executor.calls).toEqual([]);
    withoutGate.storage.close();

    const propose = vi.fn(() => ({
      status: 'approval_required' as const,
      operationId: 'network.gateway.reboot',
      consoleId: CONSOLE,
      siteId: SITE,
      correlationId: 'c',
      approvalId: 'approval-1',
    }));
    const h = await setup({ approvals: { propose } });
    const envelope = await h.dispatcher.execute(CLIENT, {
      operationId: 'network.gateway.reboot',
      consoleId: CONSOLE,
      siteId: SITE,
    });
    expect(envelope.status).toBe('approval_required');
    expect(propose).toHaveBeenCalledWith(
      expect.objectContaining({
        argumentsSha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
        policyVersion: 2,
        target: { consoleId: CONSOLE, siteId: SITE },
      }),
    );
    expect(h.executor.calls).toEqual([]);
    h.storage.close();
  });
});

describe('limits', () => {
  it('rate-limit per client without creating an execution', async () => {
    const h = await setup({
      limits: {
        rate: {
          client: { ratePerSecond: 0.01, burst: 1 },
          console: { ratePerSecond: 100, burst: 100 },
          module: { ratePerSecond: 100, burst: 100 },
          global: { ratePerSecond: 100, burst: 100 },
        },
      },
    });
    expect((await h.dispatcher.execute(CLIENT, RESTART())).status).toBe('ok');
    const limited = await h.dispatcher.execute(CLIENT, RESTART(DEVICE_B));
    expect(limited).toMatchObject({ status: 'error', error: { code: 'rate_limited' } });
    expect(limited.error?.retryAfterMs).toBeGreaterThan(0);
    expect(limited.executionId).toBeUndefined();
    expect(h.executor.calls).toHaveLength(1);
    h.storage.close();
  });

  it('refuse work when the queue is full', async () => {
    const h = await setup({
      limits: {
        scheduler: {
          globalConcurrency: 1,
          perKeyConcurrency: 1,
          globalQueue: 0,
          perKeyQueue: 0,
          perClientQueued: 0,
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
    const full = await h.dispatcher.execute(CLIENT, RESTART());
    expect(full).toMatchObject({
      status: 'error',
      outcome: 'cancelled',
      error: { code: 'queue_full' },
    });
    expect(h.executions.get(full.executionId ?? '')?.status).toBe('cancelled');
    gate.resolve();
    await running;
    h.storage.close();
  });
});

describe('recovery and shutdown', () => {
  it('never re-runs executions interrupted by a restart', async () => {
    const h = await setup();
    const base = {
      clientId: CLIENT.clientId,
      operationId: 'network.devices.restart',
      consoleId: CONSOLE,
      siteId: SITE,
      argumentsSha256: 'a'.repeat(64),
      idempotencyKey: undefined,
      policyVersion: 2,
      correlationId: 'corr',
    };
    const queued = h.executions.create(base);
    const executing = h.executions.create(base);
    h.executions.transition(executing.id, 'queued', 'executing');
    expect(h.dispatcher.recoverInterrupted()).toEqual({ outcomeUnknown: 1, cancelled: 1 });
    expect(h.executions.get(queued.id)?.status).toBe('cancelled');
    expect(h.executions.get(executing.id)).toMatchObject({
      status: 'outcome_unknown',
      errorCode: 'service_restarted',
    });
    expect(h.dispatcher.recoverInterrupted()).toEqual({ outcomeUnknown: 0, cancelled: 0 });
    expect(h.executor.calls).toEqual([]);
    h.storage.close();
  });

  it('refuses new work after drain', async () => {
    const h = await setup();
    await h.dispatcher.drain();
    expectError(await h.dispatcher.execute(CLIENT, LIST), 'shutting_down');
    h.storage.close();
  });

  it('denies everything while the stored policy is invalid', async () => {
    const h = await setup();
    h.storage.db.run(`UPDATE security_policy SET document = '{"runtimeMode":"chaos"}'`);
    const envelope = await h.dispatcher.execute(CLIENT, LIST);
    expect(envelope).toMatchObject({ status: 'denied', error: { code: 'policy_unavailable' } });
    expect(h.executor.calls).toEqual([]);
    h.storage.close();
  });
});
