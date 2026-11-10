/**
 * The stdio ↔ Streamable HTTP message relay (ADR 0003 option 1, decided in ADR 0014).
 *
 * The relay contains no tool logic. It passes JSON-RPC messages unchanged in both
 * directions, so the bridge supports whichever protocol era the harness speaks and can
 * never drift from the service's policy view. It does only two things beyond copying:
 *
 * - For 2025-era sessions it tells the HTTP transport the negotiated protocol version, by
 *   watching the response to `initialize` (2026-era requests carry it in their envelope).
 * - When a request cannot be delivered upstream, it answers the harness with a JSON-RPC
 *   error instead of leaving it waiting; an authentication failure is fatal.
 */
import type { JSONRPCMessage } from '@modelcontextprotocol/client';
import type { Logger } from '@unifi-local-mcp/telemetry/logger';

/** The transport surface the relay uses (StdioServerTransport, StreamableHTTPClientTransport). */
export interface RelayTransport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  start(): Promise<void>;
  send(message: JSONRPCMessage): Promise<void>;
  close(): Promise<void>;
}

export interface UpstreamTransport extends RelayTransport {
  setProtocolVersion(version: string): void;
}

export interface RelayOptions {
  downstream: RelayTransport;
  upstream: UpstreamTransport;
  logger: Logger;
  /** Called once when the service rejects the token; the bridge then exits non-zero. */
  onFatal: (reason: 'authentication_failed') => void;
  onClosed: () => void;
}

/** JSON-RPC error codes the bridge uses (server-defined range). */
export const BRIDGE_ERROR = { unreachable: -32001, unauthorized: -32002 } as const;

type Id = string | number;

function requestId(message: JSONRPCMessage): Id | undefined {
  const candidate = message as { id?: unknown; method?: unknown };
  return typeof candidate.method === 'string' &&
    (typeof candidate.id === 'string' || typeof candidate.id === 'number')
    ? candidate.id
    : undefined;
}

function httpStatus(error: unknown): number | undefined {
  for (let current: unknown = error, depth = 0; current !== undefined && depth < 5; depth++) {
    const record = current as { status?: unknown; code?: unknown; name?: unknown; cause?: unknown };
    if (typeof record.status === 'number') return record.status;
    if (typeof record.code === 'number' && record.code >= 400 && record.code < 600)
      return record.code;
    if (record.name === 'UnauthorizedError') return 401;
    current = record.cause;
  }
  return undefined;
}

export class Relay {
  readonly #options: RelayOptions;
  readonly #initializing = new Set<Id>();
  #fatal = false;
  #closed = false;

  constructor(options: RelayOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    const { downstream, upstream, logger } = this.#options;
    downstream.onmessage = (message) => {
      this.#toUpstream(message);
    };
    upstream.onmessage = (message) => {
      this.#toDownstream(message);
    };
    upstream.onerror = (error) => {
      logger.warn('service connection error', { err: error });
    };
    downstream.onerror = (error) => {
      logger.warn('stdio error', { err: error });
    };
    downstream.onclose = () => {
      void this.close();
    };
    await upstream.start();
    await downstream.start();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled([this.#options.upstream.close(), this.#options.downstream.close()]);
    this.#options.onClosed();
  }

  #toUpstream(message: JSONRPCMessage): void {
    if (this.#fatal) return;
    const id = requestId(message);
    if (id !== undefined && (message as { method?: unknown }).method === 'initialize') {
      this.#initializing.add(id);
    }
    this.#options.upstream.send(message).catch((error: unknown) => {
      this.#upstreamFailed(id, error);
    });
  }

  #toDownstream(message: JSONRPCMessage): void {
    const response = message as { id?: unknown; result?: { protocolVersion?: unknown } };
    if (
      (typeof response.id === 'string' || typeof response.id === 'number') &&
      this.#initializing.delete(response.id)
    ) {
      const version = response.result?.protocolVersion;
      if (typeof version === 'string') this.#options.upstream.setProtocolVersion(version);
    }
    this.#options.downstream.send(message).catch((error: unknown) => {
      this.#options.logger.error('could not write to stdout', { err: error });
    });
  }

  #upstreamFailed(id: Id | undefined, error: unknown): void {
    const status = httpStatus(error);
    const unauthorized = status === 401 || status === 403;
    this.#options.logger.error(
      unauthorized ? 'the service rejected the client token' : 'the service could not be reached',
      { status, err: error },
    );
    const answer =
      id === undefined
        ? Promise.resolve()
        : this.#options.downstream.send({
            jsonrpc: '2.0',
            id,
            error: unauthorized
              ? {
                  code: BRIDGE_ERROR.unauthorized,
                  message: 'The unifi-local-mcp service rejected the client token.',
                }
              : {
                  code: BRIDGE_ERROR.unreachable,
                  message: 'The unifi-local-mcp service could not be reached.',
                },
          });
    if (unauthorized && !this.#fatal) {
      this.#fatal = true;
      void answer.finally(() => {
        this.#options.onFatal('authentication_failed');
      });
    }
  }
}
