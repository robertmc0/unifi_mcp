/**
 * Helpers shared by CLI commands.
 */
import { readFile, stat } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { canonicalJson } from '@unifi-local-mcp/core';
import type { RunContext } from '../cli.ts';
import type { Services } from '../context.ts';
import { CliError, oneLine, type CliIo } from '../io.ts';

/** Reads a YAML or JSON document (JSON is valid YAML). */
export async function readDocument(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new CliError(
      `Cannot read ${path} (${(error as NodeJS.ErrnoException).code ?? 'error'}).`,
    );
  }
  try {
    return parseYaml(text, { maxAliasCount: 50, prettyErrors: true }) as unknown;
  } catch (error) {
    throw new CliError(`${path} is not valid YAML or JSON: ${(error as Error).message}`);
  }
}

/** Resolves a console id or alias to its id. */
export function consoleId(services: Services, idOrAlias: string): string {
  const view = services.consoles.get(idOrAlias);
  if (view === undefined) throw new CliError(`No console "${idOrAlias}".`);
  return view.id;
}

/**
 * Reads a secret from a file (trimmed), or interactively without echo. Never from an
 * argument. Warns if the file is readable by other users.
 */
export async function readSecret(
  io: CliIo,
  file: string | undefined,
  question: string,
): Promise<string> {
  if (file !== undefined) {
    const info = await stat(file).catch(() => undefined);
    if (info === undefined || !info.isFile() || info.size > 4096) {
      throw new CliError(`${file} must be a readable file of at most 4 KiB.`);
    }
    if ((info.mode & 0o077) !== 0) io.err(`warning: ${file} is readable by other users.`);
    return (await readFile(file, 'utf8')).trim();
  }
  if (!io.interactive)
    throw new CliError('Give the secret with a file option, or run in a terminal.');
  return io.promptSecret(question);
}

/** Asks the operator to type `expected` to confirm; refuses without a terminal unless `yes`. */
export async function confirm(
  io: CliIo,
  what: string,
  expected: string,
  yes: boolean,
): Promise<void> {
  if (yes) return;
  if (!io.interactive)
    throw new CliError(`${what} needs confirmation: run in a terminal or pass --yes.`);
  const answer = await io.prompt(`${what}. Type "${expected}" to continue: `);
  if (answer.trim() !== expected) throw new CliError('Not confirmed; nothing was changed.');
}

/** Rewrites `consoles` keys given as aliases into console ids, for client policies. */
export function resolveClientConsoles(services: Services, policy: unknown): unknown {
  if (typeof policy !== 'object' || policy === null) return policy;
  const consoles = (policy as { consoles?: unknown }).consoles;
  if (typeof consoles !== 'object' || consoles === null) return policy;
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(consoles)) resolved[consoleId(services, key)] = value;
  return { ...policy, consoles: resolved };
}

export function formatTable(input: string[][]): string[] {
  const rows = input.map((row) => row.map(oneLine));
  const widths =
    rows[0]?.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? '').length))) ?? [];
  return rows.map((row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd(),
  );
}

/**
 * Reports a `--dry-run`: the document was validated exactly as the real change would be, and
 * whether storing it would change anything. Nothing is written or audited.
 */
export function printDryRun(
  ctx: RunContext,
  what: string,
  current: unknown,
  next: unknown,
): number {
  const changes = canonicalJson(current ?? null) !== canonicalJson(next);
  ctx.print({ dryRun: true, changes, document: next }, () => [
    `Dry run: the ${what} is valid and would ${changes ? '' : 'not '}change the stored one. Nothing was changed.`,
  ]);
  return 0;
}
