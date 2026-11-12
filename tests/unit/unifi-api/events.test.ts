/**
 * The UniFi event connector (ADR 0020 §2): egress check, verified TLS before the key is
 * sent, the module's base path and key header, and errors reduced to codes.
 */
import { X509Certificate } from 'node:crypto';
import { defineEventStream } from '@unifi-local-mcp/core';
import {
  EgressGuard,
  spkiSha256,
  UnifiEventConnector,
  type EventConnectError,
} from '@unifi-local-mcp/unifi-api';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { testPki } from '../../fixtures/test-pki.ts';
import { ServerWebSocket } from '../../fixtures/ws-server.ts';
import { useTempDirs } from '../storage/fixtures.ts';
import { CLI, unifiHarness, type UnifiHarnessOptions } from './fixtures.ts';

const tempDir = useTempDirs();
const PROTECT_KEY = 'synthetic-protect-key-SENTINEL-55';

const STREAM = defineEventStream({
  operationId: 'protect.events.subscribe',
  moduleId: 'protect',
  category: 'events',
  effect: 'read',
  permission: 'protect.events.read',
  risk: 'low',
  sensitivityTags: [],
  approvalRequired: false,
  siteScoped: false,
  streamId: 'events',
  description: 'Synthetic.',
  documentationUrl: 'https://developer.invalid/protect',
  contractRevision: '1.0',
  apiVersionRange: '>=1.0 <2',
  pathTemplate: '/v1/subscribe/events',
  messageSchema: z.object({ type: z.string() }),
  maxMessageBytes: 64 * 1024,
  classify: () => ({ kind: 'any', sensitivityTags: [] }),
  project: (message) => message,
});

async function setup(options: Partial<UnifiHarnessOptions> & { credential?: boolean } = {}) {
  const h = await unifiHarness({ dir: await tempDir(), ...options });
  h.consoles.setModulePort(h.consoleId, 'protect', h.mock.port, CLI);
  if (options.credential !== false)
    h.consoles.setCredential(h.consoleId, 'protect', PROTECT_KEY, CLI);
  const servers: ServerWebSocket[] = [];
  h.mock.upgrade = (request, socket) => {
    if (request.headers['x-api-key'] !== PROTECT_KEY) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    servers.push(new ServerWebSocket(request, socket));
  };
  const connector = new UnifiEventConnector({
    consoles: h.consoles,
    egress: new EgressGuard({ allow: options.allow ?? ['127.0.0.1/32'] }),
    logger: h.log.logger,
    connectTimeoutMs: 2000,
  });
  const target = { consoleId: h.consoleId, stream: STREAM };
  return { h, connector, servers, target };
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (error: unknown) => error as EventConnectError,
  );

describe('UniFi event connector', () => {
  it('subscribes over verified TLS with the module key, at the documented local path', async () => {
    const { h, connector, servers, target } = await setup();
    const connection = await connector.connect(target, new AbortController().signal);
    const messages: string[] = [];
    connection.onMessage((text) => messages.push(text));
    expect(h.mock.requests.at(-1)).toMatchObject({
      method: 'GET',
      url: '/proxy/protect/integration/v1/subscribe/events',
    });
    servers[0]?.sendJson({ type: 'add' });
    for (let i = 0; i < 100 && messages.length === 0; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(messages).toEqual(['{"type":"add"}']);
    connection.close();
    expect(await connection.closed).toEqual({ code: 'closed' });
    expect(h.log.lines.join('')).not.toContain(PROTECT_KEY);
    expect(h.log.lines.join('')).toContain('event subscription open');
    await h.close();
  });

  it('refuses before connecting when the module has no credential', async () => {
    const { h, connector, target } = await setup({ credential: false });
    expect(connector.fingerprint(h.consoleId, 'protect')).toBeUndefined();
    expect(await failure(connector.connect(target, new AbortController().signal))).toMatchObject({
      code: 'console_not_configured',
    });
    expect(h.mock.requests).toEqual([]);
    await h.close();
  });

  it('never sends the key when egress or TLS verification fails', async () => {
    const denied = await setup({ allow: ['10.0.0.0/8'] });
    expect(
      await failure(denied.connector.connect(denied.target, new AbortController().signal)),
    ).toMatchObject({ code: 'egress_denied' });
    expect(denied.h.mock.requests).toEqual([]);
    await denied.h.close();

    const pinned = await setup({
      tls: { mode: 'pinned', pins: [`sha256/${'A'.repeat(43)}=`] },
    });
    expect(
      await failure(pinned.connector.connect(pinned.target, new AbortController().signal)),
    ).toMatchObject({ code: 'tls_pin_mismatch' });
    expect(pinned.h.mock.requests).toEqual([]);
    await pinned.h.close();
  });

  it('reports a refused credential by its status only', async () => {
    const { h, connector, target } = await setup();
    h.consoles.setCredential(h.consoleId, 'protect', 'another-synthetic-key-123', CLI);
    expect(await failure(connector.connect(target, new AbortController().signal))).toMatchObject({
      code: 'upgrade_unauthorized',
      status: 401,
    });
    await h.close();
  });

  it('fingerprints the address, trust and credential without revealing them', async () => {
    const { h, connector } = await setup();
    const first = connector.fingerprint(h.consoleId, 'protect');
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(connector.fingerprint(h.consoleId, 'protect')).toBe(first);
    h.consoles.setCredential(h.consoleId, 'protect', 'another-synthetic-key-123', CLI);
    const second = connector.fingerprint(h.consoleId, 'protect');
    expect(second).not.toBe(first);
    const pin = spkiSha256(new X509Certificate(testPki().serverCert));
    h.consoles.setTls(h.consoleId, { mode: 'pinned', pins: [pin] }, CLI);
    expect(connector.fingerprint(h.consoleId, 'protect')).not.toBe(second);
    await h.close();
  });
});
