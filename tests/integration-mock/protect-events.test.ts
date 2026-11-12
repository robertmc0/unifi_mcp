/**
 * The Protect event streams end to end (ADR 0020 §6): the real service with the real
 * contract inventory and the reviewed Protect streams, a synthetic 7.3.74 console sending
 * every documented event type and device kind over WebSocket, and real MCP clients with
 * different grants. Every message carries credential sentinels and an undocumented field.
 */
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { loadServiceConfig, startService } from '@unifi-local-mcp/mcp-server';
import {
  EVENT_TYPES,
  PROTECT_EVENT_STREAMS,
  PROTECT_OPERATIONS,
} from '@unifi-local-mcp/unifi-protect';
import { afterEach, describe, expect, it } from 'vitest';
import type * as z from 'zod';
import * as official from '../../packages/unifi-protect/src/generated/protect-7.3.74.ts';
import { MockConsole } from '../fixtures/mock-console.ts';
import { testPki } from '../fixtures/test-pki.ts';
import { ServerWebSocket } from '../fixtures/ws-server.ts';
import { sample } from '../fixtures/zod-samples.ts';
import { testKey, useTempDirs } from '../unit/storage/fixtures.ts';

const tempDir = useTempDirs();
const CLI = { type: 'cli', id: 'root' } as const;
const PROTECT_KEY = 'synthetic-protect-key-SENTINEL-61';
const IDENTITY = ['personal_identifier', 'biometric_or_access_identity'];

const secret = (key: string) =>
  key === 'url' ? 'SENTINEL-TALKBACK-URL' : key === 'pin_code' ? 'SENTINEL-PIN' : undefined;
const EXTRA = ['undocumentedField', 'SENTINEL-UNDOCUMENTED'] as const;

const options = (schema: z.ZodType): z.ZodType[] =>
  (schema as unknown as { _zod: { def: { options: z.ZodType[] } } })._zod.def.options;
const field = (schema: z.ZodType, name: string): z.ZodType =>
  (schema as unknown as { shape: Record<string, z.ZodType> }).shape[name] as z.ZodType;

/** One message per documented event type (the last option is the tolerant fallback). */
function eventMessages(): unknown[] {
  const [add] = options(official.OPERATIONS['GET /v1/subscribe/events'].output);
  const variants = options(field(add as z.ZodType, 'item')).slice(0, -1);
  return variants.map((variant, i) => ({
    type: i % 2 === 0 ? 'add' : 'update',
    item: sample(variant, { secret, extra: EXTRA }),
  }));
}

/** One message per documented device kind and action, in the single form. */
function deviceMessages(): unknown[] {
  const [single] = options(official.OPERATIONS['GET /v1/subscribe/devices'].output);
  const forms = options(single as z.ZodType).slice(0, -1);
  return forms.flatMap((form) => {
    const action = def(field(form, 'type')).values?.[0];
    // Each documented kind is an object with a literal modelKey; the fallback is not.
    const kinds = options(field(form, 'item')).filter(
      (kind) => def(kind).type === 'object' && def(field(kind, 'modelKey')).type === 'literal',
    );
    return kinds.map((kind) => ({ type: action, item: sample(kind, { secret, extra: EXTRA }) }));
  });
}

function def(schema: z.ZodType): { type: string; values?: unknown[] } {
  return (schema as unknown as { _zod: { def: { type: string; values?: unknown[] } } })._zod.def;
}

const stopping: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.allSettled(stopping.splice(0).map((stop) => stop()));
});

async function setup() {
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
    masterKey: testKey('protect-events'),
    operations: PROTECT_OPERATIONS,
    eventStreams: PROTECT_EVENT_STREAMS,
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
    if (request.headers['x-api-key'] !== PROTECT_KEY) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    sockets.set(request.url, new ServerWebSocket(request, socket));
  };
  const view = service.consoles.add(
    { alias: 'nvr', host: '127.0.0.1', tls: { mode: 'verify', caPem: pki.caPem } },
    CLI,
  );
  service.consoles.setModulePort(view.id, 'protect', mock.port, CLI);
  service.consoles.setCredential(view.id, 'protect', PROTECT_KEY, CLI);
  service.consoles.setPolicy(view.id, { modules: { protect: { state: 'read_only' } } }, CLI);
  service.consoles.recordObservedVersion(view.id, 'protect', '7.3.74');
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
  const uri = (stream: string) => `unifi://consoles/${view.id}/protect/${stream}`;
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

