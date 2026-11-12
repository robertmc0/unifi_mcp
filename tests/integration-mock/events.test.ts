/**
 * Event subscriptions end to end (spec §11, §16 Phase 3; ADR 0020): real MCP SDK v2
 * clients → HTTP gate → per-client handlers → event hub → WebSocket on the synthetic
 * console. A synthetic stream stands in for the Protect streams, which have their own
 * tests.
 */
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { defineEventStream } from '@unifi-local-mcp/core';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { REPO_ROOT } from '../../scripts/lib/api-specs.ts';
import { useTempDirs } from '../unit/storage/fixtures.ts';
import { CLI, connect, NETWORK_KEY, startTestService, type TestService } from './fixtures.ts';

const tempDir = useTempDirs();

const THINGS = defineEventStream({
  operationId: 'network.things.subscribe',
  moduleId: 'network',
  category: 'things',
  effect: 'read',
  permission: 'network.things.read',
  risk: 'low',
  sensitivityTags: [],
  approvalRequired: false,
  siteScoped: false,
  streamId: 'things',
  description: 'Synthetic things.',
  documentationUrl: 'https://developer.invalid/network/1.0',
  contractRevision: '1.0',
  apiVersionRange: '>=1.0 <2',
  pathTemplate: '/v1/subscribe/things',
  messageSchema: z.object({
    type: z.string(),
    item: z.object({ id: z.string(), secret: z.string().optional() }),
  }),
  maxMessageBytes: 64 * 1024,
  classify: (message) =>
    message.type === 'motion'
      ? { kind: 'motion', sensitivityTags: [] }
      : message.type === 'nfc'
        ? { kind: 'nfcScanned', sensitivityTags: ['personal_identifier' as const] }
        : undefined,
  project: (message) => ({ type: message.type, item: { id: message.item.id } }),
});

const FAST_HUB = {
  lingerMs: 100,
  backoffBaseMs: 20,
  backoffMaxMs: 40,
  notifyIntervalMs: 0,
  connectRate: { ratePerSecond: 1000, burst: 1000 },
};

async function start(options: Partial<Parameters<typeof startTestService>[0]> = {}) {
  const t = await startTestService({
    dir: await tempDir(),
    eventStreams: [THINGS],
    eventHubLimits: FAST_HUB,
    ...options,
  });
  return { t, uri: `unifi://consoles/${t.consoleId}/network/things` };
}

const until = async (check: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
};

function updates(client: Client): string[] {
  const seen: string[] = [];
  client.setNotificationHandler('notifications/resources/updated', (notification) => {
    seen.push(notification.params.uri);
  });
  return seen;
}

async function readJson(client: Client, uri: string): Promise<Record<string, unknown>> {
  const result = await client.readResource({ uri });
  const text = (result.contents[0] as { text?: string } | undefined)?.text ?? '{}';
  return JSON.parse(text) as Record<string, unknown>;
}

const kinds = (body: Record<string, unknown>) =>
  (body['events'] as { kind?: string; gap?: string }[]).map((e) => e.kind ?? `gap:${e.gap ?? ''}`);

const open = (t: TestService) => t.sockets.filter((s) => !s.isClosed);

