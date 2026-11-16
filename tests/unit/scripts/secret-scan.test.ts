/**
 * The repository's secret and address scanner (scripts/lib/secret-scan.ts; ADR 0029):
 * what it must report, what it must leave alone, and that a report never contains the
 * value. Every sensitive-looking input is assembled from pieces, so this file itself
 * passes the scan.
 */
import { describe, expect, it } from 'vitest';
import { entropy, scanHistory, scanText } from '../../../scripts/lib/secret-scan.ts';

const glue = (...parts: string[]): string => parts.join('');
const RANDOM_43 = glue('q7Zr2LxP0v', 'Nf8sKd3Tb', 'W1yHc6Jm9', 'Ge4Ua5Ro', 'Xi2Vt7Bp').slice(0, 43);
const RANDOM_PIN = `${glue('Zk3', 'Qw9Lr2Xv7Tn5', 'Bp8Hd4Mf6Js1', 'Gc0Ya3Ue5Io7', 'Rt2+/b').slice(0, 43)}=`;
const HOME_ADDRESS = ['192', '168', '7', '23'].join('.');
const PUBLIC_ADDRESS = ['81', '2', '69', '142'].join('.');
const PEM_HEADER = glue('-----BEGIN ', 'PRIVATE KEY', '-----');

const rules = (text: string, file = 'packages/example/src/file.ts'): string[] =>
  scanText(text, file).map((finding) => finding.rule);

describe('what is reported', () => {
  it.each([
    [
      'a client token of this service',
      glue('umcp_', '0123456789ab', '_', RANDOM_43),
      'client-token',
    ],
    [
      'a private key header on its own line',
      `const pem = \`\n${PEM_HEADER}\nMIIE\n\``,
      'private-key',
    ],
    [
      'a private key in one escaped line',
      `'${PEM_HEADER}\\n${'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw'.repeat(8)}'`,
      'private-key',
    ],
    ['an AWS access key id', glue('AKIA', 'Q3EGR7XJ2M', 'TZ5LPW'), 'aws-access-key'],
    ['a GitHub token', glue('ghp_', 'a8Kd3Lz0Qw9Xv7Tn5Bp8Hd4Mf6Js1Gc0Ya3Ue'), 'github-token'],
    ['a Slack token', glue('xoxb-', '2048-9917-', 'aZ3kQ9LrX2v7Tn'), 'slack-token'],
    [
      'a JSON web token',
      glue('eyJ', 'hbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiJhbGljZSJ9', '.', 'c2lnbmF0dXJlLXZhbHVl'),
      'jwt',
    ],
    ['a certificate pin', `--pin ${glue('sha256', '/')}${RANDOM_PIN}`, 'certificate-pin'],
    [
      'a credential assigned to a named variable',
      `const apiKey = '${RANDOM_43}';`,
      'assigned-credential',
    ],
    ['a credential in YAML', `password: "${RANDOM_43}"`, 'assigned-credential'],
    ['a home network address', `host: ${HOME_ADDRESS}`, 'ip-address'],
    ['a public address', `UNIFI_LIVE_HOST=${PUBLIC_ADDRESS}`, 'ip-address'],
    ['an address with a port', `https://${HOME_ADDRESS}:12445/api`, 'ip-address'],
  ])('%s', (_what, text, rule) => {
    expect(rules(text)).toContain(rule);
  });

  it('says where, and never what', () => {
    const token = glue('umcp_', '0123456789ab', '_', RANDOM_43);
    const [finding] = scanText(`line one\nconst t = "${token}";\n`, 'docs/guide.md');
    expect(finding).toMatchObject({ rule: 'client-token', file: 'docs/guide.md', line: 2 });
    expect(JSON.stringify(finding)).not.toContain(RANDOM_43);
    expect(JSON.stringify(finding)).not.toContain(RANDOM_43.slice(0, 8));
  });

  it('finds what a commit added, even if a later commit removed it', () => {
    const log = [
      'commit 0123456789abcdef0123456789abcdef01234567',
      'diff --git a/deploy/notes.md b/deploy/notes.md',
      '--- a/deploy/notes.md',
      '+++ b/deploy/notes.md',
      '@@ -10,0 +11,2 @@',
      '+The console is at',
      `+${HOME_ADDRESS}`,
      'commit fedcba9876543210fedcba9876543210fedcba98',
      '--- a/deploy/notes.md',
      '+++ b/deploy/notes.md',
      '@@ -11,2 +10,0 @@',
      '-The console is at',
      `-${HOME_ADDRESS}`,
    ].join('\n');
    expect(scanHistory(log)).toEqual([
      expect.objectContaining({
        rule: 'ip-address',
        file: 'deploy/notes.md',
        line: 12,
        commit: '0123456789ab',
      }),
    ]);
  });
});

