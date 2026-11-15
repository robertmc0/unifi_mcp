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
  /**
   * Where the application version comes from: a documented read (`probe`, ADR 0018 §3) or,
   * where none exists, an administrator's declaration (`declared`, ADR 0021 §5).
   */
  versionSource: 'probe' | 'declared';
}

/** How long a declared version counts before it must be declared again (ADR 0021 §5). */
export const DECLARATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
    versionSource: 'probe',
  },
  protect: {
    basePath: '/proxy/protect/integration',
    defaultPort: 443,
    auth: { header: 'X-API-KEY', scheme: 'raw' },
    credentialKind: 'console.protect_api_key',
    versionSource: 'probe',
  },
  access: {
    basePath: '',
    defaultPort: 12445,
    auth: { header: 'Authorization', scheme: 'bearer' },
    credentialKind: 'console.access_api_token',
    envelope: ACCESS_ENVELOPE,
    versionSource: 'declared',
  },
};

export function isModuleId(value: string): value is ModuleId {
  return (MODULE_IDS as readonly string[]).includes(value);
}

/**
 * Why an application has no adapter (spec §4.1, ADR 0024):
 * - `official_local_api_not_documented`: Ubiquiti publishes no official local API for it.
 * - `adapter_not_implemented`: an official local API is published, but this project has
 *   not reviewed it or built an adapter.
 */
export type ModuleSlotReason = 'official_local_api_not_documented' | 'adapter_not_implemented';

/**
 * An application without an adapter: a disabled plugin slot. It has no endpoint,
 * credential, operation or event stream and cannot be enabled on a console. It exists so
 * that asking for the application gets a stated reason instead of "unknown".
 */
export interface ModuleSlot {
  moduleId: string;
  title: string;
  reason: ModuleSlotReason;
}

/**
 * The slots (ADR 0024, evidence of 2026-11-15). Moving an application out of this list
 * means adding a verified contract under `api-specs/`, an ADR and a reviewed adapter;
 * tests/contract/module-slots.test.ts fails when a slot gains any of them by itself.
 */
export const MODULE_SLOTS: readonly ModuleSlot[] = [
  { moduleId: 'talk', title: 'UniFi Talk', reason: 'official_local_api_not_documented' },
  { moduleId: 'connect', title: 'UniFi Connect', reason: 'official_local_api_not_documented' },
  { moduleId: 'drive', title: 'UniFi Drive', reason: 'official_local_api_not_documented' },
  { moduleId: 'innerspace', title: 'InnerSpace', reason: 'adapter_not_implemented' },
];

export function moduleSlot(value: string): ModuleSlot | undefined {
  return MODULE_SLOTS.find((slot) => slot.moduleId === value);
}

/** The status shown for a slot, e.g. `unavailable: official_local_api_not_documented`. */
export function slotStatus(slot: ModuleSlot): string {
  return `unavailable: ${slot.reason}`;
}
