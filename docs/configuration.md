# Configuration

> **Status: Phase 1 in progress.** This page covers the settings implemented so far: the
> hard lock, the egress allowlist, the data directory, logging and the master encryption key. Listener, policy, bootstrap YAML and
> runtime-mode settings are added here as they are implemented. Commands shown as
> `unifi-mcp …` belong to the CLI, which is not built yet (Phase 1 step 9).

Configuration precedence (spec §8.1): immutable deployment overrides first, then settings
stored in the database, then YAML/environment bootstrap values. The settings on this page
are deployment settings read from the environment at every start.

## Deployment hard lock

| Variable                    | Default when unset | Meaning                                                                                                                                                                                |
| --------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNIFI_MCP_FORCE_READ_ONLY` | `true`             | When true, no write can run through any path, including approved actions. Accepts `true`/`false` (also `1`/`0`, `yes`/`no`, `on`/`off`). Any other value stops the service at startup. |

This is an immutable deployment override: it is read at startup and cannot be changed from
the database, the admin UI or an MCP client. Leaving it unset keeps the lock on; set it to
`false` deliberately to allow writes. See [security.md](security.md) for the other four
levels that must also allow a write.

## Egress allowlist

| Variable                       | Default                                                          | Meaning                                                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `UNIFI_MCP_EGRESS_ALLOW_CIDRS` | `10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,fc00::/7` | Comma-separated networks the service may connect to. When set, it replaces the default. A malformed entry stops the service at startup. |

Narrow it to the networks your consoles are actually on, for example
`192.168.1.0/24,10.8.0.0/24`. Loopback and link-local addresses are not allowed by default.
Cloud metadata (`169.254.169.254`), multicast and unspecified addresses are refused even if
listed. See [security.md](security.md#connections-to-consoles).

## Data directory

| Variable             | Container value | Meaning                                           |
| -------------------- | --------------- | ------------------------------------------------- |
| `UNIFI_MCP_DATA_DIR` | `/data`         | Persistent directory for the database and backups |

The storage layer is implemented; the service entry point that reads this variable comes
with the MCP server (Phase 1 step 7). Contents:

| Path                              | What it is                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `unifi-mcp.db` (+ `-wal`, `-shm`) | The SQLite database (WAL mode). Mode 0600.                                   |
| `backups/`                        | Automatic pre-migration backups (see [backup-restore.md](backup-restore.md)) |
| `unifi-mcp.db.pre-restore-*`      | The database a restore replaced, kept for you to inspect or delete           |

Requirements:

- **Local filesystem only** (a Docker volume or local disk). SQLite WAL mode does not work
  on NFS, SMB or other network filesystems; the service refuses to start if WAL cannot be
  enabled.
- **One service instance per data directory.** Never mount the same writable data
  directory into two running services (spec §3.1). The CLI may open it while the service
  runs.
- The service creates the directory with mode 0700 and the database with mode 0600 if
  they do not exist. Keep the volume readable only by the service user.

## Logging

| Variable              | Default | Meaning                                                                                              |
| --------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `UNIFI_MCP_LOG_LEVEL` | `info`  | Minimum log level: `debug`, `info`, `warn` or `error`. Any other value stops the service at startup. |

Log format, redaction and the audit trail are described in [monitoring.md](monitoring.md).

## Master encryption key

Credentials stored by the service (UniFi API keys, later also TOTP secrets) are encrypted
with AES-256-GCM using a key derived from the **master key**. The master key is never
stored in the database. The service will not start without it.

| Variable                    | Meaning                                                                                                                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNIFI_MCP_MASTER_KEY_FILE` | **Preferred.** Path to a file containing the key (a Docker secret or read-only mount)                                                                                                                           |
| `UNIFI_MCP_MASTER_KEY`      | Fallback: the key itself. Less isolated: environment variables are visible to anyone who can inspect the container's configuration. The service removes the variable from its own environment after reading it. |

Set exactly one of them. Setting both, or neither, stops the service at startup.

### Creating a key

The key is 32 random bytes written as standard base64 (44 characters ending in `=`):

```sh
mkdir -p secrets
(umask 077 && openssl rand -base64 32 > secrets/unifi_mcp_master_key)
chmod 0400 secrets/unifi_mcp_master_key
```

`unifi-mcp crypto generate-key` (CLI, not yet available) will do the same, writing the
file with mode 0400 and refusing to overwrite an existing file. Mount the file read-only into the container, for example as a
Docker secret at `/run/secrets/unifi_mcp_master_key`, and set
`UNIFI_MCP_MASTER_KEY_FILE` to that path (see `.env.example`). The service warns if the
file is readable by group or other users.

Rules:

- **Create the key once, before the first start.** On first start the service records the
  key's identifier in the new database. From then on it only starts with that key.
- **Never generate a new key for an existing database.** The service refuses a different
  key and changes nothing. Stored credentials cannot be decrypted without the original
  key.
- **Back the key up separately from database backups**, for example offline. A database
  backup alone cannot restore credentials, by design. See
  [backup-restore.md](backup-restore.md).
- Do not commit key files. `.gitignore` excludes `secrets/`, `master.key` and `*.key`.

### Key identifier

Every key has a public identifier: 32 hexadecimal characters derived from the key with
HKDF-SHA256. It reveals nothing about the key. Key errors and backup results show it, so
you can tell which key file belongs to which database or backup.

### Startup failures

| Error code                       | Meaning                                                                   | What to do                                                                          |
| -------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `MASTER_KEY_NOT_CONFIGURED`      | Neither variable is set                                                   | Configure the key. For an existing installation, use its original key file.         |
| `MASTER_KEY_CONFLICTING_SOURCES` | Both variables are set                                                    | Remove one; prefer the file.                                                        |
| `MASTER_KEY_UNREADABLE`          | The file is missing, unreadable or not a regular file                     | Fix the mount or path and permissions.                                              |
| `MASTER_KEY_INVALID`             | Not 32 bytes of base64, a placeholder value, or an oversized file         | Use the original key file. For a new installation, create a key as above.           |
| `MASTER_KEY_MISMATCH`            | The key is not the one this database uses (both identifiers are shown)    | Provide the original key file. Do not generate a new one.                           |
| `KEY_STATE_INCONSISTENT`         | Key records in the database were modified outside the service             | Restore the database from a backup.                                                 |
| `DATABASE_CORRUPT`               | The startup integrity check failed                                        | Restore from a backup.                                                              |
| `NOT_A_UNIFI_MCP_DATABASE`       | The data directory holds another application's SQLite file                | Point `UNIFI_MCP_DATA_DIR` at the right directory.                                  |
| `SCHEMA_NEWER_THAN_SOFTWARE`     | The database was written by a newer release                               | Upgrade, or restore a backup taken with this release. Downgrades are not supported. |
| `MIGRATION_HISTORY_MISMATCH`     | An applied migration differs from this build                              | Use the matching release or restore a backup.                                       |
| `MIGRATION_FAILED`               | A schema upgrade failed; it was rolled back and the database is unchanged | Keep the previous release running and report the error.                             |
