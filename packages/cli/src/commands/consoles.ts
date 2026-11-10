/**
 * `console …` commands (spec §13.2, §4.2).
 */
import { readFile } from 'node:fs/promises';
import {
  checkConsoleConnection,
  isModuleId,
  type ModuleId,
  type TlsTrustInput,
} from '@unifi-local-mcp/unifi-api';
import { requireString, string, strings, type Command, type RunContext } from '../cli.ts';
import { CliError, oneLine } from '../io.ts';
import {
  confirm,
  consoleId,
  formatTable,
  readDocument,
  readSecret,
  printDryRun,
} from './shared.ts';

const TLS_OPTIONS = {
  tls: { type: 'string' },
  'ca-file': { type: 'string' },
  pin: { type: 'string', multiple: true },
} as const;

async function tlsInput(ctx: RunContext): Promise<TlsTrustInput> {
  const mode = string(ctx.values, 'tls') ?? 'verify';
  switch (mode) {
    case 'verify': {
      const caFile = string(ctx.values, 'ca-file');
      return caFile === undefined ? { mode } : { mode, caPem: await readFile(caFile, 'utf8') };
    }
    case 'pinned':
      return { mode, pins: strings(ctx.values, 'pin') };
    case 'insecure':
      ctx.io.err(
        'warning: TLS verification will be DISABLED for this console. Prefer --tls pinned.',
      );
      return { mode };
    default:
      throw new CliError('--tls must be verify, pinned or insecure.', 2);
  }
}

/** A certificate distinguished name on one line; the server chooses its content. */
function dn(name: string): string {
  return name.split('\n').map(oneLine).join(', ');
}

function moduleOption(ctx: RunContext): ModuleId {
  const value = string(ctx.values, 'module') ?? 'network';
  if (!isModuleId(value)) throw new CliError('--module must be network, protect or access.', 2);
  return value;
}

