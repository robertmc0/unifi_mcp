/**
 * Approval service details: windows, expiry sweeps, views and client status (ADR 0011).
 */
import { ApprovalService, type Approver } from '@unifi-local-mcp/approvals';
import { describe, expect, it } from 'vitest';
import { useTempDirs } from '../storage/fixtures.ts';
import { CLIENT, CONSOLE, harness, RULE, SITE } from '../core/fixtures.ts';

const tempDir = useTempDirs();
const CLI: Approver = { type: 'cli', id: 'root' };
const UPDATE = {
  operationId: 'network.firewall.update_rule',
  consoleId: CONSOLE,
  siteId: SITE,
  arguments: { ruleId: RULE, action: 'allow' },
};

async function setup(ttl?: { pendingMs?: number; executeMs?: number }) {
  const clock = { now: new Date('2026-11-10T03:15:00.000Z') };
  const h = await harness({
    dir: await tempDir(),
    clock,
    approvalService: ttl === undefined ? {} : { ttl },
  });
  if (h.approvalService === undefined) throw new Error('missing');
  return { ...h, clock, approvals: h.approvalService };
}

describe('ApprovalService', () => {
  it('only allows shorter windows than the defaults', async () => {
    const h = await setup();
    const base = {
      db: h.storage.db,
      audit: h.audit,
      secrets: h.storage.secrets,
      policyStore: h.policyStore,
    };
    expect(() => new ApprovalService({ ...base, ttl: { pendingMs: 11 * 60_000 } })).toThrow(
      /shortened/,
    );
    expect(() => new ApprovalService({ ...base, ttl: { executeMs: 3 * 60_000 } })).toThrow(
      /shortened/,
    );
    expect(() => new ApprovalService({ ...base, ttl: { executeMs: 1_000 } })).toThrow(/shortened/);
    expect(
      () => new ApprovalService({ ...base, ttl: { pendingMs: 60_000, executeMs: 30_000 } }),
    ).not.toThrow();
    h.storage.close();
  });

  it('applies configured windows and expires stale requests in a sweep', async () => {
    const h = await setup({ pendingMs: 60_000, executeMs: 30_000 });
    const a = (await h.dispatcher.execute(CLIENT, UPDATE)).approvalId ?? '';
    const b = (await h.dispatcher.execute(CLIENT, UPDATE)).approvalId ?? '';
    expect(h.approvals.get(a)?.expiresAt).toBe('2026-11-10T03:16:00.000Z');
    h.approvals.approve(b, CLI);
    expect(h.approvals.get(b)?.executeBy).toBe('2026-11-10T03:15:30.000Z');
    h.clock.now = new Date('2026-11-10T03:16:00.000Z');
    expect(h.approvals.expireStale()).toBe(2);
    expect(
      h.approvals
        .list({ status: 'expired' })
        .map((v) => v.id)
        .sort(),
    ).toEqual([a, b].sort());
    expect(h.storage.db.get('SELECT count(*) AS n FROM secret_records')?.['n']).toBe(0);
    expect(
      h.audit
        .list({ eventType: 'approval', limit: 10 })
        .filter((e) => e.action === 'approval.expire'),
    ).toHaveLength(2);
    h.storage.close();
  });

  it('shows a client only its own approvals, without reviewer details', async () => {
    const h = await setup();
    const id = (await h.dispatcher.execute(CLIENT, UPDATE)).approvalId ?? '';
    expect(h.approvals.statusFor(CLIENT, id)).toEqual({
      approvalId: id,
      status: 'pending',
      expiresAt: '2026-11-10T03:25:00.000Z',
      executeBy: null,
    });
    expect(h.approvals.statusFor({ clientId: 'client-2' }, id)).toBeUndefined();
    expect(h.approvals.statusFor(CLIENT, 'nope')).toBeUndefined();
    h.storage.close();
  });

  it('refuses decisions on requests that are not pending', async () => {
    const h = await setup();
    const id = (await h.dispatcher.execute(CLIENT, UPDATE)).approvalId ?? '';
    h.approvals.reject(id, CLI);
    expect(() => h.approvals.approve(id, CLI)).toThrow(/rejected/);
    expect(() => h.approvals.approve('00000000-0000-4000-8000-000000000000', CLI)).toThrow(
      /No approval/,
    );
    expect(() => h.approvals.approve(id, { type: 'cli', id: ' ' })).toThrow(/identified/);
    h.storage.close();
  });

  it('consumes an approval exactly once, even if called directly twice', async () => {
    const h = await setup();
    const id = (await h.dispatcher.execute(CLIENT, UPDATE)).approvalId ?? '';
    const execution = h.executions.create({
      clientId: CLIENT.clientId,
      operationId: UPDATE.operationId,
      consoleId: CONSOLE,
      siteId: SITE,
      argumentsSha256: 'b'.repeat(64),
      idempotencyKey: undefined,
      policyVersion: 2,
      correlationId: 'corr',
    });
    expect(h.approvals.consume(id, execution.id)).toBe(false); // still pending
    h.approvals.approve(id, CLI);
    expect(h.approvals.consume(id, execution.id)).toBe(true);
    expect(h.approvals.consume(id, execution.id)).toBe(false);
    expect(h.approvals.get(id)).toMatchObject({ status: 'consumed', executionId: execution.id });
    h.storage.close();
  });

  it('can require a second factor for administrators', async () => {
    const h = await setup();
    const strict = new ApprovalService({
      db: h.storage.db,
      audit: h.audit,
      secrets: h.storage.secrets,
      policyStore: h.policyStore,
      now: () => h.clock.now,
      requireAdminMfa: true,
    });
    const id = (await h.dispatcher.execute(CLIENT, UPDATE)).approvalId ?? '';
    const admin = { type: 'admin', id: 'alice', authenticatedAt: h.clock.now } as const;
    expect(() => strict.approve(id, admin)).toThrow(/second factor/);
    expect(strict.approve(id, { ...admin, mfaVerified: true }).status).toBe('approved');
    // The CLI is host-level authority and needs no second factor.
    h.storage.close();
  });
});
