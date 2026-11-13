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
  cached PDF finds about 700 table rows, each a field label directly followed by its
  required flag and type. The only irregular rows are the request header `Authorization`
  (repeated in every section), `Id` printed for the field `id` (p.12), and two rows
  without a label (p.33 and p.34): there the request body itself is an array of strings,
  as the §3.16 and §3.17 samples show. (Step 3 found more shapes; see Evidence.)

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

| Form                                    | Meaning                                                                                 |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| `{"page": 14}`                          | A table row on page 14 whose label is the element's name.                               |
| `{"page": 13, "row": "nfc_cards[].id"}` | A table row printed with a different label: a nested path, or `Id` for `id`.            |
| `{"page": 33, "row": ""}`               | A row without a label, which types the whole request body.                              |
| `{"page": 13, "parent": true}`          | No row of its own: its fields' rows are printed under its name (`license_plates[].id`). |
| `{"page": 21, "sample": true}`          | The field appears only in a response sample on page 21 (response-only, §3).             |

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
  `null`, `[]` or `{}` defines no type by itself. Such a field is transcribed only when
  the same structure is typed elsewhere in the PDF, by a table row or by a filled entry of
  the same sample, and an `x-note` names it (§4: a visitor schedule's empty `monday: []`
  takes the type of its filled `friday`). Otherwise it is not transcribed and is stripped
  from results, like an unconstrained property in ADR 0018.
- **A representative row.** Where a table prints one row for a set of fields and says so,
  each field of the set cites that row, and the field names come from the samples, with
  an `x-note` (§4: `week_schedule.monday` is printed for the periods "from Sunday to
  Saturday", so each of the seven days cites it). Transcribing the row alone would accept
  Mondays only.
- **A body shown only in a sample.** A write whose request body has no table is
  transcribed without a body and is not generated, because it would send nothing (§4.13
  visitor license plates).
- **A body the samples contradict.** Where the request and response samples agree with
  each other against the table on a write's body structure, the table is still
  transcribed, but the write is not generated until the body is verified (§8.3 device
  access methods).
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
  `x-minimum-version`, transcribed literally. Where only the change log (§13) names the
  field or its mode, `x-minimum-version-source` gives that page, and the check looks for
  the version there (§7.9: `actor_id` and `actor_name` from v3.3.21; the UA Hub Gate
  modes `entry_method` and `control_cmd` from v4.2.16). The generated module lists these
  per operation. The adapter refuses a request that uses such a field when the console's
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
  §2). Other siblings of `data` that a sample shows are transcribed as sample fields
  (§9.2 prints `page` and `total` there). An operation whose `data` the PDF documents as
  `null` has no response content, and the translator discards whatever arrives.

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
  - Every enumeration value appears on the field's page, and every `x-minimum-version` on
    that page or the next.
  - Every inventory operation's documented path, permission key and method are printed on
    its `sourceRef` page or the next, transcribed or not. This also checks
    `operations.json`.
  - The error codes in `x-error-codes` are exactly those printed in the PDF.
- **PDF → transcription.** On the pages the transcription declares done (`x-pdf-pages`),
  every detected table row must be claimed by at least one element that cites its page,
  or be listed under `x-declined` with a reason. The request header `Authorization` is
  declined once for the whole document: the transport sends it. A declined row that
  matches nothing is reported. Omitted rows are therefore found mechanically, not only by
  review.
- **Limits.** The check shows that each element matches a row on the page it cites. It
  cannot show that the row belongs to that operation rather than to a neighbour on the
  same page, that nesting is right, or that a sample's type is meant generally. A person
  checks those in review. A row the extraction cannot detect is missed in both
  directions, which is why the review follows the PDF page by page, and why every row
  shape found in the whole PDF is taught to the detector (Evidence, step 3).

### 7. Generation and freshness

- `GENERATED_MODULES` gains an Access entry that reads the transcription instead of a
  vendor document. Before generating, it checks that `x-transcribed-from` matches the PDF
  checksum in `provenance.json`. Operations are named by method and path, as for Protect.
