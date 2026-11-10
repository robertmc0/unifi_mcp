/**
 * Application version ranges for operations (spec §4.3 `apiVersionRange`, §2 decision 23).
 *
 * Versions are dotted numbers as UniFi applications report them (`11.0.97`, `7.3.74`);
 * a suffix after `-` or `+` is ignored. A range is one or more space-separated comparators,
 * all of which must hold: `>=10.1 <12`, `=7.3.74`, `>6`. There is deliberately no fuzzy
 * matching: an unparseable observed version is never "supported".
 */
const COMPARATOR = /^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,3})$/;
const VERSION = /^v?(\d+(?:\.\d+){0,3})(?:[-+].*)?$/;

export type VersionRange = { op: '>=' | '<=' | '>' | '<' | '='; version: number[] }[];

export function parseVersion(text: string): number[] | undefined {
  const match = VERSION.exec(text.trim());
  return match?.[1]?.split('.').map(Number);
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function parseRange(range: string): VersionRange | undefined {
  const parts = range.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') return undefined;
  const comparators: VersionRange = [];
  for (const part of parts) {
    const match = COMPARATOR.exec(part);
    if (match?.[2] === undefined) return undefined;
    comparators.push({
      op: (match[1] ?? '=') as VersionRange[number]['op'],
      version: match[2].split('.').map(Number),
    });
  }
  return comparators;
}

export function satisfies(version: string, range: string): boolean {
  const parsedVersion = parseVersion(version);
  const parsedRange = parseRange(range);
  if (parsedVersion === undefined || parsedRange === undefined) return false;
  return parsedRange.every(({ op, version: bound }) => {
    const order = compare(parsedVersion, bound);
    switch (op) {
      case '>=':
        return order >= 0;
      case '<=':
        return order <= 0;
      case '>':
        return order > 0;
      case '<':
        return order < 0;
      case '=':
        return order === 0;
    }
  });
}
