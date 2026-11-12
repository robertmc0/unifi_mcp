/**
 * Every documented Protect write (ADR 0019 §6), end to end against a synthetic console:
 * authorisation, human approval and single resumption for high risk, direct execution for
 * medium risk, default-disabled operations, duplicates, uncertain outcomes, and credential
 * handling (an arm-profile PIN in a request is sent to the console but never logged,
 * audited, shown to approvers or returned; talkback and stream URLs are never returned).
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
import { PROTECT_OPERATIONS, PROTECT_WRITES } from '@unifi-local-mcp/unifi-protect';
import { describe, expect, it } from 'vitest';
import type * as z from 'zod';
import { sendJson } from '../fixtures/mock-console.ts';
import { branches, sample } from '../fixtures/zod-samples.ts';
import { TEST_LIMITS } from '../unit/core/fixtures.ts';
import { useTempDirs } from '../unit/storage/fixtures.ts';
import { CLI, unifiHarness } from '../unit/unifi-api/fixtures.ts';

const tempDir = useTempDirs();
const inventory = await loadContractInventory(join(import.meta.dirname, '../../api-specs'));
const BASE = '/proxy/protect/integration';
const PROTECT_KEY = 'synthetic-protect-key-SENTINEL-44';
const PRINCIPAL = { clientId: 'operator' };
const APPROVER = { type: 'cli', id: 'root' } as const;
const UNLIMITED = { ratePerSecond: 10_000, burst: 10_000 };
/** A PIN must match ^\d{4,6}$, so its sentinel is a number nothing else contains. */
const PIN = '908172';
/**
 * The PIN as a value of its own: random ids and audit hashes are hex and can contain the
 * same six digits by chance, so digits run into hex characters do not count.
 */
const PIN_VALUE = new RegExp(`(?<![0-9a-f])${PIN}(?![0-9a-f])`, 'iu');
const QUALITIES = new Set(['high', 'medium', 'low', 'package']);
const DEFAULT_DISABLED = PROTECT_WRITES.filter((d) => d.defaultDisabled === true).map(
  (d) => d.operationId,
);

/** Credential sentinels: the PIN in requests, URLs in responses. */
const secretFor = (descriptor: OperationDescriptor) => (key: string) => {
  if (key === 'pin_code') return PIN;
  if (key === 'url') return 'SENTINEL-TALKBACK-URL';
  if (descriptor.operationId.endsWith('_rtsps_streams') && QUALITIES.has(key)) {
    return 'rtsps://h.invalid:7441/SENTINEL-STREAM-TOKEN?enableSrtp';
  }
  return undefined;
};

interface StackOptions {
  allow?: string[];
  forceReadOnly?: boolean;
  moduleState?: 'read_only' | 'read_write';
  enable?: string[];
}

async function stack(options: StackOptions = {}) {
  const h = await unifiHarness({ dir: await tempDir() });
  h.consoles.setModulePort(h.consoleId, 'protect', h.mock.port, CLI);
  h.consoles.setCredential(h.consoleId, 'protect', PROTECT_KEY, CLI);
  h.policyStore.setRuntimeMode('read_write', CLI);
  const enable = options.enable ?? DEFAULT_DISABLED;
  if (enable.length > 0) {
    const current = h.policyStore.current();
    h.policyStore.replace({ ...current.document, enabledOperations: enable }, CLI, current.version);
  }
  h.consoles.setPolicy(
    h.consoleId,
    { modules: { protect: { state: options.moduleState ?? 'read_write' } } },
    CLI,
  );
  h.consoles.recordObservedVersion(h.consoleId, 'protect', '7.4.96');
  const registry = new OperationRegistry(inventory);
  for (const descriptor of PROTECT_OPERATIONS) registry.register(descriptor);
  registry.seal();
  const client = ClientPolicySchema.parse({
    clientId: PRINCIPAL.clientId,
    consoles: { [h.consoleId]: { sites: '*' } },
    allow: options.allow ?? ['protect.*.*'],
    sensitive: ['personal_identifier', 'location', 'camera_image'],
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
  const path = renderPath(descriptor.pathTemplate, args as Record<string, string | number>);
  const query = new URLSearchParams();
  for (const name of descriptor.queryParameters ?? []) {
    const value = args[name];
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) query.append(name, String(item as string | number | boolean));
    }
  }
  const text = query.toString();
  return `${BASE}${path}${text === '' ? '' : `?${text}`}`;
}

function request(
  descriptor: OperationDescriptor,
  consoleId: string,
  args: Record<string, unknown>,
) {
  return { operationId: descriptor.operationId, consoleId, arguments: args };
}

function byId(operationId: string): OperationDescriptor {
  const d = PROTECT_WRITES.find((w) => w.operationId === operationId);
  if (d === undefined) throw new Error(operationId);
  return d;
}

