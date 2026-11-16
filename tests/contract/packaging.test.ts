/**
 * Safe defaults of the image and the Compose example (spec §11, §14; ADR 0017). These are
 * checked as text so that an edit cannot quietly weaken them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
const compose = parse(readFileSync(join(ROOT, 'deploy/compose.single.yml'), 'utf8')) as {
  services: Record<string, Record<string, unknown>>;
};
const service = compose.services['unifi-mcp'] ?? {};

describe('Dockerfile', () => {
  it('pins the base image by digest and runs unprivileged without package managers', () => {
    expect(dockerfile).toMatch(
      /^ARG NODE_IMAGE=node:26\.\d+\.\d+-[a-z]+-slim@sha256:[0-9a-f]{64}$/m,
    );
    expect(dockerfile).toMatch(/^USER 10001:10001$/m);
    expect(dockerfile).not.toMatch(/^USER (root|0)\b/m);
    expect(dockerfile).toContain('rm -rf /usr/local/lib/node_modules/npm');
    expect(dockerfile).toMatch(/npm ci --omit=dev --ignore-scripts/);
    expect(dockerfile).toMatch(
      /^HEALTHCHECK .*\n\s+CMD \["node", "\/app\/packages\/mcp-server\/src\/healthcheck\.ts"\]$/m,
    );
    expect(dockerfile).toMatch(/^STOPSIGNAL SIGTERM$/m);
  });

  it('keeps vendor artefacts, secrets and local data out of the build context', () => {
    const ignore = readFileSync(join(ROOT, '.dockerignore'), 'utf8').split('\n');
    for (const entry of [
      'api-specs/**/vendor/',
      'secrets/',
      '*.key',
      '*.pem',
      'data/',
      '*.db',
      '.env',
      'tests/',
    ]) {
      expect(ignore).toContain(entry);
    }
  });
});

