/**
 * The adapters' local endpoints and authentication must match the recorded vendor
 * provenance, and the runtime contract inventory must match operations.json
 * (ADR 0005, ADR 0012). Offline: uses only committed api-specs files.
 */
import { join } from 'node:path';
import { loadContractInventory, MODULE_ENDPOINTS, MODULE_IDS } from '@unifi-local-mcp/unifi-api';
import { describe, expect, it } from 'vitest';
import { listSpecRevisions, REPO_ROOT } from '../../scripts/lib/api-specs.ts';

describe('module endpoints', () => {
  it('match the local base URL and authentication in every provenance.json', async () => {
    const revisions = await listSpecRevisions();
    for (const moduleId of MODULE_IDS) {
      const endpoint = MODULE_ENDPOINTS[moduleId];
      const ofModule = revisions.filter((rev) => rev.provenance.application === moduleId);
      expect(ofModule.length, moduleId).toBeGreaterThan(0);
      for (const { provenance } of ofModule) {
        const url = new URL(
          provenance.localBaseUrlTemplate.replace('{consoleHost}', 'console.invalid'),
        );
        expect(url.protocol).toBe('https:');
        expect(url.pathname.replace(/\/$/, '')).toBe(endpoint.basePath);
        expect(Number(url.port === '' ? 443 : url.port)).toBe(endpoint.defaultPort);
        expect(provenance.authentication.header.toLowerCase()).toBe(
          endpoint.auth.header.toLowerCase(),
        );
        expect(provenance.authentication.scheme).toBe(
          endpoint.auth.scheme === 'bearer' ? 'bearer-token' : 'api-key-header',
        );
        for (const forbidden of provenance.forbiddenBaseUrlTemplates) {
          expect(forbidden).not.toContain(
            endpoint.basePath === ''
              ? '\u0000'
              : `:${String(endpoint.defaultPort)}${endpoint.basePath}`,
          );
        }
      }
    }
  });
});

describe('runtime contract inventory', () => {
  it('admits documented operations and nothing else', async () => {
    const inventory = await loadContractInventory(join(REPO_ROOT, 'api-specs'));
    expect(inventory('network', '11.0.97', 'GET', '/v1/sites')).toBe(true);
    expect(inventory('network', '11.0.97', 'GET', '/v1/info')).toBe(true);
    expect(inventory('access', '2026-03-23', 'GET', '/api/v1/developer/access_policies')).toBe(
      true,
    );
    expect(inventory('network', '11.0.97', 'DELETE', '/v1/sites')).toBe(false);
    expect(inventory('network', '11.0.97', 'GET', '/v1/sites/../admin')).toBe(false);
    expect(inventory('network', '9.0.0', 'GET', '/v1/sites')).toBe(false);
    expect(inventory('talk', '1.0', 'GET', '/v1/sites')).toBe(false);
  });
});
