/**
 * A small secret and address scanner for this repository (spec §14 "secret scanning",
 * §16 Phase 5 gate "public-repo scan finds no secrets", AGENTS.md "no generated
 * credentials, real hostnames or addresses in the repository"; ADR 0029).
 *
 * It looks for what must never be committed here: private keys, tokens in this project's
 * own format and in common vendors' formats, credentials assigned to obviously named
 * variables, certificate pins, and IP addresses outside the documentation and loopback
 * ranges. It reports where, and never prints what it found.
 *
 * It is deliberately narrow and has no dependency. It complements, and does not replace,
 * a general-purpose scanner run before the repository is published.
 */

export interface Finding {
  rule: string;
  file: string;
  line: number;
  /** Where it was found: the working tree, or a commit of the history. */
  commit?: string;
  /** A description that does not contain the value. */
  preview: string;
}

interface Rule {
  name: string;
  pattern: RegExp;
  /** The part of the match that is the secret (default: the whole match). */
  group?: number;
  /** True when a match is not a finding. */
  allowed?(value: string, context: { file: string; line: string }): boolean;
}

/** Shannon entropy in bits per character. */
export function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

const SYNTHETIC_WORDS =
  /synthetic|sentinel|example|placeholder|dummy|sample|fixture|not[-_ ]a[-_ ]/i;

/** Obviously made up: a marker word, or too few different characters to be random. */
function synthetic(value: string): boolean {
  return SYNTHETIC_WORDS.test(value) || new Set(value).size <= 6;
}

/**
 * IPv4 addresses that may appear: loopback, unspecified, the three documentation ranges
 * (RFC 5737), link-local metadata (named in the egress denylist), broadcast, and the
 * private test networks the container tests create.
 */
function addressAllowed(address: string): boolean {
  const parts = address.split('.').map(Number);
  const [a = 0, b = 0, c = 0, d = 0] = parts;
  if (parts.some((part) => part > 255)) return true; // not an address
  if (a === 127 || address === '0.0.0.0' || address === '255.255.255.255') return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && (b === 30 || b === 31)) return true;
  // Network addresses of whole ranges, as written in allowlists and their documentation.
  if (d === 0 && ((a === 10 && b === 0 && c === 0) || (a === 172 && b === 16 && c === 0)))
    return true;
  if (d === 0 && ((a === 192 && b === 168 && c === 0) || (a === 100 && b === 64 && c === 0)))
    return true;
  if (a >= 224) return true; // multicast and reserved, never a host
  return false;
}

/** An address from its octets: this file must pass its own scan, so it holds no literal. */
function ip(...octets: number[]): string {
  return octets.join('.');
}

/**
 * Private-range addresses the egress tests need as members of each range. They are
 * accepted only under `tests/`, so the same value elsewhere is still reported.
 */
const TEST_VECTOR_ADDRESSES = new Set([
  ip(10, 255, 255, 254),
  ip(192, 168, 255, 254),
  ip(100, 127, 255, 254),
]);

