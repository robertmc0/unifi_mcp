# 0019. UniFi Protect adapter

- Status: Accepted (extended as Phase 3 proceeds)
- Date: 2026-11-11
- Phase: 3
- Spec references: §4.1, §4.3, §4.5, §6.3, §6.4, §11, §16 Phase 3, §19

## Context

Phase 3 implements the official UniFi Protect integration API. Phase 0 recorded revision
7.3.74 (74 operations). On 2026-11-11 the developer portal's index listed **v7.4.96** as
the current Protect revision. Building against an older contract than the vendor
publishes would leave the newest documented operations out, and consoles update Protect
automatically.

Protect differs from Network in ways that need their own decisions, recorded in later
sections as each step lands:

- three documented WebSocket subscriptions (devices, events, model updates);
- a binary response (`GET /v1/cameras/{id}/snapshot`, `image/jpeg`);
- a multipart upload (`POST /v1/files/{fileType}`);
- responses that grant access by themselves (RTSPS stream URLs, talkback session URLs);
- physical-world actions (sirens, relays, alarm outputs, arming and disarming) and an
  irreversible one (permanently disabling a camera microphone).

## Decision

### 1. Contract baseline: 7.4.96 replaces 7.3.74 (step 1)

`api-specs/protect/7.4.96/` is the Protect baseline: OpenAPI 3.1.0, 83 operations (38 HTTP
reads, 3 WebSocket subscriptions, 42 writes), recorded checksums, the same local base URL
`https://{consoleHost}/proxy/protect/integration`. ~~The 7.3.74 record is removed, because
7.4.96 is a strict superset of it.~~ _Superseded by §7: 7.3.74 is the current official
release and is kept._

Compared with 7.3.74:

- **Added (9):** external arm profiles (list, get, create, update, delete, arm, disarm),
  `POST /v1/speakers/{id}/stop-siren`, and the `GET /v1/subscribe/updates?modelKeys=…`
  WebSocket subscription.
- **Removed:** none.
- **Changed:** resolved schemas differ for 9 shared operations. The camera video mode
  gains `antiFlicker` (both camera reads, the camera PATCH, whose body accepts it, and the
  microphone disable); the NVR gains a **required** `featureFlags`; sensors gain a
  **required** `isMountedIncorrectly` (both sensor reads and the sensor PATCH); the devices
  subscription carries both. `POST /v1/cameras/{id}/talkback-session` documents a 409
  when another talkback session is in progress.

  _Correction (2026-11-11):_ this section first said the 409 was the only change. That
  comparison looked at the operation objects without resolving their `$ref`s, so changes
  inside shared component schemas were missed. The comparison now resolves every
  reference.

The document still declares no authentication scheme. The live test of Phase 2 showed that
the console's Integrations key authorises it ([ADR 0005](0005-official-local-unifi-api-contracts.md#live-evidence-phase-2-2026-11-11)).

`scripts/reconcile-api-coverage.ts --write` now derives the inventory of a new OpenAPI
revision that has no `operations.json` yet, as `api-specs/README.md` describes.

### 2. Generated schemas (step 2)

The ADR 0018 generator produces `packages/unifi-protect/src/generated/protect-7.4.96.ts`
from the cached, checksum-verified document. What Protect needed:

- **Names without vendor operationIds.** With `naming: 'path'`, an operation is named from
  its method and path (`GET /v1/cameras/{id}/snapshot` → `getV1CamerasByIdSnapshot`), and
  `OPERATIONS` is keyed by the inventory key `"<METHOD> <path>"`. Two operations that would
  get the same name fail generation.
