/**
 * Shared safety pieces of the opt-in live read-only tests (ADR 0018 §7, ADR 0019). Never
 * used by `npm run check` or CI.
 *
 * - `ReadOnlyGuard` sits in front of the executor and refuses anything that is not a GET
 *   of a read; every request is recorded and checked by the tests.
 * - `upgradeStatus` asks a documented WebSocket endpoint for an upgrade and returns only the
 *   HTTP status: the socket is closed as soon as the status line arrives, and nothing the
 *   console sends after it is read.
 * - Reports keep categories and outcomes only; `category` and `httpDetail` let no free text
 *   through, and `okOutcome` tells an empty list from a validated one.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as prettier from 'prettier';
import type { ExecutionCall, ExecutorOutcome, OperationExecutor } from '@unifi-local-mcp/core';
import { connectTls, type ConsoleConnection, type EgressGuard } from '@unifi-local-mcp/unifi-api';

/** Refuses anything but a GET of a read, and records what was sent. */
export class ReadOnlyGuard implements OperationExecutor {
  readonly sent: string[] = [];
  readonly #inner: OperationExecutor;
  constructor(inner: OperationExecutor) {
    this.#inner = inner;
  }
  execute(call: ExecutionCall): Promise<ExecutorOutcome> {
    if (call.descriptor.httpMethod !== 'GET' || call.descriptor.effect !== 'read') {
      throw new Error(`Live tests never send ${call.descriptor.httpMethod} requests.`);
    }
    this.sent.push(`GET ${call.descriptor.pathTemplate}`);
    return this.#inner.execute(call);
  }
}

/** An upstream enum value such as `GATEWAY`, or `other`; never free text. */
export const category = (value: unknown): string =>
  typeof value === 'string' && /^[A-Z][A-Z_]{0,31}$/.test(value) ? value : 'other';

/**
 * A short identifier such as `motion`, `camera` or `connection_lost`, or `fallback`; never
 * free text. Event types, device kinds, actions and our own close codes look like this.
 */
export const identifier = (value: unknown, fallback = 'other'): string =>
  typeof value === 'string' && /^[a-z][A-Za-z_]{0,39}$/.test(value) ? value : fallback;

/** ` (HTTP 500, code …)` from an executor message, which carries only a vetted code. */
export const httpDetail = (message: string): string => {
  const match = /\(HTTP (\d{3})(?:, code ([A-Za-z0-9][A-Za-z0-9_.-]{0,63}))?\)/.exec(message);
  if (match === null) return '';
  return ` (HTTP ${match[1] ?? ''}${match[2] === undefined ? '' : `, code ${match[2]}`})`;
};

/**
 * `ok`, or `ok (empty)` for a list that returned no items. An empty list matches any item
 * schema, so the coverage matrix does not count it as live validation of the read.
 */
export const okOutcome = (data: unknown): string =>
  Array.isArray(data) && data.length === 0 ? 'ok (empty)' : 'ok';

/**
 * Writes a report as the repository formats JSON, so a committed record passes
 * `npm run check` as written. The folder is created if needed.
 */
export async function writeReport(path: string, report: object): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const config = (await prettier.resolveConfig(path)) ?? {};
  await writeFile(
    path,
    await prettier.format(JSON.stringify(report), { ...config, filepath: path }),
  );
}

export interface Outcome {
  operationId: string;
  outcome: string;
  mismatches?: string[];
}

/**
 * The HTTP status a console answers to a WebSocket upgrade of a documented subscription,
 * sent with the given credential over the same egress check and pinned TLS as every other
 * request. Only the status line is read; the socket is then closed.
 */
export async function upgradeStatus(options: {
  connection: ConsoleConnection;
  egress: EgressGuard;
  path: string;
  credential: string;
}): Promise<number | 'timeout' | 'closed' | 'malformed'> {
  const { connection } = options;
  const resolved = await options.egress.resolve(connection.host);
  const socket = await connectTls({
    address: resolved.address,
    port: connection.port,
    host: connection.host,
    trust: connection.trust,
    timeoutMs: 10_000,
    signal: AbortSignal.timeout(15_000),
  });
  return new Promise((resolve) => {
    let head = '';
    let settled = false;
    const done = (value: number | 'timeout' | 'closed' | 'malformed'): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(10_000, () => {
      done('timeout');
    });
    socket.on('data', (chunk: Buffer) => {
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n');
      if (end >= 0) {
        const status = /^HTTP\/1\.1 (\d{3}) /.exec(head.slice(0, end));
        done(status === null ? 'malformed' : Number(status[1]));
      } else if (head.length > 1024) {
        done('malformed');
      }
    });
    socket.on('error', () => {
      done('closed');
    });
    socket.on('close', () => {
      done('closed');
    });
    const host =
      connection.port === 443 ? connection.host : `${connection.host}:${String(connection.port)}`;
    socket.write(
      [
        `GET ${connection.endpoint.basePath}${options.path} HTTP/1.1`,
        `Host: ${host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        'Sec-WebSocket-Version: 13',
        `${connection.endpoint.auth.header}: ${options.credential}`,
        '',
        '',
      ].join('\r\n'),
    );
  });
}