describe('deploy/compose.single.yml', () => {
  it('runs read-only, without capabilities or privilege escalation, with the hard lock on', () => {
    expect(service['read_only']).toBe(true);
    expect(service['cap_drop']).toEqual(['ALL']);
    expect(service['security_opt']).toEqual(['no-new-privileges:true']);
    expect(service['init']).toBe(true);
    const environment = service['environment'] as Record<string, string>;
    expect(environment['UNIFI_MCP_FORCE_READ_ONLY']).toBe('true');
    expect(environment['UNIFI_MCP_ADMIN_ENABLED']).toBe('false');
    expect(environment['UNIFI_MCP_MASTER_KEY_FILE']).toMatch(/^\/run\/secrets\//);
    // Metrics are off, and their token is a secret file too, never a value (ADR 0025).
    expect(environment['UNIFI_MCP_METRICS_ENABLED']).toBe('false');
    expect(environment['UNIFI_MCP_METRICS_TOKEN_FILE']).toMatch(/^\/run\/secrets\//);
    // No secret value in the environment: only paths of secret files (`…_FILE`).
    expect(JSON.stringify(environment)).not.toMatch(
      /UNIFI_MCP_MASTER_KEY"|_API_KEY|PASSWORD|TOKEN(?!_FILE")/,
    );
  });

  it('publishes only the MCP port, and only on the host loopback', () => {
    const ports = service['ports'] as string[];
    expect(ports).toEqual(['127.0.0.1:${UNIFI_MCP_HTTP_HOST_PORT:-3000}:3000']);
    expect(service['network_mode']).toBeUndefined();
    expect(service['privileged']).toBeUndefined();
  });
});

describe('every Compose example', () => {
  const HARDENING = [
    'init',
    'user',
    'read_only',
    'tmpfs',
    'cap_drop',
    'security_opt',
    'pids_limit',
    'mem_limit',
    'logging',
  ];
  const load = (name: string) =>
    parse(readFileSync(join(ROOT, 'deploy', name), 'utf8')) as {
      services: Record<string, Record<string, unknown>>;
      networks?: Record<string, Record<string, unknown>>;
      secrets: Record<string, { file: string }>;
    };
  const examples = ['compose.single.yml', 'compose.tls.yml', 'compose.dual.yml'].map((name) => ({
    name,
    file: load(name),
  }));

  it('runs the service with the same hardening, the hard lock on and no host access', () => {
    for (const { name, file } of examples) {
      expect(Object.keys(file.services), name).toEqual(['unifi-mcp']);
      const other = file.services['unifi-mcp'] ?? {};
      for (const key of HARDENING) expect(other[key], `${name} ${key}`).toEqual(service[key]);
      const environment = other['environment'] as Record<string, string>;
      expect(environment['UNIFI_MCP_FORCE_READ_ONLY'], name).toBe('true');
      expect(environment['UNIFI_MCP_ADMIN_ENABLED'], name).toBe('false');
      expect(environment['UNIFI_MCP_MASTER_KEY_FILE'], name).toMatch(/^\/run\/secrets\//);
      expect(JSON.stringify(environment), name).not.toMatch(
        /UNIFI_MCP_MASTER_KEY"|_API_KEY|PASSWORD|TOKEN(?!_FILE")/,
      );
      for (const forbidden of ['network_mode', 'privileged', 'cap_add', 'devices', 'pid', 'ipc']) {
        expect(other[forbidden], `${name} ${forbidden}`).toBeUndefined();
      }
      expect(JSON.stringify(other['volumes']), name).not.toContain('docker.sock');
      for (const secret of Object.values(file.secrets)) {
        expect(secret.file, name).toMatch(/^\.\/secrets\//);
      }
    }
  });

  it('with built-in TLS, has no plaintext switch and publishes one port on a chosen address', () => {
    const tls = load('compose.tls.yml').services['unifi-mcp'] ?? {};
    const environment = tls['environment'] as Record<string, string>;
    expect(environment['UNIFI_MCP_HTTP_TLS_CERT_FILE']).toMatch(/^\/run\/secrets\//);
    expect(environment['UNIFI_MCP_HTTP_TLS_KEY_FILE']).toMatch(/^\/run\/secrets\//);
    expect(environment['UNIFI_MCP_HTTP_ALLOW_PLAINTEXT']).toBeUndefined();
    const ports = tls['ports'] as string[];
    expect(ports).toHaveLength(1);
    // A required variable for the address: it cannot default to every interface.
    expect(ports[0]).toMatch(
      /^\$\{UNIFI_MCP_PUBLISH_IP:\?[^}]+\}:\$\{UNIFI_MCP_HTTP_HOST_PORT:-3000\}:3000$/,
    );
  });

  it('on two networks, binds each listener to one side, never forwards and publishes nothing', () => {
    const file = load('compose.dual.yml');
    const dual = file.services['unifi-mcp'] ?? {};
    const environment = dual['environment'] as Record<string, string>;
    expect(dual['ports']).toBeUndefined();
    expect(dual['sysctls']).toEqual({ 'net.ipv4.ip_forward': '0' });
    // MCP on the client side, with TLS; admin and metrics on the management side.
    expect(environment['UNIFI_MCP_HTTP_BIND']).toMatch(/^\$\{UNIFI_MCP_CLIENT_IP:\?/);
    expect(environment['UNIFI_MCP_HTTP_TLS_CERT_FILE']).toMatch(/^\/run\/secrets\//);
    expect(environment['UNIFI_MCP_HTTP_ALLOW_PLAINTEXT']).toBeUndefined();
    expect(environment['UNIFI_MCP_ADMIN_BIND']).toMatch(/^\$\{UNIFI_MCP_MANAGEMENT_IP:\?/);
    expect(environment['UNIFI_MCP_METRICS_BIND']).toMatch(/^\$\{UNIFI_MCP_MANAGEMENT_IP:\?/);
    expect(environment['UNIFI_MCP_METRICS_ENABLED']).toBe('false');
    for (const [key, value] of Object.entries(environment)) {
      if (key.endsWith('_BIND')) expect(value, key).not.toMatch(/0\.0\.0\.0|::/);
    }
    // The consoles must be named: there is no default allowlist here.
    expect(environment['UNIFI_MCP_EGRESS_ALLOW_CIDRS']).toMatch(/^\$\{UNIFI_MCP_CONSOLE_CIDRS:\?/);
    expect(Object.keys(dual['networks'] as object).sort()).toEqual([
      'mcp_client_net',
      'unifi_management_net',
    ]);
    // The default route is on the management side; the client network has no gateway.
    const attached = dual['networks'] as Record<string, Record<string, unknown>>;
    expect(attached['unifi_management_net']?.['gw_priority']).toBe(1);
    expect(attached['mcp_client_net']?.['gw_priority']).toBeUndefined();
    const client = file.networks?.['mcp_client_net'] as { ipam: { config: object[] } };
    expect(client.ipam.config).toHaveLength(1);
    expect(client.ipam.config[0]).not.toHaveProperty('gateway');
  });

  it('has an example for every variable the two-network file requires', () => {
    const text = readFileSync(join(ROOT, 'deploy/compose.dual.yml'), 'utf8');
    const required = new Set([...text.matchAll(/\$\{([A-Z_]+):\?/g)].map((m) => m[1] ?? ''));
    const example = readFileSync(join(ROOT, 'deploy/dual.env.example'), 'utf8');
    const given = new Set([...example.matchAll(/^([A-Z_]+)=/gm)].map((m) => m[1] ?? ''));
    for (const name of required) expect(given.has(name), name).toBe(true);
    expect(required.size).toBeGreaterThan(5);
    // Only documentation addresses and names in the example.
    for (const address of example.match(/\b\d{1,3}(\.\d{1,3}){3}\b/g) ?? []) {
      expect(address).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\./);
    }
  });
});
