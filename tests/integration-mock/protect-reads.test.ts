/**
 * Every documented Protect HTTP read (ADR 0019 §5), end to end: dispatcher → registry (real
 * contract inventory) → HTTPS executor → synthetic console. For each read and each union
 * variant of its response:
 *
 * - exactly one GET to the documented path, with the stored key and no body;
 * - the console's response, filled with every documented field, carries credential
 *   sentinels (talkback URL, arm profile PIN, RTSPS stream URLs) and an undocumented field
 *   in every object; none of them reaches the client;
 * - the snapshot arrives as bytes, never as JSON.
 */
import { join } from 'node:path';
import {
  Dispatcher,
  ExecutionStore,
  OperationRegistry,
  renderPath,
  type OperationDescriptor,
} from '@unifi-local-mcp/core';
import { ClientPolicySchema } from '@unifi-local-mcp/policy';
import { loadContractInventory } from '@unifi-local-mcp/unifi-api';
import { PROTECT_OPERATIONS, PROTECT_READS } from '@unifi-local-mcp/unifi-protect';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { sendJson } from '../fixtures/mock-console.ts';
import { branches, sample } from '../fixtures/zod-samples.ts';
import { JPEG, TEST_LIMITS } from '../unit/core/fixtures.ts';
import { useTempDirs } from '../unit/storage/fixtures.ts';
import { CLI, unifiHarness } from '../unit/unifi-api/fixtures.ts';

const tempDir = useTempDirs();
const inventory = await loadContractInventory(join(import.meta.dirname, '../../api-specs'));
const BASE = '/proxy/protect/integration';
const PROTECT_KEY = 'synthetic-protect-key-SENTINEL-43';
const PRINCIPAL = { clientId: 'viewer' };
const UNLIMITED = { ratePerSecond: 10_000, burst: 10_000 };
const ALL_SENSITIVE = ['personal_identifier', 'location', 'camera_image'];
const SNAPSHOT = 'protect.cameras.get_snapshot';
const STREAMS = 'protect.cameras.get_rtsps_streams';
const QUALITIES = new Set(['high', 'medium', 'low', 'package']);

const secretFor = (descriptor: OperationDescriptor) => (key: string) => {
  if (key === 'url') return 'SENTINEL-TALKBACK-URL';
  if (key === 'pin_code') return 'SENTINEL-PIN';
  if (descriptor.operationId === STREAMS && QUALITIES.has(key)) {
    return 'rtsps://h.invalid:7441/SENTINEL-STREAM-TOKEN?enableSrtp';
  }
  return undefined;
};
const EXTRA = ['undocumentedField', 'SENTINEL-UNDOCUMENTED'] as const;

async function stack(sensitive: string[] = ALL_SENSITIVE) {
  const h = await unifiHarness({ dir: await tempDir() });
  h.consoles.setModulePort(h.consoleId, 'protect', h.mock.port, CLI);
  h.consoles.setCredential(h.consoleId, 'protect', PROTECT_KEY, CLI);
  h.consoles.setPolicy(h.consoleId, { modules: { protect: { state: 'read_only' } } }, CLI);
  h.consoles.recordObservedVersion(h.consoleId, 'protect', '7.4.96');
  const registry = new OperationRegistry(inventory);
  for (const descriptor of PROTECT_OPERATIONS) registry.register(descriptor);
  registry.seal();
  const client = ClientPolicySchema.parse({
    clientId: PRINCIPAL.clientId,
    consoles: { [h.consoleId]: { sites: '*' } },
    allow: ['protect.*.read'],
    sensitive,
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
    deployment: { forceReadOnly: true },
    audit: h.audit,
    executions: new ExecutionStore(h.storage.db),
    logger: h.log.logger,
    // Each read runs once per response variant: no rate limiting here.
    limits: {
      ...TEST_LIMITS,
      rate: { client: UNLIMITED, console: UNLIMITED, module: UNLIMITED, global: UNLIMITED },
    },
  });
  return { h, dispatcher };
}

/** The required arguments of a read. */
function argumentsFor(descriptor: OperationDescriptor): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(descriptor.inputSchema.shape)) {
    if (!(field as z.ZodType).safeParse(undefined).success) {
      args[key] = sample(field as z.ZodType, {}, key);
    }
  }
  return args;
}

