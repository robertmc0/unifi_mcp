/**
 * The stdio relay with fake transports (ADR 0014): messages pass unchanged, the 2025-era
 * protocol version is propagated, and upstream failures are answered, never left hanging.
 */
import type { JSONRPCMessage } from '@modelcontextprotocol/client';
import {
  BRIDGE_ERROR,
  redirectConsole,
  Relay,
  type UpstreamTransport,
} from '@unifi-local-mcp/stdio-bridge';
import { describe, expect, it, vi } from 'vitest';
import { memoryLogger } from '../telemetry/fixtures.ts';

class FakeTransport implements UpstreamTransport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  readonly sent: JSONRPCMessage[] = [];
  readonly versions: string[] = [];
  closed = false;
  failWith: Error | undefined;

  start(): Promise<void> {
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    this.sent.push(message);
    return this.failWith === undefined ? Promise.resolve() : Promise.reject(this.failWith);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  setProtocolVersion(version: string): void {
    this.versions.push(version);
  }

  deliver(message: unknown): void {
    this.onmessage?.(message as JSONRPCMessage);
  }
}

async function setup() {
  const downstream = new FakeTransport();
  const upstream = new FakeTransport();
  const onFatal = vi.fn();
  const onClosed = vi.fn();
  const relay = new Relay({
    downstream,
    upstream,
    logger: memoryLogger().logger,
    onFatal,
    onClosed,
  });
  await relay.start();
  return { downstream, upstream, onFatal, onClosed, relay };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Relay', () => {
  it('passes messages unchanged in both directions', async () => {
    const r = await setup();
    const request = { jsonrpc: '2.0', id: 7, method: 'tools/list', params: { _meta: { x: 1 } } };
    r.downstream.deliver(request);
    expect(r.upstream.sent).toEqual([request]);
    const response = { jsonrpc: '2.0', id: 7, result: { tools: [] } };
    r.upstream.deliver(response);
    expect(r.downstream.sent).toEqual([response]);
  });

  it('propagates the negotiated 2025-era protocol version from the initialize response', async () => {
    const r = await setup();
    r.downstream.deliver({
      jsonrpc: '2.0',
      id: 'init-1',
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    });
    r.upstream.deliver({ jsonrpc: '2.0', id: 'other', result: { protocolVersion: '1999-01-01' } });
    expect(r.upstream.versions).toEqual([]);
    r.upstream.deliver({
      jsonrpc: '2.0',
      id: 'init-1',
      result: { protocolVersion: '2025-06-18', capabilities: {} },
    });
    expect(r.upstream.versions).toEqual(['2025-06-18']);
  });

  it('answers a request that cannot be delivered, without stopping', async () => {
    const r = await setup();
    r.upstream.failWith = new Error('ECONNREFUSED');
    r.downstream.deliver({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    r.downstream.deliver({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await flush();
    expect(r.downstream.sent).toEqual([
      {
        jsonrpc: '2.0',
        id: 3,
        error: {
          code: BRIDGE_ERROR.unreachable,
          message: 'The unifi-local-mcp service could not be reached.',
        },
      },
    ]);
    expect(r.onFatal).not.toHaveBeenCalled();
  });

  it('treats a rejected token as fatal, once', async () => {
    const r = await setup();
    r.upstream.failWith = Object.assign(new Error('Unauthorized'), { status: 401 });
    r.downstream.deliver({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await flush();
    r.downstream.deliver({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await flush();
    expect(r.downstream.sent).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: BRIDGE_ERROR.unauthorized,
          message: 'The unifi-local-mcp service rejected the client token.',
        },
      },
    ]);
    expect(r.upstream.sent).toHaveLength(1); // nothing more is forwarded
    expect(r.onFatal).toHaveBeenCalledTimes(1);
  });

  it('closes both sides when the harness goes away', async () => {
    const r = await setup();
    r.downstream.onclose?.();
    await flush();
    expect(r.upstream.closed).toBe(true);
    expect(r.onClosed).toHaveBeenCalledTimes(1);
  });
});

describe('redirectConsole', () => {
  it('sends every console method to the target stream', () => {
    const stdout = vi.spyOn(process.stdout, 'write');
    const written: string[] = [];
    const restore = redirectConsole({ write: (text: string) => written.push(text) });
    try {
      console.log('one', 1);
      console.info('two');
      console.warn('three');
      console.error('four');
      console.debug('five');
    } finally {
      restore();
    }
    expect(written).toEqual(['one 1\n', 'two\n', 'three\n', 'four\n', 'five\n']);
    expect(stdout).not.toHaveBeenCalled();
  });
});
