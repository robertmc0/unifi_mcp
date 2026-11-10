/**
 * `audit …` commands (spec §12; ADR 0008): read the audit trail and verify its hash chain.
 * Entries are already redacted when written; their details can still contain text from
 * UniFi, which the CLI prints escaped (see `terminalSafe`).
 */
import type { AuditActorType, AuditOutcome, AuditQuery } from '@unifi-local-mcp/telemetry';
import { string, type Command } from '../cli.ts';
import { CliError } from '../io.ts';
import { formatTable } from './shared.ts';

const ACTOR_TYPES = new Set<AuditActorType>(['mcp_client', 'admin', 'cli', 'system']);
const OUTCOMES = new Set<AuditOutcome>([
  'success',
  'denied',
  'failure',
  'pending',
  'outcome_unknown',
]);

function date(value: string | undefined, name: string): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new CliError(`--${name} must be an ISO 8601 date or time.`, 2);
  return parsed;
}

function integer(
  value: string | undefined,
  name: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new CliError(
      `--${name} must be a whole number from ${String(min)} to ${String(max)}.`,
      2,
    );
  }
  return parsed;
}

export const auditCommands: Record<string, Command> = {
  list: {
    summary: 'List audit entries, newest first (filters are combined)',
    usage:
      '[--limit <1-500>] [--before-seq <n>] [--since <time>] [--until <time>] [--actor-type mcp_client|admin|cli|system] [--actor <id>] [--outcome <outcome>] [--event-type <type>]',
    options: {
      limit: { type: 'string' },
      'before-seq': { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      'actor-type': { type: 'string' },
      actor: { type: 'string' },
      outcome: { type: 'string' },
      'event-type': { type: 'string' },
    },
    run: async (ctx) => {
      const actorType = string(ctx.values, 'actor-type');
      if (actorType !== undefined && !ACTOR_TYPES.has(actorType as AuditActorType)) {
        throw new CliError('Unknown --actor-type.', 2);
      }
      const outcome = string(ctx.values, 'outcome');
      if (outcome !== undefined && !OUTCOMES.has(outcome as AuditOutcome))
        throw new CliError('Unknown --outcome.', 2);
      const query: AuditQuery = {};
      const limit = integer(string(ctx.values, 'limit'), 'limit', 1, 500);
      const beforeSeq = integer(
        string(ctx.values, 'before-seq'),
        'before-seq',
        1,
        Number.MAX_SAFE_INTEGER,
      );
      const since = date(string(ctx.values, 'since'), 'since');
      const until = date(string(ctx.values, 'until'), 'until');
      const actor = string(ctx.values, 'actor');
      const eventType = string(ctx.values, 'event-type');
      if (limit !== undefined) query.limit = limit;
      if (beforeSeq !== undefined) query.beforeSeq = beforeSeq;
      if (since !== undefined) query.since = since;
      if (until !== undefined) query.until = until;
      if (actorType !== undefined) query.actorType = actorType as AuditActorType;
      if (actor !== undefined) query.actorId = actor;
      if (outcome !== undefined) query.outcome = outcome as AuditOutcome;
      if (eventType !== undefined) query.eventType = eventType;
      const entries = (await ctx.services()).audit.list(query);
      ctx.print(entries, () =>
        entries.length === 0
          ? ['No audit entries match.']
          : [
              ...formatTable([
                ['SEQ', 'TIME', 'EVENT', 'ACTION', 'OUTCOME', 'ACTOR', 'OPERATION', 'ERROR'],
                ...entries.map((e) => [
                  String(e.seq),
                  e.occurredAt,
                  e.eventType,
                  e.action,
                  e.outcome,
                  e.actorId === null ? e.actorType : `${e.actorType}:${e.actorId}`,
                  e.operationId ?? '-',
                  e.errorCode ?? '-',
                ]),
              ]),
              ...(entries.length === (limit ?? 100)
                ? ['', `More entries may exist: --before-seq ${String(entries.at(-1)?.seq ?? 0)}`]
                : []),
            ],
      );
      return 0;
    },
  },
  verify: {
    summary: 'Verify the hash chain of the audit trail',
    usage: '',
    run: async (ctx) => {
      const result = (await ctx.services()).audit.verifyChain();
      ctx.print(result, () => [
        result.ok
          ? `The audit chain is intact (${String(result.entriesChecked)} entries).`
          : `The audit chain is BROKEN at entry ${String(result.firstInvalidSeq)}: an entry was changed or an earlier one removed outside retention pruning.`,
      ]);
      return result.ok ? 0 : 1;
    },
  },
};
