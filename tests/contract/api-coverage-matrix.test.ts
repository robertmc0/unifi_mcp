/**
 * The committed coverage matrix (docs/api-coverage/) equals a fresh build from the
 * operation inventories and the registered adapters, so its implementation status,
 * reviewed metadata and test evidence cannot drift (spec §4.5, ADR 0018 §6). Offline.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCoverageFiles } from '../../scripts/lib/coverage-report.ts';

const ROOT = join(import.meta.dirname, '../..');

describe('API coverage matrix', () => {
  it('is current (npm run api:coverage-report)', async () => {
    for (const [path, content] of await buildCoverageFiles()) {
      expect(await readFile(join(ROOT, path), 'utf8'), path).toBe(content);
    }
  });

  it('reports every Network operation as implemented with evidence', async () => {
    const files = await buildCoverageFiles();
    const matrix = JSON.parse(files.get('docs/api-coverage/api-coverage.json') ?? '{}') as {
      modules: {
        application: string;
        totals: { documented: number; implemented: number };
        operations: { status: string; evidence: string[]; liveReadValidation: boolean }[];
      }[];
    };
    const network = matrix.modules.find((m) => m.application === 'network');
    expect(network?.totals).toMatchObject({ documented: 73, implemented: 73 });
    for (const op of network?.operations ?? []) {
      expect(op.status).toBe('implemented');
      expect(op.evidence.length).toBeGreaterThanOrEqual(3);
      expect(op.liveReadValidation).toBe(false); // only the opt-in live test may set this
    }
  });
});
