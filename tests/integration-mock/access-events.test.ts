/**
 * The Access notification stream end to end (ADR 0023 §6): the real service with the real
 * contract inventory and the reviewed Access operations and stream, a synthetic Access API
 * on its own port sending every documented notification over WebSocket with the bearer
 * token, a declared version, and real MCP clients with different grants. Every message
 * carries credential sentinels and an undocumented field.
 */
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { loadServiceConfig, startService } from '@unifi-local-mcp/mcp-server';
import {
  ACCESS_EVENT_STREAMS,
  ACCESS_OPERATIONS,
  NOTIFICATION_EVENTS,
} from '@unifi-local-mcp/unifi-access';
import { afterEach, describe, expect, it } from 'vitest';
import type * as z from 'zod';
import { OPERATIONS } from '../../packages/unifi-access/src/generated/access-2026-03-23.ts';
import { MockConsole } from '../fixtures/mock-console.ts';
import { testPki } from '../fixtures/test-pki.ts';
import { ServerWebSocket } from '../fixtures/ws-server.ts';
import { sample } from '../fixtures/zod-samples.ts';
import { testKey, useTempDirs } from '../unit/storage/fixtures.ts';

const tempDir = useTempDirs();
const CLI = { type: 'cli', id: 'root' } as const;
const TOKEN = 'synthetic-access-token-SENTINEL-88';
const PATH = '/api/v1/developer/devices/notifications';

/** Credential sentinels: the doorbell call's token, and the module-wide credential fields. */
const secret = (key: string) =>
  key === 'token' ? 'SENTINEL-CALL-TOKEN' : key === 'secret' ? 'SENTINEL-SECRET' : undefined;
const EXTRA = ['undocumentedField', 'SENTINEL-UNDOCUMENTED'] as const;

const options = (schema: z.ZodType): z.ZodType[] =>
  (schema as unknown as { _zod: { def: { options: z.ZodType[] } } })._zod.def.options;

/** One message per documented notification (the last option is the tolerant fallback). */
function notifications(): unknown[] {
  return options(OPERATIONS[`GET ${PATH}`].output)
    .slice(0, -1)
    .map((variant) => sample(variant, { secret, extra: EXTRA }));
}

const stopping: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.allSettled(stopping.splice(0).map((stop) => stop()));
});

async function setup(options: { version?: string | null } = {}) {
  const pki = testPki();
  const base = loadServiceConfig({ UNIFI_MCP_DATA_DIR: join(await tempDir(), 'data') });
  const service = await startService({
    config: {
      ...base,
      deployment: { forceReadOnly: true },
      egress: { allow: ['127.0.0.1/32'] },
      http: { ...base.http, port: 0 },
      admin: undefined,
    },
    masterKey: testKey('access-events'),
    operations: ACCESS_OPERATIONS,
    eventStreams: ACCESS_EVENT_STREAMS,
    eventHubLimits: { notifyIntervalMs: 0, connectRate: { ratePerSecond: 1000, burst: 1000 } },
    logSink: { write: () => undefined },
  });
  const mock = await MockConsole.start({ key: pki.serverKey, cert: pki.serverCert });
  stopping.push(async () => {
    await service.stop();
    await mock.stop();
  });
  const sockets = new Map<string, ServerWebSocket>();
  mock.upgrade = (request, socket) => {
    if (request.headers['authorization'] !== `Bearer ${TOKEN}`) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    sockets.set(request.url, new ServerWebSocket(request, socket));
  };
  const view = service.consoles.add(
    { alias: 'door', host: '127.0.0.1', tls: { mode: 'verify', caPem: pki.caPem } },
    CLI,
  );
  service.consoles.setModulePort(view.id, 'access', mock.port, CLI);
  service.consoles.setCredential(view.id, 'access', TOKEN, CLI);
  service.consoles.setPolicy(view.id, { modules: { access: { state: 'read_only' } } }, CLI);
  const version = options.version === undefined ? '4.2.16' : options.version;
  if (version !== null) service.consoles.declareVersion(view.id, 'access', version, CLI);
  const connect = async (clientId: string, allow: string[], sensitive: string[] = []) => {
    const { token } = service.clients.create(
      {
        clientId,
        policy: {
          allow,
          consoles: { [view.id]: {} },
          ...(sensitive.length > 0 ? { sensitive } : {}),
        },
      },
      CLI,
    );
    const client = new Client(
      { name: clientId, version: '0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', service.url), {
        fetch: (input: string | URL | Request, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          headers.set('authorization', `Bearer ${token}`);
          return fetch(input, { ...init, headers });
        },
      }),
    );
    stopping.push(() => client.close());
    return client;
  };
  const uri = `unifi://consoles/${view.id}/access/notifications`;
  return { service, sockets, connect, uri };
}

