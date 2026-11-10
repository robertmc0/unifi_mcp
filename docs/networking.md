# Networking

> **Status: Phase 1 in progress.** This page covers the MCP listener and egress to
> consoles, as implemented (ADR 0012, ADR 0013). Docker Compose examples for single- and
> dual-interface deployments arrive with packaging (Phase 1 step 11); the separate admin
> listener with step 10.

## The MCP listener

MCP clients connect to one Streamable HTTP endpoint, `/mcp`, on the address and port set by
`UNIFI_MCP_HTTP_BIND` (default `127.0.0.1`) and `UNIFI_MCP_HTTP_PORT` (default `3000`).
`/livez` and `/readyz` on the same listener are the health endpoints
([monitoring.md](monitoring.md)).

Bearer tokens must not cross a network in plaintext. The service therefore accepts three
setups:

| Setup                       | Configuration                                                    | When                                                                                                                         |
| --------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Built-in HTTPS              | `UNIFI_MCP_HTTP_TLS_CERT_FILE` and `UNIFI_MCP_HTTP_TLS_KEY_FILE` | Clients connect over the network directly.                                                                                   |
| Loopback only               | `UNIFI_MCP_HTTP_BIND=127.0.0.1` (default)                        | Clients run on the same machine (or use the stdio bridge on it).                                                             |
| Plaintext behind protection | `UNIFI_MCP_HTTP_ALLOW_PLAINTEXT=true` with a non-loopback bind   | A TLS-terminating reverse proxy in front, or Docker publishing the port on the host's loopback only (`127.0.0.1:3000:3000`). |

A non-loopback bind without TLS and without `UNIFI_MCP_HTTP_ALLOW_PLAINTEXT=true` stops the
service at startup. With the opt-in, the service logs a warning at every start. The opt-in
does not make the listener safe by itself: the host-level binding, firewall or proxy must
actually prevent plaintext access from other machines.

### Host and Origin checks

To defeat DNS rebinding and cross-site requests from browsers, `/mcp` accepts only:

- a `Host` header naming `localhost`, `127.0.0.1`, `[::1]` or a name listed in
  `UNIFI_MCP_HTTP_ALLOWED_HOSTS` (comma-separated, without port);
- no `Origin` header (normal for MCP clients), or an origin whose host is one of the local
  names or is listed in `UNIFI_MCP_HTTP_ALLOWED_ORIGINS`.

If clients reach the service as `mcp.example.lan`, add that name to
`UNIFI_MCP_HTTP_ALLOWED_HOSTS`. Requests with other values are answered with 403.

### Reverse proxies

A proxy must pass the original `Host` header (or one listed in
`UNIFI_MCP_HTTP_ALLOWED_HOSTS`) and the `Authorization` header, must not buffer
`text/event-stream` responses, and should allow long-lived responses. The service never
trusts `X-Forwarded-*` headers. Behind a proxy, the failed-authentication throttle sees
the proxy's address for every client.

## Connections to consoles

The service connects only to configured consoles, on addresses inside the egress
allowlist (`UNIFI_MCP_EGRESS_ALLOW_CIDRS`; private networks, carrier-grade NAT and IPv6
unique-local by default). See [security.md](security.md#connections-to-consoles) for TLS
verification and pinning. Consoles reached over a VPN must be reachable from the service's
host, and their addresses must be in the allowlist; the service does not route or forward
traffic.
