/**
 * Administrator accounts (spec §7.2, §2 decision 24; ADR 0015).
 *
 * - There is no default administrator. The first one is created by `unifi-mcp admin
 *   bootstrap` on the host, which refuses if any administrator exists.
 * - Password recovery is a host-level CLI action (`admin reset-password`), always audited.
 * - Passwords are stored only as Argon2id hashes; they are never logged or returned.
 */
import { randomUUID } from 'node:crypto';
import type { PolicyActor } from '@unifi-local-mcp/policy';
import {
  columnInteger,
  columnOptionalText,
  columnText,
  type Row,
  type SqliteDatabase,
} from '@unifi-local-mcp/storage';
import type { AuditLog } from '@unifi-local-mcp/telemetry';
import { hashPassword, passwordProblem, verifyPassword } from './passwords.ts';

export type AdminErrorCode =
  'admin_invalid' | 'admin_exists' | 'admin_not_found' | 'admin_actor_forbidden';

export class AdminError extends Error {
  override readonly name = 'AdminError';
  readonly code: AdminErrorCode;

  constructor(code: AdminErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface AdminView {
  id: string;
  username: string;
  status: 'active' | 'disabled';
  createdAt: string;
  passwordChangedAt: string;
  lastLoginAt: string | null;
}

const USERNAME = /^[a-z][a-z0-9_.-]{1,63}$/;
// A fixed hash to verify against when the user does not exist, so timing does not reveal it.
const DUMMY_HASH = hashPassword('unifi-local-mcp dummy password for timing');

function toView(row: Row): AdminView {
  return {
    id: columnText(row, 'id'),
    username: columnText(row, 'username'),
    status: columnText(row, 'status') as AdminView['status'],
    createdAt: columnText(row, 'created_at'),
    passwordChangedAt: columnText(row, 'password_changed_at'),
    lastLoginAt: columnOptionalText(row, 'last_login_at'),
  };
}

export interface AdminStoreOptions {
  db: SqliteDatabase;
  audit: AuditLog;
  now?: () => Date;
}

export class AdminStore {
  readonly #db: SqliteDatabase;
  readonly #audit: AuditLog;
  readonly #now: () => Date;

  constructor(options: AdminStoreOptions) {
    if (!options.audit.writesTo(options.db)) {
      throw new TypeError('AdminStore needs its AuditLog on its connection.');
    }
    this.#db = options.db;
    this.#audit = options.audit;
    this.#now = options.now ?? (() => new Date());
  }

  count(): number {
    return columnInteger(this.#db.get('SELECT count(*) AS n FROM admins') ?? { n: 0 }, 'n');
  }

  list(): AdminView[] {
    return this.#db.all('SELECT * FROM admins ORDER BY username').map(toView);
  }

  /** Creates the first administrator. Refuses when any administrator exists. CLI only. */
  bootstrap(username: string, password: string, actor: PolicyActor): AdminView {
    if (actor.type !== 'cli') {
      throw new AdminError(
        'admin_actor_forbidden',
        'The first administrator can only be created with the local CLI.',
      );
    }
    const name = this.#validate(username, password);
    return this.#db.transaction(() => {
      if (this.count() > 0) {
        throw new AdminError(
          'admin_exists',
          'An administrator already exists; bootstrap is only for the first one.',
        );
      }
      const timestamp = this.#now().toISOString();
      const id = randomUUID();
      this.#db.run(
        "INSERT INTO admins (id, username, password_hash, status, created_at, updated_at, password_changed_at) VALUES (?, ?, ?, 'active', ?, ?, ?)",
        [id, name, hashPassword(password), timestamp, timestamp, timestamp],
      );
      this.#record(actor, 'admin.bootstrap', { username: name });
      return this.#require(name);
    });
  }

  /** Sets a new password (host recovery). Also re-enables a disabled account. CLI only. */
  resetPassword(username: string, password: string, actor: PolicyActor): AdminView {
    if (actor.type !== 'cli') {
      throw new AdminError(
        'admin_actor_forbidden',
        'Password recovery is only possible with the local CLI.',
      );
    }
    const name = this.#validate(username, password);
    return this.#db.transaction(() => {
      this.#require(name);
      const timestamp = this.#now().toISOString();
      this.#db.run(
        "UPDATE admins SET password_hash = ?, status = 'active', updated_at = ?, password_changed_at = ? WHERE username = ?",
        [hashPassword(password), timestamp, timestamp, name],
      );
      this.#record(actor, 'admin.reset_password', { username: name });
      return this.#require(name);
    });
  }

  /**
   * Checks credentials (admin UI sign-in, step 10). Returns the account or undefined; the
   * time taken does not depend on whether the username exists.
   */
  verify(username: string, password: string): AdminView | undefined {
    const row = this.#db.get('SELECT * FROM admins WHERE username = ?', [
      username.trim().toLowerCase(),
    ]);
    const hash = row === undefined ? DUMMY_HASH : columnText(row, 'password_hash');
    const ok = verifyPassword(hash, password);
    if (row === undefined || !ok || columnText(row, 'status') !== 'active') return undefined;
    return toView(row);
  }

  #validate(username: string, password: string): string {
    const name = username.trim().toLowerCase();
    if (!USERNAME.test(name)) {
      throw new AdminError(
        'admin_invalid',
        'The username must be 2–64 lowercase letters, digits, ".", "_" or "-", starting with a letter.',
      );
    }
    const problem = passwordProblem(password, name);
    if (problem !== undefined) throw new AdminError('admin_invalid', problem);
    return name;
  }

  #require(username: string): AdminView {
    const row = this.#db.get('SELECT * FROM admins WHERE username = ?', [username]);
    if (row === undefined)
      throw new AdminError('admin_not_found', `No administrator "${username}".`);
    return toView(row);
  }

  #record(actor: PolicyActor, action: string, details: Record<string, unknown>): void {
    this.#audit.record({ eventType: 'admin.security', action, outcome: 'success', actor, details });
  }
}
