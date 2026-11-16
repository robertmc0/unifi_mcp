/**
 * The repository itself passes the static release checks and the secret scan of its
 * tracked files, on every `npm run check` (spec §14, §16 Phase 5 gate "public-repo scan
 * finds no secrets"; ADR 0029). The scan of the whole git history is `npm run
 * scan:secrets`, which CI runs with the full history.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVICE_VERSION } from '@unifi-local-mcp/mcp-server';
import { describe, expect, it } from 'vitest';
import {
  changelogProblems,
  runtimeProblems,
  trackedFileProblems,
  versionProblems,
  workflowProblems,
} from '../../scripts/lib/release-checks.ts';
import { scanText } from '../../scripts/lib/secret-scan.ts';

const ROOT = join(import.meta.dirname, '../..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter((file) => file !== '');
const rootPackage = JSON.parse(read('package.json')) as {
  version: string;
  engines?: { node?: string };
};

describe('release readiness', () => {
  it('has no secret, pin or real address in any tracked file', () => {
    const findings = tracked.flatMap((file) => {
      let text: string;
      try {
        text = read(file);
      } catch {
        return [];
      }
      return scanText(text, file).map((f) => `${f.rule}: ${f.file}:${String(f.line)}`);
    });
    expect(findings).toEqual([]);
    expect(tracked.length).toBeGreaterThan(300);
  });

  it('tracks nothing that must stay out, and has its licence and policy files', () => {
    expect(trackedFileProblems(tracked)).toEqual([]);
  });

  it('states one version everywhere, with a changelog section', () => {
    const workspaceVersions = Object.fromEntries(
      readdirSync(join(ROOT, 'packages')).map((name) => [
        `packages/${name}`,
        (JSON.parse(read(`packages/${name}/package.json`)) as { version: string }).version,
      ]),
    );
    expect(
      versionProblems({
        rootPackage,
        workspaceVersions,
        serviceVersion: SERVICE_VERSION,
        nodeVersionFile: '',
        dockerfile: '',
        changelog: '',
        workflows: {},
        trackedFiles: [],
      }),
    ).toEqual([]);
    expect(changelogProblems(read('CHANGELOG.md'), rootPackage.version)).toEqual([]);
  });

  it('pins the runtime and every action, and gives workflows read access by default', () => {
    expect(
      runtimeProblems({
        rootPackage,
        workspaceVersions: {},
        serviceVersion: undefined,
        nodeVersionFile: read('.node-version'),
        dockerfile: read('Dockerfile'),
        changelog: '',
        workflows: {},
        trackedFiles: [],
      }),
    ).toEqual([]);
    const workflows = Object.fromEntries(
      readdirSync(join(ROOT, '.github/workflows')).map((name) => [
        name,
        read(`.github/workflows/${name}`),
      ]),
    );
    expect(Object.keys(workflows).sort()).toEqual(['check.yml', 'release.yml']);
    expect(workflowProblems(workflows)).toEqual([]);
  });
});
