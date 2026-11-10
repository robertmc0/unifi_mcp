/**
 * MCP client tokens and the client store (spec §7.1; ADR 0013).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ClientError,
  ClientStore,
  loadServiceConfig,
  type ClientErrorCode,
} from '@unifi-local-mcp/mcp-server';
import { PolicyStore, type PolicyActor } from '@unifi-local-mcp/policy';
import { databasePathFor, openStorage } from '@unifi-local-mcp/storage';
import { AuditLog } from '@unifi-local-mcp/telemetry';
import { describe, expect, it, vi } from 'vitest';
import { testKey, useTempDirs } from '../storage/fixtures.ts';
import { memoryLogger } from '../telemetry/fixtures.ts';

const tempDir = useTempDirs();
const CLI: PolicyActor = { type: 'cli', id: 'root' };

async function setup() {
  const clock = { now: new Date('2026-11-10T03:15:00.000Z') };
  const dir = await tempDir();
  const storage = await openStorage({
    databasePath: databasePathFor(join(dir, 'data')),
    masterKey: testKey('clients'),
  });
  const log = memoryLogger();
  const audit = new AuditLog(storage.db, { logger: log.logger });
  const policyStore = new PolicyStore(storage.db, audit);
  policyStore.current();
  const clients = new ClientStore({ db: storage.db, audit, now: () => clock.now });
  return { dir, storage, audit, policyStore, clients, clock, log };
}

function expectClientError(fn: () => unknown, code: ClientErrorCode): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ClientError);
  expect((thrown as ClientError).code).toBe(code);
}

describe('ClientStore', () => {
  it('issues a high-entropy token once and authenticates it', async () => {
    const s = await setup();
    const issued = s.clients.create({ clientId: 'claude-laptop', description: 'Workstation' }, CLI);
    expect(issued.token).toMatch(/^umcp_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    expect(issued.token.startsWith(`umcp_${issued.tokenId}_`)).toBe(true);
    expect(issued.client.policy).toMatchObject({ status: 'active', allow: [], consoles: {} });
    expect(s.clients.authenticate(issued.token)).toEqual({
      clientId: 'claude-laptop',
      tokenId: issued.tokenId,
    });
    expect(s.policyStore.current().version).toBe(2);
    s.storage.close();
  });

  it('rejects unknown, malformed and altered tokens alike', async () => {
    const s = await setup();
    const { token, tokenId } = s.clients.create({ clientId: 'c1' }, CLI);
    const altered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    for (const candidate of [
      '',
      'nope',
      altered,
      `umcp_${tokenId}_${'x'.repeat(43)}`,
      `umcp_000000000000_${token.slice(18)}`,
    ]) {
      expect(s.clients.authenticate(candidate), candidate).toBeUndefined();
    }
    s.storage.close();
  });

  it('stops accepting a token after rotation, revocation, expiry or client disable', async () => {
    const s = await setup();
    const first = s.clients.create({ clientId: 'c1' }, CLI);
    const second = s.clients.rotate('c1', CLI);
    expect(s.clients.authenticate(first.token)).toBeUndefined();
    expect(s.clients.authenticate(second.token)?.clientId).toBe('c1');

    s.clients.setPolicy('c1', { status: 'disabled' }, CLI);
    expect(s.clients.authenticate(second.token)).toBeUndefined();
    s.clients.setPolicy('c1', { status: 'active' }, CLI);
    expect(s.clients.authenticate(second.token)?.clientId).toBe('c1');

    const expiring = s.clients.rotate('c1', CLI, new Date('2026-11-10T04:00:00.000Z'));
    expect(s.clients.authenticate(expiring.token)?.clientId).toBe('c1');
    s.clock.now = new Date('2026-11-10T04:00:00.000Z');
    expect(s.clients.authenticate(expiring.token)).toBeUndefined();

    const third = s.clients.rotate('c1', CLI);
    s.clients.revoke('c1', CLI);
    expect(s.clients.authenticate(third.token)).toBeUndefined();
    expect(s.clients.get('c1')?.policy?.status).toBe('revoked');
    s.storage.close();
  });

  it('notifies revocation listeners', async () => {
    const s = await setup();
    const listener = vi.fn();
    s.clients.onRevocation(listener);
    s.clients.create({ clientId: 'c1' }, CLI);
    s.clients.rotate('c1', CLI);
    s.clients.setPolicy('c1', { status: 'disabled' }, CLI);
    s.clients.revoke('c1', CLI);
    expect(listener.mock.calls).toEqual([['c1'], ['c1'], ['c1']]);
    s.storage.close();
  });

  it('validates ids and policies and refuses MCP actors', async () => {
    const s = await setup();
    expectClientError(() => s.clients.create({ clientId: 'Bad Id' }, CLI), 'client_invalid');
    expectClientError(
      () => s.clients.create({ clientId: 'c1', policy: { sensitive: ['credential'] } }, CLI),
      'client_invalid',
    );
    s.clients.create({ clientId: 'c1' }, CLI);
    expectClientError(() => s.clients.create({ clientId: 'c1' }, CLI), 'client_exists');
    expectClientError(() => s.clients.rotate('ghost', CLI), 'client_not_found');
    const mcp = { type: 'mcp_client', id: 'c1' } as unknown as PolicyActor;
    expectClientError(
      () => s.clients.setPolicy('c1', { allow: ['*.*.*'] }, mcp),
      'client_actor_forbidden',
    );
    s.storage.close();
  });

  it('stores only digests: tokens never appear in the database, audit or logs', async () => {
    const s = await setup();
    const { token } = s.clients.create({ clientId: 'c1' }, CLI);
    s.clients.authenticate(token);
    const secret = token.slice(18);
    expect(JSON.stringify(s.audit.list({ limit: 100 }))).not.toContain(secret);
    expect(s.log.lines.join('')).not.toContain(secret);
    s.storage.close();
    for (const file of await readdir(join(s.dir, 'data'))) {
      const content = await readFile(join(s.dir, 'data', file));
      expect(content.includes(Buffer.from(secret)), file).toBe(false);
    }
  });

  it('records last use at most once a minute', async () => {
    const s = await setup();
    const { token } = s.clients.create({ clientId: 'c1' }, CLI);
    s.clients.authenticate(token);
    const first = s.clients.get('c1')?.lastUsedAt;
    expect(first).toBe('2026-11-10T03:15:00.000Z');
    s.clock.now = new Date('2026-11-10T03:15:30.000Z');
    s.clients.authenticate(token);
    expect(s.clients.get('c1')?.lastUsedAt).toBe(first);
    s.clock.now = new Date('2026-11-10T03:16:01.000Z');
    s.clients.authenticate(token);
    expect(s.clients.get('c1')?.lastUsedAt).toBe('2026-11-10T03:16:01.000Z');
    s.storage.close();
  });
});

describe('loadServiceConfig', () => {
  it('defaults to a loopback listener, with the hard lock on', () => {
    const config = loadServiceConfig({ UNIFI_MCP_DATA_DIR: '/tmp/x' });
    expect(config.http).toMatchObject({
      bind: '127.0.0.1',
      port: 3000,
      tls: undefined,
      allowPlaintext: false,
    });
    expect(config.http.allowedHosts).toEqual(['localhost', '127.0.0.1', '[::1]']);
    expect(config.deployment.forceReadOnly).toBe(true);
    expect(config.auditRetentionDays).toBe(90);
  });

  it('refuses plaintext on a non-loopback bind unless explicitly allowed', () => {
    expect(() => loadServiceConfig({ UNIFI_MCP_HTTP_BIND: '0.0.0.0' })).toThrow(/plaintext HTTP/);
    const allowed = loadServiceConfig({
      UNIFI_MCP_HTTP_BIND: '0.0.0.0',
      UNIFI_MCP_HTTP_ALLOW_PLAINTEXT: 'true',
    });
    expect(allowed.http.allowPlaintext).toBe(true);
    const tls = loadServiceConfig({
      UNIFI_MCP_HTTP_BIND: '0.0.0.0',
      UNIFI_MCP_HTTP_TLS_CERT_FILE: '/run/secrets/cert.pem',
      UNIFI_MCP_HTTP_TLS_KEY_FILE: '/run/secrets/key.pem',
    });
    expect(tls.http.tls).toEqual({
      certFile: '/run/secrets/cert.pem',
      keyFile: '/run/secrets/key.pem',
    });
  });

  it.each([
    [{ UNIFI_MCP_HTTP_BIND: 'example.invalid' }, /must be an IP address/],
    [{ UNIFI_MCP_HTTP_PORT: '70000' }, /UNIFI_MCP_HTTP_PORT/],
    [{ UNIFI_MCP_HTTP_TLS_CERT_FILE: '/c.pem' }, /both/],
    [{ UNIFI_MCP_HTTP_ALLOW_PLAINTEXT: 'maybe' }, /true" or "false/],
    [{ UNIFI_MCP_HTTP_ALLOWED_HOSTS: 'https://x' }, /host names/],
    [{ UNIFI_MCP_AUDIT_RETENTION_DAYS: '0' }, /RETENTION/],
    [{ UNIFI_MCP_FORCE_READ_ONLY: 'perhaps' }, /FORCE_READ_ONLY/],
    [{ UNIFI_MCP_LOG_LEVEL: 'loud' }, /LOG_LEVEL/],
  ])('rejects %j', (env, pattern) => {
    expect(() => loadServiceConfig(env)).toThrow(pattern);
  });
});

describe('admin listener configuration', () => {
  it('is disabled by default, and loopback on its own port when enabled', () => {
    expect(loadServiceConfig({}).admin).toBeUndefined();
    expect(loadServiceConfig({ UNIFI_MCP_ADMIN_ENABLED: 'false' }).admin).toBeUndefined();
    expect(loadServiceConfig({ UNIFI_MCP_ADMIN_ENABLED: 'true' }).admin).toEqual({
      bind: '127.0.0.1',
      port: 3001,
      tls: undefined,
      allowPlaintext: false,
      allowedHosts: ['localhost', '127.0.0.1', '[::1]'],
      sessionIdleMinutes: 30,
      sessionMaxHours: 12,
    });
  });

  it.each([
    [{ UNIFI_MCP_ADMIN_PORT: '3000' }, /must differ/],
    [{ UNIFI_MCP_ADMIN_BIND: '0.0.0.0' }, /plaintext HTTP/],
    [{ UNIFI_MCP_ADMIN_BIND: 'admin.example' }, /IP address/],
    [{ UNIFI_MCP_ADMIN_TLS_CERT_FILE: '/x.pem' }, /both/],
    [{ UNIFI_MCP_ADMIN_SESSION_IDLE_MINUTES: '1' }, /from 5 to 480/],
    [{ UNIFI_MCP_ADMIN_ENABLED: 'maybe' }, /"true" or "false"/],
  ])('refuses %j', (extra, pattern) => {
    expect(() => loadServiceConfig({ UNIFI_MCP_ADMIN_ENABLED: 'true', ...extra })).toThrow(pattern);
  });

  it('allows a non-loopback bind with TLS or an explicit plaintext opt-in', () => {
    expect(
      loadServiceConfig({
        UNIFI_MCP_ADMIN_ENABLED: 'true',
        UNIFI_MCP_ADMIN_BIND: '0.0.0.0',
        UNIFI_MCP_ADMIN_ALLOW_PLAINTEXT: 'true',
        UNIFI_MCP_ADMIN_ALLOWED_HOSTS: 'admin.lan',
      }).admin,
    ).toMatchObject({
      bind: '0.0.0.0',
      allowPlaintext: true,
      allowedHosts: ['localhost', '127.0.0.1', '[::1]', 'admin.lan'],
    });
    expect(
      loadServiceConfig({
        UNIFI_MCP_ADMIN_ENABLED: 'true',
        UNIFI_MCP_ADMIN_BIND: '0.0.0.0',
        UNIFI_MCP_ADMIN_TLS_CERT_FILE: '/c.pem',
        UNIFI_MCP_ADMIN_TLS_KEY_FILE: '/k.pem',
      }).admin?.tls,
    ).toEqual({ certFile: '/c.pem', keyFile: '/k.pem' });
  });
});
