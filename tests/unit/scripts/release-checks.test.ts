/**
 * The static release checks (scripts/lib/release-checks.ts; ADR 0029): each one catches
 * the disagreement it exists for.
 */
import { describe, expect, it } from 'vitest';
import {
  changelogProblems,
  runtimeProblems,
  trackedFileProblems,
  versionProblems,
  workflowProblems,
  type TreeFacts,
} from '../../../scripts/lib/release-checks.ts';

const DIGEST = 'a'.repeat(64);
const SHA = 'b'.repeat(40);
const good: TreeFacts = {
  rootPackage: { version: '1.2.3', engines: { node: '>=26.13.0 <27' } },
  workspaceVersions: { 'packages/core': '1.2.3', 'packages/cli': '1.2.3' },
  serviceVersion: '1.2.3',
  nodeVersionFile: '26.13.0\n',
  dockerfile: `ARG NODE_IMAGE=node:26.13.0-trixie-slim@sha256:${DIGEST}\nFROM \${NODE_IMAGE}\n`,
  changelog: '# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-12-01\n',
  workflows: {
    'check.yml': `permissions:\n  contents: read\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@${SHA} # v7.0.1\n`,
  },
  trackedFiles: ['LICENSE', 'NOTICE', 'SECURITY.md', 'CHANGELOG.md', 'package-lock.json', 'a.ts'],
};

describe('release checks', () => {
  it('pass a consistent tree', () => {
    expect([
      ...versionProblems(good, '1.2.3'),
      ...changelogProblems(good.changelog, '1.2.3'),
      ...runtimeProblems(good),
      ...workflowProblems(good.workflows),
      ...trackedFileProblems(good.trackedFiles),
    ]).toEqual([]);
  });

  it('find versions that disagree', () => {
    expect(versionProblems({ ...good, serviceVersion: '1.2.2' })).toEqual([
      'SERVICE_VERSION is 1.2.2, package.json is 1.2.3.',
    ]);
    expect(versionProblems({ ...good, serviceVersion: undefined })[0]).toContain('missing');
    expect(
      versionProblems({
        ...good,
        workspaceVersions: { 'packages/core': '1.2.3', 'packages/cli': '1.0.0' },
      }),
    ).toEqual(['packages/cli is 1.0.0, the root is 1.2.3.']);
    expect(versionProblems(good, '1.3.0')).toEqual([
      'package.json is 1.2.3, but 1.3.0 is being released.',
    ]);
    expect(versionProblems({ ...good, rootPackage: { version: 'next' } })[0]).toContain(
      'not SemVer',
    );
  });

  it('want a changelog section for a release, and "Unreleased" during development', () => {
    expect(changelogProblems('## [Unreleased]\n', '1.2.3')).toEqual([
      'CHANGELOG.md has no "## [1.2.3]" section.',
    ]);
    expect(changelogProblems('## [Unreleased]\n', '0.0.0')).toEqual([]);
    expect(changelogProblems('## [1.2.30]\n', '1.2.3')).toHaveLength(1);
  });

  it('find a runtime that is not pinned, or stated differently in two places', () => {
    expect(
      runtimeProblems({ ...good, dockerfile: 'ARG NODE_IMAGE=node:26.13.0-trixie-slim\n' }),
    ).toEqual([
      'The Dockerfile base image is not pinned as node:<version>-…-slim@sha256:<digest>.',
    ]);
    expect(
      runtimeProblems({
        ...good,
        dockerfile: `ARG NODE_IMAGE=node:26.14.0-trixie-slim@sha256:${DIGEST}\n`,
      }),
    ).toEqual(['The Dockerfile uses Node.js 26.14.0, .node-version says 26.13.0.']);
    expect(runtimeProblems({ ...good, nodeVersionFile: '26\n' })[0]).toContain('exact version');
    expect(
      runtimeProblems({ ...good, rootPackage: { version: '1.2.3', engines: { node: '>=24' } } }),
    ).toEqual(['package.json engines.node (">=24") does not start at 26.13.0.']);
  });

  it('find actions that are not pinned by commit, and workflows that ask for too much', () => {
    const workflow = (body: string): Record<string, string> => ({
      'w.yml': `permissions:\n  contents: read\njobs:\n  a:\n    steps:\n${body}`,
    });
    expect(workflowProblems(workflow('      - uses: actions/checkout@v7\n'))).toEqual([
      'w.yml:6: "actions/checkout@v7" is not pinned by a commit SHA.',
    ]);
    expect(workflowProblems(workflow('      - uses: actions/checkout@main\n'))).toHaveLength(1);
    expect(
      workflowProblems(workflow(`      - uses: actions/checkout@${SHA.slice(0, 12)}\n`)),
    ).toHaveLength(1);
    expect(workflowProblems(workflow(`      - uses: actions/checkout@${SHA}\n`))).toEqual([
      'w.yml:6: the pinned action has no version comment.',
    ]);
    expect(workflowProblems(workflow(`      - uses: ./.github/actions/local\n`))).toEqual([]);
    expect(workflowProblems({ 'w.yml': `jobs:\n  a:\n    steps: []\n` })).toEqual([
      'w.yml: the workflow does not default to "permissions: contents: read".',
    ]);
    expect(
      workflowProblems({
        'w.yml': `on:\n  pull_request_target:\npermissions:\n  contents: read\n`,
      }),
    ).toEqual(['w.yml: pull_request_target runs untrusted code with secrets; do not use it.']);
  });

  it('find files that must never be tracked, and required files that are missing', () => {
    const tracked = (extra: string[]): string[] => [...good.trackedFiles, ...extra];
    for (const [file, what] of [
      ['api-specs/network/11.0.97/vendor/openapi.json', 'vendor artefact'],
      ['.env', 'environment file'],
      ['deploy/.env.production', 'environment file'],
      ['deploy/secrets/unifi_mcp_master_key', 'secrets or data directory'],
      ['tests/fixtures/server.pem', 'key or certificate'],
      ['master.key', 'key or certificate'],
      ['data/unifi-mcp.db', 'database'],
      ['backup.db-wal', 'database'],
      ['packages/core/node_modules/x/index.js', 'installed dependencies'],
    ] as const) {
      expect(trackedFileProblems(tracked([file])).join(' '), file).toContain(what);
    }
    expect(trackedFileProblems(tracked(['.env.example', 'deploy/dual.env.example']))).toEqual([]);
    expect(trackedFileProblems(['a.ts'])).toEqual([
      'LICENSE is missing.',
      'NOTICE is missing.',
      'SECURITY.md is missing.',
      'CHANGELOG.md is missing.',
      'package-lock.json is missing.',
    ]);
  });
});
