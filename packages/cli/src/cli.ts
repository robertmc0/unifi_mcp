/**
 * The `unifi-mcp` command framework (spec §13.2; ADR 0015): `unifi-mcp <group> <command>
 * [arguments] [--options]`. Global options: `--json` (machine-readable output), `--help`.
 * Exit codes: 0 success, 1 failure, 2 usage error.
 */
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { AdminError } from '@unifi-local-mcp/admin-api';
import { ApprovalError } from '@unifi-local-mcp/approvals';
import { ClientError, ConfigError } from '@unifi-local-mcp/mcp-server';
import { PolicyError } from '@unifi-local-mcp/policy';
import { StorageError } from '@unifi-local-mcp/storage';
import { ConsoleError } from '@unifi-local-mcp/unifi-api';
import { openServices, type Services } from './context.ts';
import { CliError, safeIo, type CliIo } from './io.ts';

export type OptionValues = Record<string, string | boolean | string[] | undefined>;

export interface RunContext {
  io: CliIo;
  env: NodeJS.ProcessEnv;
  values: OptionValues;
  positionals: string[];
  json: boolean;
  /** Opens the stores (once); closed automatically after the command. */
  services(): Promise<Services>;
  /** Prints a value as JSON (with --json) or as text lines. */
  print(value: unknown, text: () => string[]): void;
}

export interface Command {
  summary: string;
  usage: string;
  options?: ParseArgsOptionsConfig;
  args?: { min: number; max: number };
  run(ctx: RunContext): Promise<number | undefined> | number | undefined;
}

export type CommandTable = Record<string, Record<string, Command>>;

const KNOWN_ERRORS = [
  CliError,
  StorageError,
  PolicyError,
  ConsoleError,
  ClientError,
  ApprovalError,
  AdminError,
  ConfigError,
];

function helpText(table: CommandTable): string[] {
  const lines = ['Usage: unifi-mcp <group> <command> [arguments] [--json]', ''];
  for (const [group, commands] of Object.entries(table)) {
    for (const [name, command] of Object.entries(commands)) {
      lines.push(`  ${(name === '' ? group : `${group} ${name}`).padEnd(28)} ${command.summary}`);
    }
  }
  lines.push(
    '',
    'Run "unifi-mcp <group> <command> --help" for its options. Docs: docs/administration.md',
  );
  return lines;
}

export function string(values: OptionValues, name: string): string | undefined {
  const value = values[name];
  return typeof value === 'string' ? value : undefined;
}

export function strings(values: OptionValues, name: string): string[] {
  const value = values[name];
  return Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
}

export function requireString(values: OptionValues, name: string): string {
  const value = string(values, name);
  if (value === undefined || value.trim() === '') throw new CliError(`--${name} is required.`, 2);
  return value;
}

export async function runCli(
  table: CommandTable,
  argv: string[],
  rawIo: CliIo,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  // All output, including error messages that quote input, is made terminal-safe here once.
  const io = safeIo(rawIo);
  const [group, name, ...rest] = argv;
  if (group === undefined || group === '--help' || group === 'help') {
    for (const line of helpText(table)) io.out(line);
    return group === undefined ? 2 : 0;
  }
  // A group may have a default command (key ""), as in `unifi-mcp doctor`.
  const named = name === undefined ? undefined : table[group]?.[name];
  const fallback =
    named === undefined && (name === undefined || name.startsWith('-'))
      ? table[group]?.['']
      : undefined;
  const command = named ?? fallback;
  if (fallback !== undefined && name !== undefined) rest.unshift(name);
  const label = fallback === undefined ? `${group} ${name ?? ''}` : group;
  if (command === undefined) {
    io.err(`Unknown command "${[group, name].filter(Boolean).join(' ')}".`);
    for (const line of helpText(table)) io.err(line);
    return 2;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: { json: { type: 'boolean' }, help: { type: 'boolean' }, ...command.options },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    io.err(`${(error as Error).message}\nUsage: unifi-mcp ${label} ${command.usage}`);
    return 2;
  }
  if (parsed.values.help === true) {
    io.out(`Usage: unifi-mcp ${label} ${command.usage}`);
    io.out(command.summary);
    return 0;
  }
  const args = command.args ?? { min: 0, max: 0 };
  if (parsed.positionals.length < args.min || parsed.positionals.length > args.max) {
    io.err(`Usage: unifi-mcp ${label} ${command.usage}`);
    return 2;
  }
  const json = parsed.values.json === true;
  let services: Services | undefined;
  const ctx: RunContext = {
    io,
    env,
    values: parsed.values,
    positionals: parsed.positionals,
    json,
    services: async () => (services ??= await openServices(env, io)),
    print: (value, text) => {
      if (json) io.out(JSON.stringify(value, null, 2));
      else for (const line of text()) io.out(line);
    },
  };
  try {
    return (await command.run(ctx)) ?? 0;
  } catch (error) {
    if (KNOWN_ERRORS.some((type) => error instanceof type)) {
      const code = (error as { code?: unknown }).code;
      io.err(`error: ${(error as Error).message}${typeof code === 'string' ? ` (${code})` : ''}`);
      return error instanceof CliError ? error.exitCode : 1;
    }
    io.err(`error: unexpected failure: ${(error as Error).message}`);
    return 1;
  } finally {
    services?.close();
  }
}
