# 0012. UniFi transport, egress control and the console registry

- Status: Accepted
- Date: 2026-11-10
- Phase: 1
- Spec references: §2 (decisions 03, 04, 13, 22, 23), §4.1, §4.2, §4.4, §9, §17; threat model T1, T2, T10, T11

## Context

Spec §4.4 requires: only a configured console id, an allowlisted module base and a
registered path template; segment-encoded parameters; fixed methods; no user-controlled
headers, host, absolute URL or redirects; private-address/VPN allowlisting with DNS
re-resolution protection; TLS verification by default with custom CA and verified pinning,
and a per-console, audited, conspicuously warned insecure override; bounded timeouts and
response sizes; credentials never in errors, URLs, metrics, results or logs; HTTP 200 not
assumed to be success. §4.2 defines the console record. §2 decision 23 requires
version-aware adapters with explicit unsupported outcomes.

## Decision

### Request construction (executor)

`UnifiExecutor` implements the dispatcher's `OperationExecutor` (ADR 0010). The request
is built only from the registered descriptor: the module's local base path (from
provenance, below), the path template rendered with segment-encoded values, the declared
`queryParameters`, and, for `requestBody: 'json'`, the remaining arguments as a JSON body.
Registration (ADR 0010, extended here) refuses descriptors where any argument has no
declared place, a GET has a body, or `apiVersionRange` does not parse. Headers are fixed:
the module's credential header, `Accept: application/json`, `Accept-Encoding: identity`
(no decompression), `Content-Type` for JSON bodies, and `Host`.

### Module endpoints

| Module  | Base path                    | Default port | Credential header               |
| ------- | ---------------------------- | ------------ | ------------------------------- |
| network | `/proxy/network/integration` | 443          | `X-API-KEY: <key>`              |
| protect | `/proxy/protect/integration` | 443          | `X-API-KEY: <key>`              |
| access  | (none)                       | 12445        | `Authorization: Bearer <token>` |

A contract test compares this table with every `provenance.json`. The runtime
`ContractInventory` is loaded from the committed `operations.json` files, so the registry
can admit only documented method/path pairs.

### Egress

`EgressGuard` resolves the host on every connection. **Every** resolved address must be
inside the allowlist (a mixed answer is treated as rebinding), and the connection is made
to the validated address, with the configured host name used only for SNI and identity
checks. Default allowlist: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
`100.64.0.0/10` (carrier-grade NAT, common for VPNs) and `fc00::/7`;
`UNIFI_MCP_EGRESS_ALLOW_CIDRS` replaces it. Loopback and link-local are not in the default.
Unspecified, multicast, reserved, broadcast and cloud-metadata addresses are refused even
if allowlisted. IPv4-mapped IPv6 addresses are checked as IPv4.

### TLS

The TLS socket is connected and verified before the HTTP request is created, so a failed
verification never sends the credential.

- `verify` (default): `rejectUnauthorized`, system CAs or only a configured CA, identity
  checked against the configured host (name or IP).
- `pinned`: the leaf certificate's SPKI SHA-256 (base64, the `pin-sha256` form) must match
  one of up to 10 pins; CA and name are not checked. This is the route for consoles'
  self-signed certificates (the Access listener's is vendor-stated, ADR 0005).
- `insecure`: no verification. Explicit per console, audited, logged as a warning when
  configured and on first use per process, never global.

TLS 1.2 minimum, ALPN `http/1.1`. Node's `checkServerIdentity` runs only after CA
validation succeeds, so pinning is enforced in the `secureConnect` handler instead.

The HTTP request uses `createConnection` with the verified socket and **no** `agent`
option. Setting `agent: false` makes Node ignore `createConnection` and open its own,
unvalidated connection; this was found while building the transport tests, and the code
documents it.

### Response mapping

| Condition                                                     | Error code                                                                      | Not sent | Transient    | Write uncertain |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------- | ------------ | --------------- |
| Egress refused / DNS failed                                   | `egress_denied` / `dns_failed`                                                  | ✓        | DNS only     |                 |
| Connect failed / TLS failed / pin mismatch                    | `connect_failed`, `tls_*`                                                       | ✓        | connect only |                 |
| Redirect                                                      | `redirect_refused`                                                              |          |              | no              |
| Body too large, invalid JSON on 2xx, lost connection, timeout | `response_too_large`, `invalid_response`, `connection_lost`, `upstream_timeout` |          | lost/timeout | ✓               |
| 401/403, 404, other 4xx                                       | `upstream_unauthorized`, `upstream_not_found`, `upstream_rejected`              |          |              | no              |
| 429                                                           | `upstream_rate_limited` (Retry-After honoured)                                  |          | ✓            |                 |
| 5xx                                                           | `upstream_unavailable`                                                          |          | ✓            | ✓               |

Only the HTTP status and a documented, pattern-checked upstream `code` are passed on;
upstream free text is never returned (it is untrusted, threat model T8). Application-level
success shapes (for example Access `{"code":"SUCCESS"}`) are checked by the module adapters
(Phase 2–4). Default response cap 4 MiB, per operation up to 32 MiB.

### Console registry

Storage migration 6 (`consoles`, `console_modules`). A console has a UUID, a unique alias,
a validated host (name or IP literal; no scheme, path or port), its TLS trust, a validated
console policy (ADR 0009) starting with **no modules enabled**, and per module an optional
port override, an encrypted credential (secret record per module kind, write-only, 8–1024
printable characters) and the last observed application version. Every change is audited
in the same transaction; policy, TLS and removal also bump the policy version. Only
`admin`, `cli` and `system` actors can change it. A stored policy that fails validation
makes the console unavailable (deny), with an error log.

### Capability

`capability(console, operation)` is `supported` only if the observed version of the module
satisfies the operation's `apiVersionRange` (dotted numeric comparators, all must hold);
`unknown` (no probe yet) and unparseable versions are denied like `unsupported`. The probes
themselves are module-specific (Phase 2).

### Tests

A synthetic HTTPS console (`tests/fixtures/mock-console.ts`) records every request. Test
certificates (a CA, a CA-signed server certificate, a self-signed certificate) are generated
at test time with the `openssl` CLI into a temporary directory; no private key is committed.
The test suite therefore needs `openssl` on the PATH.

## Evidence (verified 2026-11-10)

- `tests/unit/unifi-api/` (executor against the synthetic console, registry, egress),
  `tests/contract/module-endpoints.test.ts`, `tests/unit/core/versions.test.ts` and
  `tests/security/unifi-transport-gates.test.ts` (dispatcher → registry → HTTPS executor →
  console: only registered method/path pairs reach the console; argument values cannot
  reshape the URL; unknown or incompatible versions send nothing; credentials never
  appear).
- Mutation checks, each making at least one test fail: pin not checked; CA verification
  off; identity checked against the address; redirects accepted; no size cap;
  `agent: false`; mixed DNS answers accepted; always-deny list ignored; upstream text passed
  through; 5xx writes treated as certain; unknown version treated as supported; version
  range ignored; host not validated.

## Consequences

- A console's API key for Network and one for Protect are stored separately, even if the
  same key works for both (unverified, ADR 0005); operators may enter the same value twice.
- Loopback consoles (for example a local test console) need an explicit
  `UNIFI_MCP_EGRESS_ALLOW_CIDRS` entry.
- The `Host` header carries the configured host name; consoles reached by IP get the IP.
- Retries reconnect and re-resolve, so each retry is validated again.

## Re-evaluation triggers

- A vendor-documented way to scope keys per application (then one credential per console).
- HTTP/2-only console endpoints.
- A requirement for proxy-based egress (an outbound HTTP proxy).
