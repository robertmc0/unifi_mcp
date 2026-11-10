# Administration with the `unifi-mcp` CLI

> **Status: Phase 1 in progress.** The CLI ([ADR 0015](adr/0015-host-administration-cli.md))
> and the admin web interface's sign-in, dashboard, approvals and audit pages
> ([ADR 0016](adr/0016-admin-listener-sessions-and-ui.md)) are implemented and tested.
> Editing consoles, clients and policy in the browser, and MFA, are Phase 5. The container
> image has `unifi-mcp` on the `PATH` ([installation.md](installation.md)).

`unifi-mcp` is the host administrator's tool. It manages MCP clients and their tokens,
consoles and their credentials, policy, approvals, the bootstrap file, the master key,
backups and the audit trail.

> **Never give the CLI to an AI agent.** Whoever can run `unifi-mcp` (or `docker exec`
> into the container, or use the Docker socket) can change any policy, approve any
> request and read the master key. Do not let an agent's shell, MCP harness or automation
> reach it. Agents use the MCP endpoint with their own scoped token, and nothing there
> can reach these commands.

## Running it

| Where                   | Command                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| Docker Compose          | `docker compose exec unifi-mcp unifi-mcp <group> <command> …`          |
| Docker, service stopped | `docker compose run --rm --no-deps --entrypoint unifi-mcp unifi-mcp …` |
| From a source checkout  | `npm run unifi-mcp -- <group> <command> …`                             |

Do **not** run `npx unifi-mcp`. The package `unifi-mcp` on the public npm registry is an
unrelated project, and `npx` downloads and runs it whenever the local command is not
linked. `npm exec --no -- unifi-mcp …` is safe: `--no` refuses to download anything.

The CLI reads the same environment as the service: at least `UNIFI_MCP_DATA_DIR` and the
master key (`UNIFI_MCP_MASTER_KEY_FILE`), and the listener and egress settings for
`doctor` and `console check` (see [configuration.md](configuration.md)). Inside the
container, `docker exec` inherits these from the container. Changes are recorded in the
audit trail as `cli:<operating-system user>`.

## Conventions

- `--help` after any command shows its options. `unifi-mcp --help` lists every command.
- `--json` prints machine-readable JSON on stdout instead of text.
- Exit codes: **0** success, **1** failure or a failed check, **2** usage error (unknown
  command or option, missing argument).
- **Secrets are never command-line arguments**, because those end up in the process list
  and the shell history. Passwords are typed twice at a hidden prompt. API keys come from a
  file (`--key-file`, for example a Docker secret) or a hidden prompt. A key file readable
  by other users gets a warning.
- Commands that delete or replace something (`console remove`, `db restore`,
  `crypto rotate-key`, `config apply`) ask you to type a word to confirm. `--yes` skips the
  question for scripts. **Approving has no `--yes`** (see below).
- Text from UniFi and from MCP clients (names, request arguments, certificate subjects) is
  untrusted. The CLI prints control characters, terminal escape sequences and
  bidirectional-text characters as `\uXXXX`, so such text cannot rewrite or reorder what
  you see. `--json` output stays exact.
- New client tokens are printed **once**. Store them in the client's secret store straight
  away: they cannot be shown again, only replaced (`client rotate`).

## First-time setup

1. Create the master key, once:
   `unifi-mcp crypto generate-key --out secrets/unifi_mcp_master_key` (mode 0400; it never
   overwrites). Back it up separately from the database; see
   [backup-restore.md](backup-restore.md).
2. Add a console and its credential:

   ```sh
   unifi-mcp console add --alias home --host 192.0.2.1
   unifi-mcp console set-credential home --module network --key-file /run/secrets/network_key
   unifi-mcp console check home
   ```

   `console check` connects over TLS and shows the certificate and its `sha256/…` pin. It
   sends no HTTP request and no credential. A UniFi console usually has a self-signed
   certificate, so check that the certificate is the expected one, then pin it with
   `unifi-mcp console set-tls home --tls pinned --pin sha256/…`. Run `console check home`
   again until it reports `verified: yes`.

3. Enable a module, read-only to begin with:
   `unifi-mcp console enable-module home --module network --mode read_only`.
