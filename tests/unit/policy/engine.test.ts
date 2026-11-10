/**
 * Policy evaluation stages and their order (spec §6.1; ADR 0009).
 */
import {
  assertOperationSecurity,
  evaluate,
  selectorMatches,
  type Decision,
  type EvaluationInput,
} from '@unifi-local-mcp/policy';
import { describe, expect, it } from 'vitest';
import { CONSOLE, defaults, NOW, permissive, readOp, SITE, writeOp } from './fixtures.ts';

function denial(decision: Decision): { reason: string; stage: number } | 'allowed' {
  return decision.allowed ? 'allowed' : { reason: decision.reason, stage: decision.stage };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('the permissive baseline', () => {
  it('allows reads and writes', () => {
    expect(evaluate(permissive(readOp()))).toEqual({
      allowed: true,
      effectiveRisk: 'low',
      approvalRequired: false,
      policyVersion: 7,
    });
    expect(evaluate(permissive(writeOp())).allowed).toBe(true);
  });
});

describe('the default state', () => {
  it('denies a read until the client is granted it explicitly', () => {
    const input = defaults(readOp());
    expect(denial(evaluate(input))).toEqual({ reason: 'not_granted_to_client', stage: 6 });
    input.client.allow = ['network.devices.read'];
    expect(evaluate(input).allowed).toBe(true);
  });

  it('denies writes at the hard lock, then at the runtime mode, then at the module', () => {
    const input = defaults(writeOp());
    input.client.allow = ['network.devices.write'];
    expect(denial(evaluate(input))).toEqual({ reason: 'hard_read_only', stage: 3 });
    input.deployment = { forceReadOnly: false };
    expect(denial(evaluate(input))).toEqual({ reason: 'runtime_read_only', stage: 4 });
    input.policy.document.runtimeMode = 'read_write';
    expect(denial(evaluate(input))).toEqual({ reason: 'module_read_only', stage: 5 });
  });

  it('denies sensitive reads without an explicit grant', () => {
    const input = defaults(readOp({ sensitivityTags: ['network_identity'] }));
    input.client.allow = ['network.devices.read'];
    expect(denial(evaluate(input))).toEqual({ reason: 'sensitive_scope_missing', stage: 8 });
    input.client.sensitive = ['network_identity'];
    expect(evaluate(input).allowed).toBe(true);
  });
});

type Mutation = [
  name: string,
  mutate: (input: EvaluationInput) => void,
  reason: string,
  stage: number,
];

const READ_DENIALS: Mutation[] = [
  ['client disabled', (i) => (i.client.status = 'disabled'), 'client_inactive', 1],
  ['client revoked', (i) => (i.client.status = 'revoked'), 'client_inactive', 1],
  ['client expired', (i) => (i.client.expiresAt = '2026-11-10T03:15:00Z'), 'client_expired', 1],
  [
    'no console id',
    (i) => (i.target = { consoleId: undefined, siteId: SITE }),
    'target_required',
    2,
  ],
  [
    'console not granted',
    (i) => (i.client.consoles = { other: { sites: '*' } }),
    'console_not_permitted',
    2,
  ],
  ['console not configured', (i) => (i.console = undefined), 'console_not_permitted', 2],
  [
    'console policy mismatch',
    (i) => i.console && (i.console.consoleId = 'other'),
    'console_not_permitted',
    2,
  ],
  ['no site id', (i) => (i.target = { consoleId: CONSOLE }), 'site_required', 2],
  [
    'site not granted',
    (i) => (i.client.consoles = { [CONSOLE]: { sites: ['site-2'] } }),
    'site_not_permitted',
    2,
  ],
  [
    'site not enabled',
    (i) => i.console && (i.console.enabledSites = ['site-2']),
    'site_not_permitted',
    2,
  ],
  ['console disabled', (i) => i.console && (i.console.state = 'disabled'), 'console_disabled', 5],
  ['module missing', (i) => i.console && (i.console.modules = {}), 'module_disabled', 5],
  [
    'module disabled',
    (i) => i.console && (i.console.modules['network'] = { state: 'disabled', deny: [] }),
    'module_disabled',
    5,
  ],
  ['global deny', (i) => (i.policy.document.deny = ['network.*.*']), 'denied_by_global_policy', 6],
  [
    'global allowlist miss',
    (i) => (i.policy.document.allow = ['protect.*.read']),
    'denied_by_global_policy',
    6,
  ],
  [
    'console deny',
    (i) => i.console && (i.console.deny = ['*.devices.read']),
    'denied_by_console_policy',
    6,
  ],
  [
    'console allowlist miss',
    (i) => i.console && (i.console.allow = ['network.clients.read']),
    'denied_by_console_policy',
    6,
  ],
  [
    'module deny',
    (i) =>
      i.console &&
      (i.console.modules['network'] = {
        state: 'read_write',
        deny: ['operation:network.devices.list'],
      }),
    'denied_by_module_policy',
    6,
  ],
  ['client deny', (i) => (i.client.deny = ['network.devices.*']), 'denied_by_client_policy', 6],
  [
    'client grant missing',
    (i) => (i.client.allow = ['network.clients.read']),
    'not_granted_to_client',
    6,
  ],
  ['capability unknown', (i) => (i.capability = 'unknown'), 'operation_unsupported', 7],
  ['capability unsupported', (i) => (i.capability = 'unsupported'), 'operation_unsupported', 7],
];

describe('each stage denies on its own', () => {
  it.each(READ_DENIALS)('%s', (_name, mutate, reason, stage) => {
    const input = permissive(readOp());
    mutate(input);
    expect(denial(evaluate(input))).toEqual({ reason, stage });
  });

  it.each<Mutation>([
    ['hard lock', (i) => (i.deployment = { forceReadOnly: true }), 'hard_read_only', 3],
    [
      'runtime read-only',
      (i) => (i.policy.document.runtimeMode = 'read_only'),
      'runtime_read_only',
      4,
    ],
    [
      'console read-only',
      (i) => i.console && (i.console.state = 'read_only'),
      'console_read_only',
      5,
    ],
    [
      'module read-only',
      (i) => i.console && (i.console.modules['network'] = { state: 'read_only', deny: [] }),
      'module_read_only',
      5,
    ],
  ])('%s denies writes but not reads', (_name, mutate, reason, stage) => {
    const write = permissive(writeOp());
    mutate(write);
    expect(denial(evaluate(write))).toEqual({ reason, stage });
    const read = permissive(readOp());
    mutate(read);
    expect(evaluate(read).allowed).toBe(true);
  });

  it('allows a client whose expiry is in the future', () => {
    const input = permissive(readOp());
    input.client.expiresAt = new Date(NOW.getTime() + 1000).toISOString();
    expect(evaluate(input).allowed).toBe(true);
  });

  it('reports the earliest failing stage', () => {
    const input = permissive(writeOp());
    input.client.allow = [];
    input.deployment = { forceReadOnly: true };
    expect(denial(evaluate(input))).toEqual({ reason: 'hard_read_only', stage: 3 });
    input.client.status = 'revoked';
    expect(denial(evaluate(input))).toEqual({ reason: 'client_inactive', stage: 1 });
  });
});

describe('stage 8: disabled operations, sensitive data, risk', () => {
  it('denies default-disabled operations unless the global policy enables them', () => {
    const input = permissive(writeOp({ defaultDisabled: true }));
    expect(denial(evaluate(input))).toEqual({ reason: 'operation_disabled', stage: 8 });
    input.policy.document.enabledOperations = ['network.devices.restart'];
    expect(evaluate(input).allowed).toBe(true);
  });

  it('never allows an operation that exposes credentials', () => {
    const input = permissive(readOp({ sensitivityTags: ['credential'] }));
    // Even a client object that bypassed schema validation cannot grant it.
    (input.client.sensitive as string[]).push('credential');
    expect(denial(evaluate(input))).toEqual({ reason: 'credential_exposure_forbidden', stage: 8 });
  });

  it('applies global and console sensitivity denials over client grants', () => {
    const input = permissive(readOp({ sensitivityTags: ['camera_image'] }));
    input.policy.document.denySensitive = ['camera_image'];
    expect(denial(evaluate(input))).toEqual({ reason: 'sensitive_denied_by_policy', stage: 8 });
    input.policy.document.denySensitive = [];
    if (input.console) input.console.denySensitive = ['camera_image'];
    expect(denial(evaluate(input))).toEqual({ reason: 'sensitive_denied_by_policy', stage: 8 });
  });

  it('requires approval for high risk, and elevations only ever raise risk', () => {
    const high = permissive(writeOp({ risk: 'high', approvalRequired: true }));
    high.policy.document.riskElevations = [{ selector: '*.*.*', risk: 'medium' }];
    expect(evaluate(high)).toMatchObject({ effectiveRisk: 'high', approvalRequired: true });

    const medium = permissive(writeOp());
    expect(evaluate(medium)).toMatchObject({ effectiveRisk: 'medium', approvalRequired: false });
    medium.policy.document.riskElevations = [{ selector: 'network.devices.write', risk: 'high' }];
    expect(evaluate(medium)).toMatchObject({ effectiveRisk: 'high', approvalRequired: true });
  });
});

describe('discovery', () => {
  it('skips only the site check', () => {
    const input = permissive(readOp());
    input.target = { consoleId: CONSOLE };
    input.purpose = 'discover';
    expect(evaluate(input).allowed).toBe(true);
    input.client.allow = ['network.clients.read'];
    expect(denial(evaluate(input))).toEqual({ reason: 'not_granted_to_client', stage: 6 });
  });
});

describe('decisions', () => {
  it('are pure: the same frozen input always gives the same decision', () => {
    const input = deepFreeze(permissive(writeOp({ risk: 'high', approvalRequired: true })));
    const first = evaluate(input);
    expect(evaluate(input)).toEqual(first);
    expect(first).toMatchObject({ allowed: true, approvalRequired: true, policyVersion: 7 });
  });

  it('carry safe messages that name no console, site or client', () => {
    for (const [, mutate] of READ_DENIALS) {
      const input = permissive(readOp());
      mutate(input);
      const decision = evaluate(input);
      if (decision.allowed) throw new Error('expected a denial');
      expect(decision.message).not.toMatch(/console-1|site-1|client-1|other/);
      expect(decision.policyVersion).toBe(7);
    }
  });
});

describe('selectors', () => {
  const op = readOp();
  it.each([
    ['network.devices.read', true],
    ['network.devices.*', true],
    ['network.*.read', true],
    ['*.*.*', true],
    ['*.devices.read', true],
    ['operation:network.devices.list', true],
    ['network.devices.write', false],
    ['protect.*.*', false],
    ['network.clients.read', false],
    ['operation:network.devices.restart', false],
  ])('%s matches: %s', (selector, expected) => {
    expect(selectorMatches(selector, op)).toBe(expected);
  });
});

describe('operation metadata', () => {
  it('rejects inconsistent reviewed metadata', () => {
    expect(() => {
      assertOperationSecurity(readOp({ permission: 'network.devices.write' }));
    }).toThrow(/permission must be/);
    expect(() => {
      assertOperationSecurity(writeOp({ risk: 'high', approvalRequired: false }));
    }).toThrow(/must require approval/);
    expect(() => evaluate(permissive(readOp({ category: 'Bad Category' })))).toThrow(TypeError);
  });
});
