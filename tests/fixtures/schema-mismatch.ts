/**
 * Describes where a response missed its schema without repeating anything it contained.
 * Used by the opt-in live tests, whose reports are reviewed and committed.
 */
import type * as z from 'zod';

/** Path segments that are schema property names; anything else could be data. */
const SAFE_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_MISMATCHES = 20;

/**
 * Where and how a response missed its schema: `data[].state: invalid_type (expected
 * string)`. Paths and zod issue codes only. List positions and keys that are not plain
 * property names are masked, and no received value or zod message is kept. For a union,
 * the closest branch (fewest issues) is followed.
 */
export function mismatchSummary(issues: readonly z.core.$ZodIssue[], prefix = ''): string[] {
  const lines: string[] = [];
  for (const issue of issues) {
    const path = [
      prefix,
      ...issue.path.map((segment) =>
        typeof segment === 'number'
          ? '[]'
          : typeof segment === 'string' && SAFE_SEGMENT.test(segment)
            ? `.${segment}`
            : '.?',
      ),
    ]
      .join('')
      .replace(/^\./, '');
    if (issue.code === 'invalid_union' && issue.errors.length > 0) {
      const closest = [...issue.errors].sort((a, b) => a.length - b.length)[0] ?? [];
      lines.push(...mismatchSummary(closest, path));
      continue;
    }
    const expected =
      issue.code === 'invalid_type' && SAFE_SEGMENT.test(issue.expected)
        ? ` (expected ${issue.expected})`
        : '';
    lines.push(`${path === '' ? '(root)' : path}: ${issue.code}${expected}`);
  }
  return [...new Set(lines)].slice(0, MAX_MISMATCHES);
}
