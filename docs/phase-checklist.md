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

- Dockerfile and Compose examples → Phase 1 (§16 Phase 1 "safe Docker examples").
- CI workflows (`.github/`) → Phase 1 adds a basic check workflow; Phase 5 adds the
  security and supply-chain jobs.
- Operator manual pages other than `docs/index.md` → written alongside Phase 1 features.

## Phase 1 — Secure platform core (in progress)

### Implementation order (plan)

1. ✅ **storage** (2026-11-10): `node:sqlite` port (ADR 0004), migrations in transactions, AEAD secret
   records with key id, master-key loading that fails closed, backup and integrity check.
   → `packages/storage`, [ADR 0007](adr/0007-storage-encryption-migrations-backups.md),
   [configuration.md](configuration.md), [backup-restore.md](backup-restore.md). Also done:
   verified key rotation, backup verification, validated offline restore, automatic
   pre-migration backups. Tests: `tests/unit/storage/`, `tests/security/storage-master-key.test.ts`.
   Still open, carried into later steps: `linux/arm64` run of the storage tests (step 11);
   CLI `crypto generate-key|rotate-key` and `db backup|restore|check` (step 9); retention
   of automatic backups; single-instance guard per data directory (step 7).
2. ✅ **telemetry** (2026-11-10): JSON logger with redaction, audit writer (fails safe on storage
   exhaustion), liveness/readiness. → `packages/telemetry`, storage migration 2
   (`audit_entries`), [ADR 0008](adr/0008-telemetry-logging-audit-health.md),
   [monitoring.md](monitoring.md). Also done: hash-chained, update-proof audit entries with
   audited pruning and chain verification; readiness recovery probe; disk space check.
   Tests: `tests/unit/telemetry/`, `tests/security/telemetry-redaction.test.ts`.
   Still open, carried into later steps: mounting `/livez` and `/readyz` and a Docker
   `HEALTHCHECK` (steps 7 and 11); token string pattern in redaction once the token format
   exists (step 7); audit-before-act wiring in the dispatcher (step 4); retention setting
   and scheduled pruning, CLI audit and chain-verification commands (step 9).
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
   and YAML import (step 9).
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
   `approvals list|show|approve|reject` (step 9); admin UI page with recent-auth and MFA
   (step 10); periodic `expireStale()` in the service (step 7); console-state diff and
   preconditions (Phase 2).
6. **unifi-api**: HTTPS client with TLS verify, CA and pinning, egress allowlist, DNS
   re-validation, redirects refused, timeouts and size caps. Synthetic mock console server
   for tests.
7. **mcp-server**: bearer gate and Host/Origin allowlist in front of `createMcpHandler`;
   per-client tool factory; `unifi_list_consoles`, `unifi_list_sites` (stub until Phase 2),
   `unifi_list_modules`, `unifi_list_operations`, `unifi_describe_operation`,
   `unifi_execute`, `unifi_get_operation_status`, resume.
8. **stdio-bridge**: spike and decide the transport-relay design (ADR 0003, Proposed).
9. **cli**: `admin bootstrap/reset-*`, `client`, `console`, `policy`, `approvals`,
   `config`, `crypto`, `db`, `doctor`, `api coverage`.
10. **admin-api / admin-ui**: separate listener (loopback default), sessions, CSRF,
    approvals page.
11. **Packaging**: Dockerfile (multi-stage, non-root, read-only rootfs), `deploy/compose.single.yml`,
    health checks.
12. **Docs**: quickstart, installation, configuration, security, approval workflow,
    administration, client guides.

### Gate (spec §16)

- [ ] 2025-era and 2026-era MCP clients connect over Streamable HTTP and stdio
- [ ] Two differently scoped tokens see different tool lists; revocation blocks calls and subscriptions
- [ ] No configured console: safe start, no write tools
- [ ] Hard lock denies registered writes via `unifi_execute`, queued work and previously approved actions
      (dispatcher verified for direct, queued and previously approved writes; the MCP tool in
      step 7)
- [ ] Generic execution cannot reach an unregistered path, alternate URL or arbitrary verb
      (dispatcher and registry verified by `tests/security/dispatcher-gates.test.ts`; still to
      verify through the MCP `unifi_execute` tool and the HTTP executor in steps 6–7)
- [ ] High-risk action requires independent CLI/UI approval and cannot be approved via MCP
      (approval service and dispatcher verified by `tests/security/approval-gates.test.ts`;
      the MCP tool list is verified in step 7, CLI/UI approval paths in steps 9–10)
- [ ] Reused, expired, parameter-changed, wrong-client and policy-changed approvals all fail
      (all five verified in `tests/security/approval-gates.test.ts` at the dispatcher; to be
      repeated through the MCP resume tool in step 7)
- [ ] Wrong or missing master key and failed migration fail closed; migrations and backups tested
      (storage layer verified by `tests/security/storage-master-key.test.ts` and
      `tests/unit/storage/`; still to verify at service startup once step 7 exists)
- [ ] stdio bridge has no UniFi key or DB access and writes nothing to stdout except protocol frames
- [ ] Admin interface is local-only by default; MCP and admin listeners use separate auth and ports

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
