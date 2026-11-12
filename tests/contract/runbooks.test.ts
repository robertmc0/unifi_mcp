/**
 * The manual write runbooks (`docs/runbook-*.md`) are run by hand against real consoles, so
 * a stale step is only found when someone follows it. Every operation they name must be
 * registered, every step's risk must be the reviewed one, and every `unifi-mcp` command
 * and option they show must exist.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMANDS } from '@unifi-local-mcp/cli';
import { NETWORK_OPERATIONS } from '@unifi-local-mcp/unifi-network';
import { PROTECT_OPERATIONS } from '@unifi-local-mcp/unifi-protect';
import { describe, expect, it } from 'vitest';

const DOCS = join(import.meta.dirname, '../../docs');
const OPERATIONS = new Map(
  [...NETWORK_OPERATIONS, ...PROTECT_OPERATIONS].map((d) => [d.operationId, d]),
);
const GLOBAL_OPTIONS = ['json', 'help'];

const runbooks = readdirSync(DOCS)
  .filter((name) => name.startsWith('runbook-') && name.endsWith('.md'))
  .map((name) => ({ name, text: readFileSync(join(DOCS, name), 'utf8') }));

describe('write runbooks', () => {
  it('exist for Network and Protect', () => {
    expect(runbooks.map((r) => r.name).sort()).toEqual([
      'runbook-network-writes.md',
      'runbook-protect-writes.md',
    ]);
  });

  for (const { name, text } of runbooks) {
    it(`${name} names only registered operations`, () => {
      const named = [...text.matchAll(/`((?:network|protect|access)\.[a-z_]+\.[a-z_]+)`/g)].map(
        (m) => m[1] ?? '',
      );
      expect(named.length).toBeGreaterThan(0);
      for (const id of named) expect(OPERATIONS.has(id), id).toBe(true);
    });

    it(`${name} gives each step its reviewed risk`, () => {
      const steps = [...text.matchAll(/^\|\s*\d+\s*\|\s*`([^`]+)`\s*\|\s*([a-z]+)\s*\|/gm)];
      expect(steps.length).toBeGreaterThan(0);
      for (const [, id = '', risk] of steps) {
        expect(OPERATIONS.get(id)?.risk, id).toBe(risk);
      }
    });

    it(`${name} shows only existing unifi-mcp commands and options`, () => {
      const joined = text.replace(/\\\n\s*/g, ' ');
      const calls = [...joined.matchAll(/unifi-mcp (?!unifi-mcp )([a-z-]+) ([a-z-]+)([^\n`]*)/g)];
      expect(calls.length).toBeGreaterThan(0);
      for (const [call, group = '', command = '', rest = ''] of calls) {
        const found = COMMANDS[group]?.[command];
        expect(found, call).toBeDefined();
        const options = [...GLOBAL_OPTIONS, ...Object.keys(found?.options ?? {})];
        for (const [, option = ''] of rest.matchAll(/--([a-z-]+)/g)) {
          expect(options, `${call}: --${option}`).toContain(option);
        }
      }
    });
  }
});
