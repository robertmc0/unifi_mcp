/**
 * Persistent, hash-chained audit trail and its fail-safe behaviour (spec §12; ADR 0008).
 */
import { join } from 'node:path';
import {
  columnInteger,
  databasePathFor,
  openStorage,
  type Storage,
} from '@unifi-local-mcp/storage';
import {
  AuditLog,
  AuditUnavailableError,
  REDACTED,
  type AuditEvent,
} from '@unifi-local-mcp/telemetry';
import { describe, expect, it } from 'vitest';
import { testKey, useTempDirs } from '../storage/fixtures.ts';
import { memoryLogger, type MemorySink } from './fixtures.ts';

const tempDir = useTempDirs();

interface Setup {
  storage: Storage;
  audit: AuditLog;
  log: MemorySink;
  clock: { now: Date };
}

async function setup(): Promise<Setup> {
  const storage = await openStorage({
    databasePath: databasePathFor(join(await tempDir(), 'data')),
    masterKey: testKey('audit'),
  });
  const log = memoryLogger();
  const clock = { now: new Date('2026-11-10T03:15:00.000Z') };
  const audit = new AuditLog(storage.db, { logger: log.logger, now: () => clock.now });
  return { storage, audit, log, clock };
}

function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    eventType: 'mcp.operation',
    action: 'operation.execute',
    outcome: 'success',
    actor: { type: 'mcp_client', id: 'client-reader' },
    correlationId: 'corr-1',
    consoleId: 'console-1',
    application: 'network',
    operationId: 'network.sites.list',
    durationMs: 12.4,
    ...overrides,
  };
}

