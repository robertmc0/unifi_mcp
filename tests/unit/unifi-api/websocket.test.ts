/**
 * The WebSocket client for documented subscriptions (ADR 0020 §2), against a synthetic
 * console over pinned TLS.
 */
import { X509Certificate } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectTls,
  openWebSocket,
  spkiSha256,
  type WebSocketConnection,
  type WebSocketOptions,
} from '@unifi-local-mcp/unifi-api';
import { MockConsole } from '../../fixtures/mock-console.ts';
import { testPki } from '../../fixtures/test-pki.ts';
import { frame, ServerWebSocket, type AcceptOptions } from '../../fixtures/ws-server.ts';

const KEY = 'synthetic-ws-key-SENTINEL-77';
const consoles: MockConsole[] = [];

afterEach(async () => {
  for (const mock of consoles.splice(0)) await mock.stop();
});

async function start(accept: AcceptOptions = {}) {
  const pki = testPki();
  const mock = await MockConsole.start({ key: pki.serverKey, cert: pki.serverCert });
  consoles.push(mock);
  const servers: ServerWebSocket[] = [];
  mock.upgrade = (request, socket) => {
    servers.push(new ServerWebSocket(request, socket, accept));
  };
  const pin = spkiSha256(new X509Certificate(pki.serverCert));
  const open = async (overrides: Partial<WebSocketOptions> = {}) => {
    const socket = await connectTls({
      address: '127.0.0.1',
      port: mock.port,
      host: '127.0.0.1',
      trust: { mode: 'pinned', spkiSha256: [pin] },
      timeoutMs: 2000,
      signal: AbortSignal.timeout(5000),
    });
    return openWebSocket({
      socket,
      path: '/proxy/protect/integration/v1/subscribe/events',
      hostHeader: '127.0.0.1',
      headers: { 'x-api-key': KEY },
      maxMessageBytes: 64 * 1024,
      handshakeTimeoutMs: 2000,
      pingIntervalMs: 60_000,
      pongTimeoutMs: 1000,
      signal: new AbortController().signal,
      ...overrides,
    });
  };
  const server = async (): Promise<ServerWebSocket> => {
    for (let i = 0; i < 100 && servers.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const first = servers[0];
    if (first === undefined) throw new Error('no upgrade arrived');
    return first;
  };
  return { mock, open, server };
}

function collect(connection: WebSocketConnection): string[] {
  const messages: string[] = [];
  connection.onMessage((text) => messages.push(text));
  return messages;
}

const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
};

