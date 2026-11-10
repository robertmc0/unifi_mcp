/**
 * The single execution dispatcher (spec §3.1, §5.2, §6.1, §10; ADR 0010).
 *
 * Every transport and every tool, named or generic, executes operations only through
 * `Dispatcher.execute`, so the security gates exist exactly once:
 *
 * 1. Resolve a registered operation and validate its arguments and target strictly.
 * 2. Evaluate policy for the verified client (enqueue check).
 * 3. High-risk operations go to the approval gate and are never executed here directly.
 * 4. Writes: create the durable execution record and its `pending` audit entry in one
 *    transaction (audit before act). Idempotency keys replay the known status.
 * 5. Rate limits, then the bounded fair scheduler.
 * 6. Writes take the resource lock. Then policy is evaluated again (dispatch check: hard
 *    lock, revocation, policy changes) and the execution moves `queued → executing`
 *    atomically before anything is sent upstream.
 * 7. Upstream call with a timeout. Reads retry transient failures with backoff; writes are
 *    retried only when the request provably was not sent. An uncertain write result is
 *    recorded as `outcome_unknown`, never retried.
 * 8. Output is validated against the documented schema and minimised; the outcome is
 *    audited. A read result is returned only after its audit entry is stored.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  evaluate,
  PolicyError,
  type Capability,
  type ClientPolicy,
  type ConsolePolicy,
  type Decision,
  type DenyReason,
  type DeploymentOverrides,
  type PolicyStore,
  type Risk,
} from '@unifi-local-mcp/policy';
import { isStorageError, type SqliteDatabase } from '@unifi-local-mcp/storage';
import {
  AuditUnavailableError,
  redactString,
  type AuditEvent,
  type AuditLog,
  type Logger,
} from '@unifi-local-mcp/telemetry';
import * as z from 'zod';
import { requestDigest } from './digest.ts';
import type { ExecutionRecord, ExecutionStatus, ExecutionStore } from './executions.ts';
import { KeyedMutex } from './locks.ts';
import { RateLimiter, type RateLimit } from './rate-limit.ts';
import type { OperationDescriptor, OperationRegistry, Target } from './registry.ts';
import { Scheduler, SchedulerError, type SchedulerLimits } from './scheduler.ts';

/** The verified identity. It comes only from the authenticated token (spec §3.2). */
export interface Principal {
  readonly clientId: string;
}

export interface ExecutionRequest {
  operationId: string;
  consoleId?: string | undefined;
  siteId?: string | undefined;
  arguments?: unknown;
  /** Writes only. Repeating a key returns the known status instead of re-executing. */
  idempotencyKey?: string | undefined;
  /** How long the request may wait for a free slot, in milliseconds. */
  maxWaitMs?: number | undefined;
}

export type EnvelopeStatus = 'ok' | 'pending' | 'denied' | 'error' | 'approval_required';

export interface EnvelopeError {
  code: string;
  message: string;
  retryAfterMs?: number;
  issues?: { path: string; message: string }[];
}

/** The stable result shape of spec §5.2. Never contains upstream headers or credentials. */
export interface ExecutionEnvelope {
  status: EnvelopeStatus;
  operationId: string;
  consoleId: string | null;
  siteId: string | null;
  correlationId: string;
  executionId?: string;
  outcome?: ExecutionStatus;
  data?: unknown;
  pagination?: unknown;
  warnings?: string[];
  approvalId?: string;
  error?: EnvelopeError;
}

/** Fresh, server-side security state. Called on every evaluation; never cached here. */
export interface SecurityContextProvider {
  clientPolicy(clientId: string): ClientPolicy | undefined;
  consolePolicy(consoleId: string): ConsolePolicy | undefined;
  capability(consoleId: string, operation: OperationDescriptor): Capability;
  /** The module version a probe last observed, used only to explain an unsupported result. */
  observedVersion?(consoleId: string, moduleId: string): string | undefined;
}

export interface UpstreamError {
  code: string;
  /** Safe, non-sensitive text. It is redacted again before it is returned. */
  message: string;
  /** The request definitely did not reach the console (safe to retry, even for writes). */
  requestNotSent?: boolean;
  /** A temporary condition; reads may be retried. */
  transient?: boolean;
  /** For writes: the console may have applied the change (for example HTTP 5xx). */
  outcomeUncertain?: boolean;
  retryAfterMs?: number;
}

export type ExecutorOutcome =
  { ok: true; data: unknown; pagination?: unknown } | { ok: false; error: UpstreamError };

export interface ExecutionCall {
  descriptor: OperationDescriptor;
  arguments: Record<string, unknown>;
  target: Target;
  signal: AbortSignal;
  correlationId: string;
  attempt: number;
}

