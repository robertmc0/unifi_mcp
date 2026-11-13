/**
 * Local endpoints and authentication per application module, from the recorded vendor
 * provenance (`api-specs/<app>/<revision>/provenance.json`, ADR 0005). Only the *local*
 * base is ever used; the cloud connector is not representable here.
 * tests/contract/module-endpoints.test.ts checks this table against provenance.json.
 */
export const MODULE_IDS = ['network', 'protect', 'access'] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

/** How a documented error code reads, for the error a client sees. */
export type EnvelopeErrorClass = 'unauthorized' | 'not_found' | 'unavailable' | 'rejected';

/**
 * A JSON result envelope whose `code` says whether the call succeeded, whatever the HTTP
 * status (Access PDF §2.3, §2.4; ADR 0023 §1). A response without the documented code is
 * not a success.
 */
export interface ResultEnvelope {
  successCode: string;
  classify(code: string): EnvelopeErrorClass;
}

export interface ModuleEndpoint {
  /** Path prefix on the console, from the provenance `localBaseUrlTemplate`. */
  basePath: string;
  defaultPort: number;
  auth: { header: string; scheme: 'raw' | 'bearer' };
  /** Secret record kind of the module's credential. */
  credentialKind: string;
  envelope?: ResultEnvelope;
}

/** Access §2.4: codes that refuse the token or its permission scopes. */
const ACCESS_UNAUTHORIZED = new Set([
  'CODE_AUTH_FAILED',
  'CODE_ACCESS_TOKEN_INVALID',
  'CODE_UNAUTHORIZED',
]);

/** Access §2.3/§2.4 envelope: `{code, msg, data}`, success only with `SUCCESS`. */
export const ACCESS_ENVELOPE: ResultEnvelope = {
  successCode: 'SUCCESS',
  classify(code) {
    if (ACCESS_UNAUTHORIZED.has(code)) return 'unauthorized';
    if (code === 'CODE_SYSTEM_ERROR') return 'unavailable';
    if (/_NOT_(FOUND|EXISTS?)$/.test(code)) return 'not_found';
    return 'rejected';
  },
};

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
    envelope: ACCESS_ENVELOPE,
  },
};

export function isModuleId(value: string): value is ModuleId {
  return (MODULE_IDS as readonly string[]).includes(value);
}