describe('Protect event streams', () => {
  it('deliver every documented event type, identity events only with identity grants', async () => {
    const t = await setup();
    const all = await t.connect('all', ['protect.events.read'], IDENTITY);
    const plain = await t.connect('plain', ['protect.events.read']);
    const devicesOnly = await t.connect('devices-only', [
      'protect.devices.read',
      'protect.cameras.read',
    ]);
    expect((await devicesOnly.listResources()).resources.map((r) => r.uri)).toEqual([
      t.uri('devices'),
    ]);
    await all.listen({ resourceSubscriptions: [t.uri('events')] });
    await plain.listen({ resourceSubscriptions: [t.uri('events')] });
    await until(() => t.sockets.has('/proxy/protect/integration/v1/subscribe/events'));
    const ws = t.sockets.get('/proxy/protect/integration/v1/subscribe/events');
    const messages = eventMessages();
    expect(messages).toHaveLength(Object.keys(EVENT_TYPES).length);
    for (const message of messages) ws?.sendJson(message);
    ws?.sendJson({ type: 'add', item: { type: 'eventFromTheFuture', id: 'x' } });
    await until(
      () =>
        t.service.events.hub.status().find((s) => s.streamId === 'events')?.buffered ===
        messages.length,
    );
    const everything = await readAll(all, t.uri('events'));
    expect(everything.kinds).toEqual(Object.keys(EVENT_TYPES).sort());
    const withoutIdentity = await readAll(plain, t.uri('events'));
    expect(withoutIdentity.kinds).toEqual(
      Object.keys(EVENT_TYPES)
        .filter((type) => type !== 'nfcCardScanned' && type !== 'fingerprintIdentified')
        .sort(),
    );
    for (const { text } of [everything, withoutIdentity]) {
      expect(text).not.toContain('SENTINEL');
      expect(text).not.toContain(PROTECT_KEY);
    }
    expect(t.service.events.hub.status().find((s) => s.streamId === 'events')?.dropped).toEqual({
      contractMismatch: 0,
      unclassified: 1,
    });
  });

  it('deliver device changes only with the grants of the read for that device', async () => {
    const t = await setup();
    const all = await t.connect('all', ['protect.*.read'], ['location']);
    const cameras = await t.connect('cameras', ['protect.devices.read', 'protect.cameras.read']);
    const fobs = await t.connect('fobs', ['protect.devices.read', 'protect.fobs.read']);
    for (const client of [all, cameras, fobs]) {
      await client.listen({ resourceSubscriptions: [t.uri('devices')] });
    }
    await until(() => t.sockets.has('/proxy/protect/integration/v1/subscribe/devices'));
    const ws = t.sockets.get('/proxy/protect/integration/v1/subscribe/devices');
    const messages = deviceMessages();
    // 14 documented kinds × add, update, remove.
    expect(messages).toHaveLength(42);
    for (const message of messages) ws?.sendJson(message);
    // A bulk update keeps its ids and fields.
    ws?.sendJson({ type: 'update', item: { id: ['c1', 'c2'], modelKey: 'camera', name: 'Front' } });
    await until(
      () =>
        t.service.events.hub.status().find((s) => s.streamId === 'devices')?.buffered === 36 + 1,
    );
    const everything = await readAll(all, t.uri('devices'));
    const expected = [
      'nvr',
      'camera',
      'chime',
      'light',
      'viewer',
      'speaker',
      'bridge',
      'sensor',
      'siren',
      'fob',
      'relay',
      'linkstation',
    ].flatMap((kind) => ['add', 'update', 'remove'].map((action) => `${kind}_${action}`));
    expect(everything.kinds).toEqual([...expected, 'camera_update'].sort());
    expect(everything.text).toContain('"id":["c1","c2"]');
    expect(everything.text).not.toContain('SENTINEL');
    expect((await readAll(cameras, t.uri('devices'))).kinds).toEqual(
      ['camera_add', 'camera_remove', 'camera_update', 'camera_update'].sort(),
    );
    // Fobs carry presence: without the location grant, none.
    expect((await readAll(fobs, t.uri('devices'))).kinds).toEqual([]);
    // AI processors and ports have no reviewed read: never delivered.
    expect(t.service.events.hub.status().find((s) => s.streamId === 'devices')?.dropped).toEqual({
      contractMismatch: 0,
      unclassified: 6,
    });
  });
});
