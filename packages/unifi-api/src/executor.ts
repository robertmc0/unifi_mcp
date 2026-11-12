/**
 * The UniFi side of the dispatcher (spec §4.4; ADR 0012): turns a validated, authorised
 * operation call into exactly one HTTPS request to the configured console.
 *
 * - URL: `https://<validated address>:<module port>` + module base path + the registered
 *   path template with segment-encoded values + declared query parameters. Nothing in the
 *   arguments can change the host, port, scheme, method, base path or headers.
 * - Headers are fixed: the module's authentication header with the stored credential,
 *   Accept, Content-Type for JSON bodies, and Host.
 * - Results map onto the dispatcher's error semantics: `requestNotSent` (egress, DNS,
 *   connect and TLS failures happen before any byte is written), `transient`, and
 *   `outcomeUncertain` for anything after the request may have reached the console.
 * - Upstream text is never returned verbatim: only the HTTP status and a documented,
 *   pattern-checked error `code` are passed on.
 */
import {
  renderPath,
  templatePlaceholders,
  type ExecutionCall,
  type ExecutorOutcome,
  type OperationExecutor,
  type ResponseType,
  type UpstreamError,
} from '@unifi-local-mcp/core';
import type { Logger } from '@unifi-local-mcp/telemetry';
import type { ConsoleRegistry } from './consoles.ts';
import { EgressError, type EgressGuard } from './egress.ts';
import { connectTls, sendHttp, TransportError, type HttpResponse } from './transport.ts';

const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const UPSTREAM_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const UPSTREAM_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface UnifiExecutorOptions {
  consoles: ConsoleRegistry;
  egress: EgressGuard;
  logger: Logger;
  connectTimeoutMs?: number;
}

function failure(error: UpstreamError): ExecutorOutcome {
  return { ok: false, error };
}

