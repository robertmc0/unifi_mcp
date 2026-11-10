/**
 * Schema migrations (spec §8.2, ADR 0007).
 *
 * Rules:
 * - Migrations are forward-only, numbered 1..n without gaps, and never edited once
 *   released. Each applied migration's SHA-256 is recorded, and a mismatch fails closed.
 * - All pending migrations run in **one** `BEGIN IMMEDIATE` transaction together with their
 *   `schema_migrations` rows, `PRAGMA user_version` and `PRAGMA foreign_key_check`. A failure
 *   leaves the database exactly as it was.
 * - A database whose history contains versions this software does not know (a newer
 *   release) is refused rather than guessed at.
 * - `crypto_keys(key_id, status)` and `secret_records(id, kind, key_id, envelope)` must stay
 *   readable with the queries in keys.ts at every schema version, because the master key is
 *   verified *before* pending migrations run.
 */
import { createHash } from 'node:crypto';
import { StorageError } from './errors.ts';
import { columnInteger, columnText, type SqliteDatabase } from './sqlite.ts';

export interface Migration {
  version: number;
  /** snake_case description, part of the recorded history. */
  name: string;
  /** Static SQL. Never interpolate values into migrations. */
  sql: string;
}

/** `PRAGMA application_id` marking a file as a unifi-local-mcp database ("UMCP"). */
export const APPLICATION_ID = 0x554d4350;

/** The schema, in order. Append only. */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'crypto_keys_and_secret_records',
    sql: `
CREATE TABLE crypto_keys (
  key_id TEXT PRIMARY KEY CHECK (length(key_id) = 32 AND key_id NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  created_at TEXT NOT NULL,
  retired_at TEXT,
  CHECK ((status = 'retired') = (retired_at IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX crypto_keys_single_active ON crypto_keys (status) WHERE status = 'active';

CREATE TABLE secret_records (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
  key_id TEXT NOT NULL REFERENCES crypto_keys (key_id),
  envelope BLOB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX secret_records_key_id ON secret_records (key_id);
`,
  },
  {
    // Audit trail (spec §12, ADR 0008). Queries live in @unifi-local-mcp/telemetry.
    version: 2,
    name: 'audit_entries',
    sql: `
CREATE TABLE audit_entries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE CHECK (length(id) = 36),
  occurred_at TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 64),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 128),
  outcome TEXT NOT NULL
    CHECK (outcome IN ('success', 'denied', 'failure', 'pending', 'outcome_unknown')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('mcp_client', 'admin', 'cli', 'system')),
  actor_id TEXT CHECK (actor_id IS NULL OR length(actor_id) BETWEEN 1 AND 128),
  correlation_id TEXT CHECK (correlation_id IS NULL OR length(correlation_id) BETWEEN 1 AND 128),
  console_id TEXT CHECK (console_id IS NULL OR length(console_id) BETWEEN 1 AND 128),
  application TEXT CHECK (application IS NULL OR length(application) BETWEEN 1 AND 64),
  operation_id TEXT CHECK (operation_id IS NULL OR length(operation_id) BETWEEN 1 AND 128),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 128),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  details TEXT NOT NULL CHECK (json_valid(details) AND length(details) <= 16384),
  prev_hash TEXT NOT NULL CHECK (length(prev_hash) = 64),
  entry_hash TEXT NOT NULL UNIQUE CHECK (length(entry_hash) = 64)
) STRICT;

CREATE INDEX audit_entries_occurred_at ON audit_entries (occurred_at);
CREATE INDEX audit_entries_actor ON audit_entries (actor_type, actor_id, seq);

CREATE TRIGGER audit_entries_immutable BEFORE UPDATE ON audit_entries
BEGIN
  SELECT RAISE(ABORT, 'audit entries are immutable');
END;
`,
  },
];

