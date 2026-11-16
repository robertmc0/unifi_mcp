/**
 * Two-step sign-in storage and rules (spec §7.2; ADR 0026): enrolment on the host only,
 * an encrypted secret, codes that work once, hashed one-time recovery codes, and sessions
 * that end when the second step changes.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AdminError,
  AdminMfa,
  AdminSessionStore,
  AdminStore,
  RECOVERY_CODE_COUNT,
  totpCode,
} from '@unifi-local-mcp/admin-api';
import { PolicyStore, type PolicyActor } from '@unifi-local-mcp/policy';
import { databasePathFor, openStorage } from '@unifi-local-mcp/storage';
import { AuditLog } from '@unifi-local-mcp/telemetry';
import { describe, expect, it } from 'vitest';
import { testKey, useTempDirs } from '../storage/fixtures.ts';
import { memoryLogger } from '../telemetry/fixtures.ts';

const tempDir = useTempDirs();
const CLI: PolicyActor = { type: 'cli', id: 'root' };
const WEB: PolicyActor = { type: 'admin', id: 'alice' };
const PASSWORD = 'correct horse battery staple';
const STEP_MS = 30_000;

async function setup() {
  const databasePath = databasePathFor(join(await tempDir(), 'data'));
  const storage = await openStorage({ databasePath, masterKey: testKey('mfa') });
  const { logger, lines } = memoryLogger();
  const clock = { time: Date.parse('2026-11-16T10:00:15.000Z') };
  const now = (): Date => new Date(clock.time);
  const audit = new AuditLog(storage.db, { logger, now });
  new PolicyStore(storage.db, audit).current();
  const admins = new AdminStore({ db: storage.db, audit, now });
  const alice = admins.bootstrap('alice', PASSWORD, CLI);
  const mfa = new AdminMfa({ db: storage.db, audit, secrets: storage.secrets, now });
  const sessions = new AdminSessionStore({ db: storage.db, admins, now });
  /** Enrols alice and returns her secret and recovery codes. */
  const enrol = (): { secret: string; codes: string[] } => {
    const { secret } = mfa.begin('alice', CLI);
    return { secret, codes: mfa.confirm('alice', totpCode(secret, now()), CLI) };
  };
  return { storage, databasePath, audit, lines, clock, now, admins, alice, mfa, sessions, enrol };
}

