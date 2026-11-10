/**
 * Administrator accounts and Argon2id password hashing (spec §7.2; ADR 0015).
 */
import { join } from 'node:path';
import {
  AdminError,
  AdminStore,
  hashPassword,
  passwordProblem,
  verifyPassword,
} from '@unifi-local-mcp/admin-api';
import { PolicyStore, type PolicyActor } from '@unifi-local-mcp/policy';
import { databasePathFor, openStorage } from '@unifi-local-mcp/storage';
import { AuditLog } from '@unifi-local-mcp/telemetry';
import { describe, expect, it } from 'vitest';
import { testKey, useTempDirs } from '../storage/fixtures.ts';
import { memoryLogger } from '../telemetry/fixtures.ts';

const tempDir = useTempDirs();
const CLI: PolicyActor = { type: 'cli', id: 'root' };
const PASSWORD = 'correct horse battery staple';

async function setup() {
  const storage = await openStorage({
    databasePath: databasePathFor(join(await tempDir(), 'data')),
    masterKey: testKey('admins'),
  });
  const audit = new AuditLog(storage.db, { logger: memoryLogger().logger });
  new PolicyStore(storage.db, audit).current();
  return { storage, audit, admins: new AdminStore({ db: storage.db, audit }) };
}

describe('passwords', () => {
  it('hash with Argon2id in PHC format and verify only the right password', () => {
    const hash = hashPassword(PASSWORD);
    expect(hash).toMatch(
      /^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
    expect(hashPassword(PASSWORD)).not.toBe(hash); // fresh salt
    expect(verifyPassword(hash, PASSWORD)).toBe(true);
    expect(verifyPassword(hash, `${PASSWORD} `)).toBe(false);
    expect(verifyPassword('$argon2id$v=19$m=1,t=1,p=1$bad', PASSWORD)).toBe(false);
    expect(verifyPassword('plain', PASSWORD)).toBe(false);
  });

  it.each([
    ['short1', 'at least 12'],
    ['alice-is-my-password', 'username'],
    ['aaaaaaaaaaaaaaaa', 'repetitive'],
  ])('rejects %j', (password, reason) => {
    expect(passwordProblem(password, 'alice')).toContain(reason);
  });
});

describe('AdminStore', () => {
  it('bootstraps exactly one first administrator, from the CLI only', async () => {
    const { storage, audit, admins } = await setup();
    expect(() => admins.bootstrap('alice', PASSWORD, { type: 'admin', id: 'x' })).toThrow(
      AdminError,
    );
    const alice = admins.bootstrap('Alice', PASSWORD, CLI);
    expect(alice).toMatchObject({ username: 'alice', status: 'active' });
    expect(() => admins.bootstrap('bob', PASSWORD, CLI)).toThrow(/already exists/);
    expect(audit.list({ limit: 1 })[0]).toMatchObject({
      action: 'admin.bootstrap',
      actorType: 'cli',
    });
    expect(JSON.stringify(audit.list({ limit: 100 }))).not.toContain(PASSWORD);
    storage.close();
  });

  it('verifies credentials without revealing whether the user exists', async () => {
    const { storage, admins } = await setup();
    admins.bootstrap('alice', PASSWORD, CLI);
    expect(admins.verify('alice', PASSWORD)?.username).toBe('alice');
    expect(admins.verify('ALICE ', PASSWORD)?.username).toBe('alice');
    expect(admins.verify('alice', 'wrong password here')).toBeUndefined();
    expect(admins.verify('mallory', PASSWORD)).toBeUndefined();
    storage.db.run("UPDATE admins SET status = 'disabled' WHERE username = 'alice'");
    expect(admins.verify('alice', PASSWORD)).toBeUndefined();
    storage.close();
  });

  it('resets a password from the CLI only', async () => {
    const { storage, admins } = await setup();
    admins.bootstrap('alice', PASSWORD, CLI);
    expect(() =>
      admins.resetPassword('alice', 'another long passphrase', { type: 'admin', id: 'alice' }),
    ).toThrow(/local CLI/);
    storage.db.run("UPDATE admins SET status = 'disabled' WHERE username = 'alice'");
    admins.resetPassword('alice', 'another long passphrase', CLI); // also re-enables
    expect(admins.verify('alice', PASSWORD)).toBeUndefined();
    expect(admins.verify('alice', 'another long passphrase')?.username).toBe('alice');
    expect(() => admins.resetPassword('nobody', 'another long passphrase', CLI)).toThrow(
      /No administrator/,
    );
    storage.close();
  });
});