- **Transport and response type** on every generated operation: `transport` is
  `websocket` for `/v1/subscribe/*` (the inventory's rule) and `http` otherwise;
  `responseType` is `json`, `none` or a binary media type. Only `image/jpeg` is accepted as
  binary, and only when documented as a binary string; its output is a `Uint8Array`. The
  Network module gained the same two fields and nothing else.
- **More of JSON Schema**, in the same spirit as ADR 0018: requests strict and bounded,
  responses tolerant of new values but never passing undocumented data on.
  - `oneOf`/`anyOf` are unions. A `null` member makes the rest nullable, as does
    `type: [T, "null"]`. Request unions accept a value that matches any member; the members
    are strict objects or distinct primitives, so `oneOf` and `anyOf` do not differ in
    practice.
  - `const` is a literal. A union of string constants is an enum, relaxed to a string in
    responses like other enums.
  - A discriminated `oneOf` with an explicit mapping (inline or as a component, without
    `allOf` inheritance) selects the variant by its literal. In responses, an unknown
    discriminator value is accepted and keeps only the discriminator.
  - `pattern`, `exclusiveMinimum`/`exclusiveMaximum` and `minProperties` bind requests;
    responses ignore them. `format: uri` is a URL in requests and a string in responses.
  - Typed maps (`additionalProperties` with a schema) are accepted in responses only (the
    alarm hub's terminal status). `additionalProperties: true` next to properties changes
    nothing: requests forward only documented properties, and responses strip the rest.
    An object without properties that is open to anything is refused.
  - `allOf` with one primitive reference and constraints beside it narrows the primitive.
    An enum without a type whose values are all strings is a string enum.
- **Reviewed omission.** `POST /v1/files/{fileType}` (upload a device asset) is a
  multipart request whose body is documented only as a binary string: the form field that
  carries the file is not named. Sending it would mean guessing, so it is not generated
  and not implemented. Generation fails if the operation disappears, so the decision is
  revisited with each revision.

While adding tests, a bug in the existing primitive intersection came to light:
`values.reduce(Math.max)` passes the index and the array too, so two numeric bounds
became `NaN`. It never reached Network's output; it made Protect's narrowed camera
`micVolume` (1–100) reject every value. The intersection is fixed, and a non-finite bound
now fails generation.

### 3. Binary responses (step 3)

A descriptor may declare `responseType: 'image/jpeg'` (`BINARY_RESPONSE_TYPES` in
`@unifi-local-mcp/core`). The registry allows it only on GET reads that are neither
projected nor paged.

- **Executor.** It sends `Accept: image/jpeg` and accepts a 2xx response only when the
  content type is exactly the documented one and the bytes start with the JPEG signature
  (`FF D8 FF`). Anything else, such as a login page or JSON, is `invalid_response`. Error
  responses keep the documented JSON handling. The descriptor's `maxResponseBytes` caps
  the size as before.
- **Dispatcher.** The bytes are checked again (`Uint8Array`, whatever the adapter's
  schema says) and returned in the envelope's `media` field. `data` only describes them
  (`{ mediaType, bytes }`). The audit entry records that the read happened, never the
  content. Nothing logs response bodies.
- **MCP.** The tool result carries the bytes as one `image` content block (base64,
  `mimeType`). The JSON text and `structuredContent` are the envelope without `media`.
  Tested with real SDK clients of both protocol eras.

Which client may read an image is a policy question: the snapshot carries the
`camera_image` sensitivity tag (step 5), so it needs its own grant.

### 4. Adapter, version probe and supported range (step 4)

`packages/unifi-protect` mirrors the Network adapter. `protectOperation(key, review)` joins
the generated contract facts of one operation, by inventory key, with hand-written
security metadata. WebSocket subscriptions cannot be made into HTTP operations (their key
type excludes them). Every Protect operation is console-level (`siteScoped: false`); the
permission is `protect.<category>.<effect>`; the documentation URL is derived from method
and path, and a contract test compares it with the inventory for every operation.

- **Version probe.** `GET /v1/meta/info` (`protect.info.get`) reports `applicationVersion`.
  The service probes it like Network's (ADR 0018 §3).
- **Supported range: `>=7.4.96 <8`.** _Superseded by §7_ (now `>=7.3.74 <8`, narrowed per
  operation).
- **Credentials** (`credentials.ts`). `url` (the talkback session endpoint) and
  `pin_code` (an arm profile PIN, which the contract sends only in requests) are removed
  from every result at any depth. The RTSPS stream URLs carry access tokens but use
  generic names (`high`, `low` …), so the stream operations remove them themselves. The
  deep removal moved to `@unifi-local-mcp/core` (`withoutFields`) and is shared with
  Network.

### 5. Reads (step 5)

All 38 documented HTTP reads are implemented: low risk, no approval, console-level,
permission `protect.<category>.read`. Categories follow the API's device types (`cameras`,
`lights`, `sensors`, `sirens`, `speakers`, `chimes`, `relays`, `bridges`,
`link_stations`, `alarm_hubs`, `fobs`, `nvrs`, `viewers`, `liveviews`), plus `alarm`
(local and external arm profiles), `users` (users and ULP users) and `files`. Named tools:
`protect_list_cameras`, `protect_get_camera`, `protect_get_snapshot`.

Sensitivity, reviewed field by field:

- **`camera_image`**: the snapshot (8 MiB cap, 20 s timeout, returned as image content
  per §3).
- **`personal_identifier`**: users and ULP users (names, e-mail addresses).
- **`location`**: key fobs. A fob's presence state (`ONLINE` … `DEVICE_LOST`) says
  whether the person carrying it is at the site.
- Devices are infrastructure, as in Network, and carry no tag. A live view's `owner` is
  only a user id.

**RTSPS streams.** `GET /v1/cameras/{id}/rtsps-stream` returns stream URLs whose path is an
access token: anyone who has one can watch the stream. The operation is implemented, but
its projection turns each quality into `true` or `false`, so a client learns which
streams exist and never their URLs. A person who needs a URL reads it in UniFi Protect.

### 6. Writes (step 6)

41 of the 42 documented writes are implemented (the multipart upload is the §2 omission):
25 high risk with human approval, 16 medium. The rule used for every one:

- **High** — anything that can arm or disarm the alarm (every alarm-manager write: local
  and external arm profiles, settings, the alarm webhook; arming and disarming are treated
  like locking and unlocking, spec §6.3); anything that can silence or disable alarms or
  monitoring (camera settings, which include motion and smart detection; sensor, siren,
  link-station, alarm-hub and fob settings; stopping a siren); and anything acting in the
  physical world (sounding a siren, switching a relay output, triggering an alarm-hub
  output).
- **Medium** — visible, reversible effects with no security consequence: floodlight,
  speaker, chime and bridge settings; viewers and live views; PTZ presets and patrols;
  short test sounds; a POS transaction overlay; enabling and disabling RTSPS streams
  (their URLs never reach a client, so enabling one gives a client nothing).
- **Off by default** — `protect.cameras.disable_microphone_permanently`, which cannot be
  undone (high, and listed in `enabledOperations` before it can run), and
  `protect.cameras.start_talkback`: the session endpoint is a credential and is removed
  from the result, so an MCP client cannot use the session it starts while it blocks a
  person's talkback (the contract's 409).

