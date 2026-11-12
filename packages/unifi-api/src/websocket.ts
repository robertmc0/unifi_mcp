/**
 * A minimal WebSocket client (RFC 6455) for documented UniFi subscriptions (spec §11;
 * ADR 0020). It runs over a TLS socket that `connectTls` has already verified, so the
 * console's identity is established before the upgrade request carries the API key.
 *
 * - **Handshake.** One `GET` upgrade with fixed headers: the module's authentication header,
 *   a random `Sec-WebSocket-Key` and version 13. No subprotocol or extension is offered,
 *   and a response that selects one is refused. `Sec-WebSocket-Accept` must match. A
 *   refused upgrade keeps only its HTTP status.
 * - **Read-only.** The client never sends a data frame: only pong, ping and close.
 * - **Bounded.** A message larger than `maxMessageBytes` closes the connection (1009) before
 *   it is buffered; fragments count towards the same bound. Text must be valid UTF-8.
 * - **Liveness.** A ping every `pingIntervalMs`; without any frame within `pongTimeoutMs`
 *   the connection is closed as idle.
 * - Frames from the console must not be masked and must not use reserved bits.
 */
import { createHash, randomBytes } from 'node:crypto';
import { request } from 'node:https';
import type { TLSSocket } from 'node:tls';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_CONTROL_PAYLOAD = 125;
const CLOSE_GRACE_MS = 2_000;

export type WebSocketErrorCode =
  | 'upgrade_unauthorized'
  | 'upgrade_refused'
  | 'handshake_invalid'
  | 'handshake_timeout'
  | 'connection_lost'
  | 'aborted';

/** The upgrade did not complete. Only the HTTP status is kept, never the response body. */
export class WebSocketError extends Error {
  override readonly name = 'WebSocketError';
  readonly code: WebSocketErrorCode;
  readonly status: number | undefined;

  constructor(code: WebSocketErrorCode, message: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.status = status;
  }
}

export type WebSocketCloseCode =
  /** Closed by this side (`close()`). */
  | 'closed'
  /** The console sent a close frame. */
  | 'closed_by_console'
  | 'connection_lost'
  | 'idle_timeout'
  | 'protocol_error'
  | 'message_too_large';

export interface WebSocketClose {
  code: WebSocketCloseCode;
  /** The close code the console sent, if any. */
  closeCode?: number;
}

export interface WebSocketOptions {
  /** A verified TLS socket (`connectTls`). It is owned by the WebSocket from now on. */
  socket: TLSSocket;
  path: string;
  /** Value of the Host header (configured console host, with port when not 443). */
  hostHeader: string;
  /** Extra request headers: only the module's authentication header. */
  headers: Readonly<Record<string, string>>;
  maxMessageBytes: number;
  handshakeTimeoutMs: number;
  pingIntervalMs: number;
  pongTimeoutMs: number;
  signal: AbortSignal;
}

function headerValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value.join(',') : (value ?? '')).trim();
}

/** Performs the upgrade and resolves with the open connection. */
export function openWebSocket(options: WebSocketOptions): Promise<WebSocketConnection> {
  return new Promise((resolve, reject) => {
    const { socket } = options;
    const key = randomBytes(16).toString('base64');
    const expectedAccept = createHash('sha1').update(`${key}${GUID}`).digest('base64');
    let settled = false;
    const fail = (error: WebSocketError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      req.destroy();
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new WebSocketError('handshake_timeout', 'The console did not answer the upgrade.'));
    }, options.handshakeTimeoutMs);
    const onAbort = (): void => {
      fail(new WebSocketError('aborted', 'The subscription was cancelled.'));
    };
    options.signal.addEventListener('abort', onAbort, { once: true });

    const req = request({
      method: 'GET',
      path: options.path,
      headers: {
        ...options.headers,
        host: options.hostHeader,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': key,
        'sec-websocket-version': '13',
      },
      setHost: false,
      // Only the verified socket (see sendHttp).
      createConnection: () => socket,
    });
    req.on('response', (res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      fail(
        status === 401 || status === 403
          ? new WebSocketError(
              'upgrade_unauthorized',
              'The console refused the credential.',
              status,
            )
          : new WebSocketError('upgrade_refused', 'The console refused the upgrade.', status),
      );
    });
    req.on('upgrade', (res, upgraded, head) => {
      const connectionTokens = headerValue(res.headers.connection)
        .toLowerCase()
        .split(',')
        .map((token) => token.trim());
      const valid =
        res.statusCode === 101 &&
        headerValue(res.headers.upgrade).toLowerCase() === 'websocket' &&
        connectionTokens.includes('upgrade') &&
        headerValue(res.headers['sec-websocket-accept']) === expectedAccept &&
        res.headers['sec-websocket-extensions'] === undefined &&
        res.headers['sec-websocket-protocol'] === undefined;
      if (!valid) {
        upgraded.destroy();
        fail(
          new WebSocketError('handshake_invalid', 'The console answered with an invalid upgrade.'),
        );
        return;
      }
      if (settled) {
        upgraded.destroy();
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      resolve(new WebSocketConnection(upgraded as TLSSocket, head, options));
    });
    req.on('error', (error) => {
      fail(
        new WebSocketError(
          'connection_lost',
          'The connection to the console was lost.',
          undefined,
          {
            cause: error,
          },
        ),
      );
    });
    req.end();
  });
}

