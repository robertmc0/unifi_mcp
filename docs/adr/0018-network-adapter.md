# 0018. UniFi Network adapter: generated schemas, reviewed metadata, version probe

- Status: Accepted (extended as Phase 2 proceeds)
- Date: 2026-11-10
- Phase: 2
- Spec references: §2 (decisions 26, 37), §4.3, §4.5, §5.1–§5.3, §6.3, §6.4, §16 Phase 2, §19

## Context

Phase 2 implements the official UniFi Network Integration API, revision 11.0.97: 73
operations (41 reads, 32 writes) in `api-specs/network/11.0.97/`. Every operation needs a
strict input schema, an output schema, and hand-reviewed security metadata (spec §4.3).
The vendor OpenAPI document has 380 component schemas. 77 of them are polymorphic, with
discriminators over `allOf` inheritance.

ADR 0006 forbids committing the vendor document. Item 6 allows adapter schemas to be
generated from the local vendor cache as our own runtime validation code, reviewed like
any other code. Spec §4.3 requires generated schemas and hand-written security metadata to
stay separate, so that a regenerated schema can never change a permission, risk or
sensitivity class.

## Decision

### 1. Generated schemas (step 1)

`scripts/generate-adapter-schemas.ts` translates the cached, checksum-verified OpenAPI
document into `packages/unifi-network/src/generated/network-11.0.97.ts`
(`scripts/lib/openapi-zod.ts`). For each vendor operation it emits the method, path, query
parameter names, whether there is a body, an input schema and an output schema. It
contains no descriptions, examples or other prose, and no security metadata.

- **Requests are strict.** Objects reject unknown properties; enums, `uuid`, `date-time`
  and `date` formats, and documented bounds are enforced. `int32` values get the `int32`
  range. Strings without a `maxLength` are limited to 4096 characters, and arrays without
  a `maxItems` to 1000 items. `uniqueItems` is checked. Defaults are not applied: only
  what the client sent is forwarded.
- **Responses tolerate additions but pass nothing undocumented.** Objects strip properties
  the contract does not define, so an undocumented field added by a newer console (a
  secret, for example) never reaches a client. Unknown enum values are accepted as strings.
  An unknown discriminator value yields the base object's documented fields. Documented
  required properties stay required. A response that does not match is refused as
  `upstream_contract_mismatch`, so nothing is guessed.
- **Polymorphism follows JSON Schema semantics.** An instance must satisfy the base and the
  selected variant. The vendor does not always repeat the base in a variant's `allOf`, so
  the base's own properties are merged into every variant, and a property narrowed by a
  variant is the intersection of both definitions. Some variants are shared by duplicated
  bases; they are accepted only if every base selects them by the same values.
- **Unconstrained schemas.** A `{}` property is accepted only where a variant narrows it.
  An unconstrained request property fails generation. An unconstrained response property
  is dropped.
- **Fail loudly.** Unsupported keywords (`oneOf`, `pattern`, `additionalProperties`, …),
  unknown formats, recursion, conflicting definitions, header or cookie parameters,
  non-JSON bodies and several 2xx responses stop generation. The 11.0.97 document needs
  none of them.
- **Targets.** `siteId` is a target supplied by the dispatcher (ADR 0010), never an
  argument. A JSON body is the single `body` argument (step 2).
- **Freshness.** `npm run api:reconcile` regenerates the module and fails if the committed
  file differs. `tests/contract/network-generated-schemas.test.ts` checks offline that the
  module was generated from the pinned SHA-256 and covers exactly the 73 inventoried
  operations with the same methods and paths.

### Reviewed deviation: the device-tag filter

`GET /v1/sites/{siteId}/device-tags` types its `filter` query parameter as an object
(`FilterExpression`). Every other list operation types `filter` as a string, and a query
parameter has no defined encoding for that object. Guessing the encoding would send a
request the contract does not define. The parameter is therefore left out of that one
operation. The other parameters (`offset`, `limit`) and the operation itself are
unaffected. The omission is declared, with its reason, in the generator configuration and
in the generated file. Generation fails if the vendor removes or changes the parameter, so
the decision is revisited.

