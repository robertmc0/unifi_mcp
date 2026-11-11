/**
 * TLS connection and one HTTP request over it (spec §4.4, §2 decision 22; ADR 0012).
 *
 * The TLS socket is established and verified **before** any HTTP bytes are written, so a
 * failed verification can never leak the API key:
 *
 * - `verify` (default): CA validation (system CAs, or only the configured CA) and host
 *   identity against the configured console host (name or IP).
 * - `pinned`: the leaf certificate's SPKI SHA-256 must equal a configured pin; CA and name
 *   are not checked. This is the path for self-signed console certificates.
 * - `insecure`: no verification. Explicit, per console, audited and logged as a warning.
 *
 * Responses: redirects are refused, bodies are size-capped and never decompressed, and
 * only the status, content type and Retry-After are kept from the headers.
 */
import { createHash, X509Certificate } from 'node:crypto';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity, connect, type TLSSocket } from 'node:tls';

export type TlsTrust =
  | { mode: 'verify'; caPem?: string | undefined }
  | { mode: 'pinned'; spkiSha256: readonly string[] }
  | { mode: 'insecure' };

export type TransportErrorCode =
  | 'connect_failed'
  | 'connect_timeout'
  | 'tls_verification_failed'
  | 'tls_pin_mismatch'
  | 'redirect_refused'
  | 'response_too_large'
  | 'connection_lost'
  | 'aborted';

export class TransportError extends Error {
  override readonly name = 'TransportError';
  readonly code: TransportErrorCode;
  /** True when HTTP request bytes may have reached the console. */
  readonly requestSent: boolean;

  constructor(
    code: TransportErrorCode,
    requestSent: boolean,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.code = code;
    this.requestSent = requestSent;
  }
}

/** Base64 SHA-256 of the certificate's SubjectPublicKeyInfo (the HPKP `pin-sha256` form). */
export function spkiSha256(certificate: X509Certificate): string {
  const spki = certificate.publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('base64');
}

const TLS_VERIFY_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
]);

export interface ConnectOptions {
  /** Validated address to connect to (from EgressGuard). */
  address: string;
  port: number;
  /** The configured console host, used for SNI and identity checks. */
  host: string;
  trust: TlsTrust;
  timeoutMs: number;
  signal: AbortSignal;
}

export function connectTls(options: ConnectOptions): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const { trust } = options;
    const socket = connect({
      host: options.address,
      port: options.port,
      ...(isIP(options.host) === 0 ? { servername: options.host } : {}),
      minVersion: 'TLSv1.2',
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: trust.mode === 'verify',
      ...(trust.mode === 'verify' && trust.caPem !== undefined ? { ca: trust.caPem } : {}),
      // Check identity against the configured host, not the address we connected to.
      checkServerIdentity: (_name, certificate) => checkServerIdentity(options.host, certificate),
    });
    let settled = false;
    const finish = (error: TransportError | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', onAbort);
      if (error === undefined) {
        resolve(socket);
      } else {
        socket.destroy();
        reject(error);
      }
    };
    const timer = setTimeout(() => {
      finish(
        new TransportError(
          'connect_timeout',
          false,
          'The console did not accept a connection in time.',
        ),
      );
    }, options.timeoutMs);
    const onAbort = (): void => {
      finish(new TransportError('aborted', false, 'The request was cancelled before it was sent.'));
    };
    options.signal.addEventListener('abort', onAbort, { once: true });
    socket.once('secureConnect', () => {
      if (trust.mode === 'pinned') {
        const certificate = socket.getPeerX509Certificate();
        if (certificate === undefined || !trust.spkiSha256.includes(spkiSha256(certificate))) {
          finish(
            new TransportError(
              'tls_pin_mismatch',
              false,
              "The console's certificate does not match the configured pin.",
            ),
          );
          return;
        }
      }
      finish(undefined);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      const code = error.code ?? '';
      finish(
        TLS_VERIFY_CODES.has(code) || code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL')
          ? new TransportError(
              'tls_verification_failed',
              false,
              "The console's TLS certificate could not be verified.",
              { cause: error },
            )
          : new TransportError('connect_failed', false, 'The console could not be reached.', {
              cause: error,
            }),
      );
    });
  });
}

export interface HttpRequest {
  method: string;
  path: string;
  /** Value of the Host header (configured console host, with port when not 443). */
  hostHeader: string;
  headers: Readonly<Record<string, string>>;
  body?: Buffer;
  /** The documented response media type. Default `application/json`. */
  accept?: string;
  maxResponseBytes: number;
  signal: AbortSignal;
}

export interface HttpResponse {
  status: number;
  contentType: string | undefined;
  retryAfter: string | undefined;
  body: Buffer;
}

/** Sends one request over an already verified socket and reads a bounded response. */
export function sendHttp(socket: TLSSocket, input: HttpRequest): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: TransportError): void => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener('abort', onAbort);
      req.destroy();
      socket.destroy();
      reject(error);
    };
    const onAbort = (): void => {
      fail(new TransportError('aborted', true, 'The request was cancelled while in flight.'));
    };
    const req = request({
      method: input.method,
      path: input.path,
      headers: {
        ...input.headers,
        host: input.hostHeader,
        accept: input.accept ?? 'application/json',
        'accept-encoding': 'identity',
        ...(input.body === undefined ? {} : { 'content-length': String(input.body.length) }),
      },
      setHost: false,
      // Use only the verified socket. Do not set `agent` (not even `false`): Node would
      // then ignore createConnection and open its own, unvalidated connection.
      createConnection: () => socket,
    });
    input.signal.addEventListener('abort', onAbort, { once: true });
    req.on('response', (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        fail(
          new TransportError(
            'redirect_refused',
            true,
            'The console answered with a redirect, which is never followed.',
          ),
        );
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > input.maxResponseBytes) {
          fail(
            new TransportError(
              'response_too_large',
              true,
              'The console response exceeded the size limit.',
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        input.signal.removeEventListener('abort', onAbort);
        socket.end();
        resolve({
          status,
          contentType: res.headers['content-type'],
          retryAfter: res.headers['retry-after'],
          body: Buffer.concat(chunks),
        });
      });
      res.on('error', (error) => {
        fail(
          new TransportError('connection_lost', true, 'The connection to the console was lost.', {
            cause: error,
          }),
        );
      });
    });
    req.on('error', (error) => {
      fail(
        new TransportError('connection_lost', true, 'The connection to the console was lost.', {
          cause: error,
        }),
      );
    });
    req.end(input.body);
  });
}