Retry classes: PATCH and DELETE are idempotent; POST actions and creations are not and are
never retried once they may have reached the console. Locks: writes to one device run in
turn (`console/protect/<kind>/<id>`); every alarm-manager write shares one lock per
console, because arming state spans profiles.

**PINs.** External arm profiles take an optional `pin_code` in create and update requests.
It is sent to the console as given. The redactor already treats any field whose name
contains the word `pin` as secret, so the PIN never appears in logs, audit entries or
approval summaries, and `pin_code` is removed from results. Tested with a distinctive PIN
value.

**PTZ** is medium although pointing a camera away reduces coverage: presets and patrols
are routine, visible and undone by the next preset. Revisit if a deployment relies on PTZ
cameras for coverage.

### 7. Two revisions: the official release 7.3.74 and the newest documented 7.4.96

The owner's live run (2026-11-11) showed a console on Protect **7.3.74**, which UniFi OS
reported as the latest official release with no update offered. The developer portal
documents 7.4.96 ahead of its rollout. With `>=7.4.96 <8`, every Protect operation would
have been refused on current consoles, so both revisions are supported:

- **Both records are kept**: `api-specs/protect/7.3.74/` (restored, with its checksums)
  and `api-specs/protect/7.4.96/`, each with a generated schema module.
- **Each operation is built from the oldest supported revision that documents it.** The
  71 implemented operations that 7.3.74 documents use the 7.3.74 schemas and carry
  `apiVersionRange: '>=7.3.74 <8'`; the 8 HTTP operations only 7.4.96 documents (external
  arm profiles, `stop-siren`) use the 7.4.96 schemas and carry `'>=7.4.96 <8'`. A 7.3.74
  console sees and runs the first group; the second is hidden and refused with
  `operation_unsupported`, naming the version. The module-level range (probe, listing) is
  `>=7.3.74 <8`.
