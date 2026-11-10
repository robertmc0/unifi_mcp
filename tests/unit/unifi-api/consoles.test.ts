/**
 * Console registry and egress policy (spec §4.2, §4.4; ADR 0012).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ConsoleError,
  DEFAULT_EGRESS_ALLOW,
  EgressGuard,
  parseEgressPolicy,
  type ConsoleErrorCode,
} from '@unifi-local-mcp/unifi-api';
import type { PolicyActor } from '@unifi-local-mcp/policy';
import { describe, expect, it } from 'vitest';
import { testPki } from '../../fixtures/test-pki.ts';
import { useTempDirs } from '../storage/fixtures.ts';
import { CLI, NETWORK_KEY, unifiHarness } from './fixtures.ts';

const tempDir = useTempDirs();

function expectConsoleError(fn: () => unknown, code: ConsoleErrorCode): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ConsoleError);
  expect((thrown as ConsoleError).code).toBe(code);
}

describe('ConsoleRegistry', () => {
  it('validates console definitions', async () => {
    const h = await unifiHarness({ dir: await tempDir() });
    const verify = { mode: 'verify' } as const;
    for (const input of [
      { alias: 'Bad Alias', host: '192.0.2.1', tls: verify },
      { alias: 'ok', host: 'https://192.0.2.1', tls: verify },
      { alias: 'ok', host: '192.0.2.1:8443', tls: verify },
      { alias: 'ok', host: 'console/path', tls: verify },
      { alias: 'ok', host: '192.0.2.1', tls: { mode: 'pinned', pins: ['nope'] } },
      { alias: 'ok', host: '192.0.2.1', tls: { mode: 'pinned', pins: [] } },
      { alias: 'ok', host: '192.0.2.1', tls: { mode: 'verify', caPem: 'not a certificate' } },
    ] as const) {
      expectConsoleError(() => h.consoles.add(input, CLI), 'console_invalid');
    }
    expectConsoleError(
      () => h.consoles.add({ alias: 'lab', host: '192.0.2.2', tls: verify }, CLI),
      'console_alias_taken',
    );
    const mcp = { type: 'mcp_client', id: 'agent' } as unknown as PolicyActor;
    expectConsoleError(
      () => h.consoles.add({ alias: 'x', host: '192.0.2.2', tls: verify }, mcp),
      'console_actor_forbidden',
    );
    await h.close();
  });

  it('starts with no modules enabled and bumps the policy version on changes', async () => {
    const h = await unifiHarness({ dir: await tempDir() });
    const view = h.consoles.get('lab');
    expect(view).toMatchObject({
      alias: 'lab',
      host: '127.0.0.1',
      tls: { mode: 'verify', customCa: true, pins: 0 },
      policy: { state: 'enabled', modules: {} },
    });
    const before = h.policyStore.current().version;
    h.consoles.setPolicy(h.consoleId, { modules: { network: { state: 'read_only' } } }, CLI);
    expect(h.policyStore.current().version).toBe(before + 1);
    expect(h.consoles.policy(h.consoleId)?.modules['network']?.state).toBe('read_only');
    expect(() => h.consoles.setPolicy(h.consoleId, { modules: { talk: {} } }, CLI)).toThrow(
      /Unknown modules/,
    );
    expect(() => h.consoles.setPolicy(h.consoleId, { state: 'on' }, CLI)).toThrow(/invalid/);
    await h.close();
  });

  it('stores credentials encrypted and write-only', async () => {
    const h = await unifiHarness({ dir: await tempDir() });
    const view = h.consoles.get(h.consoleId);
    expect(view?.modules.find((m) => m.moduleId === 'network')).toMatchObject({
      hasCredential: true,
    });
    expect(JSON.stringify(view)).not.toContain('SENTINEL');
    expect(JSON.stringify(h.audit.list({ limit: 500 }))).not.toContain('SENTINEL');
    h.consoles.setCredential(h.consoleId, 'network', 'synthetic-replacement-key', CLI);
    expect(h.consoles.connection(h.consoleId, 'network')?.credential?.reveal()).toBe(
      'synthetic-replacement-key',
    );
    expect(() => h.consoles.setCredential(h.consoleId, 'network', 'has space key', CLI)).toThrow(
      /printable/,
    );
    await h.close();
    for (const file of await readdir(join(h.storage.db.path, '..'))) {
      const content = await readFile(join(h.storage.db.path, '..', file));
      expect(content.includes(Buffer.from(NETWORK_KEY)), file).toBe(false);
    }
  });

  it('reports capability from the observed version and the operation range', async () => {
    const h = await unifiHarness({ dir: await tempDir() });
    const range = { moduleId: 'network', apiVersionRange: '>=10.1 <12' };
    expect(h.consoles.capability(h.consoleId, range)).toBe('unknown');
    h.consoles.recordObservedVersion(h.consoleId, 'network', '11.0.97');
    expect(h.consoles.capability(h.consoleId, range)).toBe('supported');
    h.consoles.recordObservedVersion(h.consoleId, 'network', '9.1.120');
    expect(h.consoles.capability(h.consoleId, range)).toBe('unsupported');
    h.consoles.recordObservedVersion(h.consoleId, 'network', 'garbage');
    expect(h.consoles.capability(h.consoleId, range)).toBe('unsupported');
    expect(h.consoles.capability(h.consoleId, { moduleId: 'talk', apiVersionRange: '>=1' })).toBe(
      'unsupported',
    );
    await h.close();
  });

  it('removes a console with its credentials', async () => {
    const h = await unifiHarness({ dir: await tempDir() });
    const before = h.policyStore.current().version;
    h.consoles.remove(h.consoleId, CLI);
    expect(h.consoles.get(h.consoleId)).toBeUndefined();
    expect(h.storage.db.get('SELECT count(*) AS n FROM secret_records')?.['n']).toBe(0);
    expect(h.policyStore.current().version).toBe(before + 1);
    expect(h.audit.list({ limit: 1 })[0]).toMatchObject({
      action: 'console.remove',
      details: { modulesWithStoredKeys: 1 },
    });
    await h.close();
  });

  it('treats a tampered stored policy as no policy', async () => {
    const h = await unifiHarness({ dir: await tempDir() });
    h.storage.db.run(`UPDATE consoles SET policy = '{"consoleId":"someone-else"}'`);
    expect(h.consoles.policy(h.consoleId)).toBeUndefined();
    expect(
      h.log
        .records()
        .some((r) => r['msg'] === 'stored console policy is invalid; the console is unavailable'),
    ).toBe(true);
    await h.close();
  });

  it('records TLS changes, warning loudly about insecure mode', async () => {
    const h = await unifiHarness({ dir: await tempDir() });
    h.consoles.setTls(h.consoleId, { mode: 'insecure' }, CLI);
    expect(h.audit.list({ limit: 2 }).map((e) => e.action)).toContain('console.tls_update');
    expect(
      h.log.records().some((r) => String(r['msg']).includes('TLS verification is DISABLED')),
    ).toBe(true);
    h.consoles.setTls(h.consoleId, { mode: 'verify', caPem: testPki().caPem }, CLI);
    expect(h.consoles.get(h.consoleId)?.tls.mode).toBe('verify');
    await h.close();
  });
});

describe('egress policy', () => {
  it('defaults to private, CGNAT and unique-local ranges only', () => {
    const guard = new EgressGuard(parseEgressPolicy({}));
    expect(parseEgressPolicy({}).allow).toEqual(DEFAULT_EGRESS_ALLOW);
    for (const allowed of [
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '100.100.1.1',
      'fd12::1',
      '::ffff:192.168.1.1',
    ]) {
      expect(guard.isAllowed(allowed), allowed).toBe(true);
    }
    for (const denied of [
      '127.0.0.1',
      '::1',
      '8.8.8.8',
      '169.254.169.254',
      '169.254.1.1',
      'fe80::1',
      '224.0.0.1',
      '0.0.0.0',
      '203.0.113.5',
      'not-an-ip',
    ]) {
      expect(guard.isAllowed(denied), denied).toBe(false);
    }
  });

  it('never allows metadata, multicast or unspecified addresses, even if listed', () => {
    const guard = new EgressGuard({ allow: ['0.0.0.0/0', '::/0'] });
    expect(guard.isAllowed('203.0.113.5')).toBe(true);
    for (const denied of ['169.254.169.254', '224.0.0.1', '0.0.0.0', '::', 'ff02::1']) {
      expect(guard.isAllowed(denied), denied).toBe(false);
    }
  });

  it('parses the deployment allowlist strictly', () => {
    expect(
      parseEgressPolicy({ UNIFI_MCP_EGRESS_ALLOW_CIDRS: '192.168.10.0/24, 10.8.0.0/16' }).allow,
    ).toEqual(['192.168.10.0/24', '10.8.0.0/16']);
    expect(() => parseEgressPolicy({ UNIFI_MCP_EGRESS_ALLOW_CIDRS: '192.168.10.0/33' })).toThrow(
      /CIDRs/,
    );
    expect(() => parseEgressPolicy({ UNIFI_MCP_EGRESS_ALLOW_CIDRS: 'console.local' })).toThrow(
      /CIDRs/,
    );
  });

  it('fails closed when a name does not resolve', async () => {
    const guard = new EgressGuard({ allow: ['10.0.0.0/8'] }, () =>
      Promise.reject(new Error('NXDOMAIN')),
    );
    await expect(guard.resolve('missing.invalid')).rejects.toMatchObject({ code: 'dns_failed' });
    const empty = new EgressGuard({ allow: ['10.0.0.0/8'] }, () => Promise.resolve([]));
    await expect(empty.resolve('empty.invalid')).rejects.toMatchObject({ code: 'dns_failed' });
  });
});