function queryString(
  names: readonly string[] | undefined,
  args: Readonly<Record<string, unknown>>,
): string {
  const params = new URLSearchParams();
  for (const name of names ?? []) {
    const value = args[name];
    const values = Array.isArray(value) ? (value as unknown[]) : [value];
    for (const item of values) {
      if (item === undefined || item === null) continue;
      if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
        throw new TypeError(`Query parameter ${name} must be a primitive.`);
      }
      params.append(name, String(item));
    }
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

function retryAfterMs(header: string | undefined): number | undefined {
  if (header === undefined) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Leading bytes of each binary media type an operation may return. */
const SIGNATURES: Record<Exclude<ResponseType, 'json'>, readonly number[]> = {
  'image/jpeg': [0xff, 0xd8, 0xff],
};

function isMedia(response: HttpResponse, responseType: Exclude<ResponseType, 'json'>): boolean {
  const declared = (response.contentType ?? '').split(';')[0]?.trim().toLowerCase();
  const signature = SIGNATURES[responseType];
  return (
    declared === responseType &&
    response.body.length > signature.length &&
    signature.every((byte, i) => response.body[i] === byte)
  );
}

function parseJson(response: HttpResponse): { ok: true; value: unknown } | { ok: false } {
  if (response.body.length === 0) return { ok: true, value: null };
  if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(response.contentType ?? ''))
    return { ok: false };
  try {
    return { ok: true, value: JSON.parse(response.body.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

function upstreamCode(body: unknown): string | undefined {
  const code = (body as { code?: unknown } | null)?.code;
  return typeof code === 'string' && UPSTREAM_CODE.test(code) ? code : undefined;
}

/** The documented `requestId` (a UUID) of an error response, if it has one. */
function upstreamRequestId(body: unknown): string | undefined {
  const id = (body as { requestId?: unknown } | null)?.requestId;
  return typeof id === 'string' && UPSTREAM_REQUEST_ID.test(id) ? id : undefined;
}

export class UnifiExecutor implements OperationExecutor {
  readonly #consoles: ConsoleRegistry;
  readonly #egress: EgressGuard;
  readonly #logger: Logger;
  readonly #connectTimeoutMs: number;
  readonly #insecureWarned = new Set<string>();

  constructor(options: UnifiExecutorOptions) {
    this.#consoles = options.consoles;
    this.#egress = options.egress;
    this.#logger = options.logger;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  async execute(call: ExecutionCall): Promise<ExecutorOutcome> {
    const { descriptor, target } = call;
    const isWrite = descriptor.effect === 'write';
    let connection;
    try {
      connection = this.#consoles.connection(target.consoleId, descriptor.moduleId);
    } catch (error) {
      this.#logger.error('console credential unreadable', {
        consoleId: target.consoleId,
        err: error,
      });
      return failure({
        code: 'credentials_unreadable',
        message: 'The stored console credential cannot be read.',
        requestNotSent: true,
      });
    }
    if (connection === undefined) {
      return failure({
        code: 'console_not_configured',
        message: 'The console or module is not configured.',
        requestNotSent: true,
      });
    }
    if (connection.credential === undefined) {
      return failure({
        code: 'credentials_missing',
        message: 'No credential is configured for this module on this console.',
        requestNotSent: true,
      });
    }

    // Request parts, entirely from the descriptor.
    const args = call.arguments;
    const placeholders = templatePlaceholders(descriptor.pathTemplate);
    const pathValues: Record<string, string | number> = {};
    for (const name of placeholders) {
      const value = name === 'siteId' ? target.siteId : args[name];
      if (typeof value !== 'string' && typeof value !== 'number') {
        return failure({
          code: 'invalid_request',
          message: `Missing path parameter ${name}.`,
          requestNotSent: true,
        });
      }
      pathValues[name] = value;
    }
    // The body is exactly the validated `body` argument (ADR 0018); nothing else is added.
    const body =
      descriptor.requestBody === 'json' && args['body'] !== undefined
        ? Buffer.from(JSON.stringify(args['body']), 'utf8')
        : undefined;
    let path: string;
    try {
      path =
        connection.endpoint.basePath +
        renderPath(descriptor.pathTemplate, pathValues) +
        queryString(descriptor.queryParameters, args);
    } catch (error) {
      return failure({
        code: 'invalid_request',
        message: (error as Error).message,
        requestNotSent: true,
      });
    }
    const credential = connection.credential.reveal();
    const headers: Record<string, string> = {
      [connection.endpoint.auth.header.toLowerCase()]:
        connection.endpoint.auth.scheme === 'bearer' ? `Bearer ${credential}` : credential,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    };

    if (connection.trust.mode === 'insecure' && !this.#insecureWarned.has(connection.consoleId)) {
      this.#insecureWarned.add(connection.consoleId);
      this.#logger.warn(
        'TLS verification is DISABLED for this console (explicit insecure override)',
        {
          consoleId: connection.consoleId,
        },
      );
    }

    const started = performance.now();
    let response: HttpResponse;
    let status: number | undefined;
    try {
      const resolved = await this.#egress.resolve(connection.host);
      const socket = await connectTls({
        address: resolved.address,
        port: connection.port,
        host: connection.host,
        trust: connection.trust,
        timeoutMs: this.#connectTimeoutMs,
        signal: call.signal,
      });
      response = await sendHttp(socket, {
        method: descriptor.httpMethod,
        path,
        hostHeader:
          connection.port === 443
            ? connection.host
            : `${connection.host}:${String(connection.port)}`,
        headers,
        ...(body === undefined ? {} : { body }),
        ...(descriptor.responseType === undefined || descriptor.responseType === 'json'
          ? {}
          : { accept: descriptor.responseType }),
        maxResponseBytes: descriptor.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
        signal: call.signal,
      });
      status = response.status;
    } catch (error) {
      return failure(this.#transportFailure(error, isWrite, connection.consoleId));
    } finally {
      this.#logger.debug('upstream request', {
        correlationId: call.correlationId,
        consoleId: connection.consoleId,
        moduleId: connection.moduleId,
        method: descriptor.httpMethod,
        pathTemplate: descriptor.pathTemplate,
        attempt: call.attempt,
        ...(status === undefined ? {} : { status }),
        durationMs: Math.round(performance.now() - started),
      });
    }
    return this.#interpret(response, isWrite, descriptor.responseType ?? 'json', {
      correlationId: call.correlationId,
      consoleId: connection.consoleId,
      moduleId: connection.moduleId,
      method: descriptor.httpMethod,
      pathTemplate: descriptor.pathTemplate,
      attempt: call.attempt,
    });
  }

  #transportFailure(error: unknown, isWrite: boolean, consoleId: string): UpstreamError {
    if (error instanceof EgressError) {
      this.#logger.warn('egress refused', { consoleId, code: error.code });
      return {
        code: error.code,
        message: error.message,
        requestNotSent: true,
        transient: error.code === 'dns_failed',
      };
    }
    if (error instanceof TransportError) {
      if (!error.requestSent) {
        const tls = error.code === 'tls_verification_failed' || error.code === 'tls_pin_mismatch';
        if (tls)
          this.#logger.warn('console TLS verification failed', { consoleId, code: error.code });
        return {
          code: error.code,
          message: error.message,
          requestNotSent: true,
          transient: !tls && error.code !== 'aborted',
        };
      }
      return {
        code: error.code === 'aborted' ? 'upstream_timeout' : error.code,
        message: error.message,
        transient: error.code !== 'redirect_refused' && error.code !== 'response_too_large',
        // A redirect means the console did not act on the request; anything else might have.
        outcomeUncertain: isWrite && error.code !== 'redirect_refused',
      };
    }
    this.#logger.error('unexpected transport failure', { consoleId, err: error });
    return {
      code: 'upstream_error',
      message: 'The console request failed.',
      transient: !isWrite,
      outcomeUncertain: isWrite,
    };
  }

  #interpret(
    response: HttpResponse,
    isWrite: boolean,
    responseType: ResponseType,
    request: Readonly<Record<string, unknown>>,
  ): ExecutorOutcome {
    const { status } = response;
    if (status >= 200 && status < 300 && responseType !== 'json') {
      // Binary reads (ADR 0019): the documented media type, and bytes that are one.
      return isMedia(response, responseType)
        ? { ok: true, data: new Uint8Array(response.body) }
        : failure({
            code: 'invalid_response',
            message: `The console did not return the documented ${responseType} content.`,
          });
    }
    const parsed = parseJson(response);
    if (status >= 200 && status < 300) {
      if (!parsed.ok) {
        return failure({
          code: 'invalid_response',
          message: 'The console returned a response that is not valid JSON.',
          outcomeUncertain: isWrite,
        });
      }
      return { ok: true, data: parsed.value };
    }
    const code = parsed.ok ? upstreamCode(parsed.value) : undefined;
    const requestId = parsed.ok ? upstreamRequestId(parsed.value) : undefined;
    // The console answered with an error (not a transport failure). Only the status, the
    // documented code and the documented request id are logged; the request id lets an
    // administrator find the request in the console's own log. None reach the client.
    this.#logger.warn('console returned an error', {
      ...request,
      status,
      ...(code === undefined ? {} : { upstreamCode: code }),
      ...(requestId === undefined ? {} : { upstreamRequestId: requestId }),
    });
    const suffix = code === undefined ? '' : `, code ${code}`;
    // Structured, for operations that declare a known failure (ADR 0018 §4).
    const http = { status, ...(code === undefined ? {} : { upstreamCode: code }) };
    if (status === 401 || status === 403) {
      return failure({
        ...http,
        code: 'upstream_unauthorized',
        message: `The console rejected the credential (HTTP ${String(status)}${suffix}).`,
      });
    }
    if (status === 404) {
      return failure({
        ...http,
        code: 'upstream_not_found',
        message: `The console reports that the resource does not exist (HTTP 404${suffix}).`,
      });
    }
    if (status === 429) {
      const delay = retryAfterMs(response.retryAfter);
      return failure({
        ...http,
        code: 'upstream_rate_limited',
        message: 'The console is rate limiting requests.',
        transient: true,
        ...(delay === undefined ? {} : { retryAfterMs: delay }),
      });
    }
    if (status >= 500) {
      return failure({
        ...http,
        code: 'upstream_unavailable',
        message: `The console reported an internal error (HTTP ${String(status)}${suffix}).`,
        transient: true,
        outcomeUncertain: isWrite,
      });
    }
    return failure({
      ...http,
      code: 'upstream_rejected',
      message: `The console rejected the request (HTTP ${String(status)}${suffix}).`,
    });
  }
}
