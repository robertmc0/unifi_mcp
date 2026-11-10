/**
 * Writes the API coverage matrix (spec §4.5): docs/api-coverage/api-coverage.json and one
 * Markdown page per module revision. See scripts/lib/coverage-report.ts for what it
 * contains. `npm run api:reconcile` fails when the committed files are stale.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { REPO_ROOT } from './lib/api-specs.ts';
import { buildCoverageFiles } from './lib/coverage-report.ts';

for (const [path, content] of await buildCoverageFiles()) {
  await mkdir(dirname(join(REPO_ROOT, path)), { recursive: true });
  await writeFile(join(REPO_ROOT, path), content, 'utf8');
  console.log(`wrote ${path}`);
}
