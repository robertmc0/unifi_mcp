# Backup, restore and key rotation

> **Status: Phase 1 in progress.** The storage behaviour and the operator commands
> (`unifi-mcp db …`, `unifi-mcp crypto …`) described here are implemented and tested
> (`packages/storage`, ADR 0007; `packages/cli`, ADR 0015). Docker commands for the
> offline steps follow with the container packaging (Phase 1 step 11).

## What needs backing up

| Item                | Where                                          | Notes                                                                                                                                          |
| ------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Database            | `$UNIFI_MCP_DATA_DIR/unifi-mcp.db`             | Settings, encrypted credentials, approvals, audit metadata. Use the backup procedure below: copying the file of a running service is not safe. |
| Master key          | The file `UNIFI_MCP_MASTER_KEY_FILE` points to | **Back it up separately**, for example offline. Without it, stored credentials cannot be decrypted.                                            |
| Retired master keys | Your key archive                               | Keep each retired key as long as you keep backups taken while it was active.                                                                   |

A database backup never contains the master key. Someone who obtains a backup without the
key cannot read the stored credentials, but the backup still holds audit metadata and
configuration: protect it (backups are written with mode 0600).

Note each backup's **key identifier** (shown by the backup command) with the backup, so
you know which key file restores it.

## Backups

A backup is a single SQLite file made with SQLite's online backup API. It is consistent
even while the service is running, and it includes changes not yet checkpointed from the
WAL. Each backup is integrity-checked before it is kept, and a backup never overwrites an
existing file.

- **Manual backup:** `unifi-mcp db backup [--out <file>]`, safe while the service runs.
  The default file is `$UNIFI_MCP_DATA_DIR/backups/manual-<UTC timestamp>.db`. The command
  prints the backup's SHA-256, size, schema version and key identifier, and records the
  backup in the audit trail.
- **Automatic pre-rotation backup:** `crypto rotate-key` first writes
  `backups/pre-rotation-<UTC timestamp>.db`, which needs the **old** key.
- **Automatic pre-migration backup:** when a new release needs to upgrade the database
  schema, the service first writes
  `$UNIFI_MCP_DATA_DIR/backups/pre-migration-v<from>-to-v<to>-<UTC timestamp>.db`. If that
  backup fails, the upgrade does not run and the service does not start. These files are
  not pruned automatically yet; delete old ones when you no longer need them.

## Verifying a backup

A backup can be verified without changing it or the live database, using the same checks
as a restore (below). Verification reports the schema version, the key identifier and the
number of encrypted records:

- `unifi-mcp db check --backup <file>` verifies a backup file.
- `unifi-mcp db check` checks the live database read-only, also while the service runs: a
  full integrity check, the master key, decryption of every credential, and the audit
  chain. It exits 1 if anything is wrong.

## Restore

Restore replaces the live database with a backup. It is an offline operation.

1. Stop the service.
2. Make sure the configured master key is the key that was active when the backup was
   taken.
3. Run `unifi-mcp db restore <file>`. Type `restore` to confirm, or pass `--yes`.
4. Start the service. If the backup is from an older release, the service upgrades it,
   taking a pre-migration backup first.

Before anything is replaced, the restore validates a private copy of the backup:

- it is a SQLite file and passes a full integrity check;
- it is a unifi-local-mcp database whose migration history this release knows (backups
  from newer releases are refused);
- its active key identifier equals the configured key's identifier;
- every encrypted record decrypts and authenticates with that key.

If any check fails, the restore stops with `RESTORE_REJECTED` and nothing changes. While
the service runs, the restore is refused with `DATA_DIRECTORY_IN_USE`. If another process
still has the database open, it stops with `DATABASE_IN_USE`. In both cases nothing
changes. The restore is recorded in the restored database's audit trail.

The database that was replaced is kept as `unifi-mcp.db.pre-restore-<UTC timestamp>` in
the data directory. Delete it once you have confirmed the restore.

## Master key rotation

Rotate the key if it may have been exposed, or on your own schedule. Rotation is an
offline operation.

1. Stop the service.
2. Create a new key file: `unifi-mcp crypto generate-key --out <new key file>`.
3. With the current key still configured, run
   `unifi-mcp crypto rotate-key --new-key-file <new key file>` and type `rotate` to
   confirm. It first writes a verified backup (`backups/pre-rotation-…`), which needs the
   **current** key.
4. Point `UNIFI_MCP_MASTER_KEY_FILE` at the new key and start the service.
5. Archive the old key for as long as you keep backups that need it.

Rotation re-encrypts every record in one transaction and verifies each one (and the
record count) before committing. If anything fails, nothing changes and the current key
stays valid. A key that was used before cannot be reactivated. The rotation and its audit
entry are committed together. While the service runs, rotation is refused with
`DATA_DIRECTORY_IN_USE`.

## Disaster recovery

| Situation                                     | Recovery                                                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Database lost or corrupt (`DATABASE_CORRUPT`) | Restore the latest backup with its key.                                                                                                                            |
| Failed upgrade (`MIGRATION_FAILED`)           | The database is unchanged; keep running the previous release and report the error.                                                                                 |
| Bad upgrade discovered after migrating        | Stop, reinstall the previous release, restore the matching `backups/pre-migration-…` file.                                                                         |
| Master key lost                               | Stored credentials are unrecoverable by design. Start with a new data directory and a new key, and re-enter the UniFi API keys and other credentials.              |
| Master key possibly exposed                   | Rotate the master key. If a copy of the database or a backup may also have been exposed, treat the stored UniFi API keys as compromised and replace them in UniFi. |
| Disk full (`STORAGE_FULL`)                    | Database writes fail and are rolled back; nothing is half-written. Free space on the data volume.                                                                  |

## Error codes

| Code                    | Meaning                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `BACKUP_FAILED`         | The backup could not be written or did not pass its integrity check (the source database may be damaged). No partial file is left behind. |
| `RESTORE_REJECTED`      | The backup failed validation; the message names the check. Nothing was changed.                                                           |
| `DATABASE_IN_USE`       | Another process has the database open. Stop the service and retry.                                                                        |
| `DATA_DIRECTORY_IN_USE` | The service (or another maintenance command) is using the data directory. Stop the service and retry.                                     |
