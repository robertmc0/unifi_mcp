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

## Phase 1 — Secure platform core (in progress)

### Implementation order (plan)

1. ✅ **storage** (2026-11-10): `node:sqlite` port (ADR 0004), migrations in transactions, AEAD secret
   records with key id, master-key loading that fails closed, backup and integrity check.
   → `packages/storage`, [ADR 0007](adr/0007-storage-encryption-migrations-backups.md),
   [configuration.md](configuration.md), [backup-restore.md](backup-restore.md). Also done:
   verified key rotation, backup verification, validated offline restore, automatic
   pre-migration backups. Tests: `tests/unit/storage/`, `tests/security/storage-master-key.test.ts`.
   Still open, carried into later steps: `linux/arm64` run of the storage tests (still open
   after step 11: needs arm64 emulation on the build host, which needs the owner's consent);
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
    Still open: `linux/arm64` build and storage tests (needs binfmt/QEMU on the build
    host: the owner's decision); dual-network and TLS Compose examples (Phase 5);
    registry publishing, SBOM and signing (Phase 5).
12. **Docs** (in progress): quickstart, installation, configuration, security, approval
    workflow, administration, client guides.
    Done (2026-11-10): [quickstart.md](quickstart.md), [installation.md](installation.md),
    [configuration.md](configuration.md), [security.md](security.md),
    [approval-workflow.md](approval-workflow.md), [administration.md](administration.md),
    [client-generic-mcp.md](client-generic-mcp.md); a link checker
    (`tests/contract/doc-links.test.ts`) for every relative link and heading anchor.
    Open: `client-claude-code.md` and `client-codex.md`, which must be verified against the
    current releases of those clients before they are published; `troubleshooting.md`.

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

## Phase 2 — UniFi Network

- [ ] Every Network v11.0.97 operation in the coverage report with status and test evidence
- [ ] Version probe; incompatible versions get a clear unsupported error with no guessed fallback
- [ ] All documented reads mock-tested with sanitised output; writes tested for authz, approval and duplicates
- [ ] Optional live read-only test (console, site, device, client, network); no state-changing request
- [ ] Field shapes, pagination, filtering and errors compared against official docs
- [ ] Manual human-approved write runbook (not CI)
- [ ] Resolve flagged unknowns: key scope across apps, read-only keys, filtering/pagination

## Phase 3 — UniFi Protect

- [ ] Same coverage and tests as Network
- [ ] Permission-filtered image/event content; documented WebSocket subscriptions; reconnect, disconnect and revocation
- [ ] No undocumented video or stream endpoints; high-consequence operations need approval

## Phase 4 — Access and other documented modules

- [ ] Verified installed-version contract (machine-readable if available), distinct auth and port
- [ ] Physical-access writes always high risk; sensitive events handled; negative tests
- [ ] Other applications: adapter scaffolds only, reported as `unavailable: official_local_api_not_documented`

## Phase 5 — Production and release hardening

- [ ] All §17 invariants pass; public-repo secret scan clean
- [ ] AMD64 and ARM64 images build and boot; single- and dual-network modes tested
- [ ] TLS pinning/CA, admin MFA, Prometheus metrics, backup/restore drills, SBOM, optional GHCR workflow
- [ ] Manual matches actual commands and UI
