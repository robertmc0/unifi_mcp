/**
 * Storage errors carry a stable machine-readable `code` and an operator-actionable message.
 *
 * Messages must never contain secret material: no key bytes, no key-file contents, no
 * plaintext or ciphertext of secret records. Key identifiers (fingerprints) are not secret
 * and may appear so that operators can match key files to databases and backups.
 */
export type StorageErrorCode =
  // Master key loading (fail closed, spec §8.2)
  | 'MASTER_KEY_NOT_CONFIGURED'
  | 'MASTER_KEY_CONFLICTING_SOURCES'
  | 'MASTER_KEY_UNREADABLE'
  | 'MASTER_KEY_INVALID'
  | 'MASTER_KEY_FILE_EXISTS'
  // Master key vs database state
  | 'MASTER_KEY_MISMATCH'
  | 'KEY_STATE_INCONSISTENT'
  // Schema and migrations
  | 'NOT_A_UNIFI_MCP_DATABASE'
  | 'MIGRATION_FAILED'
  | 'MIGRATION_HISTORY_MISMATCH'
  | 'SCHEMA_NEWER_THAN_SOFTWARE'
  // Integrity
  | 'DATABASE_CORRUPT'
  // Secret records
  | 'SECRET_NOT_FOUND'
  | 'SECRET_KIND_MISMATCH'
  | 'SECRET_DECRYPTION_FAILED'
  // Backup and restore
  | 'BACKUP_FAILED'
  | 'RESTORE_REJECTED'
  | 'DATABASE_IN_USE'
  // One service per data directory
  | 'DATA_DIRECTORY_IN_USE'
  // Translated SQLite runtime conditions
  | 'STORAGE_BUSY'
  | 'STORAGE_FULL'
  | 'STORAGE_READ_ONLY'
  | 'STORAGE_IO'
  | 'STORAGE_CONSTRAINT';

export class StorageError extends Error {
  override readonly name = 'StorageError';
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

export function isStorageError(error: unknown, code?: StorageErrorCode): error is StorageError {
  return error instanceof StorageError && (code === undefined || error.code === code);
}

/** Shape of errors thrown by `node:sqlite` (`code: 'ERR_SQLITE_ERROR'`, numeric `errcode`). */
interface SqliteNativeError extends Error {
  code: string;
  errcode: number;
}

function isSqliteNativeError(error: unknown): error is SqliteNativeError {
  return (
    error instanceof Error &&
    (error as Partial<SqliteNativeError>).code === 'ERR_SQLITE_ERROR' &&
    typeof (error as Partial<SqliteNativeError>).errcode === 'number'
  );
}

/** SQLite primary result codes (https://www.sqlite.org/rescode.html). */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_READONLY = 8;
const SQLITE_IOERR = 10;
const SQLITE_CORRUPT = 11;
const SQLITE_FULL = 13;
const SQLITE_CONSTRAINT = 19;
const SQLITE_NOTADB = 26;

/** Returns the primary SQLite result code of a `node:sqlite` error, if it is one. */
export function sqliteResultCode(error: unknown): number | undefined {
  // Extended result codes carry the primary code in the low byte.
  return isSqliteNativeError(error) ? error.errcode & 0xff : undefined;
}

/**
 * Maps operationally significant SQLite failures to `StorageError`s. Anything else is
 * returned unchanged so that programming errors keep their original stack and message.
 */
export function translateSqliteError(error: unknown): unknown {
  const code = sqliteResultCode(error);
  if (code === undefined || !(error instanceof Error)) return error;
  switch (code) {
    case SQLITE_BUSY:
    case SQLITE_LOCKED:
      return new StorageError(
        'STORAGE_BUSY',
        'The database is locked by another connection and the busy timeout expired.',
        { cause: error },
      );
    case SQLITE_FULL:
      return new StorageError(
        'STORAGE_FULL',
        'The database or its filesystem is full. Free space on the data volume; ' +
          'write and audit-critical operations are refused until then.',
        { cause: error },
      );
    case SQLITE_READONLY:
      return new StorageError('STORAGE_READ_ONLY', 'The database is read-only.', {
        cause: error,
      });
    case SQLITE_IOERR:
      return new StorageError('STORAGE_IO', 'A disk I/O error occurred on the data volume.', {
        cause: error,
      });
    case SQLITE_CORRUPT:
    case SQLITE_NOTADB:
      return new StorageError(
        'DATABASE_CORRUPT',
        'The database file is corrupt or is not a SQLite database. Restore it from a ' +
          'backup (see docs/backup-restore.md).',
        { cause: error },
      );
    case SQLITE_CONSTRAINT:
      return new StorageError('STORAGE_CONSTRAINT', error.message, { cause: error });
    default:
      return error;
  }
}
