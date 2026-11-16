/**
 * Time-based one-time passwords (RFC 6238 on RFC 4226) for administrator sign-in
 * (spec §7.2; ADR 0026). Built on `node:crypto`; no dependency.
 *
 * Parameters are the ones every authenticator app supports: HMAC-SHA-1, 6 digits, a
 * 30-second step, and a 160-bit secret shown in Base32. One step either side of the
 * current one is accepted, for clock drift. A code is accepted once: the caller stores the
 * step it accepted and passes it back as `afterStep`.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
const SECRET_BYTES = 20;
const DRIFT_STEPS = 1;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31] ?? '';
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31] ?? '';
  return out;
}

/** Decodes unpadded Base32 (upper case). Throws on any other character. */
export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new TypeError('Not a Base32 string.');
    value = ((value << 5) | index) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new random secret, in Base32 (32 characters). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

export function totpStep(now: Date, periodSeconds = TOTP_PERIOD_SECONDS): number {
  return Math.floor(now.getTime() / 1000 / periodSeconds);
}

/** The HOTP value of `counter` (RFC 4226 §5.3), as a zero-padded decimal string. */
export function hotp(
  secret: Uint8Array,
  counter: number,
  digits = TOTP_DIGITS,
  algorithm: 'sha1' | 'sha256' | 'sha512' = 'sha1',
): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, secret).update(message).digest();
  const offset = (mac.at(-1) ?? 0) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The code an authenticator shows for `secretBase32` at `now`. */
export function totpCode(secretBase32: string, now: Date): string {
  return hotp(base32Decode(secretBase32), totpStep(now));
}

/**
 * Checks a code against the current step and one step either side. Returns the step that
 * matched, or undefined. Steps at or before `afterStep` never match, so a code that was
 * accepted cannot be used again. Every candidate is compared, in constant time.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  now: Date,
  afterStep = 0,
): number | undefined {
  if (!/^\d{6}$/.test(code)) return undefined;
  const secret = base32Decode(secretBase32);
  const presented = Buffer.from(code, 'utf8');
  const current = totpStep(now);
  let matched: number | undefined;
  for (let step = current - DRIFT_STEPS; step <= current + DRIFT_STEPS; step++) {
    const expected = Buffer.from(hotp(secret, step), 'utf8');
    if (timingSafeEqual(presented, expected) && step > afterStep && matched === undefined) {
      matched = step;
    }
  }
  return matched;
}

/** The `otpauth://` URI authenticator apps accept (the "Key URI" format). */
export function otpauthUri(secretBase32: string, username: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(username)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
