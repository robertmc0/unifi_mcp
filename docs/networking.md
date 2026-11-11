# Networking

> **Status: Phase 1 complete.** This page covers the MCP listener, the admin listener
> and egress to consoles, as implemented (ADR 0012, ADR 0013, ADR 0016), and the
> single-host Docker example (`deploy/compose.single.yml`, ADR 0017). Dual-interface and
> TLS examples are Phase 5.

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

## The admin listener

The optional admin web interface ([administration.md](administration.md#admin-web-interface))
has its own listener, separate from MCP, with its own port, address, certificate and
sign-in. It is **off** unless `UNIFI_MCP_ADMIN_ENABLED=true`, and then listens on
`127.0.0.1:3001` by default. MCP tokens are not accepted on it, and its session cookie is
not accepted on `/mcp`.

The same three setups as for the MCP listener apply, with the `UNIFI_MCP_ADMIN_*`
variables ([configuration.md](configuration.md#admin-listener)). In addition:

- The session cookie is `Secure`. Browsers send it over plain HTTP only to `localhost` or
  `127.0.0.1`, so a plaintext admin listener works only when you browse to a loopback
  address: on the host itself, through an SSH tunnel
  (`ssh -L 3001:127.0.0.1:3001 host`), or through a TLS reverse proxy.
- **Docker:** `127.0.0.1` inside a container is the container's own loopback, which a
  published port cannot reach. To keep the interface host-local, bind the container to its
  interface (`UNIFI_MCP_ADMIN_BIND=0.0.0.0` with `UNIFI_MCP_ADMIN_ALLOW_PLAINTEXT=true`) and
  publish the port on the **host's** loopback only: `127.0.0.1:3001:3001`. Never publish it
  as `3001:3001`, which exposes it on every host interface. `deploy/compose.single.yml`
  is set up this way, with the admin port line commented out until you enable it.
- If you browse to it by another name (for example through a proxy at
  `admin.example.lan`), add that name to `UNIFI_MCP_ADMIN_ALLOWED_HOSTS`. The proxy must pass
  the original `Host` and `Origin` headers.
- Never expose the admin interface to the internet or to networks that MCP clients use.

## Connections to consoles

The service connects only to configured consoles, on addresses inside the egress
allowlist (`UNIFI_MCP_EGRESS_ALLOW_CIDRS`; private networks, carrier-grade NAT and IPv6
unique-local by default). See [security.md](security.md#connections-to-consoles) for TLS
verification and pinning. Consoles reached over a VPN must be reachable from the service's
host, and their addresses must be in the allowlist; the service does not route or forward
traffic.
