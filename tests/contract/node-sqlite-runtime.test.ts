/**
 * Runtime contract for the `node:sqlite` type-definition gap (ADR 0004, comment in
 * packages/storage/src/sqlite.ts). @types/node 26.6.6 declares only `DatabaseSync`;
 * the storage port uses `Database` through a local type augmentation that is correct only
 * while the runtime exports `Database` as the same class. If this test fails, the
 * augmentation is wrong and the storage port must be revisited before upgrading Node.
 *
 * This is the one place outside packages/storage that imports `node:sqlite`, and only to
 * check the runtime surface, never to use it.
 */
import * as sqlite from 'node:sqlite';
import { describe, expect, it } from 'vitest';

describe('node:sqlite runtime surface used by the storage port', () => {
  it('exports Database as the same class as DatabaseSync', () => {
    const runtime = sqlite as unknown as Record<string, unknown>;
    expect(typeof runtime['Database']).toBe('function');
    expect(runtime['Database']).toBe(sqlite.DatabaseSync);
  });

  it('exports the online backup function', () => {
    expect(typeof sqlite.backup).toBe('function');
  });

  it('runs on the pinned SQLite major version', () => {
    expect(process.versions['sqlite']).toMatch(/^3\./);
  });
});
