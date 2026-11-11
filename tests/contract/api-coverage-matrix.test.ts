/**
 * The committed coverage matrix (docs/api-coverage/) equals a fresh build from the
 * operation inventories and the registered adapters, so its implementation status,
 * reviewed metadata and test evidence cannot drift (spec §4.5, ADR 0018 §6). Offline.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
    }
  });

  it('marks exactly the reads of the committed live record that succeeded', async () => {
    const record = JSON.parse(
      await readFile(join(ROOT, 'docs/api-coverage/live/network-11.0.97.json'), 'utf8'),
    ) as { results: { operationId: string; outcome: string }[] };
    const ok = new Set(record.results.filter((r) => r.outcome === 'ok').map((r) => r.operationId));
    const files = await buildCoverageFiles();
    const matrix = JSON.parse(files.get('docs/api-coverage/api-coverage.json') ?? '{}') as {
      modules: {
        application: string;
        operations: { operationId: string | null; method: string; liveReadValidation: boolean }[];
      }[];
    };
    const operations = matrix.modules.find((m) => m.application === 'network')?.operations ?? [];
    for (const op of operations) {
      expect(op.liveReadValidation, op.operationId ?? '').toBe(ok.has(op.operationId ?? ''));
      if (op.liveReadValidation) expect(op.method).toBe('GET');
    }
    expect(operations.filter((o) => o.liveReadValidation)).toHaveLength(ok.size);
  });

  it('marks reads validated only from a reviewed live record, never writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'live-record-'));
    try {
      await writeFile(
        join(dir, 'network-11.0.97.json'),
        JSON.stringify({
          module: 'network',
          revision: '11.0.97',
          date: '2026-11-10',
          applicationVersion: '11.0.97',
          results: [
            { operationId: 'network.sites.list', outcome: 'ok' },
            { operationId: 'network.devices.list', outcome: 'upstream_contract_mismatch' },
            { operationId: 'network.acl.create', outcome: 'ok' },
          ],
        }),
      );
      const files = await buildCoverageFiles({ liveDir: dir });
      const matrix = JSON.parse(files.get('docs/api-coverage/api-coverage.json') ?? '{}') as {
        modules: {
          application: string;
          operations: { operationId: string | null; liveReadValidation: boolean }[];
        }[];
      };
      const validated = (matrix.modules.find((m) => m.application === 'network')?.operations ?? [])
        .filter((o) => o.liveReadValidation)
        .map((o) => o.operationId);
      expect(validated).toEqual(['network.sites.list']);
      expect(files.get('docs/api-coverage/network/11.0.97.md')).toContain(
        '| Live read-only validation | 1 (2026-11-10, Network 11.0.97',
      );

      await writeFile(join(dir, 'network-11.0.97.json'), JSON.stringify({ module: 'network' }));
      await expect(buildCoverageFiles({ liveDir: dir })).rejects.toThrow(
        /not a live read-only record/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
