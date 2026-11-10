/**
 * Administrator password hashing with Argon2id (spec §7.2; ADR 0015), using Node's built-in
 * `crypto.argon2Sync` (no native dependency). Hashes use the standard PHC string format so
 * parameters can be raised later without breaking existing hashes.
 *
 * Parameters: 64 MiB memory, 3 passes, parallelism 1, 16-byte salt, 32-byte tag. This is
 * above the OWASP minimum (19 MiB, 2 passes) and takes tens of milliseconds.
 */
import { argon2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

export const ARGON2_PARAMETERS = {
  memory: 65_536,
  passes: 3,
  parallelism: 1,
  tagLength: 32,
} as const;
const SALT_BYTES = 16;
const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1024;

function b64(buffer: Buffer): string {
  return buffer.toString('base64').replace(/=+$/, '');
}

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const { memory, passes, parallelism, tagLength } = ARGON2_PARAMETERS;
  const tag = argon2Sync('argon2id', {
    message: password,
    nonce: salt,
    memory,
    passes,
    parallelism,
    tagLength,
  });
  return `$argon2id$v=19$m=${String(memory)},t=${String(passes)},p=${String(parallelism)}$${b64(salt)}$${b64(tag)}`;
}

/** Constant-time verification against a PHC string. Malformed hashes never verify. */
export function verifyPassword(hash: string, password: string): boolean {
  const match = PHC.exec(hash);
  if (match === null) return false;
  const [, memory, passes, parallelism, salt = '', expected = ''] = match;
  const expectedTag = Buffer.from(expected, 'base64');
  const tag = argon2Sync('argon2id', {
    message: password,
    nonce: Buffer.from(salt, 'base64'),
    memory: Number(memory),
    passes: Number(passes),
    parallelism: Number(parallelism),
    tagLength: expectedTag.length,
  });
  return tag.length === expectedTag.length && timingSafeEqual(tag, expectedTag);
}

/** Returns a reason the password is unacceptable, or undefined. */
export function passwordProblem(password: string, username: string): string | undefined {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `The password must be at least ${String(PASSWORD_MIN_LENGTH)} characters long.`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) return 'The password is too long.';
  if (password.toLowerCase().includes(username.toLowerCase())) {
    return 'The password must not contain the username.';
  }
  if (new Set(password).size < 4) return 'The password is too repetitive.';
  return undefined;
}
