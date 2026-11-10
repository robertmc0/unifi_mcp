/**
 * Schema migrations: atomic application, history verification, and refusal of foreign,
 * newer or altered schemas (spec §8.2; Phase 1 gate "failed migration fails closed").
 */
import { join } from 'node:path';
import {
  APPLICATION_ID,
  columnInteger,
  columnText,
  migrate,
  MIGRATIONS,
  readSchemaState,
  SqliteDatabase,
  type Migration,
} from '@unifi-local-mcp/storage';
import { describe, expect, it } from 'vitest';
import { expectStorageError, fixedNow, useTempDirs } from './fixtures.ts';

const tempDir = useTempDirs();

const M1: Migration = { version: 1, name: 'one', sql: 'CREATE TABLE one (id INTEGER) STRICT;' };
const M2: Migration = { version: 2, name: 'two', sql: 'CREATE TABLE two (id INTEGER) STRICT;' };
const BROKEN_M3: Migration = {
  version: 3,
  name: 'three',
  sql: 'CREATE TABLE three (id INTEGER) STRICT; INSERT INTO no_such_table VALUES (1);',
};

async function emptyDatabase(): Promise<SqliteDatabase> {
  return SqliteDatabase.open(join(await tempDir(), 'test.db'));
}

function tableNames(db: SqliteDatabase): string[] {
  return db
    .all("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .map((row) => columnText(row, 'name'));
}

function userVersion(db: SqliteDatabase): number {
  return columnInteger(db.get('PRAGMA user_version') ?? {}, 'user_version');
}

describe('migrate', () => {
  it('initialises an empty database with the released schema', async () => {
    const db = await emptyDatabase();
    const result = migrate(db, MIGRATIONS, fixedNow);
    expect(result).toEqual({
      fromVersion: 0,
      toVersion: MIGRATIONS.length,
      applied: MIGRATIONS.map((m) => m.version),
    });
    const state = readSchemaState(db);
    expect(state.applicationId).toBe(APPLICATION_ID);
    expect(state.version).toBe(MIGRATIONS.length);
    expect(state.applied[0]).toMatchObject({
      version: 1,
      name: 'crypto_keys_and_secret_records',
      appliedAt: '2026-11-10T03:15:00.000Z',
    });
    expect(state.applied[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(userVersion(db)).toBe(MIGRATIONS.length);
    expect(tableNames(db)).toEqual([
      'admins',
      'approval_requests',
      'audit_entries',
      'client_tokens',
      'clients',
      'console_modules',
      'consoles',
      'crypto_keys',
      'operation_executions',
      'schema_migrations',
      'secret_records',
      'security_policy',
      'sqlite_sequence', // created by AUTOINCREMENT on audit_entries
    ]);
    db.close();
  });

  it('is idempotent', async () => {
    const db = await emptyDatabase();
    migrate(db);
    expect(migrate(db)).toEqual({
      fromVersion: MIGRATIONS.length,
      toVersion: MIGRATIONS.length,
      applied: [],
    });
    db.close();
  });

  it('applies only the pending migrations of an existing database', async () => {
    const db = await emptyDatabase();
    migrate(db, [M1]);
    expect(migrate(db, [M1, M2])).toEqual({ fromVersion: 1, toVersion: 2, applied: [2] });
    expect(tableNames(db)).toEqual(['one', 'schema_migrations', 'two']);
    db.close();
  });

  it('rolls back every pending migration when one fails, leaving a new database empty', async () => {
    const db = await emptyDatabase();
    expectStorageError(() => migrate(db, [M1, M2, BROKEN_M3]), 'MIGRATION_FAILED');
    expect(tableNames(db)).toEqual([]);
    expect(readSchemaState(db)).toMatchObject({ applicationId: 0, version: 0, objectCount: 0 });
    expect(userVersion(db)).toBe(0);
    db.close();
  });

  it('leaves an existing database at its version when an upgrade fails', async () => {
    const db = await emptyDatabase();
    migrate(db, [M1]);
    const error = expectStorageError(() => migrate(db, [M1, M2, BROKEN_M3]), 'MIGRATION_FAILED');
    expect(error.message).toMatch(/from version 1 to 3 failed and was rolled back/);
    expect(tableNames(db)).toEqual(['one', 'schema_migrations']);
    expect(readSchemaState(db).version).toBe(1);
    expect(userVersion(db)).toBe(1);
    db.close();
  });

  it('checks foreign keys before committing', async () => {
    const db = await emptyDatabase();
    const deferredViolation: Migration = {
      version: 1,
      name: 'deferred_violation',
      sql:
        'CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT;' +
        'CREATE TABLE child (pid INTEGER REFERENCES parent (id)) STRICT;' +
        'PRAGMA defer_foreign_keys = ON; INSERT INTO child VALUES (42);',
    };
    expectStorageError(() => migrate(db, [deferredViolation]), 'MIGRATION_FAILED');
    expect(tableNames(db)).toEqual([]);
    db.close();
  });

  it('refuses an applied migration whose content has changed', async () => {
    const db = await emptyDatabase();
    migrate(db, [M1]);
    const edited: Migration = { ...M1, sql: `${M1.sql}\n` };
    expectStorageError(() => migrate(db, [edited, M2]), 'MIGRATION_HISTORY_MISMATCH');
    expect(readSchemaState(db).version).toBe(1);
    db.close();
  });

  it('refuses a schema written by newer software', async () => {
    const db = await emptyDatabase();
    migrate(db, [M1, M2]);
    expectStorageError(() => migrate(db, [M1]), 'SCHEMA_NEWER_THAN_SOFTWARE');
    db.close();
  });

  it('refuses a database that belongs to another application', async () => {
    const db = await emptyDatabase();
    db.exec('CREATE TABLE foreign_data (x INTEGER) STRICT');
    expectStorageError(() => migrate(db), 'NOT_A_UNIFI_MCP_DATABASE');
    expect(tableNames(db)).toEqual(['foreign_data']);
    db.close();
  });

  it('rejects malformed migration lists as programming errors', async () => {
    const db = await emptyDatabase();
    expect(() => migrate(db, [M2])).toThrow(/numbered 1\.\.n without gaps/);
    expect(() => migrate(db, [{ ...M1, name: 'Bad Name' }])).toThrow(/invalid name/);
    db.close();
  });
});
