# 0009. Policy evaluation model, policy schemas and the policy version

- Status: Accepted
- Date: 2026-11-10
- Phase: 1
- Spec references: §2 (decisions 05, 25, 26, 29, 35), §5.3, §6.1–§6.4, §6.5, §8.1, §17

## Context

Spec §6.1 fixes the evaluation order and "deny always wins", requires intersection of
global, console, application, operation-category and per-client policies with default
deny for writes and sensitive reads, and says no MCP argument can upgrade authority. §6.2
gives an illustrative policy and asks for a final validated contract that rejects
ambiguous declarations. §6.3 requires reviewed risk that policy can raise but never lower,
and high-consequence operations that may be disabled by default. §6.4 defines sensitivity
tags and denies secrets to every client. §6.5 binds approvals to a security-policy
version. §8.1 makes `UNIFI_MCP_FORCE_READ_ONLY` an immutable deployment override and the
database the operational authority. This ADR records the model implemented in
`packages/policy`.

## Decision

### A pure decision function

`evaluate(input) → Decision` has no I/O and no hidden state, so the dispatcher can run it
at enqueue, at dispatch and after approval (stage 9) and always get the same answer for
the same state. Its inputs are the verified client record, server-side policy, the
reviewed operation metadata and the console's probed capability. Nothing comes from tool
arguments or request headers. It returns the first denial (`reason`, `stage`, a safe
`message`, `policyVersion`) or `{ allowed, effectiveRisk, approvalRequired,
policyVersion }`.

| Stage | Check                                                                                                                                        | Reasons                                                                           |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1     | Client active and unexpired (re-checked every time)                                                                                          | `client_inactive`, `client_expired`                                               |
| 2     | Explicit `consoleId`; client may use the console; for site-scoped operations, explicit `siteId` permitted by both the client and the console | `target_required`, `console_not_permitted`, `site_required`, `site_not_permitted` |
| 3     | Writes: deployment hard lock                                                                                                                 | `hard_read_only`                                                                  |
| 4     | Writes: runtime mode `read_write`                                                                                                            | `runtime_read_only`                                                               |
| 5     | Console state (`enabled`/`read_only`/`disabled`); module state on that console (`read_write`/`read_only`/`disabled`; unlisted = disabled)    | `console_disabled`, `console_read_only`, `module_disabled`, `module_read_only`    |
| 6     | Rule layers by intersection: global, console, module, client                                                                                 | `denied_by_*_policy`, `not_granted_to_client`                                     |
| 7     | Operation supported by the console's probed API version (`unknown` counts as unsupported)                                                    | `operation_unsupported`                                                           |
| 8     | Default-disabled operations; credential exposure; sensitivity denials and grants; risk elevation and approval requirement                    | `operation_disabled`, `credential_exposure_forbidden`, `sensitive_*`              |

`purpose: 'discover'` (tool and operation listings) skips only the site check, because no
site is chosen yet. An unknown console is reported as `console_not_permitted`, so replies
do not reveal which consoles exist.

### Rule layers and selectors

- **Permissions** are `<moduleId>.<category>.<read|write>`, fixed in reviewed operation
  metadata and checked for consistency with the operation's module, category and effect.
- **Selectors** are permission patterns with `*` for any whole segment
  (`network.*.read`, `*.firewall.*`) or exact operation ids (`operation:<id>`). Category
  and operation granularity come from selectors at every layer.
- **Global, console and module layers**: a matching `deny` denies; an optional `allow` list
  turns the layer into an allowlist. Without `allow`, the layer passes what it does not
  deny.
- **Client layer**: nothing passes unless the client's `allow` list matches, reads
  included; a matching `deny` denies.
- **Writes** additionally need the hard lock off, runtime mode `read_write`, a console that
  is not read-only and module state `read_write`. Every one of these defaults to denying.

### Sensitive data, risk and disabled operations

