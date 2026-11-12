/**
 * Live UniFi tests are read-only, opt-in and never run in CI (AGENTS.md, spec §16 decision
 * 21, ADR 0018 §7). These checks keep it that way.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import defaultConfig from '../../vitest.config.ts';
import { mismatchSummary } from '@unifi-local-mcp/core';
import { okOutcome } from '../integration-live-readonly/shared.ts';

const ROOT = join(import.meta.dirname, '../..');
const read = (path: string) => readFile(join(ROOT, path), 'utf8');

describe('live tests', () => {
  it('are excluded from the default test run', () => {
    expect(defaultConfig.test?.exclude).toContain('tests/integration-live-readonly/**');
  });

  it('are not run by CI or by npm run check', async () => {
    const workflow = await read('.github/workflows/check.yml');
    expect(workflow).not.toMatch(/test:live|integration-live-readonly|vitest\.live/);
    const pkg = JSON.parse(await read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['check']).not.toMatch(/live/);
  });

  it('guard every request: only GETs of reads pass', async () => {
    const shared = await read('tests/integration-live-readonly/shared.ts');
    expect(shared).toContain(
      "call.descriptor.httpMethod !== 'GET' || call.descriptor.effect !== 'read'",
    );
    // The WebSocket probe sends one GET upgrade and reads only its status line.
    expect(shared).toContain('`GET ${connection.endpoint.basePath}${options.path} HTTP/1.1`');
    expect(shared.match(/socket\.write\(/g)).toHaveLength(1);
  });

  it.each([
    ['network', 'NETWORK_READS', /NETWORK_WRITES|NETWORK_OPERATIONS|ADAPTER_OPERATIONS/],
    ['protect', 'PROTECT_READS', /PROTECT_WRITES|PROTECT_OPERATIONS|ADAPTER_OPERATIONS/],
  ])(
    '%s: register only reads, use the guard, and keep the hard lock on',
    async (module, reads, writes) => {
      const source = await read(`tests/integration-live-readonly/${module}.test.ts`);
      expect(source).toContain(`for (const descriptor of ${reads}) registry.register(descriptor);`);
      expect(source).not.toMatch(writes);
      expect(source).toContain('new ReadOnlyGuard(new UnifiExecutor(');
      expect(source).not.toMatch(/new UnifiExecutor\((?!\{ consoles, egress, logger \}\)\))/);
      expect(source).toContain('deployment: { forceReadOnly: true }');
      expect(source).toContain(`allow: ['${module}.*.read']`);
    },
  );
});

describe('live report outcomes', () => {
  it('tell an empty list, which validates no item schema, from a read that returned data', () => {
    expect(okOutcome([])).toBe('ok (empty)');
    expect(okOutcome([{ id: 'x' }])).toBe('ok');
    expect(okOutcome({ id: 'x' })).toBe('ok');
    expect(okOutcome(null)).toBe('ok');
  });
});

describe('live report mismatch summaries', () => {
  const issues = (schema: z.ZodType, value: unknown) => {
    const result = schema.safeParse(value);
    if (result.success) throw new Error('expected a mismatch');
    return result.error.issues;
  };

  it('name the field and the kind of mismatch, with list positions removed', () => {
    const schema = z.object({ data: z.array(z.object({ state: z.string(), port: z.int() })) });
    expect(
      mismatchSummary(issues(schema, { data: [{ state: 'ok', port: 1 }, { port: 'x' }] })),
    ).toEqual([
      'data[].state: invalid_type (expected string, received undefined)',
      'data[].port: invalid_type (expected number, received string)',
    ]);
  });

  it('never repeat a received value or a key that is not a property name', () => {
    const secret = 'Office AP 192.0.2.7 aa:bb:cc:dd:ee:ff';
    const schema = z.object({
      name: z.literal('x'),
      kind: z.enum(['a', 'b']),
      size: z.string().max(3),
      byMac: z.record(z.string(), z.int()),
    });
    const lines = mismatchSummary(
      issues(schema, { name: secret, kind: secret, size: secret, byMac: { [secret]: secret } }),
    );
    expect(lines).toEqual([
      'name: invalid_value',
      'kind: invalid_value',
      'size: too_big',
      'byMac.?: invalid_type (expected number, received string)',
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/Office|192\.0\.2|aa:bb/);
  });

  it('follow the closest branch of a union, below the union', () => {
    const schema = z.object({
      data: z.array(
        z.union([
          z.object({ c: z.string(), d: z.string() }),
          z.object({ a: z.string(), b: z.string() }),
        ]),
      ),
    });
    expect(mismatchSummary(issues(schema, { data: [{ a: 1, b: 'y' }] }))).toEqual([
      'data[].a: invalid_type (expected string, received number)',
    ]);
  });

  it('follow the branch the discriminator selected, not a closer one it did not select', () => {
    const schema = z.union([
      z.object({ kind: z.literal('A'), a: z.string(), b: z.string() }),
      z.object({ kind: z.literal('B') }),
      z.object({ kind: z.string().refine((k) => k !== 'A' && k !== 'B', { abort: true }) }),
    ]);
    // Branch A misses two fields; the others fail only on `kind`, which did not select them.
    expect(mismatchSummary(issues(schema, { kind: 'A' }))).toEqual([
      'a: invalid_type (expected string, received undefined)',
      'b: invalid_type (expected string, received undefined)',
    ]);
  });

  it('mark the root and keep at most 20 lines', () => {
    expect(mismatchSummary(issues(z.object({}), 'x'))).toEqual([
      '(root): invalid_type (expected object, received string)',
    ]);
    const wide = z.object(
      Object.fromEntries([...Array(30).keys()].map((i) => [`f${String(i)}`, z.string()])),
    );
    expect(mismatchSummary(issues(wide, {}))).toHaveLength(20);
  });
});
