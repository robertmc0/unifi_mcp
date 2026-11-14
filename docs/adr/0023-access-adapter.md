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

## 3. Reads (step 6)

- **Building.** `accessOperation()` joins the generated facts of one operation (method,
  path, schemas, the vendor-stated minimum version, the documentation link and the
  versioned request fields, all from the transcription and `operations.json`) with
  hand-written review metadata. The minimum, link and vendor permission are emitted into
  the generated module, so no reviewed file repeats them; the reviewed override of
  ADR 0021 §3 item 2 (2.2.6 for §10.5 and §10.6) sits in the generator configuration and
  may only raise a minimum.
- **Range.** `>=<minimum> <=4.2.16` (`ACCESS_MAX_VERSION`, ADR 0021 §5 U1).
- **Field versions.** Descriptors carry `versionedFields`. The dispatcher refuses a call
  that uses one on an older version at stage 7 (`operation_unsupported`), naming the
  argument and the version, before anything is sent. This is generic: any module can use
  it.
- **Results.** A result is the envelope's `data`; the paging facts are `pageNum`,
  `pageSize`, `total` and `nextPageNum` (from `pagination`, or `page` and `total` beside
  `data` in §9.2).
- **39 reads**, all low risk, console-level, `access.<category>.read`. Named tools:
  `access_list_doors`, `access_get_door`.
- **Sensitivity.** People: users, visitors and user group members carry
  `personal_identifier` (names, e-mail and phone, employee numbers) and
  `biometric_or_access_identity` (NFC cards, license plates, Touch Pass, schedules). NFC
  cards and Touch Passes carry both; the enrollment state only the second. System logs
  carry `access_log` and `personal_identifier`; log resources (video and thumbnail paths)
  `access_log` and `recording`. Doors, door groups, devices, policies, schedules, user
  groups, identity resources and webhook endpoints carry none: they describe the
  installation, not people.
