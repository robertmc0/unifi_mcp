# 0007. Storage: secret encryption, master key handling, migrations and backups

- Status: Accepted
- Date: 2026-11-10
- Phase: 1
- Spec references: §2 (decisions 15, 27), §8.2, §10, §12, §17 (Security, Reliability)

## Context

Spec §8.2 requires embedded SQLite with transactional migrations, integrity checks and
safe backups; AEAD encryption of credential-bearing fields (random nonce per record,
associated data binding type and record id, versioned format, key identifier); a master
key stored outside the database that fails closed when missing or wrong and is never
silently regenerated; and key rotation that keeps the old key usable until every record is
re-encrypted and verified. §17 makes "master key not in database; missing/wrong key fails
closed" and "SQLite restart, migration, key rotation and backup/restore are tested"
release-blocking. ADR 0004 fixed the driver (`node:sqlite`) and the storage port. This ADR
records the formats and procedures built on it in `packages/storage`.

## Decision

### Master key

- 32 random bytes, stored as standard base64 text (44 characters, optional trailing
  newline). `openssl rand -base64 32` produces the same format.
- Sources: `UNIFI_MCP_MASTER_KEY_FILE` (preferred: Docker secret or read-only file) or
  `UNIFI_MCP_MASTER_KEY` (fallback, less isolated). After reading, the inline variable is
  deleted from the process environment. Both set: error. Neither set: error. Malformed,
  short, single-repeated-byte (placeholder) or oversized (> 4 KiB file) keys: error.
  Errors never include key material or file contents. A key file accessible by group or
  others produces a warning.
- Nothing generates a key implicitly. The only generator writes a new file with mode 0400
  and refuses to overwrite an existing file.

### Key derivation and identifiers

HKDF-SHA256 over the master key, salt `unifi-local-mcp/master-key/v1`:

| `info` label                 | Output   | Use                                                    |
| ---------------------------- | -------- | ------------------------------------------------------ |
| `key-id`                     | 16 bytes | Public key identifier (32 hex chars), stored in the DB |
| `secret-records/aes-256-gcm` | 32 bytes | AES-256-GCM key for secret records                     |

The master key bytes are never used directly and never stored. The identifier reveals
nothing about the key, lets operators match key files to databases and backups, and makes
a wrong key detectable before any decryption. Future uses get their own `info` label.

### Envelope format (version 1)

`version (1 byte = 0x01) ‖ key id (16) ‖ nonce (12, random) ‖ ciphertext ‖ GCM tag (16)`.
Associated data: `"unifi-local-mcp/secret-record\0" ‖ header (17 bytes) ‖ u32be length ‖
kind ‖ u32be length ‖ record id`. Changing any byte, moving an envelope to another record
or changing its kind makes decryption fail. Random 96-bit nonces are safe at this volume
(far below 2^32 encryptions per key).

### Key binding and rotation

- Table `crypto_keys` holds key **identifiers** with status `active` or `retired`, and at
  most one active key (partial unique index). `secret_records` references its key id.
- Opening an existing database verifies the configured key against the active id
  **before any write**, including before migrations and pre-migration backups. A mismatch
  fails with `MASTER_KEY_MISMATCH` and changes nothing.
- A key is registered only when `crypto_keys` and `secret_records` are both empty. Any
  other state without an active key, or records under a non-active key, fails with
  `KEY_STATE_INCONSISTENT`.
- Rotation is offline and runs in one transaction: decrypt each record with the current
  key, seal it with the new key, re-verify every new envelope against the plaintext
  digest and the record count, retire the old id, activate the new one. Any failure rolls
  everything back. Previously used keys cannot be reactivated. Secret writes are
  conditional on the writer's key still being active, so a process that kept running
  across a rotation cannot seal records with the retired key.

### Migrations

Forward-only, numbered 1..n without gaps, never edited once released. Each applied
migration's SHA-256 is recorded in `schema_migrations`. All pending migrations,
their history rows, `PRAGMA user_version` and a `PRAGMA foreign_key_check` run in one
`BEGIN IMMEDIATE` transaction, so a failure leaves the database unchanged. The file is
marked with `PRAGMA application_id = 0x554d4350` ("UMCP"). A database with an altered
history, a newer schema or a foreign application id is refused. Opening an existing
database with pending migrations first takes a verified backup to
`backups/pre-migration-v<from>-to-v<to>-<timestamp>.db`. `crypto_keys(key_id, status)` and
`secret_records(id, kind, key_id, envelope)` must stay readable by the key checks at every
schema version.

