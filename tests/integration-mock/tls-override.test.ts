/**
 * The insecure TLS override is "per-console, audited, conspicuously warned and never
 * inherited globally" (spec §4.4, §17): a running service keeps saying so, in its log at
 * every start, in its health report, and to whoever approves a write to that console.
 */
import { describe, expect, it } from 'vitest';
import { RULE } from '../unit/core/fixtures.ts';
import { useTempDirs } from '../unit/storage/fixtures.ts';
import { CLI, connect, rawRequest, startTestService, structured } from './fixtures.ts';

const tempDir = useTempDirs();
const WARNING = 'TLS verification is DISABLED for this console (explicit insecure override)';

describe('a console with TLS verification disabled', () => {
  it('degrades health without stopping the service, and is named to administrators only', async () => {
    const t = await startTestService({ dir: await tempDir() });
    expect((await t.service.health.readiness()).degraded).toBe(false);
    t.service.consoles.setTls(t.consoleId, { mode: 'insecure' }, CLI);
    const report = await t.service.health.readiness();
    expect(report.ready).toBe(true);
    expect(report.degraded).toBe(true);
    expect(report.checks.find((check) => check.name === 'console_tls')).toMatchObject({
      status: 'degraded',
      critical: false,
      detail: 'TLS verification disabled: lab',
    });
    // The unauthenticated endpoint says ready, and nothing about consoles.
    const ready = await rawRequest(new URL('/readyz', t.service.url), {});
    expect(ready.status).toBe(200);
    expect(ready.body).toBe('{"status":"ready"}');
    expect(t.logs.filter((line) => line.includes(WARNING))).toHaveLength(1);
  });

  it('tells the approver of a write to that console, and no other', async () => {
    const t = await startTestService({ dir: await tempDir() });
    const writer = await connect(t.mcpUrl, t.token('writer', ['network.*.*']));
    const propose = async (): Promise<string> => {
      const proposed = structured(
        await writer.callTool({
          name: 'unifi_execute',
          arguments: {
            operationId: 'network.firewall.update_rule',
            consoleId: t.consoleId,
            siteId: 'site-1',
            arguments: { ruleId: RULE, body: { action: 'block' } },
          },
        }),
      );
      expect(proposed['status']).toBe('approval_required');
      return String(proposed['approvalId']);
    };
    const verified = t.service.approvals.get(await propose());
    expect(JSON.stringify(verified?.summary)).not.toContain('TLS verification');
    t.service.consoles.setTls(t.consoleId, { mode: 'insecure' }, CLI);
    const unverified = t.service.approvals.get(await propose());
    expect(unverified?.summary).toMatchObject({
      consoleNotice: expect.stringContaining('TLS verification is DISABLED') as string,
    });
    // The requesting client is not given the console's trust settings.
    const listed = structured(
      await writer.callTool({ name: 'unifi_list_consoles', arguments: {} }),
    );
    expect(JSON.stringify(listed)).not.toMatch(/insecure|TLS/);
  });

  it('is announced again at every start, and a process-wide switch is called out as ignored', async () => {
    const dir = await tempDir();
    const first = await startTestService({ dir });
    first.service.consoles.setTls(first.consoleId, { mode: 'insecure' }, CLI);
    await first.service.stop();

    const previous = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    try {
      const second = await startTestService({ dir, withConsole: false });
      const records = second.logs.map((line) => JSON.parse(line) as Record<string, unknown>);
      const warned = records.findIndex((r) => r['msg'] === WARNING);
      const started = records.findIndex((r) => r['msg'] === 'service started');
      expect(warned).toBeGreaterThanOrEqual(0);
      expect(warned).toBeLessThan(started);
      expect(records[warned]).toMatchObject({
        level: 'warn',
        alias: 'lab',
        consoleId: first.consoleId,
      });
      expect(
        records.some(
          (r) =>
            r['level'] === 'warn' &&
            String(r['msg']).includes('NODE_TLS_REJECT_UNAUTHORIZED=0 is set and is ignored'),
        ),
      ).toBe(true);
      // Back to pinning: the next start is quiet.
      second.service.consoles.setTls(
        first.consoleId,
        { mode: 'pinned', pins: ['sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='] },
        CLI,
      );
      await second.service.stop();
    } finally {
      if (previous === undefined)
        Reflect.deleteProperty(process.env, 'NODE_TLS_REJECT_UNAUTHORIZED');
      else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = previous;
    }
    const third = await startTestService({ dir, withConsole: false });
    expect(third.logs.filter((line) => line.includes(WARNING))).toEqual([]);
    expect(third.logs.join('\n')).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED');
  });
});
