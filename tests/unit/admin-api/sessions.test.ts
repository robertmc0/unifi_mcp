/**
 * Admin UI sessions (spec §7.2; ADR 0016).
 */
import { join } from 'node:path';
import { AdminSessionStore, AdminStore } from '@unifi-local-mcp/admin-api';
import { PolicyStore, type PolicyActor } from '@unifi-local-mcp/policy';
import { columnText, databasePathFor, openStorage } from '@unifi-local-mcp/storage';
import { AuditLog } from '@unifi-local-mcp/telemetry';
import { describe, expect, it } from 'vitest';
import { testKey, useTempDirs } from '../storage/fixtures.ts';
import { memoryLogger } from '../telemetry/fixtures.ts';

const tempDir = useTempDirs();
const CLI: PolicyActor = { type: 'cli', id: 'root' };
const PASSWORD = 'correct horse battery staple';

async function setup() {
  let now = new Date('2026-11-10T10:00:00Z');
  const clock = () => now;
  const storage = await openStorage({
    databasePath: databasePathFor(join(await tempDir(), 'data')),
    masterKey: testKey('sessions'),
  });
  const audit = new AuditLog(storage.db, { logger: memoryLogger().logger });
  new PolicyStore(storage.db, audit).current();
  const admins = new AdminStore({ db: storage.db, audit, now: clock });
  const alice = admins.bootstrap('alice', PASSWORD, CLI);
  const sessions = new AdminSessionStore({
    db: storage.db,
    admins,
    limits: { idleMs: 30 * 60_000, lifetimeMs: 12 * 3600_000 },
    now: clock,
  });
  return {
    storage,
    admins,
    alice,
    sessions,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe('AdminSessionStore', () => {
  it('stores only a digest and resolves only the exact cookie', async () => {
    const { storage, alice, sessions } = await setup();
    const { cookieValue, session } = sessions.create(alice);
    expect(cookieValue).toMatch(/^[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$/);
    const secret = cookieValue.split('.')[1] ?? '';
    const row = storage.db.get('SELECT * FROM admin_sessions');
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(columnText(row ?? {}, 'secret_sha256')).toMatch(/^[0-9a-f]{64}$/);
    expect(sessions.authenticate(cookieValue)?.admin.username).toBe('alice');
    expect(sessions.authenticate(`${session.id}.${'A'.repeat(43)}`)).toBeUndefined();
    expect(sessions.authenticate('garbage')).toBeUndefined();
    expect(sessions.authenticate(undefined)).toBeUndefined();
    storage.close();
  });

  it('derives a CSRF token per session', async () => {
    const { storage, alice, sessions } = await setup();
    const a = sessions.create(alice);
    const b = sessions.create(alice);
    expect(sessions.authenticate(a.cookieValue)?.csrfToken).toBe(a.session.csrfToken);
    expect(a.session.csrfToken).not.toBe(b.session.csrfToken);
    storage.close();
  });

  it('ends after the idle period, but use keeps it alive until the absolute lifetime', async () => {
    const { storage, alice, sessions, advance } = await setup();
    const idle = sessions.create(alice).cookieValue;
    const used = sessions.create(alice).cookieValue;
    for (let minutes = 20; minutes < 12 * 60; minutes += 20) {
      advance(20 * 60_000);
      expect(sessions.authenticate(used)).toBeDefined();
    }
    expect(sessions.authenticate(idle)).toBeUndefined(); // unused for more than 30 minutes
    advance(20 * 60_000); // 12 hours after sign-in
    expect(sessions.authenticate(used)).toBeUndefined();
    storage.close();
  });

  it('ends at sign-out, password reset and when the account is disabled', async () => {
    const { storage, admins, alice, sessions } = await setup();
    const a = sessions.create(alice);
    sessions.revoke(a.session.id);
    expect(sessions.authenticate(a.cookieValue)).toBeUndefined();
    const b = sessions.create(alice);
    admins.resetPassword('alice', 'another long passphrase', CLI);
    expect(sessions.authenticate(b.cookieValue)).toBeUndefined();
    const c = sessions.create(alice);
    storage.db.run("UPDATE admins SET status = 'disabled'");
    expect(sessions.authenticate(c.cookieValue)).toBeUndefined();
    storage.close();
  });

  it('renews the authentication time, and prunes old sessions', async () => {
    const { storage, alice, sessions, advance } = await setup();
    const { cookieValue, session } = sessions.create(alice);
    advance(10 * 60_000);
    const renewed = sessions.reauthenticated(session.id);
    expect(sessions.authenticate(cookieValue)?.authenticatedAt).toEqual(renewed);
    sessions.revoke(session.id);
    advance(25 * 3600_000);
    expect(sessions.prune()).toBe(1);
    storage.close();
  });
});
