/**
 * Encrypted secret records (spec §8.2): UniFi API keys, TOTP secrets and other credentials.
 *
 * Callers address a record by its generated id and must state the expected `kind` on
 * every read, so a record of one kind cannot be used where another is expected. Values
 * are returned as `SecretValue`, which redacts itself in logs, JSON and `util.inspect`.
 */
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { openEnvelope, sealEnvelope } from './envelope.ts';
import { StorageError } from './errors.ts';
import { readActiveKeyId } from './keys.ts';
import type { MasterKey } from './master-key.ts';
import { columnBlob, columnText, type SqliteDatabase } from './sqlite.ts';

/**
 * Writes are conditional on the store's key still being the active key, so a process that
 * kept running across a key rotation cannot seal new records with the retired key.
 */
const KEY_IS_ACTIVE = "EXISTS (SELECT 1 FROM crypto_keys WHERE key_id = ? AND status = 'active')";
const KIND_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const MAX_SECRET_BYTES = 64 * 1024;
const REDACTED = '[REDACTED]';

/** A secret string that does not reveal itself unless `reveal()` is called explicitly. */
export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return `SecretValue(${REDACTED})`;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }
}

function assertKind(kind: string): void {
  if (!KIND_PATTERN.test(kind)) {
    throw new TypeError(`Invalid secret kind "${kind}" (expected ${KIND_PATTERN.source}).`);
  }
}

function encodeValue(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length === 0 || bytes.length > MAX_SECRET_BYTES) {
    bytes.fill(0);
    throw new TypeError(
      `A secret value must be between 1 and ${String(MAX_SECRET_BYTES)} bytes long.`,
    );
  }
  return bytes;
}

export class SecretStore {
  readonly #db: SqliteDatabase;
  readonly #key: MasterKey;
  readonly #now: () => Date;

  constructor(db: SqliteDatabase, key: MasterKey, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#key = key;
    this.#now = now;
  }

  /** Stores a new secret and returns its record id. */
  create(kind: string, value: string): string {
    assertKind(kind);
    const id = randomUUID();
    const plaintext = encodeValue(value);
    try {
      const envelope = sealEnvelope(this.#key, { kind, recordId: id }, plaintext);
      const timestamp = this.#now().toISOString();
      const result = this.#db.run(
        'INSERT INTO secret_records (id, kind, key_id, envelope, created_at, updated_at) ' +
          `SELECT ?, ?, ?, ?, ?, ? WHERE ${KEY_IS_ACTIVE}`,
        [id, kind, this.#key.id, envelope, timestamp, timestamp, this.#key.id],
      );
      if (result.changes === 0) throw this.#keyNoLongerActive();
    } finally {
      plaintext.fill(0);
    }
    return id;
  }

  /** Replaces the value of an existing record of the given kind. */
  replace(id: string, kind: string, value: string): void {
    assertKind(kind);
    const plaintext = encodeValue(value);
    try {
      const envelope = sealEnvelope(this.#key, { kind, recordId: id }, plaintext);
      const result = this.#db.run(
        'UPDATE secret_records SET key_id = ?, envelope = ?, updated_at = ? ' +
          `WHERE id = ? AND kind = ? AND ${KEY_IS_ACTIVE}`,
        [this.#key.id, envelope, this.#now().toISOString(), id, kind, this.#key.id],
      );
      if (result.changes === 0) {
        throw readActiveKeyId(this.#db) === this.#key.id
          ? this.#notFound(id, kind)
          : this.#keyNoLongerActive();
      }
    } finally {
      plaintext.fill(0);
    }
  }

  /** Decrypts a record. Fails if it does not exist, has another kind, or fails authentication. */
  read(id: string, kind: string): SecretValue {
    assertKind(kind);
    const row = this.#db.get('SELECT kind, envelope FROM secret_records WHERE id = ?', [id]);
    if (row === undefined) throw this.#notFound(id, kind);
    const storedKind = columnText(row, 'kind');
    if (storedKind !== kind) {
      throw new StorageError(
        'SECRET_KIND_MISMATCH',
        `Secret record ${id} is a ${storedKind}, not a ${kind}.`,
      );
    }
    const plaintext = openEnvelope(this.#key, { kind, recordId: id }, columnBlob(row, 'envelope'));
    try {
      return new SecretValue(plaintext.toString('utf8'));
    } finally {
      plaintext.fill(0);
    }
  }

  /** Deletes a record (overwritten on disk: `secure_delete` is on). Returns false if absent. */
  delete(id: string): boolean {
    return this.#db.run('DELETE FROM secret_records WHERE id = ?', [id]).changes > 0;
  }

  /**
   * Decrypts every record without returning values, proving that all of them are intact
   * and readable with the configured key. Used by restore validation and `db check`.
   */
  verifyAll(): number {
    const rows = this.#db.all('SELECT id, kind, envelope FROM secret_records ORDER BY id');
    for (const row of rows) {
      const context = { kind: columnText(row, 'kind'), recordId: columnText(row, 'id') };
      openEnvelope(this.#key, context, columnBlob(row, 'envelope')).fill(0);
    }
    return rows.length;
  }

  #notFound(id: string, kind: string): StorageError {
    return new StorageError('SECRET_NOT_FOUND', `No ${kind} secret record with id ${id}.`);
  }

  #keyNoLongerActive(): StorageError {
    return new StorageError(
      'MASTER_KEY_MISMATCH',
      `Master key ${this.#key.id} is no longer the database's active key (it was rotated). ` +
        'Restart the service with the new key file.',
    );
  }
}
