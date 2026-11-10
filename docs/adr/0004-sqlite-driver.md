# 0004. SQLite driver: built-in `node:sqlite` behind a storage port

- Status: Accepted. Re-evaluate at the Phase 1 exit review.
- Date: 2026-11-10
- Phase: 0
- Spec references: §2 (decision 15), §8.2, §14 ("SQLite native module compatibility…")

## Context

Persistence is embedded SQLite in a Docker volume, with one central writer. Spec §14 warns
that native SQLite modules must be tested on both CPU architectures, and that prebuilt
binaries must never be fetched from untrusted URLs. It explicitly allows "a supported
runtime SQLite solution with reproducible packaging".

Options:

|                                  | `node:sqlite` (built in)                                                                                                    | `better-sqlite3@13.0.3`                                                               |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Native build / prebuild download | None, part of the Node binary                                                                                               | Native addon; install-time prebuild download or compiler toolchain in the build stage |
| AMD64/ARM64 parity               | Same as Node itself                                                                                                         | Must be built and tested per architecture                                             |
| Supply chain                     | Node release process                                                                                                        | Extra package plus native code                                                        |
| Stability                        | **1.2 Release candidate** in Node 26 docs, no flag needed since 22.13/23.4, RC since 25.7.0                                 | Mature, stable API                                                                    |
| SQLite version                   | 3.54.0 in Node 26.13.0, updated with Node security releases                                                                 | Bundled by package                                                                    |
| Features needed                  | Prepared statements, `sqlite.backup()`, explicit `BEGIN`/`COMMIT`, PRAGMAs (WAL, `busy_timeout`, `foreign_keys`) via `exec` | Same plus `.transaction()` helper                                                     |

## Decision

Use **`node:sqlite`** (`Database` class; `DatabaseSync` is a deprecated alias in Node 26).
Access it only through a narrow storage port in `packages/storage`, covering
`open/close`, `prepare`, `transaction(fn)`, `backup` and `integrityCheck`. No other package
imports `node:sqlite` directly. `transaction(fn)` is implemented with explicit
`BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`.

## Rationale

This removes the riskiest packaging item in spec §14: native addons on two architectures,
plus install-time binary downloads. It also adds no runtime dependency. The
release-candidate status is a real but bounded risk. RC means no further breaking changes
are anticipated. The runtime is pinned to one LTS line (ADR 0002). The storage port limits
any API change to one package.

## Consequences

- Phase 1 must include storage tests for WAL mode, `busy_timeout`, transactional
  migrations, `PRAGMA integrity_check`, online backup and restore. These run on both
  `linux/amd64` and `linux/arm64` in the container build (spec §16 Phase 5).
- Verified on Node 26.13.0: `import('node:sqlite')` emits no warning, and exports
  `Database`, `Statement`, `Session`, `backup` and `constants`, with
  `DatabaseSync === Database`. A WAL-mode in-memory database ran a `BEGIN IMMEDIATE`/`COMMIT`
  transaction correctly. Any future runtime warning must not reach stdout of the stdio
  bridge (which does not use SQLite anyway).

## Re-evaluation triggers (switch to `better-sqlite3`, compiled from source in the build stage)

- A breaking `node:sqlite` change within Node 26, or a needed feature missing (for example
  backup semantics or busy-handler behaviour under WAL).
- Phase 1 storage tests fail on either architecture.
