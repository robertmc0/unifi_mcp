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
    expect(JSON.stringify(environment)).not.toMatch(
      /UNIFI_MCP_MASTER_KEY"|_API_KEY|PASSWORD|TOKEN/,
    );
  });

  it('publishes only the MCP port, and only on the host loopback', () => {
    const ports = service['ports'] as string[];
    expect(ports).toEqual(['127.0.0.1:${UNIFI_MCP_HTTP_HOST_PORT:-3000}:3000']);
    expect(service['network_mode']).toBeUndefined();
    expect(service['privileged']).toBeUndefined();
  });
});