const Opcode = {
  Continuation: 0x0,
  Text: 0x1,
  Binary: 0x2,
  Close: 0x8,
  Ping: 0x9,
  Pong: 0xa,
} as const;
type Opcode = (typeof Opcode)[keyof typeof Opcode];

/** An open subscription. Messages arrive through `onMessage`; `closed` settles once. */
export class WebSocketConnection {
  /** Settles when the connection has ended, for whatever reason. Never rejects. */
  readonly closed: Promise<WebSocketClose>;
  #listener: ((text: string) => void) | undefined;
  readonly #socket: TLSSocket;
  readonly #options: WebSocketOptions;
  readonly #decoder = new TextDecoder('utf-8', { fatal: true });
  #buffer: Buffer = Buffer.alloc(0);
  #fragments: Buffer[] = [];
  #fragmentBytes = 0;
  #fragmenting = false;
  #closeSent = false;
  #closeRequested = false;
  #finished = false;
  #resolveClosed!: (close: WebSocketClose) => void;
  #pingTimer: NodeJS.Timeout | undefined;
  #pongDeadline: NodeJS.Timeout | undefined;
  #graceTimer: NodeJS.Timeout | undefined;

  constructor(socket: TLSSocket, head: Buffer, options: WebSocketOptions) {
    this.#socket = socket;
    this.#options = options;
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    socket.on('data', (chunk: Buffer) => {
      this.#receive(chunk);
    });
    socket.on('error', () => {
      this.#finish({ code: 'connection_lost' });
    });
    socket.on('close', () => {
      this.#finish({ code: 'connection_lost' });
    });
    options.signal.addEventListener('abort', this.#onAbort, { once: true });
    this.#pingTimer = setInterval(() => {
      this.#ping();
    }, options.pingIntervalMs);
    this.#pingTimer.unref();
    if (head.length > 0) this.#receive(head);
  }

  /** Receives each complete text message. Messages before a listener is set are dropped. */
  onMessage(listener: (text: string) => void): void {
    this.#listener = listener;
  }

  /** Starts the closing handshake; the socket is destroyed if the console does not answer. */
  close(): void {
    if (this.#finished) return;
    this.#closeRequested = true;
    this.#sendClose(1000);
    this.#graceTimer ??= setTimeout(() => {
      this.#finish({ code: 'closed' });
    }, CLOSE_GRACE_MS);
    this.#graceTimer.unref();
  }

  readonly #onAbort = (): void => {
    this.close();
  };

  #ping(): void {
    if (this.#finished || this.#pongDeadline !== undefined) return;
    this.#send(Opcode.Ping, randomBytes(4));
    this.#pongDeadline = setTimeout(() => {
      this.#fail('idle_timeout', 1001);
    }, this.#options.pongTimeoutMs);
    this.#pongDeadline.unref();
  }

  #receive(chunk: Buffer): void {
    if (this.#finished) return;
    // Any frame from the console shows the connection is alive.
    if (this.#pongDeadline !== undefined) {
      clearTimeout(this.#pongDeadline);
      this.#pongDeadline = undefined;
    }
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    // One complete frame per iteration; a frame may end the connection.
    while (this.#frame() && this.#isOpen()) {
      // continue with the next frame
    }
  }

  /** Handles one complete frame from the buffer; false when more bytes are needed. */
  #isOpen(): boolean {
    return !this.#finished;
  }

  #frame(): boolean {
    const buffer = this.#buffer;
    if (buffer.length < 2) return false;
    const first = buffer[0] ?? 0;
    const second = buffer[1] ?? 0;
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    if ((first & 0x70) !== 0 || (second & 0x80) !== 0) {
      // Reserved bits (no extension was agreed) or a masked frame from the server.
      this.#fail('protocol_error', 1002);
      return false;
    }
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return false;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return false;
      if (buffer.readUInt32BE(2) !== 0) {
        this.#fail('message_too_large', 1009);
        return false;
      }
      length = buffer.readUInt32BE(6);
      offset = 10;
    }
    const control = opcode >= 0x8;
    if (control && (!fin || length > MAX_CONTROL_PAYLOAD)) {
      this.#fail('protocol_error', 1002);
      return false;
    }
    if (!control && this.#fragmentBytes + length > this.#options.maxMessageBytes) {
      this.#fail('message_too_large', 1009);
      return false;
    }
    if (buffer.length < offset + length) return false;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    this.#buffer = buffer.subarray(offset + length);

    switch (opcode) {
      case Opcode.Text:
      case Opcode.Binary:
        if (this.#fragmenting) {
          this.#fail('protocol_error', 1002);
          return false;
        }
        if (fin) {
          this.#deliver([payload]);
        } else {
          this.#fragmenting = true;
          this.#fragments = [payload];
          this.#fragmentBytes = payload.length;
        }
        return true;
      case Opcode.Continuation:
        if (!this.#fragmenting) {
          this.#fail('protocol_error', 1002);
          return false;
        }
        this.#fragments.push(payload);
        this.#fragmentBytes += payload.length;
        if (fin) {
          const parts = this.#fragments;
          this.#fragmenting = false;
          this.#fragments = [];
          this.#fragmentBytes = 0;
          this.#deliver(parts);
        }
        return true;
      case Opcode.Ping:
        this.#send(Opcode.Pong, payload);
        return true;
      case Opcode.Pong:
        return true;
      case Opcode.Close: {
        const closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : undefined;
        this.#sendClose(1000);
        this.#finish({
          code: 'closed_by_console',
          ...(closeCode === undefined ? {} : { closeCode }),
        });
        return false;
      }
      default:
        this.#fail('protocol_error', 1002);
        return false;
    }
  }

  #deliver(parts: Buffer[]): void {
    let text: string;
    try {
      text = this.#decoder.decode(parts.length === 1 ? parts[0] : Buffer.concat(parts));
    } catch {
      this.#fail('protocol_error', 1007);
      return;
    }
    this.#listener?.(text);
  }

  #send(opcode: Opcode, payload: Buffer): void {
    if (this.#finished || this.#socket.destroyed) return;
    // Only control frames are ever sent; their payload is at most 125 bytes.
    const mask = randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) {
      masked[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
    }
    this.#socket.write(
      Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, masked]),
    );
  }

  #sendClose(code: number): void {
    if (this.#closeSent) return;
    this.#closeSent = true;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this.#send(Opcode.Close, payload);
  }

  #fail(code: WebSocketCloseCode, closeCode: number): void {
    this.#sendClose(closeCode);
    this.#finish({ code });
  }

  #finish(close: WebSocketClose): void {
    if (this.#finished) return;
    this.#finished = true;
    // Whatever ends a connection this side asked to close, it ended as asked.
    if (this.#closeRequested) close = { code: 'closed' };
    clearInterval(this.#pingTimer);
    clearTimeout(this.#pongDeadline);
    clearTimeout(this.#graceTimer);
    this.#options.signal.removeEventListener('abort', this.#onAbort);
    this.#buffer = Buffer.alloc(0);
    this.#fragments = [];
    // Let a close frame that was just written reach the console before the socket goes.
    this.#socket.end();
    setTimeout(() => this.#socket.destroy(), 100).unref();
    this.#resolveClosed(close);
  }
}
