/**
 * stdio bridge configuration (ADR 0014): one URL, one client token, nothing else.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BridgeConfigError,
  loadBridgeConfig,
  parseServiceUrl,
} from '@unifi-local-mcp/stdio-bridge';
import { describe, expect, it } from 'vitest';
import { useTempDirs } from '../storage/fixtures.ts';

const tempDir = useTempDirs();
const TOKEN = `umcp_0123456789ab_${'A'.repeat(43)}`;
const URL_LOCAL = 'http://127.0.0.1:3000/mcp';

describe('parseServiceUrl', () => {
  it.each([
    'http://127.0.0.1:3000/mcp',
    'http://localhost/mcp',
    'http://[::1]:3000/mcp',
    'https://mcp.example.invalid/mcp',
  ])('accepts %s', (url) => {
    expect(parseServiceUrl(url).href).toBe(new URL(url).href);
  });

  it.each([
    [undefined, /required/],
    ['not a url', /valid URL/],
    ['http://192.0.2.10:3000/mcp', /plaintext HTTP/],
    ['https://user:pw@mcp.example.invalid/mcp', /credentials/],
    ['https://mcp.example.invalid/mcp?token=x', /query/],
    ['ftp://127.0.0.1/mcp', /http/],
  ])('rejects %j', (url, pattern) => {
    expect(() => parseServiceUrl(url)).toThrow(pattern);
  });
});

describe('loadBridgeConfig', () => {
  it('reads the token from the environment and removes it from there', async () => {
    const env: NodeJS.ProcessEnv = { UNIFI_MCP_URL: URL_LOCAL, UNIFI_MCP_TOKEN: TOKEN };
    const config = await loadBridgeConfig(env);
    expect(config.token).toBe(TOKEN);
    expect(config.logLevel).toBe('warn');
    expect(env).not.toHaveProperty('UNIFI_MCP_TOKEN');
  });

  it('prefers a token file and warns when other users can read it', async () => {
    const dir = await tempDir();
    const strict = join(dir, 'strict.token');
    await writeFile(strict, `${TOKEN}\n`, { mode: 0o600 });
    expect(
      await loadBridgeConfig({ UNIFI_MCP_URL: URL_LOCAL, UNIFI_MCP_TOKEN_FILE: strict }),
    ).toMatchObject({
      token: TOKEN,
      warnings: [],
    });
    const open = join(dir, 'open.token');
    await writeFile(open, TOKEN, { mode: 0o644 });
    expect(
      (await loadBridgeConfig({ UNIFI_MCP_URL: URL_LOCAL, UNIFI_MCP_TOKEN_FILE: open })).warnings,
    ).toHaveLength(1);
  });

  it('removes the environment token even when the configuration is rejected', async () => {
    const env: NodeJS.ProcessEnv = {
      UNIFI_MCP_URL: URL_LOCAL,
      UNIFI_MCP_TOKEN: TOKEN,
      UNIFI_MCP_TOKEN_FILE: '/x',
    };
    await expect(loadBridgeConfig(env)).rejects.toThrow(/only one/);
    expect(env).not.toHaveProperty('UNIFI_MCP_TOKEN');
  });

  it.each([
    [{ UNIFI_MCP_URL: URL_LOCAL }, /token is required/],
    [{ UNIFI_MCP_URL: URL_LOCAL, UNIFI_MCP_TOKEN: 'umcp_short' }, /format/],
    [{ UNIFI_MCP_URL: URL_LOCAL, UNIFI_MCP_TOKEN_FILE: '/nonexistent/token' }, /Cannot open/],
    [
      { UNIFI_MCP_URL: URL_LOCAL, UNIFI_MCP_TOKEN: TOKEN, UNIFI_MCP_BRIDGE_LOG_LEVEL: 'loud' },
      /LOG_LEVEL/,
    ],
  ])('rejects %j without echoing the token', async (env, pattern) => {
    let thrown: unknown;
    try {
      await loadBridgeConfig({ ...env });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BridgeConfigError);
    expect((thrown as Error).message).toMatch(pattern);
    expect((thrown as Error).message).not.toContain('A'.repeat(43));
  });
});
