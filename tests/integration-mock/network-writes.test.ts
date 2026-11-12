/**
 * Every documented Network write (ADR 0018 §5), end to end against the synthetic console:
 * authorisation, human approval and single resumption for high risk, direct execution for
 * medium risk, default-disabled operations, duplicates, uncertain outcomes, and credential
 * handling (a passphrase in a request is sent to the console but never logged, audited,
 * shown to approvers or returned).
 */
import { join } from 'node:path';
import { ApprovalService } from '@unifi-local-mcp/approvals';
import {
  Dispatcher,
  ExecutionStore,
  OperationRegistry,
  renderPath,
  type OperationDescriptor,
} from '@unifi-local-mcp/core';
import { ClientPolicySchema } from '@unifi-local-mcp/policy';
import { loadContractInventory } from '@unifi-local-mcp/unifi-api';
import { NETWORK_OPERATIONS, NETWORK_WRITES } from '@unifi-local-mcp/unifi-network';
import { describe, expect, it } from 'vitest';
import type * as z from 'zod';
import { sendJson } from '../fixtures/mock-console.ts';
import { branches, sample } from '../fixtures/zod-samples.ts';
import { TEST_LIMITS } from '../unit/core/fixtures.ts';
import { useTempDirs } from '../unit/storage/fixtures.ts';
import { CLI, NETWORK_KEY, unifiHarness } from '../unit/unifi-api/fixtures.ts';

const tempDir = useTempDirs();
const inventory = await loadContractInventory(join(import.meta.dirname, '../../api-specs'));
const SITE = '00000000-0000-4000-8000-00000000a51e';
const BASE = '/proxy/network/integration';
const PRINCIPAL = { clientId: 'writer' };
const APPROVER = { type: 'cli', id: 'root' } as const;
const UNLIMITED = { ratePerSecond: 10_000, burst: 10_000 };
const PEOPLE = ['personal_identifier', 'network_identity'];
const DEFAULT_DISABLED = NETWORK_WRITES.filter((d) => d.defaultDisabled === true).map(
  (d) => d.operationId,
);

const secretFor = (descriptor: OperationDescriptor) => (key: string) => {
  if (key === 'passphrase') return 'SENTINEL-PASSPHRASE';
  if (key === 'code' && descriptor.category === 'hotspot') return 'SENTINEL-VOUCHER-CODE';
  return undefined;
};

interface StackOptions {
  allow?: string[];
  sensitive?: string[];
  forceReadOnly?: boolean;
  moduleState?: 'read_only' | 'read_write';
  enable?: string[];
}

async function stack(options: StackOptions = {}) {
  const h = await unifiHarness({ dir: await tempDir() });
  h.policyStore.setRuntimeMode('read_write', CLI);
  const enable = options.enable ?? DEFAULT_DISABLED;
  if (enable.length > 0) {
    const current = h.policyStore.current();
    h.policyStore.replace({ ...current.document, enabledOperations: enable }, CLI, current.version);
  }
  h.consoles.setPolicy(
    h.consoleId,
    { modules: { network: { state: options.moduleState ?? 'read_write' } } },
    CLI,
  );
  h.consoles.recordObservedVersion(h.consoleId, 'network', '11.0.97');
  const registry = new OperationRegistry(inventory);
  for (const descriptor of NETWORK_OPERATIONS) registry.register(descriptor);
  registry.seal();
  const client = ClientPolicySchema.parse({
    clientId: PRINCIPAL.clientId,
    consoles: { [h.consoleId]: { sites: '*' } },
    allow: options.allow ?? ['network.*.*'],
    sensitive: options.sensitive ?? PEOPLE,
  });
  const approvals = new ApprovalService({
    db: h.storage.db,
    audit: h.audit,
    secrets: h.storage.secrets,
    policyStore: h.policyStore,
  });
  const dispatcher = new Dispatcher({
    registry,
    executor: h.executor,
    security: {
      clientPolicy: (id) => (id === client.clientId ? client : undefined),
      consolePolicy: (id) => h.consoles.policy(id),
      capability: (id, descriptor) => h.consoles.capability(id, descriptor),
    },
    policyStore: h.policyStore,
    deployment: { forceReadOnly: options.forceReadOnly ?? false },
    audit: h.audit,
    executions: new ExecutionStore(h.storage.db),
    logger: h.log.logger,
    approvals,
    limits: {
      ...TEST_LIMITS,
      rate: { client: UNLIMITED, console: UNLIMITED, module: UNLIMITED, global: UNLIMITED },
    },
  });
  return { h, dispatcher, approvals };
}

