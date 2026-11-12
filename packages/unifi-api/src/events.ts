/**
 * Opens documented event subscriptions on a console (spec §11; ADR 0020 §2): the same
 * console registry, egress check and verified TLS as every request, then a bounded
 * WebSocket that only reads.
 *
 * The path is the module's local base path plus the stream's reviewed, fixed path. The
 * only request header besides the WebSocket ones is the module's authentication header
 * with the stored credential, which is sent only after TLS verification succeeded.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { EventConnection, EventConnector, EventTarget } from '@unifi-local-mcp/core';
import type { Logger } from '@unifi-local-mcp/telemetry';
import type { ConsoleRegistry } from './consoles.ts';
import { EgressError, type EgressGuard } from './egress.ts';
import { connectTls, TransportError } from './transport.ts';
import { openWebSocket, WebSocketError } from './websocket.ts';

export interface UnifiEventConnectorOptions {
  consoles: ConsoleRegistry;
  egress: EgressGuard;
  logger: Logger;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
}

/** A connection error with a code the event hub understands; never upstream text. */
export class EventConnectError extends Error {
  override readonly name = 'EventConnectError';
  readonly code: string;
  readonly status: number | undefined;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export class UnifiEventConnector implements EventConnector {
  readonly #options: UnifiEventConnectorOptions;
  /** Fingerprints are keyed MACs: equal settings give equal values in this process only. */
  readonly #fingerprintKey = randomBytes(32);
  readonly #insecureWarned = new Set<string>();

  constructor(options: UnifiEventConnectorOptions) {
    this.#options = options;
  }

  fingerprint(consoleId: string, moduleId: string): string | undefined {
    let connection;
    try {
      connection = this.#options.consoles.connection(consoleId, moduleId);
    } catch {
      return undefined;
    }
    if (connection?.credential === undefined) return undefined;
    return createHmac('sha256', this.#fingerprintKey)
      .update(
        JSON.stringify([
          connection.host,
          connection.port,
          connection.trust,
          connection.credential.reveal(),
        ]),
      )
      .digest('base64url');
  }

  async connect(target: EventTarget, signal: AbortSignal): Promise<EventConnection> {
    const { consoleId, stream } = target;
    let connection;
    try {
      connection = this.#options.consoles.connection(consoleId, stream.moduleId);
    } catch {
      throw new EventConnectError(
        'credentials_unreadable',
        'The stored console credential cannot be read.',
      );
    }
    if (connection?.credential === undefined) {
      throw new EventConnectError(
        'console_not_configured',
        'The console or module is not configured, or has no credential.',
      );
    }
    if (connection.trust.mode === 'insecure' && !this.#insecureWarned.has(consoleId)) {
      this.#insecureWarned.add(consoleId);
      this.#options.logger.warn(
        'TLS verification is DISABLED for this console (explicit insecure override)',
        { consoleId },
      );
    }
    const credential = connection.credential.reveal();
    const { auth } = connection.endpoint;
    try {
      const resolved = await this.#options.egress.resolve(connection.host);
      const socket = await connectTls({
        address: resolved.address,
        port: connection.port,
        host: connection.host,
        trust: connection.trust,
        timeoutMs: this.#options.connectTimeoutMs ?? 5_000,
        signal,
      });
      const ws = await openWebSocket({
        socket,
        path: connection.endpoint.basePath + stream.pathTemplate,
        hostHeader:
          connection.port === 443
            ? connection.host
            : `${connection.host}:${String(connection.port)}`,
        headers: {
          [auth.header.toLowerCase()]:
            auth.scheme === 'bearer' ? `Bearer ${credential}` : credential,
        },
        maxMessageBytes: stream.maxMessageBytes,
        handshakeTimeoutMs: this.#options.handshakeTimeoutMs ?? 10_000,
        pingIntervalMs: this.#options.pingIntervalMs ?? 30_000,
        pongTimeoutMs: this.#options.pongTimeoutMs ?? 10_000,
        signal,
      });
      this.#options.logger.info('event subscription open', {
        consoleId,
        stream: stream.operationId,
      });
      return ws;
    } catch (error) {
      if (error instanceof EgressError || error instanceof TransportError) {
        throw new EventConnectError(error.code, error.message);
      }
      if (error instanceof WebSocketError) {
        throw new EventConnectError(error.code, error.message, error.status);
      }
      throw new EventConnectError('connect_failed', 'The console could not be reached.');
    }
  }
}
