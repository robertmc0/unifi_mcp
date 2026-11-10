/**
 * Admin UI sessions (spec §7.2; ADR 0016).
 *
 * - The cookie value is `<id>.<secret>`: a public 16-hex id and 256 random bits. Only the
 *   secret's SHA-256 is stored, and it is compared in constant time.
 * - A session ends after an idle period, after an absolute lifetime, at sign-out, when the
 *   account's password is reset or when the account is disabled.
 * - The CSRF token is derived from the session secret (HMAC), so it needs no storage and
 *   only the holder of the cookie can compute it.
 * - `authenticatedAt` is the last time the password was checked. Approving a request needs
 *   the password again, which renews it (recent re-authentication).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { columnOptionalText, columnText, type SqliteDatabase } from '@unifi-local-mcp/storage';
import type { AdminStore, AdminView } from './admins.ts';

export interface SessionLimits {
  /** A session unused for this long ends. */
  idleMs: number;
  /** A session ends this long after sign-in, used or not. */
  lifetimeMs: number;
}

export const DEFAULT_SESSION_LIMITS: SessionLimits = {
  idleMs: 30 * 60_000,
  lifetimeMs: 12 * 60 * 60_000,
};

export interface AdminSession {
  id: string;
  admin: AdminView;
  createdAt: string;
  authenticatedAt: Date;
  expiresAt: string;
  /** Token that forms must echo back on every state change. */
  csrfToken: string;
}

const COOKIE_VALUE = /^([0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/;
// Last-seen times are written at most this often, to keep reads cheap.
const TOUCH_INTERVAL_MS = 60_000;

function digest(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

function csrfFor(secret: string): string {
  return createHmac('sha256', secret).update('unifi-local-mcp admin csrf v1').digest('base64url');
}

/** Constant-time comparison of two strings of possibly different length. */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}

export class AdminSessionStore {
  readonly #db: SqliteDatabase;
  readonly #admins: AdminStore;
  readonly #limits: SessionLimits;
  readonly #now: () => Date;

  constructor(options: {
    db: SqliteDatabase;
    admins: AdminStore;
    limits?: Partial<SessionLimits>;
    now?: () => Date;
  }) {
    this.#db = options.db;
    this.#admins = options.admins;
    this.#limits = { ...DEFAULT_SESSION_LIMITS, ...options.limits };
    this.#now = options.now ?? (() => new Date());
  }

  get limits(): SessionLimits {
    return this.#limits;
  }

  /** Starts a session for an account whose password was just verified. */
  create(admin: AdminView): { cookieValue: string; session: AdminSession } {
    const id = randomBytes(8).toString('hex');
    const secret = randomBytes(32).toString('base64url');
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + this.#limits.lifetimeMs).toISOString();
    this.#db.run(
      'INSERT INTO admin_sessions (id, secret_sha256, admin_id, created_at, last_seen_at, authenticated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        digest(secret).toString('hex'),
        admin.id,
        now.toISOString(),
        now.toISOString(),
        now.toISOString(),
        expiresAt,
      ],
    );
    return {
      cookieValue: `${id}.${secret}`,
      session: {
        id,
        admin,
        createdAt: now.toISOString(),
        authenticatedAt: now,
        expiresAt,
        csrfToken: csrfFor(secret),
      },
    };
  }

  /**
   * Resolves a cookie value to a live session, or undefined for any failure (malformed,
   * unknown, wrong secret, revoked, idle, expired, or the account missing or disabled).
   */
  authenticate(cookieValue: string | undefined): AdminSession | undefined {
    const match = COOKIE_VALUE.exec(cookieValue ?? '');
    const id = match?.[1];
    const secret = match?.[2] ?? '';
    const row =
      id === undefined
        ? undefined
        : this.#db.get('SELECT * FROM admin_sessions WHERE id = ?', [id]);
    const stored = Buffer.from(
      row === undefined ? '0'.repeat(64) : columnText(row, 'secret_sha256'),
      'hex',
    );
    const matches = timingSafeEqual(digest(secret), stored);
    if (row === undefined || id === undefined || !matches) return undefined;
    if (columnOptionalText(row, 'revoked_at') !== null) return undefined;
    const now = this.#now();
    const lastSeen = Date.parse(columnText(row, 'last_seen_at'));
    if (Date.parse(columnText(row, 'expires_at')) <= now.getTime()) return undefined;
    if (lastSeen + this.#limits.idleMs <= now.getTime()) return undefined;
    const admin = this.#admins.byId(columnText(row, 'admin_id'));
    if (admin?.status !== 'active') return undefined;
    if (now.getTime() - lastSeen >= TOUCH_INTERVAL_MS) {
      this.#db.run('UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?', [
        now.toISOString(),
        id,
      ]);
    }
    return {
      id,
      admin,
      createdAt: columnText(row, 'created_at'),
      authenticatedAt: new Date(columnText(row, 'authenticated_at')),
      expiresAt: columnText(row, 'expires_at'),
      csrfToken: csrfFor(secret),
    };
  }

  /** Records that the password was checked again just now. */
  reauthenticated(sessionId: string): Date {
    const now = this.#now();
    this.#db.run('UPDATE admin_sessions SET authenticated_at = ?, last_seen_at = ? WHERE id = ?', [
      now.toISOString(),
      now.toISOString(),
      sessionId,
    ]);
    return now;
  }

  /** Ends a session (sign-out). */
  revoke(sessionId: string): void {
    this.#db.run('UPDATE admin_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [
      this.#now().toISOString(),
      sessionId,
    ]);
  }

  /** Deletes sessions that ended more than a day ago. Returns how many. */
  prune(): number {
    const cutoff = new Date(this.#now().getTime() - 24 * 60 * 60_000).toISOString();
    const idleCutoff = new Date(
      this.#now().getTime() - this.#limits.idleMs - 24 * 60 * 60_000,
    ).toISOString();
    return this.#db.run(
      'DELETE FROM admin_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?) OR last_seen_at < ?',
      [cutoff, cutoff, idleCutoff],
    ).changes;
  }
}
