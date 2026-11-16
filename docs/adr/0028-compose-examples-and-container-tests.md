# 0028. Two-network and TLS Compose examples, and container tests

- Status: Accepted
- Date: 2026-11-16
- Phase: 5
- Spec references: §7.3, §9.1, §9.2, §9.3, §16 Phase 5, §17 ("Dual-network setup proves no routing/forwarding and correct interface-bound services", "Docker Compose examples are runnable and secure by default")

## Context

Phase 1 shipped one Compose example: one host, the MCP port on the host's loopback
(ADR 0017). Spec §9.2 asks for a dual-interface example with the MCP listener "bound to
the selected client-side container IP/address", no forwarding, restricted egress, and
proof; the layout in §15 also lists a TLS example and a reverse-proxy example. Until
now the examples were checked as text and by a manual smoke test.

An experiment on Docker Engine 29.6.1 (2026-11-16), with one container on two bridge
networks and a published port, showed two things:

- The published port reached the container's address on its **gateway** network only.
  Docker forwards a published port to one address; it cannot deliver "the client side"
  and "the management side" to different listeners of one container.
- `net.ipv4.ip_forward` was **1** inside the container: Docker's default.

## Decision

1. **The two-network example attaches the container to both LANs directly**
   (`deploy/compose.dual.yml`): one ipvlan network per host interface, a fixed address on
   each, and no published ports. Each listener is bound to one address: MCP to the
   client side, the admin interface and metrics to the management side. With bridge
   networks and published ports the listeners could not be told apart (see the
   experiment), so the spec's "bound to the client-side address" would have been a
   label, not a fact.

2. **Forwarding is switched off explicitly**: `sysctls: net.ipv4.ip_forward: '0'`. The
   container has no capabilities, so it can change neither that nor its routes. The IPv6
   line is given as a comment, because the sysctl fails where IPv6 is off.

3. **Required values, no defaults, for everything that decides exposure**: both
   interfaces, subnets and addresses, the public name, and the console addresses
   (`UNIFI_MCP_CONSOLE_CIDRS`, which becomes the egress allowlist). Compose refuses to
   start while one is missing. `deploy/dual.env.example` lists them with documentation
   addresses.

4. **MCP uses built-in HTTPS in this example.** Clients are on a network, so there is no
   plaintext option in the file. The default route is on the management side
   (`gw_priority`); the client network has no gateway.

5. **A TLS example for one host** (`deploy/compose.tls.yml`): HTTPS from the container,
   the port published on one host address that must be named. No plaintext switch.

6. **The reverse-proxy example is a document**, `deploy/example-reverse-proxy.md`, marked
   as not tested: it lists what a proxy must do and illustrates it with nginx. The
   project runs no proxy in its tests.

7. **Container tests** (`npm run test:containers`, `tests/container-network/`): the
   shipped Compose files run on the local Docker engine with the image built from the
   working tree. Overlays replace only what a test host cannot provide: the image, the
   file locations, and, for the two-network file, the two LANs (isolated Docker bridges
   instead of ipvlan). A client container is on the client network only; a synthetic
   console (a 30-line HTTPS server in the service image) is on the management network
   only. Nothing is pulled and nothing leaves the machine. They are opt-in, like the
   live tests, and are not part of `npm run check`, which must work without Docker.

8. **Static checks stay in `npm run check`** (`tests/contract/packaging.test.ts`): the
   three examples have the same hardening block, the hard lock on, no host access, no
   wildcard bind in the two-network file, no gateway on the client network, and an
   example value for every required variable.

## Evidence

Run on 2026-11-16, Docker Engine 29.6.1, Compose 5.3.1, linux/amd64: 12 tests pass.

- `tests/container-network/dual-network.test.ts`:
  - `ip_forward` is 0 and cannot be set; all capability sets are empty; the root
    filesystem is read-only;
  - from the management network, MCP is refused and the admin interface answers; from
    the client network, MCP answers and the admin and metrics ports are refused;
  - a client reads `network.info.get` through MCP over HTTPS; the console logs requests
    from the service's management address only, with the key, for the documented path
    only;
  - without a token the client gets 401; the console key is in no answer;
  - the client cannot connect to the console, to the service's management address or to
    the management gateway;
  - `CONNECT`, an absolute-URI request, a path traversal and a `url` parameter on the MCP
    listener reach nothing; operation arguments naming a host are `invalid_arguments`;
  - a console configured with an address on the client network is refused by the egress
    guard.
- `tests/container-network/single-host.test.ts`: `compose.single.yml` starts healthy,
  locked and read-only, publishes one port on the host loopback only, and stops with exit
  code 0; `compose.tls.yml` serves HTTPS with the mounted certificate under the
  configured name, refuses another `Host`, has no plaintext listener and publishes one
  port.
- Mutation checks, each caught: the sysctl removed; MCP bound to `0.0.0.0`; the admin
  interface bound to `0.0.0.0`; the egress allowlist widened to both networks.

**Not verified:**

- ipvlan on two physical interfaces. The service definition is the tested one; the
  network definitions in `compose.dual.yml` are not, on this machine.
- IPv6.
- The host's own forwarding and firewall, which no container test can prove.
- The nginx illustration.
- linux/arm64.

## Consequences

- The two-network example needs Linux, two host interfaces and ipvlan. The host cannot
  reach the container through the same interface, so administration is by
  `docker compose exec`.
- Container tests need Docker and about 40 seconds. CI runs them in their own job.
- An operator who wants two networks with published ports can still build that, but it
  is not what the example shows, because the listeners would not be bound to sides.

## Re-evaluation triggers

- A run on two physical interfaces, or with IPv6, that behaves differently.
- A Docker release that changes how published ports choose an address, or the default
  for `ip_forward`.
