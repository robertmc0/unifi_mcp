# 0005. Official local UniFi API contracts and module eligibility

- Status: Accepted
- Date: 2026-11-10
- Phase: 0
- Spec references: §1.2, §1.3, §4.1, §4.2, §4.4, §16 Phase 0 gate, §19

## Context

Spec §4.1 makes a module eligible only when Ubiquiti publishes an official, locally
callable API with usable authentication and a sufficiently specified contract. Phase 0
must confirm availability per application. It must also document local authentication and
URL bases from official sources, distinguish local from cloud examples, and flag
unverified assumptions.

## Decision: module eligibility

| Application                  | Official local API                    | Contract                                   | Local base URL                                          | Auth                            | Roadmap                                                                                  |
| ---------------------------- | ------------------------------------- | ------------------------------------------ | ------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| Network                      | **Yes**                               | OpenAPI 3.1, v11.0.97, 73 ops              | `https://{consoleHost}/proxy/network/integration`       | `X-API-KEY: <key>`              | Phase 2                                                                                  |
| Protect                      | **Yes**                               | OpenAPI 3.1, v7.4.96, 83 ops (3 WebSocket) | `https://{consoleHost}/proxy/protect/integration`       | `X-API-KEY: <key>`              | Phase 3                                                                                  |
| Access                       | **Yes** (distinct listener)           | PDF API reference (2026-03-23), 107 ops    | `https://{consoleHost}:12445` + `/api/v1/developer/...` | `Authorization: Bearer <token>` | Phase 4                                                                                  |
| InnerSpace                   | Yes (local server listed)             | OpenAPI, v1.3.23, 6 read ops               | `https://{consoleIP}/proxy/innerspace/integration`      | `X-API-KEY`                     | **Not in the spec roadmap.** Recorded as an eligible future plugin slot; no work planned |
| Site Manager                 | No: cloud only (`https://api.ui.com`) | —                                          | —                                                       | —                               | Excluded (spec §1.2 non-goal)                                                            |
| Mobility                     | No: cloud only (`https://api.ui.com`) | —                                          | —                                                       | —                               | Excluded                                                                                 |
| Carrier Fabric               | No: cloud only (`https://api.ui.com`) | —                                          | —                                                       | —                               | Excluded                                                                                 |
| Talk, Connect, Drive, others | None published                        | —                                          | —                                                       | —                               | `unavailable: official_local_api_not_documented`                                         |

Adapters must use only the local base URLs above. Every vendor OpenAPI also lists the
**cloud connector** server `https://api.ui.com/v1/connector/consoles/{consoleId}/proxy/<app>/integration`,
and the onboarding material advertises it as a way to reach consoles "without a VPN". This
project never uses it. The URLs are recorded in `forbiddenBaseUrlTemplates` and tested
against in `tests/contract/api-inventory.test.ts`.

## Decision: credentials and trust

- **Network/Protect API keys.** The key is created in the local application under
  _Integrations → Create New API Key_ and shown once. The vendor states no scoping or
  read-only option, and does not say whether one key covers both applications. The project
  therefore treats each key as a **console-wide administrative credential**. It is stored
  encrypted (spec §8.2) and never exposed. Operators are advised to create a dedicated key
  for this service and rotate it. The project's own policy layer is the only least-privilege
  control.
- **Access API tokens** have a validity period and per-token permission scopes that the
  console enforces. Operation permission keys are `view:*` / `edit:*`. The operator guide
  (Phase 4) will recommend tokens scoped to exactly the granted operations, so vendor
  enforcement backs up this project's policy.
- **TLS.** The Access reference states the 12445 listener certificate is "self-generated and
  untrusted". Console certificates generally need explicit trust, so per-console CA or
  certificate/public-key pinning is the expected configuration (spec §4.4). The insecure
  override stays per-console, audited and loudly warned.
- **Response semantics.** Network errors use a documented body (`statusCode`, `statusName`,
  `code`, `message`, `timestamp`, `requestPath`, `requestId`). Access always wraps
  responses as `{code, msg, data}`, and success is `code == "SUCCESS"`, never HTTP 200
  alone (spec §4.4).

The Protect row was moved from v7.3.74 (74 operations, 2 WebSocket) to v7.4.96 on
2026-11-11 ([ADR 0019](0019-protect-adapter.md)).

## Discrepancy recorded: Access OpenAPI port

| Source                                                                                                                 | Port      |
| ---------------------------------------------------------------------------------------------------------------------- | --------- |
| Access API reference PDF §1.2, §2.6 (and its link annotation `https://unifi-console-ip:12445/`)                        | **12445** |
| Required Ports Reference, help.ui.com 218506997 (updated 2026-11-06): "12445 – Open API"                               | **12445** |
| Getting Started with UniFi Access FAQ, help.ui.com 17452334269975 (edited 2026-02-26): "12455 (HTTPS): OpenAPI access" | 12455     |

Decision: default to **12445**, keep the port configurable per console, and never probe
alternative ports automatically. The console test command (Phase 4) reports a clear
connection error that names the configured port.

## Evidence

All artefacts and checksums are in `api-specs/<app>/<revision>/provenance.json`. Phase 0
verified them by re-downloading through `scripts/fetch-api-specs.ts`. The Network and Protect
`llms.txt` indexes list exactly the same operations as their OpenAPI documents
(`scripts/reconcile-api-coverage.ts`). The InnerSpace, Mobility, Carrier Fabric and Site
Manager OpenAPI `servers` arrays were inspected directly (2026-11-10).

## Live evidence (Phase 2, 2026-11-11)

The opt-in live read-only test ran against one console with UniFi Network 11.0.99 and
UniFi Protect installed. The record is
[api-coverage/live/network-11.0.97.json](../api-coverage/live/network-11.0.97.json).

- **One key covers Network and Protect.** A key created under _Integrations_ in UniFi
  Network authorised a documented Protect read on the same console. The Protect contract
  declares no authentication, so the test repeated the read with a random key as a
  control. Protect rejected it (HTTP 401), so the real key is what authorised the read.
  This confirms the credential decision above: a stored Network key is also a Protect
  credential. Storing it only for the `network` module limits what this service does with
  it, not what the key can do.
- **No scoped or read-only keys.** The _Create API Key_ dialog in UniFi Network 11.0.99
  asks only for a name: no scope, application or read-only choice. Together with the
  previous point, every key has full administrative scope across the console.
- **Site Manager keys do not work locally.** A key created at unifi.ui.com was rejected
  with HTTP 401; a key created on the console worked. The operator guide says so.
- **Paging and filtering** behaved as documented: one item per page, a next page with a
  different item, and an accepted filter expression.

## Unverified assumptions (flagged; must be resolved before the named phase)

| Assumption                                                                                   | Resolve by                                             |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| ~~One Integrations API key may or may not cover both Network and Protect~~                   | **Resolved:** it covers both (live evidence above)     |
| ~~No read-only API key type exists for Network/Protect~~                                     | **Resolved:** none in the UI (live evidence above)     |
| WebSocket subscription authentication for Protect                                            | Phase 3                                                |
| Installed Access version may ship a machine-readable contract ("Download API documentation") | Phase 4                                                |
| Local API rate limits (not documented for any application)                                   | Phase 2–4. Conservative defaults until then (spec §10) |
| ~~Network filtering/pagination rules not yet transcribed~~                                   | **Resolved:** checked live (above)                     |

## Re-evaluation triggers

- A new vendor API revision (detected by `npm run api:fetch-specs` / `api:reconcile`).
- Ubiquiti publishes an official local API for Talk, Connect, Drive or another application.
- The Access port discrepancy is corrected by the vendor.
