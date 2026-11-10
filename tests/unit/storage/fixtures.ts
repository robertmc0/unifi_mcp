/**
 * Shared helpers for storage tests. Keys are synthetic and derived from fixed labels;
 * no real credentials are used anywhere in the test suite.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  columnBlob,
  MasterKey,
  StorageError,
  type SqliteDatabase,
  type StorageErrorCode,
} from '@unifi-local-mcp/storage';
import { afterEach, expect } from 'vitest';

export const FIXED_NOW = new Date('2026-11-10T03:15:00.000Z');
export const fixedNow = (): Date => FIXED_NOW;

/** 32 deterministic bytes for a synthetic test key. */
export function testKeyBytes(label: string): Buffer {
  return createHash('sha256').update(`unifi-local-mcp synthetic test key: ${label}`).digest();
}

export function testKeyText(label: string): string {
  return testKeyBytes(label).toString('base64');
}

export function testKey(label: string): MasterKey {
  return MasterKey.fromBytes(testKeyBytes(label));
}

/** Registers per-test temporary directories that are removed after each test. */
export function useTempDirs(): () => Promise<string> {
  const created: string[] = [];
  afterEach(async () => {
    await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  return async () => {
    const dir = await mkdtemp(join(tmpdir(), 'unifi-mcp-test-'));
    created.push(dir);
    return dir;
  };
}

export function expectStorageError(fn: () => unknown, code: StorageErrorCode): StorageError {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `expected StorageError ${code}`).toBeInstanceOf(StorageError);
  expect((thrown as StorageError).code).toBe(code);
  return thrown as StorageError;
}

export async function expectStorageErrorAsync(
  promise: Promise<unknown>,
  code: StorageErrorCode,
): Promise<StorageError> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `expected StorageError ${code}`).toBeInstanceOf(StorageError);
  expect((thrown as StorageError).code).toBe(code);
  return thrown as StorageError;
}

export async function fileMode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

export async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

/** Overwrites one page in the middle of a closed database file with junk bytes. */
export async function corruptMiddlePage(path: string, pageSize = 4096): Promise<void> {
  const size = (await stat(path)).size;
  const pages = Math.floor(size / pageSize);
  if (pages < 3) throw new Error(`Database too small to corrupt safely (${String(pages)} pages).`);
  const handle = await open(path, 'r+');
  try {
    await handle.write(Buffer.alloc(pageSize, 0xa5), 0, pageSize, Math.floor(pages / 2) * pageSize);
  } finally {
    await handle.close();
  }
}

/** Flips one bit of a secret record's envelope directly in the database. */
export function tamperEnvelope(db: SqliteDatabase, recordId: string, byteIndex = -1): void {
  const row = db.get('SELECT envelope FROM secret_records WHERE id = ?', [recordId]);
  if (row === undefined) throw new Error(`No secret record ${recordId}.`);
  const envelope = Buffer.from(columnBlob(row, 'envelope'));
  const index = byteIndex < 0 ? envelope.length + byteIndex : byteIndex;
  envelope.writeUInt8((envelope.readUInt8(index) ^ 0x01) & 0xff, index);
  db.run('UPDATE secret_records SET envelope = ? WHERE id = ?', [envelope, recordId]);
}

export async function writeTextFile(path: string, text: string, mode = 0o600): Promise<void> {
  await writeFile(path, text, { mode });
}
