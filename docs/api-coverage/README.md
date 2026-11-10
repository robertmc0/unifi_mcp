# API coverage matrix

Spec §4.5 requires an inventory of **every** official operation per application revision.
Each entry shows whether it is supported, how it is exposed, its permission, risk,
sensitivity, schema validation, mock tests and optional live read validation. Coverage is
measured against the vendor contract, not by counting hand-written tools.

| Module  | Revision         | Documented | Implemented | Page                                         |
| ------- | ---------------- | ---------: | ----------: | -------------------------------------------- |
| Network | 11.0.97          |         73 |          73 | [network/11.0.97.md](network/11.0.97.md)     |
| Protect | 7.3.74           |         74 |           0 | [protect/7.3.74.md](protect/7.3.74.md)       |
| Access  | 2026-03-23 (PDF) |        107 |           0 | [access/2026-03-23.md](access/2026-03-23.md) |

Machine-readable: [`api-coverage.json`](api-coverage.json).

## How it is produced

- Pages and JSON are **generated** by `npm run api:coverage-report` from
  `api-specs/<app>/<revision>/{provenance,operations}.json` and the module adapters the
  service registers (`packages/mcp-server/src/adapters.ts`). Do not edit them by hand.
- An operation is `implemented` exactly when an adapter registers a descriptor for its
  method and path in that revision. The entry then carries the reviewed `operationId`,
  `permission`, `risk`, `approvalRequired`, `defaultDisabled`, `sensitivity`, `exposure`
  (named tool, and always the generic `unifi_execute`), `schemaValidation` (generated
  schemas), `mockTests` and `evidence` (the test files that run it end to end).
  `liveReadValidation` stays `false` until an opt-in live read-only run is recorded.
  Operations deliberately left unsupported carry a `statusReason`.
- `npm run api:reconcile` fails when the vendor contract, the committed inventory, the
  generated schemas or this matrix disagree. `tests/contract/api-coverage-matrix.test.ts`
  checks the matrix offline in every `npm run check`.
- Pages of modules without an adapter yet show the Phase 0 provisional classification
  below; pages of implemented modules show the reviewed metadata instead.

## Provisional classification (Phase 0)

The **Prov.** columns come from `scripts/lib/provisional-classification.ts`. They are rule
based and conservative: unknown writes default to `high`, and Access writes default to
`high` because the domain is physical access. They exist only to plan phases and flag
dangerous surfaces early. They are not the reviewed security metadata required by spec §4.3,
they never enable anything, and adapters must not import them.

Operations proposed to stay **disabled by default**, even for clients with write grants:

| Module  | Operation                                                   | Reason                                      |
| ------- | ----------------------------------------------------------- | ------------------------------------------- |
| Protect | `POST /v1/cameras/{id}/disable-mic-permanently`             | Irreversible                                |
| Access  | `POST /api/v1/developer/credentials/touch_passes`           | Purchases Touch Passes (financial)          |
| Access  | `POST`/`DELETE /api/v1/developer/api_server/certificates`   | Replaces the API trust anchor               |
| Access  | `POST`/`PUT`/`DELETE /api/v1/developer/webhooks/endpoints…` | Console would push events to arbitrary URLs |