- **Bounded histories.** Spec §6.4 requires Access histories to have time and size
  limits. `access.logs.list` requires `since` and `until`, at most 31 days apart (the
  PDF's own limit for the export, §9.3), and `page_size` at most 100.
- **Credentials.** Removed from every result at any depth, after the projection:
  `pin_code.token` (a PIN hash, reversible by trying every PIN; the empty `pin_code`
  stays), `secret` (webhook signing secret) and `headers` (forwarded to a webhook
  receiver, the usual place for its credentials). NFC card tokens stay: they address
  cards in the API (§6.7 to §6.10) and are not the card's secret, and the reads that
  return them need `biometric_or_access_identity`.
- **Not offered.** The PIN generator (§6.1): its result is a PIN, a credential (spec
  §6.4), so it is not registered.
- **Registration.** `ADAPTERS` lists Access without a version probe; the coverage matrix
  matches an Access operation by its contract revision (a date, not a version).

## 4. Writes (step 6)

58 of the 60 generated writes are offered (reviewed 2026-11-14 against the
transcription): 51 high risk with human approval, 7 medium, 7 of them off by default. The
PIN generator (§6.1, §3) is not offered, and the system-log query is a read.

- **The rule.** Access controls physical doors, so the review starts from spec §6.3:
  physical-access actions are high risk whatever their HTTP method. **High**: every write
  that can open, lock or ring a door (remote unlock, lock rules, emergency state, the
  doorbell), or change who may open which door, when, or with what credential (users and
  their status, NFC cards, PINs, QR codes, license plates, Touch Passes, policies,
  schedules, holiday groups, door groups, user-group membership and parents, visitors,
  NFC enrollment, which can also reset a UniFi card); every deletion; anything that sends
  data or invitations away from the console (webhook endpoints, UniFi Identity invitations)
  or grants network resources (UniFi Identity Wi-Fi and VPN assignments); buying Touch
  Passes; and removing the API server certificate. **Medium**: only writes that change
  nobody's access by themselves: creating an access policy, schedule, holiday group or
  door group (nothing uses it until a high-risk assignment or update refers to it),
  creating an empty user group, renaming an NFC card, ending an enrollment session.
- **Worst case where the PDF is silent.** It does not say whether a new user starts with
  any access, what a user group inherits from its parent, or what deleting a policy,
  schedule or group in use does. Creating a user and changing a group's parent are
  therefore high risk, and deletions carry approval cautions that members "may" lose
  access.
- **Door control has its own permission.** The unlock, lock rules and emergency state use
  category `doors` (`access.doors.write`), although the vendor's scope for them is
  `edit:space`, like door groups. A client can then manage door groups
  (`access.spaces.write`) without being able to open a door.
- **Off by default** (listed in `enabledOperations` before any client can use them): the
  two PIN assignments, because the client chose the PIN and knows it while the approver
  cannot see it (it is redacted); the emergency state, which acts on every door at once;
  creating and changing webhook endpoints, because the console then sends events, including
  who opened which door, to any address outside this service's egress controls; buying
  Touch Passes, which charges the payment method configured in Access (§6.17); and removing
  the API server certificate, after which the pinned connection fails until an
  administrator pins the new certificate, which the service cannot undo.
- **The unlock names no actor (reviewed narrowing).** §7.9 accepts `actor_id` and
  `actor_name`, which the console records as who unlocked the door. Identity comes only
  from the verified token (AGENTS.md), so a model must not write a name into the
  console's access log: the operation does not accept the body, and none is sent. The
  generic rule in `accessOperation`: a narrowing that removes `body` sends no body.
- **Approval cautions** state the consequence the approver must weigh: an unlock opens a
  physical door or moves a gate; lock rules can keep a door unlocked; evacuation and
  lockdown act on every door; the doorbell may get someone to open the door; a status
  change can reactivate a user; `force_add` moves a card from someone else; an invitation
  lets its recipient join as the user; Identity grants can reach the local network; policy,
  schedule, holiday-group and door-group changes affect everyone who uses them; PINs are
  known to the requester; webhooks send events outside the egress controls; purchases are
  charged; the certificate must be re-pinned.
- **Sensitivity.** Writes that take or return names and contact details need
  `personal_identifier` (user and visitor create and update, invitations); writes that
  take or return a credential need `biometric_or_access_identity` (cards, PINs, plates,
  QR codes, enrollment); Touch Pass writes, whose results name the holder, need both, as
  the matching reads do.
- **Credentials.** A PIN in a request is sent to the console as given; the redactor treats
  any field named `pin…` as secret, so it never reaches a log, an audit entry, an approval
  summary or a result, and approval arguments are stored encrypted (ADR 0011). Results are
  minimised like reads: webhook `secret` and `headers` and PIN hashes are removed, also
  from the results of creating a user or a webhook endpoint. Approvers also see NFC card
  tokens as `[REDACTED]` (the redactor's `token` rule), although they are not secrets.
- **Retry classes and locks.** Creations and actions (the unlock, the doorbell, enrollment,
  invitations, QR codes, purchases, batch Touch Pass assignment, Identity assignments) are
  not idempotent; updates, assignments that set a state, and deletions are. Writes are
  never retried once they may have reached the console, whatever the class (ADR 0010).
  Locks: one per object (`console/access/<kind>/<id>`: a user, visitor, group, door,
  policy, schedule, device, card, endpoint), and one per console for creations of a kind,
  the emergency state, batch Touch Pass assignment, invitations and the certificate.
- **Results.** A console refusal (a result code other than `SUCCESS`) is a failed write,
  neither retried nor uncertain; a success status without a code and `CODE_SYSTEM_ERROR`
  are uncertain (§1). Writes the PDF answers with `"data": "success"` return `null`.

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
- Step 6, reads: `tests/contract/access-security-review.test.ts` (the review table of
  every implemented operation; ranges from the generated minimum to 4.2.16, the minimum
  raised only for §10.5 and §10.6; the removed credentials and log bounds);
  `tests/integration-mock/access-reads.test.ts` (all 39 reads through the dispatcher and
  executor with a declared version: one request with the documented method, path, query
  and token; credential sentinels, an undocumented field and the vendor `msg` never
  returned; the declared-version warning; paging facts; sensitive grants; the log
  window; field versions, the raised §10.6 minimum, 4.3.x refused, an undeclared version
  explained); `tests/unit/core/dispatcher.test.ts` (versioned fields, for an argument and
  a body path). Mutation checks, each making a test fail: credentials not removed; PIN
  hashes kept; people untagged; the log window not bounded; the bound widened to 4.3.24;
  field versions dropped; a permission renamed.
- Step 6, writes: `tests/contract/access-security-review.test.ts` (every write's row; the
  physical-access list, each high risk with approval; door control under
  `access.doors.write`; exactly the seven reviewed medium writes; the unlock without
  `body`); `tests/integration-mock/access-writes.test.ts` (every write and body variant
  through the dispatcher, approval service and executor with a declared version: nothing
  sent before approval, then exactly one request with the documented method, path, query,
  token and body, and no second request on a repeated resumption; a PIN sentinel sent to
  the console but never in a result, approval summary, audit entry or log; webhook secrets,
  PIN hashes, undocumented fields and the vendor `msg` never returned; the declared-version
  notice on approvals and results. Negative tests, each sending nothing: read-only grants,
  the hard lock, a read-only module, no declared version, 4.3.x, default-disabled
  operations, missing sensitive grants, door-group rights used to unlock, the unlock's
  actor fields, `control_cmd` before 4.2.16, and a policy that tries to lower the unlock's
  risk (it can only raise, shown on a medium write). A console refusal is failed with one
  request; a missing result code and `CODE_SYSTEM_ERROR` are uncertain with one request;
  an idempotency key runs once). Mutation checks, each making a test fail: the unlock
  without approval; the unlock with its actor fields; the unlock under `access.spaces`;
  a PIN assignment on by default; the webhook secret or a PIN hash returned; user creation
  without its sensitivity tags; a body declared although the narrowing removed it.
- Not verified: how a real Access console sets the HTTP status of an error, and whether
  its tokens' scopes match the permission keys (provenance `unverified`). Both need an
  installed Access (ADR 0021, evidence C). No Access write has run against a console.

## Consequences

- Access operations run through the existing dispatcher, approval service and executor;
  nothing about the console registry, the CLI or the storage changes.
- 97 of 107 documented Access operations are offered. The rest are the PIN generator (not
  offered) and the nine operations ADR 0022 §5 leaves to step 7.
- Access writes are the first whose consequences are physical. Their review assumes the
  worst case wherever the PDF is silent; a live run (evidence C) may show that some can be
  lowered, which would be a reviewed change to this ADR and the review table.

## Re-evaluation triggers

- A real Access console reports errors in a way the envelope rule misreads.
- Ubiquiti documents HTTP statuses for Access errors, or changes the envelope.
- Pinning both certificates on one console proves inadequate (for example, different
  hosts for the console and Access).
- A console shows that a write this review classed by its worst case is harmless (for
  example, that new users start without access), or that an actor-free unlock is
  recorded in a way operators cannot use.
