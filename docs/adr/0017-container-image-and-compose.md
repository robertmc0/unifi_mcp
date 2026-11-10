# 0017. Container image, Compose example and basic CI

- Status: Accepted
- Date: 2026-11-10
- Phase: 1
- Spec references: §3.1, §7.3, §11, §14, §16 Phase 1 ("safe Docker examples")

## Context

§14 asks for:

- multi-stage images for `linux/amd64` and `linux/arm64`;
- a small runtime image with a non-root user, explicit writable volumes, no build tools,
  a `HEALTHCHECK` and graceful shutdown;
- digest pinning in deployment examples;
- CI with format, lint, typecheck, tests and a container build.

§11 and §7.3 ask for loopback publishing by default, and for the distinction between
container loopback and host-loopback publishing to be clear. They also forbid granting
`NET_ADMIN`.

## Decision

### Image (`Dockerfile`)

- **Base:** `node:26.13.0-trixie-slim`, pinned by the digest of its multi-architecture
  index, so one pin covers amd64 and arm64.
- **No compile step:** Node.js runs the TypeScript sources directly (type stripping,
  ADR 0002), so the image runs exactly the reviewed sources. `node:sqlite` is part of
  Node.js (ADR 0004), so there is no native module to build or download for either
  architecture.
- **Dependencies stage:** `npm ci --omit=dev --ignore-scripts`, so no lifecycle script
  of any dependency runs, and only production dependencies are installed (31 MB).
- **Runtime stage:**
  - removes npm, npx and corepack;
  - creates user and group `unifimcp` (10001:10001) and `/data` (0700, owned by it);
  - copies `packages/`, `api-specs/` (operation inventories and provenance only;
    `.dockerignore` keeps out the vendor cache, tests, docs, secrets and local data),
    `LICENSE`, `NOTICE`, and two wrappers: `unifi-mcp` (CLI) and `unifi-mcp-bridge`
    (stdio bridge);
  - `/app` is owned by root and not writable by the service;
  - `USER 10001:10001`, `VOLUME /data`, `STOPSIGNAL SIGTERM`;
  - `ENTRYPOINT node /app/packages/mcp-server/src/main.ts`.
- **`HEALTHCHECK`:** `packages/mcp-server/src/healthcheck.ts` probes `/livez` on the
  MCP listener inside the container. `/livez` answers whether to restart, which is what
  Docker health is used for. Proxies should use `/readyz`. The probe sends no credential,
  so with built-in TLS it does not verify the certificate. It runs every 30 s, and every
  2 s during the 20 s start period.
- The image is about 91 MB. Images are built locally for now; publishing to a registry
  stays disabled until it is explicitly configured (Phase 5).

### Compose example (`deploy/compose.single.yml`)

- **Isolation:**
  - `read_only: true` with a small `/tmp` tmpfs;
  - `cap_drop: [ALL]`, `no-new-privileges`;
  - `init: true`, `pids_limit`, `mem_limit`, and rotated `json-file` logs.
- **Hard lock:** `UNIFI_MCP_FORCE_READ_ONLY` is `"true"`, so writes need a deliberate edit.
- **Ports:** the MCP listener binds `0.0.0.0` inside the container, with
  `UNIFI_MCP_HTTP_ALLOW_PLAINTEXT=true`. It is published only as
  `127.0.0.1:3000:3000`, which is what protects it.
- **Admin interface:** off, and its port line is commented out. Enabling it takes both the
  variable and the port line, so publishing the MCP port never exposes it.
- **Master key:** a Compose secret from `./secrets/unifi_mcp_master_key` (mode 0400).
- **Data:** a bind mount `./data` (0700).
- **User:** the container runs as `UNIFI_MCP_UID:UNIFI_MCP_GID` (default 1000:1000), the
  user who owns those files. Compose secrets outside Swarm are bind mounts that keep the
  host owner, so a fixed container user could not read a 0400 key file without changing
  its ownership.
- **Maintenance:** `docker compose exec unifi-mcp unifi-mcp …` while the service runs.
  For key rotation and restore, stop the service and run
  `docker compose run --rm --no-deps --entrypoint unifi-mcp unifi-mcp …`.
- `compose.dual.yml` (separate MCP and management networks) and `compose.tls.yml` belong
  to the dual-network and TLS work of Phase 5.

### Bridge packaging

