/**
 * Offline invariants for the committed API contract baseline (ADR 0005, ADR 0006).
 * Runs without the vendor cache or network access; scripts/reconcile-api-coverage.ts
 * performs the vendor-side comparison.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COVERAGE_DIR,
  HTTP_METHODS,
  listSpecRevisions,
  readJson,
  REPO_ROOT,
  type Inventory,
} from '../../scripts/lib/api-specs.ts';

const revisions = await Promise.all(
  (await listSpecRevisions()).map(async (rev) => ({
    ...rev,
    inventory: await readJson<Inventory>(join(rev.dir, 'operations.json')),
  })),
);

interface CoverageFile {
  modules: {
    application: string;
    revision: string;
    contractSha256: string | null;
    totals: { documented: number };
    operations: { key: string; status: string }[];
  }[];
}
const coverage = await readJson<CoverageFile>(join(COVERAGE_DIR, 'api-coverage.json'));

describe('API contract baseline', () => {
  it('covers exactly the roadmap modules with official local APIs', () => {
    expect([...new Set(revisions.map((r) => r.provenance.application))].sort()).toEqual([
      'access',
      'network',
      'protect',
    ]);
    // Protect keeps the current official release and the newest documented revision.
    expect(
      revisions.map((r) => `${r.provenance.application}/${r.provenance.revision}`).sort(),
    ).toEqual(['access/2026-03-23', 'network/11.0.97', 'protect/7.3.74', 'protect/7.4.96']);
  });

  for (const { provenance: p, inventory } of revisions) {
    describe(`${p.application}/${p.revision}`, () => {
      it('uses an https local base URL and never a cloud/connector URL', () => {
        const base = new URL(p.localBaseUrlTemplate.replace('{consoleHost}', 'console.invalid'));
        expect(base.protocol).toBe('https:');
        expect(base.hostname).toBe('console.invalid');
        expect(p.localBaseUrlTemplate).not.toMatch(/api\.ui\.com|unifi\.ui\.com|\/connector\//);
        for (const forbidden of p.forbiddenBaseUrlTemplates) {
          expect(forbidden).toMatch(/^https:\/\/api\.ui\.com\//);
          expect(forbidden).not.toBe(p.localBaseUrlTemplate);
        }
      });

      it('records a contract artefact with a SHA-256 checksum', () => {
        const contracts = p.artifacts.filter((a) => a.role === 'contract');
        expect(contracts).toHaveLength(1);
        for (const a of p.artifacts) {
          expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
          expect(a.bytes).toBeGreaterThan(0);
          expect(new URL(a.url).protocol).toBe('https:');
        }
      });

      it('documents authentication from official sources', () => {
        expect(p.authentication.header).not.toBe('');
        expect(p.authentication.sources.length).toBeGreaterThan(0);
      });

      it('has a well-formed, duplicate-free operation inventory', () => {
        expect(inventory.application).toBe(p.application);
        expect(inventory.revision).toBe(p.revision);
        expect(inventory.operationCount).toBe(inventory.operations.length);
        const keys = new Set<string>();
        for (const op of inventory.operations) {
          expect(HTTP_METHODS).toContain(op.method);
          expect(op.path).toMatch(/^\/[A-Za-z0-9_\-/{}.]*$/);
          expect(op.path).not.toMatch(/:\w/); // templates use {param}, never :param
          expect(op.key).toBe(`${op.method} ${op.path}`);
          expect(keys.has(op.key)).toBe(false);
          keys.add(op.key);
        }
      });

      it('is fully represented in the coverage matrix', () => {
        const module = coverage.modules.find(
          (m) => m.application === p.application && m.revision === p.revision,
        );
        expect(module).toBeDefined();
        expect(module?.contractSha256).toBe(p.artifacts.find((a) => a.role === 'contract')?.sha256);
        expect(module?.totals.documented).toBe(inventory.operations.length);
        expect(module?.operations.map((o) => o.key).sort()).toEqual(
          inventory.operations.map((o) => o.key).sort(),
        );
      });
    });
  }

  it('does not commit vendor artefacts (vendor/ is gitignored)', async () => {
    const gitignore = await readFile(join(REPO_ROOT, '.gitignore'), 'utf8');
    expect(gitignore).toMatch(/^api-specs\/\*\*\/vendor\/$/m);
  });
});
