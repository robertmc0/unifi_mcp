/**
 * The `unifi-mcp` CLI (spec §13.2; ADR 0015).
 */
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { acquireInstanceLock, SqliteDatabase } from '@unifi-local-mcp/storage';
import { spkiSha256 } from '@unifi-local-mcp/unifi-api';
import { MockConsole, sendJson } from '../../fixtures/mock-console.ts';
import { testPki } from '../../fixtures/test-pki.ts';
import { useTempDirs } from '../storage/fixtures.ts';
import { cliHarness } from './fixtures.ts';

const tempDir = useTempDirs();
const PASSWORD = 'correct horse battery staple';

async function setup(extraEnv: NodeJS.ProcessEnv = {}) {
  return cliHarness(await tempDir(), extraEnv);
}

describe('usage', () => {
  it('prints help, and exits 2 for unknown commands and bad arguments', async () => {
    const h = await setup();
    const help = await h.run(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('approvals approve');
    expect((await h.run(['nope', 'nothing'])).code).toBe(2);
    expect((await h.run(['client', 'create'])).code).toBe(2);
    expect((await h.run(['client', 'list', '--unknown'])).code).toBe(2);
  });
});

describe('crypto', () => {
  it('generates a read-only key file, shows its id and refuses to overwrite', async () => {
    const h = await setup();
    const path = join(h.dir, 'new.key');
    const created = await h.json<{ keyId: string }>(['crypto', 'generate-key', '--out', path]);
    expect((await stat(path)).mode & 0o777).toBe(0o400);
    expect(await h.json<{ keyId: string }>(['crypto', 'key-id', '--file', path])).toEqual({
      keyId: created.keyId,
    });
    const again = await h.run(['crypto', 'generate-key', '--out', path]);
    expect(again.code).toBe(1);
    expect(again.err).toContain('MASTER_KEY_FILE_EXISTS');
  });

  it('rotates the master key after taking a backup', async () => {
    const h = await setup();
    await h.run(['console', 'add', '--alias', 'lab', '--host', '192.0.2.10']);
    await writeFile(join(h.dir, 'k'), 'synthetic-network-key-1');
    await h.run(['console', 'set-credential', 'lab', '--key-file', join(h.dir, 'k')]);
    const next = join(h.dir, 'next.key');
    await h.run(['crypto', 'generate-key', '--out', next]);
    expect((await h.run(['crypto', 'rotate-key', '--new-key-file', next])).code).toBe(1); // needs --yes or a terminal
    const rotated = await h.json<{ reencrypted: number; backup: string }>([
      'crypto',
      'rotate-key',
      '--new-key-file',
      next,
      '--yes',
    ]);
    expect(rotated.reencrypted).toBe(1);
    const old = await h.run(['db', 'check']);
    expect(old.code).toBe(1); // the old key no longer matches the database
    expect(old.out).toContain('MISMATCH');
    expect((await h.run(['db', 'check'], { env: { UNIFI_MCP_MASTER_KEY_FILE: next } })).code).toBe(
      0,
    );
    expect(rotated.backup).toContain('pre-rotation-');
  });
});

describe('admin', () => {
  it('bootstraps the first administrator interactively, once', async () => {
    const h = await setup();
    expect((await h.run(['admin', 'bootstrap', '--username', 'alice'])).err).toContain(
      'interactively',
    );
    expect(
      (
        await h.run(['admin', 'bootstrap', '--username', 'alice'], {
          interactive: true,
          answers: [PASSWORD, 'different'],
        })
      ).err,
    ).toContain('do not match');
    expect(
      (
        await h.run(['admin', 'bootstrap', '--username', 'alice'], {
          interactive: true,
          answers: ['short', 'short'],
        })
      ).err,
    ).toContain('at least 12');
    expect(
      (
        await h.run(['admin', 'bootstrap', '--username', 'alice'], {
          interactive: true,
          answers: [PASSWORD, PASSWORD],
        })
      ).code,
    ).toBe(0);
    const second = await h.run(['admin', 'bootstrap', '--username', 'bob'], {
      interactive: true,
      answers: [PASSWORD, PASSWORD],
    });
    expect(second.code).toBe(1);
    expect(second.err).toContain('already exists');
    expect(
      (
        await h.run(['admin', 'reset-password', '--username', 'alice'], {
          interactive: true,
          answers: ['another long passphrase', 'another long passphrase'],
        })
      ).code,
    ).toBe(0);
    expect(
      (await h.json<{ username: string }[]>(['admin', 'list'])).map((a) => a.username),
    ).toEqual(['alice']);
  });
});

describe('consoles and clients', () => {
  it('manage consoles without ever printing credentials', async () => {
    const h = await setup();
    expect((await h.run(['console', 'add', '--alias', 'Bad', '--host', 'x'])).code).toBe(1);
    expect(
      (
        await h.run([
          'console',
          'add',
          '--alias',
          'lab',
          '--host',
          '192.0.2.10',
          '--description',
          'Lab',
        ])
      ).code,
    ).toBe(0);
    await writeFile(join(h.dir, 'key'), 'synthetic-network-key-SENTINEL\n');
    expect(
      (await h.run(['console', 'set-credential', 'lab', '--key-file', join(h.dir, 'key')])).code,
    ).toBe(0);
    expect(
      (
        await h.run([
          'console',
          'enable-module',
          'lab',
          '--module',
          'network',
          '--mode',
          'read_write',
        ])
      ).code,
    ).toBe(0);
    const shown = await h.json<{
      modules: { moduleId: string; hasCredential: boolean }[];
      policy: { modules: Record<string, { state: string }> };
    }>(['console', 'show', 'lab']);
    expect(shown.modules).toMatchObject([{ moduleId: 'network', hasCredential: true }]);
    expect(shown.policy.modules['network']?.state).toBe('read_write');
    expect(JSON.stringify(shown)).not.toContain('SENTINEL');
    expect((await h.run(['console', 'disable', 'lab'])).code).toBe(0);
    expect(
      (await h.json<{ policy: { state: string } }[]>(['console', 'list']))[0]?.policy.state,
    ).toBe('disabled');
    const scripted = await h.run(['console', 'remove', 'lab']);
    expect(scripted.code).toBe(1);
    expect(scripted.err).toContain('needs confirmation');
    const wrong = await h.run(['console', 'remove', 'lab'], {
      interactive: true,
      answers: ['yes'],
    });
    expect(wrong.err).toContain('nothing was changed');
    expect(await h.json<unknown[]>(['console', 'list'])).toHaveLength(1);
    expect(
      (await h.run(['console', 'remove', 'lab'], { interactive: true, answers: ['lab'] })).code,
    ).toBe(0);
    expect(await h.json<unknown[]>(['console', 'list'])).toEqual([]);
  });

  it('create clients with grants, print the token once, rotate and revoke', async () => {
    const h = await setup();
    await h.run(['console', 'add', '--alias', 'lab', '--host', '192.0.2.10']);
    const created = await h.json<{ clientId: string; token: string }>([
      'client',
      'create',
      'claude-laptop',
      '--console',
      'lab=site-1,site-2',
      '--allow',
      'network.*.read',
      '--sensitive',
      'network_identity',
    ]);
    expect(created.token).toMatch(/^umcp_/);
    const shown = await h.json<{
      policy: { consoles: Record<string, { sites: string[] }>; allow: string[] };
    }>(['client', 'show', 'claude-laptop']);
    expect(Object.values(shown.policy.consoles)).toEqual([{ sites: ['site-1', 'site-2'] }]);
    expect(JSON.stringify(shown)).not.toContain(created.token.slice(18));
    const rotated = await h.json<{ token: string }>(['client', 'rotate', 'claude-laptop']);
    expect(rotated.token).not.toBe(created.token);
    await writeFile(
      join(h.dir, 'policy.yaml'),
      'consoles:\n  lab: { sites: "*" }\nallow: [network.devices.read]\n',
    );
    expect(
      (await h.run(['client', 'set-policy', 'claude-laptop', '--file', join(h.dir, 'policy.yaml')]))
        .code,
    ).toBe(0);
    expect((await h.run(['client', 'revoke', 'claude-laptop'])).code).toBe(0);
    expect(
      (await h.json<{ policy: { status: string } }[]>(['client', 'list']))[0]?.policy.status,
    ).toBe('revoked');
  });
});

describe('policy', () => {
  it('shows, validates, applies with compare-and-set, and switches the runtime mode', async () => {
    const h = await setup();
    const shown = await h.json<{ version: number; forceReadOnly: boolean }>(['policy', 'show']);
    expect(shown).toMatchObject({ version: 1, forceReadOnly: true });
    await writeFile(join(h.dir, 'bad.yaml'), 'deny: [nope]\n');
    expect((await h.run(['policy', 'validate', '--file', join(h.dir, 'bad.yaml')])).code).toBe(1);
    await writeFile(join(h.dir, 'good.yaml'), 'runtimeMode: read_only\ndeny: ["access.*.write"]\n');
    expect((await h.run(['policy', 'validate', '--file', join(h.dir, 'good.yaml')])).code).toBe(0);
    expect(
      (
        await h.run([
          'policy',
          'apply',
          '--file',
          join(h.dir, 'good.yaml'),
          '--expected-version',
          '9',
        ])
      ).err,
    ).toContain('POLICY_VERSION_CONFLICT');
    expect(
      (
        await h.run([
          'policy',
          'apply',
          '--file',
          join(h.dir, 'good.yaml'),
          '--expected-version',
          '1',
        ])
      ).code,
    ).toBe(0);
    const mode = await h.run(['policy', 'set-runtime-mode', 'read_write']);
    expect(mode.out).toContain('hard lock');
  });
});

describe('db', () => {
  it('backs up, checks, verifies a backup and restores it only when the database is free', async () => {
    const h = await setup();
    await h.run(['console', 'add', '--alias', 'lab', '--host', '192.0.2.10']);
    const backup = await h.json<{ path: string; sha256: string }>([
      'db',
      'backup',
      '--out',
      join(h.dir, 'b.db'),
    ]);
    expect(backup.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await h.run(['db', 'check'])).out).toMatch(/Integrity:\s+ok/);
    expect((await h.run(['db', 'check', '--backup', backup.path])).code).toBe(0);
    await h.run(['console', 'remove', 'lab', '--yes']);
    expect((await h.run(['db', 'restore', backup.path])).code).toBe(1); // needs confirmation
    expect((await h.run(['db', 'restore', backup.path, '--yes'])).code).toBe(0);
    expect((await h.json<{ alias: string }[]>(['console', 'list'])).map((c) => c.alias)).toEqual([
      'lab',
    ]);
  });
});

