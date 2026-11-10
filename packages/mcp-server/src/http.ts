/**
 * The MCP HTTP listener's request handling (spec §7.1, §7.3, §12; ADR 0003, ADR 0013).
 *
 *   /livez, /readyz   unauthenticated, minimal bodies (ADR 0008)
 *   /mcp              Host allowlist → Origin allowlist → failed-auth throttle per remote
 *                     address → bearer token verification → SDK handler with authInfo
 *   anything else     404
 *
 * The SDK handler never sees an unauthenticated request. The identity it receives
 * (`authInfo.clientId`) comes only from the verified token. The raw token is not passed
 * on: `authInfo.token` carries the public token id. Open responses are tracked per client
 * so revocation can close them immediately (spec §7.1).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RateLimiter } from '@unifi-local-mcp/core';
import {
  hostHeaderValidation,
  originValidation,
  toNodeHandler,
  type FetchLikeMcpHandler,
  type NodeIncomingMessageLike,
} from '@modelcontextprotocol/node';
import type { AuditLog, HealthMonitor, Logger } from '@unifi-local-mcp/telemetry';
import { createHealthHandler } from '@unifi-local-mcp/telemetry';
import type { ClientStore } from './clients.ts';

export const MCP_PATH = '/mcp';
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const FAILURE_LIMIT = { ratePerSecond: 0.2, burst: 10 };

export interface McpHttpOptions {
  handler: FetchLikeMcpHandler;
  clients: ClientStore;
  health: HealthMonitor;
  audit: AuditLog;
  logger: Logger;
  allowedHosts: string[];
  allowedOrigins: string[];
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function bearer(header: string | undefined): string | undefined {
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header ?? '');
  return match?.[1];
}

export class McpHttpService {
  readonly #options: McpHttpOptions;
  readonly #mcp: ReturnType<typeof toNodeHandler>;
  readonly #health: (request: Request) => Promise<Response | undefined>;
  readonly #validateHost: (req: IncomingMessage, res: ServerResponse) => boolean;
  readonly #validateOrigin: (req: IncomingMessage, res: ServerResponse) => boolean;
  readonly #failures = new RateLimiter();
  readonly #blockedUntil = new Map<string, number>();
  /** Open MCP responses per client, with the token each was authenticated with. */
  readonly #open = new Map<string, Map<ServerResponse, string>>();

  constructor(options: McpHttpOptions) {
    this.#options = options;
    this.#mcp = toNodeHandler(options.handler, {
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      onerror: (error) => {
        options.logger.error('MCP request handling failed', { err: error });
      },
    });
    this.#health = createHealthHandler(options.health);
    this.#validateHost = hostHeaderValidation(options.allowedHosts);
    this.#validateOrigin = originValidation(options.allowedOrigins);
  }

  /** The `node:http` / `node:https` request listener. */
  readonly listener = (req: IncomingMessage, res: ServerResponse): void => {
    this.#handle(req, res).catch((error: unknown) => {
      this.#options.logger.error('HTTP request failed', { err: error });
      sendJson(res, 500, { error: 'internal_error' });
    });
  };

  /** Closes every open MCP response of a client (revocation). Returns how many. */
  closeClientResponses(clientId: string): number {
    const open = this.#open.get(clientId);
    if (open === undefined) return 0;
    for (const res of open.keys()) res.destroy();
    this.#open.delete(clientId);
    return open.size;
  }

  /**
   * Closes every open response whose token is no longer valid: revoked, expired, or its
   * client revoked, disabled or expired. This also catches changes made by another process,
   * such as the CLI, which in-process revocation listeners never see. If the check itself
   * fails, the response is closed (fail closed). Returns the ids of affected clients.
   */
  revalidateOpenResponses(): string[] {
    const affected: string[] = [];
    for (const [clientId, open] of this.#open) {
      let closed = false;
      for (const [res, tokenId] of open) {
        let active = false;
        try {
          active = this.#options.clients.isTokenActive(tokenId);
        } catch (error) {
          this.#options.logger.error('could not re-check an open MCP response', { err: error });
        }
        if (!active) {
          res.destroy();
          open.delete(res);
          closed = true;
        }
      }
      if (open.size === 0) this.#open.delete(clientId);
      if (closed) affected.push(clientId);
    }
    return affected;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://listener.invalid').pathname;
    const health = await this.#health(
      new Request(`http://listener.invalid${path}`, { method: req.method ?? 'GET' }),
    );
    if (health !== undefined) {
      res.writeHead(health.status, Object.fromEntries(health.headers));
      res.end(Buffer.from(await health.arrayBuffer()));
      return;
    }
    if (path !== MCP_PATH) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    // DNS rebinding and cross-origin protection: these answer 403 themselves.
    if (!this.#validateHost(req, res) || !this.#validateOrigin(req, res)) return;

    const remote = req.socket.remoteAddress ?? 'unknown';
    const blockedUntil = this.#blockedUntil.get(remote) ?? 0;
    if (blockedUntil > Date.now()) {
      sendJson(
        res,
        429,
        { error: 'too_many_failed_authentications' },
        {
          'retry-after': String(Math.ceil((blockedUntil - Date.now()) / 1000)),
        },
      );
      return;
    }
    const token = bearer(req.headers.authorization);
    const identity = token === undefined ? undefined : this.#options.clients.authenticate(token);
    if (identity === undefined) {
      this.#authFailed(remote, token !== undefined);
      sendJson(
        res,
        401,
        { error: 'invalid_token' },
        { 'www-authenticate': 'Bearer realm="unifi-local-mcp"' },
      );
      return;
    }

    let open = this.#open.get(identity.clientId);
    if (open === undefined) {
      open = new Map();
      this.#open.set(identity.clientId, open);
    }
    open.set(res, identity.tokenId);
    res.on('close', () => {
      const set = this.#open.get(identity.clientId);
      set?.delete(res);
      if (set?.size === 0) this.#open.delete(identity.clientId);
    });
    // Results are per client: never cacheable by shared caches (spec §5.3). The SDK may
    // set its own value for streams (no-cache), which is equally safe.
    res.setHeader('cache-control', 'no-store');
    (req as IncomingMessage & { auth?: unknown }).auth = {
      token: identity.tokenId,
      clientId: identity.clientId,
      scopes: [],
      extra: { tokenId: identity.tokenId },
    };
    // Node's IncomingMessage is the shape the adapter expects; only the optional-property
    // typing differs under exactOptionalPropertyTypes.
    await this.#mcp(req as unknown as NodeIncomingMessageLike, res);
  }

  #authFailed(remote: string, presented: boolean): void {
    const decision = this.#failures.take([{ key: remote, limit: FAILURE_LIMIT }]);
    if (!decision.ok) {
      this.#blockedUntil.set(remote, Date.now() + decision.retryAfterMs);
      if (this.#blockedUntil.size > 10_000) {
        const now = Date.now();
        for (const [key, until] of this.#blockedUntil)
          if (until <= now) this.#blockedUntil.delete(key);
      }
      this.#options.logger.warn('authentication failures throttled', { remote });
    }
    try {
      this.#options.audit.record({
        eventType: 'mcp.auth',
        action: presented ? 'auth.token_rejected' : 'auth.token_missing',
        outcome: 'denied',
        actor: { type: 'mcp_client' },
        details: { remote },
      });
    } catch {
      // The request is refused either way; the audit failure is in the runtime log.
    }
  }
}
