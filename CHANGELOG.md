# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added — Phase 3 (in progress): UniFi Protect

- Protect contract baseline moved to v7.4.96 (83 operations; ADR 0019). The live
  read-only test also records the Protect version the console reports.
- `api:reconcile --write` derives the inventory of a new OpenAPI revision.
- Generated Protect 7.4.96 schemas (82 of 83 operations; the multipart upload with an
  undocumented form field is a reviewed omission). The generator gained path-based names,
  transport and response type, binary `image/jpeg` responses and more of JSON Schema
  (ADR 0019 §2).
- Fixed: two numeric bounds in a narrowed primitive became `NaN` in generated schemas.
- Binary reads: an operation can return documented `image/jpeg` content, checked by media
  type and signature, delivered as an MCP `image` content block and never stored in the
  audit trail (ADR 0019 §3).
- Protect adapter skeleton: version probe (`protect.info.get`), supported range
  `>=7.4.96 <8`, credential removal, `docs/applications-protect.md` (ADR 0019 §4).
- All 38 documented Protect reads, with `camera_image`, `location` and
  `personal_identifier` grants where needed; RTSPS stream URLs are never returned
  (ADR 0019 §5).
- Opt-in live read-only test for Protect (`npm run test:live`): every read the console's
  version supports, an optional snapshot, and a WebSocket authentication probe.
- Protect 7.3.74, the current official release, is supported: operations are built from
  the oldest revision that documents them, and `api:reconcile` checks that later revisions
  only add (ADR 0019 §7).
- 41 Protect writes: 25 high risk with human approval (alarm manager, anything that
  silences alarms or monitoring, sirens, relays, alarm outputs), 16 medium; the permanent
  microphone disable and talkback are off by default (ADR 0019 §6).
- Live evidence from a Protect 7.3.74 console (ADR 0019 §8): event subscriptions accept
  the API key; `protect.nvrs.list` accepts an NVR whose `armMode` leaves out
  `armProfileId`, a reviewed exception (`optionalResponseProperties` in the generator). A
  live list that returns no items is recorded as `ok (empty)` and not counted as
  validated. Mismatch reports name the received type (`received undefined`).
- Fixed: the coverage page of every module named its live record "Network".
- Manual page for events (`docs/events.md`): available streams and grants, client
  protocol eras, the read format, guarantees, reconnects, limits, states and codes, logs
  and troubleshooting; linked across the manual. A contract test checks every
  `unifi-mcp` command and option shown in the manual against the CLI.
- Manual Protect write runbook (`docs/runbook-protect-writes.md`): an arm profile
  created, renamed, refused and deleted with approvals (no devices needed), then device
  renames and RTSPS streams. A contract test keeps both runbooks in line with the
  registered operations, their risk and the CLI.
- Live records refreshed by the owner's run (2026-11-12): Protect 7.3.74, all 20 reads
  matched (5 with data, 15 empty lists); Network 11.0.99, 23 reads with data matched, 10
  empty lists are no longer counted as validated, and `get_references` still fails in the
  console.
- Network limitation narrowed: the console fails `network.networks.get_references` (HTTP 500) for every network with clients or devices and for one empty network, and answers
  for empty networks and those with only a Wi-Fi broadcast; the cause is not known.
- Event subscriptions, part 1 (ADR 0020): a bounded, read-only WebSocket client over the
  verified TLS socket, the event connector, event streams as reviewed registry entries,
  one authorisation point for streams and each message, and an on-demand event hub with a
  bounded buffer, gap markers, opaque cursors, backoff and a global connection-attempt
  limit.
- Event subscriptions, part 2: event streams as MCP resources (with cursors) and
  `subscriptions/listen` for 2026-era clients, filtered per client in the HTTP gate; one
  SDK handler per client so notifications reach only their own client; subscriptions
  closed on revocation, withdrawn grants, after one hour and for slow consumers; works
  through the stdio bridge.
- Protect event streams: `unifi://consoles/<id>/protect/events` (identity events need
  `personal_identifier` and `biometric_or_access_identity`) and `…/protect/devices`
  (each change needs the grants of the read for that device). Bulk device messages keep
  their ids and fields. Coverage: 73 of 74 (7.3.74), 81 of 83 (7.4.96).

### Added — Phase 2: UniFi Network (gate passed 2026-11-11)

- OpenAPI → zod schema generator (`scripts/generate-adapter-schemas.ts`, ADR 0018): strict
  request schemas, response schemas that strip undocumented fields, discriminated unions
  with JSON Schema semantics, and no vendor prose. Generated Network 11.0.97 schemas in
  `packages/unifi-network/src/generated/`; `api:reconcile` fails when they are stale.
- Opt-in live read-only test (`npm run test:live`, never in CI) and a manual write runbook
  (ADR 0018 §7).
- The live test names why a read failed and, for a contract mismatch, which fields
  (never their values). It creates the report folder. It checks the references of up to
  five networks, checks Protect key scope against a random-key control, and checks paging
  past the first page on the first list with two or more items.
- Network limitation documented: on Network 11.0.99 the console fails
  `network.networks.get_references` for most networks (HTTP 500).
- First real-console record (`docs/api-coverage/live/network-11.0.97.json`, Network
  11.0.99): 33 reads live-validated in the coverage matrix. A Network API key also
  authorises Protect (ADR 0005, security model, threat model), and the key dialog offers
  no scoped or read-only keys.
- Quickstart and troubleshooting: the API key must be created on the console; a Site
  Manager key from unifi.ui.com is rejected.
- Manual pages updated for Phase 2: status notes, Claude Code guide (named tools,
  client-data grants), approval workflow (the Network contract has no concurrency
  precondition), troubleshooting.
- Coverage matrix from the registered adapters (ADR 0018 §6): status, reviewed metadata
  and test evidence per operation; reconciliation and an offline test fail on drift;
  `unifi-mcp api coverage` counts implemented operations.
- All 32 documented Network writes (ADR 0018 §5): ACL rules, firewall policies and zones,
  networks, Wi-Fi broadcasts, DNS policies, traffic matching lists, device adoption,
  removal, restart and port power-cycle, client guest access, hotspot vouchers. 27 are
  high risk and need human approval; device removal and bulk voucher deletion are off by
  default.
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
