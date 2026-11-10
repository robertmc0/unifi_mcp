/**
 * @unifi-local-mcp/storage
 *
 * SQLite persistence (`node:sqlite`, ADR 0004), atomic migrations, AEAD-encrypted secret
 * records under an external master key, online backup and validated restore (ADR 0007).
 * No other package imports `node:sqlite` directly.
 */
export {
  backupDatabase,
  restoreDatabase,
  verifyBackup,
  type BackupResult,
  type BackupVerification,
  type RestoreResult,
} from './backup.ts';
export { isStorageError, StorageError, type StorageErrorCode } from './errors.ts';
export { readActiveKeyId, rotateMasterKey, type RotationResult } from './keys.ts';
export {
  loadMasterKey,
  MASTER_KEY_ENV,
  MASTER_KEY_FILE_ENV,
  MasterKey,
  readMasterKeyFile,
  writeNewMasterKeyFile,
  type LoadedMasterKey,
} from './master-key.ts';
export {
  APPLICATION_ID,
  migrate,
  MIGRATIONS,
  readSchemaState,
  type Migration,
  type MigrationResult,
  type SchemaState,
} from './migrations.ts';
export { SecretStore, SecretValue } from './secrets.ts';
export {
  columnBlob,
  columnInteger,
  columnOptionalText,
  columnText,
  SqliteDatabase,
  type IntegrityReport,
  type OpenDatabaseOptions,
  type Row,
  type RunResult,
  type SqlParams,
  type SqlValue,
} from './sqlite.ts';
export {
  BACKUP_DIRECTORY_NAME,
  DATABASE_FILENAME,
  databasePathFor,
  openStorage,
  type OpenStorageOptions,
  type Storage,
} from './storage.ts';