describe('enrolment', () => {
  it('is pending until a code from the app proves it works', async () => {
    const { storage, alice, mfa, now, audit } = await setup();
    expect(mfa.status(alice.id)).toEqual({ state: 'off', confirmedAt: null, recoveryCodesLeft: 0 });
    const { secret, uri } = mfa.begin('Alice ', CLI);
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain('unifi-local-mcp:alice');
    expect(mfa.status(alice.id).state).toBe('pending');
    // A pending enrolment is not a second step: nothing verifies against it.
    expect(mfa.verify(alice.id, totpCode(secret, now()))).toBeUndefined();

    expect(() => mfa.confirm('alice', '000000', CLI)).toThrow(/does not match/);
    expect(mfa.status(alice.id).state).toBe('pending');
    // Starting again replaces the pending key; the first key no longer confirms.
    const second = mfa.begin('alice', CLI);
    expect(second.secret).not.toBe(secret);
    expect(() => mfa.confirm('alice', totpCode(secret, now()), CLI)).toThrow(AdminError);

    const codes = mfa.confirm('alice', ` ${totpCode(second.secret, now())} `, CLI);
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
    expect(mfa.status(alice.id)).toEqual({
      state: 'active',
      confirmedAt: now().toISOString(),
      recoveryCodesLeft: RECOVERY_CODE_COUNT,
    });
    expect(audit.list({ limit: 1 })[0]).toMatchObject({
      eventType: 'admin.security',
      action: 'admin.mfa_enable',
      actorType: 'cli',
      details: { username: 'alice', sessionsEnded: 0 },
    });
    // One secret record remains: the replaced pending key was deleted.
    expect(
      storage.db.all("SELECT id FROM secret_records WHERE kind = 'admin.totp_secret'"),
    ).toHaveLength(1);
    storage.close();
  });

  it('can be cancelled, and is refused while a second step is active', async () => {
    const { storage, alice, mfa, enrol } = await setup();
    mfa.begin('alice', CLI);
    mfa.cancel('alice', CLI);
    expect(mfa.status(alice.id).state).toBe('off');
    expect(storage.db.all('SELECT id FROM secret_records')).toEqual([]);
    expect(() => mfa.confirm('alice', '123456', CLI)).toThrow(/No enrolment/);
    enrol();
    expect(() => mfa.begin('alice', CLI)).toThrow(/already active/);
    // Cancelling never removes an active second step.
    mfa.cancel('alice', CLI);
    expect(mfa.status(alice.id).state).toBe('active');
    expect(() => mfa.begin('bob', CLI)).toThrow(/No administrator "bob"/);
    storage.close();
  });

  it('is a host action: no other actor can start, finish, reset or renew it', async () => {
    const { storage, alice, mfa, enrol } = await setup();
    expect(() => mfa.begin('alice', WEB)).toThrow(/only with the local CLI/);
    const { secret } = mfa.begin('alice', CLI);
    expect(() => mfa.confirm('alice', '123456', WEB)).toThrow(/only with the local CLI/);
    expect(() => {
      mfa.cancel('alice', WEB);
    }).toThrow(/only with the local CLI/);
    expect(secret).not.toBe('');
    mfa.cancel('alice', CLI);
    enrol();
    expect(() => mfa.reset('alice', WEB)).toThrow(/only with the local CLI/);
    expect(() => mfa.regenerateRecoveryCodes('alice', { type: 'system' })).toThrow(
      /only with the local CLI/,
    );
    expect(mfa.status(alice.id).state).toBe('active');
    storage.close();
  });
});

describe('codes', () => {
  it('work once: the same code and older codes are refused afterwards', async () => {
    const { storage, alice, mfa, clock, now, enrol } = await setup();
    const { secret } = enrol();
    // The code that confirmed the enrolment is already used.
    expect(mfa.verify(alice.id, totpCode(secret, now()))).toBeUndefined();
    clock.time += STEP_MS;
    const code = totpCode(secret, now());
    expect(mfa.verify(alice.id, '000000')).toBeUndefined();
    expect(mfa.verify(alice.id, ` ${code.slice(0, 3)} ${code.slice(3)} `)).toBe('totp');
    expect(mfa.verify(alice.id, code)).toBeUndefined();
    // One step of drift: the next code is accepted early, and then the current one is old.
    clock.time += STEP_MS;
    const current = totpCode(secret, now());
    const next = totpCode(secret, new Date(now().getTime() + STEP_MS));
    expect(mfa.verify(alice.id, next)).toBe('totp');
    expect(mfa.verify(alice.id, current)).toBeUndefined();
    // A code from long ago, or for another account's time, is not accepted.
    clock.time += 10 * STEP_MS;
    expect(mfa.verify(alice.id, next)).toBeUndefined();
    expect(mfa.verify(alice.id, totpCode(secret, now()))).toBe('totp');
    expect(
      mfa.verify('00000000-0000-4000-8000-000000000000', totpCode(secret, now())),
    ).toBeUndefined();
    storage.close();
  });

  it('recovery codes work once each, however they are typed', async () => {
    const { storage, alice, mfa, enrol } = await setup();
    const { codes } = enrol();
    const [first = '', second = '', third = ''] = codes;
    expect(mfa.verify(alice.id, first)).toBe('recovery_code');
    expect(mfa.verify(alice.id, first)).toBeUndefined();
    expect(mfa.verify(alice.id, second.toLowerCase().replace(/-/g, ' '))).toBe('recovery_code');
    expect(mfa.verify(alice.id, `  ${third.replace(/-/g, '')}  `)).toBe('recovery_code');
    expect(mfa.status(alice.id).recoveryCodesLeft).toBe(RECOVERY_CODE_COUNT - 3);
    for (const bad of [
      '',
      'AAAA-AAAA-AAAA-AAAA',
      first.slice(0, -1),
      `${first}A`,
      '0000-0000-0000-0000',
    ]) {
      expect(mfa.verify(alice.id, bad), bad).toBeUndefined();
    }
    expect(mfa.status(alice.id).recoveryCodesLeft).toBe(RECOVERY_CODE_COUNT - 3);
    storage.close();
  });

  it('new recovery codes replace the old ones', async () => {
    const { storage, alice, mfa, audit, enrol } = await setup();
    const { codes } = enrol();
    const fresh = mfa.regenerateRecoveryCodes('alice', CLI);
    expect(fresh).toHaveLength(RECOVERY_CODE_COUNT);
    expect(fresh.filter((code) => codes.includes(code))).toEqual([]);
    expect(mfa.verify(alice.id, codes[0] ?? '')).toBeUndefined();
    expect(mfa.verify(alice.id, fresh[0] ?? '')).toBe('recovery_code');
    expect(audit.list({ limit: 1 })[0]).toMatchObject({ action: 'admin.mfa_recovery_codes' });
    mfa.reset('alice', CLI);
    expect(() => mfa.regenerateRecoveryCodes('alice', CLI)).toThrow(/not active/);
    storage.close();
  });
});

