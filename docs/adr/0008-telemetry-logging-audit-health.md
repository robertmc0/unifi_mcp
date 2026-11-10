# 0008. Telemetry: structured logs, redaction, audit trail and health checks

- Status: Accepted
- Date: 2026-11-10
- Phase: 1
- Spec references: §2 (decisions 17, 33), §6.4, §7.3, §12, §17 (Security, Reliability)

## Context

Spec §12 requires structured JSON logs to stdout/stderr with no stdout output from the
stdio bridge; fixed correlation fields; no bearer tokens, UniFi credentials, sensitive
bodies, cookies or TOTP values in logs; persistent immutable-in-app audit entries for all
MCP reads and writes, denials, admin security events, approval decisions and important
failures, with tamper evidence as a desirable hardening; configurable retention (proposed
90 days); storage exhaustion failing safe rather than proceeding without an audit trail;
and health checks that separate liveness from readiness, where a disconnected optional
console does not take the service down. §6.4 requires redaction "by schema and known key
patterns before any logging". §7.3 requires that readiness leaks nothing to
unauthenticated callers. This ADR records how `packages/telemetry` meets these.

## Decision

### Logger

- One JSON object per line: `time` (UTC ISO 8601), `level`, `msg`, then bound fields, then
  call fields. `time`, `level` and `msg` cannot be overwritten (colliding fields are
  renamed `field_<name>`). JSON escaping keeps injected newlines and control characters in
  upstream text from forging records.
- Levels `debug`, `info`, `warn`, `error`; `UNIFI_MCP_LOG_LEVEL`, default `info`; an
  unknown value is a startup error.
- The sink is always passed explicitly: the service logs to stdout, the stdio bridge to
  stderr. Child loggers carry bound fields such as `correlationId`.
- Logging never throws (failing sink, hostile values).
- No logging library. The needs are small, and redaction has to be built in and
  mandatory rather than an optional plugin; this also follows spec §14 (few dependencies).

### Redaction (backstop for every log record and audit entry)

1. **Field names**: split into words (camelCase, snake_case, kebab-case). Sensitive words:
   password, passphrase, pass, passwd, pwd, passcode, passkey, psk, preshared, secret(s),
   token(s), auth, authorization, bearer, cookie(s), session, credential(s), signature, jwt,
   otp, totp, mfa, pin; sensitive pairs: api key, private key, master key, access key, secret
   key, shared key, encryption key, signing key, session key, network key, Wi-Fi key, WPA
   key, WEP key, recovery code(s), set cookie. Matching values become `[REDACTED]` (null
   stays null). Deliberately conservative: non-secret identifiers must avoid these words.
   The list in `packages/telemetry/src/redact.ts` is authoritative; `psk`, `preshared`,
   `passkey` and the extra key pairs were added on 2026-11-10 after the approval tests
   found `presharedKey` unredacted (ADR 0011).
2. **String contents**: PEM private keys; RTSP(S) URLs (the path is the Protect stream
   secret); `user:password@` in URLs; `Bearer …`; base64-looking `Basic …`; secret-looking
   query parameters (`token`, `api_key`, `password`, `secret`, `signature`, `key`, `code`,
   `auth`, `session`, …).
3. **Values**: `SecretValue` (via `toJSON`) renders `[REDACTED]`; binary data becomes
   `[binary N bytes]`; errors become `{name, message, code, stack, cause}` with redacted
   strings.
4. **Bounds**: depth, keys per object, array items and string length are capped (logs:
   8 / 100 / 50 / 2048; audit details: 5 / 50 / 20 / 512), cycles become `[Circular]`.

Adapters add schema-based redaction of UniFi payloads on top (Phase 2+). The MCP client
token format is chosen in step 7; a matching string pattern is added then.

### Audit trail

- Table `audit_entries` (storage migration 2; storage owns the single migration list,
  feature packages own their queries): `seq` (AUTOINCREMENT), `id` (UUID), `occurred_at`,
  `event_type`, `action`, `outcome` (`success`, `denied`, `failure`, `pending`,
  `outcome_unknown`), `actor_type` (`mcp_client`, `admin`, `cli`, `system`), `actor_id`,
  `correlation_id`, `console_id`, `application`, `operation_id`, `error_code`,
  `duration_ms`, `details` (redacted JSON, at most 8 KiB, else replaced by a truncation
  marker), `prev_hash`, `entry_hash`.
