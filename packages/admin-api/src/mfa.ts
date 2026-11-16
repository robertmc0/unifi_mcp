/**
 * Two-step sign-in for administrators (spec §7.2; ADR 0026).
 *
 * - **TOTP.** The secret is stored encrypted with the master key (a `secret_records` entry
 *   of kind `admin.totp_secret`). It is shown once, at enrolment, and never read back out.
 * - **Recovery codes.** Ten codes of 80 random bits each, shown once. Only their SHA-256 is
 *   stored, and each works once. With that much entropy a plain digest cannot be searched.
 * - **Enrolment, reset and new recovery codes are host actions** (the local CLI), always
 *   audited. Activating or removing the second step ends the account's sessions.
 * - **A code works once.** The last accepted time step is stored with the account.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { PolicyActor } from '@unifi-local-mcp/policy';
import {
  columnInteger,
  columnOptionalText,
  columnText,
  type SecretStore,
  type SqliteDatabase,
} from '@unifi-local-mcp/storage';
import type { AuditLog } from '@unifi-local-mcp/telemetry';
import { AdminError } from './admins.ts';
import { base32Encode, generateTotpSecret, otpauthUri, verifyTotp } from './totp.ts';

export const TOTP_SECRET_KIND = 'admin.totp_secret';
export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 10;
const ISSUER = 'unifi-local-mcp';

export type SecondFactor = 'totp' | 'recovery_code';

export interface MfaStatus {
  state: 'off' | 'pending' | 'active';
  confirmedAt: string | null;
  recoveryCodesLeft: number;
}

export interface MfaEnrolment {
  /** The Base32 secret, to type into an authenticator app. Shown once. */
  secret: string;
  /** The same secret as an `otpauth://` URI. */
  uri: string;
}

/** Upper case without spaces and dashes: how a recovery code is hashed and compared. */
function normaliseRecoveryCode(input: string): string | undefined {
  const code = input.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z2-7]{16}$/.test(code) ? code : undefined;
}

function recoveryDigest(code: string): string {
  return createHash('sha256').update(`unifi-local-mcp recovery v1:${code}`, 'utf8').digest('hex');
}

function newRecoveryCode(): { shown: string; normalised: string } {
  const normalised = base32Encode(randomBytes(RECOVERY_CODE_BYTES));
  return { shown: normalised.match(/.{4}/g)?.join('-') ?? normalised, normalised };
}

export interface AdminMfaOptions {
  db: SqliteDatabase;
  audit: AuditLog;
  secrets: SecretStore;
  now?: () => Date;
}

export class AdminMfa {
  readonly #db: SqliteDatabase;
  readonly #audit: AuditLog;
  readonly #secrets: SecretStore;
  readonly #now: () => Date;

  constructor(options: AdminMfaOptions) {
    if (!options.audit.writesTo(options.db) || !options.secrets.writesTo(options.db)) {
      throw new TypeError('AdminMfa needs its AuditLog and SecretStore on its connection.');
    }
    this.#db = options.db;
    this.#audit = options.audit;
    this.#secrets = options.secrets;
    this.#now = options.now ?? (() => new Date());
  }

