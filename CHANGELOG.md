# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added — Phase 1 (in progress): secure platform core

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
- Operator manual: `docs/configuration.md` (hard lock, data directory, logging, master
  key), `docs/security.md` (permission model, write safety), `docs/backup-restore.md` and
  `docs/monitoring.md`.

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
