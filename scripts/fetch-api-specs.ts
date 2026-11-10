/**
 * Downloads the vendor artefacts listed in every api-specs/<app>/<revision>/provenance.json
 * into the uncommitted vendor/ cache and verifies each SHA-256 (ADR 0006).
 *
 *   node scripts/fetch-api-specs.ts            fetch missing artefacts, verify all
 *   node scripts/fetch-api-specs.ts --verify   verify cached artefacts only (offline)
 *
 * This is a developer tool and the only script that needs internet access. The running
 * service never fetches vendor documentation. A checksum mismatch means the vendor
 * changed a published artefact: the download is kept as <name>.mismatch for review, and
 * the script exits non-zero. Never "fix" a mismatch by editing the recorded checksum
 * without reviewing the change (see docs/api-coverage/README.md).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { listSpecRevisions, sha256, vendorPath } from './lib/api-specs.ts';

const verifyOnly = process.argv.includes('--verify');
const ALLOWED_HOSTS = new Set(['developer.ui.com', 'assets.identity.ui.com']);

async function readIfExists(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function download(url: string): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`Refusing to fetch from non-allowlisted origin: ${parsed.origin}`);
  }
  const response = await fetch(parsed, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

let failures = 0;
for (const rev of await listSpecRevisions()) {
  const { application, revision } = rev.provenance;
  for (const artifact of rev.provenance.artifacts) {
    const target = vendorPath(rev, artifact.name);
    const label = `${application}/${revision}/${artifact.name}`;
    let data = await readIfExists(target);
    if (data === undefined) {
      if (verifyOnly) {
        console.log(`MISSING  ${label} (run without --verify to download)`);
        failures++;
        continue;
      }
      data = await download(artifact.url);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
      console.log(`FETCHED  ${label} (${data.length} bytes)`);
    }
    const actual = sha256(data);
    if (actual === artifact.sha256 && data.length === artifact.bytes) {
      console.log(`OK       ${label} sha256=${actual}`);
    } else {
      failures++;
      await rename(target, `${target}.mismatch`);
      console.log(
        `MISMATCH ${label}: expected sha256=${artifact.sha256} bytes=${artifact.bytes}, ` +
          `got sha256=${actual} bytes=${data.length}. Moved to vendor/${artifact.name}.mismatch for review.`,
      );
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} artefact(s) missing or changed.`);
  process.exitCode = 1;
}
