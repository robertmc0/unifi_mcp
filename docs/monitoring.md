# Logs, audit trail, health checks and metrics

> **Status:** logging, the audit trail and the health checks are implemented (ADR 0008)
> and served by the MCP listener (ADR 0013). The CLI reads and verifies the audit trail
> (`unifi-mcp audit list|verify`, ADR 0015). Optional Prometheus metrics have their own
> listener (ADR 0025).

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

### Console version messages

The service learns each enabled console module's application version by itself (ADR 0018):
shortly after start, within a minute of a module being enabled, and every 6 hours.

| `msg`                          | Level | Meaning                                                                                        |
| ------------------------------ | ----- | ---------------------------------------------------------------------------------------------- |
| `console version observed`     | info  | A new or changed version (`version`, `previous`). A change also invalidates pending approvals. |
| `console version probe failed` | warn  | The probe failed (`code`, `retryInMs`). Logged when it starts failing or the error changes.    |
| `console reachable again`      | info  | A failing probe succeeded again.                                                               |

### Console request messages

| `msg`                                          | Level | Meaning                                                                                                                                                                                                              |
| ---------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upstream request`                             | debug | One request to a console: `method`, `pathTemplate` (no ids), `attempt`, the HTTP `status` when an answer arrived, and `durationMs`.                                                                                  |
| `console returned an error`                    | warn  | The console answered with an HTTP error: `status`, its documented `upstreamCode` and, when it sends one, `upstreamRequestId` (the id of the request in the console's own log). Nothing else from the body is logged. |
| `console response does not match the contract` | warn  | A response failed the documented schema and was withheld: `operationId`, `contractRevision` and `mismatches`, the fields and kinds of mismatch (`ipv4Configuration: invalid_type …`), never their values.            |

### Event messages

Connections to console event streams and closed subscriptions are logged as described in
[events.md](events.md#logs-and-audit). Event content is never logged.

## Audit trail

The audit trail is stored in the database (`audit_entries`) and records every MCP read
and write, every event subscription and event resource read, every permission denial, admin logins and security changes, approval
decisions, CLI changes (as `cli:<operating-system user>`), and system events such as
service start and stop, backups, master key rotation, restores, audit pruning and audit
recovery.

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
  (`unifi-mcp audit verify`, also part of `db check` and `doctor`) reports the first entry that was edited or whose predecessor
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
  not cause restarts. The `console_versions` check is degraded while a console module's
  version probe fails, and names the console and the error code.
- Free space below 512 MiB on the data volume makes the service degraded; below 64 MiB it
  is not ready.
- The endpoints are unauthenticated and therefore return only the overall status. Check
  names and details (which can include console identifiers) are shown only to
  administrators (`unifi-mcp doctor`, and the dashboard of the admin web interface).
- Responses are `Cache-Control: no-store` and accept only `GET` and `HEAD`.
- The container image's Docker `HEALTHCHECK` probes `/livez` every 30 seconds (every 2
  seconds while starting), so `docker compose ps` shows `healthy` (ADR 0017).

## Metrics

The service can publish metrics in the Prometheus text format. They are **off by
default**, served on their own port, and only to a scraper that presents a token
([ADR 0025](adr/0025-prometheus-metrics.md)). Prometheus does not run inside the
container; you point your own at it.

### Enabling

1. Create a token file. It opens the metrics page and nothing else.

   ```sh
   unifi-mcp crypto generate-token --out secrets/unifi_mcp_metrics_token
   ```

   Any file with one line of at least 32 letters and digits works, for example from
   `openssl rand -hex 32`.

2. Set `UNIFI_MCP_METRICS_ENABLED=true` and `UNIFI_MCP_METRICS_TOKEN_FILE` to the file
   ([configuration.md](configuration.md#metrics-listener)). With Docker Compose, uncomment
   the metrics lines in `deploy/compose.single.yml`
   ([networking.md](networking.md#the-metrics-listener)).
3. Restart the service. `unifi-mcp doctor` shows a `metrics` line, and the log says
   `metrics listening`.
4. Check it on the host:

   ```sh
   curl -sS -H @<(printf 'Authorization: Bearer %s\n' "$(cat secrets/unifi_mcp_metrics_token)") \
     http://127.0.0.1:9464/metrics
   ```

The listener answers `GET /metrics` and nothing else. Without the token it answers
`401`; after repeated failures from one address, `429` for a while. Refused attempts are
in the audit trail (`metrics.auth`); successful scrapes are not, because there is one
every few seconds. To change the token, replace the file and restart the service.

### Scrape configuration

```yaml
scrape_configs:
  - job_name: unifi-local-mcp
    scheme: http # https with UNIFI_MCP_METRICS_TLS_CERT_FILE and UNIFI_MCP_METRICS_TLS_KEY_FILE
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/unifi_mcp_metrics_token
    static_configs:
      - targets: ['127.0.0.1:9464']