### Connection settings and files

WAL with `synchronous=FULL` (approval and execution state transitions must survive power
loss, spec §10); `busy_timeout` 5000 ms; foreign keys on; `defensive` (refuses
`writable_schema`); `trusted_schema=OFF`; `secure_delete=ON` (deleted envelopes are
overwritten); `temp_store=MEMORY` (no temporary files with row data);
`journal_size_limit` 64 MiB. The database file is created with mode 0600 before SQLite
opens it, so `-wal`/`-shm` inherit 0600; the data directory is created with mode 0700. The
data directory must be on a local filesystem (WAL does not work on network filesystems).

### Backup and restore

- Backup: SQLite online backup API into a temporary file, switched to a single-file
  journal mode, full integrity check, fsync, then rename to a destination that must not
  exist. Mode 0600. A backup contains encrypted records but never the key.
- Restore (offline): copy the backup to a private staging file next to the database and
  validate it (SQLite header, full integrity check, application id, known migration
  history, active key id equals the configured key, every secret record decrypts). Then
  refuse with `DATABASE_IN_USE` if another connection has the live database open
  (detected because leaving WAL mode needs exclusive access), move the old database and any
  `-wal`/`-shm`/`-journal` files aside to `<db>.pre-restore-<timestamp>`, and rename the
  staging copy into place. Older schemas are allowed; they are migrated (with a
  pre-migration backup) on next start.

### Redaction

Decrypted values are returned as `SecretValue`, which renders as `[REDACTED]` in `String()`,
JSON, `util.inspect` and implicit conversion. Only `reveal()` returns the value.

## Evidence (verified 2026-11-10, Node.js 26.13.0, SQLite 3.54.0, linux/amd64)

- Pre-creating the database with mode 0600 gives `-wal` and `-shm` mode 0600.
- `defensive: true` rejects `UPDATE sqlite_schema` after `PRAGMA writable_schema = ON`.
- `PRAGMA journal_mode = DELETE` fails with `SQLITE_BUSY` ("database is locked") while
  another connection has the database open, and succeeds when it is the only connection.
- `PRAGMA max_page_count` reproduces `SQLITE_FULL`; the failing transaction is rolled back.
- `@types/node@26.6.6` declares only `DatabaseSync`. The runtime exports `Database`
  (`DatabaseSync === Database`), and `node --trace-deprecation` prints no warning for
  either. `packages/storage/src/sqlite.ts` adds a minimal type augmentation for
  `Database`; it will conflict, and should then be deleted, once `@types/node` declares it.
- Tests: `tests/unit/storage/*.test.ts` and `tests/security/storage-master-key.test.ts`
  (77 tests). Mutation checks: removing the key comparison, the migration transaction, the
  associated data, the restore in-use check, the startup integrity check, the
  active-key write condition or restore-time decryption each makes at least one test fail.

## Consequences

- Rotation and restore are offline operations: stop the service first. The in-use check
  has a small race window between the check and the rename. The host administrator is
  trusted (spec §3.1), and the documented procedure is to stop the service.
- Operators must back up the master key separately from database backups and keep retired
  keys for as long as backups sealed with them are retained (docs/backup-restore.md).
- A lost master key makes stored credentials unrecoverable by design. Recovery means a new
  data directory and re-entering credentials.
- JavaScript strings cannot be zeroed. Key bytes are held in `KeyObject`s and plaintext
  buffers are zero-filled after use, but plaintext strings returned by `reveal()` and the
  key text read from a file or variable live until garbage collection.
- The migration runner does not support migrations that must disable foreign keys (table
  rebuilds). Such a migration needs an amendment to this ADR first.
- One service instance per data directory remains a deployment rule; the CLI may open the
  same database concurrently (WAL plus busy timeout). A single-instance lease is not part
  of the storage package.

## Re-evaluation triggers

- A requirement for an external KMS/HSM or per-record data keys (envelope v2).
- A `node:sqlite` change affecting backup, journal-mode or busy-handler behaviour (ADR 0004).
- Storage tests failing on `linux/arm64` (to be run with the container build).