function argumentsFor(descriptor: OperationDescriptor, variant = 0): Record<string, unknown> {
  return sample(descriptor.inputSchema, { variant, secret: secretFor(descriptor) }) as Record<
    string,
    unknown
  >;
}

function expectedUrl(descriptor: OperationDescriptor, args: Record<string, unknown>): string {
  const path = renderPath(descriptor.pathTemplate, {
    ...(args as Record<string, string | number>),
    siteId: SITE,
  });
  const query = new URLSearchParams();
  for (const name of descriptor.queryParameters ?? []) {
    const value = args[name] as string | number | boolean | undefined;
    if (value !== undefined) query.append(name, String(value));
  }
  const text = query.toString();
  return `${BASE}${path}${text === '' ? '' : `?${text}`}`;
}

function request(
  descriptor: OperationDescriptor,
  consoleId: string,
  args: Record<string, unknown>,
) {
  return {
    operationId: descriptor.operationId,
    consoleId,
    siteId: SITE,
    arguments: args,
  };
}

describe('every documented Network write', () => {
  it('is registered: 32 writes, 27 high risk with approval, 5 medium', () => {
    expect(NETWORK_WRITES).toHaveLength(32);
    expect(NETWORK_WRITES.filter((d) => d.risk === 'high' && d.approvalRequired)).toHaveLength(27);
    expect(NETWORK_WRITES.filter((d) => d.risk === 'medium' && !d.approvalRequired)).toHaveLength(
      5,
    );
    expect(DEFAULT_DISABLED.sort()).toEqual([
      'network.devices.remove',
      'network.hotspot.delete_vouchers',
    ]);
    for (const d of NETWORK_WRITES) {
      expect(d.effect, d.operationId).toBe('write');
      expect(d.siteScoped, d.operationId).toBe(true);
      expect(typeof d.resourceLockKey, d.operationId).toBe('function');
    }
  });

  it('has valid synthetic arguments for every write and every body variant', () => {
    for (const d of NETWORK_WRITES) {
      for (let variant = 0; variant < branches(d.inputSchema); variant++) {
        const parsed = d.inputSchema.safeParse(argumentsFor(d, variant));
        expect(
          parsed.success,
          `${d.operationId} ${String(variant)}: ${JSON.stringify(parsed.error?.issues)}`,
        ).toBe(true);
      }
    }
  });

  for (const descriptor of NETWORK_WRITES) {
    it(`${descriptor.operationId}: ${descriptor.approvalRequired ? 'approval, then exactly one request' : 'exactly one request'}`, async () => {
      const { h, dispatcher, approvals } = await stack();
      const variants = branches(descriptor.inputSchema);
      for (let variant = 0; variant < variants; variant++) {
        const label = `${descriptor.operationId} variant ${String(variant)}`;
        const args = argumentsFor(descriptor, variant);
        const response = sample(descriptor.outputSchema, {
          variant,
          secret: secretFor(descriptor),
          extra: ['undocumentedField', 'SENTINEL-UNDOCUMENTED'],
        });
        h.mock.requests.length = 0;
        h.mock.respond = (_req, res) => {
          sendJson(res, 200, response);
        };
        let envelope = await dispatcher.execute(PRINCIPAL, request(descriptor, h.consoleId, args));
        if (descriptor.approvalRequired) {
          expect(envelope.status, label).toBe('approval_required');
          expect(h.mock.requests, `${label}: nothing before approval`).toEqual([]);
          const approvalId = envelope.approvalId ?? '';
          // Approvers see a redacted summary: no credential from the request.
          expect(JSON.stringify(approvals.get(approvalId)), label).not.toContain('SENTINEL');
          approvals.approve(approvalId, APPROVER);
          envelope = await dispatcher.resume(PRINCIPAL, approvalId);
          // A second resume never sends a second request.
          const again = await dispatcher.resume(PRINCIPAL, approvalId);
          expect(again.status, label).not.toBe('ok');
        }
        expect(envelope.status, `${label}: ${JSON.stringify(envelope.error)}`).toBe('ok');
        expect(envelope.outcome, label).toBe('succeeded');
        expect(h.mock.requests, label).toHaveLength(1);
        const sent = h.mock.requests[0];
        expect(sent?.method, label).toBe(descriptor.httpMethod);
        expect(sent?.url, label).toBe(expectedUrl(descriptor, args));
        expect(sent?.headers['x-api-key'], label).toBe(NETWORK_KEY);
        if (descriptor.requestBody === 'json') {
          // The console receives exactly the validated body, credentials included.
          expect(JSON.parse(sent?.body ?? 'null'), label).toEqual(
            (descriptor.inputSchema.shape['body'] as z.ZodType).parse(args['body']),
          );
          expect(sent?.headers['content-type'], label).toBe('application/json');
        } else {
          expect(sent?.body, label).toBe('');
        }
        expect(JSON.stringify(envelope), label).not.toContain('SENTINEL');
      }
      // Neither the audit trail nor the log ever holds a credential from a request.
      expect(JSON.stringify(h.audit.list({ limit: 500 }))).not.toContain('SENTINEL');
      expect(h.log.lines.join('\n')).not.toContain('SENTINEL');
      await h.close();
    }, 60_000); // one round trip per response or body variant
  }
});

