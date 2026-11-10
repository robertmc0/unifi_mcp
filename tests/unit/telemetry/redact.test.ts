/**
 * Redaction and bounded serialisation (spec §6.4, §12; ADR 0008).
 */
import { SecretValue } from '@unifi-local-mcp/storage';
import {
  isSensitiveFieldName,
  redact,
  redactString,
  REDACTED,
  type RedactionLimits,
} from '@unifi-local-mcp/telemetry';
import { describe, expect, it } from 'vitest';

describe('isSensitiveFieldName', () => {
  it.each([
    'password',
    'Password',
    'userPassword',
    'passphrase',
    'x_passphrase',
    'apiKey',
    'api_key',
    'API-KEY',
    'x-api-key',
    'X-API-KEY',
    'apikey',
    'authorization',
    'Authorization',
    'authInfo',
    'cookie',
    'Set-Cookie',
    'sessionId',
    'refreshToken',
    'access_token',
    'clientSecret',
    'totpSecret',
    'otp',
    'doorPin',
    'PIN',
    'privateKey',
    'private_key',
    'masterKey',
    'credentials',
    'signature',
    'recoveryCodes',
    'jwt',
    'presharedKey',
    'pre_shared_key',
    'psk',
    'wpaPsk',
    'x_passphrase',
    'sharedKey',
    'encryptionKey',
    'wifiKey',
    'passkey',
  ])('treats %s as sensitive', (name) => {
    expect(isSensitiveFieldName(name)).toBe(true);
  });

  it.each([
    'name',
    'consoleId',
    'clientId',
    'operationId',
    'errorCode',
    'statusCode',
    'keyId',
    'spinning',
    'mapping',
    'pinned',
    'passive',
    'bypass',
    'authenticated',
    'tokenizer',
    'description',
    'keyboard',
    'monkey',
    'sharedSites',
  ])('leaves %s alone', (name) => {
    expect(isSensitiveFieldName(name)).toBe(false);
  });
});

describe('redactString', () => {
  it.each([
    ['Bearer abc.def-ghi_jkl', 'Bearer [REDACTED]'],
    ['header was bearer eyJhbGciOi.eyJzdWIi.sig', 'header was Bearer [REDACTED]'],
    ['Basic dXNlcjpwYXNz', 'Basic [REDACTED]'],
    ['Basic configuration applied', 'Basic configuration applied'],
    ['https://admin:hunter2@console.invalid/api', 'https://[REDACTED]@console.invalid/api'],
    [
      'https://console.invalid/x?api_key=abc123&site=default',
      'https://console.invalid/x?api_key=[REDACTED]&site=default',
    ],
    ['GET /v1?token=abc&page=2', 'GET /v1?token=[REDACTED]&page=2'],
    ['stream rtsps://192.0.2.10:7441/AbCdEf123?enableSrtp ok', 'stream rtsps://[REDACTED] ok'],
  ])('redacts %j', (input, expected) => {
    expect(redactString(input)).toBe(expected);
  });

  it('redacts PEM private keys, including unterminated ones', () => {
    const pem =
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';
    expect(redactString(`key: ${pem} end`)).toBe('key: [REDACTED PRIVATE KEY] end');
    expect(redactString('-----BEGIN RSA PRIVATE KEY-----\nMIIEow')).toBe('[REDACTED PRIVATE KEY]');
  });

  it('truncates long strings with a marker', () => {
    expect(redactString('a'.repeat(30), 10)).toBe(`${'a'.repeat(10)}…[20 more characters]`);
  });
});

describe('redact', () => {
  const small: RedactionLimits = {
    maxDepth: 3,
    maxStringLength: 20,
    maxArrayItems: 2,
    maxObjectKeys: 3,
  };

  it('redacts sensitive fields at any depth and keeps the rest', () => {
    expect(
      redact({
        consoleId: 'console-1',
        headers: { authorization: 'Bearer x', 'x-api-key': 'k', accept: 'application/json' },
        items: [{ passphrase: 'p', ssid: 'office' }],
        password: null,
      }),
    ).toEqual({
      consoleId: 'console-1',
      headers: { authorization: REDACTED, 'x-api-key': REDACTED, accept: 'application/json' },
      items: [{ passphrase: REDACTED, ssid: 'office' }],
      password: null,
    });
  });

  it('redacts SecretValue, binary data and secrets inside error messages', () => {
    const error = new Error('upstream rejected Bearer abc', { cause: new Error('inner') });
    (error as Error & { code: string }).code = 'E_UPSTREAM';
    const result = redact({
      value: new SecretValue('top-secret'),
      blob: Buffer.from('secret bytes'),
      error,
    }) as Record<string, Record<string, unknown>>;
    expect(result['value']).toBe(REDACTED);
    expect(result['blob']).toBe('[binary 12 bytes]');
    expect(result['error']).toMatchObject({
      name: 'Error',
      message: 'upstream rejected Bearer [REDACTED]',
      code: 'E_UPSTREAM',
      cause: { name: 'Error', message: 'inner' },
    });
    expect(JSON.stringify(result)).not.toContain('top-secret');
  });

  it('bounds depth, arrays, strings and keys', () => {
    expect(
      redact(
        {
          deep: { a: { b: { c: 1 } } },
          list: [1, 2, 3, 4],
          text: 'x'.repeat(25),
          extra: 1,
        },
        small,
      ),
    ).toEqual({
      deep: { a: { b: '[Truncated: depth limit]' } },
      list: [1, 2, '[2 more items]'],
      text: `${'x'.repeat(20)}…[5 more characters]`,
      _truncatedKeys: 1,
    });
  });

  it('handles cycles, shared references and non-JSON values', () => {
    const shared = { n: 1 };
    const cyclic: Record<string, unknown> = { shared, again: shared };
    cyclic['self'] = cyclic;
    expect(redact(cyclic)).toEqual({ shared: { n: 1 }, again: { n: 1 }, self: '[Circular]' });
    expect(
      redact({
        big: 12n,
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        when: new Date('2026-11-10T00:00:00Z'),
        fn: () => 1,
        skipped: undefined,
        map: new Map([[1, 2]]),
      }),
    ).toEqual({
      big: '12',
      nan: 'NaN',
      inf: 'Infinity',
      when: '2026-11-10T00:00:00.000Z',
      fn: '[function]',
      map: '[Map size 1]',
    });
  });

  it('never throws on hostile objects', () => {
    const hostile = {};
    Object.defineProperty(hostile, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter');
      },
    });
    expect(redact({ hostile })).toEqual({ hostile: '[Unserialisable]' });
  });
});
