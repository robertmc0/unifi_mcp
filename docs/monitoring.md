# Logs, audit trail and health checks

> **Status: Phase 1 in progress.** Logging, the audit trail and the health checks are
> implemented (ADR 0008) and served by the MCP listener (ADR 0013). The CLI commands for
> the audit trail come with the CLI (step 9). Prometheus metrics are Phase 5.

## Runtime logs

The service writes one JSON object per line to stdout, for the container log driver. The
stdio bridge writes its logs to stderr, because its stdout carries only MCP protocol
messages.

```json
{
  "time": "2026-11-10T03:15:00.000Z",
  "level": "info",
  "msg": "request done",
  "service": "unifi-local-mcp",
  "correlationId": "…",
  "clientId": "…",
  "durationMs": 12
}
```

- `time` is UTC; `level` is `debug`, `info`, `warn` or `error`; `msg` is a short fixed
  message. Other fields include the correlation id, client id (never its token), console,
  module and operation ids, outcome, duration and error code.
- `UNIFI_MCP_LOG_LEVEL` sets the minimum level (default `info`, see
  [configuration.md](configuration.md)).
- Text from UniFi (device names, camera labels, event text) is logged as escaped JSON data,
  so it cannot break or forge log lines.

### What is never logged

Every log record and audit entry passes through redaction:

- Any field whose name contains a word such as password, passphrase, PSK/pre-shared key,
  secret, token, auth/authorization, cookie, session, credential, signature, OTP/TOTP/MFA
  or PIN, or a pair such as API key, private key, master key, shared key, encryption key
  or recovery code, is replaced by `[REDACTED]`.
- Inside any text: `Bearer …` and `Basic …` credentials, `user:password@` in URLs,
  secret-looking query parameters, RTSP(S) stream URLs and PEM private keys.
- Stored credentials are never in plaintext in memory structures that get logged: they are
  wrapped values that print as `[REDACTED]`.
- Binary data is shown only as its size; long values are truncated.

Redaction is conservative and may hide harmless fields whose names contain one of these
words.

## Audit trail

The audit trail is stored in the database (`audit_entries`) and records every MCP read
and write, every permission denial, admin logins and security changes, approval
decisions, and important system events. Audit pruning and audit recovery are recorded
already; startup, backup, key rotation and restore events are recorded once the service
and CLI that perform them exist (Phase 1 steps 7 and 9).

Each entry has: sequence number, id, UTC time, event type, action, outcome (`success`,
`denied`, `failure`, `pending`, `outcome_unknown`), actor (MCP client, admin, CLI or
system) and actor id, correlation id, console, module and operation, error code, duration,
and redacted metadata details (at most 8 KiB). Entries contain metadata and safe
identifiers, never complete sensitive responses, images or credentials.

- **Fail safe.** If an entry cannot be written (for example the data volume is full), the
  operation it describes is refused, the failure is written to the runtime log, and the
  service reports not ready. When the cause is fixed, the next readiness check records an
  `audit.recovered` entry and the service becomes ready again by itself.
- **Immutable.** Entries cannot be updated. They are removed only by retention pruning,
  which is itself recorded as an `audit.prune` entry.
- **Tamper evident.** Each entry includes the hash of the previous one. Chain verification
  (CLI, not yet available) reports the first entry that was edited or whose predecessor
  was removed. The host administrator is trusted and could rewrite the database; the chain
  makes such changes visible, it cannot prevent them.
- **Retention.** Entries older than `UNIFI_MCP_AUDIT_RETENTION_DAYS` (default 90) are
  deleted at startup and daily. Audit metadata can include client names and
  network identifiers, so include it in your privacy and retention policy. Backups contain
  the audit trail too.

## Health checks

| Endpoint  | Meaning                                                                               | Response                                                 |
| --------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `/livez`  | The process is running. Runs no checks. Use it to decide whether to **restart**.      | `200 {"status":"alive"}`                                 |
| `/readyz` | The service can serve requests: database usable, audit trail writable, disk not full. | `200 {"status":"ready"}` or `503 {"status":"not_ready"}` |

- An unreachable optional console makes the service _degraded_, never not ready, so it does
  not cause restarts.
- Free space below 512 MiB on the data volume makes the service degraded; below 64 MiB it
  is not ready.
- The endpoints are unauthenticated and therefore return only the overall status. Check
  names and details (which can include console identifiers) are shown only to
  administrators (admin UI and `unifi-mcp doctor`, not yet available).
- Responses are `Cache-Control: no-store` and accept only `GET` and `HEAD`.
