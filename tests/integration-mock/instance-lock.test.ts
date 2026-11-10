/**
 * The service holds its data directory exclusively (ADR 0015): a second service cannot start
 * on it, and key rotation and restore are refused while it runs.
 */
import { join } from 'node:path';
import { loadServiceConfig, startService } from '@unifi-local-mcp/mcp-server';
import { isStorageError } from '@unifi-local-mcp/storage';
import { describe, expect, it } from 'vitest';
import { testKey, useTempDirs } from '../unit/storage/fixtures.ts';
import { inventory } from '../unit/core/fixtures.ts';
import { OPERATIONS } from './fixtures.ts';

const tempDir = useTempDirs();

describe('service instance lock', () => {
  it('refuses a second service on the same data directory until the first stops', async () => {
    const dir = await tempDir();
    const base = loadServiceConfig({ UNIFI_MCP_DATA_DIR: join(dir, 'data') });
    const options = {
      config: { ...base, http: { ...base.http, port: 0 } },
      masterKey: testKey('service'),
      operations: OPERATIONS,
      inventory,
      logSink: { write: () => undefined },
    };
    const first = await startService(options);
    const second = startService(options);
    await expect(second).rejects.toSatisfy((error) =>
      isStorageError(error, 'DATA_DIRECTORY_IN_USE'),
    );
    await first.stop();
    const third = await startService(options);
    await third.stop();
  });
});