function expectedUrl(descriptor: OperationDescriptor, args: Record<string, unknown>): string {
  const path = renderPath(descriptor.pathTemplate, args as Record<string, string | number>);
  const query = new URLSearchParams();
  for (const name of descriptor.queryParameters ?? []) {
    const value = args[name] as string | number | boolean | undefined;
    if (value !== undefined) query.append(name, String(value));
  }
  const text = query.toString();
  return `${BASE}${path}${text === '' ? '' : `?${text}`}`;
}

describe('every documented Protect read', () => {
  it('is registered: 38 reads, all GET, low risk, console-level, none needing approval', () => {
    expect(PROTECT_READS).toHaveLength(38);
    for (const read of PROTECT_READS) {
      expect(read, read.operationId).toMatchObject({
        moduleId: 'protect',
        effect: 'read',
        httpMethod: 'GET',
        risk: 'low',
        approvalRequired: false,
        siteScoped: false,
        retryClass: 'safe-read',
      });
    }
  });

  for (const descriptor of PROTECT_READS.filter((d) => d.operationId !== SNAPSHOT)) {
    it(`${descriptor.operationId} returns sanitised data from one documented GET`, async () => {
      const { h, dispatcher } = await stack();
      const variants = branches(descriptor.outputSchema);
      for (let variant = 0; variant < variants; variant++) {
        const response = sample(descriptor.outputSchema, {
          variant,
          secret: secretFor(descriptor),
          extra: EXTRA,
        });
        h.mock.requests.length = 0;
        h.mock.respond = (_req, res) => {
          sendJson(res, 200, response);
        };
        const args = argumentsFor(descriptor);
        const envelope = await dispatcher.execute(PRINCIPAL, {
          operationId: descriptor.operationId,
          consoleId: h.consoleId,
          arguments: args,
        });
        const label = `${descriptor.operationId} variant ${String(variant)}`;
        expect(envelope.status, `${label}: ${JSON.stringify(envelope.error)}`).toBe('ok');
        expect(h.mock.requests, label).toHaveLength(1);
        const request = h.mock.requests[0];
        expect(request?.method, label).toBe('GET');
        expect(request?.url, label).toBe(expectedUrl(descriptor, args));
        expect(request?.headers['x-api-key'], label).toBe(PROTECT_KEY);
        expect(request?.body, label).toBe('');
        const returned = JSON.stringify(envelope);
        expect(returned, label).not.toContain('SENTINEL');
        expect(returned, label).not.toContain('rtsps://');
        if (descriptor.operationId !== STREAMS) {
          // Documented values do come through (sample strings or sample ids).
          expect(returned, label).toMatch(/v:|00000000-0000-4000-8000-/);
        }
      }
      await h.close();
    }, 30_000);
  }

  it('exercises the credential sentinels it checks for', () => {
    const responses = (operationId: string): string => {
      const descriptor = PROTECT_READS.find((d) => d.operationId === operationId);
      if (descriptor === undefined) throw new Error(operationId);
      return Array.from({ length: branches(descriptor.outputSchema) }, (_, variant) =>
        JSON.stringify(sample(descriptor.outputSchema, { variant, secret: secretFor(descriptor) })),
      ).join('');
    };
    expect(responses(STREAMS)).toContain('SENTINEL-STREAM-TOKEN');
  });

  it('reports which RTSPS qualities exist, never their URLs', async () => {
    const { h, dispatcher } = await stack();
    h.mock.respond = (_req, res) => {
      sendJson(res, 200, {
        high: 'rtsps://h.invalid:7441/token-high?enableSrtp',
        medium: null,
        low: 'rtsps://h.invalid:7441/token-low?enableSrtp',
      });
    };
    const envelope = await dispatcher.execute(PRINCIPAL, {
      operationId: STREAMS,
      consoleId: h.consoleId,
      arguments: { id: 'camera-1' },
    });
    expect(envelope.data).toEqual({ high: true, medium: false, low: true });
    expect(JSON.stringify(envelope)).not.toContain('token');
    await h.close();
  });

  it('returns a snapshot as bytes with the camera_image grant', async () => {
    const { h, dispatcher } = await stack();
    h.mock.respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(Buffer.from(JPEG));
    };
    const envelope = await dispatcher.execute(PRINCIPAL, {
      operationId: SNAPSHOT,
      consoleId: h.consoleId,
      arguments: { id: 'camera-1', highQuality: 'true' },
    });
    expect(envelope).toMatchObject({
      status: 'ok',
      data: { mediaType: 'image/jpeg', bytes: JPEG.length },
    });
    expect(envelope.media?.data).toEqual(JPEG);
    expect(h.mock.requests[0]).toMatchObject({
      method: 'GET',
      url: `${BASE}/v1/cameras/camera-1/snapshot?highQuality=true`,
    });
    expect(h.mock.requests[0]?.headers['accept']).toBe('image/jpeg');
    await h.close();
  });

  it('refuses people, presence and images without their sensitive grants, sending nothing', async () => {
    const { h, dispatcher } = await stack([]);
    for (const [operationId, args] of [
      ['protect.users.list', {}],
      ['protect.users.get', { id: 'u1' }],
      ['protect.users.list_ulp', {}],
      ['protect.users.get_ulp', { id: 'u1' }],
      ['protect.fobs.list', {}],
      ['protect.fobs.get', { id: 'f1' }],
      [SNAPSHOT, { id: 'camera-1' }],
    ] as const) {
      const envelope = await dispatcher.execute(PRINCIPAL, {
        operationId,
        consoleId: h.consoleId,
        arguments: args,
      });
      expect(envelope, operationId).toMatchObject({
        status: 'denied',
        error: { code: 'sensitive_scope_missing' },
      });
    }
    expect(h.mock.requests).toEqual([]);
    await h.close();
  });

  it('refuses a response that lacks documented required fields', async () => {
    const { h, dispatcher } = await stack();
    h.mock.respond = (_req, res) => {
      sendJson(res, 200, [{ name: 'Front door' }]); // cameras without id, state, …
    };
    const envelope = await dispatcher.execute(PRINCIPAL, {
      operationId: 'protect.cameras.list',
      consoleId: h.consoleId,
    });
    expect(envelope).toMatchObject({
      status: 'error',
      error: { code: 'upstream_contract_mismatch' },
    });
    expect(JSON.stringify(envelope)).not.toContain('Front door');
    await h.close();
  });

  it('accepts an NVR without armMode.armProfileId, as a 7.3.74 console sends it (ADR 0019 §8)', async () => {
    const { h, dispatcher } = await stack();
    const nvrs = PROTECT_READS.find((d) => d.operationId === 'protect.nvrs.list');
    if (nvrs === undefined) throw new Error('protect.nvrs.list is not registered');
    const read = async (armProfileId: unknown) => {
      const nvr = sample(nvrs.outputSchema) as { armMode: Record<string, unknown> };
      if (armProfileId === undefined) delete nvr.armMode['armProfileId'];
      else nvr.armMode['armProfileId'] = armProfileId;
      h.mock.respond = (_req, res) => {
        sendJson(res, 200, nvr);
      };
      return dispatcher.execute(PRINCIPAL, {
        operationId: nvrs.operationId,
        consoleId: h.consoleId,
      });
    };
    const absent = await read(undefined);
    expect(absent.status, JSON.stringify(absent.error)).toBe('ok');
    expect((absent.data as { armMode: object }).armMode).not.toHaveProperty('armProfileId');
    expect(await read(null)).toMatchObject({
      status: 'ok',
      data: { armMode: { armProfileId: null } },
    });
    expect(await read('profile-1')).toMatchObject({
      status: 'ok',
      data: { armMode: { armProfileId: 'profile-1' } },
    });
    // Only absence is tolerated: a value of another type is still a contract mismatch, and
    // every other required field stays required.
    expect(await read(42)).toMatchObject({ error: { code: 'upstream_contract_mismatch' } });
    const withoutStatus = sample(nvrs.outputSchema) as { armMode: Record<string, unknown> };
    delete withoutStatus.armMode['status'];
    h.mock.respond = (_req, res) => {
      sendJson(res, 200, withoutStatus);
    };
    expect(
      await dispatcher.execute(PRINCIPAL, {
        operationId: nvrs.operationId,
        consoleId: h.consoleId,
      }),
    ).toMatchObject({ error: { code: 'upstream_contract_mismatch' } });
    await h.close();
  });
});
