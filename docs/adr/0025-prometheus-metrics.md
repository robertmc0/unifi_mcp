# 0025. Prometheus metrics

- Status: Accepted
- Date: 2026-11-16
- Phase: 5
- Spec references: §7.3, §12, §14, §17 ("metrics do not leak sensitive identifiers")

## Context

Spec §12 asks for an "optional authenticated/management-only Prometheus endpoint" with
request counts and latencies, queue depth, error rates, console connectivity, event
subscriptions, active clients and database health, and says to "avoid IP/MAC addresses,
client names, unbounded labels, secrets and personal information". §7.3 says health and
metrics paths are separately configured. §14 says to avoid unnecessary dependencies.

## Decision

1. **No dependency.** `packages/telemetry/src/metrics.ts` is a registry of counters,
   gauges and histograms that renders the Prometheus text format (0.0.4). It is about 250
   lines; a client library would add a dependency for less control over labels.

2. **Labels are bounded by construction.** A metric declares every label with the complete
   list of values it can take. Any other value is recorded as the label's last declared
   value (`unknown` or `other`). No input can create a time series, so a name, address or
   identifier cannot become a label value by accident. One label is open: `code` on
   `unifi_mcp_operation_failures_total`, for the service's own error codes. It accepts
   only `[a-z][a-z0-9_]*` (no UUID, address or host name matches) and at most 64 distinct
   values, then `other`. A metric whose labels multiply to more than 512 series is refused
   at registration.

3. **What is measured** (27 metrics, listed in [monitoring.md](../monitoring.md#metrics)):
   requests on the MCP listener; operation requests, failures and durations; requests to
   consoles and their durations; running and queued operations; connected and configured
   clients; event subscriptions, feeds and dropped messages; consoles and their modules;
   pending approvals; readiness and each health check; the hard lock, runtime mode and
   policy version; database size, free space, memory and start time.

4. **What is never published:** console aliases, hosts, addresses and ids; client ids and
   names; site, device and operation ids; arguments; token ids; upstream text. Operations
   are labelled by module and effect only, taken from the registered descriptor, never
   from the request. An operation id that is not registered counts as `unknown`.

5. **Three observation hooks, no logic.** The dispatcher, the console executor and the
   MCP HTTP gate each accept an optional `observe` callback and report module, effect,
   status and duration after the fact. A callback cannot change a result, and its errors
   are ignored. Gauges are read from existing state when a scrape arrives. The dispatcher
   hook also sees results that are never audited, such as `audit_unavailable`.

6. **Its own listener, off by default.** `UNIFI_MCP_METRICS_ENABLED=true` starts a third
   listener (default `127.0.0.1:9464`) that answers `GET /metrics` and nothing else. It
   is not on the MCP listener (clients have no use for it, and a client-side network
   should not see it) and not on the admin listener (a scraper cannot use a browser
   session). The same plaintext rule as for the other listeners applies: no plaintext on
   a non-loopback address unless TLS files are set or `…_ALLOW_PLAINTEXT=true` says
   something else protects it.

7. **Always authenticated, with a credential of its own.** The scraper presents a bearer
   token from `UNIFI_MCP_METRICS_TOKEN_FILE` (at least 32 characters; only its SHA-256 is
   kept in memory; compared in constant time). Enabling metrics without a usable token
   file stops the service from starting. The spec allows "authenticated _or_
   management-only"; this decision requires authentication even on loopback, because in
   Docker a "loopback" listener is published by a line of Compose and the page describes
   the deployment in outline. The token is not an MCP client token and not an
   administrator session: it opens only this page, and neither of those opens it.
   Failed attempts are throttled per address and audited (`metrics.auth`); successful
   scrapes are not audited, since one arrives every few seconds.

8. **`unifi-mcp crypto generate-token --out <file>`** writes a 256-bit token with mode
   0400 and never overwrites. `doctor` and `config show-effective` show the listener; the
   token is never shown.

## Evidence

- `tests/unit/telemetry/metrics.test.ts`: the text format; undeclared values (an address,
  a UUID, a device name, quotes and braces) fall back; code labels; refused definitions.
- `tests/contract/metrics-catalogue.test.ts`: the catalogue is pinned, with every label
  value; no label names a console, client, site, device, address or operation; the manual
  lists exactly these metrics with these labels.
- `tests/integration-mock/metrics-http.test.ts`, against a running service: no listener
  unless enabled; the MCP listener never serves metrics; 401 without the token, with an
  MCP client token granted `*.*.*`, with a near miss and with the token in the query
  string; 429 after repeated failures; only `GET /metrics`; counters follow real MCP calls
  (reads, a denied write, an unknown operation id, a console that does not answer); and a
  scrape made after calls that carry sentinel values contains none of them, nor the
  console id, alias or port, the client id, token ids, the console key, device names, MAC
  addresses, any IPv4 address or any UUID. The scrape token is in no log line and no
  audit entry. A service with an unusable token file does not start.
- `tests/unit/mcp-server/clients.test.ts`: the configuration rules, and that every
  refusal survives log redaction.
- Run by hand on 2026-11-16 from a checkout: `crypto generate-token`, `doctor`,
  `config show-effective`, the service with metrics enabled, 401 without the token and
  the page with it.

**Not verified:** the scrape configuration and the example queries in the manual have
not been run against a Prometheus server. The output follows the text format and is
checked line by line in the tests, and the queries use only the published names and
labels (checked by the catalogue test), but no Prometheus has scraped this service yet.

## Consequences

- Metrics describe the service process. Changes made by the CLI in another process do not
  move the counters; the gauges read the database and do show them.
- Per-console and per-client breakdowns are deliberately impossible. The runtime log and
  the audit trail hold them, behind host access.
- A scrape runs the readiness checks and a few small queries. At a 15-second interval this
  is negligible; a scrape every second would not be.
- A third listener and a third kind of credential exist. Both are off unless enabled.

## Re-evaluation triggers

- A real need for a per-console series: it would need the owner's decision and an opaque,
  stable label that is not the console id or alias.
- A Prometheus run that shows the page or an example query to be wrong.
- OpenMetrics or OTLP being required by an operator.
