/**
 * Human approval of high-risk operations (spec §6.5; ADR 0011).
 *
 *   MCP client: high-risk request ──▶ propose ──▶ pending (TTL, default 10 min)
 *   Human (admin UI with recent sign-in, or local CLI): approve │ reject
 *   approved (execution window, default 2 min)
 *   MCP client (the same one): resume ──▶ consumed, executed once by the dispatcher
 *
 * - Approval is separate from execution, and no MCP client can approve: approvers are
 *   `admin` or `cli` only, checked at runtime as well as by type.
 * - A proposal is bound to client, operation, console, site, argument digest and the
 *   security-policy version. Any policy change invalidates it. Arguments cannot be supplied
 *   again at resume: the stored, approved ones are used, and their digest is re-checked.
 * - Proposed arguments are stored only as an encrypted secret record (they may contain
 *   credentials) and deleted as soon as the approval closes. Reviewers see a redacted
 *   summary.
 * - Every transition is a compare-and-set on the status, and consumption happens inside the
 *   dispatcher's transaction that creates the execution record: at most one execution.
 * - Every proposal, decision, refusal, expiry, invalidation and consumption is audited.
 */
import { randomUUID } from 'node:crypto';
import {
  canonicalJson,
  requestDigest,
  type ApprovalGate,
  type ApprovalRefusal,
  type ExecutionEnvelope,
  type Principal,
  type ProposalContext,
  type ResumableApproval,
} from '@unifi-local-mcp/core';
import { PolicyError, type PolicyStore } from '@unifi-local-mcp/policy';
import {
  columnInteger,
  columnOptionalText,
  columnText,
  isStorageError,
  type Row,
  type SecretStore,
  type SqliteDatabase,
} from '@unifi-local-mcp/storage';
import {
  redact,
  type AuditEvent,
  type AuditLog,
  type JsonValue,
  type RedactionLimits,
} from '@unifi-local-mcp/telemetry';

export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'invalidated',
  'consumed',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export interface ApprovalTtl {
  /** How long a proposal waits for a decision. Default and maximum 10 minutes. */
  pendingMs: number;
  /** How long an approved request may be resumed. Default and maximum 2 minutes. */
  executeMs: number;
}

export const DEFAULT_APPROVAL_TTL: ApprovalTtl = { pendingMs: 10 * 60_000, executeMs: 2 * 60_000 };
/** Administrators must have signed in this recently to approve (spec §6.5, §7.2). */
export const DEFAULT_RECENT_AUTH_MS = 5 * 60_000;

/** Who decides. MCP clients are deliberately not representable. */
export type Approver =
  | { type: 'cli'; id: string }
  | { type: 'admin'; id: string; authenticatedAt: Date; mfaVerified?: boolean };

export type ApprovalErrorCode =
  | 'approval_not_found'
  | 'approval_not_pending'
  | 'approval_expired'
  | 'approval_invalidated'
  | 'approver_forbidden'
  | 'reauthentication_required'
  | 'mfa_required';

export class ApprovalError extends Error {
  override readonly name = 'ApprovalError';
  readonly code: ApprovalErrorCode;

