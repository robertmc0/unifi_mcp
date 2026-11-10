/**
 * The container health probe (Dockerfile HEALTHCHECK; ADR 0017).
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempDirs } from '../unit/storage/fixtures.ts';
import { startTestService } from './fixtures.ts';

const tempDir = useTempDirs();
const PROBE = join(import.meta.dirname, '../../packages/mcp-server/src/healthcheck.ts');

/** Runs the probe asynchronously: the service under test lives in this process. */
async function probe(env: NodeJS.ProcessEnv): Promise<number | null> {
  const child = spawn(process.execPath, [PROBE], {
    env: { PATH: process.env['PATH'], ...env },
    stdio: 'ignore',
  });
  const [code] = (await once(child, 'exit')) as [number | null];
  return code;
}

describe('healthcheck.ts', () => {
  it('exits 0 while the service answers /livez and 1 when nothing listens', async () => {
    const t = await startTestService({ dir: await tempDir() });
    const port = new URL(t.service.url).port;
    expect(await probe({ UNIFI_MCP_HTTP_PORT: port })).toBe(0);
    expect(await probe({ UNIFI_MCP_HTTP_PORT: port, UNIFI_MCP_HTTP_BIND: '0.0.0.0' })).toBe(0);
    await t.service.stop();
    expect(await probe({ UNIFI_MCP_HTTP_PORT: port })).toBe(1);
  });
});
