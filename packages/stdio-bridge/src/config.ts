/**
 * stdio bridge configuration (spec §3.1, §7.1, §18 item 7; ADR 0014).
 *
 * The bridge needs exactly two things: the service's MCP URL and one client token. It never
 * receives, reads or forwards UniFi credentials, and it has no database or console access.
 */
import { open } from 'node:fs/promises';
import { isIP } from 'node:net';
import { LOG_LEVELS, type LogLevel } from '@unifi-local-mcp/telemetry/logger';

export const URL_ENV = 'UNIFI_MCP_URL';
export const TOKEN_FILE_ENV = 'UNIFI_MCP_TOKEN_FILE';
export const TOKEN_ENV = 'UNIFI_MCP_TOKEN';
export const LOG_LEVEL_ENV = 'UNIFI_MCP_BRIDGE_LOG_LEVEL';

const TOKEN = /^umcp_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/;
const MAX_TOKEN_FILE_BYTES = 1024;

export class BridgeConfigError extends Error {
  override readonly name = 'BridgeConfigError';
}

export interface BridgeConfig {
  url: URL;
  token: string;
  logLevel: LogLevel;
  warnings: string[];
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
}

export function parseServiceUrl(raw: string | undefined): URL {
  if (raw === undefined || raw.trim() === '') {
    throw new BridgeConfigError(`${URL_ENV} is required, for example http://127.0.0.1:3000/mcp.`);
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new BridgeConfigError(`${URL_ENV} is not a valid URL.`);
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '' || url.search !== '') {
    throw new BridgeConfigError(`${URL_ENV} must not contain credentials, a query or a fragment.`);
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new BridgeConfigError(
      `Refusing to send the client token over plaintext HTTP to ${url.hostname}. Use https:// ` +
        '(set NODE_EXTRA_CA_CERTS for a private CA) or a loopback address.',
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BridgeConfigError(`${URL_ENV} must be an http:// or https:// URL.`);
  }
  return url;
}

async function readTokenFile(path: string, warnings: string[]): Promise<string> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    throw new BridgeConfigError(
      `Cannot open ${TOKEN_FILE_ENV} (${(error as NodeJS.ErrnoException).code ?? 'error'}).`,
    );
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_TOKEN_FILE_BYTES) {
      throw new BridgeConfigError(`${TOKEN_FILE_ENV} must be a small regular file.`);
    }
    if ((stat.mode & 0o077) !== 0) {
      warnings.push(`The token file is readable by other users; restrict it to mode 0600.`);
    }
    return (await handle.readFile('utf8')).trim();
  } finally {
    await handle.close();
  }
}

/**
 * Reads the configuration. `UNIFI_MCP_TOKEN_FILE` is preferred; `UNIFI_MCP_TOKEN` is accepted
 * and then removed from `env`. Errors never contain the token.
 */
export async function loadBridgeConfig(env: NodeJS.ProcessEnv): Promise<BridgeConfig> {
  const warnings: string[] = [];
  const url = parseServiceUrl(env[URL_ENV]);
  const file = env[TOKEN_FILE_ENV]?.trim() ?? '';
  const inline = env[TOKEN_ENV] ?? '';
  Reflect.deleteProperty(env, TOKEN_ENV);
  if (file !== '' && inline !== '') {
    throw new BridgeConfigError(`Set only one of ${TOKEN_FILE_ENV} and ${TOKEN_ENV}.`);
  }
  if (file === '' && inline === '') {
    throw new BridgeConfigError(
      `A client token is required: set ${TOKEN_FILE_ENV} (preferred) or ${TOKEN_ENV}.`,
    );
  }
  const token = file === '' ? inline.trim() : await readTokenFile(file, warnings);
  if (!TOKEN.test(token)) {
    throw new BridgeConfigError('The client token is not in the umcp_<id>_<secret> format.');
  }
  const level = (env[LOG_LEVEL_ENV]?.trim().toLowerCase() ?? '') || 'warn';
  if (!(LOG_LEVELS as readonly string[]).includes(level)) {
    throw new BridgeConfigError(`${LOG_LEVEL_ENV} must be one of ${LOG_LEVELS.join(', ')}.`);
  }
  return { url, token, logLevel: level as LogLevel, warnings };
}
