# 0022. UniFi Access: transcribing the PDF contract into adapter schemas

- Status: Accepted
- Date: 2026-11-13
- Phase: 4
- Spec references: §4.1, §4.3, §4.5, §16 Phase 4, §17, §20

## Context

The Network and Protect adapters validate every request and response with schemas that
`scripts/generate-adapter-schemas.ts` translates from the vendor's OpenAPI document
(ADR 0018 §1). Nobody edits those schemas by hand, and a regenerated schema can never
change security metadata (spec §4.3).

Access has no OpenAPI document. Its only contract is the API reference PDF
(`api-specs/access/2026-03-23/`, ADR 0005, ADR 0021). The generator cannot read it, and
AGENTS.md forbids editing generated schemas by hand. Something has to turn the PDF into
schemas, and the result must be as reviewable and as strict as the generated Network and
Protect schemas.

What the PDF provides (observed in the cached copy, SHA-256 `6abb576c…`):

- **Field tables.** Request path, query and body parameters are listed with a required
  flag (`T`/`F`), a type and a description. Shared objects (the user in §3.1, the visitor
  in §4.1, and others) have tables without a required column. Nested fields are printed
  as paths, for example `nfc_cards[].id` or `resources[0].id`.
- **Samples.** Most responses say only "Schemas" (the section's shared table) and show a
  sample. Some fields, and list paging (`pagination: {page_num, page_size, total}`, a
  sibling of `data`), appear only in samples.
- **Disagreements.** Samples do not always match the tables. The §3.3 curl sample sends
  `pin_code`, which the §3.3 table does not list, to `/api/v1/developer/user`, where the
  method line says `/users/:id`. The §3.15 sample deletes from
  `/api/v1/developer/developer/user_groups/…`. §3.4 types `expand[]` as Boolean, but its
  example is `expand[]=access_policy`.
- **Vocabulary.** The types used are `String`, `Integer`, `Int`, `Number`, `Boolean`,
  `Object`, `Array[Object]` (once `Array[object]`), `Array[String]` and `File`.
  Enumerations are written in descriptions (`enum status {ACTIVE,PENDING,DEACTIVATED}`).
  No field states its nullability, and response fields are not marked required.
- **Non-JSON operations.** Multipart uploads (§3.30 profile picture, §6.19 NFC CSV import,
  §12.1 HTTPS private key and certificate), file downloads (§6.18 QR code image, §9.3 CSV
  export, §9.5 static resources) and one WebSocket (§11.1).
- **A text layer that can be checked by machine.** A dependency-free extraction of the
  cached PDF finds 702 table rows, each a field label directly followed by its required
  flag and type. The only irregular rows are the request header `Authorization` (repeated
  in every section), `Id` printed for the field `id` (p.12), and two rows without a label
  (p.33 and p.34): there the request body itself is an array of strings, as the §3.16 and
  §3.17 samples show.

Third-party OpenAPI conversions of the PDF exist (ADR 0021 §1). They are not vendor
artefacts and are not consulted.

## Decision

### 1. One transcription per revision, in OpenAPI form

`api-specs/access/2026-03-23/transcription.json` is an OpenAPI 3.1 document written by
hand from the PDF. It is this project's work, not a vendor artefact, and its `info` says
so. `x-transcribed-from` names the PDF and its SHA-256. It is committed next to
`operations.json` (ADR 0006 item 6: adapter schemas are "written or generated" as our own
validation code).

- **Interoperability facts only.** It contains path, query and body field names, types,
  required flags, documented enumerations, documented bounds and media types, each with
  its PDF location. It contains no vendor descriptions, examples or other prose. Where we
  make a transcription choice, an `x-note` explains it in our own words.
- **No security metadata.** Risk, sensitivity and permission are reviewed in the adapter
  package, as for Network and Protect (AGENTS.md, spec §4.3).
- **Why OpenAPI.** The existing translator (`scripts/lib/openapi-zod.ts`) then produces
  `packages/unifi-access/src/generated/access-2026-03-23.ts` under the same rules as the
  other adapters: strict requests, responses that strip undocumented fields, and failure
  on anything it does not understand. A custom format would need its own converter, which
  would hide interpretation decisions in code. OpenAPI keeps them in the reviewed file.
- **Join with the inventory.** The transcription's operation set must equal
  `operations.json` (method and path). Minimum versions, permission keys and section
  references stay in `operations.json` only.

### 2. Every element cites its PDF row

Each parameter and each schema property carries `x-pdf`:

| Form                                    | Meaning                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| `{"page": 14}`                          | A table row on page 14 whose label is the element's name.                    |
| `{"page": 13, "row": "nfc_cards[].id"}` | A table row printed with a different label: a nested path, or `Id` for `id`. |
| `{"page": 33, "row": ""}`               | A row without a label, which types the whole request body.                   |
| `{"page": 21, "sample": true}`          | The field appears only in a response sample on page 21 (response-only, §3).  |

Page numbers are the PDF's physical pages, as in `operations.json` `sourceRef`.

### 3. What may be transcribed

Requests are transcribed for least privilege and responses for fidelity.

- **Request fields come from field tables only.** The required flag comes from the
  `T`/`F` column. A field shown only in a request sample is not transcribed, so it is not
  accepted (the §3.3 `pin_code`). Where a sample disagrees with a table or a method line,
  the table and the method line win, and the operation's `x-note` records the
  disagreement.
- **A row that contradicts itself is left out.** For example, §3.4 `expand[]` has the type
  Boolean and the example `access_policy`. A request parameter whose wire form is not
  defined is treated the same way, like the device-tag filter in ADR 0018. The row is
  listed under `x-declined` with the reason, so the decision is revisited when the PDF
  changes. A sample may settle the wire form of a field that a table defines, for example
  repeated `status=` keys for an `Array[String]` query parameter. The executor already
  sends arrays that way.
- **Response fields come from field tables and samples.** A field shown only in a
  response sample is transcribed when the sample shows a value of a definite JSON type.
  Its type is taken from that value and it is marked `"sample": true`. A sample value of
  `null`, `[]` or `{}` with no table row defines no type, so the field is not transcribed
  and is stripped from results, like an unconstrained property in ADR 0018.
- **Required.** Request fields: as the `T`/`F` column says. Response fields: never. The
  PDF marks none, and older Access versions lack fields that newer ones send (ADR 0021
  §3 item 3).
- **Null.** The PDF never states nullability. Response properties therefore accept `null`
  as well as their type: a null carries nothing to hide, and refusing a whole read for it
  would rest on a rule the vendor never stated. Typed values are still enforced: a
  string where the table says Integer is `upstream_contract_mismatch`. Request fields
  accept `null` only where a table row says so.
- **Types.** `String` → string; `Integer` and `Int` → integer; `Number` → number;
  `Boolean` → boolean; `Object` → object with the rows nested under it; `Array[String]`
  and `Array[Object]` → arrays of those. An `Object` or `Array[Object]` with no documented
  fields cannot be a request field (generation fails), and is stripped from responses.
  `File` is a multipart part (§5).
- **Enumerations** only where the PDF presents the values as the allowed set (`enum
{…}`, "should be", "one of"). Example values alone are not an enumeration.
- **No formats or bounds are inferred.** A UUID-looking example does not make a field
  `format: uuid`. Strings and arrays without a stated bound get the translator's defaults
  (4096 characters, 1000 items).
- **Field-level versions.** A field with its own "UniFi Access Requirement" carries
  `x-minimum-version`, transcribed literally. The generated module lists these per
  operation. The adapter refuses a request that uses such a field when the console's
  declared version is lower, and sends nothing (ADR 0021 §3 item 3). Response fields need
  nothing extra: they are optional anyway.

### 4. The envelope

Every Access response has the form `{code, msg, data}`. A response is a success only when
`code` is `"SUCCESS"` (§2.8, provenance). The HTTP status alone does not show success.

- The transport checks `code`. Any other value is a console error carrying the documented
  code (§2.4). The codes are listed once in the transcription (`x-error-codes`), without
  their messages. Our own explanations belong to the adapter.
- An operation's success schema describes the envelope without `code` and `msg`: a
  required `data` (§2.8 always shows it), and an optional `pagination` where a list read
  shows one. This matches the dispatcher's existing `pagination(output)` hook (ADR 0018
  §2). An operation whose `data` the PDF documents as `null` has no response content, and
  the translator discards whatever arrives.