describe('event subscriptions', () => {
  it('list, subscribe, notify and read, with one upstream subscription and the key only upstream', async () => {
    const { t, uri } = await start();
    const client = await connect(t.mcpUrl, t.token('watcher', ['network.things.read']));
    const resources = await client.listResources();
    expect(resources.resources.map((r) => r.uri)).toEqual([uri]);
    const seen = updates(client);
    const subscription = await client.listen({ resourceSubscriptions: [uri] });
    expect(subscription.honoredFilter).toEqual({ resourceSubscriptions: [uri] });
    await until(() => open(t).length === 1);
    const upgrade = t.mock.requests.find((r) => r.url.includes('/subscribe/'));
    expect(upgrade).toMatchObject({
      method: 'GET',
      url: '/proxy/network/integration/v1/subscribe/things',
    });
    expect(upgrade?.headers['x-api-key']).toBe(NETWORK_KEY);

    const ws = open(t)[0];
    ws?.sendJson({ type: 'motion', item: { id: 'm1', secret: 'SENTINEL-SECRET' } });
    ws?.sendJson({ type: 'unknown', item: { id: 'u1' } });
    await until(() => seen.length === 1);
    expect(seen).toEqual([uri]);
    const body = await readJson(client, uri);
    expect(body).toMatchObject({ status: 'ok', state: 'connected', truncated: false, more: false });
    expect(kinds(body)).toEqual(['motion']);
    expect(JSON.stringify(body)).not.toContain('SENTINEL');
    expect(JSON.stringify(body)).not.toContain(NETWORK_KEY);

    // Newer events only, through the cursor.
    ws?.sendJson({ type: 'motion', item: { id: 'm2' } });
    await until(() => seen.length === 2);
    const page = await readJson(client, `${uri}?after=${String(body['cursor'])}&limit=10`);
    expect((page['events'] as { data: unknown }[]).map((e) => e.data)).toEqual([
      { type: 'motion', item: { id: 'm2' } },
    ]);
    const actions = t.service.audit
      .list({ actorId: 'watcher', limit: 50 })
      .map((e) => `${e.action}:${e.outcome}`);
    expect(actions).toContain('events.subscribe:success');
    expect(actions.filter((a) => a === 'resource.read:success')).toHaveLength(2);
    await subscription.close();
  });

  it('gives a client only the streams and events it may see, and only its own notifications', async () => {
    const { t, uri } = await start();
    const outsider = await connect(t.mcpUrl, t.token('outsider', ['network.devices.read']));
    expect((await outsider.listResources()).resources).toEqual([]);
    const refused = await outsider.listen({ resourceSubscriptions: [uri, 'unifi://other'] });
    expect(refused.honoredFilter).toEqual({});
    await expect(outsider.readResource({ uri })).rejects.toThrow();

    const plain = await connect(t.mcpUrl, t.token('plain', ['network.things.read']));
    const trusted = await connect(
      t.mcpUrl,
      t.token('trusted', ['network.things.read'], true, ['personal_identifier']),
    );
    const plainSeen = updates(plain);
    const trustedSeen = updates(trusted);
    // Only the permitted URI is acknowledged; another console's and unknown ones are not.
    const a = await plain.listen({
      resourceSubscriptions: [uri, 'unifi://consoles/not-granted/network/things', `${uri}x`, uri],
    });
    expect(a.honoredFilter).toEqual({ resourceSubscriptions: [uri] });
    const b = await trusted.listen({ resourceSubscriptions: [uri] });
    await until(() => open(t).length === 1);
    open(t)[0]?.sendJson({ type: 'nfc', item: { id: 'n1' } });
    await until(() => trustedSeen.length === 1);
    open(t)[0]?.sendJson({ type: 'motion', item: { id: 'm1' } });
    await until(() => plainSeen.length === 1 && trustedSeen.length === 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(plainSeen).toHaveLength(1);
    expect(kinds(await readJson(plain, uri))).toEqual(['motion']);
    expect(kinds(await readJson(trusted, uri))).toEqual(['nfcScanned', 'motion']);
    expect(t.sockets).toHaveLength(1);
    await a.close();
    await b.close();
  });

  it('closes the upstream subscription after the last client leaves', async () => {
    const { t, uri } = await start();
    const client = await connect(t.mcpUrl, t.token('watcher', ['network.things.read']));
    const subscription = await client.listen({ resourceSubscriptions: [uri] });
    await until(() => open(t).length === 1 && t.service.http.openSubscriptions === 1);
    await subscription.close();
    await until(() => t.service.http.openSubscriptions === 0);
    await until(() => open(t).length === 0);
    expect(await readJson(client, uri)).toMatchObject({ status: 'ok', state: 'inactive' });
  });

  it('closes the subscription when the client is revoked or loses the grant', async () => {
    const { t, uri } = await start({ streamRecheckMs: 50 });
    const revoked = await connect(t.mcpUrl, t.token('revoked', ['network.things.read']));
    const first = await revoked.listen({ resourceSubscriptions: [uri] });
    await until(() => t.service.http.openSubscriptions === 1);
    t.service.clients.revoke('revoked', CLI);
    expect(await first.closed).toBe('remote');
    await until(() => t.service.http.openSubscriptions === 0);

    const narrowed = await connect(t.mcpUrl, t.token('narrowed', ['network.things.read']));
    const seen = updates(narrowed);
    const second = await narrowed.listen({ resourceSubscriptions: [uri] });
    await until(() => open(t).length === 1);
    t.service.clients.setPolicy(
      'narrowed',
      { allow: ['network.devices.read'], consoles: { [t.consoleId]: {} } },
      CLI,
    );
    open(t)[0]?.sendJson({ type: 'motion', item: { id: 'm1' } });
    expect(await second.closed).toBe('remote');
    expect(seen).toEqual([]);
  });

  it('closes a subscription after its lifetime; the client subscribes again', async () => {
    const { t, uri } = await start({ streamRecheckMs: 50, listenLimits: { maxLifetimeMs: 200 } });
    const client = await connect(t.mcpUrl, t.token('watcher', ['network.things.read']));
    const subscription = await client.listen({ resourceSubscriptions: [uri] });
    expect(await subscription.closed).toBe('remote');
    const again = await client.listen({ resourceSubscriptions: [uri] });
    expect(again.honoredFilter).toEqual({ resourceSubscriptions: [uri] });
  });

  it('limits subscriptions per client and refuses listen in a batch', async () => {
    const { t, uri } = await start({ listenLimits: { maxPerClient: 1 } });
    const token = t.token('watcher', ['network.things.read']);
    const client = await connect(t.mcpUrl, token);
    await client.listen({ resourceSubscriptions: [uri] });
    await expect(client.listen({ resourceSubscriptions: [uri] })).rejects.toThrow(/limit/i);
    const batch = await fetch(t.mcpUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'subscriptions/listen', params: { notifications: {} } },
      ]),
    });
    expect(batch.status).toBe(400);
  });

  it('reconnects after the console drops the subscription and marks the gap', async () => {
    const { t, uri } = await start();
    const client = await connect(t.mcpUrl, t.token('watcher', ['network.things.read']));
    const seen = updates(client);
    await client.listen({ resourceSubscriptions: [uri] });
    await until(() => open(t).length === 1);
    open(t)[0]?.sendJson({ type: 'motion', item: { id: 'before' } });
    await until(() => seen.length === 1);
    open(t)[0]?.drop();
    await until(() => t.sockets.length === 2 && open(t).length === 1);
    open(t)[0]?.sendJson({ type: 'motion', item: { id: 'after' } });
    await until(() => seen.length === 2);
    expect(kinds(await readJson(client, uri))).toEqual(['motion', 'gap:reconnected', 'motion']);
  });

  it('work through the stdio bridge for a 2026-era client', async () => {
    const { t, uri } = await start();
    const client = new Client(
      { name: 'bridge', version: '0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(REPO_ROOT, 'packages', 'stdio-bridge', 'src', 'main.ts')],
        env: {
          PATH: process.env['PATH'] ?? '',
          UNIFI_MCP_URL: t.mcpUrl.href,
          UNIFI_MCP_TOKEN: t.token('bridged', ['network.things.read']),
        },
        stderr: 'pipe',
      }),
    );
    try {
      const seen = updates(client);
      const subscription = await client.listen({ resourceSubscriptions: [uri] });
      expect(subscription.honoredFilter).toEqual({ resourceSubscriptions: [uri] });
      await until(() => open(t).length === 1);
      open(t)[0]?.sendJson({ type: 'motion', item: { id: 'm1' } });
      await until(() => seen.length === 1);
      expect(kinds(await readJson(client, uri))).toEqual(['motion']);
    } finally {
      await client.close();
    }
  });

  it('serves 2025-era clients the resources without subscriptions', async () => {
    const { t, uri } = await start();
    const legacy = await connect(t.mcpUrl, t.token('legacy', ['network.things.read']), 'legacy');
    expect(legacy.getServerCapabilities()?.resources?.subscribe).not.toBe(true);
    expect((await legacy.listResources()).resources.map((r) => r.uri)).toEqual([uri]);
    expect(await readJson(legacy, uri)).toMatchObject({
      status: 'ok',
      state: 'inactive',
      events: [],
    });
  });

  it('closes the subscription of a client that stops reading', async () => {
    const { t, uri } = await start({ listenLimits: { slowConsumerMs: 0 } });
    const token = t.token('slow', ['network.things.read']);
    // A real client whose listen stream stops being read after the acknowledgement.
    const stalling = async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${token}`);
      const response = await fetch(input, { ...init, headers });
      const isListen = typeof init?.body === 'string' && init.body.includes('subscriptions/listen');
      if (!isListen || response.body === null) return response;
      const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
      const first = await reader.read();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (!first.done) controller.enqueue(first.value);
        },
      });
      return new Response(body, { status: response.status, headers: response.headers });
    };
    const slow = new Client(
      { name: 'slow', version: '0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await slow.connect(new StreamableHTTPClientTransport(t.mcpUrl, { fetch: stalling }));
    await slow.listen({ resourceSubscriptions: [uri] });
    const reader = await connect(t.mcpUrl, t.token('reader', ['network.things.read']));
    const seen = updates(reader);
    await reader.listen({ resourceSubscriptions: [uri] });
    await until(() => open(t).length === 1 && t.service.http.openSubscriptions === 2);
    const ws = open(t)[0];
    for (let batch = 0; batch < 400 && t.service.http.openSubscriptions === 2; batch++) {
      for (let i = 0; i < 200; i++) {
        ws?.sendJson({ type: 'motion', item: { id: `${String(batch)}-${String(i)}` } });
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    await until(() => t.service.http.openSubscriptions === 1, 10_000);
    expect(t.logs.join('')).toContain('the client is not reading');
    // The client that reads is unaffected.
    const before = seen.length;
    ws?.sendJson({ type: 'motion', item: { id: 'last' } });
    await until(() => seen.length > before);
    await slow.close().catch(() => undefined);
  }, 60_000);
});
