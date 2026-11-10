/**
 * Dispatcher test harness: real storage, audit trail and policy store, an in-memory
 * security context, a synthetic contract inventory, and a scriptable executor that
 * records every upstream call. All operations and identifiers are synthetic.
 */
import { join } from 'node:path';
import {
  defineOperation,
  DEFAULT_DISPATCHER_LIMITS,
  Dispatcher,
  ExecutionStore,
  OperationRegistry,
  type ApprovalGate,
  type ContractInventory,
  type DispatcherLimits,
  type ExecutionCall,
  type ExecutorOutcome,
  type OperationDescriptor,
  type OperationExecutor,
  type Principal,
} from '@unifi-local-mcp/core';
import {
  ClientPolicySchema,
  ConsolePolicySchema,
  PolicyStore,
  type ClientPolicy,
  type ConsolePolicy,
} from '@unifi-local-mcp/policy';
import { databasePathFor, openStorage, type Storage } from '@unifi-local-mcp/storage';
import { AuditLog, AuditUnavailableError, type AuditEvent } from '@unifi-local-mcp/telemetry';
import * as z from 'zod';
import { testKey } from '../storage/fixtures.ts';
import { memoryLogger, type MemorySink } from '../telemetry/fixtures.ts';

export const CONSOLE = 'console-1';
export const SITE = 'site-1';
export const DEVICE_A = '11111111-1111-4111-8111-111111111111';
export const DEVICE_B = '22222222-2222-4222-8222-222222222222';
export const CLIENT: Principal = { clientId: 'client-1' };

const DOCUMENTED = new Set([
  'network 1.0 GET /v1/sites/{siteId}/devices',
  'network 1.0 GET /v1/info',
  'network 1.0 POST /v1/sites/{siteId}/devices/{deviceId}/actions',
  'network 1.0 POST /v1/sites/{siteId}/gateway/reboot',
]);

export const inventory: ContractInventory = (moduleId, revision, method, path) =>
  DOCUMENTED.has(`${moduleId} ${revision} ${method} ${path}`);

const common = {
  moduleId: 'network',
  documentationUrl: 'https://developer.invalid/network/1.0',
  contractRevision: '1.0',
  apiVersionRange: '>=1.0 <2',
  sensitivityTags: [],
  timeoutMs: 1000,
} as const;

export const listDevices = defineOperation({
  ...common,
  operationId: 'network.devices.list',
  category: 'devices',
  effect: 'read',
  permission: 'network.devices.read',
  risk: 'low',
  approvalRequired: false,
  siteScoped: true,
  description: 'List devices of a site.',
  httpMethod: 'GET',
  pathTemplate: '/v1/sites/{siteId}/devices',
  retryClass: 'safe-read',
  inputSchema: z.strictObject({ limit: z.number().int().min(1).max(200).optional() }),
  outputSchema: z.object({
    data: z.array(z.object({ id: z.string(), name: z.string(), macAddress: z.string() })),
  }),
  project: (output) => output.data.map(({ id, name }) => ({ id, name })),
});

export const getInfo = defineOperation({
  ...common,
  operationId: 'network.info.get',
  category: 'info',
  effect: 'read',
  permission: 'network.info.read',
  risk: 'low',
  approvalRequired: false,
  siteScoped: false,
  description: 'Application information.',
  httpMethod: 'GET',
  pathTemplate: '/v1/info',
  retryClass: 'safe-read',
  inputSchema: z.strictObject({}),
  outputSchema: z.object({ version: z.string() }),
});

export const restartDevice = defineOperation({
  ...common,
  operationId: 'network.devices.restart',
  category: 'devices',
  effect: 'write',
  permission: 'network.devices.write',
  risk: 'medium',
  approvalRequired: false,
  siteScoped: true,
  description: 'Restart a device.',
  httpMethod: 'POST',
  pathTemplate: '/v1/sites/{siteId}/devices/{deviceId}/actions',
  retryClass: 'non-idempotent',
  inputSchema: z.strictObject({ deviceId: z.uuid() }),
  outputSchema: z.object({ accepted: z.boolean() }),
  resourceLockKey: (args) => `device:${args.deviceId}`,
});

export const rebootGateway = defineOperation({
  ...common,
  operationId: 'network.gateway.reboot',
  category: 'gateway',
  effect: 'write',
  permission: 'network.gateway.write',
  risk: 'high',
  approvalRequired: true,
  siteScoped: true,
  description: 'Reboot the gateway.',
  httpMethod: 'POST',
  pathTemplate: '/v1/sites/{siteId}/gateway/reboot',
  retryClass: 'non-idempotent',
  inputSchema: z.strictObject({}),
  outputSchema: z.unknown(),
  resourceLockKey: () => 'gateway',
});