/** The UniFi side (step 6): HTTP transport, TLS, egress controls and response caps. */
export interface OperationExecutor {
  execute(call: ExecutionCall): Promise<ExecutorOutcome>;
}

export interface ProposalContext {
  principal: Principal;
  descriptor: OperationDescriptor;
  arguments: Record<string, unknown>;
  target: Target;
  argumentsSha256: string;
  policyVersion: number;
  effectiveRisk: Risk;
  correlationId: string;
}

/** A human-approved request that may now be resumed by its original client. */
export interface ResumableApproval {
  ok: true;
  approvalId: string;
  operationId: string;
  target: Target;
  arguments: unknown;
  argumentsSha256: string;
  policyVersion: number;
}

export interface ApprovalRefusal {
  ok: false;
  code: string;
  message: string;
}

/**
 * The human approval workflow (spec §6.5; implemented by @unifi-local-mcp/approvals). The
 * gate never executes anything: it stores proposals and answers whether one may resume.
 * Execution always goes through the dispatcher's write path.
 */
export interface ApprovalGate {
  /** True when the gate stores its state through `db` (needed for atomic consumption). */
  writesTo(db: SqliteDatabase): boolean;
  propose(context: ProposalContext): ExecutionEnvelope;
  /** Validates an approval for `principal` without consuming it. */
  checkResumable(principal: Principal, approvalId: string): ResumableApproval | ApprovalRefusal;
  /**
   * Marks an approved request as used by `executionId`. Called inside the transaction that
   * creates the execution record; returns false if it is no longer approved.
   */
  consume(approvalId: string, executionId: string): boolean;
}

export interface DispatcherLimits {
  scheduler: SchedulerLimits;
  rate: { client: RateLimit; console: RateLimit; module: RateLimit; global: RateLimit };
  defaultMaxWaitMs: number;
  maxMaxWaitMs: number;
  readRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  maxRetryAfterMs: number;
}

/** Conservative defaults: Ubiquiti documents no local API rate limits (ADR 0005). */
export const DEFAULT_DISPATCHER_LIMITS: DispatcherLimits = {
  scheduler: {
    globalConcurrency: 16,
    perKeyConcurrency: 4,
    globalQueue: 256,
    perKeyQueue: 64,
    perClientQueued: 16,
  },
  rate: {
    client: { ratePerSecond: 10, burst: 20 },
    console: { ratePerSecond: 20, burst: 40 },
    module: { ratePerSecond: 10, burst: 20 },
    global: { ratePerSecond: 50, burst: 100 },
  },
  defaultMaxWaitMs: 30_000,
  maxMaxWaitMs: 120_000,
  readRetries: 2,
  retryBaseDelayMs: 200,
  retryMaxDelayMs: 2_000,
  maxRetryAfterMs: 5_000,
};

export interface DispatcherDependencies {
  registry: OperationRegistry;
  executor: OperationExecutor;
  security: SecurityContextProvider;
  policyStore: PolicyStore;
  deployment: DeploymentOverrides;
  audit: AuditLog;
  executions: ExecutionStore;
  logger: Logger;
  approvals?: ApprovalGate;
  limits?: DispatcherLimits;
  now?: () => Date;
  random?: () => number;
}

