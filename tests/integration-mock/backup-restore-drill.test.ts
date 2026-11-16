/**
 * Backup, restore and key-rotation drill, end to end through the CLI (spec §8.2, §17
 * "SQLite restart, migration, key rotation and backup/restore are tested"; ADR 0007):
 * a database with a console credential, a client token and an administrator's second
 * step is backed up, damaged, restored, rotated to a new key and restored again, and
 * every secret is shown to work afterwards. The same drill runs against the container
 * image in tests/container-network/drill.test.ts.
 */
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AdminMfa, AdminStore, totpCode } from '@unifi-local-mcp/admin-api';
import { ClientStore } from '@unifi-local-mcp/mcp-server';
import { databasePathFor, openStorage, readMasterKeyFile } from '@unifi-local-mcp/storage';
import { AuditLog } from '@unifi-local-mcp/telemetry';
import { ConsoleRegistry } from '@unifi-local-mcp/unifi-api';
import { describe, expect, it } from 'vitest';
import { cliHarness } from '../unit/cli/fixtures.ts';
import { useTempDirs } from '../unit/storage/fixtures.ts';
import { memoryLogger } from '../unit/telemetry/fixtures.ts';

const tempDir = useTempDirs();
const PASSWORD = 'correct horse battery staple';
const CONSOLE_KEY = 'synthetic-network-key-DRILL-7';

/** Opens the database with a key file and checks that every stored secret still works. */
async function secretsWork(
  dir: string,
  keyFile: string,
  expected: { totpSecret: string; clientToken: string; at: Date },
): Promise<void> {
  const { key } = await readMasterKeyFile(keyFile);
  const storage = await openStorage({
    databasePath: databasePathFor(join(dir, 'data')),
    masterKey: key,
  });
  try {
    const { logger } = memoryLogger();
    const now = (): Date => expected.at;
    const audit = new AuditLog(storage.db, { logger, now });
    const admins = new AdminStore({ db: storage.db, audit, now });
    const alice = admins.list()[0];
    expect(alice?.username).toBe('alice');
    expect(admins.verify('alice', PASSWORD)).toBeDefined();
    const mfa = new AdminMfa({ db: storage.db, audit, secrets: storage.secrets, now });
    expect(mfa.status(alice?.id ?? '').state).toBe('active');
    expect(mfa.verify(alice?.id ?? '', totpCode(expected.totpSecret, now()))).toBe('totp');
    const consoles = new ConsoleRegistry({
      db: storage.db,
      audit,
      secrets: storage.secrets,
      logger,
      now,
    });
    const lab = consoles.get('lab');
    expect(consoles.connection(lab?.id ?? '', 'network')?.credential?.reveal()).toBe(CONSOLE_KEY);
    const clients = new ClientStore({ db: storage.db, audit, now });
    expect(clients.authenticate(expected.clientToken)?.clientId).toBe('probe');
    expect(audit.verifyChain().ok).toBe(true);
  } finally {
    storage.close();
  }
}

