/**
 * Online backup, backup verification and offline restore (spec §8.2, §17).
 *
 * A backup is a single self-contained SQLite file (rollback-journal mode, mode 0600) made
 * with the SQLite online backup API, so it is consistent even while the service writes.
 * It contains encrypted secret records and audit metadata, but never the master key:
 * restoring credentials needs the key that was active when the backup was taken.
 *
 * Restore is an offline operation. It validates a private staging copy (application id,
 * full integrity check, known migration history, matching master key, every secret record
 * decrypts), refuses if another process has the live database open, keeps the previous
 * database next to it, and then atomically renames the staging copy into place.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, open, rename, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isStorageError, StorageError } from './errors.ts';
import { readActiveKeyId } from './keys.ts';
import type { MasterKey } from './master-key.ts';
import {
  APPLICATION_ID,
  MIGRATIONS,
  pendingMigrations,
  readSchemaState,
  type Migration,
} from './migrations.ts';
import { SecretStore } from './secrets.ts';
import { SqliteDatabase } from './sqlite.ts';

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');
const SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

export interface BackupResult {
  path: string;
  bytes: number;
  sha256: string;
  pages: number;
  schemaVersion: number;
  /** Master key id needed to read the backup's secret records (undefined if none yet). */
  keyId: string | undefined;
  createdAt: string;
}

export interface BackupVerification {
  schemaVersion: number;
  keyId: string;
  secretRecords: number;
  /** Migrations the current software will apply when it opens the restored database. */
  pendingMigrations: number;
}

export interface RestoreResult extends BackupVerification {
  databasePath: string;
  /** Where the replaced database was moved, if one existed. */
  previousDatabasePath: string | undefined;
}

/** UTC timestamp usable in file names, for example 20261110T031500Z. */
export function fileTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Makes a rename durable. Some filesystems do not support fsync on directories. */
async function fsyncDirectory(path: string): Promise<void> {
  try {
    await fsyncFile(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EISDIR' && code !== 'EINVAL' && code !== 'EPERM') throw error;
  }
}

async function digestFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    hash.update(buffer);
  }
  return { bytes, sha256: hash.digest('hex') };
}

async function hasSqliteHeader(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead === header.length && header.equals(SQLITE_HEADER);
  } finally {
    await handle.close();
  }
}

/**
 * Writes a verified backup of the open database to `destinationPath`, which must not
 * exist. The backup is written to a temporary file, switched to a single-file journal
 * mode, integrity-checked, fsynced and then renamed into place.
 */
export async function backupDatabase(
  db: SqliteDatabase,
  destinationPath: string,
  options: { now?: () => Date } = {},
): Promise<BackupResult> {
  const destination = resolve(destinationPath);
  const now = options.now ?? (() => new Date());
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  try {
    // Reserve the name: a backup never overwrites an existing file.
    await (await open(destination, 'wx', 0o600)).close();
  } catch (error) {
    throw new StorageError(
      'BACKUP_FAILED',
      (error as NodeJS.ErrnoException).code === 'EEXIST'
        ? `The backup destination ${destination} already exists; choose a new file name.`
        : `Cannot create the backup file ${destination}.`,
      { cause: error },
    );
  }
  const staging = `${destination}.partial-${randomUUID()}`;
  let renamed = false;
  try {
    await (await open(staging, 'wx', 0o600)).close();
    const pages = await db.copyTo(staging);
    const copy = SqliteDatabase.open(staging, { journalMode: 'delete' });
    let schemaVersion: number;
    let keyId: string | undefined;
    try {
      const report = copy.integrityCheck('full');
      if (!report.ok) {
        throw new StorageError(
          'BACKUP_FAILED',
          'The backup copy failed its integrity check, so the source database is damaged: ' +
            report.problems.slice(0, 5).join('; '),
        );
      }
      schemaVersion = readSchemaState(copy).version;
      keyId = schemaVersion >= 1 ? readActiveKeyId(copy) : undefined;
    } finally {
      copy.close();
    }
    await fsyncFile(staging);
    await rename(staging, destination);
    renamed = true;
    await fsyncDirectory(dirname(destination));
    const { bytes, sha256 } = await digestFile(destination);
    return {
      path: destination,
      bytes,
      sha256,
      pages,
      schemaVersion,
      keyId,
      createdAt: now().toISOString(),
    };
  } catch (error) {
    await unlink(staging).catch(() => undefined);
    if (!renamed) await unlink(destination).catch(() => undefined);
    if (isStorageError(error, 'BACKUP_FAILED')) throw error;
    throw new StorageError('BACKUP_FAILED', `The backup to ${destination} failed.`, {
      cause: error,
    });
  }
}