describe('every documented Protect write', () => {
  it('is registered: 41 writes, 25 high risk with approval, 16 medium', () => {
    expect(PROTECT_WRITES).toHaveLength(41);
    expect(PROTECT_WRITES.filter((d) => d.risk === 'high' && d.approvalRequired)).toHaveLength(25);
    expect(PROTECT_WRITES.filter((d) => d.risk === 'medium' && !d.approvalRequired)).toHaveLength(
      16,
    );
    expect(DEFAULT_DISABLED.sort()).toEqual([
      'protect.cameras.disable_microphone_permanently',
      'protect.cameras.start_talkback',
    ]);
    for (const d of PROTECT_WRITES) {
      expect(d.effect, d.operationId).toBe('write');
      expect(d.siteScoped, d.operationId).toBe(false);
      expect(typeof d.resourceLockKey, d.operationId).toBe('function');
    }
  });

  it('has valid synthetic arguments for every write and every body variant', () => {
    for (const d of PROTECT_WRITES) {
      for (let variant = 0; variant < branches(d.inputSchema); variant++) {
        const parsed = d.inputSchema.safeParse(argumentsFor(d, variant));
        expect(
          parsed.success,
          `${d.operationId} ${String(variant)}: ${JSON.stringify(parsed.error?.issues)}`,
        ).toBe(true);
      }
    }
  });

  it('puts the PIN sentinel into the arm-profile requests it checks', () => {
    for (const operationId of [
      'protect.alarm.create_external_profile',
      'protect.alarm.update_external_profile',
    ]) {
      const descriptor = byId(operationId);
      const all = Array.from({ length: branches(descriptor.inputSchema) }, (_, v) =>
        JSON.stringify(argumentsFor(descriptor, v)),
      ).join('');
      expect(all, operationId).toContain(PIN);
    }
  });

  for (const descriptor of PROTECT_WRITES) {
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
          const shown = JSON.stringify(approvals.get(approvalId));
          expect(shown, label).not.toContain('SENTINEL');
          expect(shown, label).not.toMatch(PIN_VALUE);
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
        expect(sent?.headers['x-api-key'], label).toBe(PROTECT_KEY);
        if (descriptor.requestBody === 'json') {
          // The console receives exactly the validated body, credentials included.
          expect(JSON.parse(sent?.body ?? 'null'), label).toEqual(
            (descriptor.inputSchema.shape['body'] as z.ZodType).parse(args['body']),
          );
          expect(sent?.headers['content-type'], label).toBe('application/json');
        } else {
          expect(sent?.body, label).toBe('');
        }
        const returned = JSON.stringify(envelope);
        expect(returned, label).not.toContain('SENTINEL');
        expect(returned, label).not.toMatch(PIN_VALUE);
        expect(returned, label).not.toContain('rtsps://');
      }
      // Neither the audit trail nor the log ever holds a credential from a request.
      const audited = JSON.stringify(h.audit.list({ limit: 500 }));
      expect(audited).not.toContain('SENTINEL');
      expect(audited).not.toMatch(PIN_VALUE);
      expect(h.log.lines.join('\n')).not.toMatch(PIN_VALUE);
      await h.close();
    }, 60_000); // one round trip per body variant
  }
});

describe('Protect write authorisation', () => {
  it.each([
    ['read-only grants', { allow: ['protect.*.read'] }, 'not_granted_to_client'],
    ['the hard lock', { forceReadOnly: true }, 'hard_read_only'],
    ['a read-only module', { moduleState: 'read_only' as const }, 'module_read_only'],
  ])('refuses every write under %s, sending nothing', async (_name, options, code) => {
    const { h, dispatcher } = await stack(options);
    for (const descriptor of PROTECT_WRITES) {
      const envelope = await dispatcher.execute(
        PRINCIPAL,
        request(descriptor, h.consoleId, argumentsFor(descriptor)),
      );
      expect(envelope, descriptor.operationId).toMatchObject({ status: 'denied', error: { code } });
    }
    expect(h.mock.requests).toEqual([]);
    await h.close();
  });

  it('keeps the permanent microphone disable and talkback off until a global policy enables them', async () => {
    const { h, dispatcher } = await stack({ enable: [] });
    for (const operationId of DEFAULT_DISABLED) {
      const descriptor = byId(operationId);
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

  it('lets a client be granted cameras without the alarm (category permissions)', async () => {
    const { h, dispatcher } = await stack({ allow: ['protect.cameras.write'] });
    const arm = byId('protect.alarm.arm_external_profile');
    const denied = await dispatcher.execute(
      PRINCIPAL,
      request(arm, h.consoleId, argumentsFor(arm)),
    );
    expect(denied).toMatchObject({ status: 'denied', error: { code: 'not_granted_to_client' } });
    const ptz = byId('protect.cameras.ptz_goto');
    h.mock.respond = (_req, res) => {
      sendJson(res, 200, {});
    };
    const moved = await dispatcher.execute(PRINCIPAL, request(ptz, h.consoleId, argumentsFor(ptz)));
    expect(moved.status).toBe('ok');
    expect(h.mock.requests).toHaveLength(1);
    await h.close();
  });

  it('runs a repeated request with the same idempotency key only once', async () => {
    const { h, dispatcher } = await stack();
    const descriptor = byId('protect.lights.update');
    h.mock.respond = (_req, res) => {
      sendJson(res, 200, sample(descriptor.outputSchema));
    };
    const call = {
      ...request(descriptor, h.consoleId, argumentsFor(descriptor)),
      idempotencyKey: 'porch-light-7',
    };
    const first = await dispatcher.execute(PRINCIPAL, call);
    const second = await dispatcher.execute(PRINCIPAL, call);
    expect(first.status).toBe('ok');
    expect(second.executionId).toBe(first.executionId);
    expect(h.mock.requests).toHaveLength(1);
    await h.close();
  });

  it('reports an uncertain outcome for a siren test and never retries it', async () => {
    const { h, dispatcher } = await stack();
    const descriptor = byId('protect.sirens.test_sound');
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
