/**
 * Every Access read (ADR 0023 §3), end to end: dispatcher → registry (real contract
 * inventory) → HTTPS executor → synthetic Access API on its own port, with a declared
 * version (ADR 0021 §5). For each read:
 *
 * - exactly one request with the documented method, path and query, the bearer token, and
 *   a body only for the system-log query;
 * - the console's answer, inside the result envelope, fills every documented field and
 *   carries credential sentinels (webhook secret and headers, PIN hashes) and an
 *   undocumented field in every object; none of them, and no vendor `msg`, reaches the
 *   client, which receives `data` and the paging facts;
 * - the result carries the "declared, not observed" warning.
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
import { ACCESS_OPERATIONS, ACCESS_READS } from '@unifi-local-mcp/unifi-access';
import { loadContractInventory } from '@unifi-local-mcp/unifi-api';
import { describe, expect, it } from 'vitest';
import type * as z from 'zod';
import { envelope } from '../fixtures/access-console.ts';
import { sendJson } from '../fixtures/mock-console.ts';
import { sample } from '../fixtures/zod-samples.ts';
import { TEST_LIMITS } from '../unit/core/fixtures.ts';
import { useTempDirs } from '../unit/storage/fixtures.ts';
import { CLI, unifiHarness } from '../unit/unifi-api/fixtures.ts';

const tempDir = useTempDirs();
const inventory = await loadContractInventory(join(import.meta.dirname, '../../api-specs'));
const TOKEN = 'synthetic-access-token-SENTINEL-61';
const PRINCIPAL = { clientId: 'viewer' };
const UNLIMITED = { ratePerSecond: 10_000, burst: 10_000 };
const ALL_SENSITIVE = [
  'personal_identifier',
  'biometric_or_access_identity',
  'access_log',
  'recording',
];
const LOGS = 'access.logs.list';
const DAY = 24 * 60 * 60;
const LOG_ARGS = {
  body: { topic: 'door_openings', since: 1_700_000_000, until: 1_700_000_000 + DAY },
};
const EXTRA = ['undocumentedField', 'SENTINEL-UNDOCUMENTED'] as const;

async function stack(options: { sensitive?: string[]; version?: string | null } = {}) {
  const h = await unifiHarness({ dir: await tempDir() });
  h.consoles.setCredential(h.consoleId, 'access', TOKEN, CLI);
  h.consoles.setPolicy(h.consoleId, { modules: { access: { state: 'read_only' } } }, CLI);
  const version = options.version === undefined ? '4.2.16' : options.version;
  if (version !== null) h.consoles.declareVersion(h.consoleId, 'access', version, CLI);
  const registry = new OperationRegistry(inventory);
  for (const descriptor of ACCESS_OPERATIONS) registry.register(descriptor);
  registry.seal();
  const client = ClientPolicySchema.parse({
    clientId: PRINCIPAL.clientId,
    consoles: { [h.consoleId]: { sites: '*' } },
    allow: ['access.*.read'],
    sensitive: options.sensitive ?? ALL_SENSITIVE,
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
    deployment: { forceReadOnly: true },
    audit: h.audit,
    executions: new ExecutionStore(h.storage.db),
    logger: h.log.logger,
    limits: {
      ...TEST_LIMITS,
      rate: { client: UNLIMITED, console: UNLIMITED, module: UNLIMITED, global: UNLIMITED },
    },
  });
  const read = (operationId: string, args: Record<string, unknown> = {}) =>
    dispatcher.execute(PRINCIPAL, { operationId, consoleId: h.consoleId, arguments: args });
  return { h, dispatcher, read };
}

/** The required arguments of a read (and a valid window for the log query). */
function argumentsFor(descriptor: OperationDescriptor): Record<string, unknown> {
  if (descriptor.operationId === LOGS) return LOG_ARGS;
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
  return `${path}${text === '' ? '' : `?${text}`}`;
}

/** Credential sentinels by field name (`token` only inside `pin_code`, set below). */
const secret = (key: string) => (key === 'secret' ? 'SENTINEL-WEBHOOK-SECRET' : undefined);

/** Puts a PIN-hash sentinel into every `pin_code` object of a sample. */
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

