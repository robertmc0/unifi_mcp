/**
 * Spec §18: the manual must match the interface. Beside the CLI commands
 * (doc-commands.test.ts) and the links (doc-links.test.ts), this checks the two other
 * names an operator or a client types: environment variables and MCP tools.
 *
 * - Every variable the service, the CLI or the stdio bridge reads is documented, and every
 *   `UNIFI_MCP_*` name in the manual, the examples, the Dockerfile and the Compose files is
 *   one the code reads, or a Compose variable of a shipped Compose file.
 * - Every tool named in the manual exists, and the client guide lists every tool.
 *
 * The phase checklist is a history, not the manual, and is not checked.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADAPTER_OPERATIONS } from '@unifi-local-mcp/mcp-server';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name).slice(ROOT.length + 1));
}

const NAME = /(?<![A-Z0-9_])UNIFI_MCP_[A-Z0-9_]+/g;
/** `tlsFiles(env, 'UNIFI_MCP_ADMIN')` reads `UNIFI_MCP_ADMIN_TLS_CERT_FILE` and `…_KEY_FILE`. */
const TLS_PREFIX = /tlsFiles\(env, '(UNIFI_MCP_[A-Z0-9_]+)'\)/g;

function variablesRead(files: string[]): Set<string> {
  const names = new Set<string>();
  for (const file of files) {
    let text = read(file);
    for (const [, prefix = ''] of text.matchAll(TLS_PREFIX)) {
      names.add(`${prefix}_TLS_CERT_FILE`);
      names.add(`${prefix}_TLS_KEY_FILE`);
    }
    text = text.replace(TLS_PREFIX, '');
    for (const [name] of text.matchAll(NAME)) if (!name.endsWith('_')) names.add(name);
  }
  return names;
}

const packages = readdirSync(join(ROOT, 'packages'));
const BRIDGE_VARIABLES = variablesRead(sources('packages/stdio-bridge/src'));
const SERVICE_VARIABLES = variablesRead(
  packages
    .filter((name) => name !== 'stdio-bridge')
    .flatMap((name) => sources(`packages/${name}/src`)),
);
const READ = new Set([...BRIDGE_VARIABLES, ...SERVICE_VARIABLES]);

const MANUAL = [
  'README.md',
  ...readdirSync(join(ROOT, 'docs'))
    .filter((name) => name.endsWith('.md') && name !== 'phase-checklist.md')
    .map((name) => `docs/${name}`),
];
const DEPLOY = readdirSync(join(ROOT, 'deploy'), { withFileTypes: true, recursive: true })
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name).slice(ROOT.length + 1));
const COMPOSE_FILES = DEPLOY.filter((path) => /^deploy\/compose\.[a-z]+\.ya?ml$/.test(path));
/** Variables a shipped Compose file substitutes (`${NAME}`), set by the operator. */
const COMPOSE_VARIABLES = new Set(
  COMPOSE_FILES.flatMap((path) =>
    [...read(path).matchAll(/\$\{(UNIFI_MCP_[A-Z0-9_]+)/g)].map((m) => m[1] ?? ''),
  ),
);
/** Names the operator chooses on the client's machine, not read by this project's code. */
const CLIENT_SIDE: Record<string, string> = {
  // Claude Code expands `${UNIFI_MCP_CLIENT_TOKEN}` in a header (client-claude-code.md).
  UNIFI_MCP_CLIENT_TOKEN: 'docs/client-claude-code.md',
};

describe('environment variables', () => {
  it('are found on both sides', () => {
    expect(SERVICE_VARIABLES.size).toBeGreaterThan(40);
    expect([...BRIDGE_VARIABLES].sort()).toEqual([
      'UNIFI_MCP_BRIDGE_LOG_LEVEL',
      'UNIFI_MCP_TOKEN',
      'UNIFI_MCP_TOKEN_FILE',
      'UNIFI_MCP_URL',
    ]);
    expect(COMPOSE_VARIABLES.size).toBeGreaterThan(5);
  });

  it('read by the service or the CLI are all in configuration.md', () => {
    const page = read('docs/configuration.md');
    const missing = [...SERVICE_VARIABLES].filter(
      (name) => !new RegExp(`\\b${name}\\b`).test(page),
    );
    expect(missing).toEqual([]);
  });

  it('read by the stdio bridge are all in client-generic-mcp.md', () => {
    const page = read('docs/client-generic-mcp.md');
    const missing = [...BRIDGE_VARIABLES].filter((name) => !new RegExp(`\\b${name}\\b`).test(page));
    expect(missing).toEqual([]);
  });

  for (const path of [...MANUAL, ...DEPLOY, '.env.example', 'Dockerfile']) {
    it(`named in ${path} are read by the code or set for a Compose file`, () => {
      const unknown = [...read(path).matchAll(NAME)]
        .map(([name]) => name)
        .filter((name) =>
          name.endsWith('_')
            ? ![...READ].some((known) => known.startsWith(name)) // a family, as `UNIFI_MCP_RATE_*`
            : !READ.has(name) && !COMPOSE_VARIABLES.has(name) && CLIENT_SIDE[name] !== path,
        );
      expect(unknown).toEqual([]);
    });
  }

  it('set in a Compose file’s environment are read by the service', () => {
    for (const path of COMPOSE_FILES) {
      for (const [, name = ''] of read(path).matchAll(/^\s+(UNIFI_MCP_[A-Z0-9_]+):/gm)) {
        expect(SERVICE_VARIABLES, `${path}: ${name}`).toContain(name);
      }
    }
  });
});

describe('MCP tools', () => {
  const FIXED = [
    ...read('packages/mcp-server/src/tools.ts').matchAll(/registerTool\(\s*'([a-z_]+)'/g),
  ].map((m) => m[1] ?? '');
  const NAMED = ADAPTER_OPERATIONS.flatMap((op) =>
    op.namedTool === undefined ? [] : [op.namedTool],
  );

  it('are found', () => {
    expect(FIXED).toContain('unifi_execute');
    expect(FIXED.length).toBeGreaterThanOrEqual(7);
    expect(NAMED.length).toBeGreaterThanOrEqual(10);
  });

  it('are all listed in the generic client guide', () => {
    const page = read('docs/client-generic-mcp.md');
    expect([...FIXED, ...NAMED].filter((tool) => !page.includes(`\`${tool}\``))).toEqual([]);
  });

  for (const path of MANUAL) {
    it(`named in ${path} exist`, () => {
      const text = read(path);
      const named = [
        ...text.matchAll(
          /`(unifi_(?!mcp_)[a-z_]+|(?:network|protect|access)_(?:list|get)_[a-z_]+)`/g,
        ),
      ].map((m) => m[1] ?? '');
      expect(named.filter((tool) => !FIXED.includes(tool) && !NAMED.includes(tool))).toEqual([]);
    });
  }
});
