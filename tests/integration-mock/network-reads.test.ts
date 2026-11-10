/**
 * Every documented Network read (ADR 0018 §4), end to end: dispatcher → registry (real
 * contract inventory) → HTTPS executor → synthetic console. For each read and each union
 * variant of its response:
 *
 * - exactly one GET to the documented path, with the stored key and no body;
 * - the console's response, filled with every documented field, carries credential
 *   sentinels (Wi-Fi passphrases, voucher codes) and an undocumented field in every
 *   object; none of them reaches the client;
 * - list operations return their items as `data` and the paging facts as `pagination`.
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
import { NETWORK_OPERATIONS, NETWORK_READS } from '@unifi-local-mcp/unifi-network';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { sendJson } from '../fixtures/mock-console.ts';
import { branches, sample } from '../fixtures/zod-samples.ts';
import { TEST_LIMITS } from '../unit/core/fixtures.ts';
import { useTempDirs } from '../unit/storage/fixtures.ts';
import { CLI, NETWORK_KEY, unifiHarness } from '../unit/unifi-api/fixtures.ts';

const tempDir = useTempDirs();
const inventory = await loadContractInventory(join(import.meta.dirname, '../../api-specs'));
const SITE = '00000000-0000-4000-8000-00000000a51e';
const BASE = '/proxy/network/integration';
const PRINCIPAL = { clientId: 'reader' };
const UNLIMITED = { ratePerSecond: 10_000, burst: 10_000 };

const secretFor = (descriptor: OperationDescriptor) => (key: string) => {
  if (key === 'passphrase') return 'SENTINEL-PASSPHRASE';
  if (key === 'code' && descriptor.category === 'hotspot') return 'SENTINEL-VOUCHER-CODE';
  return undefined;
};
const EXTRA = ['undocumentedField', 'SENTINEL-UNDOCUMENTED'] as const;

async function stack(sensitive: string[] = ['personal_identifier', 'network_identity']) {
  const h = await unifiHarness({ dir: await tempDir() });
  h.consoles.setPolicy(h.consoleId, { modules: { network: { state: 'read_only' } } }, CLI);
  h.consoles.recordObservedVersion(h.consoleId, 'network', '11.0.97');
  const registry = new OperationRegistry(inventory);
  for (const descriptor of NETWORK_OPERATIONS) registry.register(descriptor);
  registry.seal();
  const client = ClientPolicySchema.parse({
    clientId: PRINCIPAL.clientId,
    consoles: { [h.consoleId]: { sites: '*' } },
    allow: ['network.*.read'],
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
    // Each read runs once per response variant (up to ~25): no rate limiting here.
    limits: {
      ...TEST_LIMITS,
      rate: {
        client: UNLIMITED,
        console: UNLIMITED,
        module: UNLIMITED,
        global: UNLIMITED,
      },
    },
  });
  return { h, dispatcher, registry };
}

/** Arguments for a read: its required arguments, plus paging and a filter where offered. */
function argumentsFor(descriptor: OperationDescriptor): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(descriptor.inputSchema.shape)) {
    if (!(field as z.ZodType).safeParse(undefined).success) {
      args[key] = sample(field as z.ZodType, {}, key);
    }
  }
  const query = descriptor.queryParameters ?? [];
  if (query.includes('limit')) args['limit'] = 2;
  if (query.includes('offset')) args['offset'] = 0;
  if (query.includes('filter')) args['filter'] = "name.eq('Office AP')";
  return args;
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

