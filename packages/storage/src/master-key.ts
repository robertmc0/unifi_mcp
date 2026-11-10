/**
 * Master encryption key: loading, validation and key derivation (spec §8.2, ADR 0007).
 *
 * - The key is 32 random bytes, stored outside the database as standard base64 text
 *   (`openssl rand -base64 32` produces the same format).
 * - Preferred source: a read-only file (Docker secret), via `UNIFI_MCP_MASTER_KEY_FILE`.
 *   Fallback: the `UNIFI_MCP_MASTER_KEY` environment variable, which is less isolated.
 * - Nothing in this package ever generates a key implicitly. The only generator,
 *   `writeNewMasterKeyFile`, refuses to overwrite an existing file and is meant for the
 *   explicit `crypto generate-key` command.
 * - Independent subkeys are derived with HKDF-SHA256: the secret-record encryption key
 *   and a public key identifier (fingerprint). The master key bytes themselves are never
 *   used directly and never stored.
 */
import {
  createSecretKey,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { inspect } from 'node:util';
import { isStorageError, StorageError } from './errors.ts';

export const MASTER_KEY_FILE_ENV = 'UNIFI_MCP_MASTER_KEY_FILE';
export const MASTER_KEY_ENV = 'UNIFI_MCP_MASTER_KEY';

const KEY_BYTES = 32;
const KEY_ID_BYTES = 16;
const MAX_KEY_FILE_BYTES = 4096;
const BASE64_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const HKDF_SALT = Buffer.from('unifi-local-mcp/master-key/v1', 'utf8');
const INFO_KEY_ID = Buffer.from('key-id', 'utf8');
const INFO_SECRET_RECORDS = Buffer.from('secret-records/aes-256-gcm', 'utf8');

const GENERATE_HINT =
  'Generate one with `unifi-mcp crypto generate-key` or `openssl rand -base64 32`, ' +
  'store it as a Docker secret or read-only file, and set ' +
  `${MASTER_KEY_FILE_ENV} to its path. See docs/configuration.md.`;

const secretRecordKeys = new WeakMap<MasterKey, KeyObject>();

export class MasterKey {
  /** Public fingerprint: 32 lowercase hex characters. Safe to log and display. */
  readonly id: string;

  private constructor(id: string) {
    this.id = id;
  }

  /** Builds a key from 32 bytes. The caller should zero its copy afterwards. */
  static fromBytes(bytes: Uint8Array): MasterKey {
    if (bytes.length !== KEY_BYTES) {
      throw new StorageError(
        'MASTER_KEY_INVALID',
        `The master key must be exactly ${String(KEY_BYTES)} bytes.`,
      );
    }
    if (bytes.every((byte) => byte === bytes[0])) {
      throw new StorageError(
        'MASTER_KEY_INVALID',
        `The master key consists of one repeated byte, so it is a placeholder, not a random key. ${GENERATE_HINT}`,
      );
    }
    const ikm = createSecretKey(bytes);
    const keyId = Buffer.from(hkdfSync('sha256', ikm, HKDF_SALT, INFO_KEY_ID, KEY_ID_BYTES));
    const recordKeyBytes = Buffer.from(
      hkdfSync('sha256', ikm, HKDF_SALT, INFO_SECRET_RECORDS, KEY_BYTES),
    );
    const key = new MasterKey(keyId.toString('hex'));
    secretRecordKeys.set(key, createSecretKey(recordKeyBytes));
    recordKeyBytes.fill(0);
    return key;
  }

  /** Parses the base64 text form. Surrounding whitespace (a trailing newline) is ignored. */
  static fromBase64(text: string): MasterKey {
    const trimmed = text.trim();
    if (!BASE64_KEY_PATTERN.test(trimmed)) {
      throw new StorageError(
        'MASTER_KEY_INVALID',
        `The master key is not ${String(KEY_BYTES)} bytes of standard base64 ` +
          `(expected 44 characters ending in "="). ${GENERATE_HINT}`,
      );
    }
    const bytes = Buffer.from(trimmed, 'base64');
    try {
      return MasterKey.fromBytes(bytes);
    } finally {
      bytes.fill(0);
    }
  }

  /** Constant-time comparison of key identities. */
  equals(other: MasterKey): boolean {
    return timingSafeEqual(Buffer.from(this.id, 'hex'), Buffer.from(other.id, 'hex'));
  }

  toString(): string {
    return `MasterKey(id=${this.id})`;
  }

  toJSON(): string {
    return this.toString();
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

/** Package-internal: the AES-256-GCM key for secret records. Not exported from index.ts. */
export function secretRecordKey(key: MasterKey): KeyObject {
  const keyObject = secretRecordKeys.get(key);
  if (keyObject === undefined) throw new Error('MasterKey was not constructed by fromBytes().');
  return keyObject;
}

export interface LoadedMasterKey {
  key: MasterKey;
  source: 'file' | 'environment';
  /** Non-fatal configuration problems the caller should log (never contain key material). */
  warnings: string[];
}

/** Reads and validates a key file. Errors and warnings never include the file contents. */
export async function readMasterKeyFile(path: string): Promise<LoadedMasterKey> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    throw new StorageError(
      'MASTER_KEY_UNREADABLE',
      `Cannot open the master key file ${path} (${(error as NodeJS.ErrnoException).code ?? 'error'}). ` +
        'The service will not start without its key. Restore the key file; do not generate ' +
        'a new key for an existing database.',
      { cause: error },
    );
  }
  let content: Buffer | undefined;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new StorageError(
        'MASTER_KEY_UNREADABLE',
        `The master key path ${path} is not a regular file.`,
      );
    }
    if (stat.size > MAX_KEY_FILE_BYTES) {
      throw new StorageError(
        'MASTER_KEY_INVALID',
        `The master key file ${path} is larger than ${String(MAX_KEY_FILE_BYTES)} bytes, so it ` +
          `cannot be a key file. ${GENERATE_HINT}`,
      );
    }
    const warnings: string[] = [];
    const mode = stat.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      warnings.push(
        `The master key file ${path} is accessible by group or other users ` +
          `(mode ${mode.toString(8).padStart(4, '0')}). Restrict it to the service user ` +
          '(mode 0400 or 0600).',
      );
    }
    content = await handle.readFile();
    try {
      return { key: MasterKey.fromBase64(content.toString('utf8')), source: 'file', warnings };
    } catch (error) {
      if (isStorageError(error, 'MASTER_KEY_INVALID')) {
        throw new StorageError('MASTER_KEY_INVALID', `Master key file ${path}: ${error.message}`);
      }
      throw error;
    }
  } finally {
    content?.fill(0);
    await handle.close();
  }
}