export interface ExecutionStatusView {
  executionId: string;
  operationId: string;
  consoleId: string;
  siteId: string | null;
  outcome: ExecutionStatus;
  errorCode: string | null;
  correlationId: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

type Authorization =
  | Decision
  | { allowed: false; reason: 'policy_unavailable'; stage: 0; message: string; policyVersion: 0 };

interface Context {
  principal: Principal;
  descriptor: OperationDescriptor;
  args: Record<string, unknown>;
  target: Target;
  correlationId: string;
  startedMs: number;
  startBy: number;
  base: Pick<ExecutionEnvelope, 'operationId' | 'consoleId' | 'siteId' | 'correlationId'>;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class ApprovalAlreadyUsed extends Error {}
/** The request envelope itself is validated at runtime: the dispatcher is the boundary. */
const RequestSchema = z.strictObject({
  operationId: z.string().max(128),
  consoleId: z.string().max(128).optional(),
  siteId: z.string().max(128).optional(),
  arguments: z.unknown().optional(),
  idempotencyKey: z.string().max(128).optional(),
  maxWaitMs: z.number().int().nonnegative().optional(),
});
const OPERATION_ID_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const SAFE_VERSION = /^[0-9][0-9A-Za-z.+-]{0,63}$/;

const MESSAGES: Record<string, string> = {
  unknown_operation: 'No registered operation has this id.',
  invalid_arguments: 'The arguments do not match the operation schema.',
  invalid_target: 'consoleId or siteId is malformed or not applicable to this operation.',
  invalid_request: 'The request is malformed.',
  approval_unavailable: 'This operation requires human approval, which is not available.',
  rate_limited: 'Too many requests; retry later.',
  idempotency_key_conflict: 'This idempotency key was already used for a different request.',
  upstream_contract_mismatch:
    'The console response did not match the documented schema, so it was withheld.',
  upstream_timeout: 'The console did not answer in time.',
  upstream_error: 'The console request failed.',
  outcome_unknown:
    'The console may or may not have applied this change. It was not retried; check its ' +
    'state before trying again.',
  audit_unavailable: 'The audit trail cannot be written, so the operation was refused.',
  policy_unavailable: 'The security policy is unavailable, so every operation is refused.',
  internal_error: 'The request failed inside the service.',
  approval_not_found: 'No approval with this id exists for this client.',
  approval_invalidated:
    'The approval no longer matches the current request or security policy; propose again.',
  approval_already_used: 'This approval has already been used.',
  audit_after_write:
    'The outcome below is recorded in the execution record, but its audit entry could not ' +
    'be written.',
  cancelled: 'The request was cancelled before it was sent to the console.',
  queue_full: 'Too many requests are waiting; try again later.',
  deadline_exceeded: 'The request could not start before its deadline.',
  shutting_down: 'The service is shutting down.',
};

function message(code: string): string {
  return MESSAGES[code] ?? 'The request failed.';
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

export class Dispatcher {
  readonly #deps: DispatcherDependencies;
  readonly #limits: DispatcherLimits;
  readonly #now: () => Date;
  readonly #random: () => number;
  readonly #scheduler: Scheduler;
  readonly #rateLimiter: RateLimiter;
  readonly #locks = new KeyedMutex();

  constructor(deps: DispatcherDependencies) {
    if (!deps.audit.writesTo(deps.executions.database)) {
      throw new TypeError('Dispatcher needs the AuditLog and ExecutionStore on one connection.');
    }
    if (deps.approvals !== undefined && !deps.approvals.writesTo(deps.executions.database)) {
      throw new TypeError(
        'Dispatcher needs the ApprovalGate and ExecutionStore on one connection.',
      );
    }
    this.#deps = deps;
    this.#limits = deps.limits ?? DEFAULT_DISPATCHER_LIMITS;
    this.#now = deps.now ?? (() => new Date());
    this.#random = deps.random ?? Math.random;
    this.#scheduler = new Scheduler(this.#limits.scheduler);
    this.#rateLimiter = new RateLimiter();
  }

  async execute(principal: Principal, request: ExecutionRequest): Promise<ExecutionEnvelope> {
    const correlationId = randomUUID();
    const raw = request as unknown as Partial<Record<string, unknown>>;
    const base = {
      operationId: typeof raw['operationId'] === 'string' ? raw['operationId'].slice(0, 128) : '',
      consoleId: validId(raw['consoleId']) ? raw['consoleId'] : null,
      siteId: validId(raw['siteId']) ? raw['siteId'] : null,
      correlationId,
    };
    try {
      return await this.#execute(principal, request, base);
    } catch (error) {
      if (error instanceof AuditUnavailableError) {
        return { ...base, status: 'error', error: this.#error('audit_unavailable') };
      }
      this.#deps.logger.error('dispatcher failure', {
        correlationId,
        clientId: principal.clientId,
        operationId: base.operationId,
        err: error,
      });
      return { ...base, status: 'error', error: this.#error('internal_error') };
    }
  }

  /**
   * Executes a human-approved request for its original client (spec §6.5). Everything is
   * checked again: the approval (state, expiry, client, policy version, argument digest),
   * then the full policy including the hard lock, then the normal write path. The approval
   * is consumed in the transaction that creates the execution, so it runs at most once.
   */
  async resume(principal: Principal, approvalId: string): Promise<ExecutionEnvelope> {
    const correlationId = randomUUID();
    const base = { operationId: '', consoleId: null, siteId: null, correlationId };
    try {
      return await this.#resume(principal, approvalId, base);
    } catch (error) {
      if (error instanceof AuditUnavailableError) {
        return { ...base, status: 'error', error: this.#error('audit_unavailable') };
      }
      this.#deps.logger.error('dispatcher failure during resume', {
        correlationId,
        clientId: principal.clientId,
        err: error,
      });
      return { ...base, status: 'error', error: this.#error('internal_error') };
    }
  }

  async #resume(
    principal: Principal,
    approvalId: string,
    base: Context['base'],
  ): Promise<ExecutionEnvelope> {
    const startedMs = performance.now();
    const refuse = (code: string, text = message(code)): ExecutionEnvelope => {
      this.#deps.audit.record({
        eventType: 'approval',
        action: 'approval.resume',
        outcome: 'denied',
        actor: { type: 'mcp_client', id: principal.clientId },
        correlationId: base.correlationId,
        errorCode: code,
        durationMs: performance.now() - startedMs,
        details: UUID_PATTERN.test(approvalId) ? { approvalId } : {},
      });
      return { ...base, status: 'denied', error: { code, message: text } };
    };
    const gate = this.#deps.approvals;
    if (gate === undefined) return refuse('approval_unavailable');
    if (!UUID_PATTERN.test(approvalId)) return refuse('approval_not_found');
    const claim = gate.checkResumable(principal, approvalId);
    if (!claim.ok) return refuse(claim.code, claim.message);

