/**
 * Versioned, audited global policy store (spec §6.1, §6.5, §8.1; ADR 0009).
 */
import { join } from 'node:path';
import {
  columnInteger,
  databasePathFor,
  openStorage,
  SqliteDatabase,
  type Storage,
} from '@unifi-local-mcp/storage';
import {
  bumpPolicyVersion,
  PolicyError,
  PolicyStore,
  type PolicyActor,
  type PolicyErrorCode,
} from '@unifi-local-mcp/policy';
import { AuditLog } from '@unifi-local-mcp/telemetry';
import { describe, expect, it } from 'vitest';
import { fixedNow, testKey, useTempDirs } from '../storage/fixtures.ts';
import { memoryLogger } from '../telemetry/fixtures.ts';

const tempDir = useTempDirs();
const CLI: PolicyActor = { type: 'cli', id: 'root' };

interface Setup {
  storage: Storage;
  audit: AuditLog;
  store: PolicyStore;
  databasePath: string;
}

async function setup(): Promise<Setup> {
  const databasePath = databasePathFor(join(await tempDir(), 'data'));
  const storage = await openStorage({ databasePath, masterKey: testKey('policy') });
  const audit = new AuditLog(storage.db, { logger: memoryLogger().logger, now: fixedNow });
  return { storage, audit, store: new PolicyStore(storage.db, audit, fixedNow), databasePath };
}

function expectPolicyError(fn: () => unknown, code: PolicyErrorCode): PolicyError {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(PolicyError);
  expect((thrown as PolicyError).code).toBe(code);
  return thrown as PolicyError;
}

describe('PolicyStore', () => {
  it('initialises the default read-only policy once, audited', async () => {
    const { storage, audit, store } = await setup();
    const first = store.current();
    expect(first).toMatchObject({ version: 1, updatedBy: 'system:-' });
    expect(first.document.runtimeMode).toBe('read_only');
    expect(store.current()).toEqual(first);
    expect(audit.list().map((e) => e.action)).toEqual(['policy.initialize']);
    storage.close();
  });

  it('switches the runtime mode with a version bump and an audit entry', async () => {
    const { storage, audit, store } = await setup();
    const next = store.setRuntimeMode('read_write', CLI);
    expect(next).toMatchObject({ version: 2, updatedBy: 'cli:root' });
    expect(next.document.runtimeMode).toBe('read_write');
    expect(audit.list()[0]).toMatchObject({
      eventType: 'admin.security',
      action: 'policy.runtime_mode_change',
      actorType: 'cli',
      actorId: 'root',
      details: { from: 'read_only', to: 'read_write', fromVersion: 1, toVersion: 2 },
    });
    // Setting the same mode again changes nothing.
    expect(store.setRuntimeMode('read_write', CLI).version).toBe(2);
    expect(audit.list()).toHaveLength(2);
    storage.close();
  });

  it('replaces the policy with compare-and-set on the version', async () => {
    const { storage, audit, store } = await setup();
    const v1 = store.current();
    const next = store.replace(
      { runtimeMode: 'read_only', deny: ['access.*.write'] },
      CLI,
      v1.version,
    );
    expect(next.version).toBe(2);
    expect(next.document.deny).toEqual(['access.*.write']);
    expect(audit.list()[0]?.details).toMatchObject({
      fromVersion: 1,
      toVersion: 2,
      rules: { deny: 1 },
      documentSha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
    });
    expectPolicyError(() => store.replace({}, CLI, 1), 'POLICY_VERSION_CONFLICT');
    expectPolicyError(() => store.setRuntimeMode('read_write', CLI, 1), 'POLICY_VERSION_CONFLICT');
    expect(store.current().version).toBe(2);
    storage.close();
  });

  it('rejects invalid policies with their problems and changes nothing', async () => {
    const { storage, store } = await setup();
    const error = expectPolicyError(
      () => store.replace({ deny: ['nope'], extra: 1 }, CLI, store.current().version),
      'POLICY_INVALID',
    );
    expect(error.message).toMatch(/deny\.0/);
    expect(store.current().version).toBe(1);
    storage.close();
  });

  it('refuses changes attributed to an MCP client', async () => {
    const { storage, store } = await setup();
    const mcp = { type: 'mcp_client', id: 'agent' } as unknown as PolicyActor;
    expectPolicyError(() => store.setRuntimeMode('read_write', mcp), 'POLICY_ACTOR_FORBIDDEN');
    expectPolicyError(() => bumpPolicyVersion(storage.db, mcp), 'POLICY_ACTOR_FORBIDDEN');
    expect(store.current().document.runtimeMode).toBe('read_only');
    storage.close();
  });

  it('fails closed on a stored policy that no longer validates', async () => {
    const { storage, store } = await setup();
    store.current();
    storage.db.run(
      `UPDATE security_policy SET document = '{"runtimeMode":"read_write","deny":["bad"]}'`,
    );
    expectPolicyError(() => store.current(), 'POLICY_INVALID');
    storage.db.run(`UPDATE security_policy SET document = '{"runtimeMode": "read_write", "x": 1}'`);
    expectPolicyError(() => store.current(), 'POLICY_INVALID');
    storage.close();
  });

  it('bumps the version for console and client changes stored elsewhere', async () => {
    const { storage, store } = await setup();
    expectPolicyError(() => bumpPolicyVersion(storage.db, CLI), 'POLICY_NOT_INITIALISED');
    store.current();
    expect(bumpPolicyVersion(storage.db, { type: 'admin', id: 'alice' })).toBe(2);
    expect(store.current()).toMatchObject({ version: 2, updatedBy: 'admin:alice' });
    storage.close();
  });

  it('rolls the change back when the database cannot take it', async () => {
    const { storage, store } = await setup();
    const before = store.current();
    const pages = columnInteger(storage.db.get('PRAGMA page_count') ?? {}, 'page_count');
    storage.db.exec(`PRAGMA max_page_count = ${String(pages)}`);
    const big = {
      deny: Array.from({ length: 400 }, (_, i) => `operation:network.op_${String(i)}`),
    };
    expect(() => store.replace(big, CLI, before.version)).toThrow();
    storage.db.exec('PRAGMA max_page_count = 1073741823');
    expect(store.current()).toEqual(before);
    storage.close();
  });

  it('makes a change visible to other connections immediately (CLI and service)', async () => {
    const { storage, store, audit, databasePath } = await setup();
    store.current();
    const cliConnection = SqliteDatabase.open(databasePath);
    const cliAudit = new AuditLog(cliConnection, { logger: memoryLogger().logger });
    new PolicyStore(cliConnection, cliAudit).setRuntimeMode('read_write', CLI);
    expect(store.current().document.runtimeMode).toBe('read_write');
    expect(audit.list()[0]?.action).toBe('policy.runtime_mode_change');
    // An audit log on another connection could not be atomic with the change.
    expect(() => new PolicyStore(cliConnection, audit)).toThrow(/same database connection/);
    cliConnection.close();
    storage.close();
  });
});