export const consoleCommands: Record<string, Command> = {
  add: {
    summary: 'Add a console (no modules enabled until you enable them)',
    usage:
      '--alias <name> --host <name-or-ip> [--tls verify|pinned|insecure] [--ca-file <pem>] [--pin sha256/…]… [--description <text>]',
    options: {
      alias: { type: 'string' },
      host: { type: 'string' },
      description: { type: 'string' },
      ...TLS_OPTIONS,
    },
    run: async (ctx) => {
      const services = await ctx.services();
      const description = string(ctx.values, 'description');
      const view = services.consoles.add(
        {
          alias: requireString(ctx.values, 'alias'),
          host: requireString(ctx.values, 'host'),
          tls: await tlsInput(ctx),
          ...(description === undefined ? {} : { description }),
        },
        services.actor,
      );
      ctx.print(view, () => [
        `Console "${view.alias}" added with id ${view.id}.`,
        `Next: unifi-mcp console set-credential ${view.alias} --module network, then console enable-module.`,
      ]);
      return 0;
    },
  },
  list: {
    summary: 'List consoles',
    usage: '',
    run: async (ctx) => {
      const consoles = (await ctx.services()).consoles.list();
      ctx.print(consoles, () =>
        formatTable([
          ['ALIAS', 'ID', 'HOST', 'TLS', 'STATE', 'MODULES'],
          ...consoles.map((c) => [
            c.alias,
            c.id,
            c.host,
            c.tls.mode,
            c.policy?.state ?? 'invalid',
            Object.entries(c.policy?.modules ?? {})
              .map(([id, m]) => `${id}:${m.state}`)
              .join(',') || '-',
          ]),
        ]),
      );
      return 0;
    },
  },
  show: {
    summary: 'Show one console (credentials are never shown)',
    usage: '<alias|id>',
    args: { min: 1, max: 1 },
    run: async (ctx) => {
      const view = (await ctx.services()).consoles.get(ctx.positionals[0] ?? '');
      if (view === undefined) throw new CliError(`No console "${ctx.positionals[0] ?? ''}".`);
      ctx.print(view, () => [JSON.stringify(view, null, 2)]);
      return 0;
    },
  },
  'set-credential': {
    summary: 'Store a module API key or token (from a file or typed without echo)',
    usage: '<alias|id> [--module network|protect|access] [--key-file <path>]',
    options: { module: { type: 'string' }, 'key-file': { type: 'string' } },
    args: { min: 1, max: 1 },
    run: async (ctx) => {
      const services = await ctx.services();
      const id = consoleId(services, ctx.positionals[0] ?? '');
      const moduleId = moduleOption(ctx);
      const secret = await readSecret(
        ctx.io,
        string(ctx.values, 'key-file'),
        `${moduleId} API key: `,
      );
      services.consoles.setCredential(id, moduleId, secret, services.actor);
      ctx.print({ consoleId: id, moduleId, stored: true }, () => [
        `Credential for ${moduleId} stored (encrypted).`,
      ]);
      return 0;
    },
  },
  'enable-module': {
    summary: 'Enable a module on a console (read_only by default)',
    usage:
      '<alias|id> [--module network|protect|access] [--mode read_only|read_write|disabled] [--port <n>]',
    options: { module: { type: 'string' }, mode: { type: 'string' }, port: { type: 'string' } },
    args: { min: 1, max: 1 },
    run: async (ctx) => {
      const services = await ctx.services();
      const id = consoleId(services, ctx.positionals[0] ?? '');
      const moduleId = moduleOption(ctx);
      const mode = string(ctx.values, 'mode') ?? 'read_only';
      const current = services.consoles.policy(id);
      if (current === undefined)
        throw new CliError(
          'The stored console policy is invalid; replace it with console set-policy.',
        );
      const view = services.consoles.setPolicy(
        id,
        {
          ...current,
          modules: {
            ...current.modules,
            [moduleId]: { ...current.modules[moduleId], state: mode },
          },
        },
        services.actor,
      );
      const port = string(ctx.values, 'port');
      if (port !== undefined)
        services.consoles.setModulePort(
          id,
          moduleId,
          port === 'default' ? null : Number(port),
          services.actor,
        );
      ctx.print(view, () => [`Module ${moduleId} on "${view.alias}" is now ${mode}.`]);
      return 0;
    },
  },
  'set-policy': {
    summary: 'Replace a console policy from a YAML or JSON file',
    usage: '<alias|id> --file <policy.yaml> [--dry-run]',
    options: { file: { type: 'string' }, 'dry-run': { type: 'boolean' } },
    args: { min: 1, max: 1 },
    run: async (ctx) => {
      const services = await ctx.services();
      const id = consoleId(services, ctx.positionals[0] ?? '');
      const document = await readDocument(requireString(ctx.values, 'file'));
      if (ctx.values['dry-run'] === true) {
        const next = services.consoles.validatePolicy(id, document);
        return printDryRun(ctx, 'console policy', services.consoles.policy(id), next);
      }
      const view = services.consoles.setPolicy(id, document, services.actor);
      ctx.print(view, () => [`Policy of "${view.alias}" replaced.`]);
      return 0;
    },
  },
  'set-tls': {
    summary: 'Change how the console certificate is verified',
    usage: '<alias|id> --tls verify|pinned|insecure [--ca-file <pem>] [--pin sha256/…]…',
    options: TLS_OPTIONS,
    args: { min: 1, max: 1 },
    run: async (ctx) => {
      const services = await ctx.services();
      const view = services.consoles.setTls(
        consoleId(services, ctx.positionals[0] ?? ''),
        await tlsInput(ctx),
        services.actor,
      );
      ctx.print(view, () => [`TLS trust of "${view.alias}" is now ${view.tls.mode}.`]);
      return 0;
    },
  },
  disable: {
    summary: 'Disable a console (nothing can use it until enabled)',
    usage: '<alias|id>',
    args: { min: 1, max: 1 },
    run: (ctx) => setState(ctx, 'disabled'),
  },
  enable: {
    summary: 'Enable a disabled console',
    usage: '<alias|id>',
    args: { min: 1, max: 1 },
    run: (ctx) => setState(ctx, 'enabled'),
  },
  check: {
    summary: 'Check reachability and TLS trust (sends no request and no credential)',
    usage: '<alias|id> [--module network|protect|access]',
    options: { module: { type: 'string' } },
    args: { min: 1, max: 1 },
    run: async (ctx) => {
      const services = await ctx.services();
      const id = consoleId(services, ctx.positionals[0] ?? '');
      const result = await checkConsoleConnection(
        services.consoles,
        services.egress,
        id,
        moduleOption(ctx),
      );
      if (result === undefined) throw new CliError('The console or module is not configured.');
      ctx.print(result, () => [
        `Console ${result.host}:${String(result.port)} (${result.moduleId})`,
        `  address:      ${result.address ?? '-'}`,
        `  reachable:    ${result.reachable ? 'yes' : 'no'}`,
        `  TLS mode:     ${result.tlsMode}${result.tlsMode === 'insecure' ? ' (verification disabled)' : ''}`,
        `  verified:     ${result.verified ? 'yes' : 'no'}`,
        `  credential:   ${result.hasCredential ? 'stored' : 'missing'}`,
        ...(result.certificate === undefined
          ? []
          : [
              `  certificate:  ${dn(result.certificate.subject)} (issuer ${dn(result.certificate.issuer)}, valid to ${result.certificate.validTo})`,
              `  pin:          ${result.certificate.pin}`,
            ]),
        ...(result.problem === undefined ? [] : [`  problem:      ${result.problem}`]),
      ]);
      return result.reachable && (result.verified || result.tlsMode === 'insecure') ? 0 : 1;
    },
  },
  remove: {
    summary: 'Remove a console and its stored credentials',
    usage: '<alias|id> [--yes]',
    options: { yes: { type: 'boolean' } },
    args: { min: 1, max: 1 },
    run: async (ctx) => {
      const services = await ctx.services();
      const view = services.consoles.get(ctx.positionals[0] ?? '');
      if (view === undefined) throw new CliError(`No console "${ctx.positionals[0] ?? ''}".`);
      await confirm(
        ctx.io,
        `Remove console "${view.alias}" and its credentials`,
        view.alias,
        ctx.values['yes'] === true,
      );
      services.consoles.remove(view.id, services.actor);
      ctx.print({ removed: view.id }, () => [`Console "${view.alias}" removed.`]);
      return 0;
    },
  },
};

async function setState(ctx: RunContext, state: 'enabled' | 'disabled'): Promise<number> {
  const services = await ctx.services();
  const id = consoleId(services, ctx.positionals[0] ?? '');
  const current = services.consoles.policy(id);
  if (current === undefined)
    throw new CliError('The stored console policy is invalid; replace it with console set-policy.');
  const view = services.consoles.setPolicy(id, { ...current, state }, services.actor);
  ctx.print(view, () => [`Console "${view.alias}" is now ${state}.`]);
  return 0;
}
