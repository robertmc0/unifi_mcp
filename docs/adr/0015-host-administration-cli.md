# 0015. Host administration CLI, administrator accounts and the data-directory lock

- Status: Accepted
- Date: 2026-11-10
- Phase: 1
- Spec references: §2, §6.5, §7.2, §8.1, §8.2, §12, §13.2, §16 Phase 1 gate, §17

## Context

Spec §13.2 requires a host-only CLI (`unifi-mcp`) for bootstrap, clients, consoles,
policy, approvals, configuration, cryptography, the database, diagnostics and API
coverage, with `--dry-run` for permission changes. It is for a **human host
administrator** (for example through `docker exec`), never for an AI harness. The Phase 1
gate requires that a high-risk action can be approved through the CLI or the admin UI, and
never through MCP. §7.2 requires first-administrator bootstrap and local password
recovery. §8.1 describes YAML bootstrap import. The storage step (ADR 0007) left open a
single-instance guard per data directory.

## Decision

### Command framework

- `packages/cli`, entry `src/main.ts`, bin `unifi-mcp`. Commands are `<group> <command>`,
  parsed with `node:util` `parseArgs` in strict mode, so unknown options are usage errors.
  No argument-parsing dependency.
- Global options: `--json` (machine-readable output on stdout) and `--help`. Exit codes:
  0 success, 1 failure or a failed check, 2 usage error. Diagnostics go to stderr.
- The CLI opens the same configuration, master key and database as the service
  (`UNIFI_MCP_*` variables). It has no network listener and is not reachable from MCP.
  Changes are audited as actor `cli:<operating-system user>`.
- Everyday commands (clients, consoles, policy, approvals, backup, checks) work while the
  service runs. The service reads its security state fresh on every evaluation, so CLI
  changes apply immediately. Audit appends from both processes serialise on SQLite's write
  lock (`BEGIN IMMEDIATE`), which keeps the hash chain linear.
- Revocation from the CLI: new requests are refused at once, because every request
  authenticates against the database. Open responses (streams, in-flight calls) are
  tracked with the token they were authenticated with. The service's in-process
  revocation listener (ADR 0013) never sees a change made by another process, so the
  service also re-checks every open response every 5 seconds
  (`McpHttpService.revalidateOpenResponses`). It closes those whose token was revoked or
  expired, or whose client was revoked, disabled or expired, and cancels the queued work
  of inactive clients. If the check fails, the response is closed.

### Secrets never on the command line

Passwords, UniFi API keys and similar values are read from a file (`--key-file`) or from a
terminal prompt without echo. They are never read from an argument, which would leave them
in the process list and the shell history. A security test checks every option of every
command: names containing password, secret, token, key or credential must end in `-file`
(`--token-expires` is the only exception: it is a date, not a secret). Generated tokens are
printed once.

### Approvals

`approvals approve` requires an interactive terminal and has no `--yes`. It shows the
request and asks the operator to type the first eight characters of the approval id.
Scripts, pipes and agents with a shell therefore cannot approve. `approvals reject` can be
scripted, because rejecting only reduces what can happen. The approver identity is
`cli:<user>`, and `ApprovalService` (ADR 0011) applies its usual checks.

### Terminal-safe output

Approval requests contain text chosen by the MCP client, and so by the model. Console
names, events and certificate subjects come from UniFi or from a remote server. All output
passes through `terminalSafe()` once, in `runCli`. It shows as `\uXXXX` all C0 controls
other than newline and tab, DEL, C1 controls (U+009B is an 8-bit CSI on some terminals),
U+2028/U+2029, and the bidirectional formatting characters U+061C, U+200E/U+200F,
U+202A–U+202E and U+2066–U+2069. Without this, an argument could clear or rewrite lines of
the approval screen, or reverse text so that a different operation appears to be
approved. Table cells and the fields of the approval screen are also escaped onto one line
(`oneLine()`), so a value cannot forge an extra line. In `--json` output the replacement is
a valid JSON escape for the same character, so machine-readable output stays exact.

### Administrator accounts (migration 8)

- Table `admins`: username (lower case, unique), Argon2id hash in PHC format (a CHECK
  requires `$argon2id$`), status `active` or `disabled`, and timestamps.
- Argon2id from `node:crypto` (`argon2Sync`, no warning on Node 26.13.0, no native npm
  module). Parameters: m = 64 MiB, t = 3, p = 1, 16-byte random salt, 32-byte tag. That
  is the memory and pass count of RFC 9106's second recommended option, with one lane
  because the hash is computed synchronously. It is well above the OWASP minimum
  (19 MiB, t = 2).
  Verification reads the parameters from the stored hash, so they can be raised later
  without a migration. It compares tags in constant time and runs against a dummy hash
  when the user does not exist, so timing does not reveal valid usernames.
- Password rules follow NIST SP 800-63B (length, not composition): at least 12
  characters, at most 1024, must not contain the username, and at least 4 distinct
  characters.
- `admin bootstrap` works only while no administrator exists. `admin reset-password` is
  host recovery: it also re-enables a disabled account. Both require the CLI actor, a
  terminal, and the password typed twice. The web sign-in, sessions, MFA enrolment, and so
  `admin reset-mfa`, arrive with the admin UI (step 10).

### Declarative bootstrap file (`config import` / `config apply`)

