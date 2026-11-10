# 0013. MCP server: client tokens, the HTTP gate, the tool set and the service lifecycle

- Status: Accepted
- Date: 2026-11-10
- Phase: 1
- Spec references: §2 (decisions 02, 06, 12, 18, 25, 39), §3, §5, §7.1, §7.3, §8.1, §12, §16 Phase 1 gate

## Context

ADR 0003 fixed the SDK (v2, `createMcpHandler` with a per-request factory, stateless legacy
fallback) and that authentication and Host/Origin validation are ours. Spec §7.1 requires
one revocable high-entropy token per client, stored only as a verification value with
constant-time comparison, rate-limited failures, prompt revocation including open
streams, and no bearer tokens over non-loopback plaintext HTTP. §5 defines the tools,
per-client discovery and private caching. §12 requires liveness/readiness. This ADR records
the implementation in `packages/mcp-server`.

## Decision

### Client tokens

- Format `umcp_<12 hex token id>_<43 base64url secret>` (256 random bits). Shown once at
  creation or rotation. Storage migration 7: `clients` (id, description, client policy
  JSON, timestamps) and `client_tokens` (token id, SHA-256 of the secret, created, expires,
  revoked, last used).
- `authenticate()` always computes a digest and a constant-time comparison (also for
  malformed and unknown tokens), then checks token revocation and expiry and the client's
  status and expiry. All failures look the same to the caller.
- Rotation issues a new token and revokes earlier ones. Revocation, disabling and removal
  notify listeners: the dispatcher cancels the client's queued work and the HTTP layer
  closes its open responses (including listen streams).
- Every change is audited and bumps the policy version; only `admin`, `cli` and `system`
  actors can manage clients. Last use is recorded at most once a minute.
- The telemetry redactor recognises the token format inside any string (ADR 0008).

### HTTP gate

`McpHttpService` is the `node:http`/`node:https` listener:

1. `/livez`, `/readyz`: unauthenticated, minimal bodies (ADR 0008), no Host check (so
   container health checks work on any address).
2. `/mcp`: Host allowlist (DNS rebinding) and Origin allowlist via the SDK's Node guards
   (`localhost`, `127.0.0.1`, `[::1]` plus `UNIFI_MCP_HTTP_ALLOWED_HOSTS` /
   `UNIFI_MCP_HTTP_ALLOWED_ORIGINS`; requests without Origin pass, as non-browser clients
   send none).
3. Failed-authentication throttle per remote address (token bucket 10, refilling one per
   5 s; then 429 with Retry-After). Every failure is audited (`mcp.auth`).
4. Bearer verification; on success the request gets `req.auth = { clientId, token: <token
id>, scopes: [] }`, which the SDK's Node adapter forwards as `authInfo`. The raw token
   never travels further.
5. `Cache-Control: no-store` is set on every authenticated response.
6. Anything else: 404.

Request bodies are capped at 1 MiB; tool arguments at 2000 elements.

### Tools

A fresh `McpServer` per request from `authInfo.clientId` alone. Discovery runs
`evaluate(purpose: 'discover')` (ADR 0009) for every registered operation over the client's
consoles.

