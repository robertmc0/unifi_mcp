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
 *
 * Event subscriptions (ADR 0020 §5):
 * - every client has its own SDK handler, so its `subscriptions/listen` streams receive
 *   only its own notifications (the SDK's event bus is shared by all streams of a handler);
 * - the gate reads each POST body, and for `subscriptions/listen` keeps only the resource
 *   URIs the client may subscribe to, then registers the demand until the stream closes;
 * - open listen streams are closed when their grant goes (`recheckSubscriptions`), after a
 *   maximum lifetime, and when the client stops reading (slow consumer).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RateLimiter, type EventFeedKey } from '@unifi-local-mcp/core';
import type { McpHttpHandler } from '@modelcontextprotocol/server';
import {
  hostHeaderValidation,
  originValidation,
  toNodeHandler,
  type NodeIncomingMessageLike,
} from '@modelcontextprotocol/node';
import type { AuditLog, HealthMonitor, Logger } from '@unifi-local-mcp/telemetry';
import { AuditUnavailableError, createHealthHandler } from '@unifi-local-mcp/telemetry';
import type { ClientStore } from './clients.ts';
import { checkSubscription, type EventServices } from './events.ts';

export const MCP_PATH = '/mcp';
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const FAILURE_LIMIT = { ratePerSecond: 0.2, burst: 10 };

export interface ListenLimits {
  /** Open event subscriptions per client. */
  maxPerClient: number;
  /** A subscription is closed after this long; the client subscribes again (re-authorised). */
  maxLifetimeMs: number;
  /** A subscription whose client has not read for this long is closed. */
  slowConsumerMs: number;
}

export const DEFAULT_LISTEN_LIMITS: ListenLimits = {
  maxPerClient: 8,
  maxLifetimeMs: 60 * 60_000,
  slowConsumerMs: 30_000,
};

export interface McpHttpOptions {
  /** Creates one SDK handler; the service keeps one per client. */
  createHandler: () => McpHttpHandler;
  clients: ClientStore;
  health: HealthMonitor;
  audit: AuditLog;
  logger: Logger;
  allowedHosts: string[];
  allowedOrigins: string[];
  events?: EventServices;
  listen?: Partial<ListenLimits>;
  now?: () => number;
}

interface ClientHandler {
  handler: McpHttpHandler;
  node: ReturnType<typeof toNodeHandler>;
}

interface ListenStream {
  res: ServerResponse;
  clientId: string;
  uris: string[];
  keys: EventFeedKey[];
  openedAt: number;
  slowSince: number | undefined;
  release: () => void;
}

type JsonRpcError = { status: number; body: unknown };

