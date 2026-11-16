/**
 * Two independently configured consoles behind one service (spec §17 "two or more
 * independently configured consoles with correct console/site targeting", §4.2): each
 * request reaches only the console it names, with that console's own key; a client sees
 * and reaches only the consoles and sites it was granted, and a refused request sends
 * nothing anywhere.
 */
import { describe, expect, it } from 'vitest';
import { MockConsole, sendJson } from '../fixtures/mock-console.ts';
import { testPki } from '../fixtures/test-pki.ts';
import { useTempDirs } from '../unit/storage/fixtures.ts';
import { CLI, connect, NETWORK_KEY, startTestService, structured } from './fixtures.ts';

const tempDir = useTempDirs();
const SECOND_KEY = 'synthetic-network-key-SECOND-CONSOLE';

async function twoConsoles() {
  const t = await startTestService({ dir: await tempDir() });
  const pki = testPki();
  const second = await MockConsole.start({ key: pki.serverKey, cert: pki.serverCert });
  second.respond = (req, res) => {
    if (req.url.includes('/devices')) {
      sendJson(res, 200, {
        data: [{ id: 'dev-9', name: 'Lab AP', macAddress: '00:00:5e:00:53:09' }],
      });
    } else {
      sendJson(res, 200, { version: '1.0.6' });
    }
  };
  const view = t.service.consoles.add(
    { alias: 'shop', host: '127.0.0.1', tls: { mode: 'verify', caPem: pki.caPem } },
    CLI,
  );
  const secondId = view.id;
  t.service.consoles.setModulePort(secondId, 'network', second.port, CLI);
  t.service.consoles.setCredential(secondId, 'network', SECOND_KEY, CLI);
  t.service.consoles.setPolicy(secondId, { modules: { network: { state: 'read_only' } } }, CLI);
  t.service.consoles.recordObservedVersion(secondId, 'network', '1.0.5');
  const client = (clientId: string, consoles: Record<string, { sites?: string[] }>): string =>
    t.service.clients.create({ clientId, policy: { allow: ['network.*.read'], consoles } }, CLI)
      .token;
  return { t, second, secondId, client, stop: () => second.stop() };
}

const info = (consoleId: string) => ({
  name: 'unifi_execute',
  arguments: { operationId: 'network.info.get', consoleId },
});
const devices = (consoleId: string, siteId: string) => ({
  name: 'unifi_execute',
  arguments: { operationId: 'network.devices.list', consoleId, siteId },
});

describe('two consoles', () => {
  it('each request reaches only the console it names, with that console’s key', async () => {
    const { t, second, secondId, client, stop } = await twoConsoles();
    try {
      const both = await connect(t.mcpUrl, client('both', { [t.consoleId]: {}, [secondId]: {} }));
      expect(structured(await both.callTool(info(t.consoleId)))).toMatchObject({
        status: 'ok',
        data: { version: '1.0.5' },
      });
      expect(structured(await both.callTool(info(secondId)))).toMatchObject({
        status: 'ok',
        data: { version: '1.0.6' },
      });
      expect(structured(await both.callTool(devices(secondId, 'site-7')))).toMatchObject({
        status: 'ok',
        data: [{ id: 'dev-9', name: 'Lab AP' }],
      });
      expect(t.mock.requests.map((r) => r.url)).toEqual(['/proxy/network/integration/v1/info']);
      expect(second.requests.map((r) => r.url)).toEqual([
        '/proxy/network/integration/v1/info',
        '/proxy/network/integration/v1/sites/site-7/devices',
      ]);
      expect(t.mock.requests.every((r) => r.headers['x-api-key'] === NETWORK_KEY)).toBe(true);
      expect(second.requests.every((r) => r.headers['x-api-key'] === SECOND_KEY)).toBe(true);

      const listed = structured(
        await both.callTool({ name: 'unifi_list_consoles', arguments: {} }),
      );
      expect((listed['consoles'] as { alias: string }[]).map((c) => c.alias).sort()).toEqual([
        'lab',
        'shop',
      ]);
    } finally {
      await stop();
    }
  });

  it('a client reaches only its consoles and sites; a refusal sends nothing', async () => {
    const { t, second, secondId, client, stop } = await twoConsoles();
    try {
      const limited = await connect(
        t.mcpUrl,
        client('limited', { [t.consoleId]: { sites: ['site-1'] } }),
      );
      const listed = structured(
        await limited.callTool({ name: 'unifi_list_consoles', arguments: {} }),
      );
      expect((listed['consoles'] as { alias: string }[]).map((c) => c.alias)).toEqual(['lab']);

      expect(structured(await limited.callTool(info(secondId)))).toMatchObject({
        status: 'denied',
        error: { code: 'console_not_permitted' },
      });
      expect(structured(await limited.callTool(devices(t.consoleId, 'site-2')))).toMatchObject({
        status: 'denied',
        error: { code: 'site_not_permitted' },
      });
      expect(t.mock.requests).toEqual([]);
      expect(second.requests).toEqual([]);

      expect(structured(await limited.callTool(devices(t.consoleId, 'site-1')))).toMatchObject({
        status: 'ok',
      });
      expect(t.mock.requests.map((r) => r.url)).toEqual([
        '/proxy/network/integration/v1/sites/site-1/devices',
      ]);
      expect(second.requests).toEqual([]);
    } finally {
      await stop();
    }
  });
});