describe('write authorisation', () => {
  const sampleWrite = (operationId: string) => {
    const d = NETWORK_WRITES.find((w) => w.operationId === operationId);
    if (d === undefined) throw new Error(operationId);
    return d;
  };

  it.each([
    ['read-only grants', { allow: ['network.*.read'] }, 'not_granted_to_client'],
    ['the hard lock', { forceReadOnly: true }, 'hard_read_only'],
    ['a read-only module', { moduleState: 'read_only' as const }, 'module_read_only'],
  ])('refuses every write under %s, sending nothing', async (_name, options, code) => {
    const { h, dispatcher } = await stack(options);
    for (const descriptor of NETWORK_WRITES) {
      const envelope = await dispatcher.execute(
        PRINCIPAL,
        request(descriptor, h.consoleId, argumentsFor(descriptor)),
      );
      expect(envelope, descriptor.operationId).toMatchObject({ status: 'denied', error: { code } });
    }
    expect(h.mock.requests).toEqual([]);
    await h.close();
  });

  it('keeps default-disabled writes off until a global policy enables them', async () => {
    const { h, dispatcher } = await stack({ enable: [] });
    for (const operationId of DEFAULT_DISABLED) {
      const descriptor = sampleWrite(operationId);
      const envelope = await dispatcher.execute(
        PRINCIPAL,
        request(descriptor, h.consoleId, argumentsFor(descriptor)),
      );
      expect(envelope, operationId).toMatchObject({
        status: 'denied',
        error: { code: 'operation_disabled' },
      });
    }
    expect(h.mock.requests).toEqual([]);
    await h.close();
  });

  it('requires the sensitive grants for client actions', async () => {
    const { h, dispatcher } = await stack({ sensitive: [] });
    const descriptor = sampleWrite('network.clients.run_action');
    const envelope = await dispatcher.execute(
      PRINCIPAL,
      request(descriptor, h.consoleId, argumentsFor(descriptor)),
    );
    expect(envelope).toMatchObject({
      status: 'denied',
      error: { code: 'sensitive_scope_missing' },
    });
    expect(h.mock.requests).toEqual([]);
    await h.close();
  });

  it('runs a repeated request with the same idempotency key only once', async () => {
    const { h, dispatcher } = await stack();
    const descriptor = sampleWrite('network.firewall.patch_policy');
    h.mock.respond = (_req, res) => {
      sendJson(res, 200, sample(descriptor.outputSchema));
    };
    const call = {
      ...request(descriptor, h.consoleId, argumentsFor(descriptor)),
      idempotencyKey: 'change-42',
    };
    const first = await dispatcher.execute(PRINCIPAL, call);
    const second = await dispatcher.execute(PRINCIPAL, call);
    expect(first.status).toBe('ok');
    expect(second.executionId).toBe(first.executionId);
    expect(h.mock.requests).toHaveLength(1);
    await h.close();
  });

  it('reports an uncertain outcome and never retries it', async () => {
    const { h, dispatcher } = await stack();
    const descriptor = sampleWrite('network.hotspot.create_vouchers');
    h.mock.respond = (_req, res) => {
      res.destroy(); // the connection breaks after the request reached the console
    };
    const envelope = await dispatcher.execute(
      PRINCIPAL,
      request(descriptor, h.consoleId, argumentsFor(descriptor)),
    );
    expect(envelope).toMatchObject({ status: 'error', outcome: 'outcome_unknown' });
    expect(h.mock.requests).toHaveLength(1);
    await h.close();
  });
});

