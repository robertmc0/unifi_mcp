# Plan and phase checklist

Spec §16 defines the phases and gates. A phase is complete only when it has code, tests,
operator documentation and updated API coverage (milestone rule). Deferred work is listed
explicitly, never dropped silently.

## Phase 0 — Research and contract baseline ✅ (completed 2026-11-10)

### Tasks

- [x] Confirm official local API availability per application → [ADR 0005](adr/0005-official-local-unifi-api-contracts.md)
- [x] Verify Network v11.0.97 documentation and source artefacts; distinguish local from
      cloud → `api-specs/network/11.0.97/`, cloud connector recorded as forbidden
- [x] Verify MCP TypeScript SDK v2 APIs → [ADR 0003](adr/0003-mcp-sdk-v2-and-protocol-eras.md), `tests/contract/mcp-sdk-v2-eras.test.ts`
- [x] Select the Node.js LTS line → [ADR 0002](adr/0002-runtime-and-toolchain.md) (26.13.0 "Lithium")
- [x] Record official Access integration guidance, local auth and ports → `api-specs/access/2026-03-23/`, ADR 0005 (12445 vs 12455 discrepancy)
- [x] API/version/source inventory and ADRs → `api-specs/README.md`, `docs/adr/0001`–`0006`

### Deliverables

- [x] `docs/adr/0001-*` (plus 0002–0006)
- [x] `api-specs/README.md` with provenance, terms and checksums
- [x] Initial API coverage inventory: `docs/api-coverage/` (Network 73, Protect 74, Access 107 operations)
- [x] Threat-model notes: [threat-model.md](threat-model.md)
- [x] Dependency lockfile: `package-lock.json` (`npm audit`: 0 vulnerabilities)
- [x] Repository skeleton: 14 workspace packages, lint/format/typecheck/test tooling, `AGENTS.md`

### Gate

- [x] **No undocumented endpoints in the roadmap.** All 254 inventoried operations trace to
      a vendor artefact with a recorded SHA-256. `npm run api:reconcile` passes, and
      Network/Protect `llms.txt` indexes equal their OpenAPI operation sets.
- [x] **Local authentication and URL bases documented from official sources.** See each
      `provenance.json` and ADR 0005.
- [x] **Unverified assumptions explicitly flagged.** See the `unverified` arrays in
      `provenance.json`, the coverage pages and the ADR 0005 table.

### Deferred from Phase 0 (by design)

- Dockerfile and Compose examples → Phase 1 (§16 Phase 1 "safe Docker examples"); done
  in Phase 1 step 11.
- CI workflows (`.github/`) → Phase 1 adds a basic check workflow (done in step 11);
  Phase 5 adds the security and supply-chain jobs.
- Operator manual pages other than `docs/index.md` → written alongside Phase 1 features.

## Phase 1 — Secure platform core ✅ (gate passed 2026-11-10)

