# Security model

> **Status: Phase 1 in progress.** This page currently covers the permission model, which
> is implemented in `packages/policy` (ADR 0009). Client tokens, the approval workflow, TLS
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
approval through the admin UI or CLI before they run (approval workflow: Phase 1 step 5).
Some high-consequence operations are disabled by default and must be enabled explicitly in
the global policy before they can be granted at all.

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
