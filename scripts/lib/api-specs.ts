/**
 * Shared helpers for the API contract baseline tooling (ADR 0005, ADR 0006).
 *
 * Layout per application revision:
 *   api-specs/<application>/<revision>/provenance.json   committed: sources, checksums, auth, base URLs
 *   api-specs/<application>/<revision>/operations.json   committed: derived factual operation inventory
 *   api-specs/<application>/<revision>/vendor/           NOT committed: verbatim vendor artefacts (cache)
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const API_SPECS_DIR = join(REPO_ROOT, 'api-specs');
export const COVERAGE_DIR = join(REPO_ROOT, 'docs', 'api-coverage');

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export type ApplicationId = 'network' | 'protect' | 'access';

export interface ArtifactRecord {
  /** File name inside vendor/. */
  name: string;
  url: string;
  sha256: string;
  bytes: number;
  mediaType: string;
  /** contract = authoritative operation contract; index = endpoint listing; reference = supporting. */
  role: 'contract' | 'index' | 'reference';
}

export interface Provenance {
  application: ApplicationId;
  /** Directory name; the vendor version label, or the document date when the vendor gives none. */
  revision: string;
  vendorVersionLabel: string | null;
  contractKind: 'openapi' | 'pdf-manual';
  retrievedAt: string;
  localBaseUrlTemplate: string;
  /** Base URLs that appear in vendor material but must never be used by adapters. */
  forbiddenBaseUrlTemplates: string[];
  authentication: {
    scheme: 'api-key-header' | 'bearer-token';
    header: string;
    valueFormat: string;
    credentialCreation: string;
    sources: string[];
  };
  minimumApplicationVersion: string | null;
  artifacts: ArtifactRecord[];
  notes: string[];
  unverified: string[];
}

export interface InventoryOperation {
  /** Stable reconciliation key: "<METHOD> <pathTemplate>". */
  key: string;
  method: HttpMethod;
  /** Path template relative to the local base URL, using {param} placeholders. */
  path: string;
  /** Path exactly as written in the vendor source, when it differs from `path`. */
  documentedPath?: string;
  vendorOperationId: string | null;
  category: string;
  summary: string;
  documentationUrl: string | null;
  /** Vendor-defined permission key (Access API only). */
  vendorPermission?: string;
  transport: 'http' | 'websocket';
  /** Location in a non-machine-readable source (e.g. "PDF §7.9 p.138"). */
  sourceRef?: string;
}

export interface Inventory {
  application: ApplicationId;
  revision: string;
  derivedFrom: string;
  operationCount: number;
  operations: InventoryOperation[];
}

export interface SpecRevision {
  dir: string;
  provenance: Provenance;
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function vendorPath(rev: SpecRevision, artifactName: string): string {
  return join(rev.dir, 'vendor', artifactName);
}

/** Lists every api-specs/<application>/<revision>/provenance.json in a stable order. */
export async function listSpecRevisions(): Promise<SpecRevision[]> {
  const result: SpecRevision[] = [];
  const apps = (await readdir(API_SPECS_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const app of apps) {
    const revisions = (await readdir(join(API_SPECS_DIR, app), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const revision of revisions) {
      const dir = join(API_SPECS_DIR, app, revision);
      const provenance = await readJson<Provenance>(join(dir, 'provenance.json'));
      if (provenance.application !== app || provenance.revision !== revision) {
        throw new Error(`provenance.json in ${dir} does not match its directory`);
      }
      result.push({ dir, provenance });
    }
  }
  return result;
}

export function operationKey(method: HttpMethod, path: string): string {
  return `${method} ${path}`;
}

export function sortOperations(ops: InventoryOperation[]): InventoryOperation[] {
  return [...ops].sort((a, b) =>
    a.path === b.path
      ? HTTP_METHODS.indexOf(a.method) - HTTP_METHODS.indexOf(b.method)
      : a.path < b.path
        ? -1
        : 1,
  );
}
