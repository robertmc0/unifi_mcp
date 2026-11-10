/**
 * Service configuration from the environment (spec §8.1, §7.3, §8.3; ADR 0013).
 *
 * Everything here is a deployment setting read once at startup. Unknown or malformed
 * values stop the service rather than being guessed. Operational settings (policy,
 * consoles, clients) live in the database.
 */
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDeploymentOverrides, type DeploymentOverrides } from '@unifi-local-mcp/policy';
import { databasePathFor } from '@unifi-local-mcp/storage';
import {
  DEFAULT_AUDIT_RETENTION_DAYS,
  parseLogLevel,
  type LogLevel,
} from '@unifi-local-mcp/telemetry';
import { parseEgressPolicy, type EgressPolicy } from '@unifi-local-mcp/unifi-api';

export interface HttpConfig {
  bind: string;
  port: number;
  tls: { certFile: string; keyFile: string } | undefined;
  /** Accept plaintext HTTP on a non-loopback bind (behind a TLS proxy or host controls). */
  allowPlaintext: boolean;
  /** Host header names accepted on the MCP endpoint (DNS rebinding protection). */
  allowedHosts: string[];
  /** Origin host names accepted from browsers; requests without Origin are allowed. */
  allowedOrigins: string[];
}

/**
 * The admin web listener (spec §7.3, §13.1; ADR 0016). Separate bind, port, certificate
 * and authentication from the MCP listener; disabled unless UNIFI_MCP_ADMIN_ENABLED=true.
 */
export interface AdminListenerConfig {
  bind: string;
  port: number;
  tls: { certFile: string; keyFile: string } | undefined;
  allowPlaintext: boolean;
  /** Accepted Host header names (DNS-rebinding protection). */
  allowedHosts: string[];
  sessionIdleMinutes: number;
  sessionMaxHours: number;
}

export interface ServiceConfig {
  dataDir: string;
  databasePath: string;
  logLevel: LogLevel;
  deployment: DeploymentOverrides;
  egress: EgressPolicy;
  http: HttpConfig;
  /** Undefined when the admin interface is disabled (the default). */
  admin: AdminListenerConfig | undefined;
  auditRetentionDays: number;
  apiSpecsDir: string;
}

