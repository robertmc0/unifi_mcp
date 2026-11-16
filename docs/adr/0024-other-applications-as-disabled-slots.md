# 0024. Other applications as disabled module slots

- Status: Accepted
- Date: 2026-11-15
- Phase: 4
- Spec references: §1.2, §4.1, §5.1, §15, §16 Phase 4, §18 item 9, §19

## Context

Spec §4.1 lists `talk`, `connect` and "other" applications as "future plugin slots,
disabled", to be added "only after existence of an official **local** API is verified",
and says: "For a missing contract, show `unavailable: official_local_api_not_documented`."
Phase 4 asks for "adapter scaffolds only until official local API contracts are
available".

Until now these applications did not exist in the service at all. Asking for one gave
the same answer as a misspelt name: `--module must be network, protect or access`,
`Unknown modules: talk`, or an empty operation list. The reason, which the spec wants
shown, was only in ADR 0005.

ADR 0005 also recorded one application that fits neither group: InnerSpace has a
published API with a local server, but is not in the spec roadmap ("no work planned").
Calling it "not documented" would be false.

## Decision

1. **A slot is a row in one table, not a package.** `MODULE_SLOTS` in
   `packages/unifi-api/src/modules.ts` holds a module id, a title and a reason for each
   application without an adapter. A slot has no endpoint, credential kind, contract
   directory, operation, event stream or version probe. An empty workspace package per
   application would add nothing a table does not (spec §15: "avoid needlessly publishing
   many npm packages"), and would suggest work that does not exist.

2. **Two reasons, shown as `unavailable: <reason>`.**

   | Reason                              | Meaning                                                                                |
   | ----------------------------------- | -------------------------------------------------------------------------------------- |
   | `official_local_api_not_documented` | No official local API was found for the application (the spec's status).               |
   | `adapter_not_implemented`           | An official local API is published, but this project has not reviewed it or built one. |

   The second reason is this project's addition. It exists so that the first one stays
   true.

3. **The slots (evidence of 2026-11-15, below).**

   | Module id    | Application   | Reason                              |
   | ------------ | ------------- | ----------------------------------- |
   | `talk`       | UniFi Talk    | `official_local_api_not_documented` |
   | `connect`    | UniFi Connect | `official_local_api_not_documented` |
   | `drive`      | UniFi Drive   | `official_local_api_not_documented` |
   | `innerspace` | InnerSpace    | `adapter_not_implemented`           |

   These are the applications ADR 0005 names. Any other name stays unknown. The
   cloud-only APIs (Site Manager, Mobility, Carrier Fabric) are not slots: they are not
   local applications and are excluded by spec §1.2, not waiting for anything.

4. **Where the status is shown.**
   - `unifi_list_modules` lists every module with `status: "supported"` and every slot
     with `status: "unavailable"`, its `reason`, and zero operations. The slots are the
     same for every client: they say nothing about a console.
   - `unifi_list_operations` with `moduleId` set to a slot returns the empty list with
     `module: { moduleId, status, reason }`.
   - `unifi-mcp api modules` (new, host CLI) prints the same list with contract revisions
     and counts.
   - `--module <slot>` on any console command, a console policy and a bootstrap file that
     name a slot are refused with the status, instead of "unknown".
   - `docs/api-coverage/api-coverage.json` gains `unavailableModules`; the coverage README
     and [applications-other.md](../applications-other.md) list them.

5. **What stays exactly as it was.** The dispatcher, the registry and the policy engine
   have no knowledge of slots. An operation id such as `talk.info.get` is an unknown
   operation, refused like any other unknown id. A slot cannot be enabled, given a
   credential or a declared version, and its id never reaches a console. Gates are not
   duplicated: nothing new can be allowed, so there is nothing new to gate.

6. **A slot cannot become a module by accident.**
   `tests/contract/module-slots.test.ts` fails when a slot gains an endpoint, an adapter,
   an operation, an event stream, a probe or a directory under `api-specs/`, when the
   registry accepts an operation for one, or when any package source names a console path
   under `/proxy/` other than the two documented ones. Leaving the list needs the steps
   in "Re-evaluation triggers".

## Evidence

Retrieved 2026-11-15. These are supporting sources, not artefacts of record, and are not
cached.

- Developer portal root index `https://developer.ui.com/llms.txt` (33,362 bytes, SHA-256
  `90c552e29a1ce765964680851b4b0d2689ff1bca0a03f426615a338c7e4d7035`). Its "API Services"
  section lists six APIs: Network v11.0.97, Protect v7.4.99, Mobility v1.0.0, InnerSpace
  v1.3.23, Site Manager v1.0.0, Carrier Fabric v1.0.0. It lists no Talk, Connect or Drive
  API. The InnerSpace section lists six `GET` endpoints, as in Phase 0.
- help.ui.com article 30076656117655, "Getting Started with the Official UniFi API"
  (updated 2026-09-22, unchanged since Phase 0). Under "Local Application APIs" it names
  Network and Access.
- The Access API reference and the Access module are covered by ADR 0005 and ADR 0021.

What this shows and what it does not: no official local API for Talk, Connect or Drive
was found in the two places where Ubiquiti publishes its APIs. That is the absence of a
publication, checked on one date. It is not a statement by Ubiquiti that none exists or
will exist. The InnerSpace OpenAPI document itself was not fetched again; its local
base URL is the Phase 0 record in ADR 0005.

One finding outside this decision: the portal now labels the Protect API **v7.4.99**.
Its `openapi.json` is byte-identical to the 7.4.96 document in `api-specs/` (same
SHA-256, 558,984 bytes), and its `llms.txt` differs only in the version label. No new
revision record is needed (ADR 0019 §7, note of 2026-11-15). Both cached Protect
artefacts are still served at their recorded sizes.

## Consequences

- An operator or a client asking for Talk, Connect, Drive or InnerSpace gets a stated
  reason from the service itself, in the words of the spec.
- The status of a slot is a claim about vendor publications with a date. It can go stale.
  The re-evaluation triggers below are manual. Nothing in the build checks the portal.
- `unifi_list_modules` results gain a `status` field and four entries. Clients that read
  only `moduleId` and the counts are unaffected.
- InnerSpace is eligible under spec §4.1 (an official local API with a contract), and
  remains unimplemented by the Phase 0 decision in ADR 0005. It would be a read-only
  module of six operations. **The owner decided on 2026-11-16 to leave it unavailable.**

## Re-evaluation triggers

- Before each release (spec §19 asks for verification to be repeated then), and whenever
  `npm run api:fetch-specs` is run for a new vendor revision: read the portal root index
  and the help article again, and update the evidence date here.
- Ubiquiti publishes an official local API for a slot: change its reason to
  `adapter_not_implemented` at once (the old reason is then false), and decide with the
  owner whether to build the adapter.
- Building an adapter for a slot: a new ADR with the contract evidence, the artefacts
  under `api-specs/<app>/<revision>/` with checksums ([api-specs/README.md](../../api-specs/README.md)),
  the module in `MODULE_IDS` and `MODULE_ENDPOINTS` from its provenance, reviewed security
  metadata in its own package, mock and negative tests, coverage, and the operator guide.
  Then remove the slot.
- The owner reverses the decision of 2026-11-16 and asks for an InnerSpace adapter, or
  drops InnerSpace from the list.