    const descriptor = this.#deps.registry.get(claim.operationId);
    if (descriptor?.effect !== 'write') return refuse('approval_invalidated');
    const parsed = descriptor.inputSchema.safeParse(claim.arguments);
    if (!parsed.success) return refuse('approval_invalidated');
    const context: Context = {
      principal,
      descriptor,
      args: parsed.data,
      target: claim.target,
      correlationId: base.correlationId,
      startedMs,
      startBy: Date.now() + this.#limits.defaultMaxWaitMs,
      base: {
        operationId: claim.operationId,
        consoleId: claim.target.consoleId,
        siteId: claim.target.siteId ?? null,
        correlationId: base.correlationId,
      },
    };
    // The stored arguments must still be exactly the approved ones.
    if (this.#digest(context) !== claim.argumentsSha256) return refuse('approval_invalidated');
    const decision = this.#authorize(context);
    if (!decision.allowed) return this.#denied(context, decision);
    if (decision.policyVersion !== claim.policyVersion) return refuse('approval_invalidated');
    return this.#runWrite(context, decision, undefined, claim.approvalId);
  }

  /** Status of one of this client's own executions; other clients' ids are not found. */
  status(principal: Principal, executionId: string): ExecutionStatusView | undefined {
    if (executionId.length !== 36) return undefined;
    const record = this.#deps.executions.get(executionId);
    if (record?.clientId !== principal.clientId) return undefined;
    return {
      executionId: record.id,
      operationId: record.operationId,
      consoleId: record.consoleId,
      siteId: record.siteId,
      outcome: record.status,
      errorCode: record.errorCode,
      correlationId: record.correlationId,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
    };
  }

  /** Cancels a client's queued work, for example when its token is revoked. */
  cancelClient(clientId: string): number {
    return this.#scheduler.cancelClient(clientId);
  }

  /** Cancels all queued work, for example after a switch to read-only mode. */
  cancelAll(): number {
    return this.#scheduler.cancelAll();
  }

  /** Stops accepting work and waits for running operations to finish (graceful shutdown). */
  drain(): Promise<void> {
    return this.#scheduler.drain();
  }

