/**
 * The storage port over the built-in `node:sqlite` driver (ADR 0004).
 *
 * This is the only module in the repository that imports `node:sqlite`. Everything else
 * uses `SqliteDatabase`, which applies hardened connection settings, provides
 * transactions with savepoint nesting, integrity checks and online backup, and translates
 * operationally significant SQLite failures into `StorageError`s.
 */
import { openSync, closeSync } from 'node:fs';
import {
  backup as sqliteBackup,
  Database,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from 'node:sqlite';
import { StorageError, translateSqliteError } from './errors.ts';

// TYPE-DEFINITION GAP (ADR 0004 "Implementation notes"): `Database` is the current class
// name and `DatabaseSync` its deprecated alias in Node 26, but @types/node 26.6.6 declares
// only `DatabaseSync`. This augmentation names the same runtime export as `Database`.
// tests/contract/node-sqlite-runtime.test.ts checks the runtime side of that assumption.
//
// When it breaks:
// - `error TS2451: Cannot redeclare block-scoped variable 'Database'` on the two lines
//   below means @types/node now declares `Database` itself. Fix: delete this
//   `declare module` block (nothing else changes), run `npm run check`, and update the
//   ADR 0004 note.
// - An ESLint `@typescript-eslint/no-deprecated` error on `DatabaseSync` below means the
//   types now mark the alias deprecated; it is the same upgrade, so apply the same fix.
declare module 'node:sqlite' {
  const Database: typeof DatabaseSync;
  type Database = DatabaseSync;
}

export type SqlValue = null | number | bigint | string | Uint8Array;
export type SqlParams = readonly SqlValue[] | Readonly<Record<string, SqlValue>>;
export type Row = Readonly<Record<string, SQLOutputValue>>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface IntegrityReport {
  ok: boolean;
  /** Problems reported by SQLite, capped; empty when `ok`. Never contains row data. */
  problems: string[];
}

export interface OpenDatabaseOptions {
  /** Open without write access. No PRAGMA that writes is issued. Default false. */
  readOnly?: boolean;
  /**
   * `wal` (default) for the live database; `delete` for single-file artefacts such as
   * backups and restore staging copies. Switching out of WAL fails with `DATABASE_IN_USE`
   * while another connection has the file open.
   */
  journalMode?: 'wal' | 'delete';
  /** How long to wait for a lock held by another connection. Default 5000 ms. */
  busyTimeoutMs?: number;
}

const STATEMENT_CACHE_LIMIT = 256;
const DEFAULT_BUSY_TIMEOUT_MS = 5000;
/** Truncate the WAL file to this size after checkpoints instead of leaving it at its peak. */
const JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

function isPositional(params: SqlParams): params is readonly SqlValue[] {
  return Array.isArray(params);
}

function isThenable(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** Creates the file with owner-only permissions so SQLite's -wal/-shm files inherit 0600. */
function createPrivateFileIfMissing(path: string): void {
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

export class SqliteDatabase {
  readonly path: string;
  readonly readOnly: boolean;
  readonly #raw: Database;
  readonly #statements = new Map<string, StatementSync>();
  #savepointDepth = 0;

  private constructor(path: string, raw: Database, readOnly: boolean) {
    this.path = path;
    this.#raw = raw;
    this.readOnly = readOnly;
  }

  /**
   * Opens (and for read-write mode, creates with mode 0600) a database file and applies the
   * hardened connection settings:
   *
   * - `defensive`: refuses `writable_schema` and other ways to corrupt the file via SQL.
   * - `foreign_keys=ON`, `trusted_schema=OFF`, `secure_delete=ON` (deleted secret
   *   envelopes are overwritten), `temp_store=MEMORY` (no temp files with row data).
   * - `journal_mode=WAL` and `synchronous=FULL`: approval and execution state transitions
   *   must survive power loss, or a write could be repeated after restart (spec §10).
   */
  static open(path: string, options: OpenDatabaseOptions = {}): SqliteDatabase {
    const readOnly = options.readOnly ?? false;
    if (!readOnly && path !== ':memory:') createPrivateFileIfMissing(path);
    let raw: Database;
    try {
      raw = new Database(path, {
        readOnly,
        timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false,
        allowExtension: false,
        defensive: true,
      });
    } catch (error) {
      throw translateSqliteError(error);
    }
    const db = new SqliteDatabase(path, raw, readOnly);
    try {
      db.exec('PRAGMA trusted_schema = OFF');
      db.exec('PRAGMA secure_delete = ON');
      db.exec('PRAGMA temp_store = MEMORY');
      if (!readOnly) {
        const mode = options.journalMode ?? 'wal';
        db.#setJournalMode(mode);
        db.exec('PRAGMA synchronous = FULL');
        db.exec(`PRAGMA journal_size_limit = ${JOURNAL_SIZE_LIMIT_BYTES}`);
      }
    } catch (error) {
      db.close();
      throw error;
    }
    return db;
  }

  #setJournalMode(mode: 'wal' | 'delete'): void {
    let actual: unknown;
    try {
      actual = this.#raw.prepare(`PRAGMA journal_mode = ${mode.toUpperCase()}`).get()?.[
        'journal_mode'
      ];
    } catch (error) {
      const translated = translateSqliteError(error);
      if (translated instanceof StorageError && translated.code === 'STORAGE_BUSY') {
        throw new StorageError(
          'DATABASE_IN_USE',
          `The database ${this.path} is open in another process. Stop the service before ` +
            'running this command.',
          { cause: error },
        );
      }
      throw translated;
    }
    if (actual !== mode) {
      throw new StorageError(
        'STORAGE_IO',
        `Could not set journal_mode=${mode} (SQLite reported ${String(actual)}). The data ` +
          'directory must be on a local filesystem; network filesystems are not supported.',
      );
    }
  }

  get isOpen(): boolean {
    return this.#raw.isOpen;
  }

  get inTransaction(): boolean {
    return this.#transactionOpen();
  }

  /** A method, not a property read, so control-flow narrowing never caches the answer. */
  #transactionOpen(): boolean {
    return this.#raw.isTransaction;
  }

  close(): void {
    if (!this.#raw.isOpen) return;
    this.#statements.clear();
    this.#raw.close();
  }

  /** Executes one or more statements without parameters. Use only for trusted, static SQL. */
  exec(sql: string): void {
    try {
      this.#raw.exec(sql);
    } catch (error) {
      throw translateSqliteError(error);
    }
  }

  run(sql: string, params?: SqlParams): RunResult {
    const statement = this.#statement(sql);
    try {
      const result =
        params === undefined
          ? statement.run()
          : isPositional(params)
            ? statement.run(...(params as SQLInputValue[]))
            : statement.run(params);
      return {
        changes: Number(result.changes),
        lastInsertRowid: Number(result.lastInsertRowid),
      };
    } catch (error) {
      throw translateSqliteError(error);
    }
  }

  get(sql: string, params?: SqlParams): Row | undefined {
    const statement = this.#statement(sql);
    try {
      return params === undefined
        ? statement.get()
        : isPositional(params)
          ? statement.get(...(params as SQLInputValue[]))
          : statement.get(params);
    } catch (error) {
      throw translateSqliteError(error);
    }
  }

  all(sql: string, params?: SqlParams): Row[] {
    const statement = this.#statement(sql);
    try {
      return params === undefined
        ? statement.all()
        : isPositional(params)
          ? statement.all(...(params as SQLInputValue[]))
          : statement.all(params);
    } catch (error) {
      throw translateSqliteError(error);
    }
  }

  /**
   * Runs `fn` atomically. The outermost call uses `BEGIN IMMEDIATE`, so the write lock is
   * taken up front and the transaction cannot fail later with a lock upgrade conflict.
   * Nested calls use savepoints: an inner failure rolls back only the inner work if the
   * outer callback catches it. `fn` must be synchronous; a returned promise is rejected
   * and the transaction is rolled back.
   */
  transaction<T>(fn: () => T): T {
    if (this.#transactionOpen()) return this.#savepoint(fn);
    this.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      if (isThenable(result)) {
        throw new TypeError('SqliteDatabase.transaction callbacks must be synchronous.');
      }
      this.exec('COMMIT');
      return result;
    } catch (error) {
      // SQLite rolls back by itself after some errors (for example SQLITE_FULL).
      if (this.#transactionOpen()) this.#raw.exec('ROLLBACK');
      throw error;
    }
  }

  #savepoint<T>(fn: () => T): T {
    const name = `sp_${String(++this.#savepointDepth)}`;
    this.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      if (isThenable(result)) {
        throw new TypeError('SqliteDatabase.transaction callbacks must be synchronous.');
      }
      this.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      if (this.#transactionOpen()) this.#raw.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw error;
    } finally {
      this.#savepointDepth--;
    }
  }

  /**
   * Runs `PRAGMA integrity_check` (or `quick_check`) and `PRAGMA foreign_key_check`.
   * Corruption severe enough to make the check itself fail is reported as a problem.
   */
  integrityCheck(mode: 'full' | 'quick' = 'full', maxProblems = 100): IntegrityReport {
    const pragma = mode === 'full' ? 'integrity_check' : 'quick_check';
    try {
      const messages = this.all(`PRAGMA ${pragma}(${String(Math.trunc(maxProblems))})`).map((row) =>
        String(row[pragma]),
      );
      const problems = messages.length === 1 && messages[0] === 'ok' ? [] : messages;
      for (const violation of this.all('PRAGMA foreign_key_check').slice(0, maxProblems)) {
        problems.push(
          `foreign key violation: ${String(violation['table'])} row ` +
            `${String(violation['rowid'])} references missing ${String(violation['parent'])}`,
        );
      }
      return { ok: problems.length === 0, problems };
    } catch (error) {
      if (error instanceof StorageError && error.code === 'DATABASE_CORRUPT') {
        return { ok: false, problems: [error.message] };
      }
      throw error;
    }
  }

  /**
   * Online backup (SQLite backup API) of the open database into `path`, overwriting it.
   * Safe while other connections read and write. Returns the number of pages copied.
   * Use `backupDatabase()` for the complete, verified backup procedure.
   */
  async copyTo(path: string): Promise<number> {
    try {
      return await sqliteBackup(this.#raw, path);
    } catch (error) {
      throw translateSqliteError(error);
    }
  }

  #statement(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      try {
        statement = this.#raw.prepare(sql);
      } catch (error) {
        throw translateSqliteError(error);
      }
      if (this.#statements.size >= STATEMENT_CACHE_LIMIT) this.#statements.clear();
      this.#statements.set(sql, statement);
    }
    return statement;
  }
}

// Typed column accessors. They fail loudly if the schema and the code disagree.

function column(row: Row, name: string): SQLOutputValue {
  if (!(name in row)) throw new TypeError(`Result row has no column "${name}".`);
  return row[name] as SQLOutputValue;
}

export function columnText(row: Row, name: string): string {
  const value = column(row, name);
  if (typeof value !== 'string') throw new TypeError(`Column "${name}" is not TEXT.`);
  return value;
}

export function columnOptionalText(row: Row, name: string): string | null {
  const value = column(row, name);
  if (value !== null && typeof value !== 'string') {
    throw new TypeError(`Column "${name}" is not TEXT or NULL.`);
  }
  return value;
}

export function columnInteger(row: Row, name: string): number {
  const value = column(row, name);
  const result = typeof value === 'bigint' ? Number(value) : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result)) {
    throw new TypeError(`Column "${name}" is not a safe INTEGER.`);
  }
  return result;
}

export function columnBlob(row: Row, name: string): Uint8Array {
  const value = column(row, name);
  if (!(value instanceof Uint8Array)) throw new TypeError(`Column "${name}" is not a BLOB.`);
  return value;
}
