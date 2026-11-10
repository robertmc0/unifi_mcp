/**
 * Phase 1 gate for the stdio bridge (spec §16 Phase 1, §3.1, §12; ADR 0003, ADR 0014):
 *
 * - 2025-era and 2026-era MCP clients work over stdio through the bridge.
 * - stdout carries only protocol frames; logs go to stderr.
 * - A rejected token produces a JSON-RPC error and a non-zero exit; plaintext to a remote
 *   host is refused before any connection.
 * - Revocation through the bridge takes effect at once.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../scripts/lib/api-specs.ts';
import { useTempDirs } from '../unit/storage/fixtures.ts';
import { CLI, startTestService, structured } from './fixtures.ts';

const tempDir = useTempDirs();
const BRIDGE = join(REPO_ROOT, 'packages', 'stdio-bridge', 'src', 'main.ts');

const clients: Client[] = [];
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
});

function bridgeEnv(url: URL, token: string): Record<string, string> {
  return { PATH: process.env['PATH'] ?? '', UNIFI_MCP_URL: url.href, UNIFI_MCP_TOKEN: token };
}

async function viaBridge(url: URL, token: string, mode: 'legacy' | 'auto'): Promise<Client> {
  const client = new Client(
    { name: 'stdio-test', version: '0.0.0' },
    { versionNegotiation: { mode } },
  );
  clients.push(client);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [BRIDGE],
      env: bridgeEnv(url, token),
      stderr: 'pipe',
    }),
  );
  return client;
}

interface RawRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the bridge with raw stdin lines and returns everything it wrote. */
function runRaw(env: Record<string, string>, lines: string[], keepOpenMs = 1500): Promise<RawRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('exit', (code) => {
      resolve({ code, stdout, stderr });
    });
    for (const line of lines) child.stdin.write(`${line}\n`);
    setTimeout(() => child.stdin.end(), keepOpenMs);
  });
}

const LEGACY_HANDSHAKE = [
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'raw', version: '0' },
    },
  }),
  JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
];

function frames(stdout: string): unknown[] {
  return stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as unknown);
}

describe('stdio bridge', () => {
  for (const mode of ['legacy', 'auto'] as const) {
    it(`serves a ${mode === 'auto' ? '2026' : '2025'}-era client with the same tools as HTTP`, async () => {
      const t = await startTestService({ dir: await tempDir() });
      const client = await viaBridge(t.mcpUrl, t.token('reader', ['network.*.read']), mode);
      expect(client.getProtocolEra()).toBe(mode === 'auto' ? 'modern' : 'legacy');
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      expect(tools).toContain('network_list_devices');
      expect(tools).not.toContain('network_restart_device');
      const result = await client.callTool({
        name: 'network_list_devices',
        arguments: { consoleId: t.consoleId, siteId: 'site-1' },
      });
      expect(structured(result)).toMatchObject({
        status: 'ok',
        data: [{ id: 'dev-1', name: 'Office AP' }],
      });
      // Identity comes from the bridge's token, not from anything the client sent.
      expect(t.service.audit.list({ eventType: 'mcp.operation', limit: 1 })[0]?.actorId).toBe(
        'reader',
      );
    });
  }

  it('writes only JSON-RPC frames to stdout', async () => {
    const t = await startTestService({ dir: await tempDir() });
    const run = await runRaw(
      {
        ...bridgeEnv(t.mcpUrl, t.token('reader', ['network.*.read'])),
        UNIFI_MCP_BRIDGE_LOG_LEVEL: 'debug',
      },
      LEGACY_HANDSHAKE,
    );
    expect(run.code).toBe(0);
    const out = frames(run.stdout);
    expect(out.every((frame) => (frame as { jsonrpc?: unknown }).jsonrpc === '2.0')).toBe(true);
    expect(out.map((frame) => (frame as { id?: unknown }).id)).toEqual([1, 2]);
    expect(run.stderr).toContain('bridge ready'); // debug logging went to stderr
    expect(run.stdout + run.stderr).not.toMatch(/umcp_[0-9a-f]{12}_/);
  });

  it('answers with a JSON-RPC error and exits 1 when the token is rejected', async () => {
    const t = await startTestService({ dir: await tempDir() });
    const forged = `umcp_000000000000_${'A'.repeat(43)}`;
    const run = await runRaw(bridgeEnv(t.mcpUrl, forged), LEGACY_HANDSHAKE.slice(0, 1), 5000);
    expect(run.code).toBe(1);
    expect(frames(run.stdout)).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32002, message: 'The unifi-local-mcp service rejected the client token.' },
      },
    ]);
    expect(run.stderr).toContain('rejected the client token');
    expect(run.stderr).not.toContain('A'.repeat(43));
  });

  it('refuses plaintext to a remote host and malformed configuration before connecting', async () => {
    const token = `umcp_000000000000_${'A'.repeat(43)}`;
    for (const env of [
      { PATH: '', UNIFI_MCP_URL: 'http://192.0.2.10:3000/mcp', UNIFI_MCP_TOKEN: token },
      { PATH: '', UNIFI_MCP_URL: 'https://user:pw@192.0.2.10/mcp', UNIFI_MCP_TOKEN: token },
      { PATH: '', UNIFI_MCP_URL: 'http://127.0.0.1:1/mcp', UNIFI_MCP_TOKEN: 'not-a-token' },
      { PATH: '', UNIFI_MCP_URL: 'http://127.0.0.1:1/mcp' },
    ]) {
      const run = await runRaw(env, [], 200);
      expect(run.code, JSON.stringify(env.UNIFI_MCP_URL)).toBe(2);
      expect(run.stdout).toBe('');
      expect(run.stderr).not.toContain('A'.repeat(43));
    }
  });

  it('never follows a redirect with the token, not even within the same origin', async () => {
    const followed: string[] = [];
    const server = createServer((req, res) => {
      if (req.url === '/mcp') {
        res.writeHead(307, { location: '/elsewhere' });
      } else {
        followed.push(req.headers.authorization ?? 'no-authorization');
        res.writeHead(500);
      }
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const run = await runRaw(
        bridgeEnv(
          new URL(`http://127.0.0.1:${String(port)}/mcp`),
          `umcp_000000000000_${'A'.repeat(43)}`,
        ),
        LEGACY_HANDSHAKE.slice(0, 1),
      );
      expect(frames(run.stdout)).toEqual([
        {
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32001, message: 'The unifi-local-mcp service could not be reached.' },
        },
      ]);
      expect(followed).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('stops working as soon as the client is revoked', async () => {
    const t = await startTestService({ dir: await tempDir() });
    const client = await viaBridge(t.mcpUrl, t.token('reader', ['network.*.read']), 'auto');
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    t.service.clients.revoke('reader', CLI);
    await expect(client.callTool({ name: 'unifi_list_consoles', arguments: {} })).rejects.toThrow();
  });
});