- The translator accepts the schema annotations `x-pdf`, `x-note`, `x-minimum-version`
  and `x-minimum-version-source` only in transcription mode. In a vendor document they still fail
  generation. The rules of §3 that differ from OpenAPI sources (optional and nullable
  response properties, field versions) apply only in that mode, and the generated file
  states them in its header.
- Because the transcription is committed, the generated module and its freshness test
  run offline. Only the PDF comparison (§6) needs the vendor cache.
- **In stages.** The PDF is transcribed one chapter at a time (§3 users, §4 visitors, and
  so on), one reviewed commit each, including the regenerated module. Until all
  operations are transcribed, the rest are listed in the transcription's `x-pending` and
  are not generated. `x-pdf-pages` grows with each chapter, and every row citation must
  fall inside it. A sample citation may point to a later page (§3.30's sample is printed
  on p.52, beside chapter 4's first table), because samples take no part in the reverse
  check. The transcription is complete when nothing is pending and `x-pdf-pages` covers
  every page with table rows.

## Evidence

Step 2, tooling (2026-11-13). No operation is transcribed yet: all 107 are pending.

- `scripts/lib/pdf-text.ts` reads the pinned PDF (194 pages) in about 0.4 s. Its output is
  byte-identical to an independent extraction written earlier in Python for the ADR 0021
  review.
- `detectTableRows` finds 706 rows on pages 12 to 192. The irregular ones are the
  request header `Authorization` (declined once for the whole document), `Id` and `Data`
  labels, the unlabelled body rows (p.33, p.34, p.163, p.166, p.169), `Array[Object].…`
  labels (p.162) and the inbound webhook `Signature` header (p.179). Rows whose description
  starts in lower case (`statusStringenum …`) are detected.
- The parent citation form (§2) was added when a trial run over pages 12 to 16 listed
  `license_plates[].id` and its siblings on p.13, with no row for `license_plates` itself.
- `api:reconcile` (check 9) finds, for each of the 107 inventory operations, the
  `Request URL`, `Permission Key` and `Method` printed on its `sourceRef` page or the
  next. This also checks `operations.json`. The 44 error codes in `x-error-codes` equal
  those printed in the PDF.
- Tests: `tests/unit/scripts/pdf-text.test.ts` (synthetic PDFs: simple and Type0 fonts,
  ToUnicode maps, compressed streams, forms, the page tree, failures);
  `tests/unit/scripts/access-transcription.test.ts` (row detection; the structural
  checks; both directions of the PDF comparison; operations and error codes);
  `tests/unit/scripts/openapi-zod.test.ts` (transcription mode);
  `tests/contract/access-transcription.test.ts` (the committed transcription and the
  generated module, offline).
- Mutation checks, each making a test fail: cited response properties not optional and
  nullable; citation extensions accepted in a vendor document; field versions not followed
  into array items; the reverse check off; a sample field accepted in a request; the
  required-flag comparison off; components used by requests not treated as requests; vendor
  prose accepted; a misplaced citation accepted; a declined row that matches nothing
  accepted; wide `TJ` gaps not turned into spaces; a page-tree loop not detected.

Step 3, chapter §3 users (2026-11-13): 29 operations on pages 12 to 51, 78 pending.

- Reading the chapter showed row shapes the detector missed. A scan of the whole PDF for
  them found: a bare `Array` type (p.44, 46, 48, 116, 122); types printed below the label
  and flag (`idsT`, then `Array of` and `Strings`; `Object` `(Map)` and
  `Object<String, String>` on p.47, 139, 174, 175 and 177); and the label `-` (p.49). The
  detector now reads them (718 rows); typed maps are compared as `Map`.
- Tables are not always on the page of their section heading: §3.7's body table, for
  example, is printed at the top of p.24 beside §3.8's header and path tables. Each table
  was assigned by its section's labels and its sample.
- Pages 12 to 51 hold 150 rows, 120 of them other than `Authorization`. Each is
  transcribed (113 row citations, 1 parent citation, plus 19 sample citations) or
  declined. Removing one transcribed field and one declined row each produced a report.
- Declined: `touch_pass` in the user schema (typed `Array[Object]`; every sample shows one
  object); `expand[]` on p.17 and p.19 (Boolean with the example `access_policy`);
  `bundles` on p.44, 46 and 48 (item type undocumented); `emails` in the §3.27 body (a
  map, which a request cannot carry).
- Sample disagreements recorded in `x-note`: §3.3 posts to `/developer/user` and sends
  `pin_code`; §3.8 uses DELETE; §3.12 and others repeat `/developer/developer/`; §3.24's
  `data` is not valid JSON and is read as a list of users.
- §3.30 (multipart profile picture) is transcribed and omitted from generation.

Step 3, chapter §4 visitors (2026-11-13): 13 operations on pages 52 to 72; 65 pending.

- Pages 52 to 72 hold 89 rows other than `Authorization`, each transcribed. Removing one
  schema field and one query parameter each produced a report. Nothing is declined.
- The detector learned the one lower-case type in the PDF (`expand[]Fstring`, p.59), and
  enumeration values may be numbers (§4.4 `status`, Integer 1 to 6).
- Decisions recorded in `x-note`: the representative `week_schedule.monday` row; the
  samples' `weekly`, transcribed beside the table's `week_schedule`; "Support both door
  and door_group" read as the allowed set of `resources[].type`; `expand[]` and `status`
  accept one value each; §4.13 has no body table and is not generated.

Step 3, chapter §5 access policies, holiday groups and schedules (2026-11-13): 15
operations on pages 73 to 101; 50 pending.

- Pages 73 to 101 hold 113 rows other than `Authorization`, each transcribed or
  declined. Removing a field, removing a declined row and changing a field version each
  produced a report.
- Chapter 3's sample-based access policy schema is replaced by the §5.1 table. Its `Id`
  row is printed without a type, so `id` is typed from the sample.
- Declined: seven response tables that list only the `id` of the object the response
  returns in full (its "Schemas"); the `Id` printed as a required body field of the read of
  all holiday groups (it contradicts the operation; the sample sends no body); the
  §5.16 response table, which repeats four fields of the §5.13 schedule.
- `Data` rows (§5.5, §5.6, §5.17) are cited on the response. Holiday times are requests'
  `date-time`, because the tables state RFC 3339. The schedule's representative `monday`
  rows apply as in §4; on create they are required, so all seven days are. `"data":
"success"` responses are discarded.
- A field's minimum version may be printed beside another row of the same name
  (`holiday_schedule`: §5.13, p.90); the check now accepts that page.

Step 3, chapter §6 credentials (2026-11-13): 16 operations on pages 102 to 124; 34
pending.

- Pages 102 to 124 hold 100 rows other than `Authorization`, each transcribed or
  declined. Removing a field, adding an enumeration value and dropping a required flag
  each produced a report.
- Declined: `activated_at` and `expired_at` (typed Object but described as timestamps;
  every sample shows `{}`), and the bare `bundles` arrays of §6.14 and §6.17.
- §6.15 prints the Touch Pass table again; it is transcribed with its own citations, like
  §3.25 to §3.27. §6.18 (a PNG image, its media type taken from the sample's file name)
  and §6.19 (a multipart CSV upload) are transcribed and not generated.
- §6.1 returns the generated PIN code as `data`; §6.17 purchases Touch Passes with the
  payment method configured in Access. Both matter for the adapter's security review, not
  for the transcription.

Step 3, chapter §7 spaces (2026-11-13): 13 operations on pages 125 to 146; 21 pending.

- Pages 125 to 146 hold 75 rows other than `Authorization`, each transcribed or declined.
  A wrong change-log page, a removed field and a removed decline each produced a report.
- Declined: the door groups' `resources` rows (typed String; their fields and every
  sample make them lists of objects, which are cited by those fields); the doors'
  `is_bind_hub` rows (typed String; every sample shows a boolean, and §7.1 types it
  Boolean, so it is typed from the sample); the unlock's `extra` map.
- Door group `type` rows are printed `typetString` (a lower-case flag) and cited as
  printed. Each door group and door response table is transcribed with its own
  citations.
- §7.9 remote unlock: the change-log field versions above, read from p.193; `entry_method`
  (in, out) and `control_cmd` (open, close, stop) are enumerations, as the rows name the
  supported values. That `actor_id` and `actor_name` go together is left to the console.

Step 3, chapter §8 devices (2026-11-13): 4 operations on pages 147 to 154; 17 pending.

- Pages 147 to 154 hold 56 rows other than `Authorization`, each transcribed. A removed
  method and a wrong enumeration value each produced a report. Nothing is declined. The
  `Content-Type` header rows (p.151, p.153) are the only rows whose label has a hyphen;
  the detector does not see them, and the transport sends the header anyway.
- §8.1: the sample nests the devices in lists (`[[…]]`); `data` is read that way.
- §8.2 and §8.3: the tables list the access methods at the top with "true"/"false"; both
  samples nest them under `access_methods` with "yes"/"no". The response transcribes
  both; the §8.3 write transcribes the table and is not generated (§3, new rule).

Step 3, chapter §9 system logs (2026-11-13): 4 operations on pages 155 to 161; 13
pending.

- Pages 155 to 161 hold 17 rows other than `Authorization`, each transcribed. A wrong
  sample page and a removed field each produced a report.
- §9.2: the response table names the four parts of a log entry; the sample places them
  under `data.hits[]._source` and shows `page` and `total` beside `data` (§4 now allows
  such sampled siblings). §9.1's key and value tables have no types and are not field
  tables.
- §9.3 (a CSV export) and §9.5 (files whose path parameter contains slashes; the PDF
  states no media type) are transcribed and not generated. §9.4's response comes from
  its sample.

Step 3, chapter §10 UniFi Identity (2026-11-13): 6 operations on pages 162 to 169; 7
pending.

- Pages 162 to 169 hold 23 rows other than `Authorization`, each transcribed or
  declined. A wrong parent page and a removed field each produced a report.
- §10.1's body is a JSON array of invitations, printed as `Array[Object].user_id` and
  `Array[Object].email`; it is cited as their parent (a list's fields may be printed
  without brackets).
- The resource reads return `data` as an object keyed by resource type, each a list of
  resources (a typed map, which responses support). Its row `data.[resource_type]` is
  printed over three lines; the detector reads only its last line, as a row without a
  label, which is declined with that explanation (on p.163 it even says String).
- `resource_type` accepts one value of its enumeration, although an example lists several
  separated by commas.

Step 3, chapters §11 notifications and webhooks, §12 API server (2026-11-13): 7
operations; the transcription is complete.

- Pages 170 to 194 hold table rows only for the webhook endpoints (p.173 to 179) and the
  certificate upload (p.191). Declined: the request `headers` maps (p.175, p.177) and
  the inbound delivery's `Signature` header (§11.7, outside the inventory).
- §11.1 is a WebSocket whose messages are shown only as samples; it is transcribed as an
  operation and decided with the event streams. §12.1 (a multipart private key upload) is
  not generated. Webhook endpoint reads return each endpoint's `secret`, which matters for
  the adapter's security review.

The transcription as a whole (2026-11-13):

- All 107 operations, 30 component schemas, 39 declined rows with reasons. Nothing is
  pending and `x-pdf-pages` covers pages 1 to 194, so every detected row of the PDF is
  transcribed or declined; `tests/contract/access-transcription.test.ts` keeps it so.
- 98 operations are generated. Nine are not, each with its reason in the generator
  configuration: five non-JSON (§3.30, §6.18, §6.19, §9.3, §12.1), the WebSocket (§11.1),
  the static files (§9.5), §4.13 (no body table) and §8.3 (body disputed by the samples).

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
