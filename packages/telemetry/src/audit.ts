/**
 * Persistent audit trail (spec §2 decision 17, §6.4, §12; ADR 0008).
 *
 * - Every MCP read and write, permission denial, admin login or security change, approval
 *   decision and important failure is recorded. Entries are immutable in the application:
 *   a trigger refuses UPDATE, and the only delete path is retention pruning, which is
 *   itself audited.
 * - Entries are hash-chained (`entry_hash = SHA-256(prev_hash ‖ canonical entry)`), so an
 *   edited or removed entry is detectable by `verifyChain()`. The host administrator is
 *   trusted (spec §3.1); the chain makes tampering evident, it cannot prevent it.
 * - Details store metadata and safe identifiers only. They pass through the redactor and
 *   are size-capped. Never put complete sensitive reads or payloads in them.
 * - **Fail safe:** if an entry cannot be written (for example the disk is full), `record()`
 *   throws `AuditUnavailableError`. Callers must treat that as a refusal of the operation it
 *   describes: no audited operation proceeds without its audit entry. The failure is also
 *   written to the runtime log, and `healthy` turns false until a write succeeds again.
 * - `record()` joins the caller's transaction when there is one (as a savepoint), so an
 *   audit entry and the state change it describes commit or roll back together.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  columnInteger,
  columnOptionalText,
  columnText,
  isStorageError,
  type Row,
  type SqliteDatabase,
} from '@unifi-local-mcp/storage';
import type { Logger } from './logger.ts';
import { redact, redactString, type JsonValue, type RedactionLimits } from './redact.ts';

export const AUDIT_OUTCOMES = [
  'success',
  'denied',
  'failure',
  'pending',
  'outcome_unknown',
] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export const AUDIT_ACTOR_TYPES = ['mcp_client', 'admin', 'cli', 'system'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/** Proposed default retention for audit metadata (spec §12). */
export const DEFAULT_AUDIT_RETENTION_DAYS = 90;

const GENESIS_HASH = '0'.repeat(64);
const MAX_DETAILS_BYTES = 8192;
const MAX_IDENTIFIER_LENGTH = 128;
const DETAIL_LIMITS: RedactionLimits = {
  maxDepth: 5,
  maxStringLength: 512,
  maxArrayItems: 20,
  maxObjectKeys: 50,
};
const NAME_PATTERN = /^[a-z][a-z0-9_.-]*$/;
const VERIFY_BATCH = 1000;
const MAX_LIST_LIMIT = 500;

export interface AuditEvent {
  /** Category, for example `mcp.operation`, `mcp.auth`, `admin.security`, `approval`, `system`. */
  eventType: string;
  /** What happened, for example `operation.execute`, `client.revoke`, `db.backup`. */
  action: string;
  outcome: AuditOutcome;
  actor: { type: AuditActorType; id?: string | undefined };
  correlationId?: string | undefined;
  consoleId?: string | undefined;
  application?: string | undefined;
  operationId?: string | undefined;
  errorCode?: string | undefined;
  durationMs?: number | undefined;
  /** Safe metadata only. Redacted and capped at 8 KiB before storage. */
  details?: Readonly<Record<string, unknown>> | undefined;
}

export interface AuditEntry {
  seq: number;
  id: string;
  occurredAt: string;
  eventType: string;
  action: string;
  outcome: AuditOutcome;
  actorType: AuditActorType;
  actorId: string | null;
  correlationId: string | null;
  consoleId: string | null;
  application: string | null;
  operationId: string | null;
  errorCode: string | null;
  durationMs: number | null;
  details: JsonValue;
  prevHash: string;
  entryHash: string;
}

export interface AuditQuery {
  /** Return entries with `seq` below this cursor (for paging backwards from newest). */
  beforeSeq?: number;
  since?: Date;
  until?: Date;
  actorType?: AuditActorType;
  actorId?: string;
  outcome?: AuditOutcome;
  eventType?: string;
  /** Default 100, maximum 500. */
  limit?: number;
}

export interface ChainVerification {
  ok: boolean;
  entriesChecked: number;
  /** First entry whose hash or link does not match, when `ok` is false. */
  firstInvalidSeq?: number;
}

export class AuditUnavailableError extends Error {
  override readonly name = 'AuditUnavailableError';
  readonly code = 'AUDIT_UNAVAILABLE';

  constructor(options?: ErrorOptions) {
    super(
      'The audit trail cannot be written, so the operation was refused. Check free space ' +
        'and health of the data volume.',
      options,
    );
  }
}

function boundedIdentifier(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  return redactString(value, MAX_IDENTIFIER_LENGTH).slice(0, MAX_IDENTIFIER_LENGTH);
}

function assertName(field: string, value: string, maxLength: number): void {
  if (value.length > maxLength || !NAME_PATTERN.test(value)) {
    throw new TypeError(`Audit ${field} "${value}" must match ${NAME_PATTERN.source}.`);
  }
}

