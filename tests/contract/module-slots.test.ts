/**
 * Applications without an adapter are disabled slots (spec §4.1, ADR 0024): they have a
 * stated reason and nothing else. No endpoint, credential, contract, operation, event
 * stream or version probe may exist for one, and none can be registered. A slot that gains
 * any of these without leaving the slot list fails here. Offline.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { OperationRegistry } from '@unifi-local-mcp/core';
import { ADAPTER_PROBES, ADAPTERS } from '@unifi-local-mcp/mcp-server';
import {
  isModuleId,
  loadContractInventory,
  MODULE_ENDPOINTS,
  MODULE_IDS,
  MODULE_SLOTS,
  moduleSlot,
  slotStatus,
} from '@unifi-local-mcp/unifi-api';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../scripts/lib/api-specs.ts';

const API_SPECS = join(REPO_ROOT, 'api-specs');

async function* sources(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (entry.name.endsWith('.ts')) yield path;
  }
}

describe('module slots (ADR 0024)', () => {
  it('are well formed and distinct from the modules', () => {
    const ids = MODULE_SLOTS.map((slot) => slot.moduleId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const slot of MODULE_SLOTS) {
      expect(slot.moduleId).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
      expect(isModuleId(slot.moduleId), slot.moduleId).toBe(false);
      expect(slot.title.trim()).not.toBe('');
      expect(moduleSlot(slot.moduleId)).toBe(slot);
    }
    for (const moduleId of MODULE_IDS) expect(moduleSlot(moduleId)).toBeUndefined();
    expect(moduleSlot('teleport')).toBeUndefined();
  });

  it('show the status the specification names for a missing contract', () => {
    expect(
      Object.fromEntries(MODULE_SLOTS.map((slot) => [slot.moduleId, slotStatus(slot)])),
    ).toEqual({
      talk: 'unavailable: official_local_api_not_documented',
      connect: 'unavailable: official_local_api_not_documented',
      drive: 'unavailable: official_local_api_not_documented',
      // A local API is published for it (ADR 0005), so "not documented" would be false.
      innerspace: 'unavailable: adapter_not_implemented',
    });
  });

  it('have no endpoint, credential, adapter, operation, event stream or version probe', () => {
    expect(Object.keys(MODULE_ENDPOINTS).sort()).toEqual([...MODULE_IDS].sort());
    for (const { moduleId } of MODULE_SLOTS) {
      expect(ADAPTERS.filter((adapter) => (adapter.moduleId as string) === moduleId)).toEqual([]);
      expect(ADAPTER_PROBES.filter((probe) => (probe.moduleId as string) === moduleId)).toEqual([]);
      for (const adapter of ADAPTERS) {
        expect(adapter.operations.filter((d) => d.moduleId === moduleId)).toEqual([]);
        expect(adapter.eventStreams.filter((s) => s.moduleId === moduleId)).toEqual([]);
        for (const descriptor of adapter.operations) {
          expect(descriptor.operationId.startsWith(`${moduleId}.`)).toBe(false);
          expect(descriptor.permission.startsWith(`${moduleId}.`)).toBe(false);
        }
      }
    }
  });

  it('have no contract: every api-specs application is an implemented module', async () => {
    const applications = (await readdir(API_SPECS, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(applications.sort()).toEqual([...MODULE_IDS].sort());
  });

  it('cannot register an operation, whatever its path', async () => {
    const inventory = await loadContractInventory(API_SPECS);
    const documented = ADAPTERS.flatMap((adapter) => adapter.operations).find(
      (descriptor) => descriptor.operationId === 'network.info.get',
    );
    if (documented === undefined) throw new Error('network.info.get is not registered');
    for (const { moduleId } of MODULE_SLOTS) {
      const registry = new OperationRegistry(inventory);
      expect(() => {
        registry.register({
          ...documented,
          moduleId,
          operationId: `${moduleId}.info.get`,
          permission: `${moduleId}.info.read`,
        });
      }).toThrow(new RegExp(`not in the official ${moduleId} `));
      expect(registry.list()).toEqual([]);
    }
  });

  it('no package source names a console path other than the two documented proxies', async () => {
    // Network and Protect are the only applications served under /proxy/ (ADR 0005); a
    // path such as /proxy/<slot>/… in an adapter would be an undocumented endpoint.
    const offenders: string[] = [];
    for await (const path of sources(join(REPO_ROOT, 'packages'))) {
      const text = await readFile(path, 'utf8');
      for (const match of text.matchAll(/\/proxy\/([A-Za-z0-9_-]+)/g)) {
        if (match[1] !== 'network' && match[1] !== 'protect') {
          offenders.push(`${relative(REPO_ROOT, path)}: ${match[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
