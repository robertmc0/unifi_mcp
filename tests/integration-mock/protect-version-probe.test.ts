/**
 * The service learns a console's Protect version on its own (ADR 0019 §4): with the real
 * Protect adapter and contract inventory, an enabled module is probed shortly after start,
 * its operations then appear and run, and an incompatible version hides and refuses them.
 */
import { join } from 'node:path';
import { loadServiceConfig, startService } from '@unifi-local-mcp/mcp-server';
import { loadContractInventory } from '@unifi-local-mcp/unifi-api';
import { PROTECT_OPERATIONS, PROTECT_VERSION_PROBE } from '@unifi-local-mcp/unifi-protect';
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
const INFO = '/proxy/protect/integration/v1/meta/info';

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
    masterKey: testKey('protect-versions'),
    operations: PROTECT_OPERATIONS,
    probes: [PROTECT_VERSION_PROBE],
    inventory: await loadContractInventory(join(import.meta.dirname, '../../api-specs')),
    logSink: { write: () => undefined },
    versionMonitor: { intervalMs: 50, refreshMs: 200 },
  });
  const mock = await MockConsole.start({ key: pki.serverKey, cert: pki.serverCert });
  stops.push(async () => {
    await service.stop();
    await mock.stop();
  });
  const reported = { version: '7.4.96' };
  mock.respond = (req, res) => {
    if (req.method === 'GET' && req.url === INFO) {
      sendJson(res, 200, { applicationVersion: reported.version });
    } else {
      sendJson(res, 404, {});
    }
  };
  const view = service.consoles.add(
    { alias: 'lab', host: '127.0.0.1', tls: { mode: 'verify', caPem: pki.caPem } },
    CLI,
  );
  service.consoles.setModulePort(view.id, 'protect', mock.port, CLI);
  service.consoles.setCredential(view.id, 'protect', 'synthetic-protect-key-SENTINEL-42', CLI);
  service.consoles.setPolicy(view.id, { modules: { protect: { state: 'read_only' } } }, CLI);
  const token = service.clients.create(
    { clientId: 'viewer', policy: { allow: ['protect.*.read'], consoles: { [view.id]: {} } } },
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

describe('Protect version probing in the service', () => {
  it('probes an enabled module, then lists and runs its operations', async () => {
    const s = await start();
    await vi.waitFor(() => {
      expect(s.service.consoles.observedVersion(s.consoleId, 'protect')).toBe('7.4.96');
    });
    const client = await connect(new URL('/mcp', s.service.url), s.token);
    expect(await operations(client)).toContain('protect.info.get');
    const result = structured(
      await client.callTool({
        name: 'unifi_execute',
        arguments: { operationId: 'protect.info.get', consoleId: s.consoleId },
      }),
    );
    expect(result).toMatchObject({ status: 'ok', data: { applicationVersion: '7.4.96' } });
    expect(s.mock.requests.at(-1)).toMatchObject({ method: 'GET', url: INFO });
    expect(s.mock.requests.at(-1)?.headers['x-api-key']).toBe('synthetic-protect-key-SENTINEL-42');
  });

  it('on the official release 7.3.74, serves its operations and refuses those 7.4.96 added', async () => {
    const s = await start();
    s.reported.version = '7.3.74';
    await vi.waitFor(
      () => {
        expect(s.service.consoles.observedVersion(s.consoleId, 'protect')).toBe('7.3.74');
      },
      { timeout: 3000 },
    );
    const client = await connect(new URL('/mcp', s.service.url), s.token);
    const listed = await operations(client);
    expect(listed).toContain('protect.info.get');
    expect(listed).toContain('protect.cameras.list');
    expect(listed).not.toContain('protect.alarm.list_external_profiles');
    const info = structured(
      await client.callTool({
        name: 'unifi_execute',
        arguments: { operationId: 'protect.info.get', consoleId: s.consoleId },
      }),
    );
    expect(info).toMatchObject({ status: 'ok', data: { applicationVersion: '7.3.74' } });
    const before = s.mock.requests.length;
    const newer = structured(
      await client.callTool({
        name: 'unifi_execute',
        arguments: { operationId: 'protect.alarm.list_external_profiles', consoleId: s.consoleId },
      }),
    );
    expect(newer).toMatchObject({ status: 'denied', error: { code: 'operation_unsupported' } });
    expect((newer['error'] as { message: string }).message).toContain(
      'The console reports protect 7.3.74; this operation is verified for >=7.4.96 <8.',
    );
    expect(s.mock.requests.slice(before).every((r) => r.url === INFO)).toBe(true);
  });

  it('hides and refuses every operation for an older or newer major Protect version', async () => {
    const s = await start();
    await vi.waitFor(() => {
      expect(s.service.consoles.observedVersion(s.consoleId, 'protect')).toBe('7.4.96');
    });
    for (const version of ['7.2.95', '8.0.1']) {
      s.reported.version = version;
      await vi.waitFor(
        () => {
          expect(s.service.consoles.observedVersion(s.consoleId, 'protect')).toBe(version);
        },
        { timeout: 3000 },
      );
      const before = s.mock.requests.length;
      const client = await connect(new URL('/mcp', s.service.url), s.token);
      expect(await operations(client)).toEqual([]);
      const result = structured(
        await client.callTool({
          name: 'unifi_execute',
          arguments: { operationId: 'protect.info.get', consoleId: s.consoleId },
        }),
      );
      expect(result).toMatchObject({ status: 'denied', error: { code: 'operation_unsupported' } });
      expect((result['error'] as { message: string }).message).toContain(
        `The console reports protect ${version}; this operation is verified for >=7.3.74 <8.`,
      );
      expect(s.mock.requests.slice(before).every((r) => r.url === INFO)).toBe(true);
    }
  });
});
