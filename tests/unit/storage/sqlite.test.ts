/**
 * The node:sqlite storage port (ADR 0004): hardened connection settings, file
 * permissions, transactions, lock handling, storage exhaustion and integrity checks.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { columnInteger, columnText, SqliteDatabase } from '@unifi-local-mcp/storage';
import { describe, expect, it } from 'vitest';
import {
  corruptMiddlePage,
  expectStorageError,
  fileMode,
  useTempDirs,
  writeTextFile,
} from './fixtures.ts';

const tempDir = useTempDirs();

function pragma(db: SqliteDatabase, name: string): unknown {
  return db.get(`PRAGMA ${name}`)?.[name];
}

function values(db: SqliteDatabase): number[] {
  return db.all('SELECT v FROM t ORDER BY v').map((row) => columnInteger(row, 'v'));
}

async function openWithTable(): Promise<{ db: SqliteDatabase; path: string }> {
  const path = join(await tempDir(), 'test.db');
  const db = SqliteDatabase.open(path);
  db.exec('CREATE TABLE t (v INTEGER NOT NULL) STRICT');
  return { db, path };
}

describe('SqliteDatabase.open', () => {
  it('creates the database and its WAL files with owner-only permissions', async () => {
    const dir = await tempDir();
    const db = SqliteDatabase.open(join(dir, 'test.db'));
    db.exec('CREATE TABLE t (v INTEGER) STRICT; INSERT INTO t VALUES (1);');
    const files = await readdir(dir);
    expect(files.sort()).toEqual(['test.db', 'test.db-shm', 'test.db-wal']);
    for (const file of files) expect(await fileMode(join(dir, file))).toBe(0o600);
    db.close();
  });

  it('applies the hardened connection settings', async () => {
    const { db } = await openWithTable();
    expect(pragma(db, 'journal_mode')).toBe('wal');
    expect(pragma(db, 'synchronous')).toBe(2); // FULL
    expect(pragma(db, 'foreign_keys')).toBe(1);
    expect(pragma(db, 'trusted_schema')).toBe(0);
    expect(pragma(db, 'secure_delete')).toBe(1);
    expect(pragma(db, 'temp_store')).toBe(2); // MEMORY
    expect(db.get('PRAGMA busy_timeout')?.['timeout']).toBe(5000);
    db.close();
  });

  it('refuses to modify the schema table directly (defensive mode)', async () => {
    const { db } = await openWithTable();
    expect(() => {
      db.exec('PRAGMA writable_schema = ON; UPDATE sqlite_schema SET sql = sql;');
    }).toThrow(/may not be modified/);
    db.close();
  });

  it('rejects a file that is not a SQLite database', async () => {
    const path = join(await tempDir(), 'junk.db');
    await writeTextFile(path, 'x'.repeat(8192));
    expectStorageError(() => SqliteDatabase.open(path), 'DATABASE_CORRUPT');
  });

  it('opens read-only without allowing writes', async () => {
    const { db, path } = await openWithTable();
    db.run('INSERT INTO t VALUES (1)');
    db.close();
    const reader = SqliteDatabase.open(path, { readOnly: true });
    expect(values(reader)).toEqual([1]);
    expectStorageError(() => reader.run('INSERT INTO t VALUES (2)'), 'STORAGE_READ_ONLY');
    reader.close();
  });
});

describe('SqliteDatabase.transaction', () => {
  it('commits the callback result', async () => {
    const { db } = await openWithTable();
    const result = db.transaction(() => db.run('INSERT INTO t VALUES (1)').changes);
    expect(result).toBe(1);
    expect(values(db)).toEqual([1]);
    expect(db.inTransaction).toBe(false);
    db.close();
  });

  it('rolls back when the callback throws', async () => {
    const { db } = await openWithTable();
    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO t VALUES (1)');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(values(db)).toEqual([]);
    expect(db.inTransaction).toBe(false);
    db.close();
  });

  it('nests with savepoints, so a caught inner failure keeps the outer work', async () => {
    const { db } = await openWithTable();
    db.transaction(() => {
      db.run('INSERT INTO t VALUES (1)');
      try {
        db.transaction(() => {
          db.run('INSERT INTO t VALUES (2)');
          throw new Error('inner');
        });
      } catch {
        // expected: only the inner insert is undone
      }
      db.run('INSERT INTO t VALUES (3)');
    });
    expect(values(db)).toEqual([1, 3]);
    db.close();
  });

  it('rejects asynchronous callbacks and rolls back their synchronous part', async () => {
    const { db } = await openWithTable();
    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO t VALUES (1)');
        return Promise.resolve(1);
      }),
    ).toThrow(TypeError);
    expect(values(db)).toEqual([]);
    db.close();
  });

  it('reports STORAGE_BUSY when another connection holds the write lock', async () => {
    const { db, path } = await openWithTable();
    const other = SqliteDatabase.open(path, { busyTimeoutMs: 50 });
    db.exec('BEGIN IMMEDIATE');
    expectStorageError(() => other.transaction(() => 1), 'STORAGE_BUSY');
    db.exec('ROLLBACK');
    expect(other.transaction(() => 1)).toBe(1);
    other.close();
    db.close();
  });

  it('fails safely with STORAGE_FULL when the database cannot grow', async () => {
    const { db } = await openWithTable();
    db.exec('CREATE TABLE big (b BLOB NOT NULL) STRICT');
    const pages = columnInteger(db.get('PRAGMA page_count') ?? {}, 'page_count');
    db.exec(`PRAGMA max_page_count = ${String(pages)}`);
    expectStorageError(() => {
      db.transaction(() => {
        db.run('INSERT INTO t VALUES (1)');
        db.run('INSERT INTO big VALUES (?)', [new Uint8Array(64 * 1024)]);
      });
    }, 'STORAGE_FULL');
    expect(db.inTransaction).toBe(false);
    expect(values(db)).toEqual([]);
    db.close();
  });
});

describe('integrity checks', () => {
  it('passes on a healthy database in both modes', async () => {
    const { db } = await openWithTable();
    db.run('INSERT INTO t VALUES (1)');
    expect(db.integrityCheck('full')).toEqual({ ok: true, problems: [] });
    expect(db.integrityCheck('quick')).toEqual({ ok: true, problems: [] });
    db.close();
  });

  it('reports a damaged file instead of throwing', async () => {
    const { db, path } = await openWithTable();
    db.exec('CREATE TABLE filler (b BLOB NOT NULL) STRICT; CREATE INDEX filler_b ON filler (b);');
    db.transaction(() => {
      for (let i = 0; i < 400; i++) {
        db.run('INSERT INTO filler VALUES (randomblob(200))');
      }
    });
    db.close();
    await corruptMiddlePage(path);
    const reopened = SqliteDatabase.open(path);
    const report = reopened.integrityCheck('full');
    expect(report.ok).toBe(false);
    expect(report.problems.length).toBeGreaterThan(0);
    reopened.close();
  });

  it('reports foreign key violations', async () => {
    const { db } = await openWithTable();
    db.exec(
      'CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT;' +
        'CREATE TABLE child (pid INTEGER REFERENCES parent (id)) STRICT;' +
        'PRAGMA foreign_keys = OFF; INSERT INTO child VALUES (7); PRAGMA foreign_keys = ON;',
    );
    const report = db.integrityCheck('quick');
    expect(report.ok).toBe(false);
    expect(report.problems[0]).toMatch(/foreign key violation: child/);
    db.close();
  });
});

describe('typed column accessors', () => {
  it('fail loudly when the schema and the code disagree', async () => {
    const { db } = await openWithTable();
    db.run('INSERT INTO t VALUES (1)');
    const row = db.get('SELECT v FROM t') ?? {};
    expect(columnInteger(row, 'v')).toBe(1);
    expect(() => columnText(row, 'v')).toThrow(TypeError);
    expect(() => columnInteger(row, 'missing')).toThrow(/no column "missing"/);
    db.close();
  });
});
