/**
 * Every offered Access write (ADR 0023 §4), end to end: dispatcher → registry (real
 * contract inventory) → HTTPS executor → synthetic Access API, with a declared version.
 *
 * - High risk needs human approval first and sends exactly one request after it; medium
 *   risk runs directly. A second resumption never sends a second request.
 * - A PIN in a request reaches the console but never a log, the audit trail, an approver or
 *   a result; webhook secrets and PIN hashes in responses never reach the client.
 * - Negative tests: missing grants, the hard lock, a read-only module, default-disabled
 *   operations, door control without its own permission, the unlock's actor fields, an
 *   undeclared or unsupported version, refusals and uncertain outcomes from the console.
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
import { ACCESS_OPERATIONS, ACCESS_WRITES } from '@unifi-local-mcp/unifi-access';
import { loadContractInventory } from '@unifi-local-mcp/unifi-api';
import { describe, expect, it } from 'vitest';
import type * as z from 'zod';
import { envelope } from '../fixtures/access-console.ts';
import { sendJson } from '../fixtures/mock-console.ts';
import { branches, sample } from '../fixtures/zod-samples.ts';
import { TEST_LIMITS } from '../unit/core/fixtures.ts';
import { useTempDirs } from '../unit/storage/fixtures.ts';
import { CLI, unifiHarness } from '../unit/unifi-api/fixtures.ts';

const tempDir = useTempDirs();
const inventory = await loadContractInventory(join(import.meta.dirname, '../../api-specs'));
const TOKEN = 'synthetic-access-token-SENTINEL-77';
const PRINCIPAL = { clientId: 'operator' };
const APPROVER = { type: 'cli', id: 'root' } as const;
const UNLIMITED = { ratePerSecond: 10_000, burst: 10_000 };
const ALL_SENSITIVE = ['personal_identifier', 'biometric_or_access_identity'];
/** A PIN sentinel: digits that nothing else in a request, result, log or audit entry holds. */
const PIN = '480317';
/** The PIN as a value of its own, not as digits inside a hex id or hash. */
const PIN_VALUE = new RegExp(`(?<![0-9a-f])${PIN}(?![0-9a-f])`, 'iu');
const DEFAULT_DISABLED = ACCESS_WRITES.filter((d) => d.defaultDisabled === true).map(
  (d) => d.operationId,
);

/** Credential sentinels: the PIN in requests, the webhook secret in responses. */
const secret = (key: string) =>
  key === 'pin_code' ? PIN : key === 'secret' ? 'SENTINEL-WEBHOOK-SECRET' : undefined;

/** Puts a PIN-hash sentinel into every `pin_code` object of a response sample. */
function withPinHashes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withPinHashes);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) =>
      key === 'pin_code' && child !== null && typeof child === 'object'
        ? [key, { ...(child as object), token: 'SENTINEL-PIN-HASH' }]
        : [key, withPinHashes(child)],
    ),
  );
}

interface StackOptions {
  allow?: string[];
  sensitive?: string[];
  forceReadOnly?: boolean;
  moduleState?: 'read_only' | 'read_write';
  enable?: string[];
  version?: string | null;
  riskElevations?: { selector: string; risk: 'medium' | 'high' }[];
}

