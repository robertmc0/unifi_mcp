/**
 * Binding between the master key and a database (spec §8.2, ADR 0007).
 *
 * The database records the *identifier* (HKDF fingerprint) of the active master key, never
 * the key. On open, the configured key must match the recorded active key, otherwise the
 * open fails closed without writing anything. A key is registered only on a completely
 * empty key state, which is how "never silently generate or adopt a new key over an
 * existing database" is enforced.
 */
import { createHash } from 'node:crypto';
import { openEnvelope, sealEnvelope } from './envelope.ts';
import { StorageError } from './errors.ts';
import type { MasterKey } from './master-key.ts';
import { columnBlob, columnInteger, columnText, type SqliteDatabase } from './sqlite.ts';

export function readActiveKeyId(db: SqliteDatabase): string | undefined {
  const row = db.get("SELECT key_id FROM crypto_keys WHERE status = 'active'");
  return row === undefined ? undefined : columnText(row, 'key_id');
}

function count(db: SqliteDatabase, sql: string, params: readonly string[] = []): number {
  const row = db.get(sql, params);
  return row === undefined ? 0 : columnInteger(row, 'n');
}

function mismatch(configured: MasterKey, activeKeyId: string): StorageError {
  return new StorageError(
    'MASTER_KEY_MISMATCH',
    `The configured master key (id ${configured.id}) is not the key this database uses ` +
      `(id ${activeKeyId}). The service will not start. Provide the original key file. ` +
      'Do not generate a new key: stored credentials cannot be recovered without the ' +
      'original key.',
  );
}

/**
 * Verifies that `key` is the database's active master key, or registers it if the
 * database has no key state and no secret records yet. Runs in one write transaction and
 * changes nothing when it fails.
 */
export function verifyOrRegisterMasterKey(
  db: SqliteDatabase,
  key: MasterKey,
  now: () => Date = () => new Date(),
): 'verified' | 'registered' {
  return db.transaction(() => {
    const activeKeyId = readActiveKeyId(db);
    if (activeKeyId === undefined) {
      const keys = count(db, 'SELECT count(*) AS n FROM crypto_keys');
      const records = count(db, 'SELECT count(*) AS n FROM secret_records');
      if (keys > 0 || records > 0) {
        throw new StorageError(
          'KEY_STATE_INCONSISTENT',
          `The database has no active master key but contains ${String(records)} secret ` +
            `record(s) and ${String(keys)} retired key(s). It has been modified outside the ` +
            'service. Restore it from a backup.',
        );
      }
      db.run("INSERT INTO crypto_keys (key_id, status, created_at) VALUES (?, 'active', ?)", [
        key.id,
        now().toISOString(),
      ]);
      return 'registered';
    }
    if (activeKeyId !== key.id) throw mismatch(key, activeKeyId);
    const foreign = count(db, 'SELECT count(*) AS n FROM secret_records WHERE key_id <> ?', [
      activeKeyId,
    ]);
    if (foreign > 0) {
      throw new StorageError(
        'KEY_STATE_INCONSISTENT',
        `${String(foreign)} secret record(s) are not sealed with the active master key. ` +
          'Key rotation is atomic, so the database has been modified outside the service. ' +
          'Restore it from a backup.',
      );
    }
    return 'verified';
  });
}

export interface RotationResult {
  previousKeyId: string;
  newKeyId: string;
  reencrypted: number;
}

/**
 * Re-encrypts every secret record from `current` to `next` in a single transaction:
 * decrypt with `current`, seal with `next`, verify that each new envelope decrypts to the
 * same plaintext digest and that the record count is unchanged, then retire `current`
 * and activate `next`. Any failure rolls everything back, so the database keeps working
 * with `current`. Take a backup first, and keep the old key file until the backups that
 * need it have expired.
 */
export function rotateMasterKey(
  db: SqliteDatabase,
  current: MasterKey,
  next: MasterKey,
  now: () => Date = () => new Date(),
): RotationResult {
  if (current.equals(next)) {
    throw new StorageError(
      'MASTER_KEY_INVALID',
      'The new master key is the same as the current key. Generate a new key file first.',
    );
  }
  return db.transaction(() => {
    const activeKeyId = readActiveKeyId(db);
    if (activeKeyId === undefined) {
      throw new StorageError(
        'KEY_STATE_INCONSISTENT',
        'The database has no active master key to rotate from.',
      );
    }
    if (activeKeyId !== current.id) throw mismatch(current, activeKeyId);
    const known = count(db, 'SELECT count(*) AS n FROM crypto_keys WHERE key_id = ?', [next.id]);
    if (known > 0) {
      throw new StorageError(
        'MASTER_KEY_INVALID',
        `Master key ${next.id} was used by this database before. Rotate to a newly ` +
          'generated key.',
      );
    }
    const timestamp = now().toISOString();
    // The new key row must exist before records reference it (foreign key).
    db.run("UPDATE crypto_keys SET status = 'retired', retired_at = ? WHERE key_id = ?", [
      timestamp,
      current.id,
    ]);
    db.run("INSERT INTO crypto_keys (key_id, status, created_at) VALUES (?, 'active', ?)", [
      next.id,
      timestamp,
    ]);

    const rows = db.all('SELECT id, kind, envelope FROM secret_records ORDER BY id');
    const digests = new Map<string, string>();
    for (const row of rows) {
      const context = { kind: columnText(row, 'kind'), recordId: columnText(row, 'id') };
      const plaintext = openEnvelope(current, context, columnBlob(row, 'envelope'));
      try {
        digests.set(context.recordId, createHash('sha256').update(plaintext).digest('hex'));
        const sealed = sealEnvelope(next, context, plaintext);
        db.run('UPDATE secret_records SET key_id = ?, envelope = ? WHERE id = ?', [
          next.id,
          sealed,
          context.recordId,
        ]);
      } finally {
        plaintext.fill(0);
      }
    }

    // Verification pass over what will be committed.
    const after = db.all('SELECT id, kind, key_id, envelope FROM secret_records ORDER BY id');
    if (after.length !== rows.length) {
      throw new StorageError(
        'KEY_STATE_INCONSISTENT',
        'The number of secret records changed during key rotation; rotation rolled back.',
      );
    }
    for (const row of after) {
      const context = { kind: columnText(row, 'kind'), recordId: columnText(row, 'id') };
      const plaintext = openEnvelope(next, context, columnBlob(row, 'envelope'));
      const digest = createHash('sha256').update(plaintext).digest('hex');
      plaintext.fill(0);
      if (columnText(row, 'key_id') !== next.id || digests.get(context.recordId) !== digest) {
        throw new StorageError(
          'KEY_STATE_INCONSISTENT',
          `Verification of secret record ${context.recordId} failed after re-encryption; ` +
            'rotation rolled back.',
        );
      }
    }
    return { previousKeyId: current.id, newKeyId: next.id, reencrypted: rows.length };
  });
}
