# 0002. Runtime and toolchain: Node.js 26 LTS, TypeScript 6, npm workspaces

- Status: Accepted
- Date: 2026-11-10
- Phase: 0
- Spec references: §2 (decisions 11, 20), §14

## Context

Spec §14 requires strict TypeScript on a current Node.js LTS line, with the version pinned
and documented. It prefers npm workspaces with locked dependencies, pinned tool versions,
few dependencies, and reproducible AMD64/ARM64 builds.

## Decision

| Concern           | Choice                                                                                                                         | Pin                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Runtime           | Node.js 26 "Lithium" (Active LTS since 2026-10-28)                                                                             | `26.13.0` (`.node-version`, `engines: >=26.13.0 <27`, `engine-strict`) |
| Package manager   | npm workspaces, single root `package-lock.json`, private packages                                                              | npm `11.20.0` (bundled with Node 26.13.0)                              |
| Module format     | ESM (`"type": "module"`), `module`/`moduleResolution: nodenext`                                                                | —                                                                      |
| Language          | TypeScript, strict plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly`, `verbatimModuleSyntax` | `typescript@6.0.3`                                                     |
| Tests             | Vitest                                                                                                                         | `vitest@5.1.0`                                                         |
| Lint / format     | ESLint flat config with `typescript-eslint` `strictTypeChecked`; Prettier                                                      | `eslint@10.14.0`, `typescript-eslint@8.72.2`, `prettier@3.9.10`        |
| Schema validation | Zod 4 (also the MCP SDK v2 dependency)                                                                                         | `zod@4.6.7`                                                            |

All direct dependencies are saved exactly (`save-exact=true`).

**Source and build.** Relative imports use `.ts` extensions with `rewriteRelativeImportExtensions`.
Developer scripts in `scripts/` run directly on Node 26 using its built-in TypeScript type
stripping; `erasableSyntaxOnly` guarantees compatibility. The container image (Phase 1)
will run `tsc`-emitted JavaScript from `dist/`. Production then never depends on runtime
type stripping, and the shipped code is exactly the type-checked code.

## Evidence (verified 2026-11-10)

- `https://nodejs.org/dist/index.json`: v26.13.0 dated 2026-10-28 is the first release with
  `lts: "Lithium"`. v24 ("Krypton") is now in maintenance. v27 is only at alpha.
- Node 26.13.0 ships SQLite 3.54.0 and OpenSSL 3.5.9 (`process.versions`), and
  `process.features.typescript === "strip"`.
- The npm registry lists `typescript` `latest = 7.0.2`, the native port. However,
  `typescript-eslint@8.72.2` declares peer `typescript: ">=4.8.4 <6.1.0"`, so TypeScript 7
  would lose type-aware linting. We therefore pin the newest supported 6.x release.
- `vitest@5.1.0` declares `node: ^22.12.0 || ^24.0.0 || >=26.0.0`. `eslint@10.14.0` declares
  `node: ^20.19.0 || ^22.13.0 || >=24`.
- `npm audit` reported GHSA-g3hv-75wg-m249 (minimatch `<11.0.1`, moderate ReDoS) through
  eslint and typescript-eslint, which pin `minimatch@^10`. The suggested fix is a
  _downgrade_ of both tools. Instead we add an npm `overrides` entry `minimatch: 11.0.5`
  (ESM-only; loads through `require(esm)` on Node 26). After the override, `npm audit`
  reports 0 vulnerabilities and ESLint runs normally. This affects development tooling only;
  none of it ships in the runtime image.

## Consequences

- Contributors need Node.js 26.13.0 or later within the 26.x line. Older Node versions fail
  `npm install` because of `engine-strict`.
- The native module question is avoided entirely if ADR 0004 holds (`node:sqlite`).
- TypeScript 7 adoption is deferred, not rejected.

## Re-evaluation triggers

- `typescript-eslint` adds TypeScript 7 support → move to TS 7 in its own change.
- eslint/typescript-eslint adopt `minimatch >= 11.0.1` → remove the override.
- Node 26 security releases → bump `.node-version` and `engines` floor; Node 28 LTS (2028)
  → plan migration.