function serialiseDetails(details: AuditEvent['details']): string {
  const json = JSON.stringify(redact(details ?? {}, DETAIL_LIMITS));
  if (Buffer.byteLength(json, 'utf8') <= MAX_DETAILS_BYTES) return json;
  return JSON.stringify({ _truncated: true, originalBytes: Buffer.byteLength(json, 'utf8') });
}

type HashedFields = Omit<AuditEntry, 'seq' | 'details' | 'prevHash' | 'entryHash'> & {
  detailsJson: string;
};

function entryHash(prevHash: string, fields: HashedFields): string {
  const canonical = JSON.stringify([
    fields.id,
    fields.occurredAt,
    fields.eventType,
    fields.action,
    fields.outcome,
    fields.actorType,
    fields.actorId,
    fields.correlationId,
    fields.consoleId,
    fields.application,
    fields.operationId,
    fields.errorCode,
    fields.durationMs,
    fields.detailsJson,
  ]);
  return createHash('sha256').update(`${prevHash}\n${canonical}`, 'utf8').digest('hex');
}

function nullableInteger(row: Row, name: string): number | null {
  return row[name] === null ? null : columnInteger(row, name);
}

function toHashedFields(row: Row): HashedFields {
  return {
    id: columnText(row, 'id'),
    occurredAt: columnText(row, 'occurred_at'),
    eventType: columnText(row, 'event_type'),
    action: columnText(row, 'action'),
    outcome: columnText(row, 'outcome') as AuditOutcome,
    actorType: columnText(row, 'actor_type') as AuditActorType,
    actorId: columnOptionalText(row, 'actor_id'),
    correlationId: columnOptionalText(row, 'correlation_id'),
    consoleId: columnOptionalText(row, 'console_id'),
    application: columnOptionalText(row, 'application'),
    operationId: columnOptionalText(row, 'operation_id'),
    errorCode: columnOptionalText(row, 'error_code'),
    durationMs: nullableInteger(row, 'duration_ms'),
    detailsJson: columnText(row, 'details'),
  };
}

function toEntry(row: Row): AuditEntry {
  const { detailsJson, ...fields } = toHashedFields(row);
  return {
    seq: columnInteger(row, 'seq'),
    ...fields,
    details: JSON.parse(detailsJson) as JsonValue,
    prevHash: columnText(row, 'prev_hash'),
    entryHash: columnText(row, 'entry_hash'),
  };
}

export interface AuditLogOptions {
  /** Runtime logger that receives a record when an audit write fails. */
  logger: Logger;
  now?: () => Date;
}

export class AuditLog {
  readonly #db: SqliteDatabase;
  readonly #logger: Logger;
  readonly #now: () => Date;
  #healthy = true;

  constructor(db: SqliteDatabase, options: AuditLogOptions) {
    this.#db = db;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
  }

  /** False after a failed write, until a later write succeeds. Feeds readiness. */
  get healthy(): boolean {
    return this.#healthy;
  }

