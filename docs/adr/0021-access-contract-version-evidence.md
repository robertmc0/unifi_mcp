# 0021. UniFi Access contract: version evidence and binding

- Status: Accepted. The owner chose B2 with U1 on 2026-11-13 (§5).
- Date: 2026-11-12 (proposed), 2026-11-13 (decided)
- Phase: 4
- Spec references: §2 decision 23; §4.1; §4.3; §4.5; §16 Phase 4; §20

## Context

Spec §4.1 admits Access only with an official contract "verified **for installed
application version**". Network and Protect meet this with version-labelled OpenAPI
documents and a version probe. Every operation carries an `apiVersionRange`, and the
policy denies `version_unknown` until a documented read has reported the module's version
(ADR 0012, ADR 0018 §3, ADR 0019).

The Phase 4 contract review asked what the Access contract says about versions, and what
evidence would bind its operations to an application version. The project's test console
has no Access ([phase checklist](../phase-checklist.md#phase-4--access-and-other-documented-modules)),
so this review uses only published material.

## 1. Evidence (checked 2026-11-12)

Labels: **vendor-stated** is written in a vendor source; **observed** is what we saw;
**inference** is our reading and is not stated by the vendor.

### The contract source

- **Observed.** The hosted PDF is unchanged since Phase 0: the same SHA-256 (`6abb576c…`,
  [provenance](../../api-specs/access/2026-03-23/provenance.json)), 2,150,514 bytes,
  `Last-Modified: Thu, 26 Mar 2026 06:08:00 GMT`.
- **Vendor-stated.** "Getting Started with the Official UniFi API" (help.ui.com
  30076656117655, updated 2026-09-22) still links this PDF for Access. For Network, the
  same article points to documentation "specific to your UniFi Network version" in the
  application.
- **Observed.** The developer portal index (`https://developer.ui.com/llms.txt`) lists
  Network, Protect, Mobility, InnerSpace, Site Manager and Carrier Fabric, but not Access.
  `https://developer.ui.com/access` answers 404.
- **Observed.** Third-party OpenAPI conversions of the PDF exist. They are not vendor
  artefacts and are not used (AGENTS.md).

### What the PDF states about versions

- **Vendor-stated.** The document has no version of its own.
- **Vendor-stated.** §1.5: "Ensure your UniFi Access version is 1.9.1 or later."
- **Vendor-stated.** 59 of the 107 operations print "UniFi Access Requirement: X or
  later". The other 48 print none, so only the §1.5 minimum applies to them. §3.11 to
  §3.23 also print "API version: v1".

  | Stated minimum | Operations | Sections                                                 |
  | -------------- | ---------: | -------------------------------------------------------- |
  | 1.9.1 (§1.5)   |         48 | §3.2–3.10, §4.2–4.10, §5, §6.1–6.4, §7.1–7.9, §8.1, §9.2 |
  | 1.20.11        |          2 | §9.3 system log export, §11.1 notifications              |
  | 1.22.16        |          3 | §6.7–6.9 NFC cards                                       |
  | 1.24.6         |         10 | §7.10–7.13, §9.4–9.5, §10.1–10.4                         |
  | 2.2.0          |          2 | §10.5–10.6 (conflict, see below)                         |
  | 2.2.6          |         12 | §3.11–3.22 user groups                                   |
  | 2.2.10         |          6 | §11.3–11.6 webhooks, §12.1–12.2 API certificate          |
  | 3.1.30         |          3 | §3.23, §3.24, §6.10                                      |
  | 3.2.20         |          9 | §3.25–3.27, §6.12–6.17 Touch Pass                        |
  | 3.3.10         |         11 | §3.28–3.30, §4.11–4.14, §6.18–6.19, §8.2–8.3             |
  | 4.0.10         |          1 | §8.4 doorbell trigger                                    |

  §8.3 and §10.3 print the line at the top of the next page. Text positions show it sits
  under "Method", the operation's own requirement, not inside a field table.

- **Vendor-stated.** §13 "Change Logs" lists API changes for V2.2.6, V2.2.10, V3.1.30,
  V3.2.20, V3.3.10, v3.3.21, v4.0.10 and v4.2.16, each citing section numbers.
- **Vendor-stated.** Some fields have their own requirement: `user_email` (1.22.16) in
  the user schema and §3.2; `expand[]` on §4.3 (1.22.16); `holiday_schedule` in the
  schedule schema (1.20.11); license plates on visitor reads ("will be supported by
  3.3.10 or later", §4.4); several webhook events in §11.2 (3.3.10).
- **Vendor-stated, read by us.** Eight operations are cited by the change log at a
  version above their stated minimum:
  - §7.9 remote unlock: UA-Ultra (2.2.6); `actor_id`, `actor_name`, `extra` (3.3.21);
    UA Hub Gate three-button and double-driveway modes (4.2.16).
  - §3.4 and §3.5 user reads: Touch Pass details in the response (3.2.20).
  - §7.10 and §7.11 lock rules: temporary unlock for more device types, which "requires
    the latest device versions" (3.1.30).
  - §11.3 webhook endpoint list: "custom header configuration and forwarding" (3.1.30).
  - §10.5 and §10.6: these state "2.2.0 or later", but the change log lists them under
    V2.2.6 with user groups, and §3.11 introduces user groups at 2.2.6.

  The first six extend an existing operation (**inference** from the wording). The last
  two are a **conflict** between two vendor statements.

- **Vendor-stated by absence.** No upper bound, removal or deprecation is stated anywhere.
- **Correction.** Phase 0's provenance said the PDF "documents features up to UniFi
  Access 3.1.30, with per-operation minimum versions from 1.20.11 to 3.1.30". Both
  numbers were wrong (4.2.16 and 4.0.10). The provenance note is corrected.

### Which release the PDF matches

- **Observed.** The vendor's release feed (`community.ui.com`, UniFi Access Application)
  published 4.2.16 on 2026-03-26 at 02:58 GMT. That is three hours before the PDF's
  `Last-Modified`. The PDF was created on 2026-03-23, and 4.2.16 is its newest
  change-log entry.
- **Inference.** The PDF was published for Access 4.2.16. The vendor does not say so.
- **Observed.** Since then: 4.2.27 (2026-05-12), 4.2.28, 4.2.29, 4.3.3 (2026-07-07),
  4.3.5, 4.3.7, 4.3.9, 4.3.12, 4.3.22 and 4.3.24 (2026-10-27). The PDF has not changed.
  Their release notes name no new or changed API operation. 4.3.5 and 4.3.22 fix unlock
  webhooks sent in error. Release notes are not a contract, so their silence does not show
  that the API is unchanged.

### Learning the installed version

- **Observed.** None of the 107 documented operations reports the Access application
  version. Device data (§8.1 and webhook payloads) carries only device `firmware` and
  `version`.
- Network's `network.info.get` (`GET /v1/info`) reports only the Network version. UniFi OS
  console endpoints are not documented integration APIs, so they may not be used
  (AGENTS.md).
- **Consequence.** With no probe, the current platform denies every Access operation as
  `version_unknown` (policy stage 7). It fails closed.

### Other observations

- The port discrepancy is unchanged (ADR 0005). Help article 17452334269975 (updated
  2026-10-02) still says 12455; the PDF says 12445.
- §1.5 says the API is unavailable after upgrading to Identity Enterprise. The 4.1.15
  release notes fix "visitors created through the Access OpenAPI" being deleted under
  Identity Enterprise. These signals conflict; the adapter follows the PDF, which also
  documents an error code for it (`CODE_OTHERS_UID_ADOPTED_NOT_SUPPORTED`).
- §11.1 documents a local WebSocket notification subscription (since 1.20.11).
  `docs/events.md` and ADR 0020 said Access documents none; both are corrected.

## 2. What binds an operation to a version

These are three separate questions, and each needs its own evidence:

| Question                                          | Evidence that would answer it                                                                                                                                                                                                                                              | Available now                                                                                  |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A. Which Access versions does the contract cover? | A version-labelled vendor contract. Candidate: the in-app "Download API documentation" (§1.1) of an installed version X, compared by SHA-256 with the hosted PDF. If identical, the hosted PDF is X's documentation; if not, it is a new revision `api-specs/access/<X>/`. | Lower bounds only (vendor-stated). No upper bound. 4.2.16 is an inference from release timing. |
| B. Which version runs on a given console?         | A documented read that reports the Access version.                                                                                                                                                                                                                         | None documented.                                                                               |
| C. Does the console behave as documented?         | An opt-in live read-only run on version X (spec §4.1 "test evidence").                                                                                                                                                                                                     | None. The test console has no Access.                                                          |

A and C need someone with Access installed. B cannot be answered from published material
at all. It needs either a vendor change or an owner decision (§5).

## 3. Decision

1. **Record the vendor's lower bounds in the inventory.** Each Access operation in
   `operations.json` carries `minimumApplicationVersion`, `minimumVersionSource`
   (`operation` or `general`) and, where §13 cites it, `changelogVersions`. All are
   literal transcriptions. `tests/contract/api-inventory.test.ts` checks that every value
   parses, that none is below §1.5, and that no change-log citation predates its
   operation's stated minimum. It also pins the eight citations above a stated minimum
   listed in §1. The coverage page shows "vendor min" per operation.
2. **When vendor statements disagree, the higher minimum applies** (least privilege):
   2.2.6 for §10.5 and §10.6.
3. **Field and behaviour requirements** (§1) are transcribed with each request and
   response schema. A response field that older versions lack is not required, and a
   request field is accepted only for versions that state it.
4. **These bounds are not a compatibility range.** No Access operation gets an upper
   bound from this evidence alone, and the Phase 4 gate stays open.
5. **No version, no operation.** An Access operation runs only when the console's Access
   version is known and inside the operation's range. With no documented version read,
   the version comes from an administrator's declaration (§5). Without a valid declaration,
   operations are denied as `version_unknown`, the platform's existing behaviour.

## 4. Consequences

- The adapter can be built and tested against synthetic mocks: transcribed schemas
  ([ADR 0022](0022-access-contract-transcription.md)), the `{code, msg, data}` envelope, the §2.4 error codes, reviewed security metadata, and
  high risk for physical-access writes.
- Under §5, Access runs on a real console only after an administrator has declared its
  version, and only for versions up to 4.2.16. Consoles that run a current release (4.3.x
  as of 2026-11) are refused (`operation_unsupported`) even with a declaration, until
  evidence A or C covers that release.
- The Phase 4 gate needs evidence A and C from an installed Access version. B is answered
  by §5 (declared, not observed) and must be visible as such in every result and approval.

## 5. Decided: operator-declared version, bounded at 4.2.16 (B2 with U1)

The owner chose **B2 with U1** on 2026-11-13.

**Considered and not chosen.** B1, waiting for a documented version read: Access would
stay `version_unknown` on every real console, with no deviation from the spec. U2, the
bound `<5`: Network (`<12`) and Protect (`<8`) rest on a version-labelled contract and a
probed version; Access has neither, so U2 would stack one inference on another.

**B2. Operator-declared version.** This deviates from spec §2 decision 23 ("capability
detection") and is recorded here as spec §20 requires.

- A host administrator declares the installed Access version of one console through the
  host CLI. It cannot be set over MCP, and no tool or argument can change it.
- The service stores it apart from observed versions, audits it, and labels it "declared,
  not observed" in results, tool descriptions and approval requests.
- It expires 30 days after it was declared, so an Access auto-update cannot hide behind a
  stale value. After expiry, Access operations are `version_unknown` until it is declared
  again. A declaration that changes the version bumps the policy version, which invalidates
  pending approvals, exactly as an observed change does (ADR 0018 §3).
- Only a plausible version string is accepted (`PLAUSIBLE_VERSION`). Declaring a version
  above the bound is accepted and recorded, and operations are then refused as
  `operation_unsupported`, so the result says why.
- The CLI command and its storage are built with the adapter (Phase 4). They do not exist
  yet.

**U1. The range.** Each Access operation carries `apiVersionRange`
`>=<stated minimum> <=4.2.16`. The minimum is the operation's own "UniFi Access
Requirement", otherwise §1.5's 1.9.1, and the higher of two disagreeing vendor statements
(§3 item 2: 2.2.6 for §10.5 and §10.6). Field-level requirements (§3 item 3) apply within
that range. 4.2.16 is the newest version the PDF's change log covers. Widening the bound
needs evidence A or C for the newer version, recorded in this ADR.

## Re-evaluation triggers

- Ubiquiti publishes a versioned or machine-readable Access contract, or a documented read
  that reports the Access version.
- The hosted PDF changes (`npm run api:fetch-specs` reports a checksum mismatch).
- Someone supplies the in-app documentation download, or a live read-only run, from an
  installed Access version. Either can widen the U1 bound to the version it covers.
- An Access release note names a new, changed or removed API operation.
