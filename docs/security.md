# Security model

> **Status: Phase 1 in progress.** This page currently covers the permission model
> (`packages/policy`, ADR 0009), write safety (`packages/core`, ADR 0010), client tokens
> (`packages/mcp-server`, ADR 0013) and connections to consoles (`packages/unifi-api`,
> ADR 0012). Client tokens, the approval workflow, TLS
> and network isolation are added as they are implemented. Commands shown as
> `unifi-mcp …` belong to the CLI (Phase 1 step 9) and are not available yet.

## Principles

- **Deny by default.** A new installation can read nothing and write nothing until an
  administrator grants it.
- **Deny always wins.** One matching denial anywhere overrides every allow.
- **Identity comes only from the client's token.** Nothing an AI client puts in a tool
  call (a client id, a flag, a header) can change what it is allowed to do.
- **The same check everywhere.** The same decision runs when a tool list is built, when a
  request is queued, just before it is sent to UniFi, and again after a human approval.

## How a request is decided

Every request is checked in this order. The first failure denies it.

1. The client is active and its token has not expired.
2. The request names a console (there is no default console) that this client may use,
   and, where the operation targets a site, a site that both the client and the console
   allow.
3. **Writes:** the deployment hard lock is off (`UNIFI_MCP_FORCE_READ_ONLY=false`).
4. **Writes:** the service's runtime mode is read-write.
5. The console is enabled (and not read-only, for writes), and the module (Network,
   Protect, Access) is enabled on that console (read-write, for writes).
6. No global, console, module or client rule denies the operation, any allowlist at those
   layers includes it, and the client has been **explicitly granted** it.
7. The console's API version supports the operation.
8. The operation is not disabled by default (or has been enabled), the client has a grant
   for every kind of sensitive data the operation returns, and policy does not deny that
   data. High-risk operations then also need a human approval.

## Making writes possible

Writes are off at five independent levels, and all five must be changed on purpose:

| Level      | Default                                            | Changed by                                              |
| ---------- | -------------------------------------------------- | ------------------------------------------------------- |
| Deployment | Hard lock **on** (also when the variable is unset) | `UNIFI_MCP_FORCE_READ_ONLY=false` and a restart         |
| Service    | Runtime mode read-only                             | `unifi-mcp policy set-runtime-mode` (not yet available) |
| Console    | Enabled (reads and writes)                         | Console policy                                          |
| Module     | Read-only once enabled on a console                | Console policy, per module                              |
| Client     | No grants at all                                   | Client scopes                                           |

The hard lock cannot be changed from the database, the admin UI or an MCP client. While it
is on, no write runs through any path, including actions that were already approved.

## Scopes and rules

Operations are identified by a **permission** of the form `<module>.<category>.<read|write>`,
for example `network.devices.read`. Rules use **selectors**:

| Selector                  | Matches                                             |
| ------------------------- | --------------------------------------------------- |
| `network.devices.read`    | Reading Network devices                             |
| `network.*.read`          | Every Network read                                  |
| `*.firewall.*`            | Reading and writing firewall settings in any module |
| `operation:<operationId>` | One specific operation                              |

Rules exist at four layers: global, per console, per module on a console, and per client.
A layer can deny selectors and, optionally, restrict itself to an allowlist. A client
always needs an explicit allow, even for reads.

A rule set that both allows and denies the same selector in one layer, uses an unknown
field, or uses a malformed selector is rejected as a whole.

## Sensitive data

Operations that return personal or security-relevant data carry sensitivity tags:
`personal_identifier`, `network_identity`, `camera_image`, `recording`, `access_log`,
`location`, `biometric_or_access_identity`. A client needs a separate grant for each tag;
global or console policy can deny a tag for everyone.

Credentials (API keys, passwords, Wi-Fi passphrases, voucher codes and the like) are never
returned to any client. There is no grant for them.

## Risk and approval

Each operation's risk (low, medium, high) is reviewed in code. Policy can raise the risk of
selected operations but never lower it. High-risk operations need an independent human
approval through the admin UI or CLI before they run.
Some high-consequence operations are disabled by default and must be enabled explicitly in
the global policy before they can be granted at all. See
[approval-workflow.md](approval-workflow.md).

## Write safety

Every operation, whatever tool started it, runs through one dispatcher (ADR 0010):

- **Checked twice.** Permissions are evaluated when a request arrives and again just
  before it is sent to the console. Revoking a client, switching to read-only mode or
  changing policy therefore also stops work that is already waiting.