async function readAll(client: Client, uri: string): Promise<{ kinds: string[]; text: string }> {
  const kinds: string[] = [];
  let text = '';
  let target = uri;
  for (let page = 0; page < 20; page++) {
    const result = await client.readResource({ uri: target });
    const body = (result.contents[0] as { text: string }).text;
    text += body;
    const parsed = JSON.parse(body) as {
      events: { kind?: string }[];
      more: boolean;
      cursor: string;
    };
    kinds.push(...parsed.events.flatMap((e) => (e.kind === undefined ? [] : [e.kind])));
    if (!parsed.more) break;
    target = `${uri}?after=${parsed.cursor}`;
  }
  return { kinds: kinds.sort(), text };
}

const until = async (check: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
};

describe('Access notification stream', () => {
  it('delivers doorbell calls to every reader, remote unlocks only with the door and history grants', async () => {
    const t = await setup();
    const all = await t.connect(
      'all',
      ['access.notifications.read', 'access.spaces.read'],
      ['access_log'],
    );
    const plain = await t.connect('plain', ['access.notifications.read']);
    const noHistory = await t.connect('no-history', [
      'access.notifications.read',
      'access.spaces.read',
    ]);
    const doorsOnly = await t.connect('doors-only', ['access.spaces.read']);
    expect((await doorsOnly.listResources()).resources.map((r) => r.uri)).not.toContain(t.uri);
    for (const client of [all, plain, noHistory]) {
      await client.listen({ resourceSubscriptions: [t.uri] });
    }
    await until(() => t.sockets.has(PATH));
    const ws = t.sockets.get(PATH);
    const messages = notifications();
    expect(messages).toHaveLength(Object.keys(NOTIFICATION_EVENTS).length);
    expect(JSON.stringify(messages)).toContain('SENTINEL-CALL-TOKEN');
    for (const message of messages) ws?.sendJson(message);
    // A newer console's event, and a documented event that misses its shape.
    ws?.sendJson({ event: 'access.door.unlock', data: { actor: 'Someone' } });
    ws?.sendJson({ event: 'access.remote_view', data: 'ringing' });
    await until(
      () =>
        t.service.events.hub.status().find((s) => s.streamId === 'notifications')?.buffered ===
        messages.length,
    );
    const everything = await readAll(all, t.uri);
    expect(everything.kinds).toEqual(['doorbell_ring', 'doorbell_status', 'remote_unlock']);
    expect((await readAll(plain, t.uri)).kinds).toEqual(['doorbell_ring', 'doorbell_status']);
    expect((await readAll(noHistory, t.uri)).kinds).toEqual(['doorbell_ring', 'doorbell_status']);
    expect(everything.text).not.toContain('SENTINEL');
    expect(everything.text).not.toContain('"token"');
    expect(everything.text).not.toContain(TOKEN);
    expect(everything.text).toContain('"channel"');
    expect(
      t.service.events.hub.status().find((s) => s.streamId === 'notifications')?.dropped,
    ).toEqual({ contractMismatch: 1, unclassified: 1 });
  });

  it('is not offered while no Access version is declared', async () => {
    const t = await setup({ version: null });
    const client = await t.connect('all', ['access.notifications.read']);
    expect((await client.listResources()).resources.map((r) => r.uri)).not.toContain(t.uri);
    await expect(client.readResource({ uri: t.uri })).rejects.toThrow();
    expect(t.sockets.size).toBe(0);
  });
});