describe('every Access read', () => {
  it('is registered: 39 reads, low risk, console-level, none needing approval', () => {
    expect(ACCESS_READS).toHaveLength(39);
    for (const read of ACCESS_READS) {
      expect(read, read.operationId).toMatchObject({
        moduleId: 'access',
        effect: 'read',
        httpMethod: read.operationId === LOGS ? 'POST' : 'GET',
        risk: 'low',
        approvalRequired: false,
        siteScoped: false,
        retryClass: 'safe-read',
      });
      expect(read.apiVersionRange, read.operationId).toMatch(/^>=\d+\.\d+\.\d+ <=4\.2\.16$/);
    }
  });

  it('returns sanitised data from one documented request, labelled as declared', async () => {
    const { h, read } = await stack();
    for (const descriptor of ACCESS_READS) {
      const label = descriptor.operationId;
      const payload = withPinHashes(sample(descriptor.outputSchema, { secret, extra: EXTRA }));
      h.mock.requests.length = 0;
      h.mock.respond = (_req, res) => {
        sendJson(res, 200, { ...envelope(payload as object), msg: 'SENTINEL-VENDOR-MSG' });
      };
      const args = argumentsFor(descriptor);
      const result = await read(descriptor.operationId, args);
      expect(result.status, `${label}: ${JSON.stringify(result.error)}`).toBe('ok');
      expect(h.mock.requests, label).toHaveLength(1);
      const request = h.mock.requests[0];
      expect(request?.method, label).toBe(descriptor.httpMethod);
      expect(request?.url, label).toBe(expectedUrl(descriptor, args));
      expect(request?.headers['authorization'], label).toBe(`Bearer ${TOKEN}`);
      expect(request?.body, label).toBe(
        descriptor.requestBody === 'json' ? JSON.stringify(args['body']) : '',
      );
      const returned = JSON.stringify(result);
      expect(returned, label).not.toContain('SENTINEL');
      expect(returned, label).not.toContain('"headers"');
      expect(result.warnings?.[0], label).toMatch(/declared by an administrator, not observed/);
    }
    await h.close();
  }, 60_000);

  it('exercises the credential sentinels it checks for', () => {
    const raw = (operationId: string): string => {
      const descriptor = ACCESS_READS.find((d) => d.operationId === operationId);
      if (descriptor === undefined) throw new Error(operationId);
      return JSON.stringify(withPinHashes(sample(descriptor.outputSchema, { secret })));
    };
    expect(raw('access.webhooks.list_endpoints')).toContain('SENTINEL-WEBHOOK-SECRET');
    expect(raw('access.webhooks.list_endpoints')).toContain('"headers"');
    for (const operationId of ['access.users.get', 'access.visitors.list']) {
      expect(raw(operationId), operationId).toContain('SENTINEL-PIN-HASH');
    }
  });

  it('keeps a PIN assignment visible without its hash, and returns paging facts', async () => {
    const { h, read } = await stack();
    h.mock.respond = (_req, res) => {
      sendJson(
        res,
        200,
        envelope({
          data: [{ id: 'u1', first_name: 'A', pin_code: { token: 'SENTINEL-PIN-HASH' } }],
          pagination: { page_num: 1, page_size: 1, total: 3 },
        }),
      );
    };
    const result = await read('access.users.list');
    expect(result.data).toEqual([{ id: 'u1', first_name: 'A', pin_code: {} }]);
    expect(result.pagination).toEqual({ pageNum: 1, pageSize: 1, total: 3, nextPageNum: 2 });
    await h.close();
  });

  it('refuses people, cards, plates and logs without their sensitive grants, sending nothing', async () => {
    const { h, read } = await stack({ sensitive: [] });
    for (const [operationId, args] of [
      ['access.users.list', {}],
      ['access.users.get', { id: 'u1' }],
      ['access.user_groups.list_users', { id: 'g1' }],
      ['access.visitors.list', {}],
      ['access.credentials.list_nfc_cards', {}],
      ['access.credentials.get_nfc_enrollment', { id: 's1' }],
      ['access.credentials.list_touch_passes', {}],
      [LOGS, LOG_ARGS],
      ['access.logs.get_resource', { id: 'r1' }],
    ] as const) {
      const result = await read(operationId, args);
      expect(result.error?.code, operationId).toBe('sensitive_scope_missing');
    }
    expect(h.mock.requests).toEqual([]);
    // Infrastructure needs no grant.
    h.mock.respond = (_req, res) => {
      sendJson(res, 200, envelope({ data: [] }));
    };
    expect((await read('access.spaces.list_doors')).status).toBe('ok');
    await h.close();
  });

  it('bounds every log read to 31 days and 100 entries a page (spec §6.4)', async () => {
    const { h, read } = await stack();
    const since = 1_700_000_000;
    for (const args of [
      { body: { topic: 'door_openings' } },
      { body: { topic: 'door_openings', since } },
      { body: { topic: 'door_openings', since, until: since + 32 * DAY } },
      { body: { topic: 'door_openings', since, until: since } },
      { ...LOG_ARGS, page_size: '101' },
      { ...LOG_ARGS, page_size: 'all' },
    ]) {
      expect((await read(LOGS, args)).error?.code, JSON.stringify(args)).toBe('invalid_arguments');
    }
    expect(h.mock.requests).toEqual([]);
    h.mock.respond = (_req, res) => {
      sendJson(res, 200, envelope({ data: { hits: [] }, page: 1, total: 0 }));
    };
    const ok = await read(LOGS, {
      body: { topic: 'door_openings', since, until: since + 31 * DAY },
      page_size: '100',
    });
    expect(ok).toMatchObject({
      status: 'ok',
      data: { hits: [] },
      pagination: { pageNum: 1, total: 0 },
    });
    await h.close();
  });

  it('refuses what the declared version cannot do, naming why, and sends nothing', async () => {
    const old = await stack({ version: '1.21.0' });
    const expand = await old.read('access.visitors.list', { 'expand[]': 'schedule' });
    expect(expand.error?.code).toBe('operation_unsupported');
    expect(expand.error?.message).toContain('The argument expand[] needs access 1.22.16 or later');
    expect(expand.error?.message).toContain('declared, not observed');
    // §10.6 states 2.2.0 but needs 2.2.6, the user groups it reads (ADR 0021 §3).
    expect((await old.read('access.identity.list_group_resources', { id: 'g1' })).error?.code).toBe(
      'operation_unsupported',
    );
    expect(old.h.mock.requests).toEqual([]);
    await old.h.close();

    const current = await stack({ version: '4.3.24' });
    expect((await current.read('access.spaces.list_doors')).error?.message).toContain(
      'verified for >=1.9.1 <=4.2.16',
    );
    await current.h.close();

    const undeclared = await stack({ version: null });
    const unknown = await undeclared.read('access.spaces.list_doors');
    expect(unknown.error?.code).toBe('version_unknown');
    expect(unknown.error?.message).toContain('A host administrator must declare it');
    expect(undeclared.h.mock.requests).toEqual([]);
    await undeclared.h.close();
  });
});
