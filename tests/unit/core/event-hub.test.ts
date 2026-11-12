/**
 * The event connection manager and the central stream authorisation (ADR 0020 §3, §4):
 * demand-driven feeds, validation and classification, per-client filtering at
 * notification and read time, bounded buffers, gaps, opaque cursors, backoff, the
 * connection-attempt limit, credential changes and shutdown. Synthetic streams only.
 */
import { join } from 'node:path';
import {
  defineEventStream,
  EventHub,
  EventStreamRegistry,
  StreamAccess,
  type ContractInventory,
  type EventCloseInfo,
  type EventConnection,
  type EventConnector,
  type EventHubLimits,
  type EventStreamDescriptor,
  type EventTarget,
} from '@unifi-local-mcp/core';
import {
  ClientPolicySchema,
  ConsolePolicySchema,
  PolicyStore,
  type ClientPolicy,
  type ConsolePolicy,
  type OperationSecurity,
} from '@unifi-local-mcp/policy';
import { databasePathFor, openStorage } from '@unifi-local-mcp/storage';
import { AuditLog } from '@unifi-local-mcp/telemetry';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { testKey, useTempDirs } from '../storage/fixtures.ts';
import { memoryLogger } from '../telemetry/fixtures.ts';

const tempDir = useTempDirs();
const CONSOLE = 'console-1';
const OTHER_CONSOLE = 'console-2';

const inventory: ContractInventory = (moduleId, revision, method, path) =>
  moduleId === 'protect' &&
  revision === '1.0' &&
  method === 'GET' &&
  path === '/v1/subscribe/things';

const camerasGet: OperationSecurity = {
  operationId: 'protect.cameras.get',
  moduleId: 'protect',
  category: 'cameras',
  effect: 'read',
  permission: 'protect.cameras.read',
  risk: 'low',
  sensitivityTags: [],
  approvalRequired: false,
  siteScoped: false,
};

const Message = z.object({
  type: z.string(),
  item: z.object({ id: z.string(), secret: z.string().optional() }),
});

const STREAM = defineEventStream({
  operationId: 'protect.things.subscribe',
  moduleId: 'protect',
  category: 'things',
  effect: 'read',
  permission: 'protect.things.read',
  risk: 'low',
  sensitivityTags: [],
  approvalRequired: false,
  siteScoped: false,
  streamId: 'things',
  description: 'Synthetic things.',
  documentationUrl: 'https://developer.invalid/protect/1.0',
  contractRevision: '1.0',
  apiVersionRange: '>=1.0 <2',
  pathTemplate: '/v1/subscribe/things',
  messageSchema: Message,
  maxMessageBytes: 64 * 1024,
  classify: (message) => {
    switch (message.type) {
      case 'motion':
        return { kind: 'motion', sensitivityTags: [] };
      case 'nfc':
        return { kind: 'nfcScanned', sensitivityTags: ['personal_identifier'] };
      case 'camera':
        return { kind: 'camera', equivalent: camerasGet, sensitivityTags: [] };
      default:
        return undefined;
    }
  },
  project: (message) => ({ type: message.type, item: { id: message.item.id } }),
});

class FakeConnection implements EventConnection {
  readonly closed: Promise<EventCloseInfo>;
  #listener: ((text: string) => void) | undefined;
  #resolve!: (info: EventCloseInfo) => void;
  isClosed = false;

  constructor() {
    this.closed = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }
  onMessage(listener: (text: string) => void): void {
    this.#listener = listener;
  }
  send(value: unknown): void {
    this.#listener?.(typeof value === 'string' ? value : JSON.stringify(value));
  }
  end(code: string): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.#resolve({ code });
  }
  close(): void {
    this.end('closed');
  }
}

class FakeConnector implements EventConnector {
  readonly connections: FakeConnection[] = [];
  readonly attempts: { target: EventTarget; at: number }[] = [];
  fingerprints = new Map<string, string | undefined>([
    [CONSOLE, 'fp-1'],
    [OTHER_CONSOLE, 'fp-1'],
  ]);
  /** Codes to fail the next attempts with. */
  failures: string[] = [];
  failAlways: string | undefined;

