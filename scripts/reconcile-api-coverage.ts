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
 *   5. every inventory operation appears in docs/api-coverage/api-coverage.json and vice versa;
 *   6. the generated adapter schemas equal a fresh generation from the vendor cache;
 *   7. the coverage matrix equals a fresh build from the inventories and the registered
 *      adapters (status, reviewed metadata, test evidence);
 *   8. an operation built from one revision whose version range includes a later revision
 *      differs from it only additively (ADR 0019 §7);
 *   9. PDF: the hand transcription (transcription.json) is well formed, covers exactly the
 *      inventory, and matches the text of the cached PDF in both directions; every
 *      inventory operation's method, path and permission key are printed on its page
 *      (ADR 0022 §6).
 * PDF-sourced contracts (Access) are hand-transcribed; checks 1, 5, 6 and 9 apply.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  COVERAGE_DIR,
  listSpecRevisions,
  REPO_ROOT,
  readJson,
  sha256,
  vendorPath,
  writeJson,
  type Inventory,
  type InventoryOperation,
  type SpecRevision,
} from './lib/api-specs.ts';
import { generateAdapterSchemas, transcriptionPath } from './generate-adapter-schemas.ts';
import { pdfProblems, structuralProblems } from './lib/access-transcription.ts';
import { extractPdfText } from './lib/pdf-text.ts';
import { satisfies } from '@unifi-local-mcp/core';
import { ADAPTERS } from '@unifi-local-mcp/mcp-server';
import { buildCoverageFiles } from './lib/coverage-report.ts';
import { operationBreaks } from './lib/revision-compat.ts';
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
  // A new OpenAPI revision has no inventory until --write derives it (api-specs/README.md).
  let inventory = await readJson<Inventory>(inventoryPath).catch((error: unknown) => {
    if (write && contractKind === 'openapi' && (error as { code?: unknown }).code === 'ENOENT') {
      return { application, revision, derivedFrom: '', operationCount: 0, operations: [] };
    }
    throw error;
  });

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
    // PDF-manual contracts: verify the cached document is the one transcribed (1), then
    // compare the transcription with it (9).
    for (const artifact of rev.provenance.artifacts.filter((a) => a.role === 'contract')) {
      let data: Buffer | undefined;
      try {
        data = await readFile(vendorPath(rev, artifact.name));
        if (sha256(data) !== artifact.sha256) {
          report(rev, `vendor/${artifact.name} checksum changed; re-transcribe`);
          data = undefined;
        }
      } catch {
        report(rev, `vendor/${artifact.name} not cached; run "npm run api:fetch-specs"`);
      }
      const file = transcriptionPath(application, revision);
      const transcription = await readJson<Record<string, unknown>>(file).catch(() => undefined);
      if (transcription === undefined) {
        report(rev, 'transcription.json is missing or not JSON (ADR 0022)');
        continue;
      }
      for (const line of structuralProblems(transcription, inventory.operations, artifact)) {
        report(rev, `transcription: ${line}`);
      }
      if (data === undefined) continue;
      const pages = extractPdfText(data);
      for (const line of pdfProblems(transcription, pages, inventory.operations)) {
        report(rev, `transcription vs PDF: ${line}`);
      }
      const pending = transcription['x-pending'];
      console.log(
        `checked ${application}/${revision}: transcription against ${String(pages.length)} PDF ` +
          `pages (${String(Array.isArray(pending) ? pending.length : '?')} operations pending)`,
      );
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

// 7. The coverage matrix matches the registered adapters (status, metadata, evidence).
if (!write) {
  for (const [path, content] of await buildCoverageFiles()) {
    const current = await readFile(join(REPO_ROOT, path), 'utf8').catch(() => '');
    if (current !== content) problems.push(`${path} is stale: run npm run api:coverage-report`);
  }
  console.log('checked docs/api-coverage/ against the registered adapters');
}

// 8. Operations built from an older revision stay valid on every later revision their version
//    range includes: every difference is additive (ADR 0019 §7).
if (!write) {
  const revisions = await listSpecRevisions();
  const documents = new Map<string, object | undefined>();
  const documentOf = async (rev: SpecRevision): Promise<object | undefined> => {
    const id = `${rev.provenance.application}/${rev.provenance.revision}`;
    if (!documents.has(id)) {
      const text = await verifiedVendorText(rev, 'openapi.json');
      documents.set(id, text === undefined ? undefined : parseOpenApi(text));
    }
    return documents.get(id);
  };
  let compared = 0;
  const implementations = ADAPTERS.flatMap((adapter) => [
    ...adapter.operations,
    ...adapter.eventStreams.map((stream) => ({ ...stream, httpMethod: 'GET' as const })),
  ]);
  for (const descriptor of implementations) {
    const own = revisions.find(
      (r) =>
        r.provenance.application === descriptor.moduleId &&
        r.provenance.revision === descriptor.contractRevision,
    );
    const later = revisions.filter(
      (r) =>
        r.provenance.application === descriptor.moduleId &&
        r.provenance.revision !== descriptor.contractRevision &&
        r.provenance.contractKind === 'openapi' &&
        satisfies(r.provenance.revision, descriptor.apiVersionRange),
    );
    if (own === undefined || later.length === 0) continue;
    const older = await documentOf(own);
    for (const rev of later) {
      const newer = await documentOf(rev);
      if (older === undefined || newer === undefined) continue;
      compared++;
      for (const line of operationBreaks(
        older,
        newer,
        `${descriptor.httpMethod} ${descriptor.pathTemplate}`,
      )) {
        report(
          rev,
          `${descriptor.operationId} (built from ${descriptor.contractRevision}): ${line}`,
        );
      }
    }
  }
  console.log(`checked ${String(compared)} operations against later revisions they claim`);
}

// 6. Generated adapter schemas are current (ADR 0018).
for (const result of await generateAdapterSchemas(write)) {
  if (!result.upToDate && !write) {
    problems.push(`${result.output} is stale: run node scripts/generate-adapter-schemas.ts`);
  }
  console.log(
    `checked ${result.output}: ${result.upToDate ? 'up to date' : write ? 'rewritten' : 'STALE'}`,
  );
}

if (problems.length > 0) {
  console.error(`\nAPI coverage reconciliation found ${problems.length} unreviewed difference(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exitCode = 1;
} else {
  console.log('\nAPI coverage reconciliation: no unreviewed differences.');
}
