/**
 * Policy test fixtures. `permissive()` grants everything that can be granted, so a test
 * can remove exactly one permission and observe the denial it causes. `defaults()` is the
 * real default state produced by the schemas.
 */
import {
  ClientPolicySchema,
  ConsolePolicySchema,
  GlobalPolicySchema,
  GRANTABLE_SENSITIVITY_TAGS,
  type EvaluationInput,
  type OperationSecurity,
} from '@unifi-local-mcp/policy';

export const NOW = new Date('2026-11-10T03:15:00.000Z');
export const CONSOLE = 'console-1';
export const SITE = 'site-1';

export function readOp(overrides: Partial<OperationSecurity> = {}): OperationSecurity {
  return {
    operationId: 'network.devices.list',
    moduleId: 'network',
    category: 'devices',
    effect: 'read',
    permission: 'network.devices.read',
    risk: 'low',
    sensitivityTags: [],
    approvalRequired: false,
    siteScoped: true,
    ...overrides,
  };
}

export function writeOp(overrides: Partial<OperationSecurity> = {}): OperationSecurity {
  return readOp({
    operationId: 'network.devices.restart',
    effect: 'write',
    permission: 'network.devices.write',
    risk: 'medium',
    ...overrides,
  });
}

export function permissive(operation: OperationSecurity): EvaluationInput {
  return {
    now: NOW,
    deployment: { forceReadOnly: false },
    policy: { version: 7, document: GlobalPolicySchema.parse({ runtimeMode: 'read_write' }) },
    client: ClientPolicySchema.parse({
      clientId: 'client-1',
      consoles: { [CONSOLE]: { sites: '*' } },
      allow: ['*.*.*'],
      sensitive: [...GRANTABLE_SENSITIVITY_TAGS],
    }),
    console: ConsolePolicySchema.parse({
      consoleId: CONSOLE,
      modules: {
        network: { state: 'read_write' },
        protect: { state: 'read_write' },
        access: { state: 'read_write' },
      },
    }),
    operation,
    target: { consoleId: CONSOLE, siteId: SITE },
    capability: 'supported',
    purpose: 'execute',
  };
}

/** The real defaults: hard lock on (unset env), read-only runtime, no grants. */
export function defaults(operation: OperationSecurity): EvaluationInput {
  return {
    ...permissive(operation),
    deployment: { forceReadOnly: true },
    policy: { version: 1, document: GlobalPolicySchema.parse({}) },
    client: ClientPolicySchema.parse({ clientId: 'client-1', consoles: { [CONSOLE]: {} } }),
    console: ConsolePolicySchema.parse({ consoleId: CONSOLE, modules: { network: {} } }),
  };
}
