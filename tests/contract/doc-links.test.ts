/**
 * The manual is a deliverable (spec §18): every relative link in the Markdown docs must point
 * to an existing file, and every `#anchor` into a Markdown file to an existing heading
 * (GitHub's slug rules).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');

function markdownFiles(): string[] {
  const files = readdirSync(ROOT)
    .filter((name) => name.endsWith('.md'))
    .map((name) => join(ROOT, name));
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'vendor') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.md')) files.push(path);
    }
  };
  for (const dir of ['docs', 'api-specs', 'deploy']) {
    if (existsSync(join(ROOT, dir))) walk(join(ROOT, dir));
  }
  return files;
}

/** Text outside fenced code blocks and inline code. */
function prose(text: string): string {
  return text.replace(/^```[\s\S]*?^```/gm, '').replace(/`[^`\n]*`/g, '');
}

function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function anchors(path: string): Set<string> {
  const seen = new Map<string, number>();
  const result = new Set<string>();
  for (const match of readFileSync(path, 'utf8')
    .replace(/^```[\s\S]*?^```/gm, '')
    .matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = slug(match[1] ?? '');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    result.add(count === 0 ? base : `${base}-${String(count)}`);
  }
  return result;
}

describe('documentation links', () => {
  it('resolve to existing files and headings', () => {
    const broken: string[] = [];
    for (const file of markdownFiles()) {
      for (const match of prose(readFileSync(file, 'utf8')).matchAll(
        /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
      )) {
        const target = match[1] ?? '';
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, https:, mailto:
        const [pathPart = '', anchor] = target.split('#');
        const resolved = pathPart === '' ? file : resolve(dirname(file), pathPart);
        const where = `${relative(ROOT, file)} → ${target}`;
        if (!existsSync(resolved)) {
          broken.push(`${where} (no such file)`);
          continue;
        }
        if (
          anchor !== undefined &&
          anchor !== '' &&
          statSync(resolved).isFile() &&
          resolved.endsWith('.md')
        ) {
          if (!anchors(resolved).has(anchor)) broken.push(`${where} (no such heading)`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
