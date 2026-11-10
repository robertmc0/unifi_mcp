/**
 * Loads the official operation inventories (`api-specs/<app>/<revision>/operations.json`,
 * ADR 0005/0006) into the registry's ContractInventory, so that only documented
 * method/path pairs can ever be registered (AGENTS.md "UniFi API rules").
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContractInventory, HttpMethod } from '@unifi-local-mcp/core';
import { isModuleId } from './modules.ts';

interface InventoryFile {
  application: string;
  revision: string;
  operations: { method: string; path: string }[];
}

function isInventoryFile(value: unknown): value is InventoryFile {
  const file = value as Partial<InventoryFile> | null;
  return (
    typeof file?.application === 'string' &&
    typeof file.revision === 'string' &&
    Array.isArray(file.operations) &&
    file.operations.every((op) => typeof op.method === 'string' && typeof op.path === 'string')
  );
}

export async function loadContractInventory(apiSpecsDir: string): Promise<ContractInventory> {
  const keys = new Set<string>();
  for (const application of await readdir(apiSpecsDir, { withFileTypes: true })) {
    if (!application.isDirectory() || !isModuleId(application.name)) continue;
    for (const revision of await readdir(join(apiSpecsDir, application.name), {
      withFileTypes: true,
    })) {
      if (!revision.isDirectory()) continue;
      const path = join(apiSpecsDir, application.name, revision.name, 'operations.json');
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (
        !isInventoryFile(parsed) ||
        parsed.application !== application.name ||
        parsed.revision !== revision.name
      ) {
        throw new Error(`${path} is not a valid operation inventory for its directory.`);
      }
      for (const operation of parsed.operations) {
        keys.add(`${application.name} ${revision.name} ${operation.method} ${operation.path}`);
      }
    }
  }
  if (keys.size === 0) throw new Error(`No operation inventories found under ${apiSpecsDir}.`);
  return (moduleId: string, revision: string, method: HttpMethod, pathTemplate: string) =>
    keys.has(`${moduleId} ${revision} ${method} ${pathTemplate}`);
}
