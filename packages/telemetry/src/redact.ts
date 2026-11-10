/**
 * Redaction and bounded, JSON-safe serialisation for logs and audit details (spec §6.4,
 * §12; ADR 0008).
 *
 * Two layers, applied to every value before it is written anywhere:
 *
 * 1. **Field names.** A field is replaced by `[REDACTED]` when its name contains a
 *    sensitive word (password, secret, token, API key, authorization, cookie, session,
 *    TOTP/OTP, PIN, credential, passphrase, PSK/pre-shared key, private key, ...). Names are split into words
 *    (camelCase, snake_case, kebab-case), so `pin` matches `doorPin` but not `spinning`.
 *    This is deliberately conservative: name non-secret identifiers without these words.
 * 2. **String contents.** Bearer/Basic credentials, credentials in URLs, secret-looking
 *    query parameters, RTSP(S) stream URLs (their path is the stream secret) and PEM private
 *    keys are replaced inside any string.
 *
 * Output is bounded (depth, keys, array items, string length), cycle-safe, never contains
 * binary data, and never throws. Schema-specific redaction of UniFi payloads is added by
 * the adapters on top of this; this layer is the backstop.
 */

export const REDACTED = '[REDACTED]';

export interface RedactionLimits {
  maxDepth: number;
  maxStringLength: number;
  maxArrayItems: number;
  maxObjectKeys: number;
}

export const LOG_LIMITS: RedactionLimits = {
  maxDepth: 8,
  maxStringLength: 2048,
  maxArrayItems: 50,
  maxObjectKeys: 100,
};

/** Single words that mark a field as sensitive. */
const SENSITIVE_WORDS = new Set([
  'auth',
  'authorization',
  'bearer',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'jwt',
  'mfa',
  'otp',
  'pass',
  'passcode',
  'passkey',
  'passphrase',
  'passwd',
  'password',
  'pin',
  'preshared',
  'psk',
  'pwd',
  'secret',
  'secrets',
  'session',
  'signature',
  'token',
  'tokens',
  'totp',
]);

/** Word pairs that mark a field as sensitive when adjacent ("api" + "key" = apiKey, api_key, x-api-key). */
const SENSITIVE_PAIRS = new Set([
  'access key',
  'api key',
  'encryption key',
  'master key',
  'network key',
  'private key',
  'recovery code',
  'recovery codes',
  'secret key',
  'session key',
  'set cookie',
  'shared key',
  'signing key',
  'wep key',
  'wifi key',
  'wpa key',
]);

/** Splits a field name into lowercase words: `xApiKey`, `x_api_key`, `X-API-KEY` → x, api, key. */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

export function isSensitiveFieldName(name: string): boolean {
  const parts = words(name);
  if (parts.some((part) => SENSITIVE_WORDS.has(part))) return true;
  // Also catch run-together names such as "apikey" or "privatekey".
  if (
    parts.some((part) =>
      ['apikey', 'privatekey', 'masterkey', 'accesskey', 'sharedkey', 'wpapsk'].includes(part),
    )
  ) {
    return true;
  }
  for (let i = 0; i + 1 < parts.length; i++) {
    if (SENSITIVE_PAIRS.has(`${parts[i] ?? ''} ${parts[i + 1] ?? ''}`)) return true;
  }
  return false;
}

