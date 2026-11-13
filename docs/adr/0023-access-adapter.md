# 0023. UniFi Access adapter

- Status: Accepted (extended as Phase 4 proceeds)
- Date: 2026-11-13
- Phase: 4
- Spec references: §4.1, §4.3, §4.4, §4.5, §6.3, §16 Phase 4, §17

## Context

Access is the third module. Its contract is the API reference PDF, transcribed into
adapter schemas by ADR 0022 (107 operations, 98 generated). Its installed version cannot
be observed and is declared by an administrator, up to 4.2.16 (ADR 0021 §5). This ADR
records how the adapter reaches an Access console and, as Phase 4 proceeds, its version
handling and its reviewed operations.

Phase 1 already prepared the module (ADR 0012): `MODULE_IDS` includes `access`, with the
default port 12445, no path prefix, bearer authentication and its own credential kind;
the CLI stores the token, the port and the module mode like any other module.

## 1. Transport (step 4)

- **Endpoint.** `https://<console>:12445/api/v1/developer/…`, the local base of the
  provenance (PDF §1.2, §2.6). The port can be changed per console
  (`unifi-mcp console enable-module <alias> --module access --port <n>`), because Ubiquiti's
  help article names 12455 (ADR 0005). Nothing else about the URL is configurable.
- **Credential.** `Authorization: Bearer <token>`, stored encrypted as
  `console.access_api_token` (`console set-credential <alias> --module access`). Access
  tokens carry permission scopes (§1.1), a vendor-side layer in addition to this
  project's policy.
- **TLS.** §2.6: "The server certificate is self-generated and untrusted." It is a
  different certificate from the console's own on port 443. TLS trust is kept per console,
  and pinned mode accepts any of up to ten pins, so an administrator pins both:
  `console check <alias> --module access` shows the certificate presented on the Access
  port and its pin, and `console set-tls <alias> --tls pinned --pin <443 pin> --pin
<Access pin>` stores them. A pinned console then accepts either certificate on either
  port. Both belong to the same console, so this widens nothing that matters, and it needs
  no new storage. §12.1 lets an administrator install their own certificate; that upload
  is not offered by this service (ADR 0022 §5).
- **Result envelope.** Every Access response is `{code, msg, data}` (§2.8). §2.2, "HTTP
  Status Code Reference", lists only these codes, so the HTTP status of an error is not
  documented. The module therefore declares an envelope (`MODULE_ENDPOINTS.access.envelope`)
  and the executor applies it:
  - a response succeeds only when `code` is `SUCCESS`, whatever the HTTP status;
  - a 2xx response without a recognisable `code` is `invalid_response` (and, for a write,
    an uncertain outcome, because the console may have acted);
  - any other code is an error carrying that code, classified by the code rather than the
    status: the token codes (`CODE_AUTH_FAILED`, `CODE_ACCESS_TOKEN_INVALID`,
    `CODE_UNAUTHORIZED`) are `upstream_unauthorized`; codes ending in `_NOT_FOUND`,
    `_NOT_EXIST` or `_NOT_EXISTS` are `upstream_not_found`; `CODE_SYSTEM_ERROR` is
    `upstream_unavailable` (transient; uncertain for writes); every other code is
    `upstream_rejected`, and a refused write is neither retried nor uncertain;
  - an HTTP 429 stays a rate limit, and a response without a code falls back to the
    status, as for the other modules;
  - `msg` is vendor text and never reaches a client or the log; the code and status do,
    as for Network and Protect.
- **Payload.** The generated response schemas describe the envelope without `code` and
  `msg` (ADR 0022 §4), so validation strips both and a result holds `data` and, where
  documented, paging.
- Nothing else is specific to Access: egress, DNS re-validation, timeouts, size limits,
  redirect refusal and the dispatcher's retry rules apply unchanged (ADR 0012).

## 2. Declared version (step 5)

ADR 0021 §5 (B2): Access reports no version, so a host administrator declares it.

- **Storage.** Migration 10 adds `declared_version`, `declared_at` and `declared_by` to
  `console_modules`, apart from `observed_version`. `MODULE_ENDPOINTS` says where each
  module's version comes from: `probe` for Network and Protect, `declared` for Access.
