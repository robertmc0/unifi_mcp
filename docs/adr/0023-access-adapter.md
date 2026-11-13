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