  connect(target: EventTarget): Promise<EventConnection> {
    this.attempts.push({ target, at: Date.now() });
    const code = this.failures.shift() ?? this.failAlways;
    if (code !== undefined) {
      return Promise.reject(Object.assign(new Error('refused'), { code }));
    }
    const connection = new FakeConnection();
    this.connections.push(connection);
    return Promise.resolve(connection);
  }
  fingerprint(consoleId: string): string | undefined {
    return this.fingerprints.get(consoleId);
  }
  get open(): FakeConnection[] {
    return this.connections.filter((c) => !c.isClosed);
  }
}

const FAST: Partial<EventHubLimits> = {
  lingerMs: 50,
  backoffBaseMs: 20,
  backoffMaxMs: 80,
  unauthorizedBackoffMs: 5_000,
  unavailableRecheckMs: 5_000,
  stableAfterMs: 10_000,
  connectRate: { ratePerSecond: 1000, burst: 1000 },
  notifyIntervalMs: 0,
};

async function setup(
  options: { limits?: Partial<EventHubLimits>; clients?: Record<string, object> } = {},
) {
  const storage = await openStorage({
    databasePath: databasePathFor(join(await tempDir(), 'data')),
    masterKey: testKey('events'),
  });
  const log = memoryLogger();
  const policyStore = new PolicyStore(storage.db, new AuditLog(storage.db, { logger: log.logger }));
  policyStore.current();
  const clients = new Map<string, ClientPolicy>();
  const grants = options.clients ?? {
    all: { allow: ['protect.*.read'], sensitive: ['personal_identifier'] },
    plain: { allow: ['protect.things.read'] },
  };
  for (const [clientId, grant] of Object.entries(grants)) {
    clients.set(
      clientId,
      ClientPolicySchema.parse({
        clientId,
        consoles: { [CONSOLE]: { sites: '*' }, [OTHER_CONSOLE]: { sites: '*' } },
        ...grant,
      }),
    );
  }
  const consoles = new Map<string, ConsolePolicy>(
    [CONSOLE, OTHER_CONSOLE].map((consoleId) => [
      consoleId,
      ConsolePolicySchema.parse({ consoleId, modules: { protect: { state: 'read_only' } } }),
    ]),
  );
  const supported = new Set([CONSOLE, OTHER_CONSOLE]);
  const access = new StreamAccess({
    security: {
      clientPolicy: (id) => clients.get(id),
      consolePolicy: (id) => consoles.get(id),
      capability: (id) => (supported.has(id) ? 'supported' : 'unsupported'),
    },
    policyStore,
    deployment: { forceReadOnly: true },
    now: () => new Date(),
  });
  const connector = new FakeConnector();
  const notified: string[] = [];
  const hub = new EventHub({
    access,
    connector,
    logger: log.logger,
    notify: (clientId, consoleId, stream) => {
      notified.push(`${clientId}:${consoleId}:${stream.streamId}`);
    },
    supported: (consoleId) => supported.has(consoleId),
    limits: { ...FAST, ...options.limits },
    random: () => 0.5,
  });
  return { hub, connector, notified, clients, consoles, supported, log, access, storage };
}

const until = async (check: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};

const key = (consoleId = CONSOLE, stream: EventStreamDescriptor = STREAM) => ({
  consoleId,
  stream,
});
const kinds = (result: { events: object[] }) =>
  result.events.map((e) => ('kind' in e ? e.kind : `gap:${(e as { gap: string }).gap}`));

