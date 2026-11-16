/**
 * Checks a tree before it is released (spec §14, §15 `scripts/verify-release`; ADR 0029).
 * Static and offline: versions agree, the runtime and the actions are pinned, nothing
 * forbidden is tracked, the working tree is clean, and the secret scan of the tree and
 * the history is clean. It does not replace `npm run check`, `npm run api:reconcile` and
 * `npm run test:containers`, which it lists at the end.
 *
 *   node scripts/verify-release.ts [--version <x.y.z>] [--allow-dirty]
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/api-specs.ts';
import {
  changelogProblems,
  runtimeProblems,
  trackedFileProblems,
  versionProblems,
  workflowProblems,
  type TreeFacts,
} from './lib/release-checks.ts';
import { scanHistory, scanText } from './lib/secret-scan.ts';

const read = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8');
const git = (args: string[]): string =>
  execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });

const versionFlag = process.argv.indexOf('--version');
const expected = versionFlag === -1 ? undefined : process.argv[versionFlag + 1];
const trackedFiles = git(['ls-files', '-z'])
  .split('\0')
  .filter((file) => file !== '');
const packages = readdirSync(join(REPO_ROOT, 'packages'));
const facts: TreeFacts = {
  rootPackage: JSON.parse(read('package.json')) as TreeFacts['rootPackage'],
  workspaceVersions: Object.fromEntries(
    packages.map((name) => [
      `packages/${name}`,
      (JSON.parse(read(`packages/${name}/package.json`)) as { version: string }).version,
    ]),
  ),
  serviceVersion: /export const SERVICE_VERSION = '([^']+)';/.exec(
    read('packages/mcp-server/src/service.ts'),
  )?.[1],
  nodeVersionFile: read('.node-version'),
  dockerfile: read('Dockerfile'),
  changelog: read('CHANGELOG.md'),
  workflows: Object.fromEntries(
    readdirSync(join(REPO_ROOT, '.github/workflows')).map((name) => [
      `.github/workflows/${name}`,
      read(`.github/workflows/${name}`),
    ]),
  ),
  trackedFiles,
};

const secretFindings = [
  ...trackedFiles.flatMap((file) => {
    try {
      return scanText(read(file), file);
    } catch {
      return [];
    }
  }),
  ...scanHistory(
    git(['log', '--all', '-p', '--unified=0', '--no-color', '--no-ext-diff', '--format=commit %H']),
  ),
];
const dirty = git(['status', '--porcelain']).trim();

const checks: [string, string[]][] = [
  ['versions', versionProblems(facts, expected)],
  ['changelog', changelogProblems(facts.changelog, facts.rootPackage.version)],
  ['runtime pins', runtimeProblems(facts)],
  ['workflows', workflowProblems(facts.workflows)],
  ['tracked files', trackedFileProblems(trackedFiles)],
  [
    'secret scan (tree and history)',
    secretFindings.map(
      (f) =>
        `${f.rule}: ${f.file}:${String(f.line)}${f.commit === undefined ? '' : ` (commit ${f.commit})`}`,
    ),
  ],
  [
    'working tree',
    dirty === '' || process.argv.includes('--allow-dirty')
      ? []
      : ['There are uncommitted changes; release from a clean tree.'],
  ],
];

let failed = false;
for (const [name, problems] of checks) {
  console.log(`${problems.length === 0 ? 'ok  ' : 'FAIL'}  ${name}`);
  for (const problem of problems) console.log(`      ${problem}`);
  failed ||= problems.length > 0;
}
console.log(
  [
    '',
    `Version ${facts.rootPackage.version}, commit ${git(['rev-parse', '--short', 'HEAD']).trim()}.`,
    'Not run by this script; run them before a release:',
    '  npm run check && npm run api:reconcile',
    '  npm run test:containers        (Docker)',
    '  npm audit && npm audit signatures   (network)',
    '  npm run sbom',
  ].join('\n'),
);
process.exitCode = failed ? 1 : 0;