  status(adminId: string): MfaStatus {
    const row = this.#db.get('SELECT status, confirmed_at FROM admin_mfa WHERE admin_id = ?', [
      adminId,
    ]);
    if (row === undefined) return { state: 'off', confirmedAt: null, recoveryCodesLeft: 0 };
    return {
      state: columnText(row, 'status') as 'pending' | 'active',
      confirmedAt: columnOptionalText(row, 'confirmed_at'),
      recoveryCodesLeft: columnInteger(
        this.#db.get(
          'SELECT count(*) AS n FROM admin_mfa_recovery WHERE admin_id = ? AND used_at IS NULL',
          [adminId],
        ) ?? { n: 0 },
        'n',
      ),
    };
  }

  /**
   * Starts enrolment: stores a new secret as pending and returns it for the authenticator
   * app. Sign-in is unchanged until `confirm` proves the app works. Refused while the
   * second step is active (reset it first). CLI only.
   */
  begin(username: string, actor: PolicyActor): MfaEnrolment {
    this.#cliOnly(actor);
    return this.#db.transaction(() => {
      const admin = this.#admin(username);
      const existing = this.#db.get('SELECT status, secret_id FROM admin_mfa WHERE admin_id = ?', [
        admin.id,
      ]);
      if (existing !== undefined && columnText(existing, 'status') === 'active') {
        throw new AdminError(
          'admin_mfa_active',
          `Two-step sign-in is already active for "${admin.username}". Remove it first with "admin reset-mfa".`,
        );
      }
      if (existing !== undefined) this.#remove(admin.id, columnText(existing, 'secret_id'));
      const secret = generateTotpSecret();
      const secretId = this.#secrets.create(TOTP_SECRET_KIND, secret);
      this.#db.run(
        "INSERT INTO admin_mfa (admin_id, secret_id, status, created_at) VALUES (?, ?, 'pending', ?)",
        [admin.id, secretId, this.#now().toISOString()],
      );
      return { secret, uri: otpauthUri(secret, admin.username, ISSUER) };
    });
  }

  /**
   * Finishes enrolment with a code from the authenticator app. Returns the recovery codes,
   * which are shown once. Ends the account's sessions. CLI only.
   */
  confirm(username: string, code: string, actor: PolicyActor): string[] {
    this.#cliOnly(actor);
    return this.#db.transaction(() => {
      const admin = this.#admin(username);
      const row = this.#db.get('SELECT status, secret_id FROM admin_mfa WHERE admin_id = ?', [
        admin.id,
      ]);
      if (row === undefined || columnText(row, 'status') !== 'pending') {
        throw new AdminError('admin_mfa_not_pending', 'No enrolment is waiting for a code.');
      }
      const secret = this.#secrets.read(columnText(row, 'secret_id'), TOTP_SECRET_KIND).reveal();
      const step = verifyTotp(secret, code.replace(/\s/g, ''), this.#now());
      if (step === undefined) {
        throw new AdminError(
          'admin_mfa_code_invalid',
          'The code does not match. Check the time on the device and start again.',
        );
      }
      const timestamp = this.#now().toISOString();
      this.#db.run(
        "UPDATE admin_mfa SET status = 'active', confirmed_at = ?, last_step = ? WHERE admin_id = ?",
        [timestamp, step, admin.id],
      );
      const codes = this.#issueRecoveryCodes(admin.id, timestamp);
      const sessionsEnded = this.#endSessions(admin.id, timestamp);
      this.#record(actor, 'admin.mfa_enable', { username: admin.username, sessionsEnded });
      return codes;
    });
  }

  /** Drops a pending enrolment (the code was not confirmed). CLI only. */
  cancel(username: string, actor: PolicyActor): void {
    this.#cliOnly(actor);
    this.#db.transaction(() => {
      const admin = this.#admin(username);
      const row = this.#db.get('SELECT status, secret_id FROM admin_mfa WHERE admin_id = ?', [
        admin.id,
      ]);
      if (row !== undefined && columnText(row, 'status') === 'pending') {
        this.#remove(admin.id, columnText(row, 'secret_id'));
      }
    });
  }

  /**
   * Removes the second step and its recovery codes (host recovery for a lost device). Ends
   * the account's sessions. CLI only.
   */
  reset(username: string, actor: PolicyActor): { wasActive: boolean; sessionsEnded: number } {
    this.#cliOnly(actor);
    return this.#db.transaction(() => {
      const admin = this.#admin(username);
      const row = this.#db.get('SELECT status, secret_id FROM admin_mfa WHERE admin_id = ?', [
        admin.id,
      ]);
      const wasActive = row !== undefined && columnText(row, 'status') === 'active';
      if (row !== undefined) this.#remove(admin.id, columnText(row, 'secret_id'));
      const sessionsEnded = this.#endSessions(admin.id, this.#now().toISOString());
      this.#record(actor, 'admin.mfa_reset', {
        username: admin.username,
        wasActive,
        sessionsEnded,
      });
      return { wasActive, sessionsEnded };
    });
  }

  /** Replaces all recovery codes; the old ones stop working. Shown once. CLI only. */
  regenerateRecoveryCodes(username: string, actor: PolicyActor): string[] {
    this.#cliOnly(actor);
    return this.#db.transaction(() => {
      const admin = this.#admin(username);
      if (this.status(admin.id).state !== 'active') {
        throw new AdminError(
          'admin_mfa_not_active',
          `Two-step sign-in is not active for "${admin.username}".`,
        );
      }
      const codes = this.#issueRecoveryCodes(admin.id, this.#now().toISOString());
      this.#record(actor, 'admin.mfa_recovery_codes', { username: admin.username });
      return codes;
    });
  }

  /**
   * Checks the second step of an account whose password was just verified: a current TOTP
   * code or an unused recovery code. Whatever matches is consumed. Returns what matched,
   * or undefined (also when the second step is not active).
   */
  verify(adminId: string, input: string): SecondFactor | undefined {
    return this.#db.transaction(() => {
      const row = this.#db.get(
        'SELECT status, secret_id, last_step FROM admin_mfa WHERE admin_id = ?',
        [adminId],
      );
      if (row === undefined || columnText(row, 'status') !== 'active') return undefined;
      const compact = input.replace(/\s/g, '');
      if (/^\d{6}$/.test(compact)) {
        const secret = this.#secrets.read(columnText(row, 'secret_id'), TOTP_SECRET_KIND).reveal();
        const step = verifyTotp(secret, compact, this.#now(), columnInteger(row, 'last_step'));
        if (step === undefined) return undefined;
        this.#db.run('UPDATE admin_mfa SET last_step = ? WHERE admin_id = ?', [step, adminId]);
        return 'totp';
      }
      const recovery = normaliseRecoveryCode(input);
      if (recovery === undefined) return undefined;
      const used = this.#db.run(
        'UPDATE admin_mfa_recovery SET used_at = ? WHERE code_sha256 = ? AND admin_id = ? AND used_at IS NULL',
        [this.#now().toISOString(), recoveryDigest(recovery), adminId],
      ).changes;
      return used === 1 ? 'recovery_code' : undefined;
    });
  }

  #issueRecoveryCodes(adminId: string, timestamp: string): string[] {
    this.#db.run('DELETE FROM admin_mfa_recovery WHERE admin_id = ?', [adminId]);
    const codes: string[] = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
      const code = newRecoveryCode();
      this.#db.run(
        'INSERT INTO admin_mfa_recovery (code_sha256, admin_id, created_at) VALUES (?, ?, ?)',
        [recoveryDigest(code.normalised), adminId, timestamp],
      );
      codes.push(code.shown);
    }
    return codes;
  }

  #remove(adminId: string, secretId: string): void {
    this.#db.run('DELETE FROM admin_mfa WHERE admin_id = ?', [adminId]);
    this.#db.run('DELETE FROM admin_mfa_recovery WHERE admin_id = ?', [adminId]);
    this.#secrets.delete(secretId);
  }

  #endSessions(adminId: string, timestamp: string): number {
    return this.#db.run(
      'UPDATE admin_sessions SET revoked_at = ? WHERE admin_id = ? AND revoked_at IS NULL',
      [timestamp, adminId],
    ).changes;
  }

  #admin(username: string): { id: string; username: string } {
    const name = username.trim().toLowerCase();
    const row = this.#db.get('SELECT id, username FROM admins WHERE username = ?', [name]);
    if (row === undefined) throw new AdminError('admin_not_found', `No administrator "${name}".`);
    return { id: columnText(row, 'id'), username: columnText(row, 'username') };
  }

  #cliOnly(actor: PolicyActor): void {
    if (actor.type !== 'cli') {
      throw new AdminError(
        'admin_actor_forbidden',
        'Two-step sign-in is set up, removed and recovered only with the local CLI.',
      );
    }
  }

  #record(actor: PolicyActor, action: string, details: Record<string, unknown>): void {
    this.#audit.record({ eventType: 'admin.security', action, outcome: 'success', actor, details });
  }
}
