/**
 * The policy decision function (spec §6.1; ADR 0009).
 *
 * `evaluate()` is pure and deterministic: the same input always gives the same decision,
 * so the dispatcher can run it at enqueue, at dispatch and again after approval (stage 9)
 * without drift. It runs the stages in the order of spec §6.1 and returns the first
 * denial. Deny always wins; anything not explicitly permitted is denied.
 *
 * Nothing here reads tool arguments or request headers: the only inputs are the verified
 * client record, server-side policy and reviewed operation metadata. No flag supplied by an
 * MCP client can upgrade authority.
 */
import {
  assertOperationSecurity,
  type ClientPolicy,
  type ConsolePolicy,
  type GlobalPolicy,
  type OperationSecurity,
  type Risk,
  type SensitivityTag,
} from './model.ts';

export type DenyReason =
  | 'client_inactive'
  | 'client_expired'
  | 'target_required'
  | 'console_not_permitted'
  | 'site_required'
  | 'site_not_permitted'
  | 'hard_read_only'
  | 'runtime_read_only'
  | 'console_disabled'
  | 'console_read_only'
  | 'module_disabled'
  | 'module_read_only'
  | 'denied_by_global_policy'
  | 'denied_by_console_policy'
  | 'denied_by_module_policy'
  | 'denied_by_client_policy'
  | 'not_granted_to_client'
  | 'operation_unsupported'
  | 'version_unknown'
  | 'operation_disabled'
  | 'credential_exposure_forbidden'
  | 'sensitive_denied_by_policy'
  | 'sensitive_scope_missing';

/** Whether the target console's probed API version supports the operation (step 6). */
export type Capability = 'supported' | 'unsupported' | 'unknown';

export interface EvaluationInput {
  now: Date;
  /** Immutable deployment overrides (spec §8.1), read from the environment at start. */
  deployment: { forceReadOnly: boolean };
  /** The global policy and its current version (from `PolicyStore`). */
  policy: { version: number; document: GlobalPolicy };
  /** The verified client's policy. Never derived from request content. */
  client: ClientPolicy;
  /** The target console's policy; `undefined` when no such console is configured. */
  console: ConsolePolicy | undefined;
  operation: OperationSecurity;
  target: { consoleId: string | undefined; siteId?: string | undefined };
  capability: Capability;
  /**
   * `execute` checks everything. `discover` (tool and operation listings) skips only the
   * site check, because no site is chosen yet; every other stage still applies.
   */
  purpose: 'execute' | 'discover';
}

export interface Allowed {
  allowed: true;
  effectiveRisk: Risk;
  approvalRequired: boolean;
  policyVersion: number;
}

export interface Denied {
  allowed: false;
  reason: DenyReason;
  /** The spec §6.1 stage that denied (1–8). */
  stage: number;
  /** Safe to show to the requesting client: names no other client, console or secret. */
  message: string;
  policyVersion: number;
}

export type Decision = Allowed | Denied;

const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

const MESSAGES: Record<DenyReason, string> = {
  client_inactive: 'This client is disabled or revoked.',
  client_expired: 'This client token has expired.',
  target_required: 'A consoleId is required; no default console is assumed.',
  console_not_permitted: 'This client may not use the requested console.',
  site_required: 'A siteId is required for this operation; no default site is assumed.',
  site_not_permitted: 'This client may not use the requested site.',
  hard_read_only:
    'The deployment is locked read-only (UNIFI_MCP_FORCE_READ_ONLY); no write can run.',
  runtime_read_only: 'The service is in read-only mode.',
  console_disabled: 'The requested console is disabled.',
  console_read_only: 'The requested console is read-only.',
  module_disabled: 'This application module is not enabled on the requested console.',
  module_read_only: 'This application module is read-only on the requested console.',
  denied_by_global_policy: 'The operation is denied by the global policy.',
  denied_by_console_policy: 'The operation is denied by the console policy.',
  denied_by_module_policy: 'The operation is denied by the module policy for this console.',
  denied_by_client_policy: 'The operation is denied for this client.',
  not_granted_to_client: 'This client has not been granted this operation.',
  operation_unsupported: "The operation is not supported by this console's API version.",
  version_unknown:
    "This console's application version has not been determined yet, so no operation can " +
    'run. The service checks it automatically; try again shortly.',
  operation_disabled: 'The operation is disabled by default and has not been enabled.',
  credential_exposure_forbidden: 'Operations that expose credentials are never available.',
  sensitive_denied_by_policy: 'The data this operation returns is denied by policy.',
  sensitive_scope_missing: 'This client lacks a required sensitive-data grant.',
};

type ParsedSelector =
  | { kind: 'operation'; operationId: string }
  | { kind: 'permission'; module: string; category: string; effect: string };

const parsedSelectors = new Map<string, ParsedSelector>();

function parseSelector(selector: string): ParsedSelector {
  let parsed = parsedSelectors.get(selector);
  if (parsed === undefined) {
    if (selector.startsWith('operation:')) {
      parsed = { kind: 'operation', operationId: selector.slice(10) };
    } else {
      const [module = '', category = '', effect = ''] = selector.split('.');
      parsed = { kind: 'permission', module, category, effect };
    }
    if (parsedSelectors.size > 10_000) parsedSelectors.clear();
    parsedSelectors.set(selector, parsed);
  }
  return parsed;
}

