/**
 * The service learns console versions on its own (ADR 0018 §3): with the real Network
 * adapter and contract inventory, an enabled module is probed shortly after start, its
 * operations then appear and run, and an incompatible version hides and refuses them.
 */
import { join } from 'node:path';
import { loadServiceConfig, startService } from '@unifi-local-mcp/mcp-server';
import { loadContractInventory } from '@unifi-local-mcp/unifi-api';
import { NETWORK_OPERATIONS, NETWORK_VERSION_PROBE } from '@unifi-local-mcp/unifi-network';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockConsole, sendJson } from '../fixtures/mock-console.ts';
import { testPki } from '../fixtures/test-pki.ts';
import { testKey, useTempDirs } from '../unit/storage/fixtures.ts';
import { CLI, connect, structured } from './fixtures.ts';

const tempDir = useTempDirs();
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.allSettled(stops.splice(0).map((stop) => stop()));
});

async function start() {
  const pki = testPki();
  const dir = await tempDir();
  const base = loadServiceConfig({ UNIFI_MCP_DATA_DIR: join(dir, 'data') });
  const service = await startService({
    config: {
      ...base,
      deployment: { forceReadOnly: true },
      egress: { allow: ['127.0.0.1/32'] },
      http: { ...base.http, port: 0 },
    },
    masterKey: testKey('versions'),
    operations: NETWORK_OPERATIONS,
    probes: [NETWORK_VERSION_PROBE],
    inventory: await loadContractInventory(join(import.meta.dirname, '../../api-specs')),
    logSink: { write: () => undefined },
    versionMonitor: { intervalMs: 50, refreshMs: 200 },
  });
  const mock = await MockConsole.start({ key: pki.serverKey, cert: pki.serverCert });
  stops.push(async () => {
    await service.stop();
    await mock.stop();
  });
  const reported = { version: '11.0.97' };
  mock.respond = (req, res) => {
    if (req.method === 'GET' && req.url === '/proxy/network/integration/v1/info') {
      sendJson(res, 200, { applicationVersion: reported.version });
    } else {
      sendJson(res, 404, {});
    }
  };
  const view = service.consoles.add(
    { alias: 'lab', host: '127.0.0.1', tls: { mode: 'verify', caPem: pki.caPem } },
    CLI,
  );
  service.consoles.setModulePort(view.id, 'network', mock.port, CLI);
  service.consoles.setCredential(view.id, 'network', 'synthetic-network-key-SENTINEL-91', CLI);
  // Enabling the module is all an operator does; the service finds the version itself.
  service.consoles.setPolicy(view.id, { modules: { network: { state: 'read_only' } } }, CLI);
  const token = service.clients.create(
    { clientId: 'reader', policy: { allow: ['network.*.read'], consoles: { [view.id]: {} } } },
    CLI,
  ).token;
  return { service, mock, reported, consoleId: view.id, token };
}

async function operations(client: Awaited<ReturnType<typeof connect>>): Promise<string[]> {
  const result = structured(
    await client.callTool({ name: 'unifi_list_operations', arguments: {} }),
  );
  return ((result['operations'] ?? []) as { operationId: string }[]).map((o) => o.operationId);
}

describe('console version probing in the service', () => {
  it('probes an enabled module, then lists and runs its operations', async () => {
    const s = await start();
    await vi.waitFor(() => {
      expect(s.service.consoles.observedVersion(s.consoleId, 'network')).toBe('11.0.97');
    });
    const client = await connect(new URL('/mcp', s.service.url), s.token);
    expect(await operations(client)).toContain('network.info.get');
    const result = structured(
      await client.callTool({
        name: 'unifi_execute',
        arguments: { operationId: 'network.info.get', consoleId: s.consoleId },
      }),
    );
    expect(result).toMatchObject({ status: 'ok', data: { applicationVersion: '11.0.97' } });
    expect(await s.service.health.readiness()).toMatchObject({ ready: true, degraded: false });
  });

  it('hides and refuses operations once the console reports an incompatible version', async () => {
    const s = await start();
    await vi.waitFor(() => {
      expect(s.service.consoles.observedVersion(s.consoleId, 'network')).toBe('11.0.97');
    });
    s.reported.version = '10.3.55';
    await vi.waitFor(
      () => {
        expect(s.service.consoles.observedVersion(s.consoleId, 'network')).toBe('10.3.55');
      },
      { timeout: 3000 },
    );
    const before = s.mock.requests.length;
    const client = await connect(new URL('/mcp', s.service.url), s.token);
    expect(await operations(client)).toEqual([]);
    const result = structured(
      await client.callTool({
        name: 'unifi_execute',
        arguments: { operationId: 'network.info.get', consoleId: s.consoleId },
      }),
    );
    expect(result).toMatchObject({ status: 'denied', error: { code: 'operation_unsupported' } });
    expect((result['error'] as { message: string }).message).toContain(
      'The console reports network 10.3.55; this operation is verified for >=11.0.97 <12.',
    );
    // The refusal sent nothing; only probes reached the console.
    expect(
      s.mock.requests.slice(before).every((r) => r.url === '/proxy/network/integration/v1/info'),
    ).toBe(true);
  });
});
