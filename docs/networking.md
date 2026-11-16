# Networking

> **Status:** this page covers the three listeners (MCP, admin, metrics), egress to
> consoles, and the three Docker Compose examples: one host with loopback publishing,
> one host with built-in HTTPS, and two networks (ADR 0012, ADR 0013, ADR 0016, ADR 0017,
> ADR 0028). The examples are run by `npm run test:containers`. The two-network example
> is tested on Docker bridge networks, not yet on two physical interfaces.

## Which example

| You have                                                          | Use                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| MCP clients on the Docker host only (or over SSH with the bridge) | [`deploy/compose.single.yml`](../deploy/compose.single.yml)                                |
| Clients on other machines, one network                            | [`deploy/compose.tls.yml`](../deploy/compose.tls.yml): built-in HTTPS                      |
| Clients on one network, consoles on another                       | [`deploy/compose.dual.yml`](../deploy/compose.dual.yml): [two networks](#two-networks)     |
| A reverse proxy you already run                                   | `compose.single.yml` behind it: [example](../deploy/example-reverse-proxy.md) (not tested) |

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
`text/event-stream` responses, and should allow long-lived responses: an event
subscription stays open for up to an hour ([events.md](events.md)). The service never
trusts `X-Forwarded-*` headers. Behind a proxy, the failed-authentication throttle sees
the proxy's address for every client.

### Built-in HTTPS in Docker

`deploy/compose.tls.yml` serves HTTPS from the container, with your certificate and key
as Docker secrets, and publishes the port on **one** host address that you must name:

```sh
UNIFI_MCP_PUBLISH_IP=192.0.2.5 UNIFI_MCP_PUBLIC_NAME=mcp.example.lan \
  docker compose -f compose.tls.yml up -d
```

- `UNIFI_MCP_PUBLIC_NAME` is the name clients use. It must be in the certificate, and it
  becomes the allowed `Host`.
- There is no plaintext listener in this setup, and no `…_ALLOW_PLAINTEXT` switch.
- The admin interface stays on the host's loopback, as in the single-host example.

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

## The metrics listener

Optional Prometheus metrics ([monitoring.md](monitoring.md#metrics)) have a third
listener of their own. It is **off** unless `UNIFI_MCP_METRICS_ENABLED=true`, and then
listens on `127.0.0.1:9464` by default. It serves one page, `GET /metrics`, to a scraper
that presents the token from `UNIFI_MCP_METRICS_TOKEN_FILE`. MCP client tokens and admin
sessions are not accepted on it, and its token is accepted nowhere else.

- The same three setups as for the MCP listener apply, with the `UNIFI_MCP_METRICS_*`
  variables ([configuration.md](configuration.md#metrics-listener)): loopback, built-in
  TLS, or plaintext behind something that protects it.
- **Docker:** as for the admin interface, bind the container to its interface
  (`UNIFI_MCP_METRICS_BIND=0.0.0.0` with `UNIFI_MCP_METRICS_ALLOW_PLAINTEXT=true`) and
  publish the port on the **host's** loopback only: `127.0.0.1:9464:9464`.
  `deploy/compose.single.yml` has these lines, commented out until you enable metrics.
- A Prometheus server on another machine needs built-in TLS
  (`UNIFI_MCP_METRICS_TLS_CERT_FILE` and `UNIFI_MCP_METRICS_TLS_KEY_FILE`) or a TLS proxy:
  the token must not cross a network in plaintext.
- Put it on the management side. MCP clients have no use for it.

## Two networks

Use `deploy/compose.dual.yml` when MCP clients and UniFi consoles are on different
networks and the service is the only thing allowed on both.

```text
   client LAN                                         management LAN
 ┌────────────┐   HTTPS :3000   ┌──────────────────┐   HTTPS to consoles   ┌──────────┐
 │ MCP client │ ──────────────► │    unifi-mcp     │ ────────────────────► │ console  │
 └────────────┘                 │                  │                       └──────────┘
                                │ MCP listener on  │   admin :3001, metrics :9464
        no route  ✗────────────►│ the client side  │◄── (optional, management side only)
        to the management LAN   │ only; no         │
                                │ forwarding       │
                                └──────────────────┘
```

What the example does:

- **Two attachments, no published ports.** The container gets an address on each LAN
  through its own host interface (ipvlan). Each listener is bound to one of those
  addresses: MCP to the client side, the admin interface and metrics to the management
  side. No listener uses `0.0.0.0`.
- **No forwarding.** The container has no capabilities (so it cannot change routes or
  firewall rules), and `net.ipv4.ip_forward` is set to 0 for it. Docker's default for a
  container is 1.
- **Named consoles only.** `UNIFI_MCP_CONSOLE_CIDRS` is required and becomes the egress
  allowlist. List your consoles, not the LAN. A console address on the client side is
  refused even if an administrator configures it.
- **HTTPS for MCP**, with your certificate. The admin interface and metrics, if you
  enable them, need TLS too (`UNIFI_MCP_ADMIN_TLS_*`, `UNIFI_MCP_METRICS_TLS_*`), because
  their address is on a LAN.
- **The default route is on the management side**, for consoles behind a router or a
  VPN. The client network has no gateway.

Setting it up: copy [`deploy/dual.env.example`](../deploy/dual.env.example) to `.env`
beside the Compose file and set every value. Compose refuses to start while one is
missing.

Two interfaces are not isolation by themselves. The service does not forward, but the
**host** might: keep packet forwarding between the two LANs off on the host, or filtered
by its firewall, and do not give the container `NET_ADMIN`.

With ipvlan, the host itself cannot reach the container through the same interface. Run
`unifi-mcp` commands with `docker compose exec unifi-mcp unifi-mcp …`, and test from
another machine on each LAN.

### Checking it

On the host:

```sh
run='docker compose -f compose.dual.yml exec unifi-mcp'
$run cat /proc/sys/net/ipv4/ip_forward              # 0
$run cat /proc/sys/net/ipv6/conf/all/forwarding     # 0, if IPv6 is on
$run grep Cap /proc/1/status                        # all 0000000000000000
$run unifi-mcp doctor
$run unifi-mcp console check <alias>
sysctl net.ipv4.ip_forward net.ipv6.conf.all.forwarding   # the host's own setting
```

From a machine on the **client** LAN (replace the names and addresses with yours):

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://mcp.example.lan:3000/mcp     # 401: reachable, wants a token
nc -vz -w 3 198.51.100.10 3001                                                  # refused: no admin interface here
nc -vz -w 3 192.0.2.10 3000                                                     # no answer: the management side
nc -vz -w 3 192.0.2.1 443                                                       # no answer: a console
```

From a machine on the **management** LAN:

```sh
nc -vz -w 3 192.0.2.10 3000      # refused: MCP is not on this side
nc -vz -w 3 192.0.2.10 3001      # open only if you enabled the admin interface
```

For IPv6, add `net.ipv6.conf.all.forwarding: '0'` to `sysctls` in the Compose file, use
IPv6 subnets for the networks, and repeat the checks with the IPv6 addresses
(`nc -6`, `curl -6`). The egress allowlist takes IPv6 CIDRs.

### What is tested

`npm run test:containers` runs the service exactly as `compose.dual.yml` defines it,
with a client container on the client network and a synthetic console on the management
network (`tests/container-network/`). It checks that a client reads through MCP over
HTTPS; that the console sees only the service; that the client cannot reach the console,
the management side or the admin interface; that the MCP listener cannot be used as a
proxy or a tunnel; that forwarding is off and cannot be turned on; that each listener
answers on its own side only; and that a console address outside the allowlist is
refused.

Not covered: the two LANs are Docker bridge networks in the test, so the ipvlan
attachment to real interfaces, IPv6, and the host's own forwarding and firewall are
yours to check with the commands above.

## Connections to consoles

The service connects only to configured consoles, on addresses inside the egress
allowlist (`UNIFI_MCP_EGRESS_ALLOW_CIDRS`; private networks, carrier-grade NAT and IPv6
unique-local by default). See [security.md](security.md#connections-to-consoles) for TLS
verification and pinning. Event subscriptions follow the same rules: a WebSocket to the
module's address and port, opened only while a client subscribes ([events.md](events.md)). Consoles reached over a VPN must be reachable from the service's
host, and their addresses must be in the allowlist; the service does not route or forward
traffic.
