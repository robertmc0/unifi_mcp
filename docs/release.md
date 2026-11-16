# Releasing

> **Status: no release has been made.** The checks, the bill of materials and the
> workflows described here exist and pass on the development tree (version 0.0.0). The
> release workflow itself has never run, and publishing is switched off
> ([ADR 0029](adr/0029-supply-chain-and-release.md)).

This page is for the maintainer who cuts a release. Operators upgrading an installation
want [installation.md](installation.md#upgrading).

## What a release is

- A version in [Semantic Versioning](https://semver.org/), stated once in every
  `package.json`, in the service (`SERVICE_VERSION`) and in a section of
  [CHANGELOG.md](../CHANGELOG.md).
- A git tag `v<version>` on the commit that was verified.
- Optionally, a container image for `linux/amd64` and `linux/arm64` on GHCR. **Off until
  you turn it on** (below).

## Before tagging

On a clean checkout of the commit to release:

```sh
npm ci
npm run api:fetch-specs
npm run check && npm run api:reconcile
npm run test:containers
npm audit && npm audit signatures
npm run release:verify -- --version 1.2.3
npm run sbom
```

| Command                   | What it shows                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`           | Formatting, lint, types and the whole test suite, including the static checks of this page and the secret scan of the tracked files.                                                                      |
| `npm run api:reconcile`   | The vendor contracts, the inventories, the generated schemas and the coverage matrix agree.                                                                                                               |
| `npm run test:containers` | The image builds and the three Compose examples and the maintenance drill work on it. Needs Docker.                                                                                                       |
| `npm audit`               | No known vulnerability in any dependency. `npm audit signatures` checks the registry's signatures and attestations.                                                                                       |
| `npm run release:verify`  | One version everywhere and in the changelog; Node.js and the base image pinned and equal; every action pinned by commit; nothing forbidden tracked; a clean tree; no secret in the tree or in any commit. |
| `npm run scan:secrets`    | The secret scan alone, over the tree and the whole history.                                                                                                                                               |
| `npm run sbom`            | Writes `release/sbom.cdx.json` (CycloneDX) and `release/sbom.spdx.json` (SPDX): the production dependencies the image installs, from the lockfile.                                                        |

Also read the vendor portals again for new API revisions and newly published APIs, and
update the evidence dates (ADR 0024, `api-specs/README.md`).

## The secret scan

`scripts/lib/secret-scan.ts` looks for private keys, client tokens of this service,
common vendors' tokens, credentials assigned to obviously named variables, certificate
pins, and IP addresses outside the documentation and loopback ranges. It scans every
tracked file on each `npm run check`, and every line any commit ever added in
`npm run scan:secrets` and in CI. It reports the place, never the value.

It is narrow on purpose. **Before the repository is made public, also run a
general-purpose scanner** such as gitleaks or TruffleHog over the full history. None has
been run by this project.

If it reports something: a real secret must be revoked first (removing it from a file
does not remove it from history), then removed. A made-up value should look made up, for
example by containing `synthetic`.

## Cutting the release

1. Set the version in every `package.json` and in `SERVICE_VERSION`
   (`packages/mcp-server/src/service.ts`); `npm install --package-lock-only` updates the
   lockfile.
2. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [1.2.3] - <date>` and start a new
   `## [Unreleased]`. Say what an operator must do to upgrade, and whether the database
   schema changes (a pre-migration backup is then taken automatically,
   [backup-restore.md](backup-restore.md)).
3. Commit, run the commands above, then tag and push:

   ```sh
   git tag -s v1.2.3 -m "v1.2.3"
   git push origin main v1.2.3
   ```

   `-s` signs the tag with your key. An unsigned tag (`-a`) works too, but then nothing
   ties the tag to you.

4. The `release` workflow runs for the tag: the checks again, the container tests on
   both architectures, and the SBOM as a workflow artefact. It fails if the tag and the
   version in the tree differ.

## Publishing the image (off by default)

The workflow pushes an image only when the repository variable `PUBLISH_IMAGE` is
`true` **and** the run is for a version tag. To turn it on: repository _Settings →
Secrets and variables → Actions → Variables → New repository variable_, name
`PUBLISH_IMAGE`, value `true`. Delete the variable to turn it off again.

When on, the workflow builds the image on a native runner of each architecture, pushes
`ghcr.io/<owner>/unifi-local-mcp:<version>-amd64` and `…-arm64` with BuildKit's
provenance and SBOM attestations, and joins them as
`ghcr.io/<owner>/unifi-local-mcp:<version>`. It uses the workflow's own token, with
write access to packages in those two jobs only.

There is no `latest` tag. Operators should deploy by digest:

```sh
docker buildx imagetools inspect ghcr.io/<owner>/unifi-local-mcp:1.2.3   # shows the digest
```

and set `UNIFI_MCP_IMAGE=ghcr.io/<owner>/unifi-local-mcp@sha256:<digest>` for the Compose
files.

## Building it yourself

The image is reproducible from a checkout in the sense that matters here: the base
image is pinned by digest and the dependencies by the lockfile's integrity hashes.

```sh
docker build --build-arg VERSION=1.2.3 -t unifi-local-mcp:1.2.3 .
```

## Rolling back

Stop the service, start the previous image, and, if the newer release had upgraded the
database, restore the `backups/pre-migration-…` file it wrote first
([backup-restore.md](backup-restore.md#disaster-recovery)). An older release refuses a
database from a newer one rather than guessing.

## What is not done

- The image is **not signed** (no cosign or Notation signature). The provenance
  attestation says which workflow built it, on GitHub's word.
- **No vulnerability scan of the image** runs in CI. `npm audit` covers the npm
  dependencies; the base image's operating-system packages are covered only by keeping
  its pin current (Dependabot proposes updates). Scan a built image yourself with a
  scanner you trust, for example `docker scout cves <image>` or Trivy.
- The release workflow, the arm64 runners and publishing have **never run**: this
  project has not had access to run its workflows on GitHub.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md). Do not use public issues.

## Licence and attribution

Apache License 2.0 ([LICENSE](../LICENSE), [NOTICE](../NOTICE)). The image contains the
production dependencies listed in the SBOM, each under its own licence. UniFi is a
trademark of Ubiquiti Inc.; this project is not affiliated with Ubiquiti, and ships none
of its API documents ([api-specs/README.md](../api-specs/README.md)).