describe('config bootstrap', () => {
  async function writeBootstrap(dir: string, extra = ''): Promise<string> {
    await writeFile(join(dir, 'network.key'), 'synthetic-network-key-1\n');
    const path = join(dir, 'bootstrap.yaml');
    await writeFile(
      path,
      [
        'version: 1',
        'policy:',
        '  runtimeMode: read_only',
        'consoles:',
        '  - alias: home',
        '    host: 192.0.2.10',
        '    tls: { mode: pinned, pins: ["sha256/' + 'A'.repeat(43) + '="] }',
        '    policy: { modules: { network: { state: read_only } } }',
        '    modules:',
        '      network: { credentialFile: network.key }',
        'clients:',
        '  - id: codex-workstation',
        '    policy: { consoles: { home: {} }, allow: ["network.*.read"] }',
        extra,
      ].join('\n'),
    );
    return path;
  }

  it('shows a plan, applies it atomically once, and is then idempotent', async () => {
    const h = await setup();
    const file = await writeBootstrap(h.dir);
    const planned = await h.json<{ entries: { kind: string; name: string; action: string }[] }>([
      'config',
      'import',
      '--file',
      file,
    ]);
    expect(planned.entries.map((e) => `${e.kind}:${e.name}:${e.action}`)).toEqual([
      'policy:global:unchanged',
      'console:home:create',
      'client:codex-workstation:create',
    ]);
    expect(await h.json<unknown[]>(['console', 'list'])).toEqual([]); // import changed nothing
    const applied = await h.json<{ tokens: { clientId: string; token: string }[] }>([
      'config',
      'apply',
      '--file',
      file,
      '--yes',
    ]);
    expect(applied.tokens.map((t) => t.clientId)).toEqual(['codex-workstation']);
    const version = (await h.json<{ version: number }>(['policy', 'show'])).version;
    const again = await h.run(['config', 'apply', '--file', file, '--yes']);
    expect(again.out).toContain('Nothing to change.');
    expect((await h.json<{ version: number }>(['policy', 'show'])).version).toBe(version);
    // Changing one console leaves the unchanged policy and client alone: no version bump,
    // so pending approvals stay valid.
    await writeFile(
      file,
      (await readFile(file, 'utf8')).replace(
        'host: 192.0.2.10',
        'host: 192.0.2.10\n    description: Home lab',
      ),
    );
    const described = await h.json<{ entries: { name: string; action: string }[] }>([
      'config',
      'apply',
      '--file',
      file,
      '--yes',
    ]);
    expect(described.entries.map((e) => `${e.name}:${e.action}`)).toEqual([
      'global:unchanged',
      'home:update',
      'codex-workstation:unchanged',
    ]);
    expect((await h.json<{ version: number }>(['policy', 'show'])).version).toBe(version);
    expect((await h.json<{ description: string }>(['console', 'show', 'home'])).description).toBe(
      'Home lab',
    );
    const client = await h.json<{ policy: { consoles: Record<string, unknown> } }>([
      'client',
      'show',
      'codex-workstation',
    ]);
    const home = await h.json<{ id: string }>(['console', 'show', 'home']);
    expect(Object.keys(client.policy.consoles)).toEqual([home.id]);
  });

  it('rejects inline secrets, unknown fields and unknown console references', async () => {
    const h = await setup();
    const inline = join(h.dir, 'inline.yaml');
    await writeFile(
      inline,
      'version: 1\nconsoles:\n  - alias: home\n    host: 192.0.2.10\n    modules:\n      network: { apiKey: synthetic }\n',
    );
    expect((await h.run(['config', 'import', '--file', inline])).code).toBe(1);
    const unknownConsole = join(h.dir, 'unknown.yaml');
    await writeFile(
      unknownConsole,
      'version: 1\nclients:\n  - id: c1\n    policy: { consoles: { nowhere: {} } }\n',
    );
    expect((await h.run(['config', 'import', '--file', unknownConsole])).err).toContain(
      'unknown console "nowhere"',
    );
  });

  it('reports configuration that exists only in the database', async () => {
    const h = await setup();
    await h.run(['console', 'add', '--alias', 'legacy', '--host', '192.0.2.20']);
    const file = await writeBootstrap(h.dir);
    const planned = await h.json<{ notInFile: { consoles: string[] } }>([
      'config',
      'import',
      '--file',
      file,
    ]);
    expect(planned.notInFile.consoles).toEqual(['legacy']);
  });

  it('shows the effective configuration without secrets', async () => {
    const h = await setup();
    const effective = await h.json<{ masterKeyId: string; deployment: { forceReadOnly: boolean } }>(
      ['config', 'show-effective'],
    );
    expect(effective.masterKeyId).toMatch(/^[0-9a-f]{32}$/);
    expect(effective.deployment.forceReadOnly).toBe(true);
    const keyText = (await readFile(h.env['UNIFI_MCP_MASTER_KEY_FILE'] ?? '', 'utf8')).trim();
    expect(JSON.stringify(effective)).not.toContain(keyText);
  });
});

