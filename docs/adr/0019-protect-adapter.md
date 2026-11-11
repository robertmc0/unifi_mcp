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

## Consequences

- Consoles with a Protect version older than the supported range will be refused with a
  message naming the version (the version gate of ADR 0018, applied to Protect in a later
  step). The supported range is decided with the version probe.
- The open questions carried over in `provenance.json`: how the WebSocket subscriptions
  authenticate, the snapshot's size bounds, and rate limits.
