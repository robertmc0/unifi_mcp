/**
 * The metrics listener (spec §12, §7.3; ADR 0025): its own port, off unless enabled.
 *
 *   GET /metrics   bearer token from UNIFI_MCP_METRICS_TOKEN_FILE → Prometheus text
 *   anything else  404 (405 for other methods on /metrics)
 *
 * The token is a deployment secret of its own. It is not an MCP client token and not an
 * administrator session: it opens nothing but this page, and neither of the others opens
 * it. Repeated failures from one address are throttled, as on the MCP listener. Scrapes
 * are not audited (one every few seconds would bury the audit trail); refused attempts
 * are.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RateLimiter } from '@unifi-local-mcp/core';
import {
  PROMETHEUS_CONTENT_TYPE,
  type AuditLog,
  type Logger,
  type MetricsRegistry,
} from '@unifi-local-mcp/telemetry';

export const METRICS_PATH = '/metrics';
const FAILURE_LIMIT = { ratePerSecond: 0.2, burst: 10 };
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]{32,512}=*$/;
const MAX_TOKEN_FILE_BYTES = 4096;

export class MetricsTokenError extends Error {
  override readonly name = 'MetricsTokenError';
  readonly code: 'METRICS_TOKEN_INVALID' | 'METRICS_TOKEN_FILE_EXISTS';

  constructor(message: string, code: MetricsTokenError['code'] = 'METRICS_TOKEN_INVALID') {
    super(message);
    this.code = code;
  }
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Reads the scrape token: one line of at least 32 characters from the bearer-token
 * alphabet. Returns only its digest; the token itself is not kept in memory.
 */
export function loadMetricsToken(path: string): Buffer {
  let text: string;
  try {
    if (statSync(path).size > MAX_TOKEN_FILE_BYTES) {
      throw new MetricsTokenError('The metrics token file is too large.');
    }
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof MetricsTokenError) throw error;
    throw new MetricsTokenError(
      `Cannot read the metrics token file (UNIFI_MCP_METRICS_TOKEN_FILE): ${
        (error as NodeJS.ErrnoException).code ?? 'unreadable'
      }.`,
    );
  }
  const token = text.trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new MetricsTokenError(
      'The metrics token file must hold one token of at least 32 characters from ' +
        'A-Z a-z 0-9 . _ ~ + / - (create one with "unifi-mcp crypto generate-token").',
    );
  }
  return sha256(token);
}

/**
 * Writes a new random scrape token (256 bits, base64url) to `path` with mode 0400. Refuses
 * to overwrite: replacing a token is a deliberate act (remove the old file first).
 */
export async function writeNewMetricsToken(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'wx', 0o400);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new MetricsTokenError(
        `Refusing to overwrite the existing file ${path}.`,
        'METRICS_TOKEN_FILE_EXISTS',
      );
    }
    throw error;
  }
  try {
    await handle.writeFile(`${randomBytes(32).toString('base64url')}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(path).catch(() => undefined);
    throw error;
  }
  await handle.close();
}

export interface MetricsHttpOptions {
  registry: MetricsRegistry;
  /** SHA-256 of the scrape token (`loadMetricsToken`). */
  tokenDigest: Buffer;
  audit: AuditLog;
  logger: Logger;
  now?: () => number;
}

function send(
  res: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

export class MetricsHttpService {
  readonly #options: MetricsHttpOptions;
  readonly #now: () => number;
  readonly #failures: RateLimiter;
  readonly #blockedUntil = new Map<string, number>();

  constructor(options: MetricsHttpOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
    this.#failures = new RateLimiter(this.#now);
  }

  readonly listener = (req: IncomingMessage, res: ServerResponse): void => {
    this.#handle(req, res).catch((error: unknown) => {
      this.#options.logger.error('metrics request failed', { err: error });
      send(res, 500, 'internal error\n');
    });
  };

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://listener.invalid').pathname;
    if (path !== METRICS_PATH) {
      send(res, 404, 'not found\n');
      return;
    }
    if (req.method !== 'GET') {
      send(res, 405, 'method not allowed\n', { allow: 'GET' });
      return;
    }
    const remote = req.socket.remoteAddress ?? 'unknown';
    const blockedUntil = this.#blockedUntil.get(remote) ?? 0;
    if (blockedUntil > this.#now()) {
      send(res, 429, 'too many failed authentications\n', {
        'retry-after': String(Math.ceil((blockedUntil - this.#now()) / 1000)),
      });
      return;
    }
    const presented = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(req.headers.authorization ?? '')?.[1];
    if (presented === undefined || !timingSafeEqual(sha256(presented), this.#options.tokenDigest)) {
      this.#authFailed(remote, presented !== undefined);
      send(res, 401, 'unauthorized\n', {
        'www-authenticate': 'Bearer realm="unifi-local-mcp-metrics"',
      });
      return;
    }
    const body = await this.#options.registry.render((error) => {
      this.#options.logger.warn('a metrics collector failed', { err: error });
    });
    send(res, 200, body, { 'content-type': PROMETHEUS_CONTENT_TYPE });
  }

  #authFailed(remote: string, presented: boolean): void {
    const decision = this.#failures.take([{ key: remote, limit: FAILURE_LIMIT }]);
    if (!decision.ok) {
      this.#blockedUntil.set(remote, this.#now() + decision.retryAfterMs);
      if (this.#blockedUntil.size > 10_000) {
        const now = this.#now();
        for (const [key, until] of this.#blockedUntil)
          if (until <= now) this.#blockedUntil.delete(key);
      }
      this.#options.logger.warn('metrics authentication failures throttled', { remote });
    }
    try {
      this.#options.audit.record({
        eventType: 'metrics.auth',
        action: presented ? 'auth.token_rejected' : 'auth.token_missing',
        outcome: 'denied',
        actor: { type: 'system' },
        details: { remote },
      });
    } catch {
      // The request is refused either way; the audit failure is in the runtime log.
    }
  }
}