describe('doctor and api coverage', () => {
  it('reports problems and fails closed without a key', async () => {
    const h = await setup();
    const report = await h.json<{ check: string; status: string }[]>(['doctor']);
    expect(report.find((c) => c.check === 'administrators')?.status).toBe('warn');
    expect(report.find((c) => c.check === 'hard lock')?.status).toBe('ok');
    const noKey = await (
      await cliHarness(await tempDir(), { UNIFI_MCP_MASTER_KEY_FILE: '' })
    ).run(['doctor']);
    expect(noKey.code).toBe(1);
  });

  it('counts an operation for a revision only within its verified version range', async () => {
    // A made-up Network 12.0.0 that documents exactly the 11.0.97 operations: the Network
    // operations are verified for >=11.0.97 <12, so none counts as implemented for it.
    const specs = join(await tempDir(), 'api-specs');
    for (const revision of ['11.0.97', '12.0.0']) {
      await mkdir(join(specs, 'network', revision), { recursive: true });
      await copyFile(
        join(import.meta.dirname, '../../../api-specs/network/11.0.97/operations.json'),
        join(specs, 'network', revision, 'operations.json'),
      );
    }
    const h = await setup({ UNIFI_MCP_API_SPECS_DIR: specs });
    const rows = await h.json<{ revision: string; implemented: number }[]>(['api', 'coverage']);
    expect(Object.fromEntries(rows.map((r) => [r.revision, r.implemented]))).toEqual({
      '11.0.97': 73,
      '12.0.0': 0,
    });
  });

  it('lists the documented official operations', async () => {
    const h = await setup();
    const rows = await h.json<
      { module: string; revision: string; documented: number; implemented: number }[]
    >(['api', 'coverage']);
    expect(
      Object.fromEntries(
        rows.map((r) => [`${r.module}/${r.revision}`, [r.documented, r.implemented]]),
      ),
    ).toEqual({
      'access/2026-03-23': [107, 0],
      'network/11.0.97': [73, 73],
      // Operations of the official release also cover the newer revision (ADR 0019 §7).
      'protect/7.3.74': [74, 73],
      'protect/7.4.96': [83, 81],
    });
  });
});

