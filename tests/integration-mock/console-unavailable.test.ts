/**
 * Health checks and shutdown while a console is unavailable (spec §17 "health checks and
 * graceful shutdown work with disconnected/unavailable consoles"; ADR 0008, ADR 0013): a
 * console that does not answer, or cannot be reached at all, makes requests to it fail,
 * never the service. The service stays ready, and stops promptly with a request still
 * waiting for a silent console.
 */
import { describe, expect, it } from 'vitest';
import { useTempDirs } from '../unit/storage/fixtures.ts';
import { connect, startTestService, structured } from './fixtures.ts';

const tempDir = useTempDirs();

const ready = async (url: string): Promise<number> => (await fetch(new URL('/readyz', url))).status;

const info = (consoleId: string) => ({
  name: 'unifi_execute',
  arguments: { operationId: 'network.info.get', consoleId },
});

describe('an unavailable console', () => {
  it('that cannot be reached fails its requests, and the service stays ready', async () => {
    const t = await startTestService({ dir: await tempDir() });
    const client = await connect(t.mcpUrl, t.token('reader', ['network.*.read']));
    await t.mock.stop(); // nothing listens on the console's port any more
    const result = structured(await client.callTool(info(t.consoleId)));
    expect(result['status']).toBe('error');
    expect(result['error']).toMatchObject({ code: 'connect_failed' });
    expect(await ready(t.service.url)).toBe(200);
    expect((await client.callTool({ name: 'unifi_list_consoles', arguments: {} })).isError).toBe(
      false,
    );
  });

  it('that does not answer leaves the service ready, and does not hold up its shutdown', async () => {
    const t = await startTestService({ dir: await tempDir() });
    const client = await connect(t.mcpUrl, t.token('reader', ['network.*.read']));
    t.mock.respond = () => undefined; // the console accepts the request and never answers
    const inFlight = client.callTool(info(t.consoleId)).then(
      () => 'settled',
      () => 'settled',
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(t.mock.requests).toHaveLength(1);
    expect(await ready(t.service.url)).toBe(200);

    const started = Date.now();
    await t.service.stop();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await inFlight).toBe('settled');
    expect(t.logs.some((line) => line.includes('service stopped'))).toBe(true);
  });
});