| Tool                         | Shown to                                                    |
| ---------------------------- | ----------------------------------------------------------- |
| `unifi_list_consoles`        | everyone (lists only the client's enabled consoles)         |
| `unifi_list_modules`         | everyone                                                    |
| `unifi_list_operations`      | everyone (only discoverable operations, paged ≤ 50)         |
| `unifi_describe_operation`   | everyone (hidden and unregistered operations look the same) |
| `unifi_execute`              | everyone (the dispatcher decides)                           |
| named tools (`namedTool`)    | when the operation is discoverable                          |
| `unifi_get_operation_status` | clients with at least one discoverable write                |
| `unifi_resume_approved`      | clients with at least one discoverable write                |

`unifi_list_sites` (spec §5.1) is registered only once a module adapter provides a
site-listing operation (Phase 2); a tool that cannot do anything would only cost client
context. There is no tool that approves, proxies, runs code or administers. Results carry
the dispatcher envelope as `structuredContent` and as JSON text; `isError` is set for
`error` and `denied`. Discovery tool calls are audited (`mcp.discovery`). Server
`instructions` tell clients that console data is data, not instructions.

`tools/list` is emitted with `ttlMs: 0` and `cacheScope: 'private'` for 2026-era clients
(verified on the wire); 2025-era responses carry `Cache-Control: no-cache`.

### Configuration and plaintext policy

`loadServiceConfig(env)` parses every deployment setting strictly (startup error on bad
values). The listener defaults to `127.0.0.1:3000`. HTTPS is served when
`UNIFI_MCP_HTTP_TLS_CERT_FILE`/`_KEY_FILE` are set. Without TLS, a non-loopback bind is
refused unless `UNIFI_MCP_HTTP_ALLOW_PLAINTEXT=true`, which is for a TLS-terminating proxy
or host-level loopback publishing (the Docker examples) and is logged as a warning.
Forwarded headers are never used.

### Lifecycle

Startup (`startService`), each step failing closed: master key → storage (integrity, key,
migrations, pre-migration backup) → policy → console, client and approval stores →
contract inventory and operation registry (sealed) → executor and dispatcher, restart
recovery → health checks (database, audit, disk) → MCP handler → listener → `service.start`
audit entry. Timers: approval expiry every 30 s, audit retention pruning at start and daily
(`UNIFI_MCP_AUDIT_RETENTION_DAYS`, default 90). Shutdown on SIGTERM/SIGINT: stop accepting,
drain (10 s cap), close connections, `service.stop` audit entry, close the database.
`main.ts` exits 1 on any startup failure, with the error code in a JSON log line.

## Evidence (verified 2026-11-10)

- `tests/integration-mock/mcp-http.test.ts` (real listener, real SDK v2 clients in both
  eras, synthetic HTTPS console): both eras connect and call tools; differently scoped
  tokens see different tools and read-only clients see no write tools; safe start without
  consoles; hard lock through `unifi_execute`; approval required, no approve tool, resume
  once; client id smuggling refused; revocation blocks the next call and closes an in-flight
  call; 401 and throttling to 429; Host and Origin protection; minimal health endpoints;
  private, non-cacheable tool lists; no tokens or credentials in logs, audit or database.
- `tests/unit/mcp-server/clients.test.ts`: token format, verification failures, rotation,
  expiry, disable, revocation listeners, validation, digest-only storage, last-use throttle;
  configuration defaults and strict parsing including the plaintext rule.
- Entry-point smoke test: without a key the process exits 1 with
  `MASTER_KEY_NOT_CONFIGURED`; with a key it starts (hard lock on), `/readyz` answers
  `ready`, `/mcp` without a token answers 401, SIGTERM exits 0, and stdout carries only
  JSON log lines.
- Mutation checks, each making at least one test fail: Host check removed; Origin check
  removed; failed-auth throttle removed; revocation leaving streams open; revoked or expired
  tokens accepted; secret not compared; disabled clients accepted; discovery ignoring
  policy; write tools for everyone; plaintext allowed anywhere.

## Consequences

- 2025-era clients see permission changes only after reconnecting (stateless legacy
  serving, ADR 0003); 2026-era clients refetch per request.
- The failed-authentication throttle is per process and per remote address; behind a proxy
  all clients share the proxy's address, so the throttle then protects the service, not
  individual clients.
- Clients and consoles are managed through the stores until the CLI (step 9) exists.

## Re-evaluation triggers

- A target client that needs live `list_changed` on a 2025-era protocol (ADR 0003).
- OAuth-based client authentication becoming a requirement.
- A trusted-proxy deployment that needs the real client address (forwarded headers with a
  trusted CIDR list).