/** A latch: `promise` settles once `resolve()` is called. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export const DEVICES = {
  data: [
    { id: DEVICE_A, name: 'Office AP', macAddress: '00:00:5e:00:53:01' },
    { id: DEVICE_B, name: 'Lobby AP', macAddress: '00:00:5e:00:53:02' },
  ],
};

export class MockExecutor implements OperationExecutor {
  readonly calls: ExecutionCall[] = [];
  handler: (call: ExecutionCall) => ExecutorOutcome | Promise<ExecutorOutcome> = (call) =>
    call.descriptor.operationId === 'network.devices.list'
      ? { ok: true, data: DEVICES }
      : call.descriptor.operationId === 'network.info.get'
        ? { ok: true, data: { version: '1.0.0' } }
        : { ok: true, data: { accepted: true } };

  execute(call: ExecutionCall): Promise<ExecutorOutcome> {
    this.calls.push(call);
    return Promise.resolve(this.handler(call));
  }
}

/** An AuditLog that can be told to fail for selected events. */
export class FlakyAudit extends AuditLog {
  failWhen: ((event: AuditEvent) => boolean) | undefined;

  override record(event: AuditEvent): ReturnType<AuditLog['record']> {
    // Mirrors a storage failure: the audited operation must be refused.
    if (this.failWhen?.(event) === true) throw new AuditUnavailableError();
    return super.record(event);
  }
}

export interface Harness {
  storage: Storage;
  audit: FlakyAudit;
  log: MemorySink;
  policyStore: PolicyStore;
  executions: ExecutionStore;
  executor: MockExecutor;
  registry: OperationRegistry;
  clients: Map<string, ClientPolicy>;
  consoles: Map<string, ConsolePolicy>;
  dispatcher: Dispatcher;
  deployment: { forceReadOnly: boolean };
  auditActions(): string[];
}

export interface HarnessOptions {
  forceReadOnly?: boolean;
  runtimeMode?: 'read_only' | 'read_write';
  limits?: Partial<DispatcherLimits>;
  approvals?: ApprovalGate;
  dir: string;
}

export const TEST_LIMITS: DispatcherLimits = {
  ...DEFAULT_DISPATCHER_LIMITS,
  readRetries: 2,
  retryBaseDelayMs: 1,
  retryMaxDelayMs: 2,
};

export async function harness(options: HarnessOptions): Promise<Harness> {
  const storage = await openStorage({
    databasePath: databasePathFor(join(options.dir, 'data')),
    masterKey: testKey('core'),
  });
  const log = memoryLogger();
  const audit = new FlakyAudit(storage.db, { logger: log.logger });
  const policyStore = new PolicyStore(storage.db, audit);
  policyStore.current();
  if ((options.runtimeMode ?? 'read_write') === 'read_write') {
    policyStore.setRuntimeMode('read_write', { type: 'cli' });
  }
  const executions = new ExecutionStore(storage.db);
  const executor = new MockExecutor();
  const registry = new OperationRegistry(inventory);
  const descriptors: OperationDescriptor[] = [listDevices, getInfo, restartDevice, rebootGateway];
  for (const descriptor of descriptors) registry.register(descriptor);
  registry.seal();
  const clients = new Map<string, ClientPolicy>([
    [
      CLIENT.clientId,
      ClientPolicySchema.parse({
        clientId: CLIENT.clientId,
        consoles: { [CONSOLE]: { sites: '*' } },
        allow: ['network.*.*'],
      }),
    ],
  ]);
  const consoles = new Map<string, ConsolePolicy>([
    [
      CONSOLE,
      ConsolePolicySchema.parse({
        consoleId: CONSOLE,
        modules: { network: { state: 'read_write' } },
      }),
    ],
  ]);
  const deployment = { forceReadOnly: options.forceReadOnly ?? false };
  const dispatcher = new Dispatcher({
    registry,
    executor,
    security: {
      clientPolicy: (id) => clients.get(id),
      consolePolicy: (id) => consoles.get(id),
      capability: () => 'supported',
    },
    policyStore,
    deployment,
    audit,
    executions,
    logger: log.logger,
    limits: { ...TEST_LIMITS, ...options.limits },
    random: () => 0.5,
    ...(options.approvals === undefined ? {} : { approvals: options.approvals }),
  });
  return {
    storage,
    audit,
    log,
    policyStore,
    executions,
    executor,
    registry,
    clients,
    consoles,
    dispatcher,
    deployment,
    auditActions: () =>
      audit
        .list({ eventType: 'mcp.operation', limit: 500 })
        .reverse()
        .map((entry) => `${entry.action}:${entry.outcome}`),
  };
}
