# 0010. Operation registry and the central dispatcher

- Status: Accepted
- Date: 2026-11-10
- Phase: 1
- Spec references: §3.1, §4.3, §4.4, §5.2, §6.1 (stage 9), §6.5, §10, §12, §17

## Context

Spec §3.1 requires one execution dispatcher for every transport, and AGENTS.md requires
security gates implemented once, centrally, so named and generic tools cannot bypass them.
§4.3 defines the operation descriptor and requires that generated schemas never change
security metadata. §4.4 requires fixed path templates with segment-encoded parameters, fixed
methods and no user-controlled URL, host or headers. §10 requires rate limits per client,
console, application and globally; bounded fair queues with deadlines and cancellation;
resource locks for conflicting writes; checks at enqueue and dispatch; safe retries for
reads only; `outcome_unknown` for uncertain writes; durable operation ids with atomic
transitions; and idempotency keys that return the known status. ADR 0008 requires audit
before act. This ADR records how `packages/core` implements these.

## Decision

### Registry

- `OperationDescriptor` follows spec §4.3 and extends the reviewed `OperationSecurity`
  (ADR 0009), plus `contractRevision`, `timeoutMs`, `siteScoped` and optional `project`
  (output minimisation). `defineOperation()` infers argument and output types from the
  schemas for adapter authors.
- Registration fails (stopping startup) unless: the security metadata is consistent; the
  `httpMethod pathTemplate` pair is in the official contract for that module and revision,
  answered by an injected `ContractInventory` built from `api-specs/<app>/<revision>/operations.json`;
  `GET` implies a read; reads, and only reads, use retry class `safe-read`; writes have a
  `resourceLockKey`; the input schema is a **strict** object (unknown arguments are
  rejected, never forwarded); every path placeholder maps to an input field (or `{siteId}`
  for site-scoped operations); `consoleId` and `siteId` are targets, never arguments; the
  template has no query, fragment, dot segment or percent-encoding; the timeout is between
  100 ms and 120 s; the description is at most 300 characters. The registry is sealed after
  startup.
- `renderPath()` turns every value into exactly one percent-encoded path segment, so a value
  cannot add segments, traverse upwards or carry a query.

### Dispatcher pipeline

`Dispatcher.execute(principal, request)`. The principal comes only from the verified token;
the request envelope is itself validated with a strict schema, so a `clientId` or
`baseUrl` field is refused rather than ignored.

1. Resolve the registered operation, validate the target format (`consoleId` required;
   `siteId` only for site-scoped operations) and the arguments.
2. Policy evaluation with fresh client, console and capability state (enqueue check).
3. Approval required → `ApprovalGate.propose()` (step 5) with the request digest and policy
   version; without a gate, denied as `approval_unavailable`. The dispatcher never executes
   such a request itself.
4. Writes: idempotency key lookup (per client); then the `operation_executions` row
   (`queued`) and its `operation.enqueue`/`pending` audit entry in one transaction. If that
   audit entry cannot be written, nothing is recorded and nothing is sent.
5. Rate limits: token buckets for client, console, console module and global, taken all or
   nothing.
6. Scheduler slot (key = console module).
7. Writes: resource lock `consoleId/resourceLockKey(args, target)`, bounded by the request's
   wait deadline.
8. **Dispatch check**: policy evaluated again after the wait (hard lock, revocation, runtime
   mode and every other stage). Writes then move `queued → executing` by compare-and-set;
   if the record was closed elsewhere meanwhile, nothing is sent.
9. Upstream call through `OperationExecutor` (step 6), bounded by the operation timeout,
   which also aborts the executor's signal.
10. Output validated against the documented schema and minimised by `project`. Reads
    are returned only after their audit entry is stored; a read whose response does not
    match the schema is withheld (`upstream_contract_mismatch`).

### Retries and uncertain writes

- Reads retry `transient` failures with full-jitter exponential backoff (defaults: 2
  retries, 200 ms base, 2 s cap), or after the upstream `retryAfterMs` (capped at 5 s).
- Any operation may retry when the executor reports `requestNotSent` (the request provably
  never reached the console).
- A write is never retried otherwise. A timeout, an executor exception or an upstream error
  marked `outcomeUncertain` becomes `outcome_unknown`, which is logged as a warning and
  audited. Read-back reconciliation is adapter-specific (Phase 2).

### Durable executions

Storage migration 4 (`operation_executions`): server-generated UUID, client, operation,
target, argument digest, optional idempotency key (unique per client), status, policy
version, correlation id, error code and timestamps. Status moves only forward by
compare-and-set: `queued → executing → succeeded | failed | outcome_unknown`, or
`queued → cancelled | denied`. At startup, `recoverInterrupted()` turns `executing` into
`outcome_unknown` and `queued` into `cancelled` (audited, never re-run). Reads are not
recorded here (the audit trail has them), and write results are not persisted: an
idempotent replay returns the known status, not the data.

### Idempotency