### 5. Operations the translator cannot express yet

Multipart uploads, file downloads and the WebSocket are transcribed with their documented
media types and fields, so the transcription stays complete. The translator refuses them,
so each one is listed in the generator configuration as an omitted operation, with a
reason, as Protect's upload is (ADR 0019). Whether and how each is offered is a security
decision for the adapter. For example, §12.1 sends a TLS private key.

### 6. Checked against the PDF in both directions

A transcription by hand can contain typing errors, invented fields and omissions. The
transcription is therefore compared mechanically with the text of the pinned PDF. This
check is part of `npm run api:reconcile`, which CI runs after `api:fetch-specs`.

- **Text extraction.** `scripts/lib/pdf-text.ts` is dev tooling, never part of the
  service, and adds no dependency. It reads only the PDF whose SHA-256 the transcription
  names, so its output is deterministic. It handles the subset of PDF this file uses, and
  fails rather than guessing on anything else.
- **Transcription → PDF.**
  - Every `x-pdf` table row exists on its page, with the transcribed type and, for request
    fields, the transcribed required flag.
  - Every `"sample": true` field appears as `"<name>":` on its page.
  - Every enumeration value and every `x-minimum-version` appears on the field's page.
  - Every operation's method and documented path appear on its `sourceRef` page.
- **PDF → transcription.** Every detected table row must be claimed by at least one
  element that cites its page, or be listed under `x-declined` with a reason. The request
  header `Authorization` is declined once for the whole document: the transport sends it.
  Omitted rows are therefore found mechanically, not only by review.