All gate items below are met. Carried forward: `docs/client-codex.md` (waiting for the
owner's trial of Codex 0.161.0), the arm64 hardware run (Phase 5), retention of automatic
backups, and the Phase 5 items listed under the steps.

### Implementation order (plan)

1. ✅ **storage** (2026-11-10): `node:sqlite` port (ADR 0004), migrations in transactions, AEAD secret
   records with key id, master-key loading that fails closed, backup and integrity check.
   → `packages/storage`, [ADR 0007](adr/0007-storage-encryption-migrations-backups.md),
   [configuration.md](configuration.md), [backup-restore.md](backup-restore.md). Also done:
   verified key rotation, backup verification, validated offline restore, automatic
   pre-migration backups. Tests: `tests/unit/storage/`, `tests/security/storage-master-key.test.ts`.
   Still open, carried into later steps: ~~`linux/arm64` run of the storage tests~~ (done
   2026-11-10 under QEMU emulation: 63 of 63; see ADR 0017);
   ~~CLI `crypto generate-key|rotate-key` and `db backup|restore|check`~~ (done in step 9);
   retention of automatic backups; ~~single-instance guard per data directory~~ (done in
   step 9).
2. ✅ **telemetry** (2026-11-10): JSON logger with redaction, audit writer (fails safe on storage
   exhaustion), liveness/readiness. → `packages/telemetry`, storage migration 2
   (`audit_entries`), [ADR 0008](adr/0008-telemetry-logging-audit-health.md),
   [monitoring.md](monitoring.md). Also done: hash-chained, update-proof audit entries with
   audited pruning and chain verification; readiness recovery probe; disk space check.
   Tests: `tests/unit/telemetry/`, `tests/security/telemetry-redaction.test.ts`.
   Still open, carried into later steps: mounting `/livez` and `/readyz` and a Docker
   `HEALTHCHECK` (steps 7 and 11); token string pattern in redaction once the token format
   exists (step 7); audit-before-act wiring in the dispatcher (step 4); retention setting
   and scheduled pruning (done in step 7), CLI audit and chain-verification commands
   (done in step 9).
3. ✅ **policy** (2026-11-10): evaluation order §6.1, deployment hard lock, runtime mode, scope
   intersection, default deny for writes and sensitive reads. → `packages/policy`, storage
   migration 3 (`security_policy`), [ADR 0009](adr/0009-policy-evaluation-model.md),
   [security.md](security.md). Also done: strict schemas for global, console and client
   policy; risk elevation (raise only); default-disabled operations; credential exposure
   always denied; versioned, audited policy store with compare-and-set;
   `UNIFI_MCP_FORCE_READ_ONLY` unset means locked. Tests: `tests/unit/policy/`,
   `tests/security/policy-invariants.test.ts`.
   Still open, carried into later steps: running `evaluate()` at enqueue, dispatch and
   resume (step 4); binding approvals to the policy version (step 5); storing console and
   client policies with `bumpPolicyVersion` (steps 6 and 7); `policy show|validate|set-runtime-mode`
   and YAML import (done in step 9).
4. ✅ **core** (2026-11-10): `OperationDescriptor` registry, central dispatcher (checks at enqueue _and_
   dispatch), bounded queues, rate limits, resource locks, durable operation IDs.
   → `packages/core`, storage migration 4 (`operation_executions`),
   [ADR 0010](adr/0010-operation-registry-and-dispatcher.md), [security.md](security.md#write-safety).
   Also done: contract-inventory check at registration; strict request and argument
   schemas; segment-encoded path rendering; audit before act; `outcome_unknown` without
   retry; idempotency keys; restart recovery; fair round-robin scheduling; drain.
   Tests: `tests/unit/core/`, `tests/security/dispatcher-gates.test.ts`.
   Still open, carried into later steps: `ApprovalGate` and resume (step 5); the real
   `OperationExecutor`, capability probes and the inventory loader from `api-specs/`
   (step 6); MCP tools on top of the dispatcher and limits configuration (step 7);
   read-back reconciliation of `outcome_unknown` writes (Phase 2 adapters).
5. ✅ **approvals** (2026-11-10): prepare → pending → approved → resumed/executed state machine with
   atomic compare-and-set transitions, TTLs and argument digests. → `packages/approvals`,
   `Dispatcher.resume`, storage migration 5 (`approval_requests`),
   [ADR 0011](adr/0011-human-approval-workflow.md), [approval-workflow.md](approval-workflow.md).
   Also done: approvers only `admin` (recent sign-in, optional MFA) or `cli`; proposals bound
   to client, target, digest and policy version; arguments encrypted at rest and deleted on
   close; consumption atomic with the execution record; lazy and swept expiry; full audit.
   Fixed on the way: `presharedKey`-style field names were not redacted (ADR 0008).
   Tests: `tests/unit/approvals/`, `tests/security/approval-gates.test.ts`.
   Still open, carried into later steps: MCP resume/status tools (step 7); CLI
   `approvals list|show|approve|reject` (done in step 9); admin UI page with recent-auth and MFA
   (step 10); periodic `expireStale()` in the service (step 7); console-state diff and
   preconditions (Phase 2).
6. ✅ **unifi-api** (2026-11-10): HTTPS client with TLS verify, CA and pinning, egress allowlist, DNS
   re-validation, redirects refused, timeouts and size caps. Synthetic mock console server
   for tests. → `packages/unifi-api`, storage migration 6 (`consoles`, `console_modules`),
   [ADR 0012](adr/0012-unifi-transport-egress-and-console-registry.md),
   [security.md](security.md#connections-to-consoles). Also done: console registry with
   write-only encrypted credentials, audited changes and policy-version bumps; module
   endpoints checked against provenance; runtime contract inventory from `operations.json`;
   capability from observed versions and `apiVersionRange`; declared argument placement
   (path, query, body) enforced at registration. Fixed on the way: `agent: false` would
   bypass the verified socket. Tests: `tests/unit/unifi-api/`,
   `tests/contract/module-endpoints.test.ts`, `tests/security/unifi-transport-gates.test.ts`.
   Still open, carried into later steps: wiring `ConsoleRegistry` and the client store into
   the `SecurityContextProvider` (step 7); CLI `console add|list|check|disable` (done in step 9);
   module capability probes and application-level response checks (Phase 2–4).
7. ✅ **mcp-server** (2026-11-10): bearer gate and Host/Origin allowlist in front of `createMcpHandler`;
   per-client tool factory; `unifi_list_consoles`, `unifi_list_sites` (stub until Phase 2),
   `unifi_list_modules`, `unifi_list_operations`, `unifi_describe_operation`,
   `unifi_execute`, `unifi_get_operation_status`, resume. → `packages/mcp-server`, storage
   migration 7 (`clients`, `client_tokens`), [ADR 0013](adr/0013-mcp-server-tokens-gate-and-tools.md),
   [networking.md](networking.md), [client-generic-mcp.md](client-generic-mcp.md). Also done:
   token store (digest only, constant-time, rotation, revocation closing streams), failed-auth
   throttle, plaintext refusal on non-loopback binds, private non-cacheable tool lists,
   service startup/shutdown and `main.ts`, health endpoints, approval sweep and audit
   retention timers. `unifi_list_sites` is registered once an adapter provides site listing
   (Phase 2). Tests: `tests/unit/mcp-server/`, `tests/integration-mock/`.
   Still open, carried into later steps: stdio bridge (step 8); CLI for clients and consoles
   (done in step 9); Claude Code and Codex client guides verified against their releases (step 12).
8. ✅ **stdio-bridge** (2026-11-10): spike and decide the transport-relay design (ADR 0003, Proposed).
   → `packages/stdio-bridge`, [ADR 0014](adr/0014-stdio-bridge-transport-relay.md) (relay
   accepted), [client-generic-mcp.md](client-generic-mcp.md#connecting-over-stdio). Also done:
   storage-free logger export; strict configuration (loopback-only plaintext, token file
   preferred, env token removed); no redirects; JSON-RPC errors instead of hangs; exit
   codes; console redirection. Tests: `tests/unit/stdio-bridge/`,
   `tests/integration-mock/stdio-bridge.test.ts`, `tests/security/stdio-bridge-isolation.test.ts`.
   Still open, carried into later steps: packaging the bridge for client machines (step 11).
9. ✅ **cli** (2026-11-10): `admin bootstrap/reset-password`, `client`, `console`, `policy`,
   `approvals`, `config`, `crypto`, `db`, `audit`, `doctor`, `api coverage`.
   → `packages/cli`, `packages/admin-api` (accounts and Argon2id), storage migration 8
   (`admins`), [ADR 0015](adr/0015-host-administration-cli.md),
   [administration.md](administration.md), `deploy/example-bootstrap.yaml`. Also done:
   interactive-only approval with typed confirmation; secrets only from files or hidden
   prompts; terminal-safe output (control, C1 and bidi characters escaped, found while
   reviewing the approval screen); `--dry-run` through the stores' own validators;
   idempotent, never-deleting bootstrap apply in one transaction; `console check` with
   certificate pin and no request; single-instance data-directory lock (open since step 1),
   enforced for the service, key rotation and restore; open responses re-checked every 5 s
   so CLI revocations reach running streams (a gap found here: the in-process listener of
   step 7 never sees another process); key rotation and its audit entry in one
   transaction; `config validate` checks embedded policies. Tests: `tests/unit/cli/`,
   `tests/unit/admin-api/`, `tests/unit/storage/instance-lock.test.ts`,
   `tests/security/cli-invariants.test.ts`, `tests/integration-mock/cli-beside-service.test.ts`,
   `tests/integration-mock/instance-lock.test.ts`; 29 mutation checks.
   Still open, carried into later steps: `admin reset-mfa` with MFA (Phase 5); Docker
   commands for offline maintenance and the `unifi-mcp` command in the image (step 11);
   retention of automatic backups.
10. ✅ **admin-api / admin-ui** (2026-11-10): separate listener (off by default, loopback,
    own port, TLS and Host allowlist), sessions, CSRF, approvals page.
    → `packages/admin-api` (`AdminSessionStore`, `AdminHttpService`), `packages/admin-ui`
    (server-rendered pages, no JavaScript), storage migration 9 (`admin_sessions`),
    [ADR 0016](adr/0016-admin-listener-sessions-and-ui.md),
    [administration.md](administration.md#admin-web-interface),
    [networking.md](networking.md#the-admin-listener). Also done: `__Host-` Secure HttpOnly
    SameSite=Strict cookie with digest-only storage; idle and absolute session limits;
    sessions ended by sign-out, host password reset and disabled accounts; sign-in throttle
    per username and address; same-origin `Origin` check and HMAC CSRF token on every
    POST; strict CSP without scripts and other security headers; password required for
    every approval (recent re-authentication); dashboard and audit pages; shared
    `displaySafe` escaping (core) for the CLI and HTML; Trojan Source hygiene test.
    Tests: `tests/integration-mock/admin-http.test.ts`, `tests/unit/admin-api/sessions.test.ts`,
    `tests/unit/admin-ui/`, `tests/contract/source-hygiene.test.ts`; 16 mutation checks.
    Deferred to Phase 5 (with the spec's "admin MFA" task): the other §13.1 pages (editing
    consoles, clients and policy, permission preview, settings and maintenance, audit
    export), TOTP MFA with recovery codes and `admin reset-mfa`. Until then the CLI covers
    them.
11. ✅ **Packaging** (2026-11-10): Dockerfile (multi-stage, non-root, read-only rootfs),
    `deploy/compose.single.yml`, health checks. → `Dockerfile`, `.dockerignore`,
    `deploy/compose.single.yml`, `deploy/bin/`, `packages/mcp-server/src/healthcheck.ts`,
    `.github/workflows/check.yml`, [ADR 0017](adr/0017-container-image-and-compose.md),
    [installation.md](installation.md). Also done: base image pinned by multi-arch digest;
    production dependencies without lifecycle scripts; no npm, npx or corepack in the
    final image; UID 10001; `unifi-mcp` and `unifi-mcp-bridge` on the `PATH`; Compose with
    `read_only`, `cap_drop: ALL`, `no-new-privileges`, init, limits, hard lock on, MCP
    port on host loopback only and the admin port commented out; bridge from the image;
    basic CI (check job and image smoke job, actions pinned by SHA). Verified with a local
    Compose smoke test (health, read-only root, no capabilities, CLI via exec, rotation
    refused while running, bridge relay, clean stop, offline `db check`); the CI image job
    script was run locally, the workflow itself has not run on GitHub yet. Tests:
    `tests/contract/packaging.test.ts`, `tests/integration-mock/healthcheck.test.ts`.
    `linux/arm64` (2026-11-10, under QEMU emulation, ADR 0017): the image builds and the
    storage tests pass (63 of 63). The full suite passes 573 of 582 with the default
    limits; the other 9 pass with longer ones. The service and CLI from the image start
    only with `--wasm-enforce-bounds-checks`, because Node.js's WebAssembly type stripper
    fails under emulation. With that flag, the smoke test passes.
    Still open: a run on arm64 hardware (or a native arm64 CI runner, Phase 5);
    dual-network and TLS Compose examples (Phase 5); registry publishing, SBOM and signing
    (Phase 5).
12. **Docs** (in progress): quickstart, installation, configuration, security, approval
    workflow, administration, client guides.
    Done (2026-11-10): [quickstart.md](quickstart.md), [installation.md](installation.md),
    [configuration.md](configuration.md), [security.md](security.md),
    [approval-workflow.md](approval-workflow.md), [administration.md](administration.md),
    [client-generic-mcp.md](client-generic-mcp.md); a link checker
    (`tests/contract/doc-links.test.ts`) for every relative link and heading anchor;
    [client-claude-code.md](client-claude-code.md), verified with Claude Code 2.1.322 in a
    separate configuration (HTTP with a `${…}` header reference, and the stdio bridge;
    `claude mcp list` connected, negotiated `2026-07-28` and fetched the tool list);
    [troubleshooting.md](troubleshooting.md), with the refusals and messages checked
    against the running image and bridge. Found while doing so: the plaintext refusal was
    partly redacted in the log (`Bearer [REDACTED]`); reworded, and a test now requires
    startup refusals to survive redaction.
    Open: `client-codex.md`. Codex 0.161.0 offers `codex mcp add` with `--url`
    and `--bearer-token-env-var`, and stdio servers with `--env`; the owner will try it before
    the guide is written. Using the tools inside a Claude Code session has not been
    checked yet (it needs a model session).

### Gate (spec §16)

- [x] 2025-era and 2026-era MCP clients connect over Streamable HTTP and stdio
      (`tests/integration-mock/mcp-http.test.ts`, `tests/integration-mock/stdio-bridge.test.ts`)
- [x] Two differently scoped tokens see different tool lists; revocation blocks calls and subscriptions
      (`tests/integration-mock/mcp-http.test.ts`: different tools; next call refused; open
      responses, including listen streams, closed; also for revocations made with the CLI
      in another process: `tests/integration-mock/cli-beside-service.test.ts`)
- [x] No configured console: safe start, no write tools (`tests/integration-mock/mcp-http.test.ts`)
- [x] Hard lock denies registered writes via `unifi_execute`, queued work and previously approved actions
      (`tests/integration-mock/mcp-http.test.ts`, `tests/security/dispatcher-gates.test.ts`,
      `tests/security/approval-gates.test.ts`)
- [x] Generic execution cannot reach an unregistered path, alternate URL or arbitrary verb
      (`tests/security/dispatcher-gates.test.ts`, `tests/security/unifi-transport-gates.test.ts`;
      `unifi_execute` has a strict schema and calls the same dispatcher)
- [x] High-risk action requires independent CLI/UI approval and cannot be approved via MCP
      (not via MCP: `tests/integration-mock/mcp-http.test.ts`,
      `tests/security/approval-gates.test.ts`; CLI approval end to end, MCP request →
      interactive `approvals approve` in another process → single MCP resume:
      `tests/integration-mock/cli-beside-service.test.ts`,
      `tests/security/cli-invariants.test.ts`; the admin UI approval page is step 10 and
      gets its own tests there)
- [x] Reused, expired, parameter-changed, wrong-client and policy-changed approvals all fail
      (`tests/security/approval-gates.test.ts`; reuse also through the MCP resume tool)
- [x] Wrong or missing master key and failed migration fail closed; migrations and backups tested
      (`tests/security/storage-master-key.test.ts`, `tests/unit/storage/`; the service entry
      point exits 1 with `MASTER_KEY_NOT_CONFIGURED` when no key is configured)
- [x] stdio bridge has no UniFi key or DB access and writes nothing to stdout except protocol frames
      (`tests/security/stdio-bridge-isolation.test.ts`, `tests/integration-mock/stdio-bridge.test.ts`)
- [x] Admin interface is local-only by default; MCP and admin listeners use separate auth and ports
      (`tests/integration-mock/admin-http.test.ts`: off unless enabled, loopback default,
      separate port, MCP tokens refused on admin and admin cookies refused on MCP;
      `tests/unit/mcp-server/clients.test.ts`: same port and remote plaintext refused)

## Phase 2 — UniFi Network ✅ (gate passed 2026-11-11)

All gate items below are met. Carried forward: the optional manual write runbook on a real
console (owner's choice, never required); the 17 reads that had nothing to read or
returned empty lists on the test console, and `network.networks.get_references`, which
the console fails for networks in use (documented limitation), are not live-validated; the Phase 1 carry-forwards (Codex guide, arm64
hardware, Phase 5 items).

Baseline: Network Integration API v11.0.97 (73 operations: 41 reads, 32 writes),
`api-specs/network/11.0.97/`.

### Implementation order (plan)

1. ✅ **Schema generator** (2026-11-10): OpenAPI 3.1 → zod code in
   `packages/unifi-network/src/generated/`, strict for requests, tolerant of added fields
   for responses, no vendor prose copied (ADR 0006 item 6). `api:reconcile` fails when the
   generated file is stale. → `scripts/generate-adapter-schemas.ts`,
   `scripts/lib/openapi-zod.ts`, [ADR 0018](adr/0018-network-adapter.md). Tests:
   `tests/unit/scripts/openapi-zod.test.ts`, `tests/contract/network-generated-schemas.test.ts`.
   Reviewed deviation: the device-tag `filter` (an object schema for a query string) is
   left out.
2. ✅ **Core contract additions** (2026-11-10): JSON bodies travel as one `body` argument
   (several Network bodies are discriminated unions); a pagination hook for page
   responses; `version_unknown` for unprobed consoles and an `operation_unsupported`
   message that names the observed version and the verified range (ADR 0018 §2).
3. ✅ **Version probe** (2026-11-10): `GET /v1/info` through the reviewed
   `network.info.get`; a service monitor (start, every 30 s for unknown versions, 6-hour
   refresh, backoff, `console_versions` health check); `unifi-mcp console probe`; supported
   range `>=11.0.97 <12` (ADR 0018 §3). First Network operation registered at startup.
4. ✅ **Reads** (41, 2026-11-10): reviewed security metadata (`network.<category>.read`,
   low risk; client reads tagged `personal_identifier` and `network_identity`), credential
   removal at any depth (Wi-Fi `passphrase`, voucher `code`), page results split into
   `data` and `pagination`, named tools `network_list_sites|devices|clients|networks` and
   `network_get_device`. Every read tested end to end against the synthetic console for
   every response variant, with credential and undocumented-field sentinels
   (`tests/integration-mock/network-reads.test.ts`); the review table is pinned in
   `tests/contract/network-security-review.test.ts`;
   [applications-network.md](applications-network.md) (ADR 0018 §4).
5. ✅ **Writes** (32, 2026-11-10): 27 high risk with human approval, 5 medium; device
   removal and bulk voucher deletion off by default; site-level locks per kind; every
   write tested against the synthetic console for every body variant (approval, single
   resume, exact body, no credential in audit, logs, approval summaries or results;
   refusal under read-only grants, hard lock and read-only module; idempotency;
   `outcome_unknown`) in `tests/integration-mock/network-writes.test.ts` (ADR 0018 §5).
6. ✅ **Coverage** (2026-11-10): the matrix derives status, reviewed metadata and test
   evidence from the registered adapters (`packages/mcp-server/src/adapters.ts`);
   `api:reconcile` check 7 and `tests/contract/api-coverage-matrix.test.ts` fail on drift;
   `unifi-mcp api coverage` counts implemented operations (ADR 0018 §6).
7. ✅ **Live read-only test and write runbook** (2026-11-10): `npm run test:live`
   (opt-in, never in CI), dry-run against the synthetic console; reviewed reports feed
   `liveReadValidation`; [runbook-network-writes.md](runbook-network-writes.md)
   (ADR 0018 §7). Run against a real console on 2026-11-11 (gate below).
8. ✅ **Docs** (2026-11-11): [applications-network.md](applications-network.md),
   [runbook-network-writes.md](runbook-network-writes.md), ADR 0018 §1–§7; updates to the
   client guides (body argument, paging, named tools, client-data grants), security,
   approval workflow (no concurrency precondition in the Network contract),
   administration, monitoring, troubleshooting, quickstart, index, README and the status
   notes.

### Gate (spec §16)

- [x] Every Network v11.0.97 operation in the coverage report with status and test evidence
      ([network/11.0.97.md](api-coverage/network/11.0.97.md): 73 of 73 implemented, evidence per operation)
- [x] Version probe; incompatible versions get a clear unsupported error with no guessed fallback
      (`tests/integration-mock/network-version-probe.test.ts`)
- [x] All documented reads mock-tested with sanitised output; writes tested for authz, approval and duplicates
      (`tests/integration-mock/network-reads.test.ts`, `tests/integration-mock/network-writes.test.ts`)
- [x] Optional live read-only test (console, site, device, client, network); no state-changing request
      Run 2026-11-11 against a console with Network 11.0.99, GET only
      ([record](api-coverage/live/network-11.0.97.json)): 33 reads matched the contract, 7
      had nothing to read, and `network.networks.get_references` fails in the console
      (HTTP 500 for four of five networks; a documented limitation). Refreshed 2026-11-12:
      23 reads returned data and matched, 10 returned empty lists (no longer counted as
      validated), 7 had nothing to read. The owner then checked the references of all 10
      networks by hand: HTTP 500 for every network used by clients or devices (the one
      without clients is assigned to switch ports); it worked for every network used only
      by a Wi-Fi broadcast, or by nothing. Assigning one unused switch port to an empty
      network that had answered made it fail too: a device reference alone is enough.
      Later the same day the owner's direct requests showed `network.networks.list`
      returning all 10 networks and `network.networks.get` answering for each of them,
      those in use included: only the references read fails, and reading a network never
      calls it (`tests/integration-mock/network-networks.test.ts`). The cause of the
      references failure is not known.
      `tests/contract/live-tests.test.ts` keeps the test opt-in and read-only.
- [x] Field shapes, pagination, filtering and errors compared against official docs
      Field shapes come from the official contract (generated schemas, strict requests,
      documented required fields enforced on responses), and 33 real responses matched.
      Errors pass on only the HTTP status and the documented `code`; real errors matched
      (HTTP 401 for a Site Manager key, HTTP 500 `api.unexpected-error`). Paging worked
      across two pages, and a documented filter was accepted.
- [x] Manual human-approved write runbook (not CI) ([runbook-network-writes.md](runbook-network-writes.md))
- [x] Resolve flagged unknowns: key scope across apps, read-only keys, filtering/pagination
      Key scope: a Network key also authorises Protect (checked against a random-key
      control). Read-only keys: none; the Create API Key dialog asks only for a name
      (Network 11.0.99). Filtering/pagination: checked live (above). Keys stay treated as
      console-wide administrator credentials (ADR 0005).

## Phase 3 — UniFi Protect ✅ (gate passed 2026-11-12)

All gate items below are met. Carried forward: device reads, the snapshot and device
events are not live-validated (the test console has no Protect devices); event resources
are not yet verified with Claude Code, and the Codex guide is still open (spec §17 client
versions); there is no operator status view of event connections (logs and resource
reads only; the admin interface and metrics, Phase 5); the 7.4.96 model update
subscription waits for an official release that documents it; the optional manual write
runbook on a real console (owner's choice); the Phase 1 and 2 carry-forwards.

Baselines: Protect integration API v7.3.74, the current official release (74 operations),
and v7.4.96, the newest documented (83 operations: 38 HTTP reads, 3 WebSocket
subscriptions, 42 writes), in `api-specs/protect/` ([ADR 0019](adr/0019-protect-adapter.md)).

### Implementation order (plan)

1. ✅ **Contract baseline** (2026-11-11): 7.4.96 replaces the Phase 0 record of 7.3.74 (a
   strict superset: 9 added, none removed, one documented 409 added). ADR 0019 §1.
2. ✅ **Schemas** (2026-11-11): the generator names operations from method and path,
   records transport and response type, returns `image/jpeg` as bytes, and translates
   `oneOf`/`anyOf`, `const`, nullable types, typed maps, `pattern` and the other
   constructs Protect uses → `packages/unifi-protect/src/generated/protect-7.4.96.ts`
   (82 operations). The multipart upload is a reviewed omission (its form field is not
   documented). ADR 0019 §2. Tests: `tests/unit/scripts/openapi-zod.test.ts`,
   `tests/contract/protect-generated-schemas.test.ts`.
3. ✅ **Binary content** (2026-11-11): `responseType: 'image/jpeg'` on GET reads; the
   executor checks the content type and the JPEG signature, the dispatcher returns the
   bytes as `media` (audited by the fact only), and MCP sends them as an `image` content
   block outside the JSON. ADR 0019 §3. Tests: `tests/unit/core/`,
   `tests/unit/unifi-api/executor.test.ts`, `tests/integration-mock/mcp-http.test.ts`.
   The `camera_image` grant comes with the snapshot in step 5.
4. ✅ **Adapter skeleton and version probe** (2026-11-11): `protectOperation`, the probe
   on `GET /v1/meta/info`, supported range `>=7.4.96 <8`, credential removal (`url`,
   `pin_code`), registered in `ADAPTERS`; [applications-protect.md](applications-protect.md)
   started. ADR 0019 §4. Tests: `tests/integration-mock/protect-version-probe.test.ts`,
   `tests/contract/protect-security-review.test.ts`, `tests/unit/unifi-protect/`.
5. ✅ **Reads** (2026-11-11): all 38 documented HTTP reads; `camera_image` (snapshot),
   `location` (fobs), `personal_identifier` (users); RTSPS stream URLs reduced to which
   qualities exist. ADR 0019 §5. Tests: `tests/integration-mock/protect-reads.test.ts`,
   `tests/contract/protect-security-review.test.ts`.
   6b. ✅ **Official release 7.3.74** (2026-11-11): the owner's console runs 7.3.74 and no
   update is offered. Both revisions kept; each operation built from the oldest revision
   that documents it (71 from 7.3.74, 8 from 7.4.96); `api:reconcile` check 8 proves the
   later differences additive. ADR 0019 §7. Tests: `tests/unit/scripts/revision-compat.test.ts`,
   `tests/integration-mock/protect-version-probe.test.ts`.
6. ✅ **Writes** (2026-11-11): 41 of 42 (the upload is the reviewed omission); 25 high
   with approval (alarm manager, anything that silences alarms or monitoring, physical
   actions), 16 medium; the permanent microphone disable and talkback off by default; PINs
   redacted. ADR 0019 §6. Tests: `tests/integration-mock/protect-writes.test.ts`.
7. ✅ **Events** (2026-11-12): WebSocket subscriptions over the same TLS and egress controls, a connection
   manager, MCP resources with `subscriptions/listen`, per-client filtering; tests for
   expiry, revocation, client and upstream disconnects, reconnect storms and slow
   consumers. ADR 0020.
   - 7a ✅ (2026-11-12): our own bounded, read-only WebSocket client over the verified
     socket; the UniFi event connector; event streams as reviewed registry entries;
     `StreamAccess`, the one authorisation point for streams and messages; the event hub
     (on demand, bounded buffer, gaps, opaque cursors, backoff with jitter, a global
     attempt limit, credential changes). Tests: `tests/unit/unifi-api/websocket.test.ts`,
     `tests/unit/unifi-api/events.test.ts`, `tests/unit/core/event-hub.test.ts`.
   - 7b ✅ (2026-11-12): event resources per client with cursors; `subscriptions/listen`
     filtered in the HTTP gate; one SDK handler per client; re-authorisation, lifetime,
     per-client limit and slow-consumer closing; service wiring; works through the stdio
     bridge; 2025-era clients read only. ADR 0020 §5. Tests:
     `tests/integration-mock/events.test.ts`, `tests/unit/mcp-server/event-uris.test.ts`.
   - 7c ✅ (2026-11-12): the Protect event and device streams with their security review
     (identity events need `personal_identifier` and `biometric_or_access_identity`; device
     changes need the grants of the read for that device); bulk device messages tried first
     (the contract makes them a superset); a scan of every generated union for shadowed
     branches; coverage 73/74 (7.3.74) and 81/83 (7.4.96). ADR 0020 §6. Tests:
     `tests/contract/protect-streams.test.ts`, `tests/integration-mock/protect-events.test.ts`.
8. ✅ **Coverage, live read-only test and write runbook** (2026-11-12). Live test:
   `tests/integration-live-readonly/protect.test.ts` runs every Protect read the console's
   version supports, an optional snapshot, and a WebSocket upgrade probe (key and random
   key) of `/v1/subscribe/events`; the guard and helpers are shared with Network
   (`shared.ts`). Dry-run against the synthetic console (now Network and Protect).
   Owner's run (2026-11-12, Protect 7.3.74, no devices): 19 of 20 reads matched; events
   authenticate with the API key (101 with it, 401 with a random key); `GET /v1/nvrs` left
   out the required `armMode.armProfileId`, now a reviewed exception in the generator
   (`optionalResponseProperties`). Empty lists are recorded as `ok (empty)` and no longer
   count as validated. ADR 0019 §8. Rerun (2026-11-12): all 20 reads matched,
   `protect.nvrs.list` included; 5 count as validated (NVRs and the four user reads), 15
   lists were empty. The same run refreshed the Network record (23 validated, 10 empty,
   `get_references` still failing in the console). Coverage: the matrix lists every
   operation with its status, reviewed metadata and test evidence, and marks the 5 reads
   with live data. Write runbook: [runbook-protect-writes.md](runbook-protect-writes.md),
   manual and approved step by step (an arm profile created, renamed, refused and deleted
   without devices; device renames and RTSPS streams with devices).
   `tests/contract/runbooks.test.ts` checks that both runbooks name registered operations
   with their reviewed risk and only existing CLI commands and options.
9. ✅ **Docs** (2026-11-12): [events.md](events.md), the manual page for events (spec §18
   item 10): what is available and which grants each event needs, how 2026- and 2025-era
   clients get events, the read format and cursors, what is and is not guaranteed,
   reconnects and console changes, subscription limits, states and codes, logs and audit,
   troubleshooting. Linked from the Protect page, the client guides, networking (proxies
   must keep subscription streams open for an hour), monitoring, troubleshooting, the
   index and the README. Event resources with Claude Code are not verified yet (noted in
   `client-claude-code.md`). There is no operator status view of event connections yet
   (logs and resource reads only; metrics are Phase 5).
   `tests/contract/doc-commands.test.ts` checks every `unifi-mcp` command and option shown
   in the manual against the CLI (mutation-checked).

### Gate (spec §16)

Reviewed 2026-11-12 with `npm run check` (73 files, 1013 tests), `npm run api:reconcile`,
and the image smoke test of the CI job run locally (healthy with a read-only root and no
capabilities, `doctor` passes, `api coverage` lists Protect 73/74 and 81/83 from the image,
clean stop).

- [x] Same coverage and tests as Network
      Every operation of both revisions in the coverage report with status, reviewed
      metadata and test evidence ([protect/7.3.74.md](api-coverage/protect/7.3.74.md): 73 of
      74; [protect/7.4.96.md](api-coverage/protect/7.4.96.md): 81 of 83, the omissions
      reviewed). Version probe and supported range
      (`tests/integration-mock/protect-version-probe.test.ts`); all reads and writes
      mock-tested (`protect-reads.test.ts`, `protect-writes.test.ts`: authz, approval,
      idempotency, uncertain outcomes); field shapes from the official contract with one
      reviewed exception (ADR 0019 §8); optional live read-only test
      ([record](api-coverage/live/protect-7.3.74.json): 20 of 20 matched); manual write
      runbook ([runbook-protect-writes.md](runbook-protect-writes.md)). Flagged unknowns:
      how subscriptions authenticate was answered live (the API key, ADR 0019 §8); snapshot
      size and rate limits are undocumented and bounded by the service (a snapshot size
      limit, the request rate limits).
- [x] Permission-filtered image and event content
      Snapshots only with `camera_image`; people only with `personal_identifier`; fob
      presence only with `location` (`protect-reads.test.ts`, refused without sending
      anything). Each event is decided like a read: NFC and fingerprint events need the
      identity grants, device changes the grants of that device's read, decided again at
      subscription, notification and read; notifications reach only their own client
      (`tests/integration-mock/protect-events.test.ts`, `events.test.ts`,
      `tests/unit/core/event-hub.test.ts`; mutation-checked, ADR 0020).
- [x] Documented WebSocket subscriptions with event reconnection, disconnect and revocation
      Both 7.3.74 subscriptions, over the same egress and TLS controls as requests
      (`tests/unit/unifi-api/websocket.test.ts`, `events.test.ts`). Reconnect with backoff
      and gap markers, a global attempt limit against reconnect storms, reconnect on
      changed settings or keys, upstream drop; closing on client disconnect (upstream
      closed after the last client), revocation, withdrawn grants, lifetime and slow
      consumers (`tests/integration-mock/events.test.ts`, `event-hub.test.ts`). 2025-era
      clients get the documented degraded mode; the stdio bridge relays subscriptions.
- [x] Privacy and redaction
      Credentials removed from every result and event at any depth (talkback URLs, PINs,
      RTSPS URLs, which only report which qualities exist); arm-profile PINs never logged,
      audited, shown to approvers or returned; undocumented fields dropped; event content
      never logged (credential sentinels in every synthetic message,
      `protect-reads.test.ts`, `protect-writes.test.ts`, `protect-events.test.ts`). Live
      reports hold no names, ids or data (`tests/contract/api-coverage-matrix.test.ts`).
- [x] No undocumented video or stream endpoints
      Only inventoried operations can be registered (`tests/contract/module-endpoints.test.ts`,
      `protect-security-review.test.ts`); the contract documents no video download. RTSPS
      stream URLs and the talkback endpoint are never returned, and talkback is off by
      default. The 7.4.96 update subscription is not implemented (ADR 0020 §6).
- [x] High-consequence operations need independent approval
      25 high-risk writes with human approval (alarm manager, anything that silences
      alarms or monitoring, sirens, relays, alarm outputs); the permanent microphone
      disable and talkback off by default (`protect-writes.test.ts`, ADR 0019 §6). No MCP
      tool can approve (Phase 1).

### After the gate (2026-11-12)

- Fixed in the generator: a documented union variant that misses one of its own fields
  is refused (`upstream_contract_mismatch`) instead of being returned as the base object
  without that variant's fields; Network and Protect schemas regenerated (ADR 0018 §1).
  Contract mismatches and console errors are logged with field paths, HTTP status, the
  documented error code and request id (`docs/monitoring.md`, `docs/troubleshooting.md`).
- Networks in use (the owner's choice of recommendations 1–3): the references read's known
  failure is explained and not retried; network update and delete approvals carry a
  caution; the network delete is offered without `force` (ADR 0018, reviewed deviation).
  Open, owner's choice: a runbook check that the console refuses a delete without `force`
  of a network in use.
- **Next:** the owner reruns `npm run test:live` (Network, then Protect). The stricter
  schemas may now refuse a real response that used to pass without its variant's fields;
  the report names any such field. The Network run now reads the details and references
  of every network. Commit the refreshed records after review, then continue with Phase 4.

## Phase 4 — Access and other documented modules

- [ ] Verified installed-version contract (machine-readable if available), distinct auth and port
- [ ] Physical-access writes always high risk; sensitive events handled; negative tests
- [ ] Other applications: adapter scaffolds only, reported as `unavailable: official_local_api_not_documented`

## Phase 5 — Production and release hardening

- [ ] All §17 invariants pass; public-repo secret scan clean
- [ ] AMD64 and ARM64 images build and boot; single- and dual-network modes tested
- [ ] TLS pinning/CA, admin MFA, Prometheus metrics, backup/restore drills, SBOM, optional GHCR workflow
- [ ] Manual matches actual commands and UI