- **Hash chain**: `entry_hash = SHA-256(prev_hash ‖ "\n" ‖ JSON array of the entry
fields)`, genesis `prev_hash` = 64 zeros. `verifyChain()` recomputes every hash and link;
  the first remaining entry's `prev_hash` is the anchor after pruning.
- **Immutability**: a trigger aborts every `UPDATE`. The only delete path is
  `prune(olderThan)`, which records an `audit.prune` entry in the same transaction.
  Default retention is 90 days (`DEFAULT_AUDIT_RETENTION_DAYS`); scheduling and
  configuration come with the service and CLI.
- **Fail safe**: a storage failure in `record()` raises `AuditUnavailableError`
  (`AUDIT_UNAVAILABLE`), writes an error record to the runtime log, and marks the audit
  trail unhealthy. Callers must treat it as a refusal: the dispatcher (step 4) records a
  write's `pending` entry before calling UniFi and does not call UniFi if that fails; a
  read's result is withheld if its entry cannot be recorded.
- `record()` joins an open transaction as a savepoint, so an audit entry commits or rolls
  back with the state change it describes (approvals, client changes).
- **Recovery**: while unhealthy, the readiness check calls `probe()`, which tries to record
  `system`/`audit.recovered`. The service therefore becomes ready again once space is
  freed, even if an orchestrator stops sending it traffic while it is not ready. While
  healthy, `probe()` writes nothing.

### Health

- **Liveness** (`/livez` by default): the process answers. It runs no checks.
- **Readiness** (`/readyz` by default): all registered checks run concurrently with a
  timeout (default 2 s, a timeout is a failure). Ready means no _critical_ check failed.
  Non-critical checks (for example per-console connectivity, Phase 2) can only set
  `degraded`.
- Built-in critical checks: `database` (open and answering), `audit` (writable, with the
  recovery probe), `disk_space` (not ready below 64 MiB free, degraded below 512 MiB).
- The public handler returns only `{"status":"alive"}`, `{"status":"ready"}` or
  `{"status":"not_ready"}` (HTTP 503), with `Cache-Control: no-store`, `GET`/`HEAD` only.
  Check names and details are available only from `HealthMonitor.readiness()` for the admin
  API and CLI. The listener that mounts the handler, and its path configuration, are
  step 7.

## Evidence (verified 2026-11-10, Node.js 26.13.0)

- `tests/unit/telemetry/` (redaction, logger, audit, health) and
  `tests/security/telemetry-redaction.test.ts`: 92 tests.
- Mutation checks, each making at least one test fail: log fields not redacted; field-name
  redaction disabled; Bearer string pattern disabled; audit write failure swallowed; chain
  links not checked; audit details stored unredacted; public readiness body containing the
  report; readiness ignoring critical failures; recovery probe not writing.
- `PRAGMA max_page_count` reproduces a full database: `record()` raises
  `AuditUnavailableError`, the runtime log receives the failure with
  `storageErrorCode: "STORAGE_FULL"`, and `probe()` recovers once space is available.

## Consequences

- Each audited operation costs at least one fsynced write (`synchronous=FULL`, ADR 0007).
  This is accepted; the workload is human- and agent-paced, not bulk.
- The chain is tamper-evident, not tamper-proof: the host administrator is trusted
  (spec §3.1), and removing the newest entries is not detectable without an external
  anchor. Signed or anchored audit export is a Phase 5 hardening item.
- Conservative field-name redaction can hide harmless fields (for example `tokenId`).
  Name non-secret identifiers without sensitive words.
- Audit details are metadata only. Even redacted, they may contain personal or network
  metadata (client names, identifiers), so audit retention is part of the privacy policy
  (docs/monitoring.md).

## Re-evaluation triggers

- A requirement to ship logs or audit to an external system (syslog, OTLP).
- Audit volume large enough for fsync cost or table size to matter.
- Prometheus metrics (Phase 5) adding a third telemetry surface.
