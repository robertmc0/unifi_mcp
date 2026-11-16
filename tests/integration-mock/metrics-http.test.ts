/**
 * The metrics listener end to end (spec §12, §7.3, §17 "metrics do not leak sensitive
 * identifiers"; ADR 0025): off by default, its own port and token, the Prometheus text
 * format, counters that follow real MCP calls, and a scrape that contains none of the
 * identifiers of this test's own setup.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadMetricsToken, MetricsTokenError } from '@unifi-local-mcp/mcp-server';
import { describe, expect, it } from 'vitest';
import { useTempDirs } from '../unit/storage/fixtures.ts';
import {
  connect,
  INITIALIZE,
  NETWORK_KEY,
  rawRequest,
  startTestService,
  structured,
} from './fixtures.ts';

const tempDir = useTempDirs();
const TOKEN = 'synthetic-metrics-token-SENTINEL-0123456789abcdef';

async function withMetrics(dir: string, options: { forceReadOnly?: boolean } = {}) {
  const tokenFile = join(dir, 'metrics-token');
  await writeFile(tokenFile, `${TOKEN}\n`);
  const t = await startTestService({ dir, metricsTokenFile: tokenFile, ...options });
  const url = new URL('/metrics', t.service.metricsUrl);
  const scrape = async (): Promise<string> => {
    const response = await rawRequest(url, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(200);
    return response.body;
  };
  return { t, url, scrape };
}

/** The value of one sample line, or undefined when the series is absent. */
function sample(text: string, series: string): number | undefined {
  const line = text.split('\n').find((l) => l.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

describe('metrics listener', () => {
  it('does not exist unless enabled, and the MCP listener never serves metrics', async () => {
    const t = await startTestService({ dir: await tempDir() });
    expect(t.service.metricsUrl).toBeUndefined();
    const onMcp = await rawRequest(new URL('/metrics', t.service.url), {
      headers: { authorization: `Bearer ${t.token('reader', ['*.*.read'])}` },
    });
    expect(onMcp.status).toBe(404);
    expect(onMcp.body).not.toContain('unifi_mcp_');
  });

  it('serves the Prometheus text format to the scrape token only', async () => {
    const { t, url } = await withMetrics(await tempDir());
    expect(new URL(t.service.metricsUrl ?? '').port).not.toBe(new URL(t.service.url).port);

    const missing = await rawRequest(url, {});
    expect(missing.status).toBe(401);
    expect(missing.headers['www-authenticate']).toBe('Bearer realm="unifi-local-mcp-metrics"');
    expect(missing.body).toBe('unauthorized\n');
    // An MCP client token, however privileged, is not the scrape token.
    const clientToken = t.token('writer', ['*.*.*']);
    for (const authorization of [
      `Bearer ${clientToken}`,
      `Bearer ${TOKEN}x`,
      `Bearer ${TOKEN.slice(0, -1)}`,
      `Basic ${Buffer.from(`prometheus:${TOKEN}`).toString('base64')}`,
      TOKEN,
    ]) {
      const refused = await rawRequest(url, { headers: { authorization } });
      expect(refused.status, authorization.slice(0, 12)).toBe(401);
      expect(refused.body).not.toContain('unifi_mcp_');
    }
    // The token in the query string is not accepted either.
    expect((await rawRequest(new URL(`/metrics?token=${TOKEN}`, url), {})).status).toBe(401);

    const ok = await rawRequest(url, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.headers['access-control-allow-origin']).toBeUndefined();
    expect(ok.body.endsWith('\n')).toBe(true);
    for (const line of ok.body.trimEnd().split('\n')) {
      expect(line).toMatch(
        /^(# (HELP|TYPE) [a-z_]+ .+|[a-z_]+(\{[a-z_]+="[A-Za-z0-9_.:+-]*"(,[a-z_]+="[A-Za-z0-9_.:+-]*")*\})? -?[0-9.e+-]+)$/,
      );
    }
    expect(sample(ok.body, 'unifi_mcp_build_info{version="0.0.0"}')).toBe(1);
    expect(sample(ok.body, 'unifi_mcp_ready')).toBe(1);
    expect(sample(ok.body, 'unifi_mcp_hard_lock')).toBe(0);

    // Nothing else is served here: no MCP endpoint, no health pages, no other method.
    const auth = { authorization: `Bearer ${TOKEN}` };
    for (const path of ['/', '/mcp', '/livez', '/readyz', '/metrics/', '/metrics/x']) {
      expect((await rawRequest(new URL(path, url), { headers: auth })).status, path).toBe(404);
    }
    const mcp = await rawRequest(new URL('/mcp', url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${clientToken}`,
      },
      body: INITIALIZE,
    });
    expect(mcp.status).toBe(404);
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const refused = await rawRequest(url, { method, headers: auth });
      expect(refused.status, method).toBe(405);
      expect(refused.headers['allow']).toBe('GET');
    }
  });

  it('throttles repeated failures from one address, and audits them', async () => {
    const { t, url } = await withMetrics(await tempDir());
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await rawRequest(url, { headers: { authorization: 'Bearer wrong' } })).status;
    }
    expect(last).toBe(429);
    // While blocked, even the right token waits.
    const blocked = await rawRequest(url, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    const audited = t.service.audit.list({ eventType: 'metrics.auth', limit: 50 });
    expect(audited.length).toBeGreaterThan(0);
    expect(audited[0]).toMatchObject({ outcome: 'denied', action: 'auth.token_rejected' });
    // Successful scrapes are not audited.
    expect(t.service.audit.list({ limit: 200 }).some((e) => e.action.includes('scrape'))).toBe(
      false,
    );
  });

  it('counts what the service did: requests, operations, console requests, state', async () => {
    const { t, scrape } = await withMetrics(await tempDir());
    const before = await scrape();
    expect(
      sample(before, 'unifi_mcp_operations_total{module="network",effect="read",status="ok"}'),
    ).toBe(undefined);
    expect(sample(before, 'unifi_mcp_consoles{state="enabled"}')).toBe(1);
    expect(
      sample(
        before,
        'unifi_mcp_console_modules{module="network",state="read_write",version="known"}',
      ),
    ).toBe(1);
    expect(sample(before, 'unifi_mcp_runtime_mode{mode="read_write"}')).toBe(1);
    expect(sample(before, 'unifi_mcp_runtime_mode{mode="read_only"}')).toBe(0);
    expect(sample(before, 'unifi_mcp_health_check_status{check="database",status="ok"}')).toBe(1);
    expect(sample(before, 'unifi_mcp_health_check_status{check="database",status="fail"}')).toBe(0);
    expect(sample(before, 'unifi_mcp_clients_configured')).toBe(0);
    expect(sample(before, 'unifi_mcp_database_size_bytes')).toBeGreaterThan(0);
    expect(sample(before, 'unifi_mcp_data_volume_free_bytes')).toBeGreaterThan(0);
    expect(sample(before, 'process_resident_memory_bytes')).toBeGreaterThan(0);
    expect(sample(before, 'process_start_time_seconds')).toBeGreaterThan(1_700_000_000);

    const reader = await connect(t.mcpUrl, t.token('reader', ['network.*.read']));
    const read = (siteId: string) =>
      reader.callTool({
        name: 'unifi_execute',
        arguments: { operationId: 'network.devices.list', consoleId: t.consoleId, siteId },
      });
    expect(structured(await read('site-1'))['status']).toBe('ok');
    expect(structured(await read('site-1'))['status']).toBe('ok');
    // A write the reader is not granted, and an operation that does not exist.
    const denied = structured(
      await reader.callTool({
        name: 'unifi_execute',
        arguments: {
          operationId: 'network.gateway.reboot',
          consoleId: t.consoleId,
          siteId: 'site-1',
        },
      }),
    );
    expect(denied['status']).toBe('denied');
    const unknown = structured(
      await reader.callTool({
        name: 'unifi_execute',
        arguments: { operationId: 'network.secret-site-7.wipe', consoleId: t.consoleId },
      }),
    );
    expect(unknown['status']).not.toBe('ok');
    await rawRequest(t.mcpUrl, { method: 'POST', body: INITIALIZE });

    const after = await scrape();
    expect(
      sample(after, 'unifi_mcp_operations_total{module="network",effect="read",status="ok"}'),
    ).toBe(2);
    expect(
      sample(after, 'unifi_mcp_operations_total{module="network",effect="write",status="denied"}'),
    ).toBe(1);
    // The unregistered id is counted without becoming a label.
    expect(
      sample(
        after,
        `unifi_mcp_operations_total{module="unknown",effect="unknown",status="${String(unknown['status'])}"}`,
      ),
    ).toBe(1);
    expect(
      sample(after, 'unifi_mcp_operation_duration_seconds_count{module="network",effect="read"}'),
    ).toBe(2);
    expect(
      sample(
        after,
        'unifi_mcp_operation_duration_seconds_bucket{module="network",effect="read",le="+Inf"}',
      ),
    ).toBe(2);
    const deniedCode = (denied['error'] as { code: string }).code;
    expect(
      sample(after, `unifi_mcp_operation_failures_total{status="denied",code="${deniedCode}"}`),
    ).toBeGreaterThanOrEqual(1);
    expect(sample(after, 'unifi_mcp_upstream_requests_total{module="network",result="2xx"}')).toBe(
      2,
    );
    expect(
      sample(after, 'unifi_mcp_upstream_request_duration_seconds_count{module="network"}'),
    ).toBe(2);
    expect(sample(after, 'unifi_mcp_http_requests_total{path="mcp",code="200"}')).toBeGreaterThan(
      0,
    );
    expect(sample(after, 'unifi_mcp_http_requests_total{path="mcp",code="401"}')).toBe(1);
    expect(sample(after, 'unifi_mcp_clients_configured')).toBe(1);
    expect(sample(after, 'unifi_mcp_operations_running')).toBe(0);
    expect(sample(after, 'unifi_mcp_operations_queued')).toBe(0);
    expect(sample(after, 'unifi_mcp_approvals_pending')).toBe(0);
  });

  it('counts a console that does not answer and shows the hard lock', async () => {
    const { t, scrape } = await withMetrics(await tempDir(), { forceReadOnly: true });
    expect(sample(await scrape(), 'unifi_mcp_hard_lock')).toBe(1);
    await t.mock.stop();
    const reader = await connect(t.mcpUrl, t.token('reader', ['network.*.read']));
    const result = structured(
      await reader.callTool({
        name: 'unifi_execute',
        arguments: { operationId: 'network.info.get', consoleId: t.consoleId },
      }),
    );
    expect(result['status']).toBe('error');
    const text = await scrape();
    expect(
      sample(text, 'unifi_mcp_upstream_requests_total{module="network",result="no_response"}'),
    ).toBeGreaterThanOrEqual(1);
    expect(
      sample(text, 'unifi_mcp_operations_total{module="network",effect="read",status="error"}'),
    ).toBe(1);
  });

  it('contains no identifier, name, address or secret of the deployment', async () => {
    const dir = await tempDir();
    const { t, scrape } = await withMetrics(dir);
    const clientToken = t.token('reader-sentinel-client', ['network.*.read']);
    const reader = await connect(t.mcpUrl, clientToken);
    await reader.callTool({
      name: 'unifi_execute',
      arguments: {
        operationId: 'network.devices.list',
        consoleId: t.consoleId,
        siteId: 'site-SENTINEL-9',
      },
    });
    await reader.callTool({
      name: 'unifi_execute',
      arguments: { operationId: 'network.SENTINEL.operation', consoleId: 'console-SENTINEL' },
    });
    const text = await scrape();
    const view = t.service.consoles.list()[0];
    const client = t.service.clients.list()[0];
    expect(text.toLowerCase()).not.toContain('sentinel');
    const forbidden = [
      TOKEN,
      clientToken,
      NETWORK_KEY,
      t.consoleId,
      view?.alias ?? 'lab',
      String(t.mock.port),
      client?.clientId ?? '',
      ...(client?.tokens.map((token) => token.tokenId) ?? []),
      'Office AP',
      '00:00:5e:00:53:01',
      'dev-1',
      dir,
      'devices',
      '/v1/',
    ].filter((value) => value !== '');
    // As a whole word: "lab" is part of "label", and a port's digits may occur in a size.
    for (const value of forbidden) {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(text, value).not.toMatch(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`));
    }
    // No IPv4 address, MAC address or UUID anywhere in the page.
    expect(text).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(text).not.toMatch(/\b[0-9a-f]{2}(:[0-9a-f]{2}){5}\b/i);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    // The scrape token is in no log line and in no audit entry.
    expect(t.logs.join('\n')).not.toContain(TOKEN);
    expect(JSON.stringify(t.service.audit.list({ limit: 500 }))).not.toContain(TOKEN);
    // Only the digest of the token is kept by the loader.
    expect(loadMetricsToken(join(dir, 'metrics-token')).toString('hex')).not.toContain(TOKEN);
    expect(await readFile(join(dir, 'metrics-token'), 'utf8')).toBe(`${TOKEN}\n`);
  });
});

describe('metrics token file', () => {
  it('must hold one long token from the bearer alphabet', async () => {
    const dir = await tempDir();
    const file = join(dir, 'token');
    for (const [content, pattern] of [
      ['short\n', /at least 32 characters/],
      [`${'a'.repeat(31)}\n`, /at least 32 characters/],
      [`${'a'.repeat(40)} ${'b'.repeat(40)}\n`, /at least 32 characters/],
      [`${'a'.repeat(20)}\n${'b'.repeat(20)}\n`, /at least 32 characters/],
      ['', /at least 32 characters/],
      ['x'.repeat(5000), /too large/],
    ] as const) {
      await writeFile(file, content);
      expect(() => loadMetricsToken(file), JSON.stringify(content.slice(0, 20))).toThrow(pattern);
    }
    expect(() => loadMetricsToken(join(dir, 'missing'))).toThrow(MetricsTokenError);
    expect(() => loadMetricsToken(join(dir, 'missing'))).toThrow(/ENOENT/);
    await writeFile(file, `  ${'a'.repeat(32)}  \n`);
    expect(loadMetricsToken(file)).toHaveLength(32);
  });

  it('stops the service from starting when it is unusable', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'bad-token'), 'short\n');
    await expect(
      startTestService({ dir, metricsTokenFile: join(dir, 'bad-token') }),
    ).rejects.toThrow(MetricsTokenError);
    // Nothing was left running or locked: the same data directory starts without metrics.
    const t = await startTestService({ dir });
    expect(t.service.metricsUrl).toBeUndefined();
  });
});