describe('what is left alone', () => {
  it.each([
    ['documentation addresses', 'hosts 192.0.2.10, 198.51.100.7 and 203.0.113.250'],
    ['loopback and unspecified', 'bind 127.0.0.1 or 0.0.0.0'],
    ['the container test networks', 'client 172.31.210.20, console 172.31.220.3'],
    [
      'whole private ranges, as in the egress allowlist',
      '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10',
    ],
    ['the metadata address named in the denylist', "'169.254.169.254'"],
    ['application versions', 'Network 11.0.97, Protect 7.4.96, Access 4.2.16'],
    ['a synthetic client token', glue('umcp_', '0123456789ab', '_', 'A'.repeat(43))],
    ['a synthetic pin', glue('sha256', '/', 'A'.repeat(43), '=')],
    ['a synthetic credential', "const NETWORK_KEY = 'synthetic-network-key-SENTINEL-77';"],
    ['a password sentence', "const PASSWORD = 'correct horse battery staple';"],
    ['a secret file path', 'UNIFI_MCP_METRICS_TOKEN_FILE: /run/secrets/unifi_mcp_metrics_token'],
    ['a quoted key header in a redaction test', `'${PEM_HEADER}\\nMIIEow' // redacted`],
    ['a checksum', 'sha256 0828aa9f017cce92cd035429c7e19c933d0b3387c561aac17c468b4c2ca8be66'],
  ])('%s', (_what, text) => {
    expect(rules(text)).toEqual([]);
  });

  it('accepts the private-range test vectors under tests/ only', () => {
    const vector = ['192', '168', '255', '254'].join('.');
    expect(rules(`'${vector}',`, 'tests/unit/unifi-api/consoles.test.ts')).toEqual([]);
    expect(rules(`'${vector}',`, 'docs/networking.md')).toEqual(['ip-address']);
  });

  it('accepts a reviewed example address in the history of its own file only', () => {
    const reviewed = ['192', '168', '1', '0'].join('.');
    const added = (file: string): string =>
      [
        'commit 0123456789abcdef0123456789abcdef01234567',
        `+++ b/${file}`,
        '@@ -0,0 +1 @@',
        `+'${reviewed}',`,
      ].join('\n');
    expect(scanHistory(added('.env.example'))).toEqual([]);
    expect(scanHistory(added('scripts/lib/secret-scan.ts'))).toEqual([]);
    expect(scanHistory(added('docs/networking.md'))).toHaveLength(1);
    expect(rules(`'${reviewed}',`, '.env.example')).toEqual(['ip-address']);
  });

  it('does not read lock files and licences, which hold identifiers of other projects', () => {
    expect(rules(`host: ${HOME_ADDRESS}`, 'package-lock.json')).toEqual([]);
    expect(rules(`host: ${HOME_ADDRESS}`, 'packages/x/package-lock.json')).toEqual([]);
  });
});

describe('entropy', () => {
  it('separates random strings from words', () => {
    expect(entropy('aaaaaaaaaaaaaaaaaaaaaaaa')).toBe(0);
    expect(entropy('abababababababababababab')).toBe(1);
    expect(entropy(RANDOM_43)).toBeGreaterThan(4.5);
    expect(entropy('synthetic-network-key-abc')).toBeLessThan(4.2);
  });
});
