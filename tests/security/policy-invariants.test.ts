/**
 * Release-blocking policy invariants (spec §17 Security, §6.1, §5.3):
 *
 * - The deployment hard lock denies every write, whatever every other layer allows,
 *   for execution and for discovery.
 * - The default state denies all writes, all sensitive reads, and every read that was not
 *   granted explicitly.
 * - A deny at any single layer wins over allows everywhere else.
 * - Operations that expose credentials are never allowed.
 * - Risk can only be raised by policy, never lowered.
 */
import {
  evaluate,
  GRANTABLE_SENSITIVITY_TAGS,
  RISKS,
  type EvaluationInput,
  type OperationSecurity,
} from '@unifi-local-mcp/policy';
import { describe, expect, it } from 'vitest';
import { defaults, permissive, readOp, writeOp } from '../unit/policy/fixtures.ts';

function writeVariants(): OperationSecurity[] {
  const variants: OperationSecurity[] = [];
  for (const risk of RISKS) {
    for (const tags of [[], ['network_identity'], [...GRANTABLE_SENSITIVITY_TAGS]] as const) {
      for (const defaultDisabled of [false, true]) {
        variants.push(
          writeOp({
            risk,
            approvalRequired: risk === 'high',
            sensitivityTags: tags,
            defaultDisabled,
            siteScoped: tags.length === 0,
          }),
        );
      }
    }
  }
  return variants;
}

describe('deployment hard lock', () => {
  it('denies every write variant under an otherwise maximally permissive policy', () => {
    for (const operation of writeVariants()) {
      for (const purpose of ['execute', 'discover'] as const) {
        const input = permissive(operation);
        input.purpose = purpose;
        input.deployment = { forceReadOnly: true };
        input.policy.document.enabledOperations = [operation.operationId];
        const decision = evaluate(input);
        expect(decision.allowed, `${operation.risk}/${purpose}`).toBe(false);
        if (!decision.allowed) expect(decision.reason).toBe('hard_read_only');
      }
    }
  });

  it('leaves reads unaffected', () => {
    const input = permissive(readOp());
    input.deployment = { forceReadOnly: true };
    expect(evaluate(input).allowed).toBe(true);
  });
});

describe('default state', () => {
  it('denies every write variant even with the hard lock lifted', () => {
    for (const operation of writeVariants()) {
      const input = defaults(operation);
      input.deployment = { forceReadOnly: false };
      input.client.allow = ['*.*.*'];
      expect(evaluate(input).allowed).toBe(false);
    }
  });

  it('denies every sensitive read without explicit grants', () => {
    for (const tag of GRANTABLE_SENSITIVITY_TAGS) {
      const input = defaults(readOp({ sensitivityTags: [tag] }));
      input.client.allow = ['*.*.*'];
      const decision = evaluate(input);
      expect(decision.allowed, tag).toBe(false);
    }
  });

  it('denies plain reads that were not granted', () => {
    expect(evaluate(defaults(readOp())).allowed).toBe(false);
  });
});

describe('deny wins', () => {
  const selectors = [
    'network.devices.write',
    'network.devices.*',
    'network.*.write',
    '*.*.*',
    'operation:network.devices.restart',
  ];
  const layers: [string, (input: EvaluationInput, selector: string) => void][] = [
    ['global', (i, s) => (i.policy.document.deny = [s])],
    ['console', (i, s) => i.console && (i.console.deny = [s])],
    [
      'module',
      (i, s) => i.console && (i.console.modules['network'] = { state: 'read_write', deny: [s] }),
    ],
    ['client', (i, s) => (i.client.deny = [s])],
  ];
  it.each(layers)('a %s-layer deny overrides allows everywhere else', (_name, addDeny) => {
    for (const selector of selectors) {
      const input = permissive(writeOp());
      addDeny(input, selector);
      expect(evaluate(input).allowed, selector).toBe(false);
    }
  });
});

describe('credentials', () => {
  it('are never released, even with every grant and a tampered client record', () => {
    const input = permissive(readOp({ sensitivityTags: ['credential', 'network_identity'] }));
    (input.client.sensitive as string[]).push('credential');
    input.deployment = { forceReadOnly: false };
    const decision = evaluate(input);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('credential_exposure_forbidden');
  });
});

describe('risk', () => {
  it('cannot be lowered below the reviewed classification', () => {
    const input = permissive(writeOp({ risk: 'high', approvalRequired: true }));
    input.policy.document.riskElevations = [
      { selector: '*.*.*', risk: 'medium' },
      { selector: 'operation:network.devices.restart', risk: 'medium' },
    ];
    expect(evaluate(input)).toMatchObject({
      allowed: true,
      effectiveRisk: 'high',
      approvalRequired: true,
    });
  });
});
