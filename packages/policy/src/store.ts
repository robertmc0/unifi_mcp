/**
 * Persistence of the global security policy and the policy version (spec §6.1, §6.5, §8.1;
 * ADR 0009).
 *
 * - The database is the operational authority (spec §8.1). The policy is read on every
 *   evaluation, so a change made by the CLI in another process applies immediately.
 * - `version` increases on every security-relevant change: global policy edits, runtime
 *   mode switches, and (through `bumpPolicyVersion`) console and client policy changes.
 *   Approvals bind to it, so any policy change invalidates pending approvals.
 * - Every change is audited in the same transaction; if the audit entry cannot be written,
 *   the change is rolled back.
 * - A stored policy that fails validation is never interpreted: `current()` throws
 *   `POLICY_INVALID`, and callers deny everything until an administrator fixes it.
 * - Policy can only be changed by an administrator, the CLI or the system, never by an
 *   MCP client.
 */
import { createHash } from 'node:crypto';
import { columnInteger, columnText, type SqliteDatabase } from '@unifi-local-mcp/storage';
import type { AuditLog } from '@unifi-local-mcp/telemetry';
import {
  describeValidationError,
  GlobalPolicySchema,
  type GlobalPolicy,
  type RuntimeMode,
} from './model.ts';

export type PolicyErrorCode =
  | 'POLICY_INVALID'
  | 'POLICY_VERSION_CONFLICT'
  | 'POLICY_NOT_INITIALISED'
  | 'POLICY_ACTOR_FORBIDDEN';

export class PolicyError extends Error {
  override readonly name = 'PolicyError';
  readonly code: PolicyErrorCode;

