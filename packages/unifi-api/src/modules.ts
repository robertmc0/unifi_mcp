/**
 * Local endpoints and authentication per application module, from the recorded vendor
 * provenance (`api-specs/<app>/<revision>/provenance.json`, ADR 0005). Only the *local*
 * base is ever used; the cloud connector is not representable here.
 * tests/contract/module-endpoints.test.ts checks this table against provenance.json.
 */
export const MODULE_IDS = ['network', 'protect', 'access'] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

export interface ModuleEndpoint {
  /** Path prefix on the console, from the provenance `localBaseUrlTemplate`. */
  basePath: string;
  defaultPort: number;
  auth: { header: string; scheme: 'raw' | 'bearer' };
  /** Secret record kind of the module's credential. */
  credentialKind: string;
}

export const MODULE_ENDPOINTS: Readonly<Record<ModuleId, ModuleEndpoint>> = {
  network: {
    basePath: '/proxy/network/integration',
    defaultPort: 443,
    auth: { header: 'X-API-KEY', scheme: 'raw' },
    credentialKind: 'console.network_api_key',
  },
  protect: {
    basePath: '/proxy/protect/integration',
    defaultPort: 443,
    auth: { header: 'X-API-KEY', scheme: 'raw' },
    credentialKind: 'console.protect_api_key',
  },
  access: {
    basePath: '',
    defaultPort: 12445,
    auth: { header: 'Authorization', scheme: 'bearer' },
    credentialKind: 'console.access_api_token',
  },
};

export function isModuleId(value: string): value is ModuleId {
  return (MODULE_IDS as readonly string[]).includes(value);
}
