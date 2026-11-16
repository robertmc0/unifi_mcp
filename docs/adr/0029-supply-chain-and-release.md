# 0029. Supply chain checks and the release workflow

- Status: Accepted
- Date: 2026-11-16
- Phase: 5
- Spec references: §14, §15 (`scripts/verify-release`, workflows), §16 Phase 5 ("CI/security checks, … SBOM and optional GHCR workflow", gate "public-repo scan finds no secrets"), §17, §18 item 14

## Context

Spec §14 lists for CI: "SCA/dependency alerts, secret scanning, container vulnerability
scanning, architecture checks and release provenance where available", and says "GHCR
release publishing disabled until explicit opt-in/configuration". Phase 1 delivered one
workflow with a test job and an image smoke job (ADR 0017).

The project has few dependencies (17 production packages), runs its sources directly,
and has not had access to run workflows on GitHub. Every third-party action is code that
runs with the repository checked out, so each one added is a new thing to trust.

## Decision

1. **Use what npm and Docker already provide; add no third-party action.** The workflows
   use only `actions/checkout`, `actions/setup-node` and `actions/upload-artifact`, each
   pinned by commit SHA.
   - Dependency vulnerabilities: `npm audit --audit-level=low`, failing on any.
   - Registry signatures and attestations: `npm audit signatures`.
   - Bill of materials: `npm sbom` (CycloneDX and SPDX) for the production dependencies,
     from the lockfile (`npm run sbom`), uploaded as a workflow artefact.
   - Provenance and an image SBOM: BuildKit's own attestations
     (`--provenance=mode=max --sbom=true`) when an image is pushed.
   - Dependency updates: Dependabot for npm, the base image and the actions, as pull
     requests only.

2. **A secret scanner of our own, narrow and always on**
   (`scripts/lib/secret-scan.ts`). It knows what must never be in this repository:
   private keys, this service's client tokens, common vendors' tokens, credentials
   assigned to named variables, certificate pins, and addresses outside the
   documentation and loopback ranges (the owner's console must never appear). It runs
   over every tracked file in `npm run check`, and over every line any commit ever added
   in CI (`npm run scan:secrets`). It prints places, never values. It does not replace a
   general scanner; the manual says to run one before the repository is published.

3. **Static release checks** (`scripts/lib/release-checks.ts`, `npm run release:verify`):
   one version in every package, in the service and in the changelog; the Node.js
   version equal in `.node-version`, `engines` and the pinned base image; every action
   pinned by a 40-character commit with its tag in a comment; workflows default to
   `contents: read` and never use `pull_request_target`; nothing forbidden tracked
   (vendor artefacts, environment files, keys, databases); a clean tree; a clean secret
   scan of the tree and the history. The same functions run on the repository in
   `npm run check` (`tests/contract/release-readiness.test.ts`).

4. **Both architectures on native runners.** The container tests and the image smoke
   test run in a matrix of `ubuntu-24.04` and `ubuntu-24.04-arm`. No emulation: under
   QEMU, Node.js's type stripping fails without an extra flag (ADR 0017), which would
   test something operators do not run.

5. **Publishing is a switch that is off.** `release.yml` runs for a version tag or by
   hand. It always verifies and tests. It pushes to GHCR only when the repository
   variable `PUBLISH_IMAGE` is `true` and the run is for a version tag. Only the two
   publishing jobs have `packages: write`. Images are built per architecture on that
   architecture and joined into one manifest; there is no `latest` tag.

6. **Issue templates** steer security reports to private reporting, warn against pasting
   secrets and real identifiers, and say that only officially documented local APIs can
   be requested.

## Not done, and why

- **Container vulnerability scanning.** It needs a scanner (Trivy, Grype, Docker Scout),
  that is, a third-party action or a downloaded binary in CI. Which scanner to trust is
  the owner's decision, and this project could not run and review one. Until then:
  `npm audit` covers the npm dependencies, the base image is pinned by digest and
  Dependabot proposes its updates, and the manual tells operators to scan the image
  with a scanner they trust. This is a gap against spec §14.
- **Image signing** (cosign, Notation): the same reason, and it needs a key or an
  identity decision.
- **A general-purpose secret scanner** (gitleaks, TruffleHog): not run. Ours found
  nothing in 87 commits, which says what ours looks for is absent, not that nothing is.

## Evidence

Run on 2026-11-16 on the development machine:

- `npm audit`: 0 vulnerabilities. `npm audit signatures`: 58 packages with verified
  attestations.
- `npm run sbom`: 17 components (CycloneDX), 18 packages including the root (SPDX).
- `npm run scan:secrets`: 395 tracked files and the added lines of 87 commits, no
  finding. Before that, the scan reported generic example addresses (a home-LAN example
  network, members of the private ranges, a public resolver) in documentation and in
  the egress tests. None was a real address. They were replaced by documentation
  addresses; in the history they are accepted by an explicit list, for those files only.
- `npm run release:verify`: all checks pass at version 0.0.0.
- `tests/unit/scripts/secret-scan.test.ts`: 13 kinds of secret or address are reported,
  13 kinds of harmless text are not, a finding never contains its value, and a value
  that a later commit removed is still found in the history.
- `tests/unit/scripts/release-checks.test.ts`: each check catches the disagreement it
  exists for.

**Not verified:** no workflow has run on GitHub. `check.yml`'s new jobs, the arm64
runners, `release.yml`, publishing, and the BuildKit attestations are untested. The YAML
parses, and the static checks pass on it.

## Consequences

- A contributor cannot commit a key, a token, a pin or a private address without
  `npm run check` failing, unless it is made to look synthetic.
- Example addresses in documentation and tests must come from the documentation ranges.
- Releases are verifiable from a checkout without any service this project does not
  control, except the npm registry for the audit.

## Re-evaluation triggers

- The owner chooses a container scanner or a signing method.
- The first run of the workflows on GitHub, which will show what is wrong with them.
- The repository is about to be published: run a general secret scanner first.
