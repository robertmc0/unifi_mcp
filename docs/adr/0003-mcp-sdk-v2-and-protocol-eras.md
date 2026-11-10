# 0003. MCP TypeScript SDK v2 and protocol-era support

- Status: Accepted. The stdio bridge design (below) is Proposed and will be settled by a Phase 1 spike.
- Date: 2026-11-10
- Phase: 0
- Spec references: §1.3, §3.1, §3.2, §5.3, §7.1, §7.3, §16 Phase 1 gate

## Context

The spec requires the official MCP TypeScript SDK **v2** and support for both MCP
2026-07-28 ("modern") clients and 2025-era clients that use `initialize` and sessions
("legacy"). It also requires per-client tool lists, identity taken only from the verified
token, and a stdio bridge that holds only a client token.

## Decision

**Packages (exact pins):** `@modelcontextprotocol/server@2.4.0`,
`@modelcontextprotocol/client@2.4.0` and `@modelcontextprotocol/node@2.1.2`. The node
adapter depends on `hono` and `@hono/node-server`. All require `node >= 20` and
`zod ^4.2.0`. We do not use the v1 package `@modelcontextprotocol/sdk` or the frozen v1
transports in `@modelcontextprotocol/server-legacy`.

**HTTP endpoint.** One Streamable HTTP endpoint is built with
`createMcpHandler(factory, { legacy: 'stateless' })` and mounted on `node:http` through
`toNodeHandler` from `@modelcontextprotocol/node`.

- The SDK constructs a **fresh `McpServer` per request** and passes
  `{ era, authInfo, requestInfo }` to the factory. The factory registers only the tools,
  resources and prompts the authenticated client may see. This is how spec §5.3
  (per-client, permission-filtered discovery) is implemented. Execution re-checks policy
  centrally regardless of what was listed.
- **Authentication is ours.** The SDK treats `authInfo` as pass-through and never verifies
  tokens or reads headers. A gate in front of the handler verifies the opaque bearer token
  (hashed lookup, constant-time compare, revocation and expiry), then calls
  `handler.fetch(request, { authInfo })`. Tool handlers read identity only from
  `ctx.http.authInfo`. An unauthenticated request never reaches the SDK.
- **Host/Origin checks are ours.** The handler validates neither header. We compose
  `hostHeaderValidation` / `originValidation` from `@modelcontextprotocol/node` with an
  explicit allowlist from configuration. The localhost variants apply only to loopback
  binds. There is no wildcard CORS (spec §7.3).
- **Legacy clients** are served statelessly (`legacy: 'stateless'`, the SDK default). In
  this mode there are no sessions, the standalone GET SSE stream returns 405, and
  server-initiated `list_changed` notifications are not delivered. Spec §3.2 explicitly
  allows reconnect/refresh as a documented fallback for change notifications, and Phase 1
  documents it in the client guides. A sessionful legacy branch (routing with
  `isLegacyRequest` to `NodeStreamableHTTPServerTransport`) remains possible later if a
  target client needs live list refresh. It would need its own ADR, because sessions must
  then be bound to the authenticated token and torn down on revocation.
- **Modern clients** receive change notifications through `subscriptions/listen` streams,
  published with the handler's `notify`/`bus`. Revocation must also close any open listen
  stream for that token (Phase 1 requirement).
- **Revocation latency.** Because each HTTP request is authenticated independently, a
  revoked token fails on its next request without any session cleanup.

**stdio bridge (Proposed).** The bridge is a separate local process with no UniFi or
SQLite access. Two designs were considered:

1. _Transport relay (preferred)._ Pipe JSON-RPC messages between a `StdioServerTransport`
   facing the harness and a `StreamableHTTPClientTransport` facing the central service.
   The bridge adds `Authorization: Bearer <client token>` via the transport's
   `fetch`/`requestInit` option. The bridge contains no tool logic, so it cannot drift from
   the server's policy view and supports whichever era the harness speaks.
2. _SDK proxy._ `serveStdio(factory)` plus an SDK `Client` that mirrors upstream tools.
   This was rejected as the default: it re-registers tool schemas, duplicates validation,
   and has to translate list-change semantics between eras.

The Phase 1 spike must confirm three things: that the v2 client transport relays modern-era
traffic (per-request `_meta` and protocol headers) without a `Client` on top; that stdout
carries only protocol frames; and that the bridge exits non-zero, writing to stderr only,
on authentication failure.

## Evidence

- Documentation: `https://ts.sdk.modelcontextprotocol.io/v2/` (serving/http,
  serving/legacy-clients, protocol-versions, get-started/packages), read 2026-11-10.
- Installed typings for 2.4.0 confirm the exports used here: `createMcpHandler`,
  `McpServer`, `isLegacyRequest`, `requireBearerAuth`; `serveStdio` and
  `StdioServerTransport` from `@modelcontextprotocol/server/stdio`; `toNodeHandler`,
  `hostHeaderValidation` and `originValidation` from `@modelcontextprotocol/node`; and
  `Client` (with `versionNegotiation: { mode: 'legacy' | 'auto' | { pin } }` and
  `getProtocolEra()`) and `StreamableHTTPClientTransport` (with a `fetch` option) from
  `@modelcontextprotocol/client`. `CreateMcpHandlerOptions.legacy` accepts only
  `'stateless' | 'reject'`.
- `tests/contract/mcp-sdk-v2-eras.test.ts` runs a real SDK client against
  `createMcpHandler` in-process. For both negotiation modes it verifies the negotiated era
  (`legacy`, `modern`), identity propagation via `authInfo`, per-client tool lists from the
  factory, and rejection without a valid bearer token. 8/8 tests pass.

## Consequences

- Protocol compatibility tests (spec §16 Phase 1) extend the contract test to real
  listeners and the stdio bridge.
- Client documentation must state that 2025-era clients need a reconnect or refresh to see
  permission changes.
- The 2026 client caches list results (`ClientOptions` cache dispositions). Phase 1 must
  verify which cache hints the server emits for `tools/list` and make them private and
  per-client (spec §5.3).

## Re-evaluation triggers

- SDK 2.x minor releases that change `createMcpHandler`, legacy handling or caching → re-run
  the contract tests before bumping.
- A target client (Claude Code or Codex release) that needs live `list_changed` while still
  on a 2025-era protocol.
