/**
 * The Access transcription (ADR 0022) is well formed, covers exactly the inventory, and the
 * generated module was made from it. Runs offline; `npm run api:reconcile` additionally
 * compares the transcription with the cached PDF and regenerates the module.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as generated from '../../packages/unifi-access/src/generated/access-2026-03-23.ts';
import {
  structuralProblems,
  transcribedOperations,
} from '../../scripts/lib/access-transcription.ts';
import type { Inventory, Provenance } from '../../scripts/lib/api-specs.ts';
import { GENERATED_MODULES } from '../../scripts/generate-adapter-schemas.ts';

const ROOT = join(import.meta.dirname, '../..');
const SPEC = join(ROOT, 'api-specs/access/2026-03-23');
const MODULE = join(ROOT, 'packages/unifi-access/src/generated/access-2026-03-23.ts');

const text = await readFile(join(SPEC, 'transcription.json'), 'utf8');
const transcription = JSON.parse(text) as Record<string, unknown>;
const inventory = JSON.parse(await readFile(join(SPEC, 'operations.json'), 'utf8')) as Inventory;
const provenance = JSON.parse(await readFile(join(SPEC, 'provenance.json'), 'utf8')) as Provenance;
const contract = provenance.artifacts.find((a) => a.role === 'contract');
const operations = generated.OPERATIONS as Record<string, { method: string; path: string }>;
const config = GENERATED_MODULES.find((m) => m.application === 'access');

describe('Access transcription 2026-03-23', () => {
  it('passes the structural checks against the inventory and the pinned PDF', () => {
    expect(contract).toBeDefined();
    expect(
      structuralProblems(transcription, inventory.operations, contract ?? { name: '', sha256: '' }),
    ).toEqual([]);
  });

  it('is the source of the generated module', async () => {
    const source = await readFile(MODULE, 'utf8');
    const digest = createHash('sha256').update(text).digest('hex');
    expect(source).toContain('Source: api-specs/access/2026-03-23/transcription.json');
    expect(source).toContain(`SHA-256: ${digest}`);
    expect(source).toContain('hand transcription of a PDF contract, not a vendor');
    expect(config).toMatchObject({ source: 'transcription', naming: 'path' });
  });

  it('generates exactly the transcribed operations, none of the pending ones', () => {
    const omitted = Object.keys(
      config !== undefined && 'omittedOperations' in config
        ? (config.omittedOperations as Record<string, string>)
        : {},
    );
    const transcribed = [...transcribedOperations(transcription).keys()];
    expect(Object.keys(operations).sort()).toEqual(
      transcribed.filter((key) => !omitted.includes(key)).sort(),
    );
    const byKey = new Map(inventory.operations.map((op) => [op.key, op]));
    for (const [key, op] of Object.entries(operations)) {
      expect(op, key).toMatchObject({ method: byKey.get(key)?.method, path: byKey.get(key)?.path });
    }
  });
});
