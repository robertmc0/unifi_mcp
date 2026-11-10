# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added — Phase 2 (in progress): UniFi Network

- OpenAPI → zod schema generator (`scripts/generate-adapter-schemas.ts`, ADR 0018): strict
  request schemas, response schemas that strip undocumented fields, discriminated unions
  with JSON Schema semantics, and no vendor prose. Generated Network 11.0.97 schemas in
  `packages/unifi-network/src/generated/`; `api:reconcile` fails when they are stale.
- All 41 documented Network reads (ADR 0018 §4): sites, devices, statistics, pending
  devices, device tags, clients (sensitive grants required), networks, Wi-Fi broadcasts,
  firewall policies and zones, ACL rules, DNS policies, hotspot vouchers, switching, traffic
  matching lists, VPN, WANs, RADIUS profiles and reference data. Wi-Fi passphrases and
  voucher codes are never returned; lists return `data` and `pagination`; named tools
  `network_list_sites`, `network_list_devices`, `network_get_device`,
  `network_list_clients`, `network_list_networks`. `docs/applications-network.md`.
- Console version probes (ADR 0018 §3): the service learns each enabled module's
  application version by itself (`GET /v1/info` for Network), refreshes it every 6 hours,
  backs off on failure and reports it in the `console_versions` health check;
  `unifi-mcp console probe`. A changed version invalidates pending approvals. Network
  operations accept `>=11.0.97 <12`. First Network operation: `network.info.get`.
- Operations with a request body take it as one `body` argument; list results carry
  `pagination`; an unprobed console version is refused as `version_unknown`, and an
  incompatible one names the observed version and the verified range.

### Added — Phase 1: secure platform core

- Storage (`packages/storage`, ADR 0007): `node:sqlite` port with hardened connection
  settings and owner-only files; atomic, checksummed schema migrations; AES-256-GCM
  secret records bound to their kind and id; master key from a file or environment
  variable that fails closed when missing or wrong and is never generated implicitly;
  verified master key rotation; verified online backups, backup verification and
  validated offline restore; automatic pre-migration backups.
- Telemetry (`packages/telemetry`, ADR 0008): structured JSON logger with mandatory
  redaction; persistent, hash-chained, update-proof audit trail that fails safe when it
  cannot be written; liveness/readiness checks with a public endpoint handler that reveals
  only the overall status.
- Policy (`packages/policy`, ADR 0009): pure permission evaluation in the order of spec
  §6.1 with deny-wins, deployment hard lock (`UNIFI_MCP_FORCE_READ_ONLY`, locked when
  unset), runtime mode, layered rules by intersection with explicit client grants, default
  deny for writes and sensitive reads, credentials never released, raise-only risk
  elevation, and a versioned, audited global policy store.
- Core (`packages/core`, ADR 0010): operation registry that admits only operations in the
  official vendor contract, with strict schemas and segment-encoded paths; the single
  dispatcher with policy checks at enqueue and dispatch, audit before act, durable write
  executions with compare-and-set transitions, `outcome_unknown` without retry,
  idempotency keys, restart recovery, rate limits, bounded fair queues and resource locks.
- Approvals (`packages/approvals`, ADR 0011): human approval of high-risk operations by an
  administrator or the local CLI only, bound to client, target, argument digest and policy
  version, with encrypted stored arguments, time windows, single-use resumption through
  the dispatcher and a complete audit trail.
- Redaction now also covers PSK, pre-shared key, passkey and further `<qualifier> key`
  field names.
- UniFi transport (`packages/unifi-api`, ADR 0012): console registry with encrypted,
  write-only credentials; egress allowlist with DNS re-validation; TLS verification with
  custom CA, SPKI pinning or an explicit audited insecure override, checked before any
  request byte is sent; fixed requests from reviewed descriptors; redirects refused;
  response size caps; error mapping that never passes upstream text through; capability
  from observed application versions.
- MCP server (`packages/mcp-server`, ADR 0013): per-client bearer tokens stored as digests
  with rotation and immediate revocation (closing open streams); the `/mcp` gate with Host
  and Origin allowlists, failed-authentication throttling and plaintext refusal on
  non-loopback binds; per-client tool discovery with private, non-cacheable tool lists;
  `unifi_list_consoles`, `unifi_list_modules`, `unifi_list_operations`,
  `unifi_describe_operation`, `unifi_execute`, named tools, `unifi_get_operation_status`
  and `unifi_resume_approved`; health endpoints; service startup, shutdown and `main.ts`.
