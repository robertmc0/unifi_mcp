# Development

> **For contributors**, human or AI. The rules in [AGENTS.md](../AGENTS.md) apply to both;
> this page explains the workflow behind them, how an operation is added to an adapter,
> and how it is tested. The design is in the
> [specification](../unifi-mcp-design-spec.md) and the [ADRs](adr/README.md); the current
> state is in [phase-checklist.md](phase-checklist.md).

## Setting up

Requirements: Node.js 26.13.0 or later on the 26.x line (`.node-version`), npm 11, Git and
the `openssl` command, which the tests use to make synthetic certificates. The container
tests also need Docker with buildx.

```sh
npm ci
npm run api:fetch-specs   # downloads the vendor contracts; needs internet
npm run check             # format, lint, typecheck and every offline test
npm run api:reconcile     # contracts, inventories, generated schemas and coverage agree
```

`api:fetch-specs` is the only step that needs internet. It downloads the vendor contracts
from `developer.ui.com` and `assets.identity.ui.com` into `api-specs/**/vendor/`, which
is not committed because no licence allows redistributing them
([ADR 0006](adr/0006-vendor-api-artefact-handling.md)), and checks each file against the
SHA-256 recorded in `provenance.json`. Both `check` and `api:reconcile` must pass before
you start, and again before you commit.

## Commands

