/**
 * Policy model and validation (spec §6.1, §6.2, §6.3, §6.4; ADR 0009).
 *
 * Three policy fragments feed one decision:
 *
 * - **Global policy** (stored by `PolicyStore`): runtime mode, global allow/deny rules,
 *   global sensitivity denials, risk elevations, explicitly enabled default-disabled
 *   operations.
 * - **Console policy** (stored with each console, Phase 1 step 6): console state, enabled
 *   sites, console rules and per-module state and rules.
 * - **Client policy** (stored with each MCP client, Phase 1 step 7): status, expiry,
 *   permitted consoles and sites, granted scopes, denials and sensitive-data grants.
 *
 * Every schema is strict: unknown keys, malformed selectors and contradictory rules are
 * rejected rather than guessed at (spec §6.2).
 */
import * as z from 'zod';

export const EFFECTS = ['read', 'write'] as const;
export type Effect = (typeof EFFECTS)[number];

export const RISKS = ['low', 'medium', 'high'] as const;
export type Risk = (typeof RISKS)[number];

/** Spec §6.4. `credential` marks data that is never released to any client. */
export const SENSITIVITY_TAGS = [
  'personal_identifier',
  'network_identity',
  'camera_image',
  'recording',
  'access_log',
  'credential',
  'location',
  'biometric_or_access_identity',
] as const;
export type SensitivityTag = (typeof SENSITIVITY_TAGS)[number];
export const GRANTABLE_SENSITIVITY_TAGS = SENSITIVITY_TAGS.filter(
  (tag): tag is Exclude<SensitivityTag, 'credential'> => tag !== 'credential',
);

export const RUNTIME_MODES = ['read_only', 'read_write'] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

const NAME = /^[a-z][a-z0-9_]*$/;
/** Identifiers for consoles, sites and clients. */
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const OPERATION_ID = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

/**
 * A selector matches operations, either by permission pattern or by exact operation id:
 *
 * - `<module>.<category>.<effect>` with `*` allowed for any whole segment, for example
 *   `network.devices.read`, `network.*.read`, `*.firewall.*`.
 * - `operation:<operationId>`, for example `operation:access.doors.unlock`.
 */
export function isValidSelector(selector: string): boolean {
  if (selector.startsWith('operation:')) return OPERATION_ID.test(selector.slice(10));
  const segments = selector.split('.');
  if (segments.length !== 3) return false;
  const [module, category, effect] = segments as [string, string, string];
  return (
    (module === '*' || NAME.test(module)) &&
    (category === '*' || NAME.test(category)) &&
    (effect === '*' || (EFFECTS as readonly string[]).includes(effect))
  );
}

export function isValidPermission(permission: string): boolean {
  const segments = permission.split('.');
  return (
    segments.length === 3 &&
    NAME.test(segments[0] ?? '') &&
    NAME.test(segments[1] ?? '') &&
    (EFFECTS as readonly string[]).includes(segments[2] ?? '')
  );
}

const Selector = z.string().refine(isValidSelector, {
  message:
    'Selector must be "<module>.<category>.<read|write>" (segments may be "*") or ' +
    '"operation:<operationId>".',
});
const Selectors = z.array(Selector).max(500);
const Id = z.string().regex(ID, 'Invalid identifier.');
const GrantableTag = z.enum(GRANTABLE_SENSITIVITY_TAGS, {
  message: 'Unknown sensitivity tag, or "credential", which can never be granted.',
});
const AnyTag = z.enum(SENSITIVITY_TAGS);
const SiteSet = z.union([z.literal('*'), z.array(Id).min(1).max(1000)]);

/** Rejects a selector that appears in both lists of the same layer (ambiguous intent). */
function noContradiction(
  layer: { allow?: readonly string[] | undefined; deny?: readonly string[] | undefined },
  ctx: z.RefinementCtx,
): void {
  const denied = new Set(layer.deny ?? []);
  for (const selector of layer.allow ?? []) {
    if (denied.has(selector)) {
      ctx.addIssue({
        code: 'custom',
        message: `Selector "${selector}" is both allowed and denied in the same layer.`,
        path: ['allow'],
      });
    }
  }
}