describe('storage', () => {
  it('holds the secret encrypted and the recovery codes as digests only', async () => {
    const { storage, databasePath, audit, lines, enrol } = await setup();
    const { secret, codes } = enrol();
    const rows = JSON.stringify([
      storage.db.all('SELECT * FROM admin_mfa'),
      storage.db.all('SELECT * FROM admin_mfa_recovery'),
      storage.db.all('SELECT id, kind, key_id, hex(envelope) AS envelope FROM secret_records'),
      audit.list({ limit: 100 }),
      lines,
    ]);
    const recovery = storage.db.all('SELECT code_sha256 FROM admin_mfa_recovery');
    expect(recovery).toHaveLength(RECOVERY_CODE_COUNT);
    for (const row of recovery) expect(row['code_sha256']).toMatch(/^[0-9a-f]{64}$/);
    storage.close();
    const file = (await readFile(databasePath)).toString('latin1');
    for (const value of [secret, ...codes, ...codes.map((code) => code.replace(/-/g, ''))]) {
      expect(rows).not.toContain(value);
      expect(file).not.toContain(value);
    }
  });
});

describe('reset', () => {
  it('removes the second step, its codes and its secret, and ends sessions', async () => {
    const { storage, alice, mfa, sessions, clock, now, audit, enrol } = await setup();
    const before = sessions.create(alice);
    const { secret, codes } = enrol();
    // Turning the second step on ended the session that existed without it.
    expect(sessions.authenticate(before.cookieValue)).toBeUndefined();
    const during = sessions.create(alice);
    expect(sessions.authenticate(during.cookieValue)).toBeDefined();

    expect(mfa.reset('alice', CLI)).toEqual({ wasActive: true, sessionsEnded: 1 });
    expect(sessions.authenticate(during.cookieValue)).toBeUndefined();
    expect(mfa.status(alice.id)).toEqual({ state: 'off', confirmedAt: null, recoveryCodesLeft: 0 });
    expect(storage.db.all('SELECT * FROM admin_mfa')).toEqual([]);
    expect(storage.db.all('SELECT * FROM admin_mfa_recovery')).toEqual([]);
    expect(storage.db.all('SELECT id FROM secret_records')).toEqual([]);
    clock.time += STEP_MS;
    expect(mfa.verify(alice.id, totpCode(secret, now()))).toBeUndefined();
    expect(mfa.verify(alice.id, codes[0] ?? '')).toBeUndefined();
    expect(audit.list({ limit: 1 })[0]).toMatchObject({
      action: 'admin.mfa_reset',
      details: { username: 'alice', wasActive: true, sessionsEnded: 1 },
    });
    // Resetting an account without a second step changes nothing and says so.
    expect(mfa.reset('alice', CLI)).toEqual({ wasActive: false, sessionsEnded: 0 });
    // It can be set up again, with a new key.
    expect(enrol().secret).not.toBe(secret);
    storage.close();
  });
});