- **Limits.** The check shows that each element matches a row on the page it cites. It
  cannot show that the row belongs to that operation rather than to a neighbour on the
  same page, that nesting is right, or that a sample's type is meant generally. A person
  checks those in review. A row the extraction cannot detect is missed in both
  directions, which is why the review follows the PDF page by page.

### 7. Generation and freshness

- `GENERATED_MODULES` gains an Access entry that reads the transcription instead of a
  vendor document. Before generating, it checks that `x-transcribed-from` matches the PDF
  checksum in `provenance.json`. Operations are named by method and path (`naming:
'path'`).
- The translator accepts the extensions `x-pdf`, `x-note`, `x-minimum-version`,
  `x-declined`, `x-error-codes` and `x-transcribed-from` only from a transcription. In a
  vendor document they still fail generation. The rules of §3 that differ from OpenAPI
  sources (optional and nullable response properties, field versions) are generator
  options with this ADR as their reason, so the generated file states them in its header.
- Because the transcription is committed, the generated module and its freshness test
  run offline. Only the PDF comparison (§6) needs the vendor cache.
- **In stages.** The PDF is transcribed one chapter at a time (§3 users, §4 visitors, and
  so on), one reviewed commit each, including the regenerated module. Until all
  operations are transcribed, the rest are listed as pending in the generator
  configuration and are not generated. The PDF → transcription direction covers the pages
  of the chapters done. The transcription is complete when nothing is pending and that
  check covers every page with table rows.

## Consequences

- Access gets schemas as strict as Network's and Protect's, from the same translator, and
  no generated file is edited by hand.
- Its trust rests on our transcription, not on a vendor machine-readable document. The
  generated module, the coverage page and the manual say so. Live evidence (ADR 0021 C)
  remains the only test of how a real console behaves.
- Response validation is more tolerant for Access than for OpenAPI-sourced modules
  (optional, nullable properties) because the PDF states less. It still passes nothing
  undocumented and refuses wrong types.
- Requests are narrower than the samples suggest: fields seen only in samples, and rows
  that contradict themselves, are not sent. A missing capability shows up as a refused
  argument, and the declined list says why.
- A changed PDF (a new checksum) stops generation until the transcription is reviewed
  against it, as a new revision directory if the content changed.

## Re-evaluation triggers

- Ubiquiti publishes a machine-readable or version-labelled Access contract. It replaces
  the transcription, and the generated schemas are compared with this one.
- The hosted PDF changes.
- A live read-only run shows a response type or field that the transcription gets wrong.
- An Access request needs a field that this ADR leaves out (sample-only or contradictory).
