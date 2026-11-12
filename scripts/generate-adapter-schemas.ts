/**
 * Generates the zod schemas of each OpenAPI-sourced adapter from the local vendor cache
 * (ADR 0006 item 6, ADR 0018).
 *
 *   node scripts/generate-adapter-schemas.ts           write the generated modules
 *   node scripts/generate-adapter-schemas.ts --check   exit 1 if a module is stale
 *
 * Run `npm run api:fetch-specs` first. `npm run api:reconcile` runs the check as well.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import * as prettier from 'prettier';
import { REPO_ROOT, readJson, sha256, type Provenance } from './lib/api-specs.ts';
import { parseOpenApi } from './lib/openapi-inventory.ts';
import { generateZodModule } from './lib/openapi-zod.ts';

/** The adapter modules generated from OpenAPI contracts. */
export const GENERATED_MODULES = [
  {
    application: 'network',
    revision: '11.0.97',
    output: 'packages/unifi-network/src/generated/network-11.0.97.ts',
    targetParameters: ['siteId'],
    omittedParameters: {
      getDeviceTagPage: {
        filter:
          'documented as an object schema (FilterExpression), unlike the string filter of ' +
          'every other list operation; not sent until the contract is unambiguous (ADR 0018)',
      },
      deleteNetwork: {
        force:
          'undescribed in the contract; by its name it overrides a check of the console, ' +
          'and the references read cannot show what uses a network in use (Network ' +
          '11.0.99); a high-risk delete is offered without it (ADR 0018)',
      },
    },
  },
  {
    application: 'protect',
    revision: '7.3.74',
    output: 'packages/unifi-protect/src/generated/protect-7.3.74.ts',
    // The current official release; operations it documents are built from it (ADR 0019 §7).
    naming: 'path',
    targetParameters: [],
    omittedParameters: {},
    omittedOperations: {
      'POST /v1/files/{fileType}':
        'a multipart upload whose form field is not documented (the body is only a binary ' +
        'string); not implemented until the contract names it (ADR 0019)',
    },
    optionalResponseProperties: {
      nvrArmMode: {
        armProfileId:
          'documented as required (string or null), but a 7.3.74 console left it out of ' +
          'GET /v1/nvrs on 2026-11-12 (live read-only test); absent means not reported ' +
          '(ADR 0019 §8)',
      },
    },
  },
  {
    application: 'protect',
    revision: '7.4.96',
    output: 'packages/unifi-protect/src/generated/protect-7.4.96.ts',
    // No vendor operationIds: names come from method and path.
    naming: 'path',
    targetParameters: [],
    omittedParameters: {},
    omittedOperations: {
      'POST /v1/files/{fileType}':
        'a multipart upload whose form field is not documented (the body is only a binary ' +
        'string); not implemented until the contract names it (ADR 0019)',
    },
  },
] as const;

export interface GenerationResult {
  output: string;
  upToDate: boolean;
}

async function render(module: (typeof GENERATED_MODULES)[number]): Promise<string> {
  const specDir = join(REPO_ROOT, 'api-specs', module.application, module.revision);
  const provenance = await readJson<Provenance>(join(specDir, 'provenance.json'));
  const artifact = provenance.artifacts.find((a) => a.role === 'contract');
  if (artifact === undefined) throw new Error(`${specDir}: no contract artefact.`);
  const vendorFile = join(specDir, 'vendor', artifact.name);
  const text = await readFile(vendorFile, 'utf8').catch(() => {
    throw new Error(`${relative(REPO_ROOT, vendorFile)} is missing: run npm run api:fetch-specs.`);
  });
  const digest = sha256(text);
  if (digest !== artifact.sha256) {
    throw new Error(`${relative(REPO_ROOT, vendorFile)} does not match provenance.json.`);
  }
  const source = generateZodModule(parseOpenApi(text), {
    source: relative(REPO_ROOT, vendorFile),
    sourceSha256: digest,
    generator: 'scripts/generate-adapter-schemas.ts',
    targetParameters: module.targetParameters,
    omittedParameters: module.omittedParameters,
    ...('naming' in module ? { naming: module.naming } : {}),
    ...('omittedOperations' in module ? { omittedOperations: module.omittedOperations } : {}),
    ...('optionalResponseProperties' in module
      ? { optionalResponseProperties: module.optionalResponseProperties }
      : {}),
  });
  const outputPath = join(REPO_ROOT, module.output);
  const config = (await prettier.resolveConfig(outputPath)) ?? {};
  return prettier.format(source, { ...config, filepath: outputPath });
}

export async function generateAdapterSchemas(write: boolean): Promise<GenerationResult[]> {
  const results: GenerationResult[] = [];
  for (const module of GENERATED_MODULES) {
    const expected = await render(module);
    const outputPath = join(REPO_ROOT, module.output);
    const current = await readFile(outputPath, 'utf8').catch(() => '');
    const upToDate = current === expected;
    if (write && !upToDate) await writeFile(outputPath, expected, 'utf8');
    results.push({ output: module.output, upToDate });
  }
  return results;
}

if (import.meta.main) {
  const check = process.argv.includes('--check');
  const results = await generateAdapterSchemas(!check);
  let stale = false;
  for (const result of results) {
    if (result.upToDate) {
      console.log(`${result.output}: up to date`);
    } else if (check) {
      stale = true;
      console.error(`${result.output}: STALE (run node scripts/generate-adapter-schemas.ts)`);
    } else {
      console.log(`${result.output}: written; review the diff`);
    }
  }
  if (stale) process.exitCode = 1;
}