describe('console check', () => {
  it('verifies TLS and shows the pin without sending a request', async () => {
    const pki = testPki();
    const mock = await MockConsole.start({ key: pki.selfKey, cert: pki.selfCert });
    try {
      const h = await setup({ UNIFI_MCP_EGRESS_ALLOW_CIDRS: '127.0.0.1/32' });
      await h.run(['console', 'add', '--alias', 'lab', '--host', '127.0.0.1']);
      await h.run(['console', 'enable-module', 'lab', '--port', String(mock.port)]);
      const unverified = await h.run(['console', 'check', 'lab']);
      expect(unverified.code).toBe(1);
      const pin = `sha256/${spkiSha256(new X509Certificate(pki.selfCert))}`;
      expect(unverified.out).toContain(pin);
      await h.run(['console', 'set-tls', 'lab', '--tls', 'pinned', '--pin', pin]);
      const pinned = await h.run(['console', 'check', 'lab']);
      expect(pinned.code).toBe(0);
      expect(pinned.out).toMatch(/verified:\s+yes/);
      const warned = await h.run(['console', 'set-tls', 'lab', '--tls', 'insecure']);
      expect(warned.err).toContain('TLS verification will be DISABLED');
      const insecure = await h.run(['console', 'check', 'lab']);
      expect(insecure.out).toMatch(/verified:\s+no/);
      expect(mock.requests).toEqual([]);
    } finally {
      await mock.stop();
    }
  });
});

