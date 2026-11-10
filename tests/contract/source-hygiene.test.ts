/**
 * No source or document contains raw control, C1 or bidirectional formatting characters
 * ("Trojan Source", CVE-2021-42574): such characters can make code or docs display
 * differently from what they contain. Write them as `\uXXXX` escapes instead.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const DIRECTORIES = ['packages', 'tests', 'scripts', 'docs', 'deploy', 'api-specs'];
const EXTENSIONS = /\.(ts|js|mjs|json|md|ya?ml|css|html)$/;
const SKIP = new Set(['node_modules', 'vendor', '.git']);
const UNSAFE = new RegExp(
  // eslint-disable-next-line no-control-regex -- detecting raw control characters is the point
  '[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]',
  'u',
);

async function* files(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (EXTENSIONS.test(entry.name)) yield path;
  }
}

describe('source hygiene', () => {
  it('has no raw control or bidirectional characters', async () => {
    const offenders: string[] = [];
    for (const dir of DIRECTORIES) {
      for await (const path of files(join(ROOT, dir))) {
        const text = await readFile(path, 'utf8');
        const match = UNSAFE.exec(text);
        if (match !== null) {
          const line = text.slice(0, match.index).split('\n').length;
          offenders.push(
            `${relative(ROOT, path)}:${String(line)} U+${(match[0].codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