```

Give Prometheus a copy of the token file. Over a network, use HTTPS: the service refuses
to serve the listener in plaintext on a non-loopback address unless you tell it that
something else protects it.

### What is published

All values are counts, durations, sizes or flags of the service process. Counters start
at zero when the service starts.

| Metric                                        | Type      | Labels                       | Meaning                                                                                                                                |
| --------------------------------------------- | --------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `unifi_mcp_http_requests_total`               | counter   | `path`, `code`               | Requests finished on the MCP listener. `path` is `mcp`, `health` or `other`; `code` is the HTTP status, for example `401`.             |
| `unifi_mcp_operations_total`                  | counter   | `module`, `effect`, `status` | Operation requests: `status` is `ok`, `pending`, `denied`, `approval_required` or `error`.                                             |
| `unifi_mcp_operation_failures_total`          | counter   | `status`, `code`             | Denied and failed operation requests by the service's error code, for example `rate_limited`.                                          |
| `unifi_mcp_operation_duration_seconds`        | histogram | `module`, `effect`           | Time from an operation request to its result, including queueing and retries.                                                          |
| `unifi_mcp_upstream_requests_total`           | counter   | `module`, `result`           | Requests sent to consoles: `result` is `2xx`, `3xx`, `4xx`, `5xx`, or `no_response` when the console did not answer.                   |
| `unifi_mcp_upstream_request_duration_seconds` | histogram | `module`                     | Duration of one request to a console, including connecting.                                                                            |
| `unifi_mcp_build_info`                        | gauge     | `version`                    | Always 1; the label is the service version.                                                                                            |
| `process_start_time_seconds`                  | gauge     |                              | When the service process started (Unix time).                                                                                          |
| `process_resident_memory_bytes`               | gauge     |                              | Memory of the service process.                                                                                                         |
| `unifi_mcp_ready`                             | gauge     |                              | 1 when the service is ready (as `/readyz`), otherwise 0.                                                                               |
| `unifi_mcp_health_check_status`               | gauge     | `check`, `status`            | 1 for the current status (`ok`, `degraded`, `fail`) of `database`, `audit`, `disk_space` and `console_versions`; 0 otherwise.          |
| `unifi_mcp_hard_lock`                         | gauge     |                              | 1 when `UNIFI_MCP_FORCE_READ_ONLY` is on.                                                                                              |
| `unifi_mcp_runtime_mode`                      | gauge     | `mode`                       | 1 for the policy's runtime mode (`read_only` or `read_write`), 0 for the other.                                                        |
| `unifi_mcp_policy_version`                    | gauge     |                              | Rises with every change to the security policy, consoles or clients.                                                                   |
| `unifi_mcp_operations_running`                | gauge     |                              | Operations being executed now.                                                                                                         |
| `unifi_mcp_operations_queued`                 | gauge     |                              | Operation requests waiting for a free slot.                                                                                            |
| `unifi_mcp_clients_connected`                 | gauge     |                              | MCP clients with at least one open request or stream.                                                                                  |
| `unifi_mcp_open_responses`                    | gauge     |                              | Open MCP responses, including event streams.                                                                                           |
| `unifi_mcp_clients_configured`                | gauge     |                              | MCP clients that exist, whatever their status.                                                                                         |
| `unifi_mcp_event_subscriptions`               | gauge     |                              | Open event subscriptions of MCP clients.                                                                                               |
| `unifi_mcp_event_feeds`                       | gauge     | `module`, `state`            | Event connections to consoles: `connecting`, `connected`, `retrying` or `unavailable`.                                                 |
| `unifi_mcp_event_messages_dropped`            | gauge     | `module`, `reason`           | Messages the current event connections dropped: `contract_mismatch` or `unclassified`. It falls when a connection is no longer needed. |
| `unifi_mcp_consoles`                          | gauge     | `state`                      | Configured consoles: `enabled`, `read_only`, `disabled`, or `invalid` (stored policy unusable).                                        |
| `unifi_mcp_console_modules`                   | gauge     | `module`, `state`, `version` | Console modules by mode (`read_only`, `read_write`, `disabled`) and whether their application version is `known` or `unknown`.         |
| `unifi_mcp_approvals_pending`                 | gauge     |                              | Approval requests waiting for a person (at most 500 are counted).                                                                      |
| `unifi_mcp_database_size_bytes`               | gauge     |                              | Size of the database file.                                                                                                             |
| `unifi_mcp_data_volume_free_bytes`            | gauge     |                              | Free space on the data volume.                                                                                                         |

`module` is `network`, `protect`, `access` or `unknown`; `effect` is `read`, `write` or
`unknown`. `unknown` counts requests for operation ids that do not exist. A series
appears when it first has a value.

Changes made with the CLI in another process (for example `unifi-mcp client revoke`) are
not counted by the counters. The gauges read the database and show them.

### What is never published

Metrics carry no console alias, host name, address or id, no client id or name, no site,
device or operation id, no argument, no token id and no text from a console. This is
enforced, not only intended: every label has a fixed list of values, and anything else is
recorded as `unknown` or `other`. The one open label, `code` of
`unifi_mcp_operation_failures_total`, accepts only the service's own lower-case error
codes and at most 64 different ones. To see _which_ console or client is behind a number,
use the runtime log and the audit trail, which need host access.

The page still describes your deployment in outline: how many consoles and clients
exist, which modules are in use, whether writes are possible, and how busy it is. That
is why it needs a token.

### Example queries

```promql
# Share of operation requests that failed, over 5 minutes
sum(rate(unifi_mcp_operations_total{status="error"}[5m])) / sum(rate(unifi_mcp_operations_total[5m]))