const LOCAL_NAMES = ['localhost', '127.0.0.1', '[::1]'];
const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off', '']);

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name]?.trim().toLowerCase() ?? '';
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  throw new ConfigError(`${name} must be "true" or "false".`);
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim() ?? '';
  if (raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer from ${String(min)} to ${String(max)}.`);
  }
  return value;
}

function hostList(env: NodeJS.ProcessEnv, name: string): string[] {
  const raw = env[name]?.trim() ?? '';
  if (raw === '') return [];
  return raw.split(',').map((entry) => {
    const host = entry.trim().toLowerCase();
    if (!/^(\[[0-9a-f:.]+\]|[a-z0-9.-]{1,253})$/.test(host)) {
      throw new ConfigError(`${name} entries must be host names or IP addresses without port.`);
    }
    return host;
  });
}

export function isLoopbackBind(bind: string): boolean {
  return bind === 'localhost' || bind === '::1' || (isIP(bind) === 4 && bind.startsWith('127.'));
}

/** The repository's api-specs directory, relative to this package (src/ or dist/). */
export function defaultApiSpecsDir(): string {
  return fileURLToPath(new URL('../../../api-specs', import.meta.url));
}

function tlsFiles(
  env: NodeJS.ProcessEnv,
  prefix: string,
): { certFile: string; keyFile: string } | undefined {
  const certFile = env[`${prefix}_TLS_CERT_FILE`]?.trim() ?? '';
  const keyFile = env[`${prefix}_TLS_KEY_FILE`]?.trim() ?? '';
  if ((certFile === '') !== (keyFile === '')) {
    throw new ConfigError(
      `Set both ${prefix}_TLS_CERT_FILE and ${prefix}_TLS_KEY_FILE, or neither.`,
    );
  }
  return certFile === '' ? undefined : { certFile, keyFile };
}

function loadAdminConfig(
  env: NodeJS.ProcessEnv,
  http: HttpConfig,
): AdminListenerConfig | undefined {
  if (!flag(env, 'UNIFI_MCP_ADMIN_ENABLED')) return undefined;
  const bind = env['UNIFI_MCP_ADMIN_BIND']?.trim() || '127.0.0.1';
  if (bind !== 'localhost' && isIP(bind) === 0) {
    throw new ConfigError('UNIFI_MCP_ADMIN_BIND must be an IP address (or localhost).');
  }
  const port = integer(env, 'UNIFI_MCP_ADMIN_PORT', 3001, 1, 65535);
  if (port === http.port) {
    throw new ConfigError(
      'UNIFI_MCP_ADMIN_PORT must differ from UNIFI_MCP_HTTP_PORT: the admin and MCP listeners are separate.',
    );
  }
  const tls = tlsFiles(env, 'UNIFI_MCP_ADMIN');
  const allowPlaintext = flag(env, 'UNIFI_MCP_ADMIN_ALLOW_PLAINTEXT');
  if (tls === undefined && !isLoopbackBind(bind) && !allowPlaintext) {
    throw new ConfigError(
      `Refusing to serve the admin interface over plaintext HTTP on ${bind}. Configure ` +
        'UNIFI_MCP_ADMIN_TLS_CERT_FILE and UNIFI_MCP_ADMIN_TLS_KEY_FILE, bind to a loopback ' +
        'address, or set UNIFI_MCP_ADMIN_ALLOW_PLAINTEXT=true when a TLS reverse proxy or a ' +
        'host-loopback port publication protects it (docs/networking.md).',
    );
  }
  return {
    bind,
    port,
    tls,
    allowPlaintext,
    allowedHosts: [...new Set([...LOCAL_NAMES, ...hostList(env, 'UNIFI_MCP_ADMIN_ALLOWED_HOSTS')])],
    sessionIdleMinutes: integer(env, 'UNIFI_MCP_ADMIN_SESSION_IDLE_MINUTES', 30, 5, 480),
    sessionMaxHours: integer(env, 'UNIFI_MCP_ADMIN_SESSION_MAX_HOURS', 12, 1, 72),
  };
}

export function loadServiceConfig(env: NodeJS.ProcessEnv): ServiceConfig {
  const dataDir = resolve(env['UNIFI_MCP_DATA_DIR']?.trim() || '/data');
  const bind = env['UNIFI_MCP_HTTP_BIND']?.trim() || '127.0.0.1';
  if (bind !== 'localhost' && isIP(bind) === 0) {
    throw new ConfigError('UNIFI_MCP_HTTP_BIND must be an IP address (or localhost).');
  }
  const certFile = env['UNIFI_MCP_HTTP_TLS_CERT_FILE']?.trim() ?? '';
  const keyFile = env['UNIFI_MCP_HTTP_TLS_KEY_FILE']?.trim() ?? '';
  if ((certFile === '') !== (keyFile === '')) {
    throw new ConfigError(
      'Set both UNIFI_MCP_HTTP_TLS_CERT_FILE and UNIFI_MCP_HTTP_TLS_KEY_FILE, or neither.',
    );
  }
  const tls = certFile === '' ? undefined : { certFile, keyFile };
  const allowPlaintext = flag(env, 'UNIFI_MCP_HTTP_ALLOW_PLAINTEXT');
  if (tls === undefined && !isLoopbackBind(bind) && !allowPlaintext) {
    throw new ConfigError(
      `Refusing to accept bearer tokens over plaintext HTTP on ${bind}. Configure ` +
        'UNIFI_MCP_HTTP_TLS_CERT_FILE and UNIFI_MCP_HTTP_TLS_KEY_FILE, bind to a loopback ' +
        'address, or set UNIFI_MCP_HTTP_ALLOW_PLAINTEXT=true when a TLS reverse proxy or ' +
        'host-level binding protects the listener (docs/networking.md).',
    );
  }
  const config: ServiceConfig = {
    dataDir,
    databasePath: databasePathFor(dataDir),
    logLevel: parseLogLevel(env['UNIFI_MCP_LOG_LEVEL']),
    deployment: parseDeploymentOverrides(env),
    egress: parseEgressPolicy(env),
    http: {
      bind,
      port: integer(env, 'UNIFI_MCP_HTTP_PORT', 3000, 1, 65535),
      tls,
      allowPlaintext,
      allowedHosts: [
        ...new Set([...LOCAL_NAMES, ...hostList(env, 'UNIFI_MCP_HTTP_ALLOWED_HOSTS')]),
      ],
      allowedOrigins: [
        ...new Set([...LOCAL_NAMES, ...hostList(env, 'UNIFI_MCP_HTTP_ALLOWED_ORIGINS')]),
      ],
    },
    admin: undefined,
    auditRetentionDays: integer(
      env,
      'UNIFI_MCP_AUDIT_RETENTION_DAYS',
      DEFAULT_AUDIT_RETENTION_DAYS,
      1,
      3650,
    ),
    apiSpecsDir: env['UNIFI_MCP_API_SPECS_DIR']?.trim() || defaultApiSpecsDir(),
  };
  config.admin = loadAdminConfig(env, config.http);
  return config;
}