- YAML (or JSON) with `version: 1`, an optional global `policy`, `consoles` (alias, host,
  description, `tls` verify with `caFile`, `pinned` with pins, or `insecure`, console
  `policy`, and per-module `port` and `credentialFile`) and `clients` (id, description,
  `policy` whose `consoles` keys are aliases). Strict schemas: unknown fields, including
  inline secrets such as `apiKey`, are errors.
- Parsed with `yaml@2.9.1` (ISC licence, no dependencies), with `maxAliasCount: 50`
  against alias-expansion attacks. Node.js has no YAML parser, and JSON is valid input too.
- `config import` (also `config apply --dry-run`) shows the plan and changes nothing.
  `config apply` reads every referenced file first, then makes all changes in one
  transaction. Items whose stored state already matches are not rewritten, so they cause
  no policy-version bump and leave pending approvals valid. A second apply of the same
  file changes nothing. **Nothing is ever deleted**: consoles and clients that are not in
  the file are reported and left alone. Tokens of newly created clients are printed once.

### Dry runs

`policy apply`, `client set-policy`, `console set-policy` and `config apply` accept
`--dry-run`. The document is validated by the same store method the real change uses
(`PolicyStore` validation, `ClientStore.validatePolicy`, `ConsoleRegistry.validatePolicy`),
and the CLI reports whether storing it would change anything. Nothing is written or
audited.

### One service per data directory

`acquireInstanceLock(dataDir)` takes an exclusive SQLite lock (`locking_mode=EXCLUSIVE` and
`BEGIN EXCLUSIVE`, no busy wait) on `instance.lock`, mode 0600, in the data directory.

- The service holds the lock from before it opens the database until after it closes it.
  A second service on the same directory fails with `DATA_DIRECTORY_IN_USE`.
- `crypto rotate-key` and `db restore` take the same lock, so they are refused while the
  service runs. A running service would otherwise keep the old key. Restore also still
  needs exclusive access to the database itself (`DATABASE_IN_USE`, ADR 0007).
- The operating system releases the lock when its holder exits, including after a crash
  or `kill -9`. The lock file can therefore never go stale, which a PID file could: in a
  container the service is always PID 1. Like SQLite's WAL mode, this needs a local
  filesystem for the data directory, not NFS or SMB.

The rotation and its audit entry are committed in one transaction. A verified backup,
`backups/pre-rotation-<UTC>.db` (which needs the old key), is written first.

### Other commands

- `console check` resolves the host through the egress guard and makes a TLS connection
  with the configured trust. It sends no HTTP request and no credential. It then opens a
  second, unverified connection that is used only to read the presented certificate, its
  subject, validity and `sha256/…` pin, so the operator can pin it. Nothing is written on
  that connection.
- `db check` opens the live database read-only: full integrity check, master key match,
  decryption of every encrypted record, and audit chain. `db check --backup` verifies a
  backup file.
- `audit list` (filters, paging with `--before-seq`) and `audit verify`.
- `doctor` checks configuration, key, database, audit chain, policy, hard lock, listener,
  egress, consoles, clients, administrators and disk space. It exits 1 if any check
  fails.
- `api coverage` counts the official operations in each `operations.json`. Implemented
  counts are 0 until the adapters register operations (Phase 2).

### The name `unifi-mcp` on npm

The public npm package `unifi-mcp` is an unrelated project. `npx unifi-mcp` downloads and
runs it whenever the local bin link is missing, and this happened once during
development. The docs therefore never say `npx unifi-mcp`. From a source checkout, use
`npm run unifi-mcp -- <args>` or `npm exec --no -- unifi-mcp`. The container image (step 11)
puts `unifi-mcp` on the `PATH`.

## Evidence

- `tests/unit/cli/` (commands, bootstrap planning and idempotence, dry runs, audit, rotate
  and restore beside a locked data directory, `console check` against the mock console
  with no request sent, terminal escaping).
- `tests/security/cli-invariants.test.ts`: approval cannot be scripted and needs the typed
  id; hostile request text cannot forge or hide lines; JSON stays exact; no secret
  arguments.
- `tests/unit/admin-api/admins.test.ts` (Argon2id format, verification, bootstrap once,
  CLI-only actors, disabled accounts).
- `tests/unit/storage/instance-lock.test.ts`: exclusive within a process and across
  processes; released after SIGKILL.
- `tests/integration-mock/instance-lock.test.ts`: a second service is refused until the
  first stops.
- `tests/integration-mock/cli-beside-service.test.ts`: revoking, rotating or disabling a
  client with the CLI closes its in-flight response in the running service; key rotation
  is refused while the service runs.
- Mutation checks: each safeguard above was disabled one at a time, and a test failed
  each time (29 mutations).

## Consequences

- The CLI is host-level authority. Whoever can run it, or `docker exec` into the
  container, can change policy, approve, and read the master key file. That is why the
  docs say never to give the CLI or the Docker socket to an AI agent.
- Key rotation and restore need a stopped service. With Docker they run in a one-off
  container on the same volumes; the commands are documented with the packaging
  (step 11).
- The YAML dependency is the CLI's only third-party runtime dependency. The service does
  not load it.

## Re-evaluation triggers

- Node.js changes the stability of `crypto.argon2Sync`, or OWASP changes its Argon2id
  recommendations.
- A deployment needs the data directory on a network filesystem.
- The admin UI (step 10) needs further CLI recovery commands (`admin reset-mfa`).