/**
 * Loads the master key from the environment.
 *
 * `UNIFI_MCP_MASTER_KEY_FILE` is preferred. `UNIFI_MCP_MASTER_KEY` is accepted as a less
 * isolated fallback; after reading, it is **deleted from `env`** so that child processes
 * and diagnostic dumps of `process.env` do not see it. Setting both is an error. Setting
 * neither fails closed: the caller must not start.
 */
export async function loadMasterKey(env: NodeJS.ProcessEnv): Promise<LoadedMasterKey> {
  const filePath = env[MASTER_KEY_FILE_ENV];
  const inline = env[MASTER_KEY_ENV];
  const hasFile = filePath !== undefined && filePath !== '';
  const hasInline = inline !== undefined && inline !== '';
  if (hasFile && hasInline) {
    throw new StorageError(
      'MASTER_KEY_CONFLICTING_SOURCES',
      `Both ${MASTER_KEY_FILE_ENV} and ${MASTER_KEY_ENV} are set. Set only one ` +
        `(${MASTER_KEY_FILE_ENV} is preferred).`,
    );
  }
  if (hasFile) return readMasterKeyFile(filePath);
  if (hasInline) {
    // Remove first, so the variable is gone even if the value turns out to be invalid.
    Reflect.deleteProperty(env, MASTER_KEY_ENV);
    const key = MasterKey.fromBase64(inline);
    return {
      key,
      source: 'environment',
      warnings: [
        `The master key was read from ${MASTER_KEY_ENV}. Environment variables are less ` +
          `isolated than a read-only key file; prefer ${MASTER_KEY_FILE_ENV} with a Docker secret.`,
      ],
    };
  }
  throw new StorageError(
    'MASTER_KEY_NOT_CONFIGURED',
    `No master key is configured. ${GENERATE_HINT} If this installation already has a ` +
      'database, you must provide the key it was created with.',
  );
}

/**
 * Generates a new random key and writes it to `path` with mode 0400. Refuses to overwrite
 * an existing file. Returns the new key's identifier.
 */
export async function writeNewMasterKeyFile(path: string): Promise<{ keyId: string }> {
  const bytes = randomBytes(KEY_BYTES);
  const text = `${bytes.toString('base64')}\n`;
  const key = MasterKey.fromBytes(bytes);
  bytes.fill(0);
  let handle;
  try {
    handle = await open(path, 'wx', 0o400);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new StorageError(
        'MASTER_KEY_FILE_EXISTS',
        `Refusing to overwrite the existing file ${path}. A key file must never be replaced ` +
          'while a database or backup depends on it; use `crypto rotate-key` to change keys.',
        { cause: error },
      );
    }
    throw error;
  }
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } catch (error) {
    // Do not leave a truncated key file behind (it would block a retry and is unusable).
    await handle.close();
    await unlink(path).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return { keyId: key.id };
}
