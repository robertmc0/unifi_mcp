/**
 * Policy schemas: strict validation, defaults, and rejection of ambiguous declarations
 * (spec §6.2; ADR 0009).
 */
import {
  ClientPolicySchema,
  ConsolePolicySchema,
  describeValidationError,
  GlobalPolicySchema,
  isValidPermission,
  isValidSelector,
  parseDeploymentOverrides,
} from '@unifi-local-mcp/policy';
import { describe, expect, it } from 'vitest';

describe('GlobalPolicySchema', () => {
  it('defaults to read-only with no rules', () => {
    expect(GlobalPolicySchema.parse({})).toEqual({
      runtimeMode: 'read_only',
      deny: [],
      denySensitive: [],
      riskElevations: [],
      enabledOperations: [],
    });
  });

  it.each([
    ['unknown key', { runtimeMode: 'read_only', extra: true }],
    ['unknown runtime mode', { runtimeMode: 'yolo' }],
    ['malformed selector', { deny: ['network.devices'] }],
    ['bad effect', { deny: ['network.devices.delete'] }],
    ['allowed and denied at once', { allow: ['network.*.read'], deny: ['network.*.read'] }],
    ['risk lowered', { riskElevations: [{ selector: '*.*.*', risk: 'low' }] }],
    ['unknown sensitivity tag', { denySensitive: ['shoe_size'] }],
  ])('rejects %s', (_name, input) => {
    expect(GlobalPolicySchema.safeParse(input).success).toBe(false);
  });

  it('describes problems with their path', () => {
    const result = GlobalPolicySchema.safeParse({ deny: ['ok.ok.read', 'bad'] });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(describeValidationError(result.error)).toMatch(/^deny\.1: Selector/);
  });
});

describe('ClientPolicySchema', () => {
  it('grants nothing by default', () => {
    expect(ClientPolicySchema.parse({ clientId: 'client-1' })).toEqual({
      clientId: 'client-1',
      status: 'active',
      consoles: {},
      allow: [],
      deny: [],
      sensitive: [],
    });
  });

  it('can never grant credentials', () => {
    const result = ClientPolicySchema.safeParse({ clientId: 'c', sensitive: ['credential'] });
    expect(result.success).toBe(false);
  });

  it('validates identifiers, expiry and site sets', () => {
    expect(ClientPolicySchema.safeParse({ clientId: 'bad id' }).success).toBe(false);
    expect(ClientPolicySchema.safeParse({ clientId: 'c', expiresAt: 'tomorrow' }).success).toBe(
      false,
    );
    expect(
      ClientPolicySchema.safeParse({ clientId: 'c', consoles: { c1: { sites: [] } } }).success,
    ).toBe(false);
    expect(
      ClientPolicySchema.parse({ clientId: 'c', consoles: { c1: {} } }).consoles['c1'],
    ).toEqual({ sites: '*' });
  });
});

describe('ConsolePolicySchema', () => {
  it('enables the console, all sites, and modules only when listed (read-only by default)', () => {
    expect(ConsolePolicySchema.parse({ consoleId: 'c1', modules: { network: {} } })).toEqual({
      consoleId: 'c1',
      state: 'enabled',
      enabledSites: '*',
      deny: [],
      denySensitive: [],
      modules: { network: { state: 'read_only', deny: [] } },
    });
    expect(ConsolePolicySchema.parse({ consoleId: 'c1' }).modules).toEqual({});
  });

  it('rejects unknown modules keys and states', () => {
    expect(
      ConsolePolicySchema.safeParse({ consoleId: 'c1', modules: { Network: {} } }).success,
    ).toBe(false);
    expect(
      ConsolePolicySchema.safeParse({ consoleId: 'c1', modules: { network: { state: 'on' } } })
        .success,
    ).toBe(false);
  });
});

describe('selector and permission syntax', () => {
  it.each([
    ['network.devices.read', true],
    ['*.*.*', true],
    ['network.*.write', true],
    ['operation:network.devices.restart', true],
    ['network.devices', false],
    ['network.devices.read.extra', false],
    ['Network.devices.read', false],
    ['network.devices.admin', false],
    ['operation:', false],
    ['operation:Network.x', false],
  ])('selector %s valid: %s', (selector, expected) => {
    expect(isValidSelector(selector)).toBe(expected);
  });

  it('permissions are concrete, without wildcards', () => {
    expect(isValidPermission('network.devices.read')).toBe(true);
    expect(isValidPermission('network.*.read')).toBe(false);
    expect(isValidPermission('operation:network.devices.list')).toBe(false);
  });
});

describe('parseDeploymentOverrides', () => {
  it.each([
    [undefined, true],
    ['', true],
    ['true', true],
    ['1', true],
    [' Yes ', true],
    ['false', false],
    ['FALSE', false],
    ['0', false],
    ['off', false],
  ])('UNIFI_MCP_FORCE_READ_ONLY=%j gives forceReadOnly=%s', (value, expected) => {
    const overrides = parseDeploymentOverrides(
      value === undefined ? {} : { UNIFI_MCP_FORCE_READ_ONLY: value },
    );
    expect(overrides.forceReadOnly).toBe(expected);
    expect(Object.isFrozen(overrides)).toBe(true);
  });

  it('rejects unrecognised values instead of guessing', () => {
    expect(() => parseDeploymentOverrides({ UNIFI_MCP_FORCE_READ_ONLY: 'maybe' })).toThrow(
      /must be "true" or "false"/,
    );
  });
});