The key is valid only for writes. The same key from the same client with the same
operation and argument digest returns the known status (`ok`, `pending`, `denied` or
`error`) with a warning and executes nothing; a different request with that key is
`idempotency_key_conflict`. A concurrent duplicate that loses the insert race is caught by
the unique index and replayed. The key never replaces server-side checks: policy is
evaluated first.

### Limits (defaults, conservative because vendor limits are undocumented)

| Limit                      | Default                                                          |
| -------------------------- | ---------------------------------------------------------------- |
| Concurrency                | 16 global, 4 per console module                                  |
| Queues                     | 256 global, 64 per console module, 16 per client                 |
| Rates (per second / burst) | client 10/20, console 20/40, console module 10/20, global 50/100 |
| Wait for a slot            | 30 s default, 120 s maximum                                      |

**Configuration and load tests, 2026-11-16 (Phase 5 step 7).** "Exposing them in
configuration" was deferred here in Phase 1 and then not picked up; spec §10 asks for
configurable limits. The rates, the two concurrency limits and the three queue sizes are
now deployment settings (`UNIFI_MCP_RATE_*`, `UNIFI_MCP_CONCURRENCY_*`,
`UNIFI_MCP_QUEUE_*`, [configuration.md](../configuration.md#limits)), validated at start,
with the table above as defaults. Each rate applies to every client, console or console
module alike; there is no per-client override. Wait times and retry counts stay in code.

The rules above are also tested under volume (`tests/performance/`, part of
`npm run check`):

- 600 simultaneous reads from 10 clients to 4 consoles: the global and per-module
  concurrency caps are reached and never passed; every read is answered once and audited
  once; nothing stays queued.
- Bounded queues: with a busy console, exactly the configured number of requests wait and
  the rest are refused at once; one client cannot take more than its share.
- Fairness: a client with one request is served before a backlog of 29 from another.
- Deadlines: 50 waiting requests fail on time and none runs afterwards.
- Rates: of 500 requests at once, a bucketful passes and the rest get a retry time; one
  client's limit does not slow another.
- Writes: 100 simultaneous requests with one idempotency key reach the console once; 80
  writes to two devices each run exactly once, never two at a time on one device;
  uncertain outcomes are recorded once and not retried.
- Revocation cancels a client's 25 queued requests and only those.
- The whole service over HTTP with the shipped limits: 200 reads from 8 clients are all
  answered (`ok` or a stated limit), the console sees at most 4 at once, and the metrics
  and the audit trail add up to 200. Limits set through the environment are applied.

Measured on the development machine on 2026-11-16 (Node.js 26.13.0, linux/amd64, an
instant synthetic console): about 500 audited reads per second through the dispatcher,
one after another or all at once. The cost is the audit entry, a synchronous SQLite
commit per request. This is a single observation, not a benchmark; the test asserts only
a floor of 100 per second. The default global rate limit is 50 per second.

Waiting clients are served round-robin within a key and keys round-robin overall. Queued
work can be cancelled per client (revocation) or entirely (read-only switch, shutdown).
`drain()` stops intake and waits for running operations.

### Envelope (spec §5.2)

`status` (`ok`, `pending`, `denied`, `error`, `approval_required`), `operationId`,
`consoleId`, `siteId`, `correlationId`, and for writes `executionId` and `outcome`;
`data` and `pagination` for successful results; `warnings`; and `error` with a stable
`code`, a safe message, optional `retryAfterMs` and argument `issues` (paths and messages,
never values). Executor messages are redacted again before they are returned. Upstream
headers and credentials never appear.

### Audit after a write has run

When a write has already been executed, its execution record is the truth. If the final
audit entry then fails, the outcome is still returned with a warning (the failure is in the
runtime log), instead of hiding from the client a change that happened.

## Evidence (verified 2026-11-10)

- `tests/unit/core/` and `tests/security/dispatcher-gates.test.ts`: 52 tests, including the
  Phase 1 gate cases "hard lock denies registered writes via `unifi_execute` and queued
  work", "generic execution cannot reach an unregistered path, alternate URL or arbitrary
  verb", revocation of queued reads and writes, audit before act, and restart recovery.
- Mutation checks, each making at least one test fail: write and read dispatch re-checks
  removed; pending audit skipped; writes retried on transient errors; read output not
  validated; read returned without audit; resource lock removed; approval requirement
  ignored; request envelope not strict; compare-and-set result ignored; contract inventory
  not checked; path values not encoded; both idempotency replay layers removed.

## Consequences

- One service instance per data directory is still assumed for locks and the scheduler
  (they are in memory). The durable compare-and-set prevents double execution even if two
  processes race, but cross-process fairness and locking would need a different design.
- The approval gate (step 5) plugs into `ApprovalGate` and resumes through the same
  dispatch path, so approved actions get the same dispatch check and hard lock.
- ~~Limits are code defaults for now. Exposing them in configuration is part of the service
  configuration in step 7/9.~~ Done in Phase 5 step 7 (see "Limits").

## Re-evaluation triggers

- Ubiquiti publishing local API rate limits (adjust defaults to them).
- A multi-instance deployment requirement.
- Adapters needing streaming or paginated aggregation inside one operation.