describe('every documented Network read', () => {
  it('is registered: 41 reads, all GET, all low risk, none needing approval', () => {
    expect(NETWORK_READS).toHaveLength(41);
    for (const read of NETWORK_READS) {
      expect(read, read.operationId).toMatchObject({
        effect: 'read',
        httpMethod: 'GET',
        risk: 'low',
        approvalRequired: false,
        retryClass: 'safe-read',
      });
    }
  });

  for (const descriptor of NETWORK_READS) {
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
          ...(descriptor.siteScoped ? { siteId: SITE } : {}),
          arguments: args,
        });
        const label = `${descriptor.operationId} variant ${String(variant)}`;
        expect(envelope.status, `${label}: ${JSON.stringify(envelope.error)}`).toBe('ok');
        expect(h.mock.requests, label).toHaveLength(1);
        const request = h.mock.requests[0];
        expect(request?.method, label).toBe('GET');
        expect(request?.url, label).toBe(expectedUrl(descriptor, args));
        expect(request?.headers['x-api-key'], label).toBe(NETWORK_KEY);
        expect(request?.body, label).toBe('');
        const returned = JSON.stringify(envelope);
        expect(returned, label).not.toContain('SENTINEL');
        expect(returned, label).not.toContain(NETWORK_KEY);
        expect(returned, label).toContain('v:'); // documented values do come through
        if ((descriptor.queryParameters ?? []).includes('limit')) {
          expect(Array.isArray(envelope.data), label).toBe(true);
          expect(envelope.pagination, label).toMatchObject({
            offset: expect.any(Number) as unknown,
            limit: expect.any(Number) as unknown,
            count: expect.any(Number) as unknown,
            totalCount: expect.any(Number) as unknown,
          });
        }
      }
      await h.close();
    });
  }

  it('exercises the credential sentinels it checks for', () => {
    const responses = (operationId: string): string => {
      const descriptor = NETWORK_READS.find((d) => d.operationId === operationId);
      if (descriptor === undefined) throw new Error(operationId);
      return Array.from({ length: branches(descriptor.outputSchema) }, (_, variant) =>
        JSON.stringify(sample(descriptor.outputSchema, { variant, secret: secretFor(descriptor) })),
      ).join('');
    };
    expect(responses('network.wifi.get')).toContain('SENTINEL-PASSPHRASE');
    expect(responses('network.hotspot.list_vouchers')).toContain('SENTINEL-VOUCHER-CODE');
    expect(responses('network.hotspot.get_voucher')).toContain('SENTINEL-VOUCHER-CODE');
  });

  it('keeps harmless fields named like credentials (country codes)', async () => {
    const { h, dispatcher } = await stack();
    h.mock.respond = (_req, res) => {
      sendJson(res, 200, {
        offset: 0,
        limit: 25,
        count: 1,
        totalCount: 1,
        data: [{ code: 'NZ', name: 'New Zealand' }],
      });
    };
    const envelope = await dispatcher.execute(PRINCIPAL, {
      operationId: 'network.reference.list_countries',
      consoleId: h.consoleId,
    });
    expect(envelope.data).toEqual([{ code: 'NZ', name: 'New Zealand' }]);
    await h.close();
  });

  it('pages: nextOffset only while more items remain', async () => {
    const { h, dispatcher } = await stack();
    const page = (offset: number) => ({
      offset,
      limit: 2,
      count: 2,
      totalCount: 3,
      data: [{ id: 'a', name: 'A', internalReference: 'default' }],
    });
    for (const [offset, next] of [
      [0, 2],
      [2, undefined],
    ] as const) {
      h.mock.respond = (_req, res) => {
        sendJson(res, 200, { ...page(offset), count: offset === 0 ? 2 : 1 });
      };
      const envelope = await dispatcher.execute(PRINCIPAL, {
        operationId: 'network.sites.list',
        consoleId: h.consoleId,
        arguments: { offset, limit: 2 },
      });
      expect(envelope.pagination?.['nextOffset' as never]).toBe(next);
    }
    await h.close();
  });

  it('refuses client data without the sensitive grants, sending nothing', async () => {
    const { h, dispatcher } = await stack([]);
    for (const operationId of ['network.clients.list', 'network.clients.get']) {
      const envelope = await dispatcher.execute(PRINCIPAL, {
        operationId,
        consoleId: h.consoleId,
        siteId: SITE,
        arguments: operationId.endsWith('.get')
          ? { clientId: '00000000-0000-4000-8000-000000000c11' }
          : {},
      });
      expect(envelope).toMatchObject({
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
      sendJson(res, 200, { data: [] }); // no paging facts
    };
    const envelope = await dispatcher.execute(PRINCIPAL, {
      operationId: 'network.devices.list',
      consoleId: h.consoleId,
      siteId: SITE,
    });
    expect(envelope).toMatchObject({
      status: 'error',
      error: { code: 'upstream_contract_mismatch' },
    });
    await h.close();
  });

  it('describes every read with a JSON schema of its arguments', async () => {
    const { h, registry } = await stack();
    for (const descriptor of NETWORK_READS) {
      expect(
        registry.inputJsonSchema(descriptor.operationId),
        descriptor.operationId,
      ).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
    }
    await h.close();
  });
});