- **Audit first.** A write is recorded in the audit trail before it is sent. If that is
  not possible, it is not sent. A read's result is returned only after its audit entry is
  stored.
- **Recorded.** Every write gets an execution id and a status (`queued`, `executing`,
  `succeeded`, `failed`, `outcome_unknown`, `cancelled`, `denied`) that only moves forward.
  The same execution can never be sent twice.
- **Never guessed.** If the console does not answer, or answers in a way that leaves open
  whether the change was applied, the write is marked `outcome_unknown` and is **not
  retried**. Check the console before trying again. After a restart, writes that were in
  progress are marked `outcome_unknown` and writes that were waiting are cancelled; none is
  re-run.
- **Idempotency keys.** A client may send a key with a write. Sending the same request with
  the same key again returns the known status instead of executing it again.
- **One change per resource at a time.** Conflicting writes to the same console resource
  run one after another.
- **Bounded.** Requests are rate-limited per client, per console, per module on a console
  and globally, and queues are bounded. Excess requests get `rate_limited` (with a retry
  delay) or `queue_full` immediately, and requests that cannot start in time get
  `deadline_exceeded`. Defaults are conservative because Ubiquiti documents no local API
  rate limits.
- **Only documented operations.** An operation can be registered only if its method and
  path are in the official vendor contract recorded in `api-specs/`. Unknown arguments are
  rejected, and argument values can never change the request path, host, method or
  headers.

## Client tokens

Each MCP client has its own identity and bearer token (ADR 0013).

- Tokens look like `umcp_<id>_<secret>` and contain 256 random bits. A token is shown once,
  when it is created or rotated. The service stores only a hash of it.
- Every request is checked against the token store, so revoking a token or a client stops
  it at once. Revocation also cancels the client's queued work and closes its open
  connections.
- Repeated failed sign-ins from one address are throttled.
- The token is never logged, stored in the audit trail or passed to tool code. Logs and
  audit entries show the client id and the token id.
- Only an administrator or the CLI can create, rotate or revoke tokens.

## Connections to consoles

The service talks only to consoles an administrator has configured, and only through the
documented local API of each module (ADR 0012).

- **Only allowed networks.** Before every connection the console's address is resolved and
  checked against the egress allowlist (private networks, carrier-grade NAT and IPv6
  unique-local by default; see `UNIFI_MCP_EGRESS_ALLOW_CIDRS` in
  [configuration.md](configuration.md)). If a host name resolves to any address outside
  the allowlist, nothing is sent. The connection goes to the checked address, so a DNS
  change in between cannot redirect it. Cloud metadata, multicast and unspecified
  addresses are always refused.
- **Verified TLS.** By default the console certificate must be valid for the configured
  host and issued by a trusted CA, or by a CA you configure for that console. For consoles
  with self-signed certificates, configure a **pin** instead (see below). Turning
  verification off is possible only per console, is recorded in the audit trail and is
  logged as a warning. The certificate is checked before anything, including the API key,
  is sent.
- **Fixed requests.** Method, path, query parameters and body come from the reviewed
  operation; argument values are encoded and cannot change the host, path or headers.
  Redirects are never followed. Responses are size-limited.
- **Credentials are write-only.** API keys and tokens are stored encrypted and are never
  shown again by the service, in its logs or in the audit trail.
- **Version checks.** An operation runs only if the console's application version is known
  and within the range the operation was reviewed for.

### Computing a pin

A pin is the base64 SHA-256 of the certificate's public key (`sha256/…`). Read it from the
console (replace the host and port):

```sh
openssl s_client -connect 192.0.2.10:443 -servername 192.0.2.10 </dev/null 2>/dev/null \
  | openssl x509 -pubkey -noout \
  | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -binary | base64
```

Compare the value with the console itself (for example on its local display or a trusted
network) before trusting it. A pin stops working when the console generates a new key, so
configure the new pin before the old certificate is replaced.

## Policy changes

The global policy and runtime mode are stored in the database. Every change:

- is validated first; an invalid policy is rejected as a whole;
- increases the **policy version**, which invalidates all pending approvals;
- is recorded in the audit trail, in the same transaction as the change;
- takes effect on the next request, including changes made by the CLI while the service
  runs.

If the stored policy is ever found invalid, every operation is denied until an
administrator fixes it or restores a backup. Policy can only be changed by an administrator
or the CLI, never by an MCP client.