  /**
   * Resolves executions a previous process left open: `executing` becomes
   * `outcome_unknown` (never re-run), `queued` becomes `cancelled`. Call once at startup.
   */
  recoverInterrupted(): { outcomeUnknown: number; cancelled: number } {
    const result = { outcomeUnknown: 0, cancelled: 0 };
    for (const record of this.#deps.executions.interrupted()) {
      const to = record.status === 'executing' ? 'outcome_unknown' : 'cancelled';
      this.#deps.executions.database.transaction(() => {
        if (!this.#deps.executions.transition(record.id, record.status, to, 'service_restarted')) {
          return;
        }
        this.#deps.audit.record({
          eventType: 'mcp.operation',
          action: 'operation.recover',
          outcome: to === 'outcome_unknown' ? 'outcome_unknown' : 'failure',
          actor: { type: 'system' },
          correlationId: record.correlationId,
          consoleId: record.consoleId,
          operationId: record.operationId,
          errorCode: 'service_restarted',
          details: { executionId: record.id, clientId: record.clientId, previous: record.status },
        });
        result[to === 'outcome_unknown' ? 'outcomeUnknown' : 'cancelled']++;
      });
    }
    return result;
  }

  async #execute(
    principal: Principal,
    request: ExecutionRequest,
    base: Context['base'],
  ): Promise<ExecutionEnvelope> {
    const startedMs = performance.now();
    const actor = { type: 'mcp_client' as const, id: principal.clientId };
    const reject = (
      status: 'error' | 'denied',
      code: string,
      auditOutcome: 'failure' | 'denied',
      extra: Partial<EnvelopeError> = {},
    ): ExecutionEnvelope => {
      this.#deps.audit.record({
        eventType: 'mcp.operation',
        action: 'operation.execute',
        outcome: auditOutcome,
        actor,
        correlationId: base.correlationId,
        consoleId: base.consoleId ?? undefined,
        operationId: OPERATION_ID_PATTERN.test(base.operationId) ? base.operationId : undefined,
        errorCode: code,
        durationMs: performance.now() - startedMs,
      });
      return { ...base, status, error: { ...this.#error(code), ...extra } };
    };

    const shape = RequestSchema.safeParse(request);
    if (!shape.success) return reject('error', 'invalid_request', 'failure');
    request = shape.data;
    const descriptor = OPERATION_ID_PATTERN.test(request.operationId)
      ? this.#deps.registry.get(request.operationId)
      : undefined;
    if (descriptor === undefined) return reject('error', 'unknown_operation', 'denied');

    // Targets are explicit and well-formed; site only where the operation takes one.
    if (
      !validId(request.consoleId) ||
      (request.siteId !== undefined && (!validId(request.siteId) || !descriptor.siteScoped))
    ) {
      return reject('error', 'invalid_target', 'failure');
    }
    if (
      request.idempotencyKey !== undefined &&
      (descriptor.effect !== 'write' || !IDEMPOTENCY_KEY_PATTERN.test(request.idempotencyKey))
    ) {
      return reject('error', 'invalid_request', 'failure');
    }
    const parsed = descriptor.inputSchema.safeParse(request.arguments ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 20).map((issue) => ({
        path: issue.path.map(String).join('.') || '(root)',
        message: redactString(issue.message, 200),
      }));
      return reject('error', 'invalid_arguments', 'failure', { issues });
    }
    const target: Target = { consoleId: request.consoleId, siteId: request.siteId };
    const maxWait = Math.min(
      Math.max(request.maxWaitMs ?? this.#limits.defaultMaxWaitMs, 0),
      this.#limits.maxMaxWaitMs,
    );
    const context: Context = {
      principal,
      descriptor,
      args: parsed.data,
      target,
      correlationId: base.correlationId,
      startedMs,
      startBy: Date.now() + maxWait,
      base,
    };

    const decision = this.#authorize(context);
    if (!decision.allowed) return this.#denied(context, decision);
    if (decision.approvalRequired) {
      if (this.#deps.approvals === undefined)
        return reject('denied', 'approval_unavailable', 'denied');
      return this.#deps.approvals.propose({
        principal,
        descriptor,
        arguments: context.args,
        target,
        argumentsSha256: this.#digest(context),
        policyVersion: decision.policyVersion,
        effectiveRisk: decision.effectiveRisk,
        correlationId: base.correlationId,
      });
    }
    return descriptor.effect === 'read'
      ? this.#runRead(context)
      : this.#runWrite(context, decision, request.idempotencyKey);
  }

  #authorize(context: Context): Authorization {
    let snapshot;
    try {
      snapshot = this.#deps.policyStore.current();
    } catch (error) {
      if (!(error instanceof PolicyError)) throw error;
      this.#deps.logger.error('security policy unavailable; denying', { err: error });
      return {
        allowed: false,
        reason: 'policy_unavailable',
        stage: 0,
        message: message('policy_unavailable'),
        policyVersion: 0,
      };
    }
    const client = this.#deps.security.clientPolicy(context.principal.clientId);
    if (client?.clientId !== context.principal.clientId) {
      return {
        allowed: false,
        reason: 'client_inactive',
        stage: 1,
        message: 'This client is disabled or revoked.',
        policyVersion: snapshot.version,
      };
    }
    const consolePolicy = this.#deps.security.consolePolicy(context.target.consoleId);
    return evaluate({
      now: this.#now(),
      deployment: this.#deps.deployment,
      policy: { version: snapshot.version, document: snapshot.document },
      client,
      console: consolePolicy,
      operation: context.descriptor,
      target: context.target,
      capability:
        consolePolicy === undefined
          ? 'unknown'
          : this.#deps.security.capability(context.target.consoleId, context.descriptor),
      purpose: 'execute',
    });
  }

  #denied(
    context: Context,
    decision: { reason: DenyReason | 'policy_unavailable'; stage: number; message: string },
    execution?: ExecutionRecord,
  ): ExecutionEnvelope {
    this.#audit(context, {
      outcome: 'denied',
      errorCode: decision.reason,
      details: {
        stage: decision.stage,
        effect: context.descriptor.effect,
        ...(execution === undefined ? {} : { executionId: execution.id }),
      },
    });
    return {
      ...context.base,
      status: 'denied',
      ...(execution === undefined ? {} : { executionId: execution.id, outcome: 'denied' as const }),
      error: {
        code: decision.reason,
        message:
          decision.reason === 'operation_unsupported'
            ? this.#unsupportedMessage(context, decision.message)
            : decision.message,
      },
    };
  }

  /** Names the observed version and the verified range, so the operator knows what to do. */
  #unsupportedMessage(context: Context, base: string): string {
    const { moduleId, apiVersionRange } = context.descriptor;
    const observed = this.#deps.security.observedVersion?.(context.target.consoleId, moduleId);
    // The version string comes from the console: it is shown only if it looks like one.
    const shown =
      observed !== undefined && SAFE_VERSION.test(observed) ? observed : 'an unrecognised version';
    return `${base} The console reports ${moduleId} ${shown}; this operation is verified for ${apiVersionRange}.`;
  }

  #rateLimit(context: Context): number | undefined {
    const { rate } = this.#limits;
    const { consoleId } = context.target;
    const result = this.#rateLimiter.take([
      { key: `client:${context.principal.clientId}`, limit: rate.client },
      { key: `console:${consoleId}`, limit: rate.console },
      { key: `module:${consoleId}/${context.descriptor.moduleId}`, limit: rate.module },
      { key: 'global', limit: rate.global },
    ]);
    return result.ok ? undefined : result.retryAfterMs;
  }

  #schedulerKey(context: Context): string {
    return `${context.target.consoleId}/${context.descriptor.moduleId}`;
  }

  async #runRead(context: Context): Promise<ExecutionEnvelope> {
    const retryAfterMs = this.#rateLimit(context);
    if (retryAfterMs !== undefined) return this.#failure(context, 'rate_limited', { retryAfterMs });
    try {
      return await this.#scheduler.run(
        {
          key: this.#schedulerKey(context),
          clientId: context.principal.clientId,
          startBy: context.startBy,
        },
        async () => {
          const decision = this.#authorize(context);
          if (!decision.allowed) return this.#denied(context, decision);
          const outcome = await this.#callWithRetries(context);
          if (!outcome.ok) return this.#failure(context, outcome.error.code, {}, outcome.error);
          const output = context.descriptor.outputSchema.safeParse(outcome.data);
          if (!output.success) return this.#failure(context, 'upstream_contract_mismatch');
          const data =
            context.descriptor.project === undefined
              ? output.data
              : context.descriptor.project(output.data);
          const pagination = context.descriptor.pagination?.(output.data) ?? outcome.pagination;
          // The read is returned only once its audit entry is stored.
          this.#audit(context, { outcome: 'success' });
          return {
            ...context.base,
            status: 'ok',
            data,
            ...(pagination === undefined ? {} : { pagination }),
          };
        },
      );
    } catch (error) {
      if (error instanceof SchedulerError) return this.#failure(context, error.code);
      throw error;
    }
  }

  async #runWrite(
    context: Context,
    decision: Extract<Decision, { allowed: true }>,
    idempotencyKey: string | undefined,
    approvalId?: string,
  ): Promise<ExecutionEnvelope> {
    const { executions } = this.#deps;
    const argumentsSha256 = this.#digest(context);
    if (idempotencyKey !== undefined) {
      const existing = executions.findByIdempotencyKey(context.principal.clientId, idempotencyKey);
      if (existing !== undefined) return this.#replay(context, existing, argumentsSha256);
    }
    const retryAfterMs = this.#rateLimit(context);
    if (retryAfterMs !== undefined) return this.#failure(context, 'rate_limited', { retryAfterMs });

    let execution: ExecutionRecord;
    try {
      execution = executions.database.transaction(() => {
        const record = executions.create({
          clientId: context.principal.clientId,
          operationId: context.descriptor.operationId,
          consoleId: context.target.consoleId,
          siteId: context.target.siteId,
          argumentsSha256,
          idempotencyKey,
          policyVersion: decision.policyVersion,
          correlationId: context.correlationId,
        });
        this.#audit(context, {
          action: 'operation.enqueue',
          outcome: 'pending',
          details: {
            executionId: record.id,
            argumentsSha256,
            effectiveRisk: decision.effectiveRisk,
            policyVersion: decision.policyVersion,
            ...(approvalId === undefined ? {} : { approvalId }),
          },
        });
        // Single use: the approval is consumed atomically with the execution record.
        if (
          approvalId !== undefined &&
          this.#deps.approvals?.consume(approvalId, record.id) !== true
        ) {
          throw new ApprovalAlreadyUsed();
        }
        return record;
      });
    } catch (error) {
      if (error instanceof ApprovalAlreadyUsed)
        return this.#failure(context, 'approval_already_used');
      // A concurrent request with the same idempotency key won the insert.
      if (idempotencyKey !== undefined && isStorageError(error, 'STORAGE_CONSTRAINT')) {
        const existing = executions.findByIdempotencyKey(
          context.principal.clientId,
          idempotencyKey,
        );
        if (existing !== undefined) return this.#replay(context, existing, argumentsSha256);
      }
      throw error;
    }

    const withExecution = { executionId: execution.id };
    try {
      return await this.#scheduler.run(
        {
          key: this.#schedulerKey(context),
          clientId: context.principal.clientId,
          startBy: context.startBy,
        },
        async () => {
          const lockKey = `${context.target.consoleId}/${String(
            context.descriptor.resourceLockKey?.(context.args, context.target),
          )}`;
          let release: () => void;
          try {
            release = await this.#locks.acquire(
              lockKey,
              AbortSignal.timeout(Math.max(1, context.startBy - Date.now())),
            );
          } catch {
            return this.#closeWrite(context, execution, 'queued', 'cancelled', 'deadline_exceeded');
          }
          try {
            // Dispatch check, as close to execution as possible (spec §6.1 stage 9).
            const recheck = this.#authorize(context);
            if (!recheck.allowed) {
              executions.transition(execution.id, 'queued', 'denied', recheck.reason);
              return this.#denied(context, recheck, execution);
            }
            if (!executions.transition(execution.id, 'queued', 'executing')) {
              const current = executions.get(execution.id);
              return {
                ...context.base,
                ...withExecution,
                status: 'error',
                outcome: current?.status ?? 'cancelled',
                error: this.#error('cancelled'),
              };
            }
            const outcome = await this.#callWithRetries(context);
            if (outcome.ok) {
              executions.transition(execution.id, 'executing', 'succeeded');
              const output = context.descriptor.outputSchema.safeParse(outcome.data);
              const audited = this.#tryAudit(context, {
                outcome: 'success',
                details: withExecution,
              });
              const envelope: ExecutionEnvelope = {
                ...context.base,
                ...withExecution,
                status: 'ok',
                outcome: 'succeeded',
                ...(audited ? {} : { warnings: [message('audit_after_write')] }),
              };
              if (output.success) {
                envelope.data =
                  context.descriptor.project === undefined
                    ? output.data
                    : context.descriptor.project(output.data);
              } else {
                envelope.warnings = [
                  ...(envelope.warnings ?? []),
                  message('upstream_contract_mismatch'),
                ];
              }
              return envelope;
            }
            const uncertain = outcome.error.outcomeUncertain === true;
            return this.#closeWrite(
              context,
              execution,
              'executing',
              uncertain ? 'outcome_unknown' : 'failed',
              uncertain ? 'outcome_unknown' : outcome.error.code,
              outcome.error,
            );
          } finally {
            release();
          }
        },
      );
    } catch (error) {
      if (error instanceof SchedulerError) {
        return this.#closeWrite(context, execution, 'queued', 'cancelled', error.code);
      }
      throw error;
    }
  }

  #closeWrite(
    context: Context,
    execution: ExecutionRecord,
    from: ExecutionStatus,
    to: ExecutionStatus,
    code: string,
    upstream?: UpstreamError,
  ): ExecutionEnvelope {
    this.#deps.executions.transition(execution.id, from, to, code);
    const audited = this.#tryAudit(context, {
      outcome: to === 'outcome_unknown' ? 'outcome_unknown' : 'failure',
      errorCode: code,
      details: { executionId: execution.id },
    });
    if (to === 'outcome_unknown') {
      this.#deps.logger.warn('write outcome unknown; not retried', {
        correlationId: context.correlationId,
        executionId: execution.id,
        operationId: context.descriptor.operationId,
        consoleId: context.target.consoleId,
      });
    }
    return {
      ...context.base,
      executionId: execution.id,
      status: 'error',
      outcome: to,
      error: this.#upstreamOrOwnError(code, upstream),
      ...(audited ? {} : { warnings: [message('audit_after_write')] }),
    };
  }

  #replay(context: Context, existing: ExecutionRecord, argumentsSha256: string): ExecutionEnvelope {
    if (
      existing.operationId !== context.descriptor.operationId ||
      existing.argumentsSha256 !== argumentsSha256
    ) {
      return this.#failure(context, 'idempotency_key_conflict');
    }
    this.#audit(context, {
      action: 'operation.replay',
      outcome: 'success',
      details: { executionId: existing.id, outcome: existing.status },
    });
    const envelope: ExecutionEnvelope = {
      ...context.base,
      executionId: existing.id,
      outcome: existing.status,
      status:
        existing.status === 'succeeded'
          ? 'ok'
          : existing.status === 'queued' || existing.status === 'executing'
            ? 'pending'
            : existing.status === 'denied'
              ? 'denied'
              : 'error',
      warnings: ['Idempotency key reused: returned the known status; nothing was re-executed.'],
    };
    if (envelope.status === 'error' || envelope.status === 'denied') {
      envelope.error = this.#error(existing.errorCode ?? existing.status);
    }
    return envelope;
  }

  #failure(
    context: Context,
    code: string,
    extra: Partial<EnvelopeError> = {},
    upstream?: UpstreamError,
  ): ExecutionEnvelope {
    this.#audit(context, { outcome: 'failure', errorCode: code });
    return {
      ...context.base,
      status: 'error',
      error: { ...this.#upstreamOrOwnError(code, upstream), ...extra },
    };
  }

  #upstreamOrOwnError(code: string, upstream: UpstreamError | undefined): EnvelopeError {
    if (upstream === undefined || code in MESSAGES) return this.#error(code);
    return { code: redactString(upstream.code, 64), message: redactString(upstream.message, 300) };
  }

  #error(code: string): EnvelopeError {
    return { code, message: message(code) };
  }

  #audit(context: Context, event: Partial<AuditEvent> & Pick<AuditEvent, 'outcome'>): void {
    this.#deps.audit.record({
      eventType: 'mcp.operation',
      action: 'operation.execute',
      actor: { type: 'mcp_client', id: context.principal.clientId },
      correlationId: context.correlationId,
      consoleId: context.target.consoleId,
      application: context.descriptor.moduleId,
      operationId: context.descriptor.operationId,
      durationMs: performance.now() - context.startedMs,
      ...event,
    });
  }

  /**
   * For outcomes of writes whose execution record is already final: the durable record is
   * the truth, so an audit failure must not hide the outcome from the client. The failure
   * is in the runtime log (AuditLog) and the client gets a warning.
   */
  #tryAudit(context: Context, event: Partial<AuditEvent> & Pick<AuditEvent, 'outcome'>): boolean {
    try {
      this.#audit(context, event);
      return true;
    } catch (error) {
      if (error instanceof AuditUnavailableError) return false;
      throw error;
    }
  }

  #digest(context: Context): string {
    return requestDigest({
      operationId: context.descriptor.operationId,
      consoleId: context.target.consoleId,
      siteId: context.target.siteId,
      arguments: context.args,
    });
  }

  async #callWithRetries(context: Context): Promise<ExecutorOutcome> {
    const isRead = context.descriptor.effect === 'read';
    const retryDeadline =
      Date.now() + (this.#limits.readRetries + 1) * context.descriptor.timeoutMs;
    for (let attempt = 1; ; attempt++) {
      const outcome = await this.#callOnce(context, attempt);
      if (outcome.ok) return outcome;
      const { error } = outcome;
      const retryable = error.requestNotSent === true || (isRead && error.transient === true);
      if (!retryable || attempt > this.#limits.readRetries) return outcome;
      const backoff = Math.min(
        this.#limits.retryMaxDelayMs,
        this.#limits.retryBaseDelayMs * 2 ** (attempt - 1),
      );
      const delay =
        error.retryAfterMs === undefined
          ? Math.round(backoff * this.#random())
          : Math.min(error.retryAfterMs, this.#limits.maxRetryAfterMs);
      if (Date.now() + delay > retryDeadline) return outcome;
      await sleep(delay);
    }
  }

  async #callOnce(context: Context, attempt: number): Promise<ExecutorOutcome> {
    const controller = new AbortController();
    const isWrite = context.descriptor.effect === 'write';
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<ExecutorOutcome>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error('upstream timeout'));
        resolve({
          ok: false,
          error: {
            code: 'upstream_timeout',
            message: message('upstream_timeout'),
            transient: true,
            outcomeUncertain: true,
          },
        });
      }, context.descriptor.timeoutMs);
    });
    const call = this.#deps.executor
      .execute({
        descriptor: context.descriptor,
        arguments: context.args,
        target: context.target,
        signal: controller.signal,
        correlationId: context.correlationId,
        attempt,
      })
      .catch((error: unknown): ExecutorOutcome => {
        this.#deps.logger.warn('executor failure', {
          correlationId: context.correlationId,
          operationId: context.descriptor.operationId,
          err: error,
        });
        return {
          ok: false,
          error: {
            code: 'upstream_error',
            message: message('upstream_error'),
            transient: !isWrite,
            // An exception during a write may have happened after the request was sent.
            outcomeUncertain: isWrite,
          },
        };
      });
    try {
      return await Promise.race([call, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
