# Backup, restore and key rotation

> **Status:** the storage behaviour and the operator commands (`unifi-mcp db …`,
> `unifi-mcp crypto …`) described here are implemented and tested (`packages/storage`,
> ADR 0007; `packages/cli`, ADR 0015). The procedures on this page are also run as a
> drill, through the CLI and against the container image: backup, restore, a hard kill, a
> corrupted database and a key rotation ([Drills](#drills)). With Docker, run the commands
> as shown in [installation.md](installation.md#maintenance-with-the-service-stopped):
> `docker compose exec unifi-mcp unifi-mcp …` while the service runs, and
> `docker compose run --rm --no-deps --entrypoint unifi-mcp unifi-mcp …` once it is
> stopped.

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
  backup fails, the upgrade does not run and the service does not start.

### Listing and pruning

`unifi-mcp db backups` lists every backup file with its kind, time and size. `doctor`
shows how many there are.

The service never deletes a backup by itself. Automatic backups (`pre-migration`,
`pre-rotation`, and the `pre-restore` databases described below) accumulate until you
prune them:

```sh
unifi-mcp db prune-backups --keep 5 --dry-run   # shows what would be deleted
unifi-mcp db prune-backups --keep 5             # asks you to type "prune"
```

This keeps the newest 5 of each automatic kind and deletes the older ones. It never
deletes a `manual` backup or a file it does not recognise, and it is recorded in the
audit trail. Before pruning `pre-rotation` backups, remember that each needs the key that
was active before that rotation. `doctor` warns when more than 20 automatic backups have
accumulated.

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
the data directory (with `-2`, `-3` and so on if that name is taken, so an earlier one is
never replaced). Delete it once you have confirmed the restore, or let
`db prune-backups` do it.

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

## Drills

A backup you have never restored is a hope, not a backup. The project runs these
procedures as tests, and you can run them too, on a copy:

| Drill                                                                                             | Where                                                 |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Back up; lose a console, a client and an administrator's second step; restore; every secret works | `tests/integration-mock/backup-restore-drill.test.ts` |
| A damaged backup, and a backup under another key, are refused and change nothing                  | the same                                              |
| Rotate the key; the new key opens everything; old backups need the retired key                    | the same                                              |
| In the container image: backup while running; offline operations refused until the service stops  | `tests/container-network/drill.test.ts`               |
| In the image: restore with a one-off container; the same client token works afterwards            | the same                                              |
| In the image: the container is killed; the next start is healthy and the audit chain is intact    | the same                                              |
| In the image: a corrupted database stops the start (`DATABASE_CORRUPT`); a restore repairs it     | the same                                              |
| In the image: after a rotation, the old key does not start the service (`MASTER_KEY_MISMATCH`)    | the same                                              |

To try a restore yourself without touching the live service, copy a backup and the
matching key file to another machine or directory, point `UNIFI_MCP_DATA_DIR` and
`UNIFI_MCP_MASTER_KEY_FILE` at the copies, and run `unifi-mcp db check --backup <file>`,
then `unifi-mcp db restore <file>` and `unifi-mcp doctor`.

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
