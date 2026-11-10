/**
 * `admin …` and `client …` commands (spec §13.2, §7.1, §7.2).
 */
import { ClientPolicySchema } from '@unifi-local-mcp/policy';
import { requireString, string, strings, type Command, type RunContext } from '../cli.ts';
import { CliError } from '../io.ts';
import {
  consoleId,
  formatTable,
  readDocument,
  resolveClientConsoles,
  printDryRun,
} from './shared.ts';

async function newPassword(ctx: RunContext): Promise<string> {
  if (!ctx.io.interactive) {
    throw new CliError('Passwords are only accepted interactively, from a terminal.');
  }
  const first = await ctx.io.promptSecret('New password: ');
  const second = await ctx.io.promptSecret('Repeat the password: ');
  if (first !== second) throw new CliError('The passwords do not match.');
  return first;
}

export const adminCommands: Record<string, Command> = {
  bootstrap: {
    summary: 'Create the first administrator (interactive; refused if one exists)',
    usage: '--username <name>',
    options: { username: { type: 'string' } },
    run: async (ctx) => {
      const username = requireString(ctx.values, 'username');
      const services = await ctx.services();
      if (services.admins.count() > 0) {
        throw new CliError(
          'An administrator already exists; use "admin reset-password" to recover access.',
        );
      }
      const admin = services.admins.bootstrap(username, await newPassword(ctx), services.actor);
      ctx.print(admin, () => [`Administrator "${admin.username}" created.`]);
      return 0;
    },
  },
  'reset-password': {
    summary: 'Set a new password for an administrator (interactive, host recovery)',
    usage: '--username <name>',
    options: { username: { type: 'string' } },
    run: async (ctx) => {
      const services = await ctx.services();
      const admin = services.admins.resetPassword(
        requireString(ctx.values, 'username'),
        await newPassword(ctx),
        services.actor,
      );
      ctx.print(admin, () => [`Password of "${admin.username}" changed; the account is active.`]);
      return 0;
    },
  },
  list: {
    summary: 'List administrators',
    usage: '',
    run: async (ctx) => {
      const admins = (await ctx.services()).admins.list();
      ctx.print(admins, () =>
        admins.length === 0
          ? ['No administrators. Create one with "unifi-mcp admin bootstrap".']
          : formatTable([
              ['USERNAME', 'STATUS', 'CREATED', 'LAST SIGN-IN'],
              ...admins.map((a) => [a.username, a.status, a.createdAt, a.lastLoginAt ?? '-']),
            ]),
      );
      return 0;
    },
  },
};

const POLICY_OPTIONS = {
  description: { type: 'string' },
  console: { type: 'string', multiple: true },
  allow: { type: 'string', multiple: true },
  deny: { type: 'string', multiple: true },
  sensitive: { type: 'string', multiple: true },
  'token-expires': { type: 'string' },
} as const;

function tokenExpiry(ctx: RunContext): Date | undefined {
  const raw = string(ctx.values, 'token-expires');
  if (raw === undefined) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime()))
    throw new CliError('--token-expires must be an ISO date or date-time.', 2);
  return date;
}

function printToken(ctx: RunContext, clientId: string, token: string): void {
  ctx.print({ clientId, token }, () => [
    `Client "${clientId}" token (shown once; store it in the client's secret store):`,
    '',
    `  ${token}`,
    '',
  ]);
}

