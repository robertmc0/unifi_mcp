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
`https://{consoleHost}/proxy/protect/integration`. The 7.3.74 record is removed, because
7.4.96 is a strict superset of it.

Compared with 7.3.74:

- **Added (9):** external arm profiles (list, get, create, update, delete, arm, disarm),
  `POST /v1/speakers/{id}/stop-siren`, and the `GET /v1/subscribe/updates?modelKeys=…`
  WebSocket subscription.
- **Removed:** none.
- **Changed (1):** `POST /v1/cameras/{id}/talkback-session` documents a 409 when another
  talkback session is in progress.

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

## Consequences

- Consoles with a Protect version older than the supported range will be refused with a
  message naming the version (the version gate of ADR 0018, applied to Protect in a later
  step). The supported range is decided with the version probe.
- The open questions carried over in `provenance.json`: how the WebSocket subscriptions
  authenticate, the snapshot's size bounds, and rate limits.
