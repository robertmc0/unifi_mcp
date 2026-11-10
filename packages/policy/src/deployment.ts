/**
 * Immutable deployment security overrides (spec §8.1 precedence level 1, decision 29).
 *
 * These are read from the environment once at startup and can never be changed from the
 * database, the admin UI or an MCP request.
 */
export const FORCE_READ_ONLY_ENV = 'UNIFI_MCP_FORCE_READ_ONLY';

export interface DeploymentOverrides {
  /** When true, no write can execute through any path, including approved actions. */
  readonly forceReadOnly: boolean;
}

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

/**
 * Parses the deployment overrides. `UNIFI_MCP_FORCE_READ_ONLY` defaults to **true** when
 * unset or empty (fail safe): writes require the operator to set it to `false`
 * deliberately. Any unrecognised value is a startup error rather than a guess.
 */
export function parseDeploymentOverrides(env: NodeJS.ProcessEnv): DeploymentOverrides {
  const raw = env[FORCE_READ_ONLY_ENV]?.trim().toLowerCase() ?? '';
  if (raw === '' || TRUE_VALUES.has(raw)) return Object.freeze({ forceReadOnly: true });
  if (FALSE_VALUES.has(raw)) return Object.freeze({ forceReadOnly: false });
  throw new Error(
    `${FORCE_READ_ONLY_ENV} must be "true" or "false" (got an unrecognised value). ` +
      'Unset means true.',
  );
}
