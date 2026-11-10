/**
 * One service per data directory (ADR 0015): an exclusive lock that the operating system
 * releases when its holder exits, including after SIGKILL.
 */
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import {
  acquireInstanceLock,
  INSTANCE_LOCK_FILENAME,
  isStorageError,
} from '@unifi-local-mcp/storage';
import { describe, expect, it } from 'vitest';
import { useTempDirs } from './fixtures.ts';

const tempDir = useTempDirs();

function expectInUse(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(isStorageError(error, 'DATA_DIRECTORY_IN_USE')).toBe(true);
    expect((error as Error).message).toContain('Cannot rotate the master key');
    return;
  }
  throw new Error('expected DATA_DIRECTORY_IN_USE');
}

/** Starts a separate Node process that holds the lock until it is killed. */
async function holdInChild(dataDir: string) {
  const script = `
    import { acquireInstanceLock } from '@unifi-local-mcp/storage';
    acquireInstanceLock(process.argv[1], 'test');
    process.stdout.write('held\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, dataDir], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const [chunk] = (await once(child.stdout, 'data')) as [Buffer];
  expect(chunk.toString()).toBe('held\n');
  return child;
}

describe('acquireInstanceLock', () => {
  it('is exclusive, releasable, and creates a private lock file', async () => {
    const dataDir = join(await tempDir(), 'data');
    const lock = acquireInstanceLock(dataDir, 'start the service');
    expect((await stat(join(dataDir, INSTANCE_LOCK_FILENAME))).mode & 0o777).toBe(0o600);
    expectInUse(() => acquireInstanceLock(dataDir, 'rotate the master key'));
    lock.release();
    lock.release(); // idempotent
    acquireInstanceLock(dataDir, 'rotate the master key').release();
  });

  it('is held across processes and released when the holder is killed', async () => {
    const dataDir = join(await tempDir(), 'data');
    const child = await holdInChild(dataDir);
    try {
      expectInUse(() => acquireInstanceLock(dataDir, 'rotate the master key'));
    } finally {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
    acquireInstanceLock(dataDir, 'start the service').release();
  });
});
