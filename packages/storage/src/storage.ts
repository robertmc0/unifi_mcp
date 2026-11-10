/**
 * Startup sequence for the service's database (spec §8.2). Every step fails closed:
 *
 * 1. Open (create with mode 0600 in a 0700 directory if missing) with hardened settings.
 * 2. `PRAGMA quick_check`: never migrate or serve a damaged database.
 * 3. Check the migration history: refuse foreign, newer or altered schemas.
 * 4. Existing database: verify the master key **before any write**. A wrong key changes
 *    nothing.
 * 5. Pending migrations on an existing database: take a verified pre-migration backup
 *    first, then migrate atomically.
 * 6. New database: migrate, then register the configured key as the active key.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { backupDatabase, fileTimestamp, type BackupResult } from './backup.ts';
import { StorageError } from './errors.ts';
import { verifyOrRegisterMasterKey } from './keys.ts';
import type { MasterKey } from './master-key.ts';
import {
  migrate,
  MIGRATIONS,
  pendingMigrations,
  readSchemaState,
  type Migration,
  type MigrationResult,
} from './migrations.ts';
import { SecretStore } from './secrets.ts';
import { SqliteDatabase } from './sqlite.ts';

/** File name of the service database inside `UNIFI_MCP_DATA_DIR`. */
export const DATABASE_FILENAME = 'unifi-mcp.db';
/** Directory (inside the data directory) for automatic pre-migration backups. */
export const BACKUP_DIRECTORY_NAME = 'backups';

export function databasePathFor(dataDir: string): string {
  return join(resolve(dataDir), DATABASE_FILENAME);
}

export interface OpenStorageOptions {
  databasePath: string;
  masterKey: MasterKey;
  /** Default: `backups/` next to the database file. */
  backupDirectory?: string;
  /** Default: the released schema. Tests may pass synthetic lists. */
  migrations?: readonly Migration[];
  now?: () => Date;
}

export interface Storage {
  readonly db: SqliteDatabase;
  readonly secrets: SecretStore;
  readonly keyId: string;
  readonly schemaVersion: number;
  /** `registered` means this open initialised a new database with the configured key. */
  readonly keyRegistration: 'verified' | 'registered';
  readonly migration: MigrationResult;
  readonly preMigrationBackup: BackupResult | undefined;
  close(): void;
}

export async function openStorage(options: OpenStorageOptions): Promise<Storage> {
  const databasePath = resolve(options.databasePath);
  const migrations = options.migrations ?? MIGRATIONS;
  const now = options.now ?? (() => new Date());
  const key = options.masterKey;
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });

  const db = SqliteDatabase.open(databasePath);
  try {
    const check = db.integrityCheck('quick');
    if (!check.ok) {
      throw new StorageError(
        'DATABASE_CORRUPT',
        `The database ${databasePath} failed its integrity check ` +
          `(${check.problems.slice(0, 3).join('; ')}). Restore it from a backup ` +
          '(see docs/backup-restore.md).',
      );
    }
    const state = readSchemaState(db);
    const pending = pendingMigrations(state, migrations);

    let keyRegistration: 'verified' | 'registered' | undefined;
    let preMigrationBackup: BackupResult | undefined;
    if (state.version >= 1) {
      keyRegistration = verifyOrRegisterMasterKey(db, key, now);
      if (pending.length > 0) {
        const target = pending[pending.length - 1]?.version ?? state.version;
        const directory =
          options.backupDirectory ?? join(dirname(databasePath), BACKUP_DIRECTORY_NAME);
        preMigrationBackup = await backupDatabase(
          db,
          join(
            directory,
            `pre-migration-v${String(state.version)}-to-v${String(target)}-` +
              `${fileTimestamp(now())}.db`,
          ),
          { now },
        );
      }
    }
    const migration = migrate(db, migrations, now);
    keyRegistration ??= verifyOrRegisterMasterKey(db, key, now);

    return {
      db,
      secrets: new SecretStore(db, key, now),
      keyId: key.id,
      schemaVersion: migration.toVersion,
      keyRegistration,
      migration,
      preMigrationBackup,
      close: () => {
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