The stdio bridge ships in the same image as `unifi-mcp-bridge`, or runs from a source
checkout with Node.js 26. A harness can start it with
`docker run -i --rm --network host -v <token file>:/run/token:ro …`. The bridge closes when
its stdin closes. Per the MCP stdio binding, requests still in flight then are not
answered, so harnesses keep stdin open. A standalone npm package or binary is a release
task (Phase 5).

### CI (`.github/workflows/check.yml`)

- **`check` job:** `npm ci`, `api:fetch-specs` (checksum-verified), `npm run check` and
  `api:reconcile`.
- **`image` job:** builds the image, starts it read-only without capabilities, waits for
  `healthy`, runs `unifi-mcp doctor`, and checks that `docker stop` exits 0.
- **Hardening:** actions are pinned by commit SHA (`actions/checkout` v7.0.1,
  `actions/setup-node` v7.1.0), permissions are `contents: read` and credentials are not
  persisted. No secrets, no live UniFi access, nothing published.
- Security scanning, SBOM, provenance and arm64 builds are Phase 5 jobs.

## Evidence

- Local build on amd64. Checked in the image: user 10001; no npm, npx or corepack; no
  test files; `/app` not writable; CLI and `api coverage` working.
- **Compose smoke test** (isolated project, temporary directory, admin enabled for the
  test):
  - healthy after about 4 s;
  - `/readyz` and the admin sign-in page answered from the host;
  - root filesystem read-only, `/data` writable, `CapEff` 0, `NoNewPrivs` 1;
  - `doctor` and `client create` through `exec`;
  - key rotation refused while running (`DATA_DIRECTORY_IN_USE`);
  - the bridge from the image relayed `initialize` to the service;
  - `docker compose stop` exit code 0;
  - offline `db check` through `run`.
- The `image` job's script, run locally: healthy, `doctor`, exit 0.
- `tests/contract/packaging.test.ts`: digest pin, user, no package managers, health
  check, ignore list, Compose isolation, hard lock, admin off, loopback-only MCP port.
- `tests/integration-mock/healthcheck.test.ts`: exit 0 while the service answers, 1 when
  it is gone.
- **`linux/arm64` under QEMU user-mode emulation** (2026-11-10, on the amd64 development
  host, with the owner's consent to register `qemu-aarch64` through a digest-pinned
  `tonistiigi/binfmt`):
  - `docker buildx build --platform linux/arm64` builds the image with the same Dockerfile
    and base digest.
  - The full test suite, run with `npm ci` in the pinned arm64 Node.js image on a clean
    copy of the committed tree, passes 573 of 582 tests with the default 5-second
    limits. That includes all storage tests (7 files, 63 tests: `node:sqlite`, AEAD
    secrets, migrations, backup and restore, the instance lock). The other 9 are
    integration tests that start a service or a bridge process. They pass with longer
    limits: emulation is slow.
  - **The service and the CLI from the image do not start under emulation.** Node.js's
    TypeScript stripper (WebAssembly) fails with
    `ERR_INTERNAL_ASSERTION: memory access out of bounds` once its memory has grown,
    after about 20 files. Every file strips on amd64. Under emulation they strip only
    with V8's `--wasm-enforce-bounds-checks`, which replaces bounds checks based on
    guard pages and signal handling with explicit checks. Emulation is therefore the
    likely cause, not the image or our sources.
  - With that flag, which was added only to the emulated test run, the arm64 image works:
    healthy after 8 s, read-only root, `CapEff` 0, `NoNewPrivs` 1, `/app` not writable;
    `doctor`, `client create`, `db check`, `db backup` and `audit verify` succeed; and
    `docker stop` exits 0.

## Consequences

- One image serves the service, the CLI and the bridge.
- Upgrading means building or pulling a new image and restarting. The service upgrades
  the database itself after writing a pre-migration backup (ADR 0007).
- **arm64 is verified under emulation only.** The image builds, the tests pass, and the
  service works when the emulation workaround above is used. No arm64 hardware has been
  tested. The image does not carry `--wasm-enforce-bounds-checks`: it is an emulation
  workaround, and it would slow every native start. Running the arm64 image on an amd64
  host under QEMU is therefore not supported. Use the image for the host's architecture.
  An arm64 CI job (Phase 5) should use a native arm64 runner, or pass the flag when it
  starts the service under emulation.

## Re-evaluation triggers

- A dependency gains a native module, or Node.js type stripping changes.
- The first run on arm64 hardware, or a Node.js or QEMU release that changes the
  emulation result.
- Publishing images (Phase 5): signing, SBOM, provenance, multi-arch manifests.
- A deployment cannot run as the file owner's UID (for example rootless setups with
  user-namespace remapping).