describe('event stream registry', () => {
  it('accepts a reviewed stream and refuses anything else', () => {
    const registry = new EventStreamRegistry(inventory);
    registry.register(STREAM);
    expect(() => {
      registry.register(STREAM);
    }).toThrow(/already registered/);
    const bad = (patch: Partial<EventStreamDescriptor>) => () => {
      new EventStreamRegistry(inventory).register({ ...STREAM, ...patch });
    };
    expect(bad({ pathTemplate: '/v1/subscribe/other' })).toThrow(/is not in protect\/1.0/);
    expect(bad({ effect: 'write', permission: 'protect.things.write' })).toThrow(/low-risk read/);
    expect(bad({ risk: 'high', approvalRequired: true })).toThrow(/low-risk read/);
    expect(bad({ siteScoped: true })).toThrow(/site-scoped/);
    expect(bad({ operationId: 'protect.things.list' })).toThrow(/subscribe/);
    expect(bad({ maxMessageBytes: 100 * 1024 * 1024 })).toThrow(/maxMessageBytes/);
    expect(bad({ apiVersionRange: 'latest' })).toThrow(/apiVersionRange/);
    registry.seal();
    expect(() => {
      registry.register({ ...STREAM, streamId: 'more' });
    }).toThrow(/sealed/);
  });
});

