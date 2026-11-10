/**
 * Durable write executions (spec §10; ADR 0010).
 *
 * Every write gets a server-generated execution id and a row whose status only moves
 * forward through compare-and-set transitions:
 *
 *   queued ──▶ executing ──▶ succeeded | failed | outcome_unknown
 *     │
 *     └──▶ cancelled | denied
 *
 * A transition succeeds only from the expected state, so a double call or a second
 * process can never move the same execution to `executing` twice. After a restart, rows
 * left in `executing` become `outcome_unknown` (never re-run automatically) and rows left
 * in `queued` become `cancelled`.
 */
import { randomUUID } from 'node:crypto';
import {
  columnInteger,
  columnOptionalText,
  columnText,
  type Row,
  type SqliteDatabase,
} from '@unifi-local-mcp/storage';

export const EXECUTION_STATUSES = [
  'queued',
  'executing',
  'succeeded',
  'failed',
  'outcome_unknown',
  'cancelled',
  'denied',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];
export const TERMINAL_STATUSES: readonly ExecutionStatus[] = [
  'succeeded',
  'failed',
  'outcome_unknown',
  'cancelled',
  'denied',
];

export interface ExecutionRecord {
  id: string;
  clientId: string;
  operationId: string;
  consoleId: string;
  siteId: string | null;
  argumentsSha256: string;
  idempotencyKey: string | null;
  status: ExecutionStatus;
  policyVersion: number;
  correlationId: string;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface NewExecution {
  clientId: string;
  operationId: string;
  consoleId: string;
  siteId: string | undefined;
  argumentsSha256: string;
  idempotencyKey: string | undefined;
  policyVersion: number;
  correlationId: string;
}

function toRecord(row: Row): ExecutionRecord {
  return {
    id: columnText(row, 'id'),
    clientId: columnText(row, 'client_id'),
    operationId: columnText(row, 'operation_id'),
    consoleId: columnText(row, 'console_id'),
    siteId: columnOptionalText(row, 'site_id'),
    argumentsSha256: columnText(row, 'arguments_sha256'),
    idempotencyKey: columnOptionalText(row, 'idempotency_key'),
    status: columnText(row, 'status') as ExecutionStatus,
    policyVersion: columnInteger(row, 'policy_version'),
    correlationId: columnText(row, 'correlation_id'),
    errorCode: columnOptionalText(row, 'error_code'),
    createdAt: columnText(row, 'created_at'),
    updatedAt: columnText(row, 'updated_at'),
    startedAt: columnOptionalText(row, 'started_at'),
    finishedAt: columnOptionalText(row, 'finished_at'),
  };
}

export class ExecutionStore {
  readonly #db: SqliteDatabase;
  readonly #now: () => Date;

  constructor(db: SqliteDatabase, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
  }

  get database(): SqliteDatabase {
    return this.#db;
  }

  create(fields: NewExecution): ExecutionRecord {
    const id = randomUUID();
    const timestamp = this.#now().toISOString();
    this.#db.run(
      'INSERT INTO operation_executions (id, client_id, operation_id, console_id, site_id, ' +
        'arguments_sha256, idempotency_key, status, policy_version, correlation_id, ' +
        "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)",
      [
        id,
        fields.clientId,
        fields.operationId,
        fields.consoleId,
        fields.siteId ?? null,
        fields.argumentsSha256,
        fields.idempotencyKey ?? null,
        fields.policyVersion,
        fields.correlationId,
        timestamp,
        timestamp,
      ],
    );
    const record = this.get(id);
    if (record === undefined) throw new Error('Execution record vanished after insert.');
    return record;
  }

  get(id: string): ExecutionRecord | undefined {
    const row = this.#db.get('SELECT * FROM operation_executions WHERE id = ?', [id]);
    return row === undefined ? undefined : toRecord(row);
  }

  findByIdempotencyKey(clientId: string, idempotencyKey: string): ExecutionRecord | undefined {
    const row = this.#db.get(
      'SELECT * FROM operation_executions WHERE client_id = ? AND idempotency_key = ?',
      [clientId, idempotencyKey],
    );
    return row === undefined ? undefined : toRecord(row);
  }

  /**
   * Moves an execution from `from` to `to`. Returns false (and changes nothing) when the
   * execution is not currently in `from`.
   */
  transition(id: string, from: ExecutionStatus, to: ExecutionStatus, errorCode?: string): boolean {
    const timestamp = this.#now().toISOString();
    const started = to === 'executing' ? timestamp : null;
    const finished = TERMINAL_STATUSES.includes(to) ? timestamp : null;
    return (
      this.#db.run(
        'UPDATE operation_executions SET status = ?, error_code = coalesce(?, error_code), ' +
          'updated_at = ?, started_at = coalesce(?, started_at), ' +
          'finished_at = coalesce(?, finished_at) WHERE id = ? AND status = ?',
        [to, errorCode ?? null, timestamp, started, finished, id, from],
      ).changes === 1
    );
  }

  /** Executions left mid-flight by a previous process. */
  interrupted(): ExecutionRecord[] {
    return this.#db
      .all(
        "SELECT * FROM operation_executions WHERE status IN ('queued', 'executing') ORDER BY created_at",
      )
      .map(toRecord);
  }
}
