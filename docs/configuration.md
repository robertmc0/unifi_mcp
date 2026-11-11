# Configuration

> **Status: Phase 1 complete.** This page covers the settings implemented so far: the
> hard lock, the MCP listener, audit retention, the egress allowlist, the data directory,
> logging and the master encryption key. The bootstrap YAML file, policy and runtime mode
> are managed with the CLI ([administration.md](administration.md)).

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

## MCP listener

| Variable                                                      | Default     | Meaning                                                                                                          |
| ------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `UNIFI_MCP_HTTP_BIND`                                         | `127.0.0.1` | Listener address (an IP address or `localhost`).                                                                 |
| `UNIFI_MCP_HTTP_PORT`                                         | `3000`      | Listener port.                                                                                                   |
| `UNIFI_MCP_HTTP_TLS_CERT_FILE`, `UNIFI_MCP_HTTP_TLS_KEY_FILE` | unset       | Serve HTTPS with this certificate and key (PEM). Set both or neither.                                            |
| `UNIFI_MCP_HTTP_ALLOW_PLAINTEXT`                              | `false`     | Allow plaintext HTTP on a non-loopback bind, only when a TLS proxy or loopback-only port publishing protects it. |
| `UNIFI_MCP_HTTP_ALLOWED_HOSTS`                                | unset       | Extra host names accepted in the `Host` header, comma-separated (local names are always accepted).               |
| `UNIFI_MCP_HTTP_ALLOWED_ORIGINS`                              | unset       | Extra browser origin host names accepted, comma-separated.                                                       |

See [networking.md](networking.md) for when to use which.

## Admin listener

The optional admin web interface (ADR 0016). It is off by default and never needed for
normal operation.

| Variable                                                        | Default     | Meaning                                                                                             |
| --------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| `UNIFI_MCP_ADMIN_ENABLED`                                       | `false`     | Start the admin listener.                                                                           |
| `UNIFI_MCP_ADMIN_BIND`                                          | `127.0.0.1` | Listener address (an IP address or `localhost`).                                                    |
| `UNIFI_MCP_ADMIN_PORT`                                          | `3001`      | Listener port. Must differ from `UNIFI_MCP_HTTP_PORT`.                                              |
| `UNIFI_MCP_ADMIN_TLS_CERT_FILE`, `UNIFI_MCP_ADMIN_TLS_KEY_FILE` | unset       | Serve HTTPS with this certificate and key (PEM), separate from the MCP certificate.                 |
| `UNIFI_MCP_ADMIN_ALLOW_PLAINTEXT`                               | `false`     | Allow plaintext HTTP on a non-loopback bind (Docker with host-loopback publishing, or a TLS proxy). |
| `UNIFI_MCP_ADMIN_ALLOWED_HOSTS`                                 | unset       | Extra host names accepted in the `Host` header (local names are always accepted).                   |
| `UNIFI_MCP_ADMIN_SESSION_IDLE_MINUTES`                          | `30`        | A session unused for this long ends (5–480).                                                        |
| `UNIFI_MCP_ADMIN_SESSION_MAX_HOURS`                             | `12`        | A session ends this long after sign-in (1–72).                                                      |

## Audit retention

| Variable                         | Default | Meaning                                                                  |
| -------------------------------- | ------- | ------------------------------------------------------------------------ |
| `UNIFI_MCP_AUDIT_RETENTION_DAYS` | `90`    | Audit entries older than this are deleted at startup and daily (1–3650). |

## Egress allowlist

| Variable                       | Default                                                          | Meaning                                                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `UNIFI_MCP_EGRESS_ALLOW_CIDRS` | `10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,fc00::/7` | Comma-separated networks the service may connect to. When set, it replaces the default. A malformed entry stops the service at startup. |

Narrow it to the networks your consoles are actually on, for example
`192.168.1.0/24,10.8.0.0/24`. Loopback and link-local addresses are not allowed by default.
Cloud metadata (`169.254.169.254`), multicast and unspecified addresses are refused even if
listed. See [security.md](security.md#connections-to-consoles).

## Data directory

| Variable             | Default | Meaning                                           |
| -------------------- | ------- | ------------------------------------------------- |
| `UNIFI_MCP_DATA_DIR` | `/data` | Persistent directory for the database and backups |

Contents:

| Path                              | What it is                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `unifi-mcp.db` (+ `-wal`, `-shm`) | The SQLite database (WAL mode). Mode 0600.                                                                                              |
| `backups/`                        | Pre-migration, pre-rotation and manual backups (see [backup-restore.md](backup-restore.md))                                             |
| `unifi-mcp.db.pre-restore-*`      | The database a restore replaced, kept for you to inspect or delete                                                                      |
| `instance.lock`                   | Held by the running service so that only one uses this directory. Mode 0600. Never delete it while the service runs; it is never stale. |

Requirements:

- **Local filesystem only** (a Docker volume or local disk). SQLite WAL mode does not work
  on NFS, SMB or other network filesystems; the service refuses to start if WAL cannot be
  enabled.
- **One service instance per data directory.** Never mount the same writable data
  directory into two running services (spec §3.1). The service enforces this: a second
  service on the same directory exits with `DATA_DIRECTORY_IN_USE`. The CLI may open the
  directory while the service runs, except for master key rotation and restore (see
  [administration.md](administration.md)).
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

`unifi-mcp crypto generate-key --out <file>` does the same, writing the file with mode
0400 and refusing to overwrite an existing file. Mount the file read-only into the container, for example as a
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