function rpcError(id: unknown, code: number, message: string, status = 200): JsonRpcError {
  return {
    status,
    body: {
      jsonrpc: '2.0',
      id: typeof id === 'string' || typeof id === 'number' ? id : null,
      error: { code, message },
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isListen(message: unknown): message is Record<string, unknown> {
  return isObject(message) && message['method'] === 'subscriptions/listen';
}

/** Reads a request body up to `limit` bytes; undefined when it is larger. */
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
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
  readonly #listenLimits: ListenLimits;
  readonly #handlers = new Map<string, ClientHandler>();
  readonly #listens = new Map<string, Set<ListenStream>>();
  readonly #now: () => number;
  readonly #health: (request: Request) => Promise<Response | undefined>;
  readonly #validateHost: (req: IncomingMessage, res: ServerResponse) => boolean;
  readonly #validateOrigin: (req: IncomingMessage, res: ServerResponse) => boolean;
  readonly #failures = new RateLimiter();
  readonly #blockedUntil = new Map<string, number>();
  /** Open MCP responses per client, with the token each was authenticated with. */
  readonly #open = new Map<string, Map<ServerResponse, string>>();

  constructor(options: McpHttpOptions) {
    this.#options = options;
    this.#listenLimits = { ...DEFAULT_LISTEN_LIMITS, ...options.listen };
    this.#now = options.now ?? (() => Date.now());
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
    const entry = this.#handlers.get(clientId);
    this.#handlers.delete(clientId);
    if (entry !== undefined) {
      entry.handler.close().catch((error: unknown) => {
        this.#options.logger.error('closing a client handler failed', { err: error });
      });
    }
    if (open === undefined) return 0;
    for (const res of open.keys()) res.destroy();
    this.#open.delete(clientId);
    return open.size;
  }

  /**
   * Tells one client's subscriptions that a resource changed. Subscriptions whose client
   * has not been reading for too long are closed instead (slow consumer).
   */
  notifyResourceUpdated(clientId: string, uri: string): void {
    const entry = this.#handlers.get(clientId);
    if (entry === undefined) return;
    const now = this.#now();
    for (const stream of this.#listens.get(clientId) ?? []) {
      if (stream.uris.includes(uri)) this.#checkSlow(stream, now);
    }
    entry.handler.notify.resourceUpdated(uri);
  }

  /**
   * Closes event subscriptions that may no longer stay open: a stream the client may no
   * longer use, a subscription past its lifetime, or a client that stopped reading. The
   * client may subscribe again and is authorised again. Returns how many were closed.
   */
  recheckSubscriptions(): number {
    const events = this.#options.events;
    const now = this.#now();
    let closed = 0;
    for (const streams of this.#listens.values()) {
      for (const stream of [...streams]) {
        const expired = now - stream.openedAt >= this.#listenLimits.maxLifetimeMs;
        const revoked =
          events !== undefined &&
          stream.keys.some(
            (key) => !events.access.stream(stream.clientId, key.consoleId, key.stream).allowed,
          );
        if (expired || revoked) {
          this.#options.logger.info('event subscription closed', {
            clientId: stream.clientId,
            reason: expired ? 'lifetime' : 'no_longer_permitted',
          });
          stream.res.destroy();
          closed++;
        } else if (this.#checkSlow(stream, now)) {
          closed++;
        }
      }
    }
    return closed;
  }

  /** The number of open event subscriptions (operator status and tests). */
  get openSubscriptions(): number {
    let count = 0;
    for (const streams of this.#listens.values()) count += streams.size;
    return count;
  }

  /** True when the stream was closed as a slow consumer. */
  #checkSlow(stream: ListenStream, now: number): boolean {
    if (!stream.res.writableNeedDrain) {
      stream.slowSince = undefined;
      return false;
    }
    stream.slowSince ??= now;
    if (now - stream.slowSince < this.#listenLimits.slowConsumerMs) return false;
    this.#options.logger.warn('event subscription closed: the client is not reading', {
      clientId: stream.clientId,
    });
    stream.res.destroy();
    return true;
  }

  #handlerFor(clientId: string): ClientHandler {
    let entry = this.#handlers.get(clientId);
    if (entry === undefined) {
      const handler = this.#options.createHandler();
      entry = {
        handler,
        node: toNodeHandler(handler, {
          maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
          onerror: (error) => {
            this.#options.logger.error('MCP request handling failed', { err: error });
          },
        }),
      };
      this.#handlers.set(clientId, entry);
    }
    return entry;
  }

  /** Closes every client handler (shutdown). */
  async close(): Promise<void> {
    const handlers = [...this.#handlers.values()];
    this.#handlers.clear();
    await Promise.allSettled(handlers.map((entry) => entry.handler.close()));
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
    let parsedBody: unknown;
    if (req.method === 'POST') {
      const body = await readBody(req, MAX_REQUEST_BODY_BYTES);
      if (body === undefined) {
        sendJson(res, 413, rpcError(null, -32600, 'The request body is too large.').body);
        return;
      }
      try {
        parsedBody = JSON.parse(body.toString('utf8')) as unknown;
      } catch {
        sendJson(res, 400, rpcError(null, -32700, 'Parse error').body);
        return;
      }
      const refusal = this.#prepareListen(identity.clientId, parsedBody, res);
      if (refusal !== undefined) {
        sendJson(res, refusal.status, refusal.body);
        return;
      }
    }
    // Node's IncomingMessage is the shape the adapter expects; only the optional-property
    // typing differs under exactOptionalPropertyTypes.
    await this.#handlerFor(identity.clientId).node(
      req as unknown as NodeIncomingMessageLike,
      res,
      parsedBody,
    );
  }

  /**
   * For `subscriptions/listen`: keeps only the resource URIs the client may subscribe to
   * (in place) and registers the demand until the response closes. Returns a refusal to
   * send instead, or undefined to continue.
   */
  #prepareListen(
    clientId: string,
    message: unknown,
    res: ServerResponse,
  ): JsonRpcError | undefined {
    if (Array.isArray(message)) {
      return message.some(isListen)
        ? rpcError(null, -32600, 'subscriptions/listen cannot be sent in a batch.', 400)
        : undefined;
    }
    if (!isListen(message)) return undefined;
    const notifications = isObject(message['params'])
      ? message['params']['notifications']
      : undefined;
    if (!isObject(notifications)) return undefined; // the SDK answers the invalid request
    const requested = notifications['resourceSubscriptions'];
    if (requested === undefined) return undefined;
    if (!Array.isArray(requested)) return undefined; // invalid: answered by the SDK
    const events = this.#options.events;
    const check =
      events === undefined
        ? { accepted: [], keys: [], refused: requested.length }
        : checkSubscription(events, clientId, requested);
    if (check.accepted.length === 0) {
      delete notifications['resourceSubscriptions'];
    } else {
      notifications['resourceSubscriptions'] = check.accepted;
    }
    try {
      this.#options.audit.record({
        eventType: 'mcp.resource',
        action: 'events.subscribe',
        outcome: check.accepted.length > 0 ? 'success' : 'denied',
        actor: { type: 'mcp_client', id: clientId },
        details: { accepted: check.accepted.length, refused: check.refused },
      });
    } catch (error) {
      if (error instanceof AuditUnavailableError) {
        return rpcError(message['id'], -32603, 'The audit trail cannot be written.');
      }
      throw error;
    }
    if (events === undefined || check.keys.length === 0) return undefined;
    const streams = this.#listens.get(clientId) ?? new Set<ListenStream>();
    if (streams.size >= this.#listenLimits.maxPerClient) {
      return rpcError(message['id'], -32603, 'Subscription limit reached');
    }
    let release: () => void;
    try {
      release = events.hub.subscribe(clientId, check.keys);
    } catch (error) {
      this.#options.logger.warn('event subscription refused', { clientId, err: error });
      return rpcError(message['id'], -32603, 'Subscription limit reached');
    }
    const stream: ListenStream = {
      res,
      clientId,
      uris: check.accepted,
      keys: check.keys,
      openedAt: this.#now(),
      slowSince: undefined,
      release,
    };
    streams.add(stream);
    this.#listens.set(clientId, streams);
    res.on('close', () => {
      stream.release();
      streams.delete(stream);
      if (streams.size === 0 && this.#listens.get(clientId) === streams) {
        this.#listens.delete(clientId);
      }
    });
    return undefined;
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
