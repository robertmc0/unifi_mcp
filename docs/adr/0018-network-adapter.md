# 0018. UniFi Network adapter: generated schemas, reviewed metadata, version probe

- Status: Accepted (extended as Phase 2 proceeds)
- Date: 2026-11-10
- Phase: 2
- Spec references: §2 (decisions 26, 37), §4.3, §4.5, §5.1–§5.3, §6.3, §6.4, §16 Phase 2, §19

## Context

Phase 2 implements the official UniFi Network Integration API, revision 11.0.97: 73
operations (38 reads, 35 writes) in `api-specs/network/11.0.97/`. Every operation needs a
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
