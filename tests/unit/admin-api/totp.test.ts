/**
 * TOTP against the published test vectors (RFC 4226 Appendix D, RFC 6238 Appendix B,
 * RFC 4648 §10), and the acceptance rules: one step of drift, and no code twice
 * (spec §7.2; ADR 0026).
 */
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  totpCode,
  totpStep,
  verifyTotp,
} from '@unifi-local-mcp/admin-api';
import { describe, expect, it } from 'vitest';

const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const SECRET = base32Encode(RFC_SECRET);
const at = (seconds: number): Date => new Date(seconds * 1000);

describe('Base32', () => {
  it.each([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('encodes %j as %j and back (RFC 4648)', (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain, 'ascii'))).toBe(encoded);
    expect(base32Decode(encoded).toString('ascii')).toBe(plain);
  });

  it('round-trips random secrets and refuses other characters', () => {
    for (let i = 0; i < 20; i++) {
      const secret = generateTotpSecret();
      expect(secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(base32Encode(base32Decode(secret))).toBe(secret);
    }
    expect(generateTotpSecret()).not.toBe(generateTotpSecret());
    for (const bad of ['abc', 'MZXW1', 'MZ XW', 'MZXW6===']) {
      expect(() => base32Decode(bad)).toThrow(/Base32/);
    }
  });
});

describe('HOTP and TOTP values', () => {
  it('match RFC 4226 Appendix D', () => {
    expect(Array.from({ length: 10 }, (_, counter) => hotp(RFC_SECRET, counter))).toEqual([
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ]);
  });

  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('match RFC 6238 Appendix B at %d s (SHA-1, 8 digits)', (seconds, expected) => {
    expect(hotp(RFC_SECRET, totpStep(at(seconds)), 8)).toBe(expected);
  });

  it.each([
    ['sha256', '12345678901234567890123456789012', 59, '46119246'],
    ['sha512', '1234567890123456789012345678901234567890123456789012345678901234', 59, '90693936'],
  ] as const)('match RFC 6238 Appendix B for %s', (algorithm, secret, seconds, expected) => {
    expect(hotp(Buffer.from(secret, 'ascii'), totpStep(at(seconds)), 8, algorithm)).toBe(expected);
  });

  it('show six digits, the last six of the eight-digit vector', () => {
    expect(totpCode(SECRET, at(59))).toBe('287082');
    expect(totpCode(SECRET, at(1111111109))).toBe('081804');
    expect(totpStep(at(59))).toBe(1);
    expect(totpStep(at(60))).toBe(2);
  });
});

describe('TOTP verification', () => {
  const now = at(1_800_000_015); // the middle of a step
  const step = totpStep(now);
  const code = (offset: number): string => hotp(RFC_SECRET, step + offset);

  it('accepts the current step and one either side, and nothing further', () => {
    expect(verifyTotp(SECRET, code(0), now)).toBe(step);
    expect(verifyTotp(SECRET, code(-1), now)).toBe(step - 1);
    expect(verifyTotp(SECRET, code(1), now)).toBe(step + 1);
    expect(verifyTotp(SECRET, code(-2), now)).toBeUndefined();
    expect(verifyTotp(SECRET, code(2), now)).toBeUndefined();
    expect(verifyTotp(SECRET, code(-20), now)).toBeUndefined();
  });

  it('never accepts a step at or before the last accepted one', () => {
    expect(verifyTotp(SECRET, code(0), now, step)).toBeUndefined();
    expect(verifyTotp(SECRET, code(-1), now, step)).toBeUndefined();
    expect(verifyTotp(SECRET, code(-1), now, step - 1)).toBeUndefined();
    expect(verifyTotp(SECRET, code(0), now, step - 1)).toBe(step);
    expect(verifyTotp(SECRET, code(1), now, step)).toBe(step + 1);
  });

  it('refuses anything that is not six digits, and another secret', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', ' 12345', '12 345', '１２３４５６']) {
      expect(verifyTotp(SECRET, bad, now), JSON.stringify(bad)).toBeUndefined();
    }
    expect(verifyTotp(generateTotpSecret(), code(0), now)).toBeUndefined();
  });
});

describe('otpauth URI', () => {
  it('carries the secret, issuer and parameters authenticator apps expect', () => {
    const uri = new URL(otpauthUri(SECRET, 'alice', 'unifi-local-mcp'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/unifi-local-mcp:alice');
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      secret: SECRET,
      issuer: 'unifi-local-mcp',
      algorithm: 'SHA1',
      digits: '6',
      period: '30',
    });
  });
});
