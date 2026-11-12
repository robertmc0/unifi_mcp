/**
 * Spec §18: the manual's commands must match the CLI. Every `unifi-mcp <group> <command>`
 * shown in code in the Markdown docs (fenced blocks and inline code) must exist, with only
 * the options that command accepts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMANDS } from '@unifi-local-mcp/cli';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const GLOBAL_OPTIONS = ['json', 'help'];

const pages = [
  'README.md',
  ...readdirSync(join(ROOT, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/${name}`),
].map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf8') }));

/** Code in a Markdown page: fenced blocks with continuation lines joined, and inline code. */
function code(text: string): string[] {
  const blocks = [...text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((m) =>
    (m[1] ?? '').replace(/\\\n\s*/g, ' '),
  );
  const inline = [...text.replace(/^```[\s\S]*?^```/gm, '').matchAll(/`([^`\n]+)`/g)].map(
    (m) => m[1] ?? '',
  );
  return [...blocks, ...inline];
}

describe('commands in the manual', () => {
  it('are found', () => {
    const all = pages.flatMap(({ text }) => code(text)).join('\n');
    expect(all.match(/unifi-mcp [a-z]/g)?.length ?? 0).toBeGreaterThan(50);
  });

  for (const { path, text } of pages) {
    it(`${path} shows only existing unifi-mcp commands and options`, () => {
      for (const snippet of code(text)) {
        for (const [call, group = '', command = '', rest = ''] of snippet.matchAll(
          /unifi-mcp (?!unifi-mcp )([a-z][a-z-]*)(?: ([a-z][a-z-]*))?([^\n|;&]*)/g,
        )) {
          const table = COMMANDS[group];
          expect(table, `${path}: ${call}`).toBeDefined();
          // `unifi-mcp db …` names a group only.
          if (command === '' && rest.trim().startsWith('…')) continue;
          const found = table?.[command] ?? table?.[''];
          expect(found, `${path}: ${call}`).toBeDefined();
          const options = [...GLOBAL_OPTIONS, ...Object.keys(found?.options ?? {})];
          for (const [, option = ''] of rest.matchAll(/(?:^|\s)--([a-z][a-z-]*)/g)) {
            expect(options, `${path}: ${call}: --${option}`).toContain(option);
          }
        }
      }
    });
  }
});