export function selectorMatches(selector: string, operation: OperationSecurity): boolean {
  const parsed = parseSelector(selector);
  if (parsed.kind === 'operation') return parsed.operationId === operation.operationId;
  const [module, category, effect] = operation.permission.split('.');
  return (
    (parsed.module === '*' || parsed.module === module) &&
    (parsed.category === '*' || parsed.category === category) &&
    (parsed.effect === '*' || parsed.effect === effect)
  );
}

function anyMatch(selectors: readonly string[] | undefined, operation: OperationSecurity): boolean {
  return selectors?.some((selector) => selectorMatches(selector, operation)) ?? false;
}

/** A layer passes when nothing in `deny` matches and, if it has an allowlist, it matches. */
function layerPasses(
  layer: { allow?: readonly string[] | undefined; deny: readonly string[] },
  operation: OperationSecurity,
): boolean {
  if (anyMatch(layer.deny, operation)) return false;
  return layer.allow === undefined || anyMatch(layer.allow, operation);
}

function sitePermitted(sites: '*' | readonly string[], siteId: string): boolean {
  return sites === '*' || sites.includes(siteId);
}

export function evaluate(input: EvaluationInput): Decision {
  const { operation, client, policy } = input;
  assertOperationSecurity(operation);
  const deny = (reason: DenyReason, stage: number): Denied => ({
    allowed: false,
    reason,
    stage,
    message: MESSAGES[reason],
    policyVersion: policy.version,
  });
  const isWrite = operation.effect === 'write';

  // 1. The verified client must be active and unexpired (re-checked at every evaluation).
  if (client.status !== 'active') return deny('client_inactive', 1);
  if (client.expiresAt !== undefined && Date.parse(client.expiresAt) <= input.now.getTime()) {
    return deny('client_expired', 1);
  }

  // 2. Console and site membership. An unknown console is reported exactly like a
  //    console the client may not use, so the reply does not reveal which consoles exist.
  const consoleId = input.target.consoleId;
  if (consoleId === undefined || consoleId === '') return deny('target_required', 2);
  const membership = client.consoles[consoleId];
  const consolePolicy = input.console;
  if (membership === undefined || consolePolicy?.consoleId !== consoleId) {
    return deny('console_not_permitted', 2);
  }
  if (operation.siteScoped && input.purpose === 'execute') {
    const siteId = input.target.siteId;
    if (siteId === undefined || siteId === '') return deny('site_required', 2);
    if (
      !sitePermitted(membership.sites, siteId) ||
      !sitePermitted(consolePolicy.enabledSites, siteId)
    ) {
      return deny('site_not_permitted', 2);
    }
  }

  // 3. Deployment hard lock: no write, whatever any other layer says.
  if (isWrite && input.deployment.forceReadOnly) return deny('hard_read_only', 3);

  // 4. Runtime global mode.
  if (isWrite && policy.document.runtimeMode !== 'read_write') return deny('runtime_read_only', 4);

  // 5. Console and module state.
  if (consolePolicy.state === 'disabled') return deny('console_disabled', 5);
  if (isWrite && consolePolicy.state === 'read_only') return deny('console_read_only', 5);
  const modulePolicy = consolePolicy.modules[operation.moduleId];
  if (modulePolicy === undefined || modulePolicy.state === 'disabled') {
    return deny('module_disabled', 5);
  }
  if (isWrite && modulePolicy.state !== 'read_write') return deny('module_read_only', 5);

  // 6. Rule layers by intersection: global, console, module (category and operation
  //    granularity through selectors), then the client, which must grant explicitly.
  if (!layerPasses(policy.document, operation)) return deny('denied_by_global_policy', 6);
  if (!layerPasses(consolePolicy, operation)) return deny('denied_by_console_policy', 6);
  if (!layerPasses(modulePolicy, operation)) return deny('denied_by_module_policy', 6);
  if (anyMatch(client.deny, operation)) return deny('denied_by_client_policy', 6);
  if (!anyMatch(client.allow, operation)) return deny('not_granted_to_client', 6);

  // 7. The operation must be supported by this console's verified API version. An
  //    unprobed version is never assumed to be compatible.
  if (input.capability === 'unknown') return deny('version_unknown', 7);
  if (input.capability !== 'supported') return deny('operation_unsupported', 7);

  // 8. Default-disabled operations, sensitive data, then risk and approval.
  if (
    operation.defaultDisabled === true &&
    !policy.document.enabledOperations.includes(operation.operationId)
  ) {
    return deny('operation_disabled', 8);
  }
  const tags: readonly SensitivityTag[] = operation.sensitivityTags;
  if (tags.includes('credential')) return deny('credential_exposure_forbidden', 8);
  if (
    tags.some(
      (tag) =>
        policy.document.denySensitive.includes(tag) || consolePolicy.denySensitive.includes(tag),
    )
  ) {
    return deny('sensitive_denied_by_policy', 8);
  }
  if (tags.some((tag) => !(client.sensitive as readonly SensitivityTag[]).includes(tag))) {
    return deny('sensitive_scope_missing', 8);
  }

  let effectiveRisk: Risk = operation.risk;
  for (const elevation of policy.document.riskElevations) {
    if (
      selectorMatches(elevation.selector, operation) &&
      RISK_ORDER[elevation.risk] > RISK_ORDER[effectiveRisk]
    ) {
      effectiveRisk = elevation.risk;
    }
  }
  return {
    allowed: true,
    effectiveRisk,
    approvalRequired: operation.approvalRequired || effectiveRisk === 'high',
    policyVersion: policy.version,
  };
}