describe('WebSocket client', () => {
  it('upgrades with the key header only, and receives text messages, also fragmented', async () => {
    const { mock, open, server } = await start();
    const connection = await open();
    const messages = collect(connection);
    const ws = await server();
    expect(mock.requests[0]).toMatchObject({
      method: 'GET',
      url: '/proxy/protect/integration/v1/subscribe/events',
    });
    const headers = mock.requests[0]?.headers ?? {};
    expect(headers['x-api-key']).toBe(KEY);
    expect(headers['sec-websocket-version']).toBe('13');
    expect(headers['sec-websocket-protocol']).toBeUndefined();
    expect(headers['sec-websocket-extensions']).toBeUndefined();

    ws.sendJson({ type: 'add', item: { id: 'e1' } });
    ws.sendFrame(0x1, '{"type":', { fin: false });
    ws.sendFrame(0x9, 'ping-in-between');
    ws.sendFrame(0x0, '"update"}');
    ws.sendFrame(0x2, Buffer.from('{"binary":true}'));
    await until(() => messages.length === 3);
    expect(messages).toEqual([
      '{"type":"add","item":{"id":"e1"}}',
      '{"type":"update"}',
      '{"binary":true}',
    ]);
    // The ping was answered with a masked pong carrying the same payload.
    await until(() => ws.received.some((f) => f.opcode === 0xa));
    const pong = ws.received.find((f) => f.opcode === 0xa);
    expect(pong).toMatchObject({ masked: true });
    expect(pong?.payload.toString()).toBe('ping-in-between');
    connection.close();
    expect(await connection.closed).toEqual({ code: 'closed' });
    // It never sent a data frame, and every frame was masked.
    expect(ws.received.every((f) => f.masked && f.opcode >= 0x8)).toBe(true);
  });

  it.each([
    ['401', 'HTTP/1.1 401 Unauthorized', 'upgrade_unauthorized', 401],
    ['403', 'HTTP/1.1 403 Forbidden', 'upgrade_unauthorized', 403],
    ['404', 'HTTP/1.1 404 Not Found', 'upgrade_refused', 404],
  ])('reports a refused upgrade (%s) by its status only', async (_label, line, code, status) => {
    const { mock, open } = await start();
    mock.upgrade = (_request, socket) => {
      socket.end(
        `${line}\r\nContent-Type: application/json\r\nContent-Length: 27\r\n\r\n{"secret":"SENTINEL-BODY"}`,
      );
    };
    const error = await open().catch((e: unknown) => e);
    expect(error).toMatchObject({ code, status });
    expect((error as Error).message).not.toContain('SENTINEL');
  });

  it.each([
    ['a wrong accept value', { accept: 'd3JvbmcgYWNjZXB0IHZhbHVlIQ==' }],
    [
      'an extension it did not offer',
      { extraHeaders: ['Sec-WebSocket-Extensions: permessage-deflate'] },
    ],
    ['a subprotocol it did not offer', { extraHeaders: ['Sec-WebSocket-Protocol: chat'] }],
  ])('refuses an upgrade with %s', async (_label, accept) => {
    const { open } = await start(accept);
    await expect(open()).rejects.toMatchObject({ code: 'handshake_invalid' });
  });

  it('times out a console that never answers the upgrade', async () => {
    const { mock, open } = await start();
    mock.upgrade = () => undefined;
    await expect(open({ handshakeTimeoutMs: 100 })).rejects.toMatchObject({
      code: 'handshake_timeout',
    });
  });

  it('closes on a message over the bound before buffering it, also across fragments', async () => {
    for (const send of [
      (ws: ServerWebSocket) => {
        ws.sendRaw(frame(0x1, Buffer.alloc(70 * 1024, 0x61)).subarray(0, 10));
      },
      (ws: ServerWebSocket) => {
        ws.sendFrame(0x1, Buffer.alloc(40 * 1024, 0x61), { fin: false });
        ws.sendFrame(0x0, Buffer.alloc(40 * 1024, 0x61));
      },
    ]) {
      const { open, server } = await start();
      const connection = await open();
      const messages = collect(connection);
      send(await server());
      expect(await connection.closed).toEqual({ code: 'message_too_large' });
      expect(messages).toEqual([]);
    }
  });

  it.each([
    [
      'a masked frame',
      (ws: ServerWebSocket) => {
        ws.sendFrame(0x1, 'x', { masked: true });
      },
    ],
    [
      'reserved bits',
      (ws: ServerWebSocket) => {
        ws.sendFrame(0x1, 'x', { rsv: 4 });
      },
    ],
    [
      'an unknown opcode',
      (ws: ServerWebSocket) => {
        ws.sendFrame(0x3, 'x');
      },
    ],
    [
      'a continuation without a start',
      (ws: ServerWebSocket) => {
        ws.sendFrame(0x0, 'x');
      },
    ],
    [
      'a fragmented ping',
      (ws: ServerWebSocket) => {
        ws.sendFrame(0x9, 'x', { fin: false });
      },
    ],
    [
      'invalid UTF-8',
      (ws: ServerWebSocket) => {
        ws.sendFrame(0x1, Buffer.from([0xc3, 0x28]));
      },
    ],
  ])('closes on %s as a protocol error, delivering nothing', async (_label, send) => {
    const { open, server } = await start();
    const connection = await open();
    const messages = collect(connection);
    send(await server());
    expect(await connection.closed).toEqual({ code: 'protocol_error' });
    expect(messages).toEqual([]);
  });

  it('reports a close frame and a dropped connection', async () => {
    const first = await start();
    const closing = await first.open();
    (await first.server()).close(1011);
    expect(await closing.closed).toEqual({ code: 'closed_by_console', closeCode: 1011 });

    const second = await start();
    const dropped = await second.open();
    (await second.server()).drop();
    expect(await dropped.closed).toEqual({ code: 'connection_lost' });
  });

  it('pings an idle connection and closes it when nothing comes back', async () => {
    const answering = await start();
    const alive = await answering.open({ pingIntervalMs: 50, pongTimeoutMs: 100 });
    const ws = await answering.server();
    await until(() => ws.received.filter((f) => f.opcode === 0x9).length >= 3);
    alive.close();
    expect(await alive.closed).toEqual({ code: 'closed' });

    const silent = await start({ autoPong: false });
    const idle = await silent.open({ pingIntervalMs: 50, pongTimeoutMs: 100 });
    expect(await idle.closed).toEqual({ code: 'idle_timeout' });
  });

  it('ends a close the console does not answer after a grace period', async () => {
    const { open, server } = await start({ answerClose: false });
    const connection = await open();
    const ws = await server();
    const started = Date.now();
    connection.close();
    expect(await connection.closed).toEqual({ code: 'closed' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    await ws.closed;
  });

  it('closes when its signal is aborted', async () => {
    const { open, server } = await start();
    const controller = new AbortController();
    const connection = await open({ signal: controller.signal });
    const ws = await server();
    controller.abort();
    expect(await connection.closed).toEqual({ code: 'closed' });
    await until(() => ws.received.some((f) => f.opcode === 0x8));
  });
});