describe('console probe', () => {
  it('learns the version with one documented read and says whether it is supported', async () => {
    const pki = testPki();
    const mock = await MockConsole.start({ key: pki.serverKey, cert: pki.serverCert });
    const reported = { version: '11.0.97' };
    mock.respond = (req, res) => {
      if (req.url === '/proxy/network/integration/v1/info') {
        sendJson(res, 200, { applicationVersion: reported.version });
      } else {
        sendJson(res, 404, {});
      }
    };
    try {
      const h = await setup({ UNIFI_MCP_EGRESS_ALLOW_CIDRS: '127.0.0.1/32' });
      const pin = `sha256/${spkiSha256(new X509Certificate(pki.serverCert))}`;
      const keyFile = join(h.dir, 'network.key');
      await writeFile(keyFile, 'synthetic-network-key-SENTINEL-55\n', { mode: 0o600 });
      await h.run(['console', 'add', '--alias', 'lab', '--host', '127.0.0.1']);
      await h.run(['console', 'set-tls', 'lab', '--tls', 'pinned', '--pin', pin]);
      await h.run(['console', 'set-credential', 'lab', '--key-file', keyFile]);

      const disabled = await h.run(['console', 'probe', 'lab']);
      expect(disabled.code).toBe(1);
      expect(disabled.err).toContain('module_disabled');
      expect(mock.requests).toEqual([]);

      await h.run(['console', 'enable-module', 'lab', '--port', String(mock.port)]);
      const probed = await h.run(['console', 'probe', 'lab']);
      expect(probed.code).toBe(0);
      expect(probed.out).toContain('network on "lab": 11.0.97');
      expect(probed.out).toContain('supported (>=11.0.97 <12)');
      expect(mock.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
        'GET /proxy/network/integration/v1/info',
      ]);

      reported.version = '10.3.55';
      const old = await h.run(['console', 'probe', 'lab']);
      expect(old.code).toBe(1);
      expect(old.out).toContain('10.3.55 (was 11.0.97)');
      expect(old.out).toContain('NOT supported');
      const shown = await h.json<{ consoles: { modules: { observedVersion: string | null }[] }[] }>(
        ['console', 'show', 'lab'],
      );
      expect(JSON.stringify(shown)).toContain('10.3.55');
    } finally {
      await mock.stop();
    }
  });
});

