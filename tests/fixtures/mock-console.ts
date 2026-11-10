/**
 * A synthetic UniFi console for tests: an HTTPS server on 127.0.0.1 that records every TLS
 * handshake and every HTTP request (method, path, headers, body), and answers with a
 * per-test responder. It implements no real UniFi behaviour.
 */
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export type Responder = (request: RecordedRequest, response: ServerResponse) => void;

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

export class MockConsole {
  readonly requests: RecordedRequest[] = [];
  tlsHandshakes = 0;
  respond: Responder = (_request, response) => {
    sendJson(response, 200, {});
  };
  readonly #server: Server;
  readonly #open = new Set<{ destroy: () => void }>();

  private constructor(server: Server) {
    this.#server = server;
  }

  static async start(tls: { key: string; cert: string }): Promise<MockConsole> {
    const server = createServer({ key: tls.key, cert: tls.cert });
    const mock = new MockConsole(server);
    server.on('secureConnection', (socket) => {
      mock.tlsHandshakes++;
      mock.#open.add(socket);
      socket.on('close', () => mock.#open.delete(socket));
      socket.on('error', () => undefined);
    });
    server.on('tlsClientError', () => undefined);
    server.on('request', (request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const recorded = {
          method: request.method ?? '',
          url: request.url ?? '',
          headers: request.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        mock.requests.push(recorded);
        mock.respond(recorded, response);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return mock;
  }

  get port(): number {
    return (this.#server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const socket of this.#open) socket.destroy();
    await new Promise<void>((resolve) =>
      this.#server.close(() => {
        resolve();
      }),
    );
  }
}
