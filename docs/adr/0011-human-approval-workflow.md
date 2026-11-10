# 0011. Human approval workflow for high-risk operations

- Status: Accepted
- Date: 2026-11-10
- Phase: 1
- Spec references: §2 (decisions 09, 10, 36), §6.5, §7.2, §8.2, §16 Phase 1 gate, §17

## Context

Spec §6.5 requires a server-enforced two-step workflow for high-impact writes: the AI
client's request becomes an immutable proposal with a short TTL; a human approves it
independently in the admin UI or local CLI; the approval binds client, console, site,
action, argument digest, security-policy version and expiry; the original client
explicitly resumes; resumption re-checks token, permissions, hard lock, version and expiry,
takes the resource lock and executes at most once. No MCP tool may approve; administrators
need a recent sign-in (and TOTP if required); defaults are 10 minutes pending and 2 minutes
to execute, configurable only downward; ids are single-use and unpredictable; approvals
never override the hard lock. §8.2 requires sensitive fields to be encrypted at rest.

## Decision

### Lifecycle

`pending → approved → consumed`, or `pending → rejected | expired | invalidated`, or
`approved → expired | invalidated`. Every transition is a compare-and-set on the status
(storage migration 5, `approval_requests`).

| Step       | Who                        | What happens                                                                                                                                                                                                         |
| ---------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Propose    | Dispatcher (MCP request)   | After validation and policy evaluation return `approvalRequired`. Stores the proposal and returns `approval_required` with the approval id, expiry and a redacted summary. Nothing is executed.                      |
| Decide     | Administrator or CLI       | `approve` or `reject`. Approvers are `admin` (signed in within 5 minutes, optionally with verified MFA) or `cli` (host authority). An MCP client cannot be represented as an approver and is refused at runtime too. |
| Resume     | The original MCP client    | `Dispatcher.resume(principal, approvalId)`; see below.                                                                                                                                                               |
| Expire     | Time                       | Applied lazily on every access and by `expireStale()`.                                                                                                                                                               |
| Invalidate | Policy change or tampering | A changed policy version, unreadable stored arguments or a changed argument digest.                                                                                                                                  |

### Binding and storage

- The row records client, operation, console, site, argument digest (canonical JSON SHA-256,
  ADR 0010), effective risk and policy version.
- Proposed arguments may contain credentials (for example a pre-shared key), so they are
  stored only as an encrypted secret record (`approval.arguments`, ADR 0007) and deleted when
  the approval closes. A database constraint ties "open" status to the presence of the
  encrypted record.
- Reviewers see a summary: the operation description and the arguments passed through the
  redactor (ADR 0008).
- Approval ids are random UUIDs. They are not secrets: knowing one does not allow approving,
  and only the original client can resume it.

### Resumption

1. The approval exists and belongs to this client (otherwise `approval_not_found`, so other
   clients learn nothing); it is `approved` and within its execution window.
2. The current policy version equals the proposal's; otherwise it is invalidated.
3. The stored arguments decrypt, and their digest equals the approved digest. The
   dispatcher re-validates them against the operation schema and recomputes the digest
   independently.
4. Full policy evaluation (all of spec §6.1, including the hard lock and revocation).
5. The normal write path (ADR 0010): the execution record, its `pending` audit entry and the
   approval's consumption happen in **one transaction**, so the approval is used at most
   once; then the resource lock, the dispatch re-check and the upstream call.

A resumption refused by the hard lock or by policy leaves the approval unconsumed, and it
expires normally. Arguments cannot be supplied again at resume.

### Windows

Defaults 10 minutes (pending) and 2 minutes (execution). Deployments may shorten them
(minimum 30 seconds each); longer values are rejected at startup.

### Audit

`approval.propose`, `approval.approve`, `approval.reject`, refusals of decisions (for
example `approver_forbidden`, `reauthentication_required`), `approval.resume` refusals,
`approval.consume`, `approval.expire` and `approval.invalidate`, with the approval id in the
details.

## Evidence (verified 2026-11-10)

- `tests/security/approval-gates.test.ts` covers the Phase 1 gates: the request is held
  without execution and cannot be approved by an MCP client; exactly-once execution of the
  approved arguments for the original client; reused, concurrently resumed, expired
  (both windows), parameter-changed (digest and encrypted record), wrong-client,
  policy-changed (before and after approval) and revoked-client cases fail; the hard lock
  denies a previously approved action; stored arguments are encrypted, redacted for
  reviewers and deleted on closing. `tests/unit/approvals/` covers windows, sweeps, client
  status views, decisions on closed requests, direct double consumption and MFA.
- Mutation checks, each making at least one test fail: MCP approver accepted; stale admin
  sign-in accepted; policy version not checked at resume; wrong client accepted;
  consumption not single-use; execution window not enforced; summary not redacted; resume
  skipping policy evaluation; both digest checks removed.
- Writing these tests found a redaction gap: the field name `presharedKey` was not treated
  as sensitive. ADR 0008's word list was extended (`psk`, `preshared`, `passkey` and more
  `<qualifier> key` pairs).

## Consequences

- No pre-execution "diff against current console state" yet: that needs adapter read-back
  (Phase 2). Until then the summary shows the proposed call. Where an official API offers
  no concurrency precondition (ETag or version), the adapter must disclose that in its
  operation description (spec §6.5).
- Any policy change invalidates every open approval (ADR 0009).
- The admin UI (step 10) and CLI (step 9) call `approve`/`reject` with an authenticated
  approver; the MCP server (step 7) exposes resume and status but never a decision.

## Re-evaluation triggers

- Multi-person approval (four-eyes) requirements.
- Adapters that can capture and re-verify a console precondition at resume.