async function stack(options: StackOptions = {}) {
  const h = await unifiHarness({ dir: await tempDir() });
  h.consoles.setCredential(h.consoleId, 'access', TOKEN, CLI);
  h.policyStore.setRuntimeMode('read_write', CLI);
  const current = h.policyStore.current();
  h.policyStore.replace(
    {
      ...current.document,
      enabledOperations: options.enable ?? DEFAULT_DISABLED,
      riskElevations: options.riskElevations ?? [],
    },
    CLI,
    current.version,
  );
  h.consoles.setPolicy(
    h.consoleId,
    { modules: { access: { state: options.moduleState ?? 'read_write' } } },
    CLI,
  );
  const version = options.version === undefined ? '4.2.16' : options.version;
  if (version !== null) h.consoles.declareVersion(h.consoleId, 'access', version, CLI);
  const registry = new OperationRegistry(inventory);
  for (const descriptor of ACCESS_OPERATIONS) registry.register(descriptor);
  registry.seal();
  const client = ClientPolicySchema.parse({
    clientId: PRINCIPAL.clientId,
    consoles: { [h.consoleId]: { sites: '*' } },
    allow: options.allow ?? ['access.*.*'],
    sensitive: options.sensitive ?? ALL_SENSITIVE,
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
      moduleVersion: (id, moduleId) => h.consoles.moduleVersion(id, moduleId),
      declaresVersion: (moduleId) => moduleId === 'access',
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
  const execute = (operationId: string, args: Record<string, unknown>, idempotencyKey?: string) =>
    dispatcher.execute(PRINCIPAL, {
      operationId,
      consoleId: h.consoleId,
      arguments: args,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    });
  return { h, dispatcher, approvals, execute };
}

function argumentsFor(descriptor: OperationDescriptor, variant = 0): Record<string, unknown> {
  return sample(descriptor.inputSchema, { variant, secret }) as Record<string, unknown>;
}

function expectedUrl(descriptor: OperationDescriptor, args: Record<string, unknown>): string {
  const path = renderPath(descriptor.pathTemplate, args as Record<string, string | number>);
  const query = new URLSearchParams();
  for (const name of descriptor.queryParameters ?? []) {
    const value = args[name] as string | number | boolean | undefined;
    if (value !== undefined) query.append(name, String(value));
  }
  const text = query.toString();
  return `${path}${text === '' ? '' : `?${text}`}`;
}

/** The console's answer to a write: a sample inside the envelope, or the PDF's "success". */
function answer(descriptor: OperationDescriptor, variant: number): object {
  const payload = sample(descriptor.outputSchema, {
    variant,
    secret,
    extra: ['undocumentedField', 'SENTINEL-UNDOCUMENTED'],
  });
  return {
    ...envelope(
      payload !== null && typeof payload === 'object'
        ? (withPinHashes(payload) as object)
        : { data: 'success' },
    ),
    msg: 'SENTINEL-VENDOR-MSG',
  };
}

function byId(operationId: string): OperationDescriptor {
  const d = ACCESS_WRITES.find((w) => w.operationId === operationId);
  if (d === undefined) throw new Error(operationId);
  return d;
}

describe('every offered Access write', () => {
  it('is registered: 58 writes, 51 high risk with approval, 7 medium, 7 off by default', () => {
    expect(ACCESS_WRITES).toHaveLength(58);
    expect(ACCESS_WRITES.filter((d) => d.risk === 'high' && d.approvalRequired)).toHaveLength(51);
    expect(ACCESS_WRITES.filter((d) => d.risk === 'medium' && !d.approvalRequired)).toHaveLength(7);
    expect(DEFAULT_DISABLED.sort()).toEqual([
      'access.api_server.delete_certificate',
      'access.credentials.purchase_touch_passes',
      'access.doors.set_emergency',
      'access.users.assign_pin',
      'access.visitors.assign_pin',
      'access.webhooks.create_endpoint',
      'access.webhooks.update_endpoint',
    ]);
    for (const d of ACCESS_WRITES) {
      expect(d.effect, d.operationId).toBe('write');
      expect(d.siteScoped, d.operationId).toBe(false);
      expect(d.retryClass, d.operationId).not.toBe('safe-read');
      expect(typeof d.resourceLockKey, d.operationId).toBe('function');
      expect(d.apiVersionRange, d.operationId).toMatch(/^>=\d+\.\d+\.\d+ <=4\.2\.16$/);
    }
  });

  it('has valid synthetic arguments for every write and every body variant', () => {
    for (const d of ACCESS_WRITES) {
      for (let variant = 0; variant < branches(d.inputSchema); variant++) {
        const parsed = d.inputSchema.safeParse(argumentsFor(d, variant));
        expect(
          parsed.success,
          `${d.operationId} ${String(variant)}: ${JSON.stringify(parsed.error?.issues)}`,
        ).toBe(true);
      }
    }
  });

  it('puts the PIN and secret sentinels into the requests and responses it checks', () => {
    for (const operationId of ['access.users.assign_pin', 'access.visitors.assign_pin']) {
      expect(JSON.stringify(argumentsFor(byId(operationId))), operationId).toMatch(PIN_VALUE);
    }
    const created = JSON.stringify(answer(byId('access.webhooks.create_endpoint'), 0));
    expect(created).toContain('SENTINEL-WEBHOOK-SECRET');
    expect(JSON.stringify(answer(byId('access.users.create'), 0))).toContain('SENTINEL-PIN-HASH');
  });

  for (const descriptor of ACCESS_WRITES) {
    it(`${descriptor.operationId}: ${descriptor.approvalRequired ? 'approval, then exactly one request' : 'exactly one request'}`, async () => {
      const { h, dispatcher, approvals, execute } = await stack();
      const variants = branches(descriptor.inputSchema);
      for (let variant = 0; variant < variants; variant++) {
        const label = `${descriptor.operationId} variant ${String(variant)}`;
        const args = argumentsFor(descriptor, variant);
        const response = answer(descriptor, variant);
        h.mock.requests.length = 0;
        h.mock.respond = (_req, res) => {
          sendJson(res, 200, response);
        };
        let result = await execute(descriptor.operationId, args);
        if (descriptor.approvalRequired) {
          expect(result.status, `${label}: ${JSON.stringify(result.error)}`).toBe(
            'approval_required',
          );
          expect(h.mock.requests, `${label}: nothing before approval`).toEqual([]);
          const approvalId = result.approvalId ?? '';
          const shown = JSON.stringify(approvals.get(approvalId));
          expect(shown, label).not.toContain('SENTINEL');
          expect(shown, label).not.toMatch(PIN_VALUE);
          // The approver is told the version is declared, not observed.
          expect(shown, label).toContain('declared by an administrator');
          approvals.approve(approvalId, APPROVER);
          result = await dispatcher.resume(PRINCIPAL, approvalId);
          const again = await dispatcher.resume(PRINCIPAL, approvalId);
          expect(again.status, label).not.toBe('ok');
        }
        expect(result.status, `${label}: ${JSON.stringify(result.error)}`).toBe('ok');
        expect(result.outcome, label).toBe('succeeded');
        expect(h.mock.requests, label).toHaveLength(1);
        const sent = h.mock.requests[0];
        expect(sent?.method, label).toBe(descriptor.httpMethod);
        expect(sent?.url, label).toBe(expectedUrl(descriptor, args));
        expect(sent?.headers['authorization'], label).toBe(`Bearer ${TOKEN}`);
        if (descriptor.requestBody === 'json') {
          // The console receives exactly the validated body, a PIN included.
          expect(JSON.parse(sent?.body ?? 'null'), label).toEqual(
            (descriptor.inputSchema.shape['body'] as z.ZodType).parse(args['body']),
          );
        } else {
          expect(sent?.body, label).toBe('');
        }
        const returned = JSON.stringify(result);
        expect(returned, label).not.toContain('SENTINEL');
        expect(returned, label).not.toMatch(PIN_VALUE);
        expect(result.warnings?.join(' '), label).toMatch(/declared by an administrator/);
      }
      const audited = JSON.stringify(h.audit.list({ limit: 500 }));
      expect(audited).not.toContain('SENTINEL');
      expect(audited).not.toMatch(PIN_VALUE);
      expect(h.log.lines.join('\n')).not.toMatch(PIN_VALUE);
      expect(h.log.lines.join('\n')).not.toContain('SENTINEL');
      await h.close();
    }, 60_000);
  }
});

describe('Access write authorisation and failures', () => {
  it.each([
    ['read-only grants', { allow: ['access.*.read'] }, 'not_granted_to_client'],
    ['the hard lock', { forceReadOnly: true }, 'hard_read_only'],
    ['a read-only module', { moduleState: 'read_only' as const }, 'module_read_only'],
    ['no declared version', { version: null }, 'version_unknown'],
    ['a declared 4.3.x', { version: '4.3.24' }, 'operation_unsupported'],
  ])('refuses every write under %s, sending nothing', async (_name, options, code) => {
    const { h, execute } = await stack(options);
    for (const descriptor of ACCESS_WRITES) {
      const result = await execute(descriptor.operationId, argumentsFor(descriptor));
      expect(result, descriptor.operationId).toMatchObject({ status: 'denied', error: { code } });
    }
    expect(h.mock.requests).toEqual([]);
    await h.close();
  });

  it('keeps PINs, purchases, emergency, webhooks and the certificate off until enabled', async () => {
    const { h, execute } = await stack({ enable: [] });
    for (const operationId of DEFAULT_DISABLED) {
      const result = await execute(operationId, argumentsFor(byId(operationId)));
      expect(result, operationId).toMatchObject({
        status: 'denied',
        error: { code: 'operation_disabled' },
      });
    }
    expect(h.mock.requests).toEqual([]);
    await h.close();
  });

  it('refuses writes about people and credentials without their sensitive grants', async () => {
    const { h, execute } = await stack({ sensitive: [] });
    for (const descriptor of ACCESS_WRITES.filter((d) => d.sensitivityTags.length > 0)) {
      const result = await execute(descriptor.operationId, argumentsFor(descriptor));
      expect(result.error?.code, descriptor.operationId).toBe('sensitive_scope_missing');
    }
    expect(h.mock.requests).toEqual([]);
    await h.close();
  });

  it('keeps door control apart: door-group rights do not open doors', async () => {
    const { h, execute } = await stack({ allow: ['access.spaces.write'] });
    const unlock = await execute('access.doors.unlock', { id: 'door-1' });
    expect(unlock).toMatchObject({ status: 'denied', error: { code: 'not_granted_to_client' } });
    h.mock.respond = (_req, res) => {
      sendJson(res, 200, envelope({ data: { id: 'g1', name: 'Front' } }));
    };
    const group = await execute('access.spaces.create_door_group', {
      body: { group_name: 'Front', resources: ['door-1'] },
    });
    expect(group.status).toBe('ok');
    expect(h.mock.requests).toHaveLength(1);
    await h.close();

    const doors = await stack({ allow: ['access.doors.write'] });
    expect((await doors.execute('access.doors.unlock', { id: 'door-1' })).status).toBe(
      'approval_required',
    );
    expect(doors.h.mock.requests).toEqual([]);
    await doors.h.close();
  });

  it('never lets a policy lower a physical-access write, and can raise a medium one', async () => {
    const lowered = await stack({
      riskElevations: [{ selector: 'access.doors.write', risk: 'medium' }],
    });
    expect((await lowered.execute('access.doors.unlock', { id: 'door-1' })).status).toBe(
      'approval_required',
    );
    expect(lowered.h.mock.requests).toEqual([]);
    await lowered.h.close();

    const raised = await stack({
      riskElevations: [{ selector: 'access.spaces.write', risk: 'high' }],
    });
    const group = await raised.execute('access.spaces.create_door_group', {
      body: { group_name: 'Front', resources: ['door-1'] },
    });
    expect(group.status).toBe('approval_required');
    expect(raised.h.mock.requests).toEqual([]);
    await raised.h.close();
  });

  it('refuses the actor fields of an unlock and arguments the declared version lacks', async () => {
    const { h, execute } = await stack({ version: '4.1.0' });
    const actor = await execute('access.doors.unlock', {
      id: 'door-1',
      body: { actor_id: 'u1', actor_name: 'Someone Else' },
    });
    expect(actor.error?.code).toBe('invalid_arguments');
    const gate = await execute('access.doors.unlock', { id: 'door-1', control_cmd: 'open' });
    expect(gate.error?.code).toBe('operation_unsupported');
    expect(gate.error?.message).toContain('control_cmd needs access 4.2.16 or later');
    expect(h.mock.requests).toEqual([]);
    await h.close();
  });

  it('sends an approved unlock without a body, so the console names no actor', async () => {
    const { h, dispatcher, approvals, execute } = await stack();
    h.mock.respond = (_req, res) => {
      sendJson(res, 200, envelope({ data: 'success' }));
    };
    const pending = await execute('access.doors.unlock', { id: 'door-1', reader_id: 'r1' });
    approvals.approve(pending.approvalId ?? '', APPROVER);
    const result = await dispatcher.resume(PRINCIPAL, pending.approvalId ?? '');
    expect(result).toMatchObject({ status: 'ok', outcome: 'succeeded', data: null });
    expect(h.mock.requests).toMatchObject([
      { method: 'PUT', url: '/api/v1/developer/doors/door-1/unlock?reader_id=r1', body: '' },
    ]);
    await h.close();
  });

  it('reports a refusal by the console as failed, never as uncertain, and never retries', async () => {
    const { h, execute } = await stack();
    h.mock.respond = (_req, res) => {
      sendJson(res, 200, {
        ...envelope({ data: null }, 'CODE_PARAMS_INVALID'),
        msg: 'SENTINEL-VENDOR-MSG',
      });
    };
    const result = await execute(
      'access.policies.create_schedule',
      argumentsFor(byId('access.policies.create_schedule')),
    );
    expect(result).toMatchObject({
      status: 'error',
      outcome: 'failed',
      error: { code: 'upstream_rejected' },
    });
    expect(JSON.stringify(result)).not.toContain('SENTINEL');
    expect(h.mock.requests).toHaveLength(1);
    await h.close();
  });

  it.each([
    ['a success status without a result code', { data: null }],
    ['a transient system error', envelope({ data: null }, 'CODE_SYSTEM_ERROR')],
  ])('reports %s as an uncertain outcome and never retries', async (_name, body) => {
    const { h, execute } = await stack();
    h.mock.respond = (_req, res) => {
      sendJson(res, 200, body);
    };
    const descriptor = byId('access.policies.create');
    const result = await execute(descriptor.operationId, argumentsFor(descriptor));
    expect(result).toMatchObject({ status: 'error', outcome: 'outcome_unknown' });
    expect(h.mock.requests).toHaveLength(1);
    await h.close();
  });

  it('runs a repeated request with the same idempotency key only once', async () => {
    const { h, execute } = await stack();
    const descriptor = byId('access.credentials.update_nfc_card');
    h.mock.respond = (_req, res) => {
      sendJson(res, 200, envelope({ data: 'success' }));
    };
    const args = argumentsFor(descriptor);
    const first = await execute(descriptor.operationId, args, 'card-alias-1');
    const second = await execute(descriptor.operationId, args, 'card-alias-1');
    expect(first.status).toBe('ok');
    expect(second.executionId).toBe(first.executionId);
    expect(h.mock.requests).toHaveLength(1);
    await h.close();
  });
});