describe('backup, restore and key rotation drill', () => {
  it('brings back every credential, token and second step, and only with the right key', async () => {
    const h = await cliHarness(await tempDir());
    const keyFile = h.env['UNIFI_MCP_MASTER_KEY_FILE'] ?? '';
    const ok = async (argv: string[], options?: Parameters<typeof h.run>[1]) => {
      const result = await h.run(argv, options);
      if (result.code !== 0) throw new Error(`${argv.join(' ')}: ${result.err}`);
      return result;
    };

    // 1. A database worth backing up.
    await ok(['admin', 'bootstrap', '--username', 'alice'], {
      interactive: true,
      answers: [PASSWORD, PASSWORD],
    });
    let totpSecret = '';
    await ok(['admin', 'enable-mfa', '--username', 'alice'], {
      interactive: true,
      answers: [
        (printed) => {
          totpSecret = (/Key: {2}([A-Z2-7 ]+)/.exec(printed)?.[1] ?? '').replace(/ /g, '');
          return totpCode(totpSecret, new Date());
        },
      ],
    });
    await ok(['console', 'add', '--alias', 'lab', '--host', '192.0.2.10']);
    await writeFile(join(h.dir, 'console.key'), CONSOLE_KEY);
    await ok(['console', 'set-credential', 'lab', '--key-file', join(h.dir, 'console.key')]);
    await ok(['console', 'enable-module', 'lab', '--module', 'network']);
    const created = await h.json<{ token: string }>([
      'client',
      'create',
      'probe',
      '--console',
      'lab',
      '--allow',
      'network.*.read',
    ]);
    // Codes are checked a few minutes ahead, so a code is never reused between checks.
    let minutes = 5;
    const expected = () => ({
      totpSecret,
      clientToken: created.token,
      at: new Date(Date.now() + minutes++ * 60_000),
    });
    await secretsWork(h.dir, keyFile, expected());

    // 2. Back up, then lose things.
    const backup = await h.json<{ path: string; keyId: string; sha256: string; bytes: number }>([
      'db',
      'backup',
    ]);
    expect((await stat(backup.path)).mode & 0o777).toBe(0o600);
    const verified = await h.json<{ secretRecords: number; keyId: string }>([
      'db',
      'check',
      '--backup',
      backup.path,
    ]);
    expect(verified).toMatchObject({ secretRecords: 2, keyId: backup.keyId });
    await ok(['admin', 'reset-mfa', '--username', 'alice', '--yes']);
    await ok(['client', 'revoke', 'probe']);
    await ok(['console', 'remove', 'lab', '--yes']);
    expect(await h.json<unknown[]>(['console', 'list'])).toEqual([]);

    // 3. A damaged or foreign backup is refused, and nothing changes.
    const damaged = join(h.dir, 'damaged.db');
    const bytes = await readFile(backup.path);
    bytes.fill(0x5a, Math.floor(bytes.length / 2), Math.floor(bytes.length / 2) + 4096);
    await writeFile(damaged, bytes);
    const refused = await h.run(['db', 'restore', damaged, '--yes']);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('RESTORE_REJECTED');
    const otherKey = join(h.dir, 'other.key');
    await ok(['crypto', 'generate-key', '--out', otherKey]);
    const foreign = await h.run(['db', 'restore', backup.path, '--yes'], {
      env: { UNIFI_MCP_MASTER_KEY_FILE: otherKey },
    });
    expect(foreign.code).toBe(1);
    expect(foreign.err).toMatch(/RESTORE_REJECTED|MASTER_KEY_MISMATCH/);
    expect(await h.json<unknown[]>(['console', 'list'])).toEqual([]);

    // 4. Restore: everything is back, and the replaced database is kept beside it.
    const restored = await ok(['db', 'restore', backup.path, '--yes']);
    expect(restored.out).toContain('The previous database was kept as');
    await secretsWork(h.dir, keyFile, expected());
    expect((await h.run(['db', 'check'])).code).toBe(0);
    const audit = await h.json<{ action: string }[]>(['audit', 'list']);
    expect(audit[0]?.action).toBe('db.restore');
    const kinds = async () =>
      (await h.json<{ kind: string }[]>(['db', 'backups'])).map((f) => f.kind).sort();
    expect(await kinds()).toEqual(['manual', 'pre-restore']);

    // 5. Rotate the master key: the new key opens everything, the old one nothing.
    const nextKey = join(h.dir, 'next.key');
    await ok(['crypto', 'generate-key', '--out', nextKey]);
    const rotated = await h.json<{ reencrypted: number; backup: string }>([
      'crypto',
      'rotate-key',
      '--new-key-file',
      nextKey,
      '--yes',
    ]);
    expect(rotated.reencrypted).toBe(2);
    const withNext = { env: { UNIFI_MCP_MASTER_KEY_FILE: nextKey } };
    expect((await h.run(['db', 'check'], withNext)).code).toBe(0);
    await secretsWork(h.dir, nextKey, expected());
    const oldKey = await h.run(['db', 'check']);
    expect(oldKey.code).toBe(1);
    expect(oldKey.out).toContain('MISMATCH');
    expect((await h.run(['doctor'])).code).toBe(1);
    expect((await h.run(['doctor'], withNext)).code).toBe(0);

    // 6. A backup needs the key that was active when it was taken.
    expect((await h.run(['db', 'check', '--backup', rotated.backup], withNext)).code).toBe(1);
    expect((await h.run(['db', 'check', '--backup', rotated.backup])).code).toBe(0);
    const wrongKey = await h.run(['db', 'restore', backup.path, '--yes'], withNext);
    expect(wrongKey.code).toBe(1);
    expect(wrongKey.err).toContain('RESTORE_REJECTED');
    await secretsWork(h.dir, nextKey, expected());
    // With the retired key configured again, the old backup restores, as the manual says.
    await ok(['db', 'restore', backup.path, '--yes']);
    await secretsWork(h.dir, keyFile, expected());

    // 7. Retention: automatic backups are pruned on request, manual ones never.
    await copyFile(backup.path, backup.path.replace('manual-', 'pre-rotation-2020'));
    expect(await kinds()).toEqual([
      'manual',
      'pre-restore',
      'pre-restore',
      'pre-rotation',
      'pre-rotation',
    ]);
    const dry = await h.json<{ deleted: { kind: string }[]; dryRun: boolean }>([
      'db',
      'prune-backups',
      '--keep',
      '1',
      '--dry-run',
    ]);
    expect(dry.dryRun).toBe(true);
    expect(dry.deleted.map((f) => f.kind).sort()).toEqual(['pre-restore', 'pre-rotation']);
    expect((await kinds()).length).toBe(5);
    const unconfirmed = await h.run(['db', 'prune-backups', '--keep', '1']);
    expect(unconfirmed.code).toBe(1);
    expect((await kinds()).length).toBe(5);
    for (const bad of ['0', 'all', '1.5']) {
      expect((await h.run(['db', 'prune-backups', '--keep', bad, '--yes'])).code).toBe(2);
    }
    await ok(['db', 'prune-backups', '--keep', '1', '--yes']);
    expect(await kinds()).toEqual(['manual', 'pre-restore', 'pre-rotation']);
    expect((await h.json<{ action: string }[]>(['audit', 'list']))[0]?.action).toBe(
      'db.prune_backups',
    );
    const doctor = await h.json<{ check: string; status: string; detail: string }[]>(['doctor']);
    expect(doctor.find((c) => c.check === 'backups')).toMatchObject({
      status: 'ok',
      detail: expect.stringMatching(/^3 file\(s\), \d+ MiB, newest \d{4}-\d{2}-\d{2}$/) as string,
    });
    await ok(['db', 'prune-backups', '--keep', '1', '--yes']); // nothing left to delete
  });
});
