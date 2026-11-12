/**
 * The server side of a WebSocket (RFC 6455) for the synthetic console's upgrade hook. Tests
 * script what the "console" sends and inspect what the client sent. Frames from the client
 * must be masked; the fixture records them unmasked.
 */
import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import type { RecordedRequest } from './mock-console.ts';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface ClientFrame {
  fin: boolean;
  opcode: number;
  masked: boolean;
  payload: Buffer;
}

export interface FrameOptions {
  fin?: boolean;
  /** Reserved bits (0–7), shifted into place. */
  rsv?: number;
  /** Servers must not mask; set to test that the client refuses it. */
  masked?: boolean;
}

/** Encodes one frame as a server would send it. */
export function frame(
  opcode: number,
  payload: Buffer | string,
  options: FrameOptions = {},
): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const first = ((options.fin ?? true) ? 0x80 : 0) | ((options.rsv ?? 0) << 4) | opcode;
  const maskBit = options.masked === true ? 0x80 : 0;
  let header: Buffer;
  if (data.length < 126) {
    header = Buffer.from([first, maskBit | data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = maskBit | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = maskBit | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(data.length, 6);
  }
  if (options.masked !== true) return Buffer.concat([header, data]);
  const mask = Buffer.from([1, 2, 3, 4]);
  return Buffer.concat([header, mask, Buffer.from(data.map((b, i) => b ^ (mask[i % 4] ?? 0)))]);
}

export interface AcceptOptions {
  /** Answer with this Sec-WebSocket-Accept instead of the correct one. */
  accept?: string;
  /** Extra response header lines, e.g. `Sec-WebSocket-Extensions: permessage-deflate`. */
  extraHeaders?: string[];
  /** Answer pings with pongs (default true). */
  autoPong?: boolean;
  /** Answer a close frame with a close frame (default true). */
  answerClose?: boolean;
}

/** A server-side connection: accepted with a valid 101 unless the options say otherwise. */
export class ServerWebSocket {
  readonly received: ClientFrame[] = [];
  readonly socket: Socket;
  #buffer: Buffer = Buffer.alloc(0);
  readonly #autoPong: boolean;
  readonly #answerClose: boolean;
  #closed = false;
  readonly closed: Promise<void>;

  constructor(request: RecordedRequest, socket: Socket, options: AcceptOptions = {}) {
    this.socket = socket;
    this.#autoPong = options.autoPong ?? true;
    this.#answerClose = options.answerClose ?? true;
    this.closed = new Promise((resolve) => {
      socket.on('close', () => {
        this.#closed = true;
        resolve();
      });
    });
    const key = request.headers['sec-websocket-key'] ?? '';
    const accept = options.accept ?? createHash('sha1').update(`${key}${GUID}`).digest('base64');
    socket.on('data', (chunk: Buffer) => {
      this.#receive(chunk);
    });
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        ...(options.extraHeaders ?? []),
        '',
        '',
      ].join('\r\n'),
    );
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  sendText(text: string): void {
    this.socket.write(frame(0x1, text));
  }

  sendJson(value: unknown): void {
    this.sendText(JSON.stringify(value));
  }

  sendFrame(opcode: number, payload: Buffer | string, options?: FrameOptions): void {
    this.socket.write(frame(opcode, payload, options));
  }

  sendRaw(bytes: Buffer): void {
    this.socket.write(bytes);
  }

  /** Sends a close frame with a code and ends the socket. */
  close(code = 1000): void {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this.socket.end(frame(0x8, payload));
  }

  /** Drops the TCP connection without a close frame. */
  drop(): void {
    this.socket.destroy();
  }

  #receive(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const buffer = this.#buffer;
      if (buffer.length < 2) return;
      const first = buffer[0] ?? 0;
      const second = buffer[1] ?? 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = buffer.readUInt32BE(6);
        offset = 10;
      }
      const masked = (second & 0x80) !== 0;
      const maskLength = masked ? 4 : 0;
      if (buffer.length < offset + maskLength + length) return;
      const mask = buffer.subarray(offset, offset + maskLength);
      const raw = buffer.subarray(offset + maskLength, offset + maskLength + length);
      const payload = Buffer.from(raw.map((b, i) => (masked ? b ^ (mask[i % 4] ?? 0) : b)));
      this.#buffer = buffer.subarray(offset + maskLength + length);
      const received: ClientFrame = {
        fin: (first & 0x80) !== 0,
        opcode: first & 0x0f,
        masked,
        payload,
      };
      this.received.push(received);
      if (received.opcode === 0x9 && this.#autoPong && !this.#closed) {
        this.socket.write(frame(0xa, payload));
      }
      if (received.opcode === 0x8 && !this.#closed && this.#answerClose) {
        // Answer the closing handshake, as a console does.
        this.socket.end(frame(0x8, payload.subarray(0, 2)));
      }
    }
  }
}
