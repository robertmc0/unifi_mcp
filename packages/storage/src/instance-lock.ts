/**
 * One running service per data directory (ADR 0015).
 *
 * The service holds `instance.lock` in its data directory for its whole lifetime. A second
 * service on the same directory refuses to start, and host maintenance that must not run
 * beside the service (master key rotation, restore) takes the same lock and is refused while
 * the service runs. The lock is released by the operating system when the holder exits, so
 * a crashed service never leaves a stale lock behind.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { StorageError } from './errors.ts';
import { tryLockFile, type FileLock } from './sqlite.ts';

export const INSTANCE_LOCK_FILENAME = 'instance.lock';

export type InstanceLock = FileLock;

/**
 * Takes the data-directory lock or throws `DATA_DIRECTORY_IN_USE`. `purpose` completes the
 * error message, for example "start the service" or "rotate the master key".
 */
export function acquireInstanceLock(dataDir: string, purpose: string): InstanceLock {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lock = tryLockFile(join(dataDir, INSTANCE_LOCK_FILENAME));
  if (lock === undefined) {
    throw new StorageError(
      'DATA_DIRECTORY_IN_USE',
      `Cannot ${purpose}: a unifi-mcp service or maintenance command is using ${dataDir}. ` +
        'Stop the service first (and wait for other maintenance commands to finish).',
    );
  }
  return lock;
}
