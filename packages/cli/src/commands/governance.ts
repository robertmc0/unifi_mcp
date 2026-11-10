/**
 * `policy …` and `approvals …` commands (spec §13.2, §6, §6.5).
 */
import { validateGlobalPolicy } from '@unifi-local-mcp/policy';
import type { ApprovalStatus } from '@unifi-local-mcp/approvals';
import { requireString, string, type Command } from '../cli.ts';
import { CliError, oneLine } from '../io.ts';
import { formatTable, printDryRun, readDocument } from './shared.ts';

export const policyCommands: Record<string, Command> = {
  show: {
    summary: 'Show the global policy, its version and the deployment hard lock',
    usage: '',
    run: async (ctx) => {
      const services = await ctx.services();
      const snapshot = services.policyStore.current();
      const value = { ...snapshot, forceReadOnly: services.config.deployment.forceReadOnly };
      ctx.print(value, () => [
        `Policy version ${String(snapshot.version)}, updated ${snapshot.updatedAt} by ${snapshot.updatedBy}`,
        `Deployment hard lock (UNIFI_MCP_FORCE_READ_ONLY): ${services.config.deployment.forceReadOnly ? 'ON — no writes possible' : 'off'}`,
        `Runtime mode: ${snapshot.document.runtimeMode}`,
        JSON.stringify(snapshot.document, null, 2),
      ]);
      return 0;
    },
  },
  validate: {
    summary: 'Validate a global policy file without applying it',
    usage: '--file <policy.yaml>',
    options: { file: { type: 'string' } },
    run: async (ctx) => {
      const result = validateGlobalPolicy(await readDocument(requireString(ctx.values, 'file')));
      if (!result.ok) {
        ctx.io.err(`The policy is invalid:\n${result.errors}`);
        return 1;
      }
      ctx.print(result.document, () => ['The policy is valid.']);
      return 0;
    },
  },
  apply: {
    summary: 'Replace the global policy from a file (compare-and-set on the version)',
    usage: '--file <policy.yaml> (--expected-version <n> | --dry-run)',
    options: {
      file: { type: 'string' },
      'expected-version': { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    run: async (ctx) => {
      const document = await readDocument(requireString(ctx.values, 'file'));
      if (ctx.values['dry-run'] === true) {
        const validation = validateGlobalPolicy(document);
        if (!validation.ok) throw new CliError(`The policy is invalid:\n${validation.errors}`);
        const services = await ctx.services();
        const current = services.policyStore.current();
        return printDryRun(ctx, 'global policy', current.document, validation.document);
      }
      const expected = Number(requireString(ctx.values, 'expected-version'));
      if (!Number.isInteger(expected))
        throw new CliError('--expected-version must be the current policy version.', 2);
      const services = await ctx.services();
      const next = services.policyStore.replace(document, services.actor, expected);
      ctx.print(next, () => [
        `Policy replaced; version ${String(next.version)}. Pending approvals are invalidated.`,
      ]);
      return 0;
    },
  },
  'set-runtime-mode': {
    summary: 'Switch the runtime mode (read_only or read_write)',
    usage: '<read_only|read_write>',
    args: { min: 1, max: 1 },
    run: async (ctx) => {
      const mode = ctx.positionals[0];
      if (mode !== 'read_only' && mode !== 'read_write') {
        throw new CliError('The mode must be read_only or read_write.', 2);
      }
      const services = await ctx.services();
      const next = services.policyStore.setRuntimeMode(mode, services.actor);
      ctx.print(next, () => [
        `Runtime mode is ${mode} (policy version ${String(next.version)}).`,
        ...(mode === 'read_write' && services.config.deployment.forceReadOnly
          ? [
              'Note: the deployment hard lock (UNIFI_MCP_FORCE_READ_ONLY) is on, so writes stay impossible.',
            ]
          : []),
      ]);
      return 0;
    },
  },
};

const STATUSES = new Set<ApprovalStatus>([
  'pending',
  'approved',
  'rejected',
  'expired',
  'invalidated',
  'consumed',
]);

export const approvalCommands: Record<string, Command> = {
  list: {
    summary: 'List approval requests (newest first)',
    usage: '[--status pending|approved|rejected|expired|invalidated|consumed]',
    options: { status: { type: 'string' } },
    run: async (ctx) => {
      const status = string(ctx.values, 'status');
      if (status !== undefined && !STATUSES.has(status as ApprovalStatus))
        throw new CliError('Unknown --status.', 2);
      const list = (await ctx.services()).approvals.list(
        status === undefined ? {} : { status: status as ApprovalStatus },
      );
      ctx.print(list, () =>
        list.length === 0
          ? ['No approval requests.']
          : formatTable([
              ['ID', 'STATUS', 'CLIENT', 'OPERATION', 'RISK', 'EXPIRES'],
              ...list.map((a) => [
                a.id,
                a.status,
                a.clientId,
                a.operationId,
                a.risk,
                a.executeBy ?? a.expiresAt,
              ]),
            ]),
      );
      return 0;
    },
  },
  show: {
    summary: 'Show an approval request with its redacted summary',
    usage: '<approval-id>',
    args: { min: 1, max: 1 },
    run: async (ctx) => {
      const view = (await ctx.services()).approvals.get(ctx.positionals[0] ?? '');
      if (view === undefined) throw new CliError('No such approval request.');
      ctx.print(view, () => [JSON.stringify(view, null, 2)]);
      return 0;
    },
  },
  approve: {
    summary: 'Approve a pending request (interactive confirmation; never scripted)',
    usage: '<approval-id> [--note <text>]',
    options: { note: { type: 'string' } },
    args: { min: 1, max: 1 },
    run: async (ctx) => {
      if (!ctx.io.interactive) {
        throw new CliError(
          'Approving needs a human at an interactive terminal; it cannot be scripted.',
        );
      }
      const services = await ctx.services();
      const id = ctx.positionals[0] ?? '';
      const view = services.approvals.get(id);
      if (view === undefined) throw new CliError('No such approval request.');
      // Every field is escaped onto one line: the request text is chosen by the client
      // (and so by the model), and must not be able to forge or hide lines of this screen.
      for (const line of [
        `Client:     ${oneLine(view.clientId)}`,
        `Operation:  ${oneLine(view.operationId)} (risk ${oneLine(view.risk)})`,
        `Console:    ${oneLine(view.consoleId)}${view.siteId === null ? '' : `, site ${oneLine(view.siteId)}`}`,
        `Requested:  ${view.createdAt}, expires ${view.expiresAt}`,
        `Summary:    ${oneLine(JSON.stringify(view.summary))}`,
      ]) {
        ctx.io.err(line);
      }
      const expected = id.slice(0, 8);
      const answer = await ctx.io.prompt(`Type "${expected}" to approve this request: `);
      if (answer.trim() !== expected) throw new CliError('Not confirmed; nothing was approved.');
      const note = string(ctx.values, 'note');
      const approved = services.approvals.approve(
        id,
        services.actor as { type: 'cli'; id: string },
        note,
      );
      ctx.print(approved, () => [
        `Approved. The client must resume it before ${approved.executeBy ?? '-'}.`,
      ]);
      return 0;
    },
  },
  reject: {
    summary: 'Reject a pending request',
    usage: '<approval-id> [--note <text>]',
    options: { note: { type: 'string' } },
    args: { min: 1, max: 1 },
    run: async (ctx) => {
      const services = await ctx.services();
      const rejected = services.approvals.reject(
        ctx.positionals[0] ?? '',
        services.actor as { type: 'cli'; id: string },
        string(ctx.values, 'note'),
      );
      ctx.print(rejected, () => ['Rejected.']);
      return 0;
    },
  },
};