### 2. Core contract additions (step 2)

- **A JSON body is one `body` argument.** Twelve Network request bodies are discriminated
  unions, which cannot be flattened next to the path arguments. An operation with
  `requestBody: 'json'` must therefore have a `body` argument, and the executor sends
  exactly its value as the request body, with nothing added. `body` cannot also be a path or
  query parameter. This replaces the Phase 1 rule ("fields not used in the path or query
  form the body"), which no adapter used yet.
- **Pagination.** An optional descriptor hook, `pagination(output)`, returns the paging
  facts of a validated page response. The dispatcher returns them as the envelope's
  `pagination`, next to the projected `data`.
- **Unknown versus unsupported versions.** The policy engine denies an operation whose
  console version has not been probed as `version_unknown`, and one outside its verified
  range as `operation_unsupported` (both at stage 7). For `operation_unsupported` the
  dispatcher adds the observed version and the verified range to the message. The version
  string comes from the console, so it is shown only if it looks like a version.

### 3. Version probe and the supported range (step 3)

- **Range.** Every Network operation carries `apiVersionRange` `>=11.0.97 <12`
  (`NETWORK_VERSION_RANGE`). The contract was verified for 11.0.97. Later 11.x releases are
  accepted because they serve the same `/v1` integration API, and the strict schemas refuse
  anything that does not match (requests are rejected by the console, responses become
  `upstream_contract_mismatch`). Earlier versions (the portal documents 9.1.120 to
  11.0.97) and 12 or later are refused with `operation_unsupported` until their contracts
  are reviewed. The constant is the one place to change.
- **Probe.** `GET /v1/info` through the reviewed operation `network.info.get`, which the
  `VersionProber` (`packages/unifi-api/src/probe.ts`) runs with the same executor, egress
  and TLS controls as any request. The probe operation must be registered, argument-free
  and console-level. Only enabled consoles and modules are probed. The reported version is
  stored only if it looks like a version (`PLAUSIBLE_VERSION`).
- **Recording.** `observed_at` is always updated. A new or different version is audited
  (`console.version_observed`). A change of a known version also bumps the policy version,
  so pending approvals prepared against the old version are invalidated (spec §6.5).
- **Monitor.** `VersionMonitor` runs in the service: a pass at start and then every 30 s.
  It probes enabled modules that have a credential and an unknown version, including
  modules enabled by the CLI from another process. It refreshes known versions every 6 h,
  and retries failures with exponential backoff (30 s up to 30 min). A failing probe
  degrades the non-critical `console_versions` health check. Tool lists are computed per
  request, so newly supported operations appear without a restart (2025-era clients after
  reconnecting).
- **CLI.** `unifi-mcp console probe <alias>` probes at once and says whether the version is
  supported. `doctor` already warns about modules whose version has not been probed.
- A dispatcher-side lazy probe (probe on first use) was not added: discovery already hides
  operations of unprobed consoles, so a client could not call them anyway, and the monitor
  probes within a minute.

### 4. Reads (step 4)

- **Descriptors.** `networkOperation()` joins the generated contract facts of one vendor
  operation with hand-written review metadata. Each read gets an id
  `network.<category>.<action>`, a category (sites, devices, clients, networks, wifi,
  firewall, acl, dns, hotspot, switching, traffic_lists, vpn, wans, radius, reference,
  info), our own description, low risk, `safe-read` and a 15 s timeout. The review is
  pinned in `tests/contract/network-security-review.test.ts`, so a metadata change must
  change that table too.
- **Sensitive data.** The two client reads return names that usually identify people and
  MAC and IP addresses of their devices, so they carry `personal_identifier` and
  `network_identity`. Device, network and configuration reads carry no tag: they describe
  infrastructure, not people.
- **Credentials.** Removed from every result after every projection, at any depth:
  `passphrase` everywhere (Wi-Fi pre-shared keys, including `presharedKeys` entries), and
  `code` for hotspot operations (voucher codes). `code` is not removed elsewhere, because
  it also names harmless values such as country codes. The `credential` tag is not used:
  it would make the whole operation unavailable, while only these fields are secret.
- **Pages.** The 23 list reads return `data` (the items) and `pagination` (`offset`,
  `limit`, `count`, `totalCount`, and `nextOffset` while more items remain).
- **Named tools.** `network_list_sites` (needed first, to learn site ids),
  `network_list_devices`, `network_get_device`, `network_list_clients` and
  `network_list_networks` (spec §5.1). Everything else is reached through
  `unifi_execute`.

## Evidence

- `tests/unit/scripts/openapi-zod.test.ts` (synthetic documents only, 25 tests):
  - strict requests, enforced formats, bounds and uniqueness, default bounds;
  - responses that strip undocumented fields and accept unknown enum values;
  - discriminated unions with base merging, narrowing, an unknown-value fallback and
    shared variants;
  - unconstrained properties; omissions; identifiers;
  - generation failing on unsupported constructs.
- Mutation checks, each making a test fail: requests not strict; responses keeping unknown
  fields; the base not merged into variants; an unconstrained request property accepted;
  no default string bound; lenient request enums; uniqueness ignored; disagreeing bases
  accepted; recursion accepted; narrowing ignored.
- `npm run api:reconcile` reports the generated module up to date.
- Step 2: `tests/security/dispatcher-gates.test.ts` (a body only as the `body` argument;
  `body` reserved), `tests/unit/core/dispatcher.test.ts` (`version_unknown` sends nothing;
  the unsupported message names the version and range; an implausible version string is
  not echoed; page responses), `tests/unit/unifi-api/executor.test.ts` (exactly the `body`
  argument is sent). Mutation checks, each making a test fail: all arguments sent as the
  body; the `body` argument not required; an unknown version treated as supported; an
  unsafe version string echoed; the pagination hook ignored.
- Step 3: `tests/unit/unifi-api/probe.test.ts` (one documented GET with the stored key;
  only changes audited; a change bumps the policy version; disabled consoles and modules
  never contacted; implausible, missing and non-string versions refused; console errors
  reported; only argument-free console-level reads accepted as probes; monitor refresh,
  backoff, degraded health and recovery, skipped modules),
  `tests/integration-mock/network-version-probe.test.ts` (the service probes by itself,
  then lists and runs `network.info.get`; an incompatible version hides and refuses it with
  the version and range named, sending nothing), and the `console probe` CLI test.
  Mutation checks, each making a test fail: probing a disabled console or module; recording
  an implausible version; a version change keeping approvals; auditing every probe; no
  backoff; probing without a credential; failures not degrading health; the service never
  probing; site-scoped probes accepted.
- Step 4: `tests/integration-mock/network-reads.test.ts` runs all 41 reads through the
  dispatcher, the real contract inventory and the HTTPS executor against the synthetic
  console, once per response variant (every union option and enum value). Responses fill
  every documented field and carry credential sentinels and an undocumented field in every
  object. Checked: exactly one GET to the documented path with the stored key; no
  sentinel, undocumented field or key in the result; paging facts; country codes kept;
  client reads refused without the sensitive grants and not sent; a response missing
  required fields refused; every read's arguments describable as JSON Schema. Mutation
  checks, each making a test fail: `passphrase` not removed; voucher codes kept; removal
  not applied; removal only at the top level; client reads untagged; no pagination; a named
  tool dropped.

## Consequences

- The generated module (about 4300 lines) is reviewed as a diff whenever the vendor
  contract changes. Security metadata lives elsewhere and does not change with it.
- The generator is shared with the Protect adapter (Phase 3).
- A console that sends a response violating the documented required fields fails that read
  with `upstream_contract_mismatch`. The live read-only test (step 7) checks this against
  real consoles.

## Re-evaluation triggers

- A new contract revision that uses constructs the translator refuses.
- The vendor fixes or documents the device-tag filter.
- Live reads show documented required fields that consoles omit.