describe('dry runs', () => {
  it('validate permission changes exactly like the real change, and change nothing', async () => {
    const h = await setup();
    await h.run(['console', 'add', '--alias', 'lab', '--host', '192.0.2.10']);
    await h.run(['client', 'create', 'agent', '--console', 'lab']);
    const version = (await h.json<{ version: number }>(['policy', 'show'])).version;
    const auditBefore = (await h.json<unknown[]>(['audit', 'list', '--limit', '500'])).length;

    const global = join(h.dir, 'global.yaml');
    await writeFile(global, 'runtimeMode: read_only\ndeny: ["access.*.write"]\n');
    const g = await h.json<{ dryRun: boolean; changes: boolean }>([
      'policy',
      'apply',
      '--file',
      global,
      '--dry-run',
    ]);
    expect(g).toMatchObject({ dryRun: true, changes: true });
    await writeFile(join(h.dir, 'bad.yaml'), 'deny: [nope]\n');
    expect(
      (await h.run(['policy', 'apply', '--file', join(h.dir, 'bad.yaml'), '--dry-run'])).code,
    ).toBe(1);

    const client = join(h.dir, 'client.yaml');
    await writeFile(client, 'consoles:\n  lab: { sites: "*" }\nallow: ["network.*.read"]\n');
    const c = await h.json<{ changes: boolean }>([
      'client',
      'set-policy',
      'agent',
      '--file',
      client,
      '--dry-run',
    ]);
    expect(c.changes).toBe(true);
    await writeFile(join(h.dir, 'bad-client.yaml'), 'allow: 7\n');
    expect(
      (
        await h.run([
          'client',
          'set-policy',
          'agent',
          '--file',
          join(h.dir, 'bad-client.yaml'),
          '--dry-run',
        ])
      ).code,
    ).toBe(1);
    expect(
      (await h.run(['client', 'set-policy', 'nobody', '--file', client, '--dry-run'])).code,
    ).toBe(1);

    const consolePolicy = join(h.dir, 'console.yaml');
    await writeFile(consolePolicy, 'modules: { network: { state: read_only } }\n');
    const k = await h.json<{ changes: boolean }>([
      'console',
      'set-policy',
      'lab',
      '--file',
      consolePolicy,
      '--dry-run',
    ]);
    expect(k.changes).toBe(true);
    await writeFile(
      join(h.dir, 'bad-console.yaml'),
      'modules: { teleport: { state: read_only } }\n',
    );
    expect(
      (
        await h.run([
          'console',
          'set-policy',
          'lab',
          '--file',
          join(h.dir, 'bad-console.yaml'),
          '--dry-run',
        ])
      ).err,
    ).toContain('Unknown modules');

    const bootstrap = join(h.dir, 'bootstrap.yaml');
    await writeFile(bootstrap, 'version: 1\nconsoles:\n  - alias: second\n    host: 192.0.2.30\n');
    const b = await h.json<{ dryRun: boolean; entries: { name: string; action: string }[] }>([
      'config',
      'apply',
      '--file',
      bootstrap,
      '--dry-run',
    ]);
    expect(b.entries).toEqual([expect.objectContaining({ name: 'second', action: 'create' })]);

    expect((await h.json<{ version: number }>(['policy', 'show'])).version).toBe(version);
    expect((await h.json<{ alias: string }[]>(['console', 'list'])).map((x) => x.alias)).toEqual([
      'lab',
    ]);
    expect(await h.json<unknown[]>(['audit', 'list', '--limit', '500'])).toHaveLength(auditBefore);
  });
});

