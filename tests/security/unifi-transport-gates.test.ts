/**
 * Phase 1 gate and release-blocking invariants at the network level (spec §16 Phase 1,
 * §17 Security, §4.4): dispatcher → registry → UniFi executor → synthetic HTTPS console.
 *
 * - Generic execution cannot reach an unregistered path, alternate URL or arbitrary verb:
 *   the console receives only registered method/path pairs under the module base path.
 * - Argument values cannot add path segments, change the host, or add headers.
 * - Without an observed, compatible application version, nothing is sent.
 * - Credentials never appear in envelopes, logs or the audit trail.
 */
import {
  Dispatcher,
  ExecutionStore,
  OperationRegistry,
  type OperationDescriptor,
} from '@unifi-local-mcp/core';
import { ClientPolicySchema } from '@unifi-local-mcp/policy';
import { describe, expect, it } from 'vitest';
import { sendJson } from '../fixtures/mock-console.ts';
import {
  CLIENT,
  getInfo,
  inventory,
  listDevices,
  restartDevice,
  TEST_LIMITS,
} from '../unit/core/fixtures.ts';
import { useTempDirs } from '../unit/storage/fixtures.ts';
import { CLI, unifiHarness } from '../unit/unifi-api/fixtures.ts';

const tempDir = useTempDirs();

async function stack() {
  const h = await unifiHarness({ dir: await tempDir() });
  h.policyStore.setRuntimeMode('read_write', CLI);
  h.consoles.setPolicy(h.consoleId, { modules: { network: { state: 'read_write' } } }, CLI);
  h.consoles.recordObservedVersion(h.consoleId, 'network', '1.0.5');
  const registry = new OperationRegistry(inventory);
  for (const descriptor of [listDevices, getInfo, restartDevice] as OperationDescriptor[]) {
    registry.register(descriptor);
  }
  registry.seal();
  const client = ClientPolicySchema.parse({
    clientId: CLIENT.clientId,
    consoles: { [h.consoleId]: { sites: '*' } },
    allow: ['network.*.*'],
  });
  const dispatcher = new Dispatcher({
    registry,
    executor: h.executor,
    security: {
      clientPolicy: (id) => (id === client.clientId ? client : undefined),
      consolePolicy: (id) => h.consoles.policy(id),
      capability: (id, descriptor) => h.consoles.capability(id, descriptor),
    },
    policyStore: h.policyStore,
    deployment: { forceReadOnly: false },
    audit: h.audit,
    executions: new ExecutionStore(h.storage.db),
    logger: h.log.logger,
    limits: TEST_LIMITS,
  });
  h.mock.respond = (request, response) => {
    if (request.url.includes('/devices?') || request.url.endsWith('/devices')) {
      sendJson(response, 200, {
        data: [{ id: 'd1', name: 'AP', macAddress: '00:00:5e:00:53:01' }],
      });
    } else if (request.url.endsWith('/v1/info')) {
      sendJson(response, 200, { version: '1.0.5' });
    } else {
      sendJson(response, 200, { accepted: true });
    }
  };
  return { ...h, dispatcher };
}

describe('generic execution over HTTPS', () => {
  it('reaches only registered method/path pairs on the configured console', async () => {
    const s = await stack();
    const ok = await s.dispatcher.execute(CLIENT, {
      operationId: 'network.devices.list',
      consoleId: s.consoleId,
      siteId: 'site-1',
      arguments: { limit: 3 },
    });
    expect(ok).toMatchObject({ status: 'ok', data: [{ id: 'd1', name: 'AP' }] });

    const attempts: object[] = [
      { operationId: 'network.anything.delete', consoleId: s.consoleId },
      {
        operationId: 'network.devices.list',
        consoleId: s.consoleId,
        siteId: 'site-1',
        arguments: { url: 'https://api.ui.com/' },
      },
      {
        operationId: 'network.devices.list',
        consoleId: s.consoleId,
        siteId: 'site-1',
        arguments: { limit: 3 },
        method: 'DELETE',
      },
      {
        operationId: 'network.devices.list',
        consoleId: s.consoleId,
        siteId: 'site-1',
        arguments: { limit: 3 },
        headers: { 'x-api-key': 'x' },
      },
    ];
    for (const attempt of attempts) {
      expect((await s.dispatcher.execute(CLIENT, attempt as never)).status).toBe('error');
    }
    expect(s.mock.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET /proxy/network/integration/v1/sites/site-1/devices?limit=3',
    ]);
    await s.close();
  });

  it('keeps hostile identifiers inside one path segment', async () => {
    const s = await stack();
    await s.dispatcher.execute(CLIENT, {
      operationId: 'network.devices.list',
      consoleId: s.consoleId,
      siteId: 'site-1..%2f',
    });
    // The siteId format check refuses this before anything is sent ...
    expect(s.mock.requests).toEqual([]);
    // ... and even a permitted id with dots stays one encoded segment.
    await s.dispatcher.execute(CLIENT, {
      operationId: 'network.devices.list',
      consoleId: s.consoleId,
      siteId: 'a.b:c',
    });
    expect(s.mock.requests.map((r) => r.url)).toEqual([
      '/proxy/network/integration/v1/sites/a.b%3Ac/devices',
    ]);
    await s.close();
  });

  it('sends nothing while the console version is unknown or incompatible', async () => {
    const s = await stack();
    for (const version of ['garbage', '2.0.0']) {
      s.consoles.recordObservedVersion(s.consoleId, 'network', version);
      const envelope = await s.dispatcher.execute(CLIENT, {
        operationId: 'network.info.get',
        consoleId: s.consoleId,
      });
      expect(envelope).toMatchObject({
        status: 'denied',
        error: { code: 'operation_unsupported' },
      });
    }
    expect(s.mock.requests).toEqual([]);
    await s.close();
  });

  it('never exposes the credential', async () => {
    const s = await stack();
    const envelope = await s.dispatcher.execute(CLIENT, {
      operationId: 'network.info.get',
      consoleId: s.consoleId,
    });
    expect(envelope.status).toBe('ok');
    s.mock.respond = (_request, response) => {
      sendJson(response, 401, { code: 'api.authentication.invalid' });
    };
    const denied = await s.dispatcher.execute(CLIENT, {
      operationId: 'network.info.get',
      consoleId: s.consoleId,
    });
    expect(denied.error?.code).toBe('upstream_unauthorized');
    const everything =
      JSON.stringify([envelope, denied, s.audit.list({ limit: 500 })]) + s.log.lines.join('');
    expect(everything).not.toContain('SENTINEL');
    await s.close();
  });
});