export const clientCommands: Record<string, Command> = {
  create: {
    summary: 'Create an MCP client and print its token once',
    usage:
      '<client-id> [--console <alias|id>[=site,site]]… [--allow <selector>]… [--deny <selector>]… [--sensitive <tag>]… [--description <text>] [--token-expires <date>]',
    options: POLICY_OPTIONS,
    args: { min: 1, max: 1 },
    run: async (ctx) => {
      const services = await ctx.services();
      const description = string(ctx.values, 'description');
      const expires = tokenExpiry(ctx);
      const consoles: Record<string, { sites: '*' | string[] }> = {};
      for (const entry of strings(ctx.values, 'console')) {
        const [ref = '', sites] = entry.split('=', 2);
        consoles[consoleId(services, ref)] = {
          sites: sites === undefined || sites === '*' ? '*' : sites.split(',').map((s) => s.trim()),
        };
      }
      const issued = services.clients.create(
        {
          clientId: ctx.positionals[0] ?? '',
          ...(description === undefined ? {} : { description }),
          policy: {
            consoles,
            allow: strings(ctx.values, 'allow'),
            deny: strings(ctx.values, 'deny'),
            sensitive: strings(ctx.values, 'sensitive'),
          },
          ...(expires === undefined ? {} : { tokenExpiresAt: expires }),
        },
        services.actor,
      );
      printToken(ctx, issued.client.clientId, issued.token);
      return 0;
    },
  },
  list: {
    summary: 'List MCP clients',
    usage: '',
    run: async (ctx) => {
      const clients = (await ctx.services()).clients.list();
      ctx.print(clients, () =>
        formatTable([
          ['CLIENT', 'STATUS', 'CONSOLES', 'GRANTS', 'LAST USED'],
          ...clients.map((c) => [
            c.clientId,
            c.policy?.status ?? 'invalid',
            String(Object.keys(c.policy?.consoles ?? {}).length),
            String(c.policy?.allow.length ?? 0),
            c.lastUsedAt ?? '-',
          ]),
        ]),
      );
      return 0;
    },
  },
  show: {
    summary: 'Show one client with its policy and tokens (never the token values)',
    usage: '<client-id>',
    args: { min: 1, max: 1 },
    run: async (ctx) => {
      const client = (await ctx.services()).clients.get(ctx.positionals[0] ?? '');
      if (client === undefined) throw new CliError(`No client "${ctx.positionals[0] ?? ''}".`);
      ctx.print(client, () => [JSON.stringify(client, null, 2)]);
      return 0;
    },
  },
  rotate: {
    summary: 'Issue a new token and revoke the old ones',
    usage: '<client-id> [--token-expires <date>]',
    options: { 'token-expires': { type: 'string' } },
    args: { min: 1, max: 1 },
    run: async (ctx) => {
      const services = await ctx.services();
      const issued = services.clients.rotate(
        ctx.positionals[0] ?? '',
        services.actor,
        tokenExpiry(ctx),
      );
      printToken(ctx, issued.client.clientId, issued.token);
      return 0;
    },
  },
  revoke: {
    summary: 'Revoke a client and all its tokens',
    usage: '<client-id>',
    args: { min: 1, max: 1 },
    run: async (ctx) => {
      const services = await ctx.services();
      const client = services.clients.revoke(ctx.positionals[0] ?? '', services.actor);
      ctx.print(client, () => [`Client "${client.clientId}" revoked. Restart is not needed.`]);
      return 0;
    },
  },
  'set-policy': {
    summary: 'Replace a client policy from a YAML or JSON file',
    usage: '<client-id> --file <policy.yaml> [--dry-run]',
    options: { file: { type: 'string' }, 'dry-run': { type: 'boolean' } },
    args: { min: 1, max: 1 },
    run: async (ctx) => {
      const services = await ctx.services();
      const id = ctx.positionals[0] ?? '';
      const document = resolveClientConsoles(
        services,
        await readDocument(requireString(ctx.values, 'file')),
      );
      if (ctx.values['dry-run'] === true) {
        const existing = services.clients.get(id);
        if (existing === undefined) throw new CliError(`No client "${id}".`);
        return printDryRun(
          ctx,
          'client policy',
          existing.policy,
          services.clients.validatePolicy(id, document),
        );
      }
      const client = services.clients.setPolicy(id, document, services.actor);
      ctx.print(client, () => [`Policy of "${client.clientId}" replaced.`]);
      return 0;
    },
  },
  'show-schema': {
    summary: 'Show the defaults of a client policy',
    usage: '',
    run: (ctx) => {
      const example = ClientPolicySchema.parse({ clientId: 'example' });
      ctx.print(example, () => [JSON.stringify(example, null, 2)]);
      return 0;
    },
  },
};