describe('audit', () => {
  it('lists entries with filters and verifies the chain', async () => {
    const h = await setup();
    await h.run(['console', 'add', '--alias', 'lab', '--host', '192.0.2.10']);
    const entries = await h.json<{ seq: number; actorType: string; action: string }[]>([
      'audit',
      'list',
      '--actor-type',
      'cli',
    ]);
    expect(entries.map((e) => e.action)).toContain('console.add');
    expect(entries.every((e) => e.actorType === 'cli')).toBe(true);
    const older = await h.json<{ seq: number }[]>([
      'audit',
      'list',
      '--before-seq',
      String(entries[0]?.seq ?? 0),
      '--limit',
      '1',
    ]);
    expect(older).toHaveLength(1);
    expect(older[0]?.seq).toBeLessThan(entries[0]?.seq ?? 0);
    expect((await h.run(['audit', 'list', '--actor-type', 'robot'])).code).toBe(2);
    expect((await h.run(['audit', 'list', '--limit', '0'])).code).toBe(2);
    expect((await h.run(['audit', 'list', '--since', 'yesterday-ish'])).code).toBe(2);
    expect((await h.run(['audit', 'verify'])).out).toContain('intact');
  });

  it('reports a tampered chain', async () => {
    const h = await setup();
    await h.run(['console', 'add', '--alias', 'lab', '--host', '192.0.2.10']);
    await h.run(['console', 'add', '--alias', 'lab2', '--host', '192.0.2.11']);
    const db = SqliteDatabase.open(join(h.env['UNIFI_MCP_DATA_DIR'] ?? '', 'unifi-mcp.db'));
    db.exec('DROP TRIGGER audit_entries_immutable');
    db.run("UPDATE audit_entries SET action = 'nothing.happened' WHERE action = 'console.add'");
    db.close();
    const verify = await h.run(['audit', 'verify']);
    expect(verify.code).toBe(1);
    expect(verify.out).toContain('BROKEN');
    expect((await h.run(['doctor'])).code).toBe(1);
  });
});

describe('maintenance beside a running service', () => {
  it('refuses key rotation and restore while the data directory is locked', async () => {
    const h = await setup();
    await h.run(['console', 'add', '--alias', 'lab', '--host', '192.0.2.10']);
    const backup = await h.json<{ path: string }>(['db', 'backup', '--out', join(h.dir, 'b.db')]);
    const next = join(h.dir, 'next.key');
    await h.run(['crypto', 'generate-key', '--out', next]);
    const lock = acquireInstanceLock(h.env['UNIFI_MCP_DATA_DIR'] ?? '', 'start the service');
    try {
      const rotate = await h.run(['crypto', 'rotate-key', '--new-key-file', next, '--yes']);
      expect(rotate.code).toBe(1);
      expect(rotate.err).toContain('DATA_DIRECTORY_IN_USE');
      const restore = await h.run(['db', 'restore', backup.path, '--yes']);
      expect(restore.code).toBe(1);
      expect(restore.err).toContain('DATA_DIRECTORY_IN_USE');
      // Everyday commands work beside the service.
      expect((await h.run(['client', 'create', 'agent', '--console', 'lab'])).code).toBe(0);
      expect((await h.run(['db', 'backup', '--out', join(h.dir, 'c.db')])).code).toBe(0);
    } finally {
      lock.release();
    }
    expect((await h.run(['crypto', 'rotate-key', '--new-key-file', next, '--yes'])).code).toBe(0);
  });
});

describe('example bootstrap file', () => {
  it('deploy/example-bootstrap.yaml is valid, and validate checks embedded policies', async () => {
    const h = await setup();
    const example = join(import.meta.dirname, '../../../deploy/example-bootstrap.yaml');
    expect((await h.run(['config', 'validate', '--file', example])).code).toBe(0);
    const bad = join(h.dir, 'bad.yaml');
    await writeFile(
      bad,
      'version: 1\nconsoles:\n  - alias: home\n    host: 192.0.2.1\n    policy: { modules: { network: { state: everything } } }\n',
    );
    const run = await h.run(['config', 'validate', '--file', bad]);
    expect(run.code).toBe(1);
    expect(run.err).toContain('Console "home"');
    const badClient = join(h.dir, 'bad-client.yaml');
    await writeFile(
      badClient,
      'version: 1\nclients:\n  - id: c1\n    policy: { allow: ["not a selector"] }\n',
    );
    expect((await h.run(['config', 'validate', '--file', badClient])).err).toContain('Client "c1"');
  });
});
