/**
 * The CLI working beside a running service (ADR 0015): changes made in another process
 * apply immediately, and a revocation also closes the client's open responses, which the
 * service's in-process revocation listener never sees.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { COMMANDS, runCli, type CliIo } from '@unifi-local-mcp/cli';
import { describe, expect, it } from 'vitest';
import { RULE } from '../unit/core/fixtures.ts';
import { testKeyText, useTempDirs } from '../unit/storage/fixtures.ts';
import { connect, startTestService, structured } from './fixtures.ts';

const tempDir = useTempDirs();

async function cli(
  dir: string,
  argv: string[],
  answers?: string[],
): Promise<{ code: number; err: string }> {
  const keyFile = join(dir, 'service.key');
  await writeFile(keyFile, `${testKeyText('service')}\n`, { mode: 0o600 });
  const err: string[] = [];
  const queue = [...(answers ?? [])];
  const io: CliIo = {
    out: () => undefined,
    err: (line) => err.push(line),
    interactive: answers !== undefined,
    prompt: () => Promise.resolve(queue.shift() ?? ''),
    promptSecret: () => Promise.resolve(queue.shift() ?? ''),
  };
  const code = await runCli(COMMANDS, argv, io, {
    UNIFI_MCP_DATA_DIR: join(dir, 'data'),
    UNIFI_MCP_MASTER_KEY_FILE: keyFile,
  });
  return { code, err: err.join('\n') };
}

describe('CLI beside the service', () => {
  it('approves a high-risk MCP request from the host, which the client then resumes once', async () => {
    const dir = await tempDir();
    const t = await startTestService({ dir });
    const writer = await connect(t.mcpUrl, t.token('writer', ['network.*.*']));
    const proposed = structured(
      await writer.callTool({
        name: 'unifi_execute',
        arguments: {
          operationId: 'network.firewall.update_rule',
          consoleId: t.consoleId,
          siteId: 'site-1',
          arguments: { ruleId: RULE, action: 'block' },
        },
      }),
    );
    expect(proposed['status']).toBe('approval_required');
    const approvalId = String(proposed['approvalId']);
    // Not without a terminal, not with the wrong confirmation.
    expect((await cli(dir, ['approvals', 'approve', approvalId])).code).toBe(1);
    expect((await cli(dir, ['approvals', 'approve', approvalId], ['yes'])).code).toBe(1);
    expect(t.mock.requests.filter((r) => r.method !== 'GET')).toEqual([]);
    expect(
      await cli(dir, ['approvals', 'approve', approvalId], [approvalId.slice(0, 8)]),
    ).toMatchObject({ code: 0 });
    const resumed = structured(
      await writer.callTool({ name: 'unifi_resume_approved', arguments: { approvalId } }),
    );
    expect(resumed).toMatchObject({ status: 'ok', outcome: 'succeeded' });
    expect(t.mock.requests.filter((r) => r.method !== 'GET')).toHaveLength(1);
    expect(
      structured(
        await writer.callTool({ name: 'unifi_resume_approved', arguments: { approvalId } }),
      ),
    ).toMatchObject({ status: 'denied', error: { code: 'approval_already_used' } });
  });

  it('revoking with the CLI refuses new calls and closes open responses', async () => {
    const dir = await tempDir();
    const t = await startTestService({ dir, streamRecheckMs: 50 });
    const client = await connect(t.mcpUrl, t.token('reader', ['network.*.read']));
    expect((await client.callTool({ name: 'unifi_list_consoles', arguments: {} })).isError).toBe(
      false,
    );
    t.mock.respond = () => undefined; // the console never answers
    const inFlight = client
      .callTool({
        name: 'unifi_execute',
        arguments: { operationId: 'network.info.get', consoleId: t.consoleId },
      })
      .then(
        () => 'resolved',
        () => 'rejected',
      );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await cli(dir, ['client', 'revoke', 'reader'])).toMatchObject({ code: 0 });
    expect(await inFlight).toBe('rejected');
    await expect(client.callTool({ name: 'unifi_list_consoles', arguments: {} })).rejects.toThrow();
    expect(t.logs.some((line) => line.includes('whose token is no longer valid'))).toBe(true);
  });

  it('rotating with the CLI closes responses opened with the old token', async () => {
    const dir = await tempDir();
    const t = await startTestService({ dir, streamRecheckMs: 50 });
    const client = await connect(t.mcpUrl, t.token('reader', ['network.*.read']));
    t.mock.respond = () => undefined;
    const inFlight = client
      .callTool({
        name: 'unifi_execute',
        arguments: { operationId: 'network.info.get', consoleId: t.consoleId },
      })
      .then(
        () => 'resolved',
        () => 'rejected',
      );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await cli(dir, ['client', 'rotate', 'reader'])).toMatchObject({ code: 0 });
    expect(await inFlight).toBe('rejected');
  });

  it('disabling a client with the CLI closes its open responses', async () => {
    const dir = await tempDir();
    const t = await startTestService({ dir, streamRecheckMs: 50 });
    const client = await connect(t.mcpUrl, t.token('reader', ['network.*.read']));
    t.mock.respond = () => undefined;
    const inFlight = client
      .callTool({
        name: 'unifi_execute',
        arguments: { operationId: 'network.info.get', consoleId: t.consoleId },
      })
      .then(
        () => 'resolved',
        () => 'rejected',
      );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const policy = join(dir, 'disabled.yaml');
    await writeFile(policy, 'status: disabled\n');
    expect(await cli(dir, ['client', 'set-policy', 'reader', '--file', policy])).toMatchObject({
      code: 0,
    });
    expect(await inFlight).toBe('rejected');
  });

  it('refuses key rotation while the service runs', async () => {
    const dir = await tempDir();
    await startTestService({ dir });
    const next = join(dir, 'next.key');
    expect((await cli(dir, ['crypto', 'generate-key', '--out', next])).code).toBe(0);
    const rotate = await cli(dir, ['crypto', 'rotate-key', '--new-key-file', next, '--yes']);
    expect(rotate.code).toBe(1);
    expect(rotate.err).toContain('DATA_DIRECTORY_IN_USE');
  });
});
