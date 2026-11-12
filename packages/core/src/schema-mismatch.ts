/**
 * Describes where a response missed its schema without repeating anything it contained.
 * Used for the dispatcher's log of a contract mismatch and by the opt-in live tests, whose
 * reports are reviewed and committed.
 */
import type * as z from 'zod';

/** The JavaScript type names zod reports as "received"; only these are kept. */
const TYPE_NAMES = new Set([
  'undefined',
  'null',
  'string',
  'number',
  'boolean',
  'object',
  'array',
  'bigint',
  'nan',
]);

/** `undefined` from "Invalid input: expected string, received undefined"; never a value. */
function receivedType(message: string): string | undefined {
  const name = /received (\w+)$/.exec(message)?.[1];
  return name !== undefined && TYPE_NAMES.has(name) ? name : undefined;
}

/** Path segments that are schema property names; anything else could be data. */
const SAFE_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_MISMATCHES = 20;

/**
 * A union branch whose discriminator did not select it: it failed on a literal or on the
 * fallback's "not a documented value" check at its own top level.
 */
function notSelected(branch: readonly z.core.$ZodIssue[]): boolean {
  return branch.some(
    (issue) =>
      issue.path.length === 1 && (issue.code === 'invalid_value' || issue.code === 'custom'),
  );
}

/**
 * Where and how a response missed its schema: `data[].state: invalid_type (expected
 * string, received undefined)`. Paths, zod issue codes and type names only. List positions
 * and keys that are not plain property names are masked, and no received value or zod
 * message is kept. For a union, the branch its discriminator selected is followed, or else
 * the closest branch (fewest issues).
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
      const closest =
        [...issue.errors].sort(
          (a, b) => Number(notSelected(a)) - Number(notSelected(b)) || a.length - b.length,
        )[0] ?? [];
      lines.push(...mismatchSummary(closest, path));
      continue;
    }
    const received = issue.code === 'invalid_type' ? receivedType(issue.message) : undefined;
    const expected =
      issue.code === 'invalid_type' && SAFE_SEGMENT.test(issue.expected)
        ? ` (expected ${issue.expected}${received === undefined ? '' : `, received ${received}`})`
        : '';
    lines.push(`${path === '' ? '(root)' : path}: ${issue.code}${expected}`);
  }
  return [...new Set(lines)].slice(0, MAX_MISMATCHES);
}
