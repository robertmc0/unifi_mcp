/**
 * UniFi transport test harness: real storage, audit, policy store and console registry,
 * a mock HTTPS console, and an executor whose egress allowlist admits only 127.0.0.1.
 */
import { join } from 'node:path';
import { PolicyStore, type PolicyActor } from '@unifi-local-mcp/policy';
import { databasePathFor, openStorage, type Storage } from '@unifi-local-mcp/storage';
import { AuditLog } from '@unifi-local-mcp/telemetry';
import {
  ConsoleRegistry,
  EgressGuard,
  UnifiExecutor,
  type Lookup,
  type TlsTrustInput,
} from '@unifi-local-mcp/unifi-api';
import type { ExecutionCall, OperationDescriptor } from '@unifi-local-mcp/core';
import { MockConsole } from '../../fixtures/mock-console.ts';
import { testPki } from '../../fixtures/test-pki.ts';
import { testKey } from '../storage/fixtures.ts';
import { memoryLogger, type MemorySink } from '../telemetry/fixtures.ts';

export const CLI: PolicyActor = { type: 'cli', id: 'root' };
export const NETWORK_KEY = 'synthetic-network-key-SENTINEL-41';

export interface UnifiHarness {
  storage: Storage;
  audit: AuditLog;
  policyStore: PolicyStore;
  consoles: ConsoleRegistry;
  log: MemorySink;
  mock: MockConsole;
  consoleId: string;
  executor: UnifiExecutor;
  close(): Promise<void>;
}

export interface UnifiHarnessOptions {
  dir: string;
  /** Which certificate the mock console presents. Default: CA-signed. */
  serverCert?: 'ca-signed' | 'self-signed';
  tls?: TlsTrustInput;
  host?: string;
  allow?: string[];
  lookup?: Lookup;
}

export async function unifiHarness(options: UnifiHarnessOptions): Promise<UnifiHarness> {
  const pki = testPki();
  const storage = await openStorage({
    databasePath: databasePathFor(join(options.dir, 'data')),
    masterKey: testKey('unifi-api'),
  });
  const log = memoryLogger();
  const audit = new AuditLog(storage.db, { logger: log.logger });
  const policyStore = new PolicyStore(storage.db, audit);
  policyStore.current();
  const consoles = new ConsoleRegistry({
    db: storage.db,
    audit,
    secrets: storage.secrets,
    logger: log.logger,
  });
  const mock = await MockConsole.start(
    options.serverCert === 'self-signed'
      ? { key: pki.selfKey, cert: pki.selfCert }
      : { key: pki.serverKey, cert: pki.serverCert },
  );
  const view = consoles.add(
    {
      alias: 'lab',
      host: options.host ?? '127.0.0.1',
      tls: options.tls ?? { mode: 'verify', caPem: pki.caPem },
    },
    CLI,
  );
  for (const moduleId of ['network', 'access'] as const) {
    consoles.setModulePort(view.id, moduleId, mock.port, CLI);
  }
  consoles.setCredential(view.id, 'network', NETWORK_KEY, CLI);
  const egress = new EgressGuard({ allow: options.allow ?? ['127.0.0.1/32'] }, options.lookup);
  const executor = new UnifiExecutor({
    consoles,
    egress,
    logger: log.logger,
    connectTimeoutMs: 2000,
  });
  return {
    storage,
    audit,
    policyStore,
    consoles,
    log,
    mock,
    consoleId: view.id,
    executor,
    close: async () => {
      await mock.stop();
      storage.close();
    },
  };
}

export function call(
  descriptor: OperationDescriptor,
  consoleId: string,
  args: Record<string, unknown> = {},
  signal: AbortSignal = new AbortController().signal,
): ExecutionCall {
  return {
    descriptor,
    arguments: args,
    target: { consoleId, siteId: 'site-1' },
    signal,
    correlationId: 'corr-1',
    attempt: 1,
  };
}
