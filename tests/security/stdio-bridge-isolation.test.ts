/**
 * Phase 1 gate (spec §16, §3.1): the stdio bridge has no UniFi API key or database access.
 *
 * The bridge's complete module graph (its sources and every workspace module they reach,
 * following package exports) must not include storage, SQLite, the UniFi transport, the
 * dispatcher, policy or any adapter, and its code must not reference UniFi credentials or
 * the master key. External packages are limited to the MCP SDK.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../scripts/lib/api-specs.ts';

const IMPORT =
  /(?:^|[;\s])(?:import|export)\s(?:[^'"]*?\sfrom\s)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm;

function workspaceEntry(specifier: string): string {
  const [scope, name, ...rest] = specifier.split('/');
  const packageDir = join(REPO_ROOT, 'packages', name ?? '');
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    exports: Record<string, string>;
  };
  const subpath = rest.length === 0 ? '.' : `./${rest.join('/')}`;
  const target = manifest.exports[subpath];
  if (scope !== '@unifi-local-mcp' || target === undefined) {
    throw new Error(`Unresolvable workspace import ${specifier}`);
  }
  return resolve(packageDir, target);
}

function moduleGraph(entry: string): {
  files: Set<string>;
  external: Set<string>;
  workspace: Set<string>;
} {
  const files = new Set<string>();
  const external = new Set<string>();
  const workspace = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() ?? '';
    if (files.has(file)) continue;
    files.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT)) {
      const specifier = match[1] ?? match[2] ?? '';
      if (specifier.startsWith('.')) queue.push(resolve(dirname(file), specifier));
      else if (specifier.startsWith('@unifi-local-mcp/')) {
        workspace.add(specifier);
        queue.push(workspaceEntry(specifier));
      } else external.add(specifier);
    }
  }
  return { files, external, workspace };
}

const graph = moduleGraph(join(REPO_ROOT, 'packages', 'stdio-bridge', 'src', 'main.ts'));

describe('stdio bridge isolation', () => {
  it('reaches no storage, SQLite, UniFi transport, dispatcher, policy or adapter code', () => {
    expect([...graph.workspace].sort()).toEqual(['@unifi-local-mcp/telemetry/logger']);
    for (const forbidden of ['node:sqlite', 'node:dns', 'node:tls', 'node:https']) {
      expect(graph.external.has(forbidden), forbidden).toBe(false);
    }
    const externalPackages = [...graph.external].filter((s) => !s.startsWith('node:')).sort();
    expect(externalPackages).toEqual([
      '@modelcontextprotocol/client',
      '@modelcontextprotocol/server/stdio',
    ]);
    for (const file of graph.files) {
      expect(file, file).not.toMatch(
        /packages\/(storage|unifi-api|core|policy|approvals|mcp-server|unifi-)/,
      );
    }
  });

  it('never references UniFi credentials, the master key or the database', () => {
    // The bridge's own code; the shared redactor legitimately names such fields to hide them.
    const own = [...graph.files].filter((file) => file.includes('/packages/stdio-bridge/'));
    expect(own.length).toBeGreaterThanOrEqual(4);
    for (const file of own) {
      const source = readFileSync(file, 'utf8');
      for (const marker of [
        'UNIFI_MCP_MASTER_KEY',
        'X-API-KEY',
        'secret_records',
        'UNIFI_MCP_DATA_DIR',
        'api.ui.com',
      ]) {
        expect(source.includes(marker), `${file} mentions ${marker}`).toBe(false);
      }
    }
  });

  it('declares only the MCP SDK and the logger as dependencies', () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, 'packages', 'stdio-bridge', 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      '@modelcontextprotocol/client',
      '@modelcontextprotocol/server',
      '@unifi-local-mcp/telemetry',
    ]);
  });
});