- **Forward compatibility is checked, not assumed.** A 7.3.74 schema is used on 7.4.x
  consoles too, which is safe only when every difference in 7.4.96 is additive: in
  responses, new properties (even required ones) and new enum values, which the older
  schemas strip or accept; in requests, new optional properties and new enum values.
  `api:reconcile` check 8 compares every registered operation with each later revision
  its range includes, with every `$ref` resolved, and fails on anything else (removed or
  retyped properties, requirements dropped from responses or added to requests, new request
  constraints, changed union members). For 7.3.74 → 7.4.96 it finds no breaking change in
  any of the 71 operations (`scripts/lib/revision-compat.ts`).
- What a 7.4.x console loses by being served 7.3.74 schemas: the new response fields
  (the NVR's `featureFlags`, a sensor's `isMountedIncorrectly`) are stripped, and the camera
  PATCH does not accept the `antiFlicker` video mode. When a later official release is
  the minimum, the shared operations move to it.
- **Coverage** counts an operation as implemented for a revision when a registered
  operation with the same method and path has a version range that includes it: 7.3.74
  71/74, 7.4.96 79/83.

### 8. Live evidence (2026-11-12) and a reviewed response exception

The owner ran the opt-in live read-only test against a console with Protect 7.3.74. The
record is [api-coverage/live/protect-7.3.74.json](../api-coverage/live/protect-7.3.74.json).

- **Events authenticate with the API key.** A WebSocket upgrade of the documented
  `/v1/subscribe/events` with the stored key in `X-API-KEY` was accepted (HTTP 101); the
  same upgrade with a random key was refused (HTTP 401). Subscriptions therefore use the
  same credential, header, egress check and pinned TLS as every other request. This closes
  the open question carried in `provenance.json` and ADR 0005.
- **Reads.** 20 reads ran and 19 matched the contract. Users and ULP users returned data,
  so their item reads ran too. Every device list (cameras, lights, sensors, sirens,
  speakers, chimes, relays, bridges, link stations, alarm hubs, fobs, viewers, live views)
  came back empty, so the 13 device reads, the stream read and the snapshot were skipped,
  and no device schema met real data. The two reads only 7.4.96 documents were skipped as
  designed. An empty list matches any item schema, so from now on the live tests record
  it as `ok (empty)`, and the coverage matrix does not count it as live validation.
- **One deviation.** `GET /v1/nvrs` returned an NVR whose `armMode` left out
  `armProfileId`. The contract (`nvrArmMode`, in 7.3.74 and 7.4.96) requires it as a
  string or `null`. Every other `armMode` field was present and valid.
- **Rerun with the exception below (same day).** All 20 reads matched, `GET /v1/nvrs`
  included. Five returned data and count as live-validated (the NVR list and the four
  user reads); the 15 lists came back empty (`ok (empty)`). The committed record is this
  rerun.

**Decision.** `nvrArmMode.armProfileId` is accepted when absent, in responses only. It is
a reviewed deviation in the generator configuration (`optionalResponseProperties` in
`scripts/generate-adapter-schemas.ts`), with its reason in the generated module:

- Only absence is tolerated. A value of any type other than string or `null` is still
  `upstream_contract_mismatch`, and every other required field stays required. An absent
  field is passed on as absent, not invented as `null`: the console did not say that no
  profile is selected.
- The field is an identifier of a profile, not a credential or personal data; the read's
  risk and sensitivity do not change.
- It applies to the 7.3.74 schemas, which every console from 7.3.74 to 7.x uses for this
  read (§7). The 7.4.96 module is unchanged and unused for it.
- Generation fails if the property disappears from the schema, is no longer required, or
  is no longer used in a response, so the exception is revisited when the vendor changes
  the contract. Tests: `tests/unit/scripts/openapi-zod.test.ts` (the option),
  `tests/integration-mock/protect-reads.test.ts` (absent, `null` and a string pass; a
  number and a missing `status` fail).

Alternatives rejected: making every `armMode` field optional (wider than the evidence),
filling in `null` (states something the console did not), and editing the generated
module by hand (lost on the next generation, and unreviewable).

## Consequences

- Consoles with a Protect version older than 7.3.74, or 8 and later, are refused with a
  message naming the version (ADR 0018 §3). On 7.3.x, the operations only 7.4.96 documents
  are refused the same way (§7).
- The open questions carried over in `provenance.json`: the snapshot's size bounds and
  rate limits. How subscriptions authenticate was answered live (§8).
- Device reads have not met real data yet: the console tested had no Protect devices.
- A console that leaves out further required fields fails that read until the evidence is
  reviewed the same way (§8).