export const RULES: readonly Rule[] = [
  // A key as it sits in a file: the header on a line of its own, or followed on the same
  // line by a key's worth of data. A short quoted header in a redaction test is neither.
  { name: 'private-key', pattern: /^\s*-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----\s*$/g },
  {
    name: 'private-key',
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----(?:\\n|\s)*[A-Za-z0-9+/=\\n]{200,}/g,
  },
  {
    name: 'client-token',
    pattern: /\bumcp_[0-9a-f]{12}_([A-Za-z0-9_-]{43})\b/g,
    group: 1,
    allowed: (value) => synthetic(value),
  },
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    name: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g,
  },
  { name: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    name: 'certificate-pin',
    pattern: /sha256\/([A-Za-z0-9+/]{43}=)/g,
    group: 1,
    allowed: (value) => synthetic(value),
  },
  {
    // key = "value" or key: 'value' for names that say what the value is.
    name: 'assigned-credential',
    pattern:
      /\b(?:pass(?:word|wd)?|secret|token|api[_-]?key|private[_-]?key|credential)s?["']?\s*[:=]\s*["'`]([A-Za-z0-9+/=_.~-]{24,})["'`]/gi,
    group: 1,
    allowed: (value) => synthetic(value) || entropy(value) < 3.5 || /^[a-z_.-]+$/.test(value),
  },
  {
    name: 'ip-address',
    pattern: /(?<![\d.])(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?![\d.]|\.\d)/g,
    group: 1,
    allowed: (value, { file, line }) =>
      addressAllowed(value) ||
      (file.startsWith('tests/') && TEST_VECTOR_ADDRESSES.has(value)) ||
      // Version numbers with four parts, and object identifiers.
      (/version|OID|oid|@|v\d/.test(line.slice(0, 200)) &&
        !/host|addr|ip|console|bind/i.test(line)),
  },
];

/** Files whose content is other people's identifiers by nature. */
const SKIPPED_FILES =
  /(^|\/)(package-lock\.json|LICENSE|NOTICE)$|\.(png|jpg|jpeg|gif|ico|pdf|woff2?)$/;

/**
 * Reviewed on 2026-11-16: generic example addresses that earlier commits used in
 * documentation and in the egress tests (a home-LAN example network, members of the
 * private ranges, a well-known public resolver). They identify nobody, were replaced by
 * documentation addresses, and stay in the history. They are accepted in the history of
 * these files only; the same value in the tree, or anywhere else, is reported.
 */
const HISTORY_BASELINE: Readonly<Record<string, readonly string[]>> = {
  '.env.example': [ip(192, 168, 1, 0)],
  'docs/configuration.md': [ip(192, 168, 1, 0), ip(10, 8, 0, 0)],
  'packages/unifi-api/src/egress.ts': [ip(10, 0, 0, 1), ip(192, 168, 1, 0)],
  'tests/unit/unifi-api/consoles.test.ts': [
    ip(10, 1, 2, 3),
    ip(172, 20, 0, 1),
    ip(192, 168, 1, 1),
    ip(100, 100, 1, 1),
    ip(8, 8, 8, 8),
    ip(192, 168, 10, 0),
    ip(10, 8, 0, 0),
  ],
  // This file's first version (commit 702fafa) held the test vectors and the lists above
  // as literals, so it failed its own scan; it now builds every address from octets.
  'scripts/lib/secret-scan.ts': [
    ...TEST_VECTOR_ADDRESSES,
    ip(192, 168, 1, 0),
    ip(10, 8, 0, 0),
    ip(10, 0, 0, 1),
    ip(10, 1, 2, 3),
    ip(172, 20, 0, 1),
    ip(192, 168, 1, 1),
    ip(100, 100, 1, 1),
    ip(8, 8, 8, 8),
    ip(192, 168, 10, 0),
  ],
};

/** Findings in one text. `file` is used for reporting and for the skip list. */
export function scanText(
  text: string,
  file: string,
  options: { history?: boolean } = {},
): Finding[] {
  if (SKIPPED_FILES.test(file)) return [];
  const findings: Finding[] = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (line.length > 5000) return; // generated data, not source
    for (const rule of RULES) {
      for (const match of line.matchAll(rule.pattern)) {
        const value = match[rule.group ?? 0] ?? match[0];
        if (rule.allowed?.(value, { file, line }) === true) continue;
        if (
          options.history === true &&
          rule.name === 'ip-address' &&
          HISTORY_BASELINE[file]?.includes(value) === true
        ) {
          continue;
        }
        findings.push({
          rule: rule.name,
          file,
          line: index + 1,
          preview: `${String(value.length)} characters, starting "${value.slice(0, 3)}…"`,
        });
      }
    }
  });
  return findings;
}

/**
 * Findings in the added lines of a `git log -p --unified=0` stream: every line any commit
 * ever added, including ones removed since.
 */
export function scanHistory(log: string): Finding[] {
  const findings: Finding[] = [];
  let commit = '';
  let file = '';
  let line = 0;
  for (const raw of log.split('\n')) {
    if (raw.startsWith('commit ')) commit = raw.slice(7, 19);
    else if (raw.startsWith('+++ b/')) file = raw.slice(6);
    else if (raw.startsWith('+++ ')) file = '';
    else if (raw.startsWith('@@')) {
      line = Number(/\+(\d+)/.exec(raw)?.[1] ?? '0') - 1;
    } else if (raw.startsWith('+') && file !== '') {
      line += 1;
      for (const finding of scanText(raw.slice(1), file, { history: true })) {
        findings.push({ ...finding, line, commit });
      }
    }
  }
  return findings;
}