export const GlobalPolicySchema = z
  .strictObject({
    runtimeMode: z.enum(RUNTIME_MODES).default('read_only'),
    /** When present, only matching operations pass the global layer. */
    allow: Selectors.optional(),
    deny: Selectors.default([]),
    denySensitive: z.array(AnyTag).default([]),
    /** Raise (never lower) the reviewed risk of matching operations. */
    riskElevations: z
      .array(z.strictObject({ selector: Selector, risk: z.enum(['medium', 'high']) }))
      .max(500)
      .default([]),
    /** Operations that are disabled by default (spec §6.3) and explicitly enabled here. */
    enabledOperations: z.array(z.string().regex(OPERATION_ID)).max(500).default([]),
  })
  .superRefine(noContradiction);
export type GlobalPolicy = z.output<typeof GlobalPolicySchema>;

export const MODULE_STATES = ['disabled', 'read_only', 'read_write'] as const;
export type ModuleState = (typeof MODULE_STATES)[number];
export const CONSOLE_STATES = ['disabled', 'read_only', 'enabled'] as const;
export type ConsoleState = (typeof CONSOLE_STATES)[number];

const ModulePolicySchema = z
  .strictObject({
    state: z.enum(MODULE_STATES).default('read_only'),
    allow: Selectors.optional(),
    deny: Selectors.default([]),
  })
  .superRefine(noContradiction);

export const ConsolePolicySchema = z
  .strictObject({
    consoleId: Id,
    state: z.enum(CONSOLE_STATES).default('enabled'),
    /** Sites operations may target on this console. */
    enabledSites: SiteSet.default('*'),
    allow: Selectors.optional(),
    deny: Selectors.default([]),
    denySensitive: z.array(AnyTag).default([]),
    /** Modules not listed here are disabled on this console. */
    modules: z.record(z.string().regex(NAME), ModulePolicySchema).default({}),
  })
  .superRefine(noContradiction);
export type ConsolePolicy = z.output<typeof ConsolePolicySchema>;

export const CLIENT_STATUSES = ['active', 'disabled', 'revoked'] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export const ClientPolicySchema = z
  .strictObject({
    clientId: Id,
    status: z.enum(CLIENT_STATUSES).default('active'),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    /** Consoles this client may use, each with the sites it may target. */
    consoles: z.record(Id, z.strictObject({ sites: SiteSet.default('*') })).default({}),
    /** Granted scopes. Nothing is granted by default, reads included. */
    allow: Selectors.default([]),
    deny: Selectors.default([]),
    /** Sensitive-data grants (spec §6.4). `credential` can never be granted. */
    sensitive: z.array(GrantableTag).default([]),
  })
  .superRefine(noContradiction);
export type ClientPolicy = z.output<typeof ClientPolicySchema>;

/** Security metadata of a registered operation, reviewed in code (spec §4.3). */
export interface OperationSecurity {
  operationId: string;
  moduleId: string;
  category: string;
  effect: Effect;
  /** `<moduleId>.<category>.<effect>`. */
  permission: string;
  risk: Risk;
  sensitivityTags: readonly SensitivityTag[];
  approvalRequired: boolean;
  /** True when the operation targets one site and needs a `siteId`. */
  siteScoped: boolean;
  /** Disabled unless the global policy lists it in `enabledOperations` (spec §6.3). */
  defaultDisabled?: boolean;
}

/**
 * Checks internal consistency of reviewed operation metadata. A violation is a
 * programming error in an adapter and throws.
 */
export function assertOperationSecurity(operation: OperationSecurity): void {
  const problems: string[] = [];
  if (!OPERATION_ID.test(operation.operationId)) problems.push('invalid operationId');
  if (!NAME.test(operation.moduleId)) problems.push('invalid moduleId');
  if (!NAME.test(operation.category)) problems.push('invalid category');
  if (operation.permission !== `${operation.moduleId}.${operation.category}.${operation.effect}`) {
    problems.push('permission must be "<moduleId>.<category>.<effect>"');
  }
  if (operation.risk === 'high' && !operation.approvalRequired) {
    problems.push('high-risk operations must require approval');
  }
  for (const tag of operation.sensitivityTags) {
    if (!(SENSITIVITY_TAGS as readonly string[]).includes(tag)) problems.push(`unknown tag ${tag}`);
  }
  if (problems.length > 0) {
    throw new TypeError(
      `Invalid security metadata for ${operation.operationId}: ${problems.join('; ')}.`,
    );
  }
}

/** Formats a Zod error as one line per problem, with the path. */
export function describeValidationError(error: z.ZodError): string {
  return error.issues
    .map(
      (issue) => `${issue.path.length === 0 ? '(root)' : issue.path.join('.')}: ${issue.message}`,
    )
    .join('\n');
}