| Command                                  | What it does                                                                                                                                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                          | `format:check`, `lint`, `typecheck` and `test`. Required before every commit.                                                                                                                                        |
| `npm test`, `npm run test:watch`         | The offline tests (unit, contract, mock integration, security, performance).                                                                                                                                         |
| `npm run api:reconcile`                  | Fails on any unreviewed difference between the vendor contracts, the committed inventories, the generated schemas and the coverage matrix. Required when you touch `api-specs/`, an adapter or the coverage tooling. |
| `npm run api:coverage-report`            | Rewrites the coverage matrix in `docs/api-coverage/` from the inventories and the registered adapters.                                                                                                               |
| `npm run test:containers`                | Builds the image and runs the shipped Compose files ([ADR 0028](adr/0028-compose-examples-and-container-tests.md)). Required when you touch `deploy/`, the `Dockerfile` or a listener.                               |
| `npm run test:live`                      | Opt-in, read-only tests against your own console. Never in CI ([below](#tests-against-a-real-console)).                                                                                                              |
| `npm run scan:secrets`                   | The secret and address scan over the tree and the whole history.                                                                                                                                                     |
| `npm run release:verify`, `npm run sbom` | Release checks and the bill of materials ([release.md](release.md)).                                                                                                                                                 |
| `npm run unifi-mcp -- <command>`         | The CLI from source ([administration.md](administration.md)). Never `npx unifi-mcp`: that name belongs to an unrelated package on the npm registry.                                                                  |

## Repository layout

| Path                                                                        | What is there                                                                                                                                                                      |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`                                                             | The operation registry, input and output validation, and the one dispatcher every transport uses.                                                                                  |
| `packages/policy`                                                           | Effective permissions, risk, sensitivity tags and redaction.                                                                                                                       |
| `packages/approvals`                                                        | Human approval of high-risk requests and their resumption by the requesting client.                                                                                                |
| `packages/storage`                                                          | SQLite, migrations, encryption of secret records, backups.                                                                                                                         |
| `packages/telemetry`                                                        | Logging, the audit trail, health checks, metrics.                                                                                                                                  |
| `packages/unifi-api`                                                        | The HTTPS transport to consoles: console registry, TLS trust and pins, egress checks, version probes, module endpoints.                                                            |
| `packages/unifi-network`, `packages/unifi-protect`, `packages/unifi-access` | The adapters: generated schemas and the reviewed metadata of each operation.                                                                                                       |
| `packages/mcp-server`                                                       | The service: MCP tools, the three listeners, the adapter list (`src/adapters.ts`).                                                                                                 |
| `packages/admin-api`, `packages/admin-ui`                                   | The optional admin web interface.                                                                                                                                                  |
| `packages/cli`                                                              | The host administration CLI.                                                                                                                                                       |
| `packages/stdio-bridge`                                                     | The stdio bridge for clients that only speak stdio.                                                                                                                                |
| `api-specs/`                                                                | Per application revision: `provenance.json` and `operations.json` (and, for Access, `transcription.json`), committed; `vendor/`, not committed ([README](../api-specs/README.md)). |
| `scripts/`                                                                  | Contract fetching, reconciliation, schema generation, the coverage report, the secret scan, release checks.                                                                        |
| `tests/`                                                                    | See [Tests](#tests).                                                                                                                                                               |
| `docs/`                                                                     | This manual, the ADRs, the coverage matrix and the phase checklist.                                                                                                                |
| `deploy/`                                                                   | Compose files and the wrapper scripts the image installs.                                                                                                                          |

The conventions are in [AGENTS.md](../AGENTS.md#engineering-conventions): ESM, strict
TypeScript run directly by Node.js (relative imports end in `.ts`), npm workspaces.

## What may be implemented

Only operations listed in `api-specs/<application>/<revision>/operations.json`, against
the local base URL in that revision's `provenance.json`. Each inventory is derived from an
official vendor contract whose checksum is recorded. Never add:

- an undocumented, private, legacy or reverse-engineered endpoint, even one a community
  project uses, or one a console answers when you try it;
- the cloud connector (`api.ui.com`) or any other cloud route;
- a tool that proxies arbitrary HTTP, runs code or SQL, approves a request or reaches the
  CLI.

When the contract is ambiguous, do not guess. Leave the operation or the parameter out
and record why: an omission with a reason (`PROTECT_OMISSIONS`, `ACCESS_OMISSIONS`), or
an omitted parameter in `scripts/generate-adapter-schemas.ts`. The coverage matrix shows
the reason. If the contract and the specification disagree, write an ADR with the
evidence before going further (spec §20).

## Adding an operation

This is the path for an operation that is in an inventory but not yet implemented (the
"Not yet" column of the [coverage matrix](api-coverage/README.md)).

1. **Read the vendor's documentation of the operation** (its `documentationUrl` in
   `operations.json`) and the generated schema of its request and response in
   `packages/unifi-<application>/src/generated/`. Never edit a generated file; it is
   rewritten from the vendor cache ([ADR 0018](adr/0018-network-adapter.md)).
2. **Define it** in `packages/unifi-<application>/src/operations/<category>.ts` with the
   adapter's helper: `networkOperation`, `protectOperation` or `accessOperation`. The
   helper takes the method, path and schemas from the generated contract. Everything else
   is your review, written in code and never derived from the vendor document:
   - `operationId` (`<module>.<category>.<action>`), `category`, `effect`, and a
     description in your own words;
   - for a write: `risk` (spec §6.3; [security.md](security.md#risk-and-approval)),
     `approvalRequired`, `retryClass` (`idempotent` only if repeating it cannot change
     the result), `resourceLockKey` (writes that conflict share a key and run one at a
     time), and `defaultDisabled` for anything that destroys or resets;
   - `sensitivityTags` when the result says something about people, and the credential
     fields of the result, which are removed before anything is returned;
   - `namedTool` only for a common read.

   [`devices.ts`](../packages/unifi-network/src/operations/devices.ts) shows reads and
   high-risk writes side by side.

3. **Add it to the adapter's list** (`NETWORK_READS` or `NETWORK_WRITES`, and the same
   for Protect and Access) in the package's `index.ts`. The service, the CLI and the
   coverage tooling all register from `packages/mcp-server/src/adapters.ts`, so they
   cannot disagree about what exists. The registry refuses at start an operation whose
   method and path are not in the inventory.
4. **Record the review** as a row of the table in
   `tests/contract/<application>-security-review.test.ts`. A later change to risk,
   approval, sensitivity, default state or named tool must change that row too.
5. **Test it** against the synthetic console (see [Tests](#tests)). The read and write
   tests of each adapter (`tests/integration-mock/<application>-reads.test.ts` and
   `-writes.test.ts`) run every operation in its lists and pin how many there are: update
   the count, add the arguments and responses your operation needs, and the cases only it
   has.
6. **Regenerate the coverage matrix** with `npm run api:coverage-report` and review the
   diff, and update the hand-written totals in
   [api-coverage/README.md](api-coverage/README.md).
7. **Document it** on the application's page (`docs/applications-<application>.md`):
   what it does, the grants it needs, what is never returned, and its limitations.
8. Run `npm run check` and `npm run api:reconcile`.

## A new contract revision or application

**A changed artefact.** If `api:fetch-specs` reports a mismatch, the vendor changed a
published file at the same URL. The download is kept as `<name>.mismatch`. Never make the
error go away by editing the recorded checksum: treat it as a new revision and review
what changed ([ADR 0006](adr/0006-vendor-api-artefact-handling.md)).

**A new revision of a supported application:**

1. Add `api-specs/<application>/<revision>/provenance.json`, starting from the previous
   revision's: the artefact URLs, the SHA-256 and size of each artefact as you
   downloaded and reviewed it, the local and forbidden base URLs, authentication, and
   what is still unverified. Run `npm run api:fetch-specs`.
2. Derive the inventory with `node scripts/reconcile-api-coverage.ts --write` and review
   the diff of `operations.json`.
3. Add the revision to `GENERATED_MODULES` in `scripts/generate-adapter-schemas.ts`, run
   `node scripts/generate-adapter-schemas.ts`, and review the generated module like any
   other code.
4. Decide, in an ADR, which revisions the adapter supports and for which application
   versions. An operation built from one revision may serve a later one only if the
   later contract differs from it by additions alone; `api:reconcile` checks this
   ([ADR 0019](adr/0019-protect-adapter.md) §7).

**A new application** needs, first, an official local API that the vendor documents in
an artefact whose checksum can be recorded. Until then it stays a disabled slot with a
reason ([ADR 0024](adr/0024-other-applications-as-disabled-slots.md),
[applications-other.md](applications-other.md)). With such a contract, the Network,
Protect and Access adapters are the worked examples
([ADR 0018](adr/0018-network-adapter.md), [ADR 0019](adr/0019-protect-adapter.md),
[ADR 0023](adr/0023-access-adapter.md)): the module's endpoint in
`packages/unifi-api/src/modules.ts`, a package with its helper, lists and probe, its
entry in `packages/mcp-server/src/adapters.ts`, its evidence in
`scripts/lib/coverage-report.ts`, and the tests and pages above. Access shows what to do
when the contract is only a PDF: its schemas come from a hand transcription in which
every field cites its page and row, and `api:reconcile` checks the transcription against
the PDF ([ADR 0022](adr/0022-access-contract-transcription.md)).

## Tests

| Folder                             | What it holds                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/unit/<package>/`            | One package at a time.                                                                                                                                                                     |
| `tests/contract/`                  | Offline checks of committed facts: inventories, generated schemas, the security review tables, the coverage matrix, packaging, and the manual against the CLI, the code and its own links. |
| `tests/integration-mock/`          | The real service, adapters and MCP clients against synthetic consoles.                                                                                                                     |
| `tests/security/`                  | The invariants of spec §17: policy, approvals, the dispatcher's gates, the transport, the bridge, redaction, the master key.                                                               |
| `tests/performance/`               | The dispatcher and the service under load ([ADR 0010](adr/0010-operation-registry-and-dispatcher.md)).                                                                                     |
| `tests/container-network/`         | The image and the Compose files (`npm run test:containers`).                                                                                                                               |
| `tests/integration-live-readonly/` | Opt-in reads against your own console (`npm run test:live`).                                                                                                                               |

**Synthetic consoles.** `tests/fixtures/mock-console.ts` is an HTTPS server on
127.0.0.1 that records every request and answers with whatever a test tells it to.
`network-console.ts` answers every documented Network and Protect read with a sample
built from its response schema, and `access-console.ts` does the same for Access.
`test-pki.ts` makes the certificates. Write tests run only against these; nothing in the
automated tests writes to a real console.

**Synthetic data only.** Fixtures never hold a real key, token, host name or address. Use
the documentation address ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`),
`.example` or `.invalid` names, and values that look made up (`synthetic-…`,
`SENTINEL-…`). The secret scan in `npm run check` fails otherwise. A test that needs a
value shaped like a real secret builds it from pieces, as
`tests/unit/scripts/secret-scan.test.ts` does.

**Prove the test can fail.** For a security check, break the code it guards, see the test
fail, and put the code back. The ADRs record such mutation checks.

### Tests against a real console

The live tests only read, are opt-in, and never run in CI. How to run them and what they
record is on each application's page
([Network](applications-network.md#testing-against-a-real-console)). The optional write
runbooks ([Network](runbook-network-writes.md), [Protect](runbook-protect-writes.md)) are
manual, never automated, and need your approval at every high-risk step. Never commit a
console's address, certificate pin, key, or the names and ids it returns.

## Documentation and decisions

- The manual is a deliverable (spec §18). A change that alters what an operator or a
  client sees changes the page that describes it, in the same commit. The tests check that
  every `unifi-mcp` command, link, environment variable and tool name in the manual exists.
- Record a decision that the specification does not already fix as an ADR in `docs/adr/`
  ([ADR 0001](adr/0001-record-architecture-decisions.md)), and add it to the
  [index](adr/README.md).
- Update [phase-checklist.md](phase-checklist.md) when a task or a gate changes state.
- Add user-visible changes to [CHANGELOG.md](../CHANGELOG.md) under "Unreleased".

## Commits and pull requests

Small, reviewable commits, each passing `npm run check` (and `npm run api:reconcile` when
it applies). Say what was verified and how, and what was not: never claim that a test, an
integration or an endpoint works without having run it. Security problems are reported
privately ([SECURITY.md](../SECURITY.md)), never in a public issue.
