/**
 * Reconciles the committed operation inventories against the verified vendor contracts
 * and the committed coverage matrix (spec §4.3, §4.5).
 *
 *   node scripts/reconcile-api-coverage.ts          check only; non-zero exit on any drift
 *   node scripts/reconcile-api-coverage.ts --write  regenerate operations.json from vendor
 *                                                   OpenAPI (review the git diff afterwards)
 *
 * Checks, per application revision:
 *   1. contract artefacts in vendor/ match provenance.json checksums (run fetch-api-specs first);
 *   2. OpenAPI: the vendor operation set equals operations.json (added / removed / changed);
 *   3. OpenAPI: the llms.txt endpoint index lists exactly the same operations as the OpenAPI;
 *   4. OpenAPI: the documented local server URL equals provenance.localBaseUrlTemplate's path;
 *   5. every inventory operation appears in docs/api-coverage/api-coverage.json and vice versa.
 * PDF-sourced contracts (Access) are hand-transcribed; only checks 1 and 5 apply.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  COVERAGE_DIR,
  listSpecRevisions,
  readJson,
  sha256,
  vendorPath,
  writeJson,
  type Inventory,
  type InventoryOperation,
  type SpecRevision,
} from './lib/api-specs.ts';
import {
  inventoryFromOpenApi,
  openApiServers,
  parseLlmsIndex,
  parseOpenApi,
} from './lib/openapi-inventory.ts';

interface CoverageFile {
  modules: { application: string; revision: string; operations: { key: string }[] }[];
}

const write = process.argv.includes('--write');
const problems: string[] = [];
const report = (rev: SpecRevision, message: string): void => {
  problems.push(`${rev.provenance.application}/${rev.provenance.revision}: ${message}`);
};

async function verifiedVendorText(rev: SpecRevision, name: string): Promise<string | undefined> {
  const artifact = rev.provenance.artifacts.find((a) => a.name === name);
  if (artifact === undefined) return undefined;
  let data: Buffer;
  try {
    data = await readFile(vendorPath(rev, name));
  } catch {
    report(rev, `vendor/${name} not cached; run "npm run api:fetch-specs"`);
    return undefined;
  }
  if (sha256(data) !== artifact.sha256) {
    report(rev, `vendor/${name} does not match the recorded checksum`);
    return undefined;
  }
  return data.toString('utf8');
}

function diffInventories(
  rev: SpecRevision,
  committed: InventoryOperation[],
  vendor: InventoryOperation[],
): void {
  const before = new Map(committed.map((o) => [o.key, o]));
  const after = new Map(vendor.map((o) => [o.key, o]));
  for (const key of after.keys()) if (!before.has(key)) report(rev, `ADDED upstream: ${key}`);
  for (const key of before.keys()) if (!after.has(key)) report(rev, `REMOVED upstream: ${key}`);
  for (const [key, op] of after) {
    const old = before.get(key);
    if (old === undefined) continue;
    for (const field of [
      'vendorOperationId',
      'category',
      'summary',
      'documentationUrl',
      'transport',
    ] as const) {
      if (old[field] !== op[field]) {
        report(rev, `CHANGED ${key} ${field}: ${String(old[field])} -> ${String(op[field])}`);
      }
    }
  }
}

const coverage = await readJson<CoverageFile>(join(COVERAGE_DIR, 'api-coverage.json')).catch(() => {
  problems.push('docs/api-coverage/api-coverage.json missing; run "npm run api:coverage-report"');
  return undefined;
});

for (const rev of await listSpecRevisions()) {
  const { application, revision, contractKind } = rev.provenance;
  const inventoryPath = join(rev.dir, 'operations.json');
  let inventory = await readJson<Inventory>(inventoryPath);

  if (contractKind === 'openapi') {
    const specText = await verifiedVendorText(rev, 'openapi.json');
    const llmsText = await verifiedVendorText(rev, 'llms.txt');
    if (specText !== undefined && llmsText !== undefined) {
      const doc = parseOpenApi(specText);
      const index = parseLlmsIndex(llmsText);
      const vendorOps = inventoryFromOpenApi(doc, index);

      const localPath = new URL(
        rev.provenance.localBaseUrlTemplate.replace('{consoleHost}', 'h.invalid'),
      ).pathname;
      if (
        !openApiServers(doc).some(
          (s) => s.startsWith('https://{consoleIP}') && s.endsWith(localPath),
        )
      ) {
        report(rev, `OpenAPI servers no longer contain a local server ending in ${localPath}`);
      }
      const opKeys = new Set(vendorOps.map((o) => o.key));
      for (const key of index.keys())
        if (!opKeys.has(key)) report(rev, `llms.txt lists ${key} but OpenAPI does not`);
      for (const key of opKeys)
        if (!index.has(key)) report(rev, `OpenAPI has ${key} but llms.txt does not`);

      if (write) {
        inventory = {
          application,
          revision,
          derivedFrom:
            'vendor/openapi.json + vendor/llms.txt (scripts/reconcile-api-coverage.ts --write)',
          operationCount: vendorOps.length,
          operations: vendorOps,
        };
        await writeJson(inventoryPath, inventory);
        console.log(
          `WROTE ${application}/${revision}/operations.json (${vendorOps.length} operations)`,
        );
      } else {
        diffInventories(rev, inventory.operations, vendorOps);
      }
    }
  } else {
    // PDF-manual contracts: verify the cached document is the one transcribed.
    for (const artifact of rev.provenance.artifacts.filter((a) => a.role === 'contract')) {
      try {
        const data = await readFile(vendorPath(rev, artifact.name));
        if (sha256(data) !== artifact.sha256)
          report(rev, `vendor/${artifact.name} checksum changed; re-transcribe`);
      } catch {
        report(rev, `vendor/${artifact.name} not cached; run "npm run api:fetch-specs"`);
      }
    }
  }

  if (inventory.operationCount !== inventory.operations.length) {
    report(
      rev,
      `operations.json operationCount ${inventory.operationCount} != ${inventory.operations.length}`,
    );
  }
  const keys = inventory.operations.map((o) => o.key);
  if (new Set(keys).size !== keys.length) report(rev, 'operations.json contains duplicate keys');

  if (coverage !== undefined) {
    const module = coverage.modules.find(
      (m) => m.application === application && m.revision === revision,
    );
    if (module === undefined) {
      report(rev, 'no module entry in api-coverage.json');
    } else {
      const covered = new Set(module.operations.map((o) => o.key));
      for (const key of keys) if (!covered.has(key)) report(rev, `not in coverage matrix: ${key}`);
      for (const key of covered)
        if (!keys.includes(key)) report(rev, `coverage matrix has unknown operation: ${key}`);
    }
  }
  console.log(
    `checked ${application}/${revision}: ${inventory.operations.length} operations (${contractKind})`,
  );
}

if (problems.length > 0) {
  console.error(`\nAPI coverage reconciliation found ${problems.length} unreviewed difference(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exitCode = 1;
} else {
  console.log('\nAPI coverage reconciliation: no unreviewed differences.');
}