describe('AuditLog.record', () => {
  it('stores the entry and links it into the hash chain', async () => {
    const { storage, audit } = await setup();
    const first = audit.record(event({ details: { page: 1 } }));
    const second = audit.record(event({ outcome: 'denied', errorCode: 'permission_denied' }));
    expect(first).toMatchObject({
      seq: 1,
      occurredAt: '2026-11-10T03:15:00.000Z',
      eventType: 'mcp.operation',
      actorType: 'mcp_client',
      actorId: 'client-reader',
      durationMs: 12,
      details: { page: 1 },
      prevHash: '0'.repeat(64),
    });
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.prevHash).toBe(first.entryHash);
    expect(audit.list()).toEqual([second, first]);
    expect(audit.verifyChain()).toEqual({ ok: true, entriesChecked: 2 });
    storage.close();
  });

  it('redacts and caps details and identifiers', async () => {
    const { storage, audit } = await setup();
    const entry = audit.record(
      event({
        actor: { type: 'mcp_client', id: `client-${'x'.repeat(300)}` },
        correlationId: 'Bearer abc123',
        details: { password: 'p', target: 'site-1', nested: { apiKey: 'k' } },
      }),
    );
    expect(entry.details).toEqual({
      password: REDACTED,
      target: 'site-1',
      nested: { apiKey: REDACTED },
    });
    expect(entry.actorId).toHaveLength(128);
    expect(entry.correlationId).toBe('Bearer [REDACTED]');
    const huge = audit.record(
      event({
        details: Object.fromEntries(
          Array.from({ length: 40 }, (_, i) => [`f${String(i)}`, 'y'.repeat(500)]),
        ),
      }),
    );
    expect(huge.details).toMatchObject({ _truncated: true });
    storage.close();
  });

  it('rejects malformed events as programming errors', async () => {
    const { storage, audit } = await setup();
    expect(() => audit.record(event({ eventType: 'Bad Type' }))).toThrow(TypeError);
    expect(() => audit.record(event({ outcome: 'maybe' as never }))).toThrow(TypeError);
    expect(() => audit.record(event({ actor: { type: 'robot' as never } }))).toThrow(TypeError);
    expect(() => audit.record(event({ durationMs: -1 }))).toThrow(TypeError);
    expect(audit.list()).toEqual([]);
    storage.close();
  });

  it('commits or rolls back together with the caller’s transaction', async () => {
    const { storage, audit } = await setup();
    expect(() =>
      storage.db.transaction(() => {
        audit.record(event());
        throw new Error('state change failed');
      }),
    ).toThrow('state change failed');
    expect(audit.list()).toEqual([]);
    storage.db.transaction(() => audit.record(event()));
    expect(audit.list()).toHaveLength(1);
    storage.close();
  });

  it('fails safe when the database is full and recovers afterwards', async () => {
    const { storage, audit, log } = await setup();
    audit.record(event());
    const pages = columnInteger(storage.db.get('PRAGMA page_count') ?? {}, 'page_count');
    storage.db.exec(`PRAGMA max_page_count = ${String(pages)}`);
    const big = Object.fromEntries(
      Array.from({ length: 14 }, (_, i) => [`f${String(i)}`, 'z'.repeat(500)]),
    );
    let thrown: unknown;
    try {
      for (let i = 0; i < 20; i++) audit.record(event({ details: big }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AuditUnavailableError);
    expect((thrown as AuditUnavailableError).code).toBe('AUDIT_UNAVAILABLE');
    expect(audit.healthy).toBe(false);
    expect(log.records().at(-1)).toMatchObject({
      level: 'error',
      msg: 'audit write failed; the audited operation is refused',
      storageErrorCode: 'STORAGE_FULL',
      action: 'operation.execute',
    });
    storage.db.exec('PRAGMA max_page_count = 1073741823');
    audit.record(event());
    expect(audit.healthy).toBe(true);
    expect(audit.verifyChain().ok).toBe(true);
    storage.close();
  });

  it('recovers through the readiness probe alone, without other traffic', async () => {
    const { storage, audit } = await setup();
    expect(audit.probe()).toBe(true);
    expect(audit.list()).toEqual([]); // no write while healthy
    const pages = columnInteger(storage.db.get('PRAGMA page_count') ?? {}, 'page_count');
    storage.db.exec(`PRAGMA max_page_count = ${String(pages)}`);
    // Fill the remaining space with entries of the same size as the probe's entry.
    const probeSized: AuditEvent = {
      eventType: 'system',
      action: 'audit.recovered',
      outcome: 'success',
      actor: { type: 'system' },
    };
    expect(() => {
      for (let i = 0; i < 10_000; i++) audit.record(probeSized);
    }).toThrow(AuditUnavailableError);
    expect(audit.probe()).toBe(false); // still full
    storage.db.exec('PRAGMA max_page_count = 1073741823');
    const before = audit.list({ limit: 500 }).length;
    expect(audit.probe()).toBe(true);
    expect(audit.healthy).toBe(true);
    expect(audit.list({ limit: 1 })[0]).toMatchObject({
      eventType: 'system',
      action: 'audit.recovered',
      actorType: 'system',
    });
    expect(audit.probe()).toBe(true);
    expect(audit.list({ limit: 500 })).toHaveLength(before + 1);
    storage.close();
  });
});

describe('audit immutability and tamper evidence', () => {
  it('refuses updates', async () => {
    const { storage, audit } = await setup();
    audit.record(event());
    expect(() => storage.db.run("UPDATE audit_entries SET outcome = 'denied'")).toThrow(
      /immutable/,
    );
    storage.close();
  });

  it('detects an edited entry', async () => {
    const { storage, audit } = await setup();
    for (let i = 0; i < 3; i++) audit.record(event());
    storage.db.exec('DROP TRIGGER audit_entries_immutable');
    storage.db.run("UPDATE audit_entries SET outcome = 'denied' WHERE seq = 2");
    expect(audit.verifyChain()).toEqual({ ok: false, entriesChecked: 1, firstInvalidSeq: 2 });
    storage.close();
  });

  it('detects a removed entry', async () => {
    const { storage, audit } = await setup();
    for (let i = 0; i < 3; i++) audit.record(event());
    storage.db.run('DELETE FROM audit_entries WHERE seq = 2');
    expect(audit.verifyChain()).toEqual({ ok: false, entriesChecked: 1, firstInvalidSeq: 3 });
    storage.close();
  });
});

describe('AuditLog.prune', () => {
  it('deletes old entries, audits the pruning, and keeps the chain verifiable', async () => {
    const { storage, audit, clock } = await setup();
    clock.now = new Date('2026-08-01T00:00:00.000Z');
    audit.record(event());
    audit.record(event());
    clock.now = new Date('2026-11-01T00:00:00.000Z');
    audit.record(event());
    clock.now = new Date('2026-11-10T00:00:00.000Z');
    expect(audit.prune(new Date('2026-08-12T00:00:00.000Z'))).toBe(2);
    const entries = audit.list();
    expect(entries.map((e) => e.action)).toEqual(['audit.prune', 'operation.execute']);
    expect(entries[0]).toMatchObject({
      eventType: 'system',
      actorType: 'system',
      details: { deleted: 2, olderThan: '2026-08-12T00:00:00.000Z' },
    });
    expect(audit.verifyChain()).toEqual({ ok: true, entriesChecked: 2 });
    storage.close();
  });
});

describe('AuditLog.list', () => {
  it('filters and pages newest first', async () => {
    const { storage, audit, clock } = await setup();
    for (let i = 0; i < 5; i++) {
      clock.now = new Date(Date.UTC(2026, 10, 1 + i));
      audit.record(
        event({
          outcome: i % 2 === 0 ? 'success' : 'denied',
          actor: { type: 'mcp_client', id: i < 3 ? 'client-a' : 'client-b' },
        }),
      );
    }
    expect(audit.list({ actorId: 'client-a' }).map((e) => e.seq)).toEqual([3, 2, 1]);
    expect(audit.list({ outcome: 'denied' }).map((e) => e.seq)).toEqual([4, 2]);
    expect(audit.list({ limit: 2 }).map((e) => e.seq)).toEqual([5, 4]);
    expect(audit.list({ beforeSeq: 4, limit: 2 }).map((e) => e.seq)).toEqual([3, 2]);
    expect(
      audit
        .list({ since: new Date(Date.UTC(2026, 10, 2)), until: new Date(Date.UTC(2026, 10, 4)) })
        .map((e) => e.seq),
    ).toEqual([3, 2]);
    expect(audit.list({ eventType: 'system' })).toEqual([]);
    expect(audit.list({ limit: 10_000 })).toHaveLength(5);
    storage.close();
  });
});
