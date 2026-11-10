/**
 * Release-blocking invariants (spec §17 Security/Reliability, §12, §7.3):
 *
 * - Bearer tokens, UniFi API keys, passwords, cookies, TOTP values and other secrets never
 *   reach logs or the audit trail, while correlation fields remain.
 * - The unauthenticated readiness endpoint reveals no console identifiers or internal state.
 * - The logger writes only to the sink it was given (the stdio bridge's stdout stays clean).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { databasePathFor, openStorage, SecretValue } from '@unifi-local-mcp/storage';
import {
  AuditLog,
  createHealthHandler,
  createLogger,
  HealthMonitor,
} from '@unifi-local-mcp/telemetry';
import { describe, expect, it, vi } from 'vitest';
import { testKey, useTempDirs } from '../unit/storage/fixtures.ts';
import { memoryLogger } from '../unit/telemetry/fixtures.ts';

const tempDir = useTempDirs();

/** A realistic request/upstream context in which every secret contains "SENTINEL". */
function contextWithSecrets(): Record<string, unknown> {
  return {
    correlationId: 'corr-42',
    clientId: 'client-reader',
    consoleId: 'console-1',
    request: {
      headers: {
        authorization: 'Bearer SENTINEL-MCP-TOKEN',
        'X-API-KEY': 'SENTINEL-UNIFI-KEY',
        cookie: 'sid=SENTINEL-COOKIE',
      },
      url: 'https://operator:SENTINEL-URL-PASSWORD@console.invalid/x?token=SENTINEL-QUERY',
    },
    body: {
      name: 'Guest Wi-Fi',
      passphrase: 'SENTINEL-PSK',
      admins: [{ username: 'ops', password: 'SENTINEL-PASSWORD', totpCode: 'SENTINEL-TOTP' }],
    },
    stream: 'rtsps://192.0.2.10:7441/SENTINEL-STREAM?enableSrtp',
    storedKey: new SecretValue('SENTINEL-SECRET-VALUE'),
    error: new Error('upstream replied 401 for Bearer SENTINEL-IN-ERROR'),
  };
}

describe('secrets never reach logs or the audit trail', () => {
  it('log records keep correlation fields and drop every secret', () => {
    const { lines, logger } = memoryLogger();
    logger.error('operation failed', contextWithSecrets());
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('SENTINEL');
    expect(lines[0]).toContain('"correlationId":"corr-42"');
    expect(lines[0]).toContain('"clientId":"client-reader"');
    expect(lines[0]).toContain('"name":"Guest Wi-Fi"');
  });

  it('audit details are redacted before they reach the database files', async () => {
    const dir = await tempDir();
    const storage = await openStorage({
      databasePath: databasePathFor(join(dir, 'data')),
      masterKey: testKey('telemetry-security'),
    });
    const audit = new AuditLog(storage.db, { logger: memoryLogger().logger });
    audit.record({
      eventType: 'mcp.operation',
      action: 'operation.execute',
      outcome: 'failure',
      actor: { type: 'mcp_client', id: 'client-reader' },
      correlationId: 'corr-42',
      details: contextWithSecrets(),
    });
    expect(JSON.stringify(audit.list())).not.toContain('SENTINEL');
    storage.close();
    for (const file of await readdir(join(dir, 'data'))) {
      const content = await readFile(join(dir, 'data', file));
      expect(content.includes(Buffer.from('SENTINEL')), file).toBe(false);
    }
  });
});

describe('public health endpoints', () => {
  it('reveal nothing beyond the overall status', async () => {
    const monitor = new HealthMonitor();
    monitor.register({
      name: 'console.site-a-gateway',
      critical: true,
      run: () => ({ status: 'fail', detail: 'console-1 at 192.0.2.1 unreachable' }),
    });
    monitor.register({ name: 'database', critical: true, run: () => ({ status: 'ok' }) });
    const handle = createHealthHandler(monitor);
    const ready = await handle(new Request('http://localhost/readyz'));
    expect(await ready?.text()).toBe('{"status":"not_ready"}');
    const live = await handle(new Request('http://localhost/livez'));
    expect(await live?.text()).toBe('{"status":"alive"}');
  });
});

describe('log destinations', () => {
  it('a logger bound to stderr never writes to stdout', () => {
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logger = createLogger({ level: 'debug', sink: process.stderr });
    logger.debug('bridge starting');
    logger.error('bridge failed', { err: new Error('x') });
    expect(stderr).toHaveBeenCalledTimes(2);
    expect(stdout).not.toHaveBeenCalled();
  });
});