describe('networks in use (ADR 0018)', () => {
  const write = (operationId: string) => {
    const d = NETWORK_WRITES.find((w) => w.operationId === operationId);
    if (d === undefined) throw new Error(operationId);
    return d;
  };
  const NETWORK = '00000000-0000-4000-8000-000000000050';

  it('offers no forced network delete: `force` is refused before anything is sent', async () => {
    const { h, dispatcher } = await stack();
    const descriptor = write('network.networks.delete');
    expect(descriptor.queryParameters).toEqual([]);
    for (const force of [true, false]) {
      const envelope = await dispatcher.execute(
        PRINCIPAL,
        request(descriptor, h.consoleId, { networkId: NETWORK, force }),
      );
      expect(envelope, String(force)).toMatchObject({
        status: 'error',
        error: { code: 'invalid_arguments' },
      });
    }
    expect(h.mock.requests).toEqual([]);
    await h.close();
  });

  it('asks the approver to check what uses a network before it is changed or deleted', async () => {
    const { h, dispatcher, approvals } = await stack();
    const caution = /cannot reliably list what uses a network.*Check in UniFi Network/u;
    for (const [operationId, cautioned] of [
      ['network.networks.update', true],
      ['network.networks.delete', true],
      ['network.networks.create', false],
    ] as const) {
      const descriptor = write(operationId);
      const envelope = await dispatcher.execute(
        PRINCIPAL,
        request(descriptor, h.consoleId, argumentsFor(descriptor)),
      );
      expect(envelope.status, operationId).toBe('approval_required');
      // The client sees it, and so does the approver (CLI and admin interface).
      const shown = (envelope.data as { summary: { caution?: string } }).summary.caution;
      const stored = (approvals.get(envelope.approvalId ?? '')?.summary as { caution?: string })
        .caution;
      if (cautioned) {
        expect(shown, operationId).toMatch(caution);
        expect(stored, operationId).toBe(shown);
      } else {
        expect(shown, operationId).toBeUndefined();
        expect(stored, operationId).toBeUndefined();
      }
    }
    expect(h.mock.requests).toEqual([]);
    await h.close();
  });
});
