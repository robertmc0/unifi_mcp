/**
 * The committed coverage matrix (docs/api-coverage/) equals a fresh build from the
 * operation inventories and the registered adapters, so its implementation status,
 * reviewed metadata and test evidence cannot drift (spec §4.5, ADR 0018 §6). Offline.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCoverageFiles } from '../../scripts/lib/coverage-report.ts';

const ROOT = join(import.meta.dirname, '../..');
const LIVE_DIR = join(ROOT, 'docs/api-coverage/live');

interface LiveRecord {
  module: string;
  revision: string;
  results: { operationId: string; outcome: string }[];
}

/** The committed live read-only records (docs/api-coverage/live/). */
async function liveRecords(): Promise<{ file: string; text: string; record: LiveRecord }[]> {
  const files = (await readdir(LIVE_DIR)).filter((file) => file.endsWith('.json'));
  return Promise.all(
    files.map(async (file) => {
      const text = await readFile(join(LIVE_DIR, file), 'utf8');
      return { file, text, record: JSON.parse(text) as LiveRecord };
    }),
  );
}

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

  it('marks exactly the reads of each committed live record that succeeded', async () => {
    const records = await liveRecords();
    expect(records.map((r) => r.file).sort()).toEqual([
      'network-11.0.97.json',
      'protect-7.3.74.json',
    ]);
    const files = await buildCoverageFiles();
    const matrix = JSON.parse(files.get('docs/api-coverage/api-coverage.json') ?? '{}') as {
      modules: {
        application: string;
        revision: string;
        operations: { operationId: string | null; method: string; liveReadValidation: boolean }[];
      }[];
    };
    for (const { record } of records) {
      const ok = new Set(
        record.results.filter((r) => r.outcome === 'ok').map((r) => r.operationId),
      );
      const operations =
        matrix.modules.find(
          (m) => m.application === record.module && m.revision === record.revision,
        )?.operations ?? [];
      for (const op of operations) {
        expect(op.liveReadValidation, op.operationId ?? '').toBe(ok.has(op.operationId ?? ''));
        if (op.liveReadValidation) expect(op.method).toBe('GET');
      }
      expect(operations.filter((o) => o.liveReadValidation)).toHaveLength(ok.size);
    }
  });

  it('commits live records that hold outcomes only, never addresses, ids or data', async () => {
    for (const { file, text, record } of await liveRecords()) {
      expect(text, file).not.toMatch(/:\/\/|@/);
      expect(text, file).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/); // IPv4
      expect(text, file).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|\b[0-9a-f]{24}\b/i); // ids
      expect(text, file).not.toMatch(/\b[0-9a-f]{2}(:[0-9a-f]{2}){5}\b/i); // MAC
      for (const result of record.results) {
        expect(result.operationId, file).toMatch(/^(network|protect)\.[a-z_]+\.[a-z_]+$/);
        expect(result.outcome, file).toMatch(
          /^(ok( \(empty\))?|[a-z_]+|skipped: [A-Za-z0-9 .<>=()_]+)$/,
        );
      }
    }
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
            { operationId: 'network.networks.list', outcome: 'ok (empty)' },
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
        '| Live read-only validation | 1 (2026-11-10, UniFi Network 11.0.97',
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
