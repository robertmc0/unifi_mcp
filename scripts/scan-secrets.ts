/**
 * Scans the tracked files and, with `--history`, every line any commit ever added, for
 * secrets and real addresses (scripts/lib/secret-scan.ts; ADR 0029).
 *
 *   node scripts/scan-secrets.ts             the working tree (tracked files)
 *   node scripts/scan-secrets.ts --history   the tree and the whole git history
 *
 * Exits 1 when anything is found. Values are never printed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/api-specs.ts';
import { scanHistory, scanText, type Finding } from './lib/secret-scan.ts';

const git = (args: string[]): string =>
  execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });

const findings: Finding[] = [];
const files = git(['ls-files', '-z'])
  .split('\0')
  .filter((file) => file !== '');
for (const file of files) {
  let text: string;
  try {
    text = readFileSync(join(REPO_ROOT, file), 'utf8');
  } catch {
    continue; // deleted in the working tree
  }
  findings.push(...scanText(text, file));
}
console.log(`scanned ${String(files.length)} tracked files`);

if (process.argv.includes('--history')) {
  const commits = git(['rev-list', '--all', '--count']).trim();
  findings.push(
    ...scanHistory(
      git([
        'log',
        '--all',
        '-p',
        '--unified=0',
        '--no-color',
        '--no-ext-diff',
        '--format=commit %H',
      ]),
    ),
  );
  console.log(`scanned the added lines of ${commits} commits`);
}

if (findings.length === 0) {
  console.log('No secret, pin or real address found.');
} else {
  const seen = new Set<string>();
  for (const f of findings) {
    const where = `${f.file}:${String(f.line)}${f.commit === undefined ? '' : ` (commit ${f.commit})`}`;
    const key = `${f.rule} ${where}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.error(`${f.rule}: ${where}: ${f.preview}`);
  }
  console.error(
    `\n${String(seen.size)} finding(s). Remove the value, or, if it is synthetic, make that obvious.`,
  );
  process.exitCode = 1;
}