- Tags (spec §6.4): `personal_identifier`, `network_identity`, `camera_image`, `recording`,
  `access_log`, `credential`, `location`, `biometric_or_access_identity`. A client needs a
  grant for every tag of an operation; global and console `denySensitive` override grants.
- `credential` can never be granted (rejected by the schema) and an operation tagged with
  it is always denied, even if a tampered client record contains the grant. Adapters must
  project credential fields out of results instead of tagging operations with it.
- Effective risk is the reviewed risk raised by matching `riskElevations` (only `medium`
  or `high` can be specified, and a lower value never applies). High risk, or reviewed
  `approvalRequired`, means approval is required.
- Operations marked `defaultDisabled` in reviewed metadata (for example console-side
  exfiltration features, threat model T17) are denied unless the global policy lists them
  in `enabledOperations`.

### Schemas

Zod schemas for the global policy, console policy and client policy are strict: unknown
keys, malformed selectors, unknown tags, empty site lists, `low` risk elevations and a
selector that is both allowed and denied in the same layer are rejected. Defaults are the
safe state: runtime `read_only`, no rules; console `enabled` with every site but no modules;
module `read_only`; client `active` with no consoles, no grants and no sensitive grants.
The console and client schemas are stored by the console registry (step 6) and client
store (step 7), and the bootstrap YAML import (step 9) uses the same schemas.

### Deployment override

`UNIFI_MCP_FORCE_READ_ONLY` accepts `true/1/yes/on` and `false/0/no/off`
(case-insensitive). **Unset or empty means `true`.** The spec does not define the unset
case, and failing safe means writes need a deliberate `false`. Any other value is a
startup error.

### Policy version and the store

- One monotonic `security_policy.version` covers every security-relevant change: global
  policy edits and runtime mode switches through `PolicyStore`, and console or client
  policy changes through `bumpPolicyVersion` inside their own transactions. Approvals bind
  to it (spec §6.5), so any policy change invalidates pending approvals. This invalidates
  more than strictly necessary, which is the safe direction.
- `PolicyStore` reads the policy on every call (a change made by the CLI in another
  process applies to the next request), writes with compare-and-set on the version, and
  records every change in the audit trail in the same transaction. It refuses an
  `AuditLog` bound to another connection, because the entry would not be atomic with the
  change.
- A stored policy that fails validation is never interpreted: `POLICY_INVALID`, and every
  operation is denied until an administrator replaces it or restores a backup.
- Actors are `admin`, `cli` or `system`. An MCP client cannot be represented as a policy
  actor and is refused at runtime as well.

## Evidence (verified 2026-11-10)

- `tests/unit/policy/` and `tests/security/policy-invariants.test.ts`: 105 tests, including
  every stage on its own, stage order, the default state, hard lock over every write
  variant for execution and discovery, deny-wins at each layer with five selector forms,
  credentials never released, and risk never lowered.
- Mutation checks, each making at least one test fail: hard lock removed; runtime mode
  ignored; client grant not required; client deny ignored; layer deny ignored; credential
  allowed; elevation able to lower risk; unknown capability allowed; site check skipped;
  module read-only ignored; unset hard lock treated as false; credential grantable in the
  schema; invalid stored policy accepted.

## Consequences

- Enabling a write takes five deliberate steps: hard lock off, runtime `read_write`,
  console not read-only, module `read_write`, and a client grant (plus approval for high
  risk). This matches the spec's default state and is documented in docs/security.md.
- Every evaluation reads one policy row. This is cheap, and it keeps processes consistent
  without cache invalidation.
- Admin "verify effective permissions" (spec §13.1) and tool discovery can be built
  directly on `evaluate()`.

## Re-evaluation triggers

- Policy reads becoming measurable in request latency (then cache keyed on the version).
- A need for rule semantics that selectors cannot express (for example time windows).
- Per-resource (not per-site) authorisation requirements in Phase 2–4 adapters.
