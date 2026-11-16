/**
 * The whole service under a burst, with its shipped limits (spec §10, §17): eight MCP
 * clients send 200 reads at once over HTTP to one synthetic console. Every call gets one
 * stated answer, the console never sees more than the per-console concurrency, and the
 * metrics add up to what happened.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_DISPATCHER_LIMITS } from '@unifi-local-mcp/core';
import { describe, expect, it } from 'vitest';
import { sendJson } from '../fixtures/mock-console.ts';
import { connect, rawRequest, startTestService, structured } from '../integration-mock/fixtures.ts';
import { useTempDirs } from '../unit/storage/fixtures.ts';

const tempDir = useTempDirs();
const METRICS_TOKEN = 'synthetic-metrics-token-for-the-load-test-0123456789';

function sample(text: string, series: string): number {
  const line = text.split('\n').find((l) => l.startsWith(`${series} `));
  return line === undefined ? 0 : Number(line.slice(series.length + 1));
}

describe('a burst from eight clients', () => {
  it('is answered completely, within the console concurrency, and counted exactly', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'metrics-token'), `${METRICS_TOKEN}\n`);
    const t = await startTestService({ dir, metricsTokenFile: join(dir, 'metrics-token') });
    let inFlight = 0;
    let maxInFlight = 0;
    let served = 0;
    t.mock.respond = (_req, res) => {
      inFlight += 1;
      served += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight -= 1;
        sendJson(res, 200, {
          data: [{ id: 'dev-1', name: 'Office AP', macAddress: '00:00:5e:00:53:01' }],
        });
      }, 15);
    };
    const clients = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        connect(t.mcpUrl, t.token(`burst-${String(i)}`, ['network.*.read'])),
      ),
    );
    const results = await Promise.all(
      clients.flatMap((client) =>
        Array.from({ length: 25 }, async () =>
          structured(
            await client.callTool({
              name: 'unifi_execute',
              arguments: {
                operationId: 'network.devices.list',
                consoleId: t.consoleId,
                siteId: 'site-1',
              },
            }),
          ),
        ),
      ),
    );
    expect(results).toHaveLength(200);
    const ok = results.filter((r) => r['status'] === 'ok');
    const refused = results.filter((r) => r['status'] !== 'ok');
    // Every refusal is a stated limit with a retry time; nothing is lost or left hanging.
    for (const result of refused) {
      const error = result['error'] as { code: string; retryAfterMs?: number };
      expect(['rate_limited', 'queue_full']).toContain(error.code);
      if (error.code === 'rate_limited') expect(error.retryAfterMs).toBeGreaterThan(0);
    }
    // The burst is larger than the shipped limits allow, so some calls must be refused,
    // and at least a bucketful must get through.
    expect(ok.length).toBeGreaterThanOrEqual(DEFAULT_DISPATCHER_LIMITS.rate.module.burst);
    expect(refused.length).toBeGreaterThan(0);
    // The console answered exactly the calls that succeeded, never too many at once.
    expect(served).toBe(ok.length);
    expect(maxInFlight).toBeLessThanOrEqual(DEFAULT_DISPATCHER_LIMITS.scheduler.perKeyConcurrency);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(t.service.dispatcher.load).toEqual({ running: 0, queued: 0 });

    const metrics = (
      await rawRequest(new URL('/metrics', t.service.metricsUrl), {
        headers: { authorization: `Bearer ${METRICS_TOKEN}` },
      })
    ).body;
    const count = (status: string): number =>
      sample(
        metrics,
        `unifi_mcp_operations_total{module="network",effect="read",status="${status}"}`,
      );
    expect(count('ok')).toBe(ok.length);
    expect(count('ok') + count('error') + count('denied')).toBe(200);
    expect(
      sample(metrics, 'unifi_mcp_upstream_requests_total{module="network",result="2xx"}'),
    ).toBe(ok.length);
    expect(
      sample(metrics, 'unifi_mcp_operation_failures_total{status="error",code="rate_limited"}') +
        sample(metrics, 'unifi_mcp_operation_failures_total{status="error",code="queue_full"}'),
    ).toBe(refused.length);
    expect(sample(metrics, 'unifi_mcp_operations_queued')).toBe(0);
    expect(sample(metrics, 'unifi_mcp_operations_running')).toBe(0);
    // One audit entry per call, refused ones included.
    const audited = t.service.storage.db.get(
      "SELECT count(*) AS n FROM audit_entries WHERE action = 'operation.execute'",
    );
    expect(audited?.['n']).toBe(200);
  }, 60_000);

  it('follows the limits the deployment sets', async () => {
    const t = await startTestService({
      dir: await tempDir(),
      env: {
        UNIFI_MCP_RATE_PER_CLIENT: '0.1/3',
        UNIFI_MCP_CONCURRENCY_PER_MODULE: '1',
        UNIFI_MCP_CONCURRENCY_GLOBAL: '1',
      },
    });
    let inFlight = 0;
    let maxInFlight = 0;
    t.mock.respond = (_req, res) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight -= 1;
        sendJson(res, 200, {
          data: [{ id: 'dev-1', name: 'Office AP', macAddress: '00:00:5e:00:53:01' }],
        });
      }, 10);
    };
    const call = async (client: Awaited<ReturnType<typeof connect>>) =>
      structured(
        await client.callTool({
          name: 'unifi_execute',
          arguments: {
            operationId: 'network.devices.list',
            consoleId: t.consoleId,
            siteId: 'site-1',
          },
        }),
      );
    const first = await connect(t.mcpUrl, t.token('first', ['network.*.read']));
    const second = await connect(t.mcpUrl, t.token('second', ['network.*.read']));
    const results = await Promise.all([
      ...Array.from({ length: 6 }, () => call(first)),
      ...Array.from({ length: 3 }, () => call(second)),
    ]);
    // Three per client: the first client's other three are refused, the second's all pass.
    expect(results.slice(0, 6).filter((r) => r['status'] === 'ok')).toHaveLength(3);
    expect(results.slice(6).filter((r) => r['status'] === 'ok')).toHaveLength(3);
    for (const refused of results.filter((r) => r['status'] !== 'ok')) {
      expect((refused['error'] as { code: string }).code).toBe('rate_limited');
    }
    // One request at a time reaches the console.
    expect(maxInFlight).toBe(1);
  });
});
