/**
 * Liveness, readiness and the public health endpoints (spec §12, §7.3; ADR 0008).
 */
import { join } from 'node:path';
import { databasePathFor, openStorage } from '@unifi-local-mcp/storage';
import {
  AuditLog,
  auditCheck,
  createHealthHandler,
  databaseCheck,
  diskSpaceCheck,
  HealthMonitor,
  type HealthCheck,
} from '@unifi-local-mcp/telemetry';
import { describe, expect, it } from 'vitest';
import { testKey, useTempDirs } from '../storage/fixtures.ts';
import { memoryLogger } from './fixtures.ts';

const tempDir = useTempDirs();

function check(
  name: string,
  critical: boolean,
  run: HealthCheck['run'],
  timeoutMs?: number,
): HealthCheck {
  return { name, critical, run, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

describe('HealthMonitor', () => {
  it('reports liveness without running any check', () => {
    const monitor = new HealthMonitor();
    monitor.register(check('never', true, () => ({ status: 'fail' })));
    expect(monitor.liveness()).toEqual({ status: 'alive' });
  });

  it('is ready only when every critical check passes', async () => {
    const monitor = new HealthMonitor({ now: () => new Date('2026-11-10T03:15:00.000Z') });
    monitor.register(check('database', true, () => ({ status: 'ok' })));
    expect(await monitor.readiness()).toMatchObject({
      ready: true,
      degraded: false,
      checkedAt: '2026-11-10T03:15:00.000Z',
      checks: [{ name: 'database', critical: true, status: 'ok' }],
    });
    monitor.register(check('audit', true, () => ({ status: 'fail', detail: 'disk full' })));
    expect(await monitor.readiness()).toMatchObject({ ready: false, degraded: false });
  });

  it('lets non-critical checks degrade but never block readiness', async () => {
    const monitor = new HealthMonitor();
    monitor.register(check('database', true, () => ({ status: 'degraded' })));
    monitor.register(
      check('console.office', false, () => ({ status: 'fail', detail: 'unreachable' })),
    );
    expect(await monitor.readiness()).toMatchObject({ ready: true, degraded: true });
  });

  it('fails checks that throw or time out, with redacted details', async () => {
    const monitor = new HealthMonitor();
    monitor.register(
      check('throws', true, () => {
        throw new Error('rejected Bearer abc123');
      }),
    );
    monitor.register(check('hangs', true, () => new Promise(() => undefined), 20));
    const report = await monitor.readiness();
    expect(report.ready).toBe(false);
    expect(report.checks).toEqual([
      expect.objectContaining({
        name: 'throws',
        status: 'fail',
        detail: 'rejected Bearer [REDACTED]',
      }),
      expect.objectContaining({ name: 'hangs', status: 'fail', detail: 'timed out after 20 ms' }),
    ]);
  });

  it('rejects duplicate and malformed check names', () => {
    const monitor = new HealthMonitor();
    monitor.register(check('database', true, () => ({ status: 'ok' })));
    expect(() => {
      monitor.register(check('database', true, () => ({ status: 'ok' })));
    }).toThrow(TypeError);
    expect(() => {
      monitor.register(check('Bad Name', true, () => ({ status: 'ok' })));
    }).toThrow(TypeError);
  });
});

describe('built-in checks', () => {
  it('database and audit checks follow the storage and audit state', async () => {
    const storage = await openStorage({
      databasePath: databasePathFor(join(await tempDir(), 'data')),
      masterKey: testKey('health'),
    });
    const audit = new AuditLog(storage.db, { logger: memoryLogger().logger });
    expect(await databaseCheck(storage.db).run()).toEqual({ status: 'ok' });
    expect(await auditCheck(audit).run()).toEqual({ status: 'ok' });
    storage.close();
    expect(await databaseCheck(storage.db).run()).toMatchObject({ status: 'fail' });
  });

  it('disk space check applies its thresholds', async () => {
    const dir = await tempDir();
    const huge = Number.MAX_SAFE_INTEGER;
    expect((await diskSpaceCheck(dir, { failBelowBytes: 0, warnBelowBytes: 0 }).run()).status).toBe(
      'ok',
    );
    expect(
      (await diskSpaceCheck(dir, { failBelowBytes: 0, warnBelowBytes: huge }).run()).status,
    ).toBe('degraded');
    const failed = await diskSpaceCheck(dir, { failBelowBytes: huge, warnBelowBytes: huge }).run();
    expect(failed.status).toBe('fail');
    expect(failed.detail).toMatch(/MiB free on the data volume/);
  });
});

describe('createHealthHandler', () => {
  async function body(response: Response | undefined): Promise<unknown> {
    if (response === undefined) throw new Error('expected a response');
    return response.json();
  }

  it('serves liveness and readiness with minimal, uncached bodies', async () => {
    const monitor = new HealthMonitor();
    monitor.register(check('database', true, () => ({ status: 'ok' })));
    const handle = createHealthHandler(monitor);
    const live = await handle(new Request('http://localhost/livez'));
    expect(live?.status).toBe(200);
    expect(live?.headers.get('cache-control')).toBe('no-store');
    expect(await body(live)).toEqual({ status: 'alive' });
    const ready = await handle(new Request('http://localhost/readyz'));
    expect(ready?.status).toBe(200);
    expect(await body(ready)).toEqual({ status: 'ready' });
  });

  it('returns 503 with no check names or details when not ready', async () => {
    const monitor = new HealthMonitor();
    monitor.register(
      check('console.office-gateway', true, () => ({ status: 'fail', detail: 'console-1 down' })),
    );
    const response = await createHealthHandler(monitor)(new Request('http://localhost/readyz'));
    expect(response?.status).toBe(503);
    expect(await response?.text()).toBe('{"status":"not_ready"}');
  });

  it('supports HEAD, refuses other methods, and ignores other paths', async () => {
    const handle = createHealthHandler(new HealthMonitor(), {
      livenessPath: '/health/live',
      readinessPath: '/health/ready',
    });
    const head = await handle(new Request('http://localhost/health/ready', { method: 'HEAD' }));
    expect(head?.status).toBe(200);
    expect(await head?.text()).toBe('');
    const post = await handle(new Request('http://localhost/health/live', { method: 'POST' }));
    expect(post?.status).toBe(405);
    expect(post?.headers.get('allow')).toBe('GET, HEAD');
    expect(await handle(new Request('http://localhost/readyz'))).toBeUndefined();
    expect(await handle(new Request('http://localhost/mcp'))).toBeUndefined();
  });
});