/** Patterns replaced inside any string. Order matters: more specific patterns first. */
const STRING_PATTERNS: readonly [RegExp, string][] = [
  // unifi-local-mcp client tokens (ADR 0013): umcp_<12 hex token id>_<43 base64url secret>.
  [/\bumcp_[0-9a-f]{12}_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, REDACTED],
  [
    /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    '[REDACTED PRIVATE KEY]',
  ],
  // Protect RTSP(S) URLs: the path is the stream secret.
  [/\brtsps?:\/\/[^\s"'<>]+/gi, 'rtsps://[REDACTED]'],
  // user:password@ in any URL.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]*@/gi, `$1${REDACTED}@`],
  // Authorization scheme credentials. Anything after "Bearer" is treated as a credential.
  [/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, `Bearer ${REDACTED}`],
  // Basic credentials must look like base64 (an inner capital, a digit or +/=), so that
  // prose such as "Basic configuration" is left alone.
  [
    /\bBasic\s+(?=[A-Za-z0-9+/]*(?:[a-z0-9+/][A-Z]|[0-9+/=]))[A-Za-z0-9+/]{6,}={0,2}/g,
    `Basic ${REDACTED}`,
  ],
  // Secret-looking query or form parameters.
  [
    /([?&;](?:access_token|api[-_]?key|apikey|auth|code|key|password|passwd|pwd|secret|session|sig|signature|token)=)[^&#\s"']*/gi,
    `$1${REDACTED}`,
  ],
];

export function redactString(value: string, maxLength = LOG_LIMITS.maxStringLength): string {
  let result = value;
  for (const [pattern, replacement] of STRING_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  if (result.length > maxLength) {
    const omitted = result.length - maxLength;
    result = `${result.slice(0, maxLength)}…[${String(omitted)} more characters]`;
  }
  return result;
}

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function redactError(
  error: Error,
  limits: RedactionLimits,
  depth: number,
  ancestors: WeakSet<object>,
): JsonValue {
  const result: Record<string, JsonValue> = {
    name: redactString(error.name, 128),
    message: redactString(error.message, limits.maxStringLength),
  };
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' || typeof code === 'number') result['code'] = code;
  if (error.stack !== undefined)
    result['stack'] = redactString(error.stack, limits.maxStringLength);
  if (error.cause !== undefined) {
    result['cause'] = redactValue(error.cause, limits, depth + 1, ancestors);
  }
  return result;
}

function redactValue(
  value: unknown,
  limits: RedactionLimits,
  depth: number,
  ancestors: WeakSet<object>,
): JsonValue {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'bigint':
      return value.toString();
    case 'string':
      return redactString(value, limits.maxStringLength);
    case 'symbol':
    case 'function':
      return `[${typeof value}]`;
    case 'object':
      break;
  }
  const object = value;
  if (depth >= limits.maxDepth) return '[Truncated: depth limit]';
  if (ancestors.has(object)) return '[Circular]';
  if (object instanceof Uint8Array || object instanceof ArrayBuffer) {
    return `[binary ${String(object.byteLength)} bytes]`;
  }
  if (object instanceof Date) {
    return Number.isNaN(object.getTime()) ? 'Invalid Date' : object.toISOString();
  }
  ancestors.add(object);
  try {
    if (object instanceof Error) return redactError(object, limits, depth, ancestors);
    if (object instanceof Map || object instanceof Set) {
      return `[${object instanceof Map ? 'Map' : 'Set'} size ${String(object.size)}]`;
    }
    // Values that define their own JSON form (for example SecretValue, which renders as
    // [REDACTED]) are serialised through it.
    const toJSON = (object as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') {
      return redactValue((toJSON as () => unknown).call(object), limits, depth + 1, ancestors);
    }
    if (Array.isArray(object)) {
      const items = object
        .slice(0, limits.maxArrayItems)
        .map((item: unknown) => redactValue(item, limits, depth + 1, ancestors));
      if (object.length > limits.maxArrayItems) {
        items.push(`[${String(object.length - limits.maxArrayItems)} more items]`);
      }
      return items;
    }
    const result: Record<string, JsonValue> = {};
    const keys = Object.keys(object);
    for (const key of keys.slice(0, limits.maxObjectKeys)) {
      const field = (object as Record<string, unknown>)[key];
      if (field === undefined) continue;
      result[redactString(key, 128)] =
        field !== null && isSensitiveFieldName(key)
          ? REDACTED
          : redactValue(field, limits, depth + 1, ancestors);
    }
    if (keys.length > limits.maxObjectKeys) {
      result['_truncatedKeys'] = keys.length - limits.maxObjectKeys;
    }
    return result;
  } catch {
    // A hostile getter or toJSON must not break logging.
    return '[Unserialisable]';
  } finally {
    ancestors.delete(object);
  }
}

/** Returns a redacted, bounded, JSON-safe copy of `value`. Never throws. */
export function redact(value: unknown, limits: RedactionLimits = LOG_LIMITS): JsonValue {
  return redactValue(value, limits, 0, new WeakSet());
}