  /**
   * Readiness probe. When healthy, returns true without writing. After a failure it tries
   * to record a `system`/`audit.recovered` entry, so the service becomes ready again once
   * the cause (for example a full disk) is fixed, even if no traffic reaches it while it
   * is not ready.
   */
  probe(): boolean {
    if (this.#healthy) return true;
    try {
      this.record({
        eventType: 'system',
        action: 'audit.recovered',
        outcome: 'success',
        actor: { type: 'system' },
      });
      return true;
    } catch (error) {
      if (error instanceof AuditUnavailableError) return false;
      throw error;
    }
  }

  /**
   * Appends an entry. Throws `AuditUnavailableError` when it cannot be stored; the caller
   * must then refuse the operation. Invalid event shapes are programming errors (TypeError).
   */
  record(event: AuditEvent): AuditEntry {
    assertName('eventType', event.eventType, 64);
    assertName('action', event.action, 128);
    if (!(AUDIT_OUTCOMES as readonly string[]).includes(event.outcome)) {
      throw new TypeError(`Unknown audit outcome "${event.outcome}".`);
    }
    if (!(AUDIT_ACTOR_TYPES as readonly string[]).includes(event.actor.type)) {
      throw new TypeError(`Unknown audit actor type "${event.actor.type}".`);
    }
    if (
      event.durationMs !== undefined &&
      (!Number.isFinite(event.durationMs) || event.durationMs < 0)
    ) {
      throw new TypeError('Audit durationMs must be a non-negative finite number.');
    }
    const fields: HashedFields = {
      id: randomUUID(),
      occurredAt: this.#now().toISOString(),
      eventType: event.eventType,
      action: event.action,
      outcome: event.outcome,
      actorType: event.actor.type,
      actorId: boundedIdentifier(event.actor.id),
      correlationId: boundedIdentifier(event.correlationId),
      consoleId: boundedIdentifier(event.consoleId),
      application: boundedIdentifier(event.application)?.slice(0, 64) ?? null,
      operationId: boundedIdentifier(event.operationId),
      errorCode: boundedIdentifier(event.errorCode),
      durationMs: event.durationMs === undefined ? null : Math.round(event.durationMs),
      detailsJson: serialiseDetails(event.details),
    };
    try {
      const entry = this.#db.transaction(() => {
        const last = this.#db.get('SELECT entry_hash FROM audit_entries ORDER BY seq DESC LIMIT 1');
        const prevHash = last === undefined ? GENESIS_HASH : columnText(last, 'entry_hash');
        const hash = entryHash(prevHash, fields);
        const result = this.#db.run(
          'INSERT INTO audit_entries (id, occurred_at, event_type, action, outcome, actor_type, ' +
            'actor_id, correlation_id, console_id, application, operation_id, error_code, ' +
            'duration_ms, details, prev_hash, entry_hash) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            fields.id,
            fields.occurredAt,
            fields.eventType,
            fields.action,
            fields.outcome,
            fields.actorType,
            fields.actorId,
            fields.correlationId,
            fields.consoleId,
            fields.application,
            fields.operationId,
            fields.errorCode,
            fields.durationMs,
            fields.detailsJson,
            prevHash,
            hash,
          ],
        );
        const { detailsJson, ...rest } = fields;
        return {
          seq: result.lastInsertRowid,
          ...rest,
          details: JSON.parse(detailsJson) as JsonValue,
          prevHash,
          entryHash: hash,
        } satisfies AuditEntry;
      });
      this.#healthy = true;
      return entry;
    } catch (error) {
      if (!isStorageError(error)) throw error;
      this.#healthy = false;
      this.#logger.error('audit write failed; the audited operation is refused', {
        storageErrorCode: error.code,
        eventType: fields.eventType,
        action: fields.action,
        outcome: fields.outcome,
        actorType: fields.actorType,
        actorId: fields.actorId,
        correlationId: fields.correlationId,
      });
      throw new AuditUnavailableError({ cause: error });
    }
  }

  /** Newest first, paged by `beforeSeq`. */
  list(query: AuditQuery = {}): AuditEntry[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    const add = (sql: string, value: string | number | undefined): void => {
      if (value === undefined) return;
      conditions.push(sql);
      params.push(value);
    };
    add('seq < ?', query.beforeSeq);
    add('occurred_at >= ?', query.since?.toISOString());
    add('occurred_at < ?', query.until?.toISOString());
    add('actor_type = ?', query.actorType);
    add('actor_id = ?', query.actorId);
    add('outcome = ?', query.outcome);
    add('event_type = ?', query.eventType);
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 100), 1), MAX_LIST_LIMIT);
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    return this.#db
      .all(`SELECT * FROM audit_entries ${where} ORDER BY seq DESC LIMIT ${String(limit)}`, params)
      .map(toEntry);
  }

  /**
   * Deletes entries that occurred before `olderThan` and records the pruning as an audit
   * entry, in one transaction. Returns the number of entries deleted.
   */
  prune(olderThan: Date, actor: AuditEvent['actor'] = { type: 'system' }): number {
    return this.#db.transaction(() => {
      const cutoff = olderThan.toISOString();
      const deleted = this.#db.run('DELETE FROM audit_entries WHERE occurred_at < ?', [cutoff]);
      this.record({
        eventType: 'system',
        action: 'audit.prune',
        outcome: 'success',
        actor,
        details: { deleted: deleted.changes, olderThan: cutoff },
      });
      return deleted.changes;
    });
  }

  /**
   * Recomputes the hash chain. The first remaining entry's `prev_hash` is the anchor (older
   * entries may have been pruned); every later entry must link to its predecessor.
   */
  verifyChain(): ChainVerification {
    let previousHash: string | undefined;
    let afterSeq = 0;
    let checked = 0;
    for (;;) {
      const rows = this.#db.all(
        `SELECT * FROM audit_entries WHERE seq > ? ORDER BY seq LIMIT ${String(VERIFY_BATCH)}`,
        [afterSeq],
      );
      if (rows.length === 0) return { ok: true, entriesChecked: checked };
      for (const row of rows) {
        const seq = columnInteger(row, 'seq');
        const prevHash = columnText(row, 'prev_hash');
        const linked = previousHash === undefined || prevHash === previousHash;
        if (!linked || entryHash(prevHash, toHashedFields(row)) !== columnText(row, 'entry_hash')) {
          return { ok: false, entriesChecked: checked, firstInvalidSeq: seq };
        }
        previousHash = columnText(row, 'entry_hash');
        afterSeq = seq;
        checked++;
      }
    }
  }
}
