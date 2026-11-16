/**
 * Writes the software bill of materials of what the image installs (spec §14; ADR 0029):
 * the production dependencies of the workspace, from the lockfile, in CycloneDX and SPDX,
 * with npm's own `npm sbom`. Output goes to `release/` (not committed).
 *
 *   node scripts/generate-sbom.ts
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/api-specs.ts';

const out = join(REPO_ROOT, 'release');
mkdirSync(out, { recursive: true });
for (const [format, file] of [
  ['cyclonedx', 'sbom.cdx.json'],
  ['spdx', 'sbom.spdx.json'],
] as const) {
  const text = execFileSync(
    'npm',
    ['sbom', '--omit', 'dev', '--sbom-format', format, '--package-lock-only'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  const document = JSON.parse(text) as { components?: unknown[]; packages?: unknown[] };
  writeFileSync(join(out, file), text);
  const count = (document.components ?? document.packages ?? []).length;
  const sha256 = createHash('sha256').update(text).digest('hex');
  console.log(`wrote release/${file}: ${String(count)} entries, sha256 ${sha256}`);
}
