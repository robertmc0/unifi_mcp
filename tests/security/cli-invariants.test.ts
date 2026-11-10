/**
 * Release-blocking CLI invariants (spec §6.5, §7.2, §13.2, §16 Phase 1 gate):
 *
 * - Approving a high-risk request is an interactive, human action at the host: refused
 *   without a terminal, no --yes bypass, and only after typing part of the approval id.
 * - No command accepts a password, key, token or credential as a command-line argument.
 * - Text chosen by a client or by UniFi cannot rewrite what the operator sees: control,
 *   C1 and bidirectional characters are shown escaped.
 */
import { COMMANDS, type CliIo } from '@unifi-local-mcp/cli';
import { requestDigest } from '@unifi-local-mcp/core';
import { describe, expect, it } from 'vitest';
import { openServices } from '../../packages/cli/src/context.ts';
import { cliHarness } from '../unit/cli/fixtures.ts';
import { rebootGateway } from '../unit/core/fixtures.ts';
import { useTempDirs } from '../unit/storage/fixtures.ts';

const tempDir = useTempDirs();

const silentIo: CliIo = {
  out: () => undefined,
  err: () => undefined,
  interactive: false,
  prompt: () => Promise.resolve(''),
  promptSecret: () => Promise.resolve(''),
};

async function pendingApproval(env: NodeJS.ProcessEnv, siteId = 'site-1'): Promise<string> {
  const services = await openServices(env, silentIo);
  try {
    const target = { consoleId: 'console-1', siteId };
    const envelope = services.approvals.propose({
      principal: { clientId: 'agent' },
      descriptor: rebootGateway,
      arguments: {},
      target,
      argumentsSha256: requestDigest({
        operationId: rebootGateway.operationId,
        ...target,
        arguments: {},
      }),
      policyVersion: services.policyStore.current().version,
      effectiveRisk: 'high',
      correlationId: 'corr-1',
    });
    return envelope.approvalId ?? '';
  } finally {
    services.close();
  }
}

describe('CLI approval', () => {
  it('cannot be scripted and needs the typed confirmation', async () => {
    const h = await cliHarness(await tempDir());
    const id = await pendingApproval(h.env);
    const scripted = await h.run(['approvals', 'approve', id]);
    expect(scripted.code).toBe(1);
    expect(scripted.err).toContain('cannot be scripted');
    expect((await h.run(['approvals', 'approve', id, '--yes'])).code).toBe(2); // no such option
    const wrong = await h.run(['approvals', 'approve', id], {
      interactive: true,
      answers: ['yes'],
    });
    expect(wrong.err).toContain('nothing was approved');
    expect((await h.json<{ status: string }>(['approvals', 'show', id])).status).toBe('pending');
    const approved = await h.run(['approvals', 'approve', id], {
      interactive: true,
      answers: [id.slice(0, 8)],
    });
    expect(approved.code).toBe(0);
    const view = await h.json<{ status: string; decidedBy: string }>(['approvals', 'show', id]);
    expect(view.status).toBe('approved');
    expect(view.decidedBy).toMatch(/^cli:/);
  });

  it('can reject without confirmation', async () => {
    const h = await cliHarness(await tempDir());
    const id = await pendingApproval(h.env);
    expect((await h.run(['approvals', 'reject', id, '--note', 'no'])).code).toBe(0);
    expect((await h.json<{ status: string }>(['approvals', 'show', id])).status).toBe('rejected');
  });
});

describe('CLI output', () => {
  // ESC sequence clearing the line, carriage return, a forged line, the 8-bit CSI and a
  // right-to-left override.
  const HOSTILE = 'site-1\u001b[2K\r\nOperation:  harmless.read\u009b2J\u202eevil';
  // eslint-disable-next-line no-control-regex -- detecting raw control characters is the point
  const RAW = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

  it('escapes hostile request text on the approval screen', async () => {
    const h = await cliHarness(await tempDir());
    const id = await pendingApproval(h.env, HOSTILE);
    const run = await h.run(['approvals', 'approve', id], {
      interactive: true,
      answers: ['no'],
    });
    expect(run.err).not.toMatch(RAW);
    expect(run.err).toContain('\\u001b[2K\\u000d\\u000aOperation:');
    expect(run.err.split('\n').filter((line) => line.startsWith('Operation:'))).toHaveLength(1);
    expect(run.err).toContain('\\u009b2J\\u202eevil');
    const listed = await h.run(['approvals', 'show', id]);
    expect(`${listed.out}${listed.err}`).not.toMatch(RAW);
  });

  it('keeps --json output exact while escaping it', async () => {
    const h = await cliHarness(await tempDir());
    const id = await pendingApproval(h.env, HOSTILE);
    const run = await h.run(['approvals', 'show', id, '--json']);
    expect(run.out).not.toMatch(RAW);
    expect((JSON.parse(run.out) as { siteId: string }).siteId).toBe(HOSTILE);
  });
});

describe('CLI arguments', () => {
  it('never take secrets as values: only file paths or prompts', () => {
    const SENSITIVE = /password|passphrase|secret|token|key|credential/;
    const ALLOWED = new Set(['token-expires']);
    for (const [group, commands] of Object.entries(COMMANDS)) {
      for (const [name, command] of Object.entries(commands)) {
        for (const option of Object.keys(command.options ?? {})) {
          if (!SENSITIVE.test(option) || ALLOWED.has(option)) continue;
          expect(option.endsWith('-file'), `${group} ${name} --${option}`).toBe(true);
        }
      }
    }
  });
});