describe('event hub', () => {
  it('connects only while someone subscribes, and once per console and stream', async () => {
    const { hub, connector } = await setup();
    expect(connector.attempts).toHaveLength(0);
    const releaseA = hub.subscribe('all', [key()]);
    const releaseB = hub.subscribe('plain', [key()]);
    await until(() => connector.open.length === 1);
    releaseA();
    releaseA();
    releaseB();
    // Lingers briefly, then closes and forgets the buffer.
    expect(connector.open).toHaveLength(1);
    await until(() => connector.open.length === 0);
    expect(hub.status()).toEqual([]);
    expect(hub.read('all', CONSOLE, STREAM).state).toBe('inactive');
    // A new subscriber within the linger keeps the connection.
    const again = hub.subscribe('all', [key()]);
    await until(() => connector.open.length === 1);
    again();
    hub.subscribe('all', [key()]);
    await new Promise((r) => setTimeout(r, 80));
    expect(connector.connections).toHaveLength(2);
    await hub.close();
  });

  it('validates, classifies and minimises messages, and shows each client only what it may see', async () => {
    const { hub, connector, notified } = await setup();
    hub.subscribe('all', [key()]);
    hub.subscribe('plain', [key()]);
    await until(() => connector.open.length === 1);
    const upstream = connector.open[0] as FakeConnection;
    upstream.send({ type: 'motion', item: { id: 'm1', secret: 'SENTINEL-SECRET' } });
    upstream.send({ type: 'nfc', item: { id: 'n1' } });
    upstream.send({ type: 'camera', item: { id: 'c1' } });
    upstream.send({ type: 'unknown', item: { id: 'u1' } });
    upstream.send({ type: 'motion' }); // no item: does not match the contract
    upstream.send('not json');

    const all = hub.read('all', CONSOLE, STREAM);
    expect(all.state).toBe('connected');
    expect(kinds(all)).toEqual(['motion', 'nfcScanned', 'camera']);
    expect(JSON.stringify(all)).not.toContain('SENTINEL');
    // No camera permission and no personal_identifier grant.
    expect(kinds(hub.read('plain', CONSOLE, STREAM))).toEqual(['motion']);
    expect(notified.filter((n) => n.startsWith('all:'))).toHaveLength(3);
    expect(notified.filter((n) => n.startsWith('plain:'))).toHaveLength(1);
    expect(hub.status()[0]).toMatchObject({
      state: 'connected',
      subscribers: 2,
      buffered: 3,
      dropped: { contractMismatch: 2, unclassified: 1 },
    });
    await hub.close();
  });

  it('re-checks the policy at read time and notification time', async () => {
    const { hub, connector, notified, clients } = await setup();
    hub.subscribe('plain', [key()]);
    await until(() => connector.open.length === 1);
    const upstream = connector.open[0] as FakeConnection;
    upstream.send({ type: 'motion', item: { id: 'm1' } });
    expect(kinds(hub.read('plain', CONSOLE, STREAM))).toEqual(['motion']);
    clients.set(
      'plain',
      ClientPolicySchema.parse({
        clientId: 'plain',
        consoles: { [CONSOLE]: { sites: '*' } },
        allow: [],
      }),
    );
    expect(kinds(hub.read('plain', CONSOLE, STREAM))).toEqual([]);
    upstream.send({ type: 'motion', item: { id: 'm2' } });
    expect(notified).toHaveLength(1);
    clients.delete('plain');
    expect(kinds(hub.read('plain', CONSOLE, STREAM))).toEqual([]);
    await hub.close();
  });

  it('pages with opaque cursors that do not reveal hidden events', async () => {
    const { hub, connector } = await setup({ limits: { readLimit: 2 } });
    hub.subscribe('all', [key()]);
    await until(() => connector.open.length === 1);
    const upstream = connector.open[0] as FakeConnection;
    for (const type of ['motion', 'nfc', 'nfc', 'motion', 'motion']) {
      upstream.send({ type, item: { id: type } });
    }
    const first = hub.read('plain', CONSOLE, STREAM);
    expect(kinds(first)).toEqual(['motion', 'motion']);
    expect(first.more).toBe(true);
    expect(first.cursor).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const second = hub.read('plain', CONSOLE, STREAM, { after: first.cursor });
    expect(kinds(second)).toEqual(['motion']);
    expect(second).toMatchObject({ more: false, truncated: false });
    expect(hub.read('plain', CONSOLE, STREAM, { after: second.cursor }).events).toEqual([]);
    // Cursors from elsewhere are not trusted: read from the oldest event, flagged.
    const forged = hub.read('plain', CONSOLE, STREAM, { after: 'AAAAAAAAAAAAAAAAAAAAAA' });
    expect(forged.truncated).toBe(true);
    expect(kinds(forged)).toEqual(['motion', 'motion']);
    await hub.close();
  });

  it('bounds the buffer by entries and bytes, and flags what a cursor missed', async () => {
    const { hub, connector } = await setup({ limits: { bufferEntries: 3, bufferBytes: 10_000 } });
    hub.subscribe('all', [key()]);
    await until(() => connector.open.length === 1);
    const upstream = connector.open[0] as FakeConnection;
    upstream.send({ type: 'motion', item: { id: 'a' } });
    const cursor = hub.read('all', CONSOLE, STREAM).cursor;
    for (const id of ['b', 'c', 'd', 'e']) upstream.send({ type: 'motion', item: { id } });
    const result = hub.read('all', CONSOLE, STREAM, { after: cursor });
    expect(result.truncated).toBe(true);
    expect(
      result.events.map((e) => (e as { data: { item: { id: string } } }).data.item.id),
    ).toEqual(['c', 'd', 'e']);
    upstream.send({ type: 'motion', item: { id: 'x'.repeat(20_000) } });
    expect(hub.status()[0]?.buffered).toBe(1);
    await hub.close();
  });

  it('reconnects with backoff after a drop and marks the gap', async () => {
    const { hub, connector } = await setup();
    hub.subscribe('all', [key()]);
    await until(() => connector.open.length === 1);
    (connector.open[0] as FakeConnection).send({ type: 'motion', item: { id: 'before' } });
    const cursor = hub.read('all', CONSOLE, STREAM).cursor;
    (connector.open[0] as FakeConnection).end('connection_lost');
    await until(() => hub.status()[0]?.state === 'retrying');
    expect(hub.status()[0]?.detail).toBe('connection_lost');
    await until(() => connector.open.length === 1);
    (connector.open[0] as FakeConnection).send({ type: 'motion', item: { id: 'after' } });
    expect(kinds(hub.read('all', CONSOLE, STREAM, { after: cursor }))).toEqual([
      'gap:reconnected',
      'motion',
    ]);
    await hub.close();
  });

  it('waits long after the console refuses the credential, and reconnects at once when it changes', async () => {
    const { hub, connector } = await setup();
    connector.failures = ['upgrade_unauthorized'];
    hub.subscribe('all', [key()]);
    await until(() => hub.status()[0]?.detail === 'upgrade_unauthorized');
    expect(hub.status()[0]?.state).toBe('retrying');
    await new Promise((r) => setTimeout(r, 100));
    expect(connector.attempts).toHaveLength(1);
    await hub.close();

    const second = await setup();
    second.hub.subscribe('all', [key()]);
    await until(() => second.connector.open.length === 1);
    second.hub.recheck();
    expect(second.connector.connections).toHaveLength(1);
    second.connector.fingerprints.set(CONSOLE, 'fp-2');
    second.hub.recheck();
    await until(
      () => second.connector.connections.length === 2 && second.connector.open.length === 1,
    );
    await second.hub.close();
  });

  it('waits while the console is not configured or runs an unsupported version', async () => {
    const { hub, connector, supported } = await setup();
    connector.fingerprints.set(CONSOLE, undefined);
    hub.subscribe('all', [key()]);
    await until(() => hub.status()[0]?.state === 'unavailable');
    expect(hub.status()[0]?.detail).toBe('console_not_configured');
    connector.fingerprints.set(CONSOLE, 'fp-1');
    supported.delete(CONSOLE);
    hub.recheck();
    await until(() => hub.status()[0]?.detail === 'operation_unsupported');
    expect(connector.attempts).toHaveLength(0);
    supported.add(CONSOLE);
    hub.recheck();
    await until(() => connector.open.length === 1);
    // An open connection to a console that is no longer supported is closed.
    supported.delete(CONSOLE);
    hub.recheck();
    await until(() => hub.status()[0]?.state === 'unavailable');
    expect(connector.open).toHaveLength(0);
    await hub.close();
  });

  it('limits connection attempts across all feeds (no reconnect storm)', async () => {
    const { hub, connector } = await setup({
      limits: { connectRate: { ratePerSecond: 10, burst: 3 }, backoffBaseMs: 1, backoffMaxMs: 2 },
    });
    connector.failAlways = 'connect_failed';
    const streams = Array.from({ length: 6 }, (_, i) => ({ ...STREAM, streamId: `s${String(i)}` }));
    hub.subscribe(
      'all',
      streams.map((stream) => key(CONSOLE, stream)),
    );
    await new Promise((r) => setTimeout(r, 300));
    // A burst of 3, then about 10 per second.
    expect(connector.attempts.length).toBeGreaterThanOrEqual(4);
    expect(connector.attempts.length).toBeLessThanOrEqual(7);
    await hub.close();
  });

  it('coalesces notifications per client and feed', async () => {
    const { hub, connector, notified } = await setup({ limits: { notifyIntervalMs: 100 } });
    hub.subscribe('all', [key(), key(OTHER_CONSOLE)]);
    await until(() => connector.open.length === 2);
    const [first, second] = connector.open as [FakeConnection, FakeConnection];
    for (let i = 0; i < 20; i++) first.send({ type: 'motion', item: { id: String(i) } });
    second.send({ type: 'motion', item: { id: 'other' } });
    expect(notified).toEqual(['all:console-1:things', 'all:console-2:things']);
    await until(() => notified.length === 3);
    expect(notified[2]).toBe('all:console-1:things');
    await new Promise((r) => setTimeout(r, 150));
    expect(notified).toHaveLength(3);
    await hub.close();
  });

  it('closes every connection on shutdown and refuses new subscriptions', async () => {
    const { hub, connector } = await setup();
    hub.subscribe('all', [key(), key(OTHER_CONSOLE)]);
    await until(() => connector.open.length === 2);
    await hub.close();
    expect(connector.open).toHaveLength(0);
    expect(() => hub.subscribe('all', [key()])).toThrow(/closed/);
  });
});