  constructor(code: PolicyErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

/** Who changes policy. MCP clients are deliberately not representable. */
export interface PolicyActor {
  type: 'admin' | 'cli' | 'system';
  id?: string;
}

export interface PolicySnapshot {
  version: number;
  document: GlobalPolicy;
  updatedAt: string;
  updatedBy: string;
}

export type PolicyValidation = { ok: true; document: GlobalPolicy } | { ok: false; errors: string };

export function validateGlobalPolicy(input: unknown): PolicyValidation {
  const result = GlobalPolicySchema.safeParse(input);
  return result.success
    ? { ok: true, document: result.data }
    : { ok: false, errors: describeValidationError(result.error) };
}

function actorLabel(actor: PolicyActor): string {
  if ((actor.type as string) === 'mcp_client' || !['admin', 'cli', 'system'].includes(actor.type)) {
    throw new PolicyError(
      'POLICY_ACTOR_FORBIDDEN',
      'Security policy can only be changed by an administrator, the CLI or the system.',
    );
  }
  return `${actor.type}:${actor.id ?? '-'}`.slice(0, 160);
}

function documentDigest(document: GlobalPolicy): string {
  return createHash('sha256').update(JSON.stringify(document), 'utf8').digest('hex');
}

/**
 * Increments the policy version inside the caller's transaction, for console and client
 * policy changes that are stored elsewhere. Returns the new version. The caller audits
 * its own change.
 */
export function bumpPolicyVersion(
  db: SqliteDatabase,
  actor: PolicyActor,
  now: () => Date = () => new Date(),
): number {
  const label = actorLabel(actor);
  return db.transaction(() => {
    const result = db.run(
      'UPDATE security_policy SET version = version + 1, updated_at = ?, updated_by = ? ' +
        'WHERE singleton = 1',
      [now().toISOString(), label],
    );
    if (result.changes === 0) {
      throw new PolicyError(
        'POLICY_NOT_INITIALISED',
        'The security policy has not been initialised; call PolicyStore.current() first.',
      );
    }
    const row = db.get('SELECT version FROM security_policy WHERE singleton = 1');
    return row === undefined ? 0 : columnInteger(row, 'version');
  });
}

export class PolicyStore {
  readonly #db: SqliteDatabase;
  readonly #audit: AuditLog;
  readonly #now: () => Date;

  constructor(db: SqliteDatabase, audit: AuditLog, now: () => Date = () => new Date()) {
    if (!audit.writesTo(db)) {
      // A policy change and its audit entry must commit in one transaction.
      throw new TypeError('PolicyStore needs an AuditLog on the same database connection.');
    }
    this.#db = db;
    this.#audit = audit;
    this.#now = now;
  }

  /**
   * The current policy. On first use, stores the default policy (read-only runtime mode,
   * no rules) as version 1 and audits it.
   */
  current(): PolicySnapshot {
    return this.#read() ?? this.#initialise();
  }

  /** Switches the runtime mode. A no-op when the mode is already set. */
  setRuntimeMode(mode: RuntimeMode, actor: PolicyActor, expectedVersion?: number): PolicySnapshot {
    const label = actorLabel(actor);
    return this.#db.transaction(() => {
      const current = this.current();
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        throw this.#conflict(expectedVersion, current.version);
      }
      if (current.document.runtimeMode === mode) return current;
      const document: GlobalPolicy = { ...current.document, runtimeMode: mode };
      const next = this.#write(current.version, document, label);
      this.#audit.record({
        eventType: 'admin.security',
        action: 'policy.runtime_mode_change',
        outcome: 'success',
        actor,
        details: {
          from: current.document.runtimeMode,
          to: mode,
          fromVersion: current.version,
          toVersion: next.version,
        },
      });
      return next;
    });
  }

  /**
   * Replaces the global policy after validation. `expectedVersion` must equal the current
   * version (compare-and-set), so concurrent edits cannot silently overwrite each other.
   */
  replace(input: unknown, actor: PolicyActor, expectedVersion: number): PolicySnapshot {
    const label = actorLabel(actor);
    const validation = validateGlobalPolicy(input);
    if (!validation.ok) {
      throw new PolicyError('POLICY_INVALID', `The policy is invalid:\n${validation.errors}`);
    }
    return this.#db.transaction(() => {
      const current = this.current();
      if (current.version !== expectedVersion) {
        throw this.#conflict(expectedVersion, current.version);
      }
      const next = this.#write(current.version, validation.document, label);
      this.#audit.record({
        eventType: 'admin.security',
        action: 'policy.update',
        outcome: 'success',
        actor,
        details: {
          fromVersion: current.version,
          toVersion: next.version,
          runtimeMode: next.document.runtimeMode,
          documentSha256: documentDigest(next.document),
          rules: {
            allow: next.document.allow?.length ?? null,
            deny: next.document.deny.length,
            denySensitive: next.document.denySensitive.length,
            riskElevations: next.document.riskElevations.length,
            enabledOperations: next.document.enabledOperations.length,
          },
        },
      });
      return next;
    });
  }

  #read(): PolicySnapshot | undefined {
    const row = this.#db.get(
      'SELECT version, document, updated_at, updated_by FROM security_policy WHERE singleton = 1',
    );
    if (row === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(columnText(row, 'document'));
    } catch (error) {
      throw this.#invalidStored('it is not valid JSON', error);
    }
    const validation = validateGlobalPolicy(parsed);
    if (!validation.ok) throw this.#invalidStored(validation.errors);
    return {
      version: columnInteger(row, 'version'),
      document: validation.document,
      updatedAt: columnText(row, 'updated_at'),
      updatedBy: columnText(row, 'updated_by'),
    };
  }

  #initialise(): PolicySnapshot {
    return this.#db.transaction(() => {
      const existing = this.#read();
      if (existing !== undefined) return existing;
      const document = GlobalPolicySchema.parse({});
      const updatedAt = this.#now().toISOString();
      this.#db.run(
        'INSERT INTO security_policy (singleton, version, document, updated_at, updated_by) ' +
          "VALUES (1, 1, ?, ?, 'system:-')",
        [JSON.stringify(document), updatedAt],
      );
      this.#audit.record({
        eventType: 'admin.security',
        action: 'policy.initialize',
        outcome: 'success',
        actor: { type: 'system' },
        details: { version: 1, runtimeMode: document.runtimeMode },
      });
      return { version: 1, document, updatedAt, updatedBy: 'system:-' };
    });
  }

  #write(fromVersion: number, document: GlobalPolicy, label: string): PolicySnapshot {
    const updatedAt = this.#now().toISOString();
    const result = this.#db.run(
      'UPDATE security_policy SET version = ?, document = ?, updated_at = ?, updated_by = ? ' +
        'WHERE singleton = 1 AND version = ?',
      [fromVersion + 1, JSON.stringify(document), updatedAt, label, fromVersion],
    );
    if (result.changes === 0) throw this.#conflict(fromVersion, undefined);
    return { version: fromVersion + 1, document, updatedAt, updatedBy: label };
  }

  #conflict(expected: number, actual: number | undefined): PolicyError {
    return new PolicyError(
      'POLICY_VERSION_CONFLICT',
      `The policy changed meanwhile (expected version ${String(expected)}` +
        `${actual === undefined ? '' : `, found ${String(actual)}`}). Reload it and retry.`,
    );
  }

  #invalidStored(reason: string, cause?: unknown): PolicyError {
    return new PolicyError(
      'POLICY_INVALID',
      `The stored security policy is invalid (${reason}). Every operation is denied until an ` +
        'administrator replaces it or restores a backup.',
      cause === undefined ? undefined : { cause },
    );
  }
}