  constructor(code: ApprovalErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ApprovalView {
  id: string;
  clientId: string;
  operationId: string;
  consoleId: string;
  siteId: string | null;
  risk: string;
  /** Redacted description and arguments, for the human reviewer. */
  summary: JsonValue;
  status: ApprovalStatus;
  policyVersion: number;
  correlationId: string;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  executeBy: string | null;
  closedAt: string | null;
  executionId: string | null;
}

/** What the requesting client may know about its own approval. */
export interface ClientApprovalStatus {
  approvalId: string;
  status: ApprovalStatus;
  expiresAt: string;
  executeBy: string | null;
}

export interface ApprovalServiceOptions {
  db: SqliteDatabase;
  audit: AuditLog;
  secrets: SecretStore;
  policyStore: PolicyStore;
  now?: () => Date;
  /** Deployment policy may shorten, never lengthen, the default windows. */
  ttl?: Partial<ApprovalTtl>;
  recentAuthMs?: number;
  /** Require a verified second factor for administrator approvals. */
  requireAdminMfa?: boolean;
}

const ARGUMENTS_KIND = 'approval.arguments';
const SUMMARY_LIMITS: RedactionLimits = {
  maxDepth: 6,
  maxStringLength: 500,
  maxArrayItems: 50,
  maxObjectKeys: 100,
};
const MAX_SUMMARY_BYTES = 16_000;
const MIN_WINDOW_MS = 30_000;

const REFUSALS: Record<string, string> = {
  approval_not_found: 'No approval with this id exists for this client.',
  approval_pending: 'The request has not been approved yet.',
  approval_rejected: 'A human reviewer rejected this request.',
  approval_expired: 'The approval expired; propose the request again.',
  approval_invalidated:
    'The approval no longer matches the current request or security policy; propose again.',
  approval_already_used: 'This approval has already been used.',
  policy_unavailable: 'The security policy is unavailable, so every operation is refused.',
};

function refusal(code: string): ApprovalRefusal {
  return { ok: false, code, message: REFUSALS[code] ?? 'The approval cannot be used.' };
}

interface StoredApproval extends ApprovalView {
  argumentsSha256: string;
  argumentsSecretId: string | null;
}

function toStored(row: Row): StoredApproval {
  return {
    id: columnText(row, 'id'),
    clientId: columnText(row, 'client_id'),
    operationId: columnText(row, 'operation_id'),
    consoleId: columnText(row, 'console_id'),
    siteId: columnOptionalText(row, 'site_id'),
    argumentsSha256: columnText(row, 'arguments_sha256'),
    argumentsSecretId: columnOptionalText(row, 'arguments_secret_id'),
    risk: columnText(row, 'risk'),
    summary: JSON.parse(columnText(row, 'summary')) as JsonValue,
    status: columnText(row, 'status') as ApprovalStatus,
    policyVersion: columnInteger(row, 'policy_version'),
    correlationId: columnText(row, 'correlation_id'),
    createdAt: columnText(row, 'created_at'),
    expiresAt: columnText(row, 'expires_at'),
    decidedAt: columnOptionalText(row, 'decided_at'),
    decidedBy: columnOptionalText(row, 'decided_by'),
    decisionNote: columnOptionalText(row, 'decision_note'),
    executeBy: columnOptionalText(row, 'execute_by'),
    closedAt: columnOptionalText(row, 'closed_at'),
    executionId: columnOptionalText(row, 'execution_id'),
  };
}

function toView(stored: StoredApproval): ApprovalView {
  return {
    id: stored.id,
    clientId: stored.clientId,
    operationId: stored.operationId,
    consoleId: stored.consoleId,
    siteId: stored.siteId,
    risk: stored.risk,
    summary: stored.summary,
    status: stored.status,
    policyVersion: stored.policyVersion,
    correlationId: stored.correlationId,
    createdAt: stored.createdAt,
    expiresAt: stored.expiresAt,
    decidedAt: stored.decidedAt,
    decidedBy: stored.decidedBy,
    decisionNote: stored.decisionNote,
    executeBy: stored.executeBy,
    closedAt: stored.closedAt,
    executionId: stored.executionId,
  };
}

export class ApprovalService implements ApprovalGate {
  readonly #db: SqliteDatabase;
  readonly #audit: AuditLog;
  readonly #secrets: SecretStore;
  readonly #policyStore: PolicyStore;
  readonly #now: () => Date;
  readonly #ttl: ApprovalTtl;
  readonly #recentAuthMs: number;
  readonly #requireAdminMfa: boolean;

  constructor(options: ApprovalServiceOptions) {
    if (!options.audit.writesTo(options.db) || !options.secrets.writesTo(options.db)) {
      throw new TypeError('ApprovalService needs its AuditLog and SecretStore on its connection.');
    }
    const ttl = { ...DEFAULT_APPROVAL_TTL, ...options.ttl };
    if (
      ttl.pendingMs < MIN_WINDOW_MS ||
      ttl.pendingMs > DEFAULT_APPROVAL_TTL.pendingMs ||
      ttl.executeMs < MIN_WINDOW_MS ||
      ttl.executeMs > DEFAULT_APPROVAL_TTL.executeMs
    ) {
      throw new TypeError(
        'Approval windows can only be shortened: pending 30 s–10 min, execution 30 s–2 min.',
      );
    }
    this.#db = options.db;
    this.#audit = options.audit;
    this.#secrets = options.secrets;
    this.#policyStore = options.policyStore;
    this.#now = options.now ?? (() => new Date());
    this.#ttl = ttl;
    this.#recentAuthMs = options.recentAuthMs ?? DEFAULT_RECENT_AUTH_MS;
    this.#requireAdminMfa = options.requireAdminMfa ?? false;
  }

  writesTo(db: SqliteDatabase): boolean {
    return this.#db === db;
  }

  /** Called by the dispatcher for requests that need approval. Never executes anything. */
  propose(context: ProposalContext): ExecutionEnvelope {
    const id = randomUUID();
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + this.#ttl.pendingMs).toISOString();
    // A reviewed caution of the operation (ADR 0011) goes with every request for it.
    const { description, approvalCaution } = context.descriptor;
    const reviewed = {
      description,
      ...(approvalCaution === undefined ? {} : { caution: approvalCaution }),
    };
    let summaryJson = JSON.stringify(
      redact({ ...reviewed, arguments: context.arguments }, SUMMARY_LIMITS),
    );
    if (Buffer.byteLength(summaryJson, 'utf8') > MAX_SUMMARY_BYTES) {
      summaryJson = JSON.stringify({ ...reviewed, arguments: '[too large to summarise]' });
    }
    this.#db.transaction(() => {
      const secretId = this.#secrets.create(ARGUMENTS_KIND, canonicalJson(context.arguments));
      this.#db.run(
        'INSERT INTO approval_requests (id, client_id, operation_id, console_id, site_id, ' +
          'arguments_sha256, arguments_secret_id, summary, risk, policy_version, status, ' +
          "correlation_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
        [
          id,
          context.principal.clientId,
          context.descriptor.operationId,
          context.target.consoleId,
          context.target.siteId ?? null,
          context.argumentsSha256,
          secretId,
          summaryJson,
          context.effectiveRisk,
          context.policyVersion,
          context.correlationId,
          now.toISOString(),
          expiresAt,
        ],
      );
      this.#record({
        action: 'approval.propose',
        outcome: 'pending',
        actor: { type: 'mcp_client', id: context.principal.clientId },
        correlationId: context.correlationId,
        consoleId: context.target.consoleId,
        operationId: context.descriptor.operationId,
        details: {
          approvalId: id,
          risk: context.effectiveRisk,
          argumentsSha256: context.argumentsSha256,
          policyVersion: context.policyVersion,
          expiresAt,
        },
      });
    });
    return {
      status: 'approval_required',
      operationId: context.descriptor.operationId,
      consoleId: context.target.consoleId,
      siteId: context.target.siteId ?? null,
      correlationId: context.correlationId,
      approvalId: id,
      data: {
        approvalId: id,
        expiresAt,
        risk: context.effectiveRisk,
        summary: JSON.parse(summaryJson) as JsonValue,
        next:
          'A human administrator must approve this request in the admin UI or with the CLI ' +
          '(unifi-mcp approvals approve). Then call resume with this approvalId. Approval ' +
          'cannot be given through MCP.',
      },
    };
  }

  checkResumable(principal: Principal, approvalId: string): ResumableApproval | ApprovalRefusal {
    return this.#db.transaction((): ResumableApproval | ApprovalRefusal => {
      const stored = this.#load(approvalId);
      if (stored?.clientId !== principal.clientId) return refusal('approval_not_found');
      const current = this.#expireIfDue(stored);
      switch (current.status) {
        case 'pending':
          return refusal('approval_pending');
        case 'rejected':
          return refusal('approval_rejected');
        case 'consumed':
          return refusal('approval_already_used');
        case 'expired':
          return refusal('approval_expired');
        case 'invalidated':
          return refusal('approval_invalidated');
        case 'approved':
          break;
      }
      let policyVersion: number;
      try {
        policyVersion = this.#policyStore.current().version;
      } catch (error) {
        if (error instanceof PolicyError) return refusal('policy_unavailable');
        throw error;
      }
      if (policyVersion !== current.policyVersion) {
        this.#close(current, 'invalidated', 'policy_changed');
        return refusal('approval_invalidated');
      }
      let args: unknown;
      try {
        args = JSON.parse(
          this.#secrets.read(current.argumentsSecretId ?? '', ARGUMENTS_KIND).reveal(),
        );
      } catch (error) {
        if (!isStorageError(error) && !(error instanceof SyntaxError)) throw error;
        this.#close(current, 'invalidated', 'arguments_unreadable');
        return refusal('approval_invalidated');
      }
      const target = {
        consoleId: current.consoleId,
        ...(current.siteId === null ? {} : { siteId: current.siteId }),
      };
      const digest = requestDigest({
        operationId: current.operationId,
        consoleId: current.consoleId,
        siteId: current.siteId ?? undefined,
        arguments: args,
      });
      if (digest !== current.argumentsSha256) {
        this.#close(current, 'invalidated', 'arguments_changed');
        return refusal('approval_invalidated');
      }
      return {
        ok: true,
        approvalId: current.id,
        operationId: current.operationId,
        target,
        arguments: args,
        argumentsSha256: current.argumentsSha256,
        policyVersion: current.policyVersion,
      };
    });
  }

  consume(approvalId: string, executionId: string): boolean {
    return this.#db.transaction(() => {
      const stored = this.#load(approvalId);
      if (stored?.status !== 'approved') return false;
      const closedAt = this.#now().toISOString();
      const changed = this.#db.run(
        "UPDATE approval_requests SET status = 'consumed', arguments_secret_id = NULL, " +
          "closed_at = ?, execution_id = ? WHERE id = ? AND status = 'approved'",
        [closedAt, executionId, approvalId],
      ).changes;
      if (changed !== 1) return false;
      if (stored.argumentsSecretId !== null) this.#secrets.delete(stored.argumentsSecretId);
      this.#record({
        action: 'approval.consume',
        outcome: 'success',
        actor: { type: 'mcp_client', id: stored.clientId },
        correlationId: stored.correlationId,
        consoleId: stored.consoleId,
        operationId: stored.operationId,
        details: { approvalId, executionId },
      });
      return true;
    });
  }

  /** Approves a pending request. Only administrators (recently signed in) and the CLI. */
  approve(approvalId: string, approver: Approver, note?: string): ApprovalView {
    return this.#decide(approvalId, approver, 'approve', note);
  }

  reject(approvalId: string, approver: Approver, note?: string): ApprovalView {
    return this.#decide(approvalId, approver, 'reject', note);
  }

  get(approvalId: string): ApprovalView | undefined {
    const stored = this.#load(approvalId);
    return stored === undefined
      ? undefined
      : toView(this.#db.transaction(() => this.#expireIfDue(stored)));
  }

  list(filter: { status?: ApprovalStatus; limit?: number } = {}): ApprovalView[] {
    this.expireStale();
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 100), 1), 500);
    const rows =
      filter.status === undefined
        ? this.#db.all(
            `SELECT * FROM approval_requests ORDER BY created_at DESC LIMIT ${String(limit)}`,
          )
        : this.#db.all(
            `SELECT * FROM approval_requests WHERE status = ? ORDER BY created_at DESC LIMIT ${String(limit)}`,
            [filter.status],
          );
    return rows.map((row) => toView(toStored(row)));
  }

  /** The requesting client's view of its own approval; other clients' ids are not found. */
  statusFor(principal: Principal, approvalId: string): ClientApprovalStatus | undefined {
    const stored = this.#load(approvalId);
    if (stored?.clientId !== principal.clientId) return undefined;
    const current = this.#db.transaction(() => this.#expireIfDue(stored));
    return {
      approvalId: current.id,
      status: current.status,
      expiresAt: current.expiresAt,
      executeBy: current.executeBy,
    };
  }

  /** Closes every request whose window has passed. Returns how many were expired. */
  expireStale(): number {
    const open = this.#db
      .all("SELECT * FROM approval_requests WHERE status IN ('pending', 'approved')")
      .map(toStored);
    let expired = 0;
    for (const stored of open) {
      this.#db.transaction(() => {
        if (this.#expireIfDue(stored).status === 'expired') expired++;
      });
    }
    return expired;
  }

  #decide(
    approvalId: string,
    approver: Approver,
    decision: 'approve' | 'reject',
    note: string | undefined,
  ): ApprovalView {
    const action = decision === 'approve' ? 'approval.approve' : 'approval.reject';
    const refuse = (code: ApprovalErrorCode, text: string, stored?: StoredApproval): never => {
      this.#record({
        action,
        outcome: 'denied',
        actor: this.#actor(approver),
        errorCode: code,
        ...(stored === undefined
          ? {}
          : { consoleId: stored.consoleId, operationId: stored.operationId }),
        details: { approvalId },
      });
      throw new ApprovalError(code, text);
    };
    const approverType = (approver as { type: string }).type;
    if (approverType !== 'cli' && approverType !== 'admin') {
      return refuse(
        'approver_forbidden',
        'Only an administrator or the local CLI can decide on approvals; never an MCP client.',
      );
    }
    if (approver.id.trim() === '' || approver.id.length > 128) {
      return refuse('approver_forbidden', 'The approver must be identified.');
    }
    const now = this.#now();
    if (approver.type === 'admin' && decision === 'approve') {
      const age = now.getTime() - approver.authenticatedAt.getTime();
      if (age < 0 || age > this.#recentAuthMs) {
        return refuse(
          'reauthentication_required',
          'Sign in again before approving a high-risk action.',
        );
      }
      if (this.#requireAdminMfa && approver.mfaVerified !== true) {
        return refuse('mfa_required', 'A verified second factor is required to approve.');
      }
    }
    return this.#db.transaction(() => {
      const stored = this.#load(approvalId);
      if (stored === undefined)
        return refuse('approval_not_found', REFUSALS['approval_not_found'] ?? '');
      const current = this.#expireIfDue(stored);
      if (current.status === 'expired') {
        return refuse('approval_expired', REFUSALS['approval_expired'] ?? '', current);
      }
      if (current.status !== 'pending') {
        return refuse('approval_not_pending', `The request is ${current.status}.`, current);
      }
      if (decision === 'approve' && this.#policyStore.current().version !== current.policyVersion) {
        this.#close(current, 'invalidated', 'policy_changed');
        return refuse('approval_invalidated', REFUSALS['approval_invalidated'] ?? '', current);
      }
      const decidedAt = now.toISOString();
      const decidedBy = `${approver.type}:${approver.id}`;
      const trimmedNote = note?.slice(0, 500) ?? null;
      if (decision === 'approve') {
        const executeBy = new Date(now.getTime() + this.#ttl.executeMs).toISOString();
        this.#db.run(
          "UPDATE approval_requests SET status = 'approved', decided_at = ?, decided_by = ?, " +
            "decision_note = ?, execute_by = ? WHERE id = ? AND status = 'pending'",
          [decidedAt, decidedBy, trimmedNote, executeBy, approvalId],
        );
      } else {
        this.#close(current, 'rejected', undefined, { decidedAt, decidedBy, note: trimmedNote });
      }
      this.#record({
        action,
        outcome: 'success',
        actor: this.#actor(approver),
        correlationId: current.correlationId,
        consoleId: current.consoleId,
        operationId: current.operationId,
        details: { approvalId, clientId: current.clientId, risk: current.risk },
      });
      const updated = this.#load(approvalId);
      if (updated === undefined) throw new Error('Approval vanished during decision.');
      return toView(updated);
    });
  }

  #load(approvalId: string): StoredApproval | undefined {
    if (approvalId.length !== 36) return undefined;
    const row = this.#db.get('SELECT * FROM approval_requests WHERE id = ?', [approvalId]);
    return row === undefined ? undefined : toStored(row);
  }

  /** Must run inside a transaction. Returns the record after any time-based expiry. */
  #expireIfDue(stored: StoredApproval): StoredApproval {
    const now = this.#now().getTime();
    const due =
      (stored.status === 'pending' && now >= Date.parse(stored.expiresAt)) ||
      (stored.status === 'approved' &&
        stored.executeBy !== null &&
        now >= Date.parse(stored.executeBy));
    if (!due) return stored;
    this.#close(stored, 'expired', stored.status === 'pending' ? 'not_decided' : 'not_resumed');
    return { ...stored, status: 'expired', argumentsSecretId: null };
  }

  /** Closes an open request and deletes its stored arguments. Must run inside a transaction. */
  #close(
    stored: StoredApproval,
    to: 'expired' | 'invalidated' | 'rejected',
    reason: string | undefined,
    decision?: { decidedAt: string; decidedBy: string; note: string | null },
  ): void {
    const closedAt = this.#now().toISOString();
    const changed = this.#db.run(
      'UPDATE approval_requests SET status = ?, arguments_secret_id = NULL, closed_at = ?, ' +
        'decided_at = coalesce(?, decided_at), decided_by = coalesce(?, decided_by), ' +
        'decision_note = coalesce(?, decision_note) WHERE id = ? AND status = ?',
      [
        to,
        closedAt,
        decision?.decidedAt ?? null,
        decision?.decidedBy ?? null,
        decision?.note ?? null,
        stored.id,
        stored.status,
      ],
    ).changes;
    if (changed !== 1) return;
    if (stored.argumentsSecretId !== null) this.#secrets.delete(stored.argumentsSecretId);
    if (to !== 'rejected') {
      this.#record({
        action: to === 'expired' ? 'approval.expire' : 'approval.invalidate',
        outcome: 'success',
        actor: { type: 'system' },
        correlationId: stored.correlationId,
        consoleId: stored.consoleId,
        operationId: stored.operationId,
        ...(reason === undefined ? {} : { errorCode: reason }),
        details: { approvalId: stored.id, previous: stored.status },
      });
    }
  }

  /** The audit actor: records what was attempted, including a forbidden MCP approver. */
  #actor(approver: Approver): AuditEvent['actor'] {
    const type = (approver as { type: unknown }).type;
    const rawId = (approver as { id?: unknown }).id;
    const id = typeof rawId === 'string' && rawId.trim() !== '' ? rawId.slice(0, 128) : undefined;
    if (type === 'admin' || type === 'cli' || type === 'mcp_client') return { type, id };
    return { type: 'system', id: 'unrecognised-approver' };
  }

  #record(event: Omit<AuditEvent, 'eventType'>): void {
    this.#audit.record({ eventType: 'approval', ...event });
  }
}