# 95th percentile of operation duration per module
histogram_quantile(0.95, sum by (le, module) (rate(unifi_mcp_operation_duration_seconds_bucket[5m])))

# Consoles not answering, or answering with server errors, per module
sum by (module) (rate(unifi_mcp_upstream_requests_total{result=~"no_response|5xx"}[5m]))

# Refused MCP sign-ins (wrong or missing client token)
rate(unifi_mcp_http_requests_total{path="mcp",code="401"}[5m])

# Not ready, or a health check that is not ok
unifi_mcp_ready == 0
unifi_mcp_health_check_status{status!="ok"} == 1

# Writes are possible: the hard lock is off and the runtime mode is read_write
unifi_mcp_hard_lock == 0 and on() unifi_mcp_runtime_mode{mode="read_write"} == 1

# Requests are queueing, approvals are waiting, event connections are failing
unifi_mcp_operations_queued > 0
unifi_mcp_approvals_pending > 0
sum(unifi_mcp_event_feeds{state=~"retrying|unavailable"}) > 0

# Less than 1 GiB free on the data volume
unifi_mcp_data_volume_free_bytes < 1073741824
```

They are written for Grafana panels and alert rules. The names and labels in them are
checked against the service by a test. The scrape configuration and these queries have
not yet been run against a Prometheus server
([ADR 0025](adr/0025-prometheus-metrics.md), "Not verified").
