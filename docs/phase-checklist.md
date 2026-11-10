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

## Phase 1 — Secure platform core (next)

### Implementation order (plan)

1. **storage**: `node:sqlite` port (ADR 0004), migrations in transactions, AEAD secret
   records with key id, master-key loading that fails closed, backup and integrity check.
2. **telemetry**: JSON logger with redaction, audit writer (fails safe on storage
   exhaustion), liveness/readiness.
3. **policy**: evaluation order §6.1, deployment hard lock, runtime mode, scope
   intersection, default deny for writes and sensitive reads.
4. **core**: `OperationDescriptor` registry, central dispatcher (checks at enqueue _and_
   dispatch), bounded queues, rate limits, resource locks, durable operation IDs.
5. **approvals**: prepare → pending → approved → resumed/executed state machine with
   atomic compare-and-set transitions, TTLs and argument digests.
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
- [ ] Generic execution cannot reach an unregistered path, alternate URL or arbitrary verb
- [ ] High-risk action requires independent CLI/UI approval and cannot be approved via MCP
- [ ] Reused, expired, parameter-changed, wrong-client and policy-changed approvals all fail
- [ ] Wrong or missing master key and failed migration fail closed; migrations and backups tested
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