- **Declaring.** `unifi-mcp console declare-version <alias> --module access --version
<x.y.z>` (or `--clear`). `ConsoleRegistry.declareVersion` accepts only the CLI actor,
  only modules whose version is declared, and only dotted numbers. No MCP tool or admin
  page calls it. Every declaration and withdrawal is audited
  (`console.version_declared`, `console.version_declaration_removed`). When the version
  that operations were checked against changes or is withdrawn, the policy version is
  bumped, so pending approvals are invalidated. A first declaration, or one replacing an
  expired declaration, bumps nothing, because nothing could have been approved without a
  version.
- **Counting.** `capability()` and `moduleVersion()` use the effective version: the
  observed one for probed modules, and for declared modules a declaration less than 30
  days old. After that the module is `version_unknown` again. A declared version above
  4.2.16 is recorded and its operations are refused as `operation_unsupported`.
- **Labels.** Every result and approval request of a module with a declared version
  carries a warning: "The access version 4.2.16 was declared by an administrator, not
  observed; the service cannot check it. It counts until <date>." The approval summary
  shows it as `versionNotice`. `unifi_list_consoles` lists such a module with
  `versionSource: "declared, not observed"` and `versionExpiresAt`. An
  `operation_unsupported` message names the version as declared. A `version_unknown`
  message for Access says that an administrator must declare the version, instead of
  "try again shortly". The admin UI marks the version "(declared, not observed)", and
  `doctor` warns when no version is declared, when the declaration has expired, or when it
  expires within 7 days.
- The version monitor never probes Access (it has no probe), so the `console_versions`
  health check is unaffected.

## Evidence

- `tests/unit/unifi-api/executor.test.ts`, "result envelope": success only with
  `SUCCESS`; a 2xx without a code is `invalid_response`, uncertain for a write; error codes
  classified whatever the status (200, 400) and the vendor text never returned;
  `CODE_SYSTEM_ERROR` transient and uncertain for a write; 429 still a rate limit; the
  envelope applies only to modules that declare it. The existing test "use bearer
  authentication and the module port for Access" covers the request side.
- `tests/integration-mock/access-transport.test.ts` sends all 98 generated operations
  through the real executor to a synthetic Access API (`tests/fixtures/access-console.ts`)
  on its own port: each request has the documented method and path, the bearer token,
  every sampled query parameter and exactly the sampled body; each response, a sample of
  the generated schema inside the envelope, reads back through that schema without `code`
  or `msg`. A refused token is `upstream_unauthorized` with `CODE_UNAUTHORIZED`, and an
  HTTP 200 with `CODE_USER_WORKER_NOT_EXISTS` is `upstream_not_found`.
- Mutation checks, each making a test fail: every 2xx accepted as success; the error class
  taken from the status instead of the code; `CODE_SYSTEM_ERROR` not transient; Access
  without its envelope; a 429 with a code no longer a rate limit.
- Step 5: `tests/unit/unifi-api/consoles.test.ts`, "declared versions" (CLI only, Access
  only, dotted numbers; 30 days to the millisecond; a version above the range
  unsupported; audit and policy-version bumps, including none after an expired
  declaration); `tests/unit/core/dispatcher.test.ts` (the `version_unknown` and
  `operation_unsupported` messages; the warning on a read and on an approval request, and
  the approval summary's `versionNotice`; no warning for observed versions);
  `tests/unit/cli/cli.test.ts` (`declare-version` arguments, output, `console show`,
  withdrawal, and `doctor`); `tests/integration-mock/mcp-http.test.ts`
  (`unifi_list_consoles` over MCP). Mutation checks, each making a test fail: declarations
  never expiring; an administrator allowed to declare; no approval invalidation; Network
  declarable; no label on results; no label on approvals; `doctor` silent.
- Not verified: how a real Access console sets the HTTP status of an error, and whether
  its tokens' scopes match the permission keys (provenance `unverified`). Both need an
  installed Access (ADR 0021, evidence C).

## Consequences

- Access operations can run through the existing dispatcher and executor; nothing about
  the console registry, the CLI or the storage changes.
- The declared version (step 5) and the reviewed operation metadata (step 6) are still
  needed before any Access operation is registered.

## Re-evaluation triggers

- A real Access console reports errors in a way the envelope rule misreads.
- Ubiquiti documents HTTP statuses for Access errors, or changes the envelope.
- Pinning both certificates on one console proves inadequate (for example, different
  hosts for the console and Access).
