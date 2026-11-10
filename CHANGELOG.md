# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
