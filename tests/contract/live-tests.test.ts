/**
 * Live UniFi tests are read-only, opt-in and never run in CI (AGENTS.md, spec §16 decision
 * 21, ADR 0018 §7). These checks keep it that way.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import defaultConfig from '../../vitest.config.ts';

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

  it('register only reads, refuse non-GET requests, and keep the hard lock on', async () => {
    const source = await read('tests/integration-live-readonly/network.test.ts');
    expect(source).toContain(
      'for (const descriptor of NETWORK_READS) registry.register(descriptor);',
    );
    expect(source).not.toMatch(/NETWORK_WRITES|NETWORK_OPERATIONS|ADAPTER_OPERATIONS/);
    expect(source).toContain(
      "call.descriptor.httpMethod !== 'GET' || call.descriptor.effect !== 'read'",
    );
    expect(source).toContain('deployment: { forceReadOnly: true }');
    expect(source).toContain("allow: ['network.*.read']");
  });
});