4. Create a client for each agent or harness, granting only what it needs:

   ```sh
   unifi-mcp client create claude-code-laptop --console home --allow 'network.*.read'
   ```

   `--console home=site-a,site-b` limits the client to some sites. `--deny` removes
   operations again. `--sensitive <tag>` grants a sensitive-data class (spec §6.4). The
   `credential` class can never be granted.

5. Optionally, create the first administrator for the [admin web interface](#admin-web-interface):
   `unifi-mcp admin bootstrap --username alice`.
6. Run `unifi-mcp doctor`, and fix anything it reports as `FAIL` or `WARN`.

Instead of steps 2 to 4 you can write a [bootstrap file](#bootstrap-file) and apply it.

## Commands

The service can keep running for every command except `crypto rotate-key` and
`db restore`, which are refused with `DATA_DIRECTORY_IN_USE` until it is stopped. Changes
apply to the running service immediately.

### Clients (`client`)

| Command                                         | What it does                                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `client create <id> [options]`                  | Creates a client with `--console`, `--allow`, `--deny`, `--sensitive`, `--description` and `--token-expires`, and prints its token once. |
| `client list`, `client show <id>`               | Lists clients, or shows one with its policy and token metadata. Token values are never shown.                                            |
| `client rotate <id> [--token-expires <date>]`   | Issues a new token, printed once, and revokes the old ones. Streams opened with an old token are closed within 5 seconds.                |
| `client revoke <id>`                            | Revokes the client and all its tokens. New requests are refused at once; its open MCP streams are closed within 5 seconds.               |
| `client set-policy <id> --file <f> [--dry-run]` | Replaces the client policy. `consoles` keys may be aliases.                                                                              |
| `client show-schema`                            | Shows a client policy with all defaults.                                                                                                 |

### Consoles (`console`)

| Command                                                                | What it does                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `console add --alias <a> --host <h> [--tls …] [--ca-file …] [--pin …]` | Adds a console. No module is enabled yet. The host must be inside the egress allowlist when used.                                                                                                                                                                       |
| `console list`, `console show <a>`                                     | Lists consoles, or shows one with its modules, policy and TLS mode. Credentials are never shown.                                                                                                                                                                        |
| `console set-credential <a> [--module m] [--key-file f]`               | Stores a module API key, encrypted with the master key. It can be replaced but never read back.                                                                                                                                                                         |
| `console enable-module <a> [--module m] [--mode …] [--port n]`         | Enables a module (`read_only` by default), changes its mode, or disables it.                                                                                                                                                                                            |
| `console set-policy <a> --file <f> [--dry-run]`                        | Replaces the console policy (state, sites, allow/deny, module states).                                                                                                                                                                                                  |
| `console set-tls <a> --tls verify\|pinned\|insecure …`                 | Changes how the certificate is checked. `insecure` prints a warning; prefer `pinned`.                                                                                                                                                                                   |
| `console disable <a>`, `console enable <a>`                            | Disables a console (nothing can use it) or enables it again.                                                                                                                                                                                                            |
| `console check <a> [--module m]`                                       | Checks name resolution, egress, reachability and TLS trust, and shows the certificate pin. Exits 1 if the certificate is not trusted.                                                                                                                                   |
| `console probe <a> [--module m]`                                       | Asks the console for the module's application version now, with one documented read (`GET /v1/info` for Network), and says whether it is supported. Exits 1 if it is not. The service does this by itself within a minute of a module being enabled, and every 6 hours. |
| `console remove <a> [--yes]`                                           | Removes the console and its stored credentials.                                                                                                                                                                                                                         |

### Policy (`policy`)

| Command                                          | What it does                                                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `policy show`                                    | Shows the global policy, its version and the deployment hard lock (`UNIFI_MCP_FORCE_READ_ONLY`).                                 |
| `policy validate --file <f>`                     | Validates a global policy file.                                                                                                  |
| `policy apply --file <f> --expected-version <n>` | Replaces the global policy if its version is still `n` (otherwise `POLICY_VERSION_CONFLICT`). Pending approvals are invalidated. |
| `policy apply --file <f> --dry-run`              | Validates and reports whether it would change anything.                                                                          |
| `policy set-runtime-mode read_only\|read_write`  | Switches the runtime mode. The hard lock still overrides `read_write`.                                                           |

Policy layers, selectors and the evaluation order are described in
[security.md](security.md).

### Approvals (`approvals`)

| Command                             | What it does                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| `approvals list [--status s]`       | Lists approval requests, newest first.                                                            |
| `approvals show <id>`               | Shows a request with its redacted summary.                                                        |
| `approvals approve <id> [--note t]` | Approves a pending request. Needs an interactive terminal: type the first 8 characters of the id. |
| `approvals reject <id> [--note t]`  | Rejects a pending request. Can be scripted.                                                       |

Approving cannot be scripted or piped, and there is no `--yes`. Read the request on the
screen before you type the id: client, operation and risk, console and site, and the
summary of its arguments. See [approval-workflow.md](approval-workflow.md) for what
happens next.

### Configuration (`config`)

| Command                                       | What it does                                                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `config validate [--file <f>]`                | Validates the environment, and a bootstrap file with its policies.                                                    |
| `config show-effective`                       | Shows the effective configuration: listener, egress, hard lock, key id, versions and counts. Secrets are never shown. |
| `config import --file <f>`                    | Shows the plan for a bootstrap file. Changes nothing.                                                                 |
| `config apply --file <f> [--yes] [--dry-run]` | Applies a bootstrap file.                                                                                             |

### Master key (`crypto`) and database (`db`)

| Command                                        | What it does                                                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `crypto generate-key --out <f>`                | Writes a new random key file (mode 0400). Never overwrites.                                                                   |
| `crypto key-id --file <f>`                     | Shows a key file's identifier, to match key files to databases and backups.                                                   |
| `crypto rotate-key --new-key-file <f> [--yes]` | Re-encrypts all credentials with a new key. **Service stopped.**                                                              |
| `db backup [--out <f>]`                        | Writes a verified online backup. Safe while the service runs.                                                                 |
| `db check [--backup <f>]`                      | Checks the live database read-only (integrity, key, every credential, audit chain), or a backup file. Exits 1 on any problem. |
| `db restore <f> [--yes]`                       | Replaces the database with a validated backup. **Service stopped.**                                                           |

Procedures are in [backup-restore.md](backup-restore.md).

### Audit trail (`audit`)

| Command        | What it does                                                                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit list`   | Lists entries, newest first. Filters: `--since`, `--until`, `--actor-type`, `--actor`, `--outcome`, `--event-type`, `--limit` (up to 500). Older pages: `--before-seq <seq>`. |
| `audit verify` | Verifies the hash chain. Exits 1 and names the first bad entry if one was changed or an earlier one removed.                                                                  |

See [monitoring.md](monitoring.md#audit-trail).

### Administrators, diagnostics and coverage

| Command                               | What it does                                                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin bootstrap --username <u>`      | Creates the first administrator for the admin web interface. Refused once one exists.                                                                                 |
| `admin reset-password --username <u>` | Sets a new password and re-enables the account (local recovery).                                                                                                      |
| `admin list`                          | Lists administrators.                                                                                                                                                 |
| `doctor`                              | Checks configuration, key, database, audit chain, policy, hard lock, listener, egress, consoles, clients, administrators and disk space. Exits 1 if a check fails.    |
| `api coverage`                        | Shows the official operations per module and how many this service implements. The full matrix, with reviewed metadata and test evidence, is in `docs/api-coverage/`. |

Passwords must have at least 12 characters, must not contain the username, and need at
least 4 different characters. They are stored as Argon2id hashes. `admin reset-password`
also ends all of the account's web sessions. `admin reset-mfa` arrives with MFA
(Phase 5).

## Admin web interface

An optional browser interface for the dashboard, approvals and the audit trail. It is
off by default and never needed: the CLI does everything it does.

1. Create an administrator on the host: `unifi-mcp admin bootstrap --username alice`.
2. Set `UNIFI_MCP_ADMIN_ENABLED=true` and restart the service. It listens on
   `127.0.0.1:3001` by default; see [networking.md](networking.md#the-admin-listener) for
   Docker and remote access.
3. Open `http://localhost:3001` (or your `https://` address) and sign in.

| Page      | What it shows                                                                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard | Hard lock, runtime mode, policy version, readiness and every health check, listeners, consoles and their modules, counts.                                   |
| Approvals | Pending and recent requests. A request's page shows the client, operation, risk, target, times and the redacted arguments, with **Approve** and **Reject**. |
| Audit     | The audit trail, newest first, filtered by actor, outcome and event type, with paging.                                                                      |

- **Approving needs your password every time**, on the approval form. Approving does not
  run anything: the requesting client must resume the request before the time shown.
  Rejecting needs no password.
- Sessions end after 30 minutes without use, 12 hours after sign-in, at **Sign out**,
  when your password is reset on the host, or when the account is disabled.
- After 5 failed sign-ins for a username (or 20 from one address) within 15 minutes,
  sign-in is refused for the rest of the 15 minutes.
- Sign-ins, sign-outs and failures are in the audit trail (`admin.auth`), and your
  decisions too (`approval`).
- Text from MCP clients and UniFi is shown escaped. Control and bidirectional-text
  characters appear as `\uXXXX`, so a request cannot hide or reorder what you read.

## Bootstrap file

A bootstrap file describes the global policy, consoles and clients in one YAML (or JSON)
document. [`deploy/example-bootstrap.yaml`](../deploy/example-bootstrap.yaml) is a
commented example.

```sh
unifi-mcp config validate --file bootstrap.yaml   # schema and policies
unifi-mcp config import --file bootstrap.yaml     # the plan; changes nothing
unifi-mcp config apply --file bootstrap.yaml      # asks you to type "apply"
```

- `version: 1`, then optional `policy` (global), `consoles` and `clients`. Unknown fields
  are errors.
- A console has `alias`, `host`, optional `description`, `tls` (`mode: verify` with an
  optional `caFile`, `mode: pinned` with `pins`, or `mode: insecure`), `policy` (console
  policy), and `modules` with an optional `port` and `credentialFile` per module.
- **Credentials are never written in the file.** `credentialFile` names a file, such as a
  Docker secret, that is read when the file is applied. Relative paths are relative to the
  bootstrap file.
- A client has `id`, optional `description` and `policy`. In the client policy, `consoles`
  keys are console aliases.
- `config apply` reads all referenced files first and then makes every change in one
  transaction: all of it or none of it.
- It only adds and updates. **Nothing is ever deleted.** Consoles and clients that exist
  but are not in the file are listed as "not in the file" and left unchanged.
- Applying the same file again changes nothing. Unchanged items are not rewritten, so they
  do not invalidate pending approvals.
- New clients' tokens are printed once at the end.

## Dry runs

`policy apply`, `client set-policy`, `console set-policy` and `config apply` take
`--dry-run`. The document is validated exactly as the real change would be, and the
command reports whether it would change the stored policy. Nothing is written or audited.

## Maintenance with the service stopped

Only one service can use a data directory. While it runs, it holds `instance.lock` in the
data directory. `crypto rotate-key` and `db restore` need the same lock, so they fail with
`DATA_DIRECTORY_IN_USE` until the service is stopped. A crashed service never leaves a
stale lock: the operating system releases it when the process exits. The data directory
must be on a local filesystem, not a network share.

With Docker Compose:

```sh
docker compose stop unifi-mcp
docker compose run --rm --no-deps --entrypoint unifi-mcp unifi-mcp crypto rotate-key --new-key-file /run/secrets/<new key>
docker compose start unifi-mcp
```

The new key file must be mounted into the one-off container, for example as a second
Compose secret. Afterwards, point the `unifi_mcp_master_key` secret at the new file.

## Common errors

| Error                       | Meaning and fix                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `MASTER_KEY_NOT_CONFIGURED` | Set `UNIFI_MCP_MASTER_KEY_FILE` (or run inside the container, which has it).                     |
| `MASTER_KEY_MISMATCH`       | The configured key is not the database's key. Use the key file that created the database.        |
| `DATA_DIRECTORY_IN_USE`     | Another service or maintenance command uses the data directory. Stop the service first.          |
| `POLICY_VERSION_CONFLICT`   | The policy changed since you read its version. Run `policy show` and retry with the new version. |
| `needs confirmation`        | Run in a terminal, or add `--yes` (not possible for approvals).                                  |
| `Approving needs a human …` | Approve from an interactive terminal, not a script or pipe.                                      |
