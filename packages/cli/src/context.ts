/**
 * Opens the service's stores for a CLI command, with the same configuration, master key and
 * database as the service (spec §13.2). The CLI is host-level authority: changes are made and
 * audited as `cli:<operating-system user>`.
 */
import { userInfo } from 'node:os';
import { AdminStore } from '@unifi-local-mcp/admin-api';
import { ApprovalService } from '@unifi-local-mcp/approvals';
import { ClientStore, loadServiceConfig, type ServiceConfig } from '@unifi-local-mcp/mcp-server';
import { PolicyStore, type PolicyActor } from '@unifi-local-mcp/policy';
import { loadMasterKey, openStorage, type MasterKey, type Storage } from '@unifi-local-mcp/storage';
import { AuditLog, createLogger, type Logger } from '@unifi-local-mcp/telemetry';
import { OperationRegistry } from '@unifi-local-mcp/core';
import {
  ConsoleRegistry,
  EgressGuard,
  loadContractInventory,
  UnifiExecutor,
  VersionProber,
} from '@unifi-local-mcp/unifi-api';
import { NETWORK_OPERATIONS, NETWORK_VERSION_PROBE } from '@unifi-local-mcp/unifi-network';
import type { CliIo } from './io.ts';

export interface Services {
  config: ServiceConfig;
  masterKey: MasterKey;
  storage: Storage;
  audit: AuditLog;
  policyStore: PolicyStore;
  consoles: ConsoleRegistry;
  clients: ClientStore;
  approvals: ApprovalService;
  admins: AdminStore;
  egress: EgressGuard;
  actor: PolicyActor;
  logger: Logger;
  /** Built on first use: the reviewed adapters, checked against api-specs/. */
  prober(): Promise<VersionProber>;
  close(): void;
}

export function cliActor(): PolicyActor {
  let name = 'unknown';
  try {
    name = userInfo().username;
  } catch {
    // No passwd entry (common in containers): keep "unknown".
  }
  return { type: 'cli', id: name.slice(0, 120) };
}

export function cliLogger(io: CliIo): Logger {
  return createLogger({
    level: 'warn',
    sink: {
      write: (line: string) => {
        io.err(line.trimEnd());
      },
    },
    bindings: { component: 'unifi-mcp-cli' },
  });
}

export async function loadKey(env: NodeJS.ProcessEnv, io: CliIo): Promise<MasterKey> {
  const loaded = await loadMasterKey(env);
  for (const warning of loaded.warnings) io.err(`warning: ${warning}`);
  return loaded.key;
}

export async function openServices(env: NodeJS.ProcessEnv, io: CliIo): Promise<Services> {
  const config = loadServiceConfig(env);
  const masterKey = await loadKey(env, io);
  const logger = cliLogger(io);
  const storage = await openStorage({ databasePath: config.databasePath, masterKey });
  if (storage.preMigrationBackup !== undefined) {
    io.err(`note: the database was upgraded; backup written to ${storage.preMigrationBackup.path}`);
  }
  const audit = new AuditLog(storage.db, { logger });
  const policyStore = new PolicyStore(storage.db, audit);
  policyStore.current();
  const consoles = new ConsoleRegistry({ db: storage.db, audit, secrets: storage.secrets, logger });
  const egress = new EgressGuard(config.egress);
  let prober: Promise<VersionProber> | undefined;
  const buildProber = async (): Promise<VersionProber> => {
    // The same adapters and contract check as the service (packages/mcp-server/src/main.ts).
    const registry = new OperationRegistry(await loadContractInventory(config.apiSpecsDir));
    for (const descriptor of NETWORK_OPERATIONS) registry.register(descriptor);
    registry.seal();
    const executor = new UnifiExecutor({ consoles, egress, logger });
    return new VersionProber({ consoles, executor, registry, specs: [NETWORK_VERSION_PROBE] });
  };
  return {
    config,
    masterKey,
    storage,
    audit,
    policyStore,
    consoles,
    clients: new ClientStore({ db: storage.db, audit }),
    approvals: new ApprovalService({
      db: storage.db,
      audit,
      secrets: storage.secrets,
      policyStore,
    }),
    admins: new AdminStore({ db: storage.db, audit }),
    egress,
    actor: cliActor(),
    logger,
    prober: () => (prober ??= buildProber()),
    close: () => {
      storage.close();
    },
  };
}