- stdio bridge (`packages/stdio-bridge`, ADR 0014): a local stdio MCP server that relays
  messages unchanged to the service over authenticated Streamable HTTP for 2025-era and
  2026-era clients; holds one client token and nothing else; stdout carries protocol
  frames only; refuses remote plaintext and redirects; clear exit codes.
- Host administration CLI (`packages/cli`, ADR 0015): `unifi-mcp` with `admin`, `client`,
  `console`, `policy`, `approvals`, `config`, `crypto`, `db`, `audit`, `doctor` and
  `api coverage` commands; `--json` output and stable exit codes; secrets only from
  files or hidden prompts; interactive-only approval with a typed confirmation;
  terminal-safe output that escapes control, escape-sequence and bidirectional
  characters; `--dry-run` for permission changes; a declarative YAML bootstrap file
  (`config import|apply`, one transaction, idempotent, never deletes, credentials only by
  file reference) with `deploy/example-bootstrap.yaml`; `console check` that shows the
  certificate pin without sending a request.
- Administrator accounts (`packages/admin-api`, storage migration 8): Argon2id password
  hashes from `node:crypto`, first-administrator bootstrap and password recovery from the
  CLI only, constant-time verification.
- One service per data directory: an exclusive lock that the operating system releases
  when the holder exits; master key rotation and restore are refused while the service
  runs. The rotation and its audit entry now commit together.
- Open MCP responses are re-checked every 5 seconds, so revocations, rotations and
  disabled clients from the CLI (another process) also close streams in the running
  service.
- Admin web interface (`packages/admin-api`, `packages/admin-ui`, storage migration 9,
  ADR 0016): optional separate listener (off by default, loopback, own port, certificate
  and Host allowlist); password sign-in with throttling; `__Host-` Secure, HttpOnly,
  SameSite=Strict session cookies stored as digests, with idle and absolute limits;
  same-origin and CSRF checks on every form; server-rendered pages without JavaScript under
  a strict CSP; dashboard, approvals (password required for every approval) and audit
  pages. `admin reset-password` now ends the account's web sessions.
- Control, C1 and bidirectional characters are shown escaped in the CLI and the admin
  pages (shared `displaySafe` in core), and a repository test refuses raw ones in sources.
- Container image (`Dockerfile`, ADR 0017): digest-pinned Node.js 26 base, production
  dependencies installed without lifecycle scripts, no package managers in the final
  image, non-root user, read-only-root friendly, `HEALTHCHECK` on `/livez`, and the
  `unifi-mcp` CLI and `unifi-mcp-bridge` on the `PATH`.
- `deploy/compose.single.yml`: read-only, no capabilities, `no-new-privileges`, hard lock
  on, MCP port on host loopback only, admin interface off with its port unpublished.
- A documentation link checker: every relative link and heading anchor must resolve.
- Client guide for Claude Code (`docs/client-claude-code.md`), verified with Claude Code
  2.1.322 over the stdio bridge and over HTTP with a `${…}` header reference; a
  troubleshooting guide (`docs/troubleshooting.md`).
- The image also builds for `linux/arm64`. It is tested under QEMU emulation only, where
  the service needs a V8 flag to start (ADR 0017).
- The plaintext-HTTP refusal is now readable in the runtime log (it was partly redacted),
  and a test requires startup refusals to survive log redaction.
- Basic CI (`.github/workflows/check.yml`): format, lint, typecheck, tests, contract
  reconciliation, and an image build with a read-only smoke run; actions pinned by
  commit SHA.
- Operator manual: `docs/quickstart.md`, `docs/installation.md`, `docs/administration.md`; `docs/configuration.md` (hard lock, MCP listener, audit retention,
  egress allowlist, data directory, logging, master key), `docs/networking.md`,
  `docs/client-generic-mcp.md`, `docs/security.md` (permission model, write safety, console
  connections), `docs/approval-workflow.md`,
  `docs/backup-restore.md` and `docs/monitoring.md`.

### Added — Phase 0: research and contract baseline

- Repository skeleton: npm workspaces (14 private packages), strict TypeScript 6, ESLint,
  Prettier, Vitest; pinned toolchain on Node.js 26 LTS.
- API contract baseline for UniFi Network 11.0.97 (73 operations), Protect 7.3.74 (74) and
  Access API reference 2026-03-23 (107), with provenance, checksums and local base URLs.
- API tooling: `api:fetch-specs` (checksum-verified download), `api:reconcile` (drift
  detection), `api:coverage-report` (coverage matrix).
- ADRs 0001–0006, threat-model notes, phase plan and checklist.
- Contract tests for the MCP TypeScript SDK v2 (2025-era and 2026-07-28 clients) and for
  the API inventory invariants.
