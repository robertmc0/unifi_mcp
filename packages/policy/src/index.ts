/**
 * @unifi-local-mcp/policy
 *
 * Permission evaluation in the order of spec §6.1 (deny always wins), the deployment hard
 * lock and runtime mode, layered allow/deny rules by intersection, default deny for writes
 * and sensitive reads, risk elevation, and the versioned global policy store (ADR 0009).
 */
export {
  FORCE_READ_ONLY_ENV,
  parseDeploymentOverrides,
  type DeploymentOverrides,
} from './deployment.ts';
export {
  evaluate,
  selectorMatches,
  type Allowed,
  type Capability,
  type Decision,
  type Denied,
  type DenyReason,
  type EvaluationInput,
} from './engine.ts';
export {
  assertOperationSecurity,
  CLIENT_STATUSES,
  ClientPolicySchema,
  CONSOLE_STATES,
  ConsolePolicySchema,
  describeValidationError,
  EFFECTS,
  GlobalPolicySchema,
  GRANTABLE_SENSITIVITY_TAGS,
  isValidPermission,
  isValidSelector,
  MODULE_STATES,
  RISKS,
  RUNTIME_MODES,
  SENSITIVITY_TAGS,
  type ClientPolicy,
  type ClientStatus,
  type ConsolePolicy,
  type ConsoleState,
  type Effect,
  type GlobalPolicy,
  type ModuleState,
  type OperationSecurity,
  type Risk,
  type RuntimeMode,
  type SensitivityTag,
} from './model.ts';
export {
  bumpPolicyVersion,
  PolicyError,
  PolicyStore,
  validateGlobalPolicy,
  type PolicyActor,
  type PolicyErrorCode,
  type PolicySnapshot,
  type PolicyValidation,
} from './store.ts';
