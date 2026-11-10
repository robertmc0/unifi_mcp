/**
 * Phase 1 gate and release-blocking invariants for human approval (spec §16 Phase 1,
 * §17 Security, §6.5):
 *
 * - A high-risk action requires independent CLI/UI approval and cannot be approved via MCP.
 * - Reused, expired, parameter-changed, wrong-client and policy-changed approvals all fail.
 * - The hard lock denies previously approved actions.
 * - Approval binds exact operation, target, arguments and client; resumption repeats every
 *   security check and executes at most once.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionEnvelope } from '@unifi-local-mcp/core';
import { ApprovalError, type Approver } from '@unifi-local-mcp/approvals';
import { describe, expect, it } from 'vitest';
import { tamperEnvelope, useTempDirs } from '../unit/storage/fixtures.ts';
import {
  CLIENT,
  CONSOLE,
  harness,
  RULE,
  SITE,
  type Harness,
  type HarnessOptions,
} from '../unit/core/fixtures.ts';

const tempDir = useTempDirs();
const CLI: Approver = { type: 'cli', id: 'root' };
const SECRET = 'synthetic-psk-SENTINEL-9f2';
const UPDATE = {
  operationId: 'network.firewall.update_rule',
  consoleId: CONSOLE,
  siteId: SITE,
  arguments: { ruleId: RULE, action: 'block', presharedKey: SECRET },
};

interface Setup extends Harness {
  clock: { now: Date };
  approvals: NonNullable<Harness['approvalService']>;
}

async function setup(options: Omit<HarnessOptions, 'dir' | 'clock'> = {}): Promise<Setup> {
  const clock = { now: new Date('2026-11-10T03:15:00.000Z') };
  const h = await harness({ ...options, dir: await tempDir(), clock, approvalService: {} });
  if (h.approvalService === undefined) throw new Error('approval service missing');
  h.executor.handler = () => ({ ok: true, data: { updated: true } });
  return { ...h, clock, approvals: h.approvalService };
}

async function propose(h: Setup): Promise<string> {
  const envelope = await h.dispatcher.execute(CLIENT, UPDATE);
  expect(envelope.status).toBe('approval_required');
  expect(envelope.approvalId).toMatch(/^[0-9a-f-]{36}$/);
  return envelope.approvalId ?? '';
}

function expectApprovalError(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ApprovalError);
  expect((thrown as ApprovalError).code).toBe(code);
}

function expectRefused(envelope: ExecutionEnvelope, code: string): void {
  expect(envelope.status === 'denied' || envelope.status === 'error').toBe(true);
  expect(envelope.error?.code).toBe(code);
}

function advance(h: Setup, ms: number): void {
  h.clock.now = new Date(h.clock.now.getTime() + ms);
}

describe('independent human approval', () => {
  it('holds a high-risk request without executing it and cannot be approved through MCP', async () => {
    const h = await setup();
    const id = await propose(h);
    expect(h.executor.calls).toEqual([]);
    expectRefused(await h.dispatcher.resume(CLIENT, id), 'approval_pending');
    const mcpApprover = { type: 'mcp_client', id: CLIENT.clientId } as unknown as Approver;
    expectApprovalError(() => h.approvals.approve(id, mcpApprover), 'approver_forbidden');
    expect(h.approvals.get(id)?.status).toBe('pending');
    expect(h.audit.list({ eventType: 'approval', limit: 1 })[0]).toMatchObject({
      action: 'approval.approve',
      outcome: 'denied',
      actorType: 'mcp_client',
      errorCode: 'approver_forbidden',
    });
    expect(h.executor.calls).toEqual([]);
    h.storage.close();
  });

  it('executes exactly the approved request once, for the original client', async () => {
    const h = await setup();
    const id = await propose(h);
    expect(h.approvals.approve(id, CLI, 'change window CHG-1')).toMatchObject({
      status: 'approved',
      decidedBy: 'cli:root',
      executeBy: '2026-11-10T03:17:00.000Z',
    });
    const envelope = await h.dispatcher.resume(CLIENT, id);
    expect(envelope).toMatchObject({ status: 'ok', outcome: 'succeeded', data: { updated: true } });
    expect(h.executor.calls).toHaveLength(1);
    expect(h.executor.calls[0]?.arguments).toEqual(UPDATE.arguments);
    expect(h.approvals.get(id)).toMatchObject({
      status: 'consumed',
      executionId: envelope.executionId,
    });
    expect(
      h.audit
        .list({ limit: 500 })
        .map((e) => e.action)
        .reverse(),
    ).toEqual(
      expect.arrayContaining([
        'approval.propose',
        'approval.approve',
        'operation.enqueue',
        'approval.consume',
        'operation.execute',
      ]),
    );
    h.storage.close();
  });
});

describe('approvals that must fail', () => {
  it('reused', async () => {
    const h = await setup();
    const id = await propose(h);
    h.approvals.approve(id, CLI);
    expect((await h.dispatcher.resume(CLIENT, id)).outcome).toBe('succeeded');
    expectRefused(await h.dispatcher.resume(CLIENT, id), 'approval_already_used');
    expect(h.executor.calls).toHaveLength(1);
    h.storage.close();
  });

  it('resumed twice at once', async () => {
    const h = await setup();
    const id = await propose(h);
    h.approvals.approve(id, CLI);
    const results = await Promise.all([
      h.dispatcher.resume(CLIENT, id),
      h.dispatcher.resume(CLIENT, id),
    ]);
    expect(results.map((r) => r.outcome ?? r.error?.code).sort()).toEqual([
      'approval_already_used',
      'succeeded',
    ]);
    expect(h.executor.calls).toHaveLength(1);
    h.storage.close();
  });

  it('expired before a decision', async () => {
    const h = await setup();
    const id = await propose(h);
    advance(h, 10 * 60_000);
    expectApprovalError(() => h.approvals.approve(id, CLI), 'approval_expired');
    expectRefused(await h.dispatcher.resume(CLIENT, id), 'approval_expired');
    expect(h.executor.calls).toEqual([]);
    h.storage.close();
  });

  it('expired after approval, before resumption', async () => {
    const h = await setup();
    const id = await propose(h);
    h.approvals.approve(id, CLI);
    advance(h, 2 * 60_000);
    expectRefused(await h.dispatcher.resume(CLIENT, id), 'approval_expired');
    expect(h.approvals.get(id)?.status).toBe('expired');
    expect(h.executor.calls).toEqual([]);
    h.storage.close();
  });

  it('parameter-changed: stored digest or stored arguments altered', async () => {
    const h = await setup();
    const first = await propose(h);
    h.approvals.approve(first, CLI);
    h.storage.db.run('UPDATE approval_requests SET arguments_sha256 = ? WHERE id = ?', [
      '0'.repeat(64),
      first,
    ]);
    expectRefused(await h.dispatcher.resume(CLIENT, first), 'approval_invalidated');

    const second = await propose(h);
    h.approvals.approve(second, CLI);
    const secretId = String(
      h.storage.db.get('SELECT arguments_secret_id AS s FROM approval_requests WHERE id = ?', [
        second,
      ])?.['s'],
    );
    tamperEnvelope(h.storage.db, secretId);
    expectRefused(await h.dispatcher.resume(CLIENT, second), 'approval_invalidated');
    expect(h.executor.calls).toEqual([]);
    h.storage.close();
  });

  it('wrong client', async () => {
    const h = await setup();
    const id = await propose(h);
    h.approvals.approve(id, CLI);
    const original = h.clients.get(CLIENT.clientId);
    if (original === undefined) throw new Error('missing client');
    h.clients.set('client-2', { ...original, clientId: 'client-2' });
    expectRefused(await h.dispatcher.resume({ clientId: 'client-2' }, id), 'approval_not_found');
    expect(h.executor.calls).toEqual([]);
    // The original client can still use it.
    expect((await h.dispatcher.resume(CLIENT, id)).outcome).toBe('succeeded');
    h.storage.close();
  });

  it('policy-changed after approval', async () => {
    const h = await setup();
    const id = await propose(h);
    h.approvals.approve(id, CLI);
    h.policyStore.replace(
      { runtimeMode: 'read_write', deny: ['access.*.*'] },
      { type: 'cli' },
      h.policyStore.current().version,
    );
    expectRefused(await h.dispatcher.resume(CLIENT, id), 'approval_invalidated');
    expect(h.approvals.get(id)?.status).toBe('invalidated');
    expect(h.executor.calls).toEqual([]);
    h.storage.close();
  });

  it('policy-changed before approval', async () => {
    const h = await setup();
    const id = await propose(h);
    h.policyStore.replace(
      { runtimeMode: 'read_write', deny: ['access.*.*'] },
      { type: 'cli' },
      h.policyStore.current().version,
    );
    expectApprovalError(() => h.approvals.approve(id, CLI), 'approval_invalidated');
    h.storage.close();
  });

  it('client revoked after approval', async () => {
    const h = await setup();
    const id = await propose(h);
    h.approvals.approve(id, CLI);
    const client = h.clients.get(CLIENT.clientId);
    if (client) client.status = 'revoked';
    expectRefused(await h.dispatcher.resume(CLIENT, id), 'client_inactive');
    expect(h.executor.calls).toEqual([]);
    h.storage.close();
  });
});

describe('hard read-only lock', () => {
  it('denies a previously approved action', async () => {
    const h = await setup();
    const id = await propose(h);
    h.approvals.approve(id, CLI);
    h.deployment.forceReadOnly = true;
    expectRefused(await h.dispatcher.resume(CLIENT, id), 'hard_read_only');
    expect(h.executor.calls).toEqual([]);
    expect(h.approvals.get(id)?.status).toBe('approved'); // not consumed; it simply expires
    h.storage.close();
  });
});

describe('administrator approvals', () => {
  it('require a recent sign-in', async () => {
    const h = await setup();
    const id = await propose(h);
    const stale: Approver = {
      type: 'admin',
      id: 'alice',
      authenticatedAt: new Date(h.clock.now.getTime() - 6 * 60_000),
    };
    expectApprovalError(() => h.approvals.approve(id, stale), 'reauthentication_required');
    const fresh: Approver = {
      type: 'admin',
      id: 'alice',
      authenticatedAt: new Date(h.clock.now.getTime() - 60_000),
    };
    expect(h.approvals.approve(id, fresh).decidedBy).toBe('admin:alice');
    h.storage.close();
  });
});

describe('stored arguments', () => {
  it('are encrypted, redacted for reviewers and deleted when the approval closes', async () => {
    const h = await setup();
    const id = await propose(h);
    const view = h.approvals.get(id);
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(view?.summary).toMatchObject({
      arguments: { ruleId: RULE, action: 'block', presharedKey: '[REDACTED]' },
    });
    for (const file of await readdir(join(h.storage.db.path, '..'))) {
      const content = await readFile(join(h.storage.db.path, '..', file));
      expect(content.includes(Buffer.from(SECRET)), file).toBe(false);
    }
    h.approvals.reject(id, CLI, 'not now');
    expect(h.approvals.get(id)).toMatchObject({ status: 'rejected', decisionNote: 'not now' });
    expect(h.storage.db.get('SELECT count(*) AS n FROM secret_records')?.['n']).toBe(0);
    expectRefused(await h.dispatcher.resume(CLIENT, id), 'approval_rejected');
    h.storage.close();
  });
});