const HISTORY_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version >= 1),
  name TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  applied_at TEXT NOT NULL
) STRICT`;

const MIGRATION_NAME_PATTERN = /^[a-z0-9_]{1,64}$/;

export function migrationChecksum(migration: Migration): string {
  return createHash('sha256').update(migration.sql, 'utf8').digest('hex');
}

/** Validates a migration list. Violations are programming errors, not runtime conditions. */
export function assertValidMigrationList(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `Migration list must be numbered 1..n without gaps; position ${String(index + 1)} ` +
          `has version ${String(migration.version)}.`,
      );
    }
    if (!MIGRATION_NAME_PATTERN.test(migration.name)) {
      throw new Error(`Migration ${String(migration.version)} has an invalid name.`);
    }
  });
}

export interface AppliedMigration {
  version: number;
  name: string;
  sha256: string;
  appliedAt: string;
}

export interface SchemaState {
  /** `PRAGMA application_id`; 0 for a database not yet initialised. */
  applicationId: number;
  /** Number of tables, views, indexes and triggers outside the SQLite internals. */
  objectCount: number;
  applied: AppliedMigration[];
  /** Highest applied version; 0 for an empty database. */
  version: number;
}

export function readSchemaState(db: SqliteDatabase): SchemaState {
  const applicationIdRow = db.get('PRAGMA application_id');
  const applicationId =
    applicationIdRow === undefined ? 0 : columnInteger(applicationIdRow, 'application_id');
  const objects = db.get("SELECT count(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'");
  const objectCount = objects === undefined ? 0 : columnInteger(objects, 'n');
  const hasHistory =
    db.get("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?", [
      'schema_migrations',
    ]) !== undefined;
  const applied = hasHistory
    ? db
        .all('SELECT version, name, sha256, applied_at FROM schema_migrations ORDER BY version')
        .map((row) => ({
          version: columnInteger(row, 'version'),
          name: columnText(row, 'name'),
          sha256: columnText(row, 'sha256'),
          appliedAt: columnText(row, 'applied_at'),
        }))
    : [];
  return {
    applicationId,
    objectCount,
    applied,
    version: applied.length === 0 ? 0 : (applied[applied.length - 1]?.version ?? 0),
  };
}

/**
 * Checks that `state` is a unifi-local-mcp database whose history is a prefix of
 * `migrations`. Throws `NOT_A_UNIFI_MCP_DATABASE`, `SCHEMA_NEWER_THAN_SOFTWARE` or
 * `MIGRATION_HISTORY_MISMATCH`. Returns the migrations still to apply.
 */
export function pendingMigrations(
  state: SchemaState,
  migrations: readonly Migration[],
): readonly Migration[] {
  assertValidMigrationList(migrations);
  const isEmpty = state.objectCount === 0 && state.applicationId === 0;
  if (!isEmpty && state.applicationId !== APPLICATION_ID) {
    throw new StorageError(
      'NOT_A_UNIFI_MCP_DATABASE',
      'The database file belongs to another application (its SQLite application_id is ' +
        `${String(state.applicationId)}). Point UNIFI_MCP_DATA_DIR at an empty directory or ` +
        'at an existing unifi-local-mcp data directory.',
    );
  }
  const latest = migrations.length;
  if (state.version > latest) {
    throw new StorageError(
      'SCHEMA_NEWER_THAN_SOFTWARE',
      `The database schema is version ${String(state.version)}, but this software only knows ` +
        `versions up to ${String(latest)}. It was written by a newer release. Upgrade the ` +
        'software or restore a backup taken with this release; downgrades are not supported.',
    );
  }
  state.applied.forEach((applied, index) => {
    const expected = migrations[index];
    if (
      expected === undefined ||
      applied.version !== expected.version ||
      applied.sha256 !== migrationChecksum(expected)
    ) {
      throw new StorageError(
        'MIGRATION_HISTORY_MISMATCH',
        `Applied migration ${String(applied.version)} (${applied.name}) does not match this ` +
          'software. Released migrations must never change; the database or the build has ' +
          'been altered. Restore a backup or use the matching release.',
      );
    }
  });
  return migrations.slice(state.version);
}

export interface MigrationResult {
  fromVersion: number;
  toVersion: number;
  applied: number[];
}

/** Applies all pending migrations atomically. See the module comment for the rules. */
export function migrate(
  db: SqliteDatabase,
  migrations: readonly Migration[] = MIGRATIONS,
  now: () => Date = () => new Date(),
): MigrationResult {
  const before = readSchemaState(db);
  const pending = pendingMigrations(before, migrations);
  if (pending.length === 0) {
    return { fromVersion: before.version, toVersion: before.version, applied: [] };
  }
  const toVersion = pending[pending.length - 1]?.version ?? before.version;
  let result: MigrationResult;
  try {
    result = db.transaction(() => {
      // Re-read inside the write lock: another process may have migrated meanwhile.
      const current = readSchemaState(db);
      const stillPending = pendingMigrations(current, migrations);
      if (stillPending.length === 0) {
        return { fromVersion: current.version, toVersion: current.version, applied: [] };
      }
      if (current.version === 0) {
        db.exec(`PRAGMA application_id = ${String(APPLICATION_ID)}`);
      }
      db.exec(HISTORY_TABLE_SQL);
      const appliedAt = now().toISOString();
      for (const migration of stillPending) {
        db.exec(migration.sql);
        db.run(
          'INSERT INTO schema_migrations (version, name, sha256, applied_at) VALUES (?, ?, ?, ?)',
          [migration.version, migration.name, migrationChecksum(migration), appliedAt],
        );
      }
      db.exec(`PRAGMA user_version = ${String(toVersion)}`);
      const violations = db.all('PRAGMA foreign_key_check');
      if (violations.length > 0) {
        throw new Error(`${String(violations.length)} foreign key violation(s) after migration.`);
      }
      return {
        fromVersion: current.version,
        toVersion,
        applied: stillPending.map((migration) => migration.version),
      };
    });
  } catch (error) {
    if (error instanceof StorageError && error.code !== 'STORAGE_CONSTRAINT') throw error;
    throw new StorageError(
      'MIGRATION_FAILED',
      `Migrating the database from version ${String(before.version)} to ` +
        `${String(toVersion)} failed and was rolled back; the database is unchanged. The ` +
        'service will not start until this is resolved.',
      { cause: error },
    );
  }
  return result;
}
