# 0014. stdio bridge: a message relay with one client token

- Status: Accepted (supersedes the "Proposed" bridge section of ADR 0003)
- Date: 2026-11-10
- Phase: 1
- Spec references: §2 (decisions 02, 16), §3.1, §7.1, §12, §16 Phase 1 gate, §18 item 7

## Context

Spec §3.1 requires the stdio bridge to be a lightweight local process that speaks stdio to
its harness and forwards to the central service over authenticated Streamable HTTP, with
no UniFi connectivity, no SQLite access, no configuration ability and its own client
identity. §12 and the Phase 1 gate require that its stdout carries only protocol frames.
ADR 0003 preferred a transport relay over an SDK proxy and asked a spike to confirm: that
the v2 client transport relays modern-era traffic without a `Client` on top; that stdout
carries only protocol frames; and that the bridge exits non-zero, writing to stderr only,
on authentication failure.

## Decision

Implement the **transport relay** (ADR 0003 option 1) in `packages/stdio-bridge`:

- `StdioServerTransport` (harness side) and `StreamableHTTPClientTransport` (service side)
  connected by `Relay`, which copies JSON-RPC messages unchanged in both directions. There
  is no tool logic, so the bridge supports whichever protocol era the harness negotiates
  and cannot drift from the service's per-client tool list or policy.
- For 2025-era sessions the relay calls `setProtocolVersion()` with the version from the
  `initialize` response, as an SDK client would (the MCP 2025-06-18 revision requires the
  header on later requests). 2026-era requests carry their version in the envelope, from
  which the transport derives its headers.
- A request that cannot be delivered is answered with a JSON-RPC error
  (`-32001` unreachable), so the harness never waits forever. A 401/403 from the service is
  answered with `-32002`, stops all further forwarding, and exits with code 1.
- Configuration: `UNIFI_MCP_URL` (http only for loopback hosts; no credentials, query or
  fragment), the token from `UNIFI_MCP_TOKEN_FILE` (preferred, warned if readable by others)
  or `UNIFI_MCP_TOKEN` (removed from the environment once read, even if the configuration is
  then rejected), `UNIFI_MCP_BRIDGE_LOG_LEVEL` (default `warn`). Invalid configuration exits
  with code 2 before any connection.
- The token is sent only to the configured URL: `redirectPolicy: 'same-origin'` (the SDK
  default, pinned) plus `redirect: 'error'` on every request, so not even a same-origin
  redirect is followed.
- stdout: protocol frames only. Logs use the telemetry logger (through its storage-free
  `@unifi-local-mcp/telemetry/logger` export) on stderr, and every `console` method is
  redirected to stderr in case a dependency prints.
- Exit codes: 0 on stdin close or SIGTERM/SIGINT, 1 when the token is rejected, 2 for
  invalid configuration.

## Evidence (spike, verified 2026-11-10)

- `tests/integration-mock/stdio-bridge.test.ts` runs the real bridge process between real
  SDK v2 clients (`StdioClientTransport`) and the real service: 2025-era and 2026-era
  clients negotiate their era, see the per-client tool list, and call tools; identity in the
  audit trail is the bridge's client. A raw run with debug logging produces only JSON-RPC
  frames on stdout and the logs on stderr. A forged token produces exactly one `-32002`
  frame and exit 1. Remote plaintext, credentials in the URL, malformed tokens and a missing
  token exit 2 with empty stdout. A same-origin redirect is not followed. Revocation stops
  the bridge's next call.
- `tests/unit/stdio-bridge/` covers the relay with fake transports (messages unchanged,
  version propagation only for the `initialize` response, delivery failures answered, a
  rejected token fatal once, closing), the console redirection, and the configuration
  rules.
- `tests/security/stdio-bridge-isolation.test.ts` walks the bridge's complete module
  graph: the only workspace import is `@unifi-local-mcp/telemetry/logger`; no storage,
  SQLite, TLS/DNS, UniFi transport, dispatcher, policy or adapter module is reachable; the
  bridge's own code does not mention UniFi credentials, the master key or the data
  directory; its declared dependencies are the MCP SDK and telemetry only.
- Mutation checks, each making at least one test fail: protocol version not propagated;
  `console` output to stdout; logs to stdout; authentication failure not fatal; messages
  forwarded after a fatal error; plaintext to a remote host allowed; token kept in the
  environment; redirects followed.

## Consequences

- The bridge needs Node.js 26 on the harness machine; packaging it as a single file or
  container entry point is part of step 11.
- A private CA for an HTTPS service URL is configured with `NODE_EXTRA_CA_CERTS`.
- 2025-era harnesses see permission changes after reconnecting (stateless legacy serving,
  ADR 0003), exactly as over HTTP.

## Re-evaluation triggers

- An SDK change that makes the transport require a `Client` for header handling.
- A harness that needs server-initiated requests (sampling, elicitation) through the
  bridge; the relay passes them, but they are untested until a tool uses them.