function rejected(reason: string, cause?: unknown): StorageError {
  return new StorageError(
    'RESTORE_REJECTED',
    `The backup was rejected: ${reason}`,
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Validates a private, writable copy of a backup. Never call this on the operator's
 * original file: opening switches the copy's journal mode.
 */
function validateCopy(
  path: string,
  key: MasterKey,
  migrations: readonly Migration[],
): BackupVerification {
  let db: SqliteDatabase;
  try {
    db = SqliteDatabase.open(path, { journalMode: 'delete' });
  } catch (error) {
    throw rejected(error instanceof Error ? error.message : 'it cannot be opened.', error);
  }
  try {
    const report = db.integrityCheck('full');
    if (!report.ok) {
      throw rejected(`integrity check failed: ${report.problems.slice(0, 5).join('; ')}`);
    }
    const state = readSchemaState(db);
    if (state.applicationId !== APPLICATION_ID) {
      throw rejected('it is not a unifi-local-mcp database.');
    }
    if (state.version === 0) throw rejected('it contains no schema.');
    const pending = pendingMigrations(state, migrations);
    const keyId = readActiveKeyId(db);
    if (keyId === undefined) throw rejected('it has no active master key record.');
    if (keyId !== key.id) {
      throw rejected(
        `its secret records are encrypted with master key ${keyId}, but the configured key ` +
          `is ${key.id}. Provide the key file that was in use when the backup was taken.`,
      );
    }
    const secretRecords = new SecretStore(db, key).verifyAll();
    return {
      schemaVersion: state.version,
      keyId,
      secretRecords,
      pendingMigrations: pending.length,
    };
  } catch (error) {
    if (isStorageError(error, 'RESTORE_REJECTED')) throw error;
    if (error instanceof StorageError) throw rejected(error.message, error);
    throw error;
  } finally {
    db.close();
  }
}

/** Verifies a backup file without modifying it or restoring anything. */
export async function verifyBackup(
  backupPath: string,
  key: MasterKey,
  options: { migrations?: readonly Migration[] } = {},
): Promise<BackupVerification> {
  if (!(await hasSqliteHeader(backupPath))) throw rejected('it is not a SQLite database file.');
  const workDir = await mkdtemp(join(tmpdir(), 'unifi-mcp-verify-'));
  try {
    const copy = join(workDir, 'backup.db');
    await copyFile(backupPath, copy, constants.COPYFILE_EXCL);
    await chmod(copy, 0o600);
    return validateCopy(copy, key, options.migrations ?? MIGRATIONS);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Replaces the database at `databasePath` with a validated copy of `backupPath`. The
 * service must be stopped; if another process still has the database open, the restore
 * is refused with `DATABASE_IN_USE` and nothing changes. The replaced database is kept as
 * `<databasePath>.pre-restore-<timestamp>`.
 */
export async function restoreDatabase(options: {
  backupPath: string;
  databasePath: string;
  masterKey: MasterKey;
  migrations?: readonly Migration[];
  now?: () => Date;
}): Promise<RestoreResult> {
  const databasePath = resolve(options.databasePath);
  const now = options.now ?? (() => new Date());
  if (!(await hasSqliteHeader(options.backupPath))) {
    throw rejected('it is not a SQLite database file.');
  }
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  const staging = `${databasePath}.restore-${randomUUID()}`;
  let installed = false;
  try {
    await copyFile(options.backupPath, staging, constants.COPYFILE_EXCL);
    await chmod(staging, 0o600);
    const verification = validateCopy(staging, options.masterKey, options.migrations ?? MIGRATIONS);

    let previousDatabasePath: string | undefined;
    if (await exists(databasePath)) {
      try {
        // Leaving WAL mode needs exclusive access, so this fails while the service runs.
        // It also checkpoints the WAL into the main file.
        SqliteDatabase.open(databasePath, { journalMode: 'delete', busyTimeoutMs: 1000 }).close();
      } catch (error) {
        // A corrupt database (often the reason for restoring) is moved aside regardless.
        if (!isStorageError(error, 'DATABASE_CORRUPT')) throw error;
      }
      previousDatabasePath = `${databasePath}.pre-restore-${fileTimestamp(now())}`;
      await rename(databasePath, previousDatabasePath);
      for (const suffix of SIDECAR_SUFFIXES) {
        // A stale WAL must never be replayed onto the restored file.
        if (await exists(databasePath + suffix)) {
          await rename(databasePath + suffix, previousDatabasePath + suffix);
        }
      }
    }
    await fsyncFile(staging);
    await rename(staging, databasePath);
    installed = true;
    await fsyncDirectory(dirname(databasePath));
    return { ...verification, databasePath, previousDatabasePath };
  } finally {
    if (!installed) await unlink(staging).catch(() => undefined);
  }
}
