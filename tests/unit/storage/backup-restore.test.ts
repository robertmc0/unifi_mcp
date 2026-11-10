/**
 * Online backup, backup verification, validated restore and automatic pre-migration
 * backups (spec §8.2, §17 "backup/restore are tested").
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  backupDatabase,
  databasePathFor,
  MIGRATIONS,
  openStorage,
  restoreDatabase,
  SqliteDatabase,
  verifyBackup,
  type Migration,
  type Storage,
} from '@unifi-local-mcp/storage';
import { describe, expect, it } from 'vitest';
import {
  corruptMiddlePage,
  expectStorageError,
  expectStorageErrorAsync,
  fileMode,
  fixedNow,
  sha256File,
  tamperEnvelope,
  testKey,
  useTempDirs,
} from './fixtures.ts';

const tempDir = useTempDirs();
const keyA = testKey('backup-a');
const keyB = testKey('backup-b');
const KIND = 'console.api_key';
const EXTRA_MIGRATION: Migration = {
  version: MIGRATIONS.length + 1,
  name: 'synthetic_extra_table',
  sql: 'CREATE TABLE synthetic_extra (id INTEGER PRIMARY KEY) STRICT;',
};

interface Setup {
  dir: string;
  databasePath: string;
  storage: Storage;
}

async function setup(migrations: readonly Migration[] = MIGRATIONS): Promise<Setup> {
  const dir = await tempDir();
  const databasePath = databasePathFor(join(dir, 'data'));
  const storage = await openStorage({ databasePath, masterKey: keyA, migrations, now: fixedNow });
  return { dir, databasePath, storage };
}

describe('backupDatabase', () => {
  it('writes a verified single-file backup with owner-only permissions', async () => {
    const { dir, storage } = await setup();
    storage.secrets.create(KIND, 'synthetic');
    const path = join(dir, 'backups', 'one.db');
    const result = await backupDatabase(storage.db, path, { now: fixedNow });
    expect(result).toMatchObject({
      path,
      schemaVersion: MIGRATIONS.length,
      keyId: keyA.id,
      createdAt: '2026-11-10T03:15:00.000Z',
    });
    expect(result.sha256).toBe(await sha256File(path));
    expect(await fileMode(path)).toBe(0o600);
    expect(await readdir(join(dir, 'backups'))).toEqual(['one.db']);
    const copy = SqliteDatabase.open(path, { readOnly: true });
    expect(copy.get('PRAGMA journal_mode')?.['journal_mode']).toBe('delete');
    copy.close();
    storage.close();
  });

  it('includes committed changes that are still in the WAL', async () => {
    const { dir, storage } = await setup();
    storage.secrets.create(KIND, 'synthetic-in-wal');
    const path = join(dir, 'wal.db');
    await backupDatabase(storage.db, path);
    expect((await verifyBackup(path, keyA)).secretRecords).toBe(1);
    storage.close();
  });

  it('never overwrites an existing file', async () => {
    const { dir, storage } = await setup();
    const path = join(dir, 'existing.db');
    await writeFile(path, 'keep me');
    await expectStorageErrorAsync(backupDatabase(storage.db, path), 'BACKUP_FAILED');
    expect(await readFile(path, 'utf8')).toBe('keep me');
    expect((await readdir(dir)).filter((name) => name.includes('.partial-'))).toEqual([]);
    storage.close();
  });
});

describe('verifyBackup', () => {
  it('reports what a restore would bring back, without modifying the file', async () => {
    const { dir, storage } = await setup();
    storage.secrets.create(KIND, 'one');
    storage.secrets.create(KIND, 'two');
    const path = join(dir, 'b.db');
    await backupDatabase(storage.db, path);
    const digest = await sha256File(path);
    expect(await verifyBackup(path, keyA)).toEqual({
      schemaVersion: MIGRATIONS.length,
      keyId: keyA.id,
      secretRecords: 2,
      pendingMigrations: 0,
    });
    expect(await sha256File(path)).toBe(digest);
    storage.close();
  });

  it('names the required key when the configured key does not match', async () => {
    const { dir, storage } = await setup();
    const path = join(dir, 'b.db');
    await backupDatabase(storage.db, path);
    const error = await expectStorageErrorAsync(verifyBackup(path, keyB), 'RESTORE_REJECTED');
    expect(error.message).toContain(`encrypted with master key ${keyA.id}`);
    expect(error.message).toContain(`configured key is ${keyB.id}`);
    storage.close();
  });
});

describe('restoreDatabase', () => {
  async function scenario(): Promise<Setup & { backupPath: string; secretId: string }> {
    const ctx = await setup();
    const secretId = ctx.storage.secrets.create(KIND, 'value-at-backup');
    const backupPath = join(ctx.dir, 'restore-me.db');
    await backupDatabase(ctx.storage.db, backupPath);
    ctx.storage.secrets.replace(secretId, KIND, 'value-after-backup');
    ctx.storage.secrets.create(KIND, 'created-after-backup');
    return { ...ctx, backupPath, secretId };
  }

  it('restores over a stopped database and keeps the previous one', async () => {
    const { databasePath, storage, backupPath, secretId } = await scenario();
    storage.close();
    const result = await restoreDatabase({
      backupPath,
      databasePath,
      masterKey: keyA,
      now: fixedNow,
    });
    expect(result).toMatchObject({
      databasePath,
      previousDatabasePath: `${databasePath}.pre-restore-20261110T031500Z`,
      schemaVersion: MIGRATIONS.length,
      secretRecords: 1,
    });
    expect(await fileMode(databasePath)).toBe(0o600);
    const restored = await openStorage({ databasePath, masterKey: keyA });
    expect(restored.secrets.read(secretId, KIND).reveal()).toBe('value-at-backup');
    expect(restored.secrets.verifyAll()).toBe(1);
    restored.close();
    const previous = await openStorage({
      databasePath: result.previousDatabasePath ?? '',
      masterKey: keyA,
    });
    expect(previous.secrets.read(secretId, KIND).reveal()).toBe('value-after-backup');
    previous.close();
  });

  it('refuses while the database is in use and changes nothing', async () => {
    const { dir, databasePath, storage, backupPath, secretId } = await scenario();
    await expectStorageErrorAsync(
      restoreDatabase({ backupPath, databasePath, masterKey: keyA }),
      'DATABASE_IN_USE',
    );
    expect(storage.secrets.read(secretId, KIND).reveal()).toBe('value-after-backup');
    const leftovers = (await readdir(join(dir, 'data'))).filter(
      (name) => name.includes('.restore-') || name.includes('.pre-restore-'),
    );
    expect(leftovers).toEqual([]);
    storage.close();
  });

  it('rejects a backup that needs a different master key', async () => {
    const { databasePath, storage, backupPath } = await scenario();
    storage.close();
    const digest = await sha256File(databasePath);
    await expectStorageErrorAsync(
      restoreDatabase({ backupPath, databasePath, masterKey: keyB }),
      'RESTORE_REJECTED',
    );
    expect(await sha256File(databasePath)).toBe(digest);
  });

  it('rejects files that are not unifi-local-mcp backups', async () => {
    const { dir, databasePath, storage } = await setup();
    storage.close();
    const junk = join(dir, 'junk.db');
    await writeFile(junk, 'not a database at all, just text'.repeat(200));
    const junkError = await expectStorageErrorAsync(
      restoreDatabase({ backupPath: junk, databasePath, masterKey: keyA }),
      'RESTORE_REJECTED',
    );
    expect(junkError.message).toMatch(/not a SQLite database file/);

    const foreign = join(dir, 'foreign.db');
    const other = SqliteDatabase.open(foreign, { journalMode: 'delete' });
    other.exec('CREATE TABLE notes (body TEXT) STRICT');
    other.close();
    const foreignError = await expectStorageErrorAsync(
      restoreDatabase({ backupPath: foreign, databasePath, masterKey: keyA }),
      'RESTORE_REJECTED',
    );
    expect(foreignError.message).toMatch(/not a unifi-local-mcp database/);
  });

  it('rejects a backup containing a tampered secret record', async () => {
    const { databasePath, storage, backupPath, secretId } = await scenario();
    storage.close();
    const copy = SqliteDatabase.open(backupPath, { journalMode: 'delete' });
    tamperEnvelope(copy, secretId);
    copy.close();
    const error = await expectStorageErrorAsync(
      restoreDatabase({ backupPath, databasePath, masterKey: keyA }),
      'RESTORE_REJECTED',
    );
    expect(error.message).toMatch(/could not be decrypted/);
  });

  it('rejects a damaged backup', async () => {
    const { dir, databasePath, storage } = await setup();
    storage.db.transaction(() => {
      for (let i = 0; i < 300; i++) storage.secrets.create(KIND, `synthetic-${String(i)}`);
    });
    const backupPath = join(dir, 'damaged.db');
    await backupDatabase(storage.db, backupPath);
    storage.close();
    await corruptMiddlePage(backupPath);
    await expectStorageErrorAsync(
      restoreDatabase({ backupPath, databasePath, masterKey: keyA }),
      'RESTORE_REJECTED',
    );
  });

  it('rejects a backup written by newer software', async () => {
    const newer = await setup([...MIGRATIONS, EXTRA_MIGRATION]);
    const backupPath = join(newer.dir, 'newer.db');
    await backupDatabase(newer.storage.db, backupPath);
    newer.storage.close();
    const { databasePath, storage } = await setup();
    storage.close();
    const error = await expectStorageErrorAsync(
      restoreDatabase({ backupPath, databasePath, masterKey: keyA }),
      'RESTORE_REJECTED',
    );
    expect(error.message).toMatch(/written by a newer release/);
  });

  it('restores into an empty data directory (disaster recovery)', async () => {
    const { dir, storage, backupPath, secretId } = await scenario();
    storage.close();
    const databasePath = databasePathFor(join(dir, 'new-host'));
    const result = await restoreDatabase({ backupPath, databasePath, masterKey: keyA });
    expect(result.previousDatabasePath).toBeUndefined();
    const restored = await openStorage({ databasePath, masterKey: keyA });
    expect(restored.secrets.read(secretId, KIND).reveal()).toBe('value-at-backup');
    restored.close();
  });
});

describe('openStorage pre-migration backups', () => {
  it('takes a verified backup before migrating an existing database', async () => {
    const { dir, databasePath, storage } = await setup();
    storage.secrets.create(KIND, 'synthetic');
    storage.close();
    const upgraded = await openStorage({
      databasePath,
      masterKey: keyA,
      migrations: [...MIGRATIONS, EXTRA_MIGRATION],
      now: fixedNow,
    });
    expect(upgraded.migration.applied).toEqual([EXTRA_MIGRATION.version]);
    const backup = upgraded.preMigrationBackup;
    expect(backup?.path).toBe(
      join(
        dir,
        'data',
        'backups',
        `pre-migration-v${String(MIGRATIONS.length)}-to-v${String(EXTRA_MIGRATION.version)}-20261110T031500Z.db`,
      ),
    );
    expect((await verifyBackup(backup?.path ?? '', keyA)).schemaVersion).toBe(MIGRATIONS.length);
    upgraded.close();
  });

  it('does not back up a new database or an up-to-date one', async () => {
    const { dir, databasePath, storage } = await setup();
    expect(storage.preMigrationBackup).toBeUndefined();
    storage.close();
    const again = await openStorage({ databasePath, masterKey: keyA });
    expect(again.preMigrationBackup).toBeUndefined();
    again.close();
    expect(await readdir(join(dir, 'data'))).not.toContain('backups');
  });

  it('refuses to start on a damaged database', async () => {
    const { databasePath, storage } = await setup();
    storage.db.transaction(() => {
      for (let i = 0; i < 300; i++) storage.secrets.create(KIND, `synthetic-${String(i)}`);
    });
    storage.close();
    await corruptMiddlePage(databasePath);
    await expectStorageErrorAsync(
      openStorage({ databasePath, masterKey: keyA }),
      'DATABASE_CORRUPT',
    );
  });
});

describe('SqliteDatabase journal mode switch', () => {
  it('reports DATABASE_IN_USE instead of a generic lock error', async () => {
    const { databasePath, storage } = await setup();
    expectStorageError(
      () => SqliteDatabase.open(databasePath, { journalMode: 'delete', busyTimeoutMs: 50 }),
      'DATABASE_IN_USE',
    );
    storage.close();
  });
});
