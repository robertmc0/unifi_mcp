/**
 * Service composition and lifecycle (spec §3.1, §8.2, §12; ADR 0013).
 *
 * Startup order, every step failing closed:
 *   master key → storage (integrity, key, migrations) → policy → registries → contract
 *   inventory and operation registry → dispatcher (+ restart recovery) → health checks →
 *   MCP handler → listener.
 * Shutdown: stop accepting, drain running operations, close the database.
 */
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { AdminHttpService, AdminSessionStore, AdminStore } from '@unifi-local-mcp/admin-api';
import type { DashboardView } from '@unifi-local-mcp/admin-ui';
import { ApprovalService } from '@unifi-local-mcp/approvals';
import {
  Dispatcher,
  ExecutionStore,
  OperationRegistry,
  type ContractInventory,
  type OperationDescriptor,
  type OperationExecutor,
  type SecurityContextProvider,
} from '@unifi-local-mcp/core';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { PolicyStore } from '@unifi-local-mcp/policy';
import {
  acquireInstanceLock,
  loadMasterKey,
  openStorage,
  type MasterKey,
  type Storage,
} from '@unifi-local-mcp/storage';
import {
  auditCheck,
  AuditLog,
  createLogger,
  databaseCheck,
  diskSpaceCheck,
  HealthMonitor,
  type LogSink,
  type Logger,
} from '@unifi-local-mcp/telemetry';
import {
  ConsoleRegistry,
  EgressGuard,
  loadContractInventory,
  UnifiExecutor,
  type Lookup,
} from '@unifi-local-mcp/unifi-api';
import { ClientStore } from './clients.ts';
import type { AdminListenerConfig, ServiceConfig } from './config.ts';
import { McpHttpService } from './http.ts';
import { buildMcpServer } from './tools.ts';

export const SERVICE_VERSION = '0.0.0';
const APPROVAL_SWEEP_MS = 30_000;
/** How often open MCP responses are re-checked against their token (out-of-process revocation). */
const STREAM_RECHECK_MS = 5_000;
const AUDIT_PRUNE_MS = 24 * 60 * 60_000;
const DRAIN_TIMEOUT_MS = 10_000;

export interface ServiceOptions {
  config: ServiceConfig;
  /** Environment for the master key (`UNIFI_MCP_MASTER_KEY[_FILE]`). Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** A key that is already loaded (tests); otherwise loaded from `env`. */
  masterKey?: MasterKey;
  /** Reviewed operations from the module adapters (Phase 2+). */
  operations?: readonly OperationDescriptor[];
  /** Tests only: a synthetic contract inventory instead of api-specs/. */
  inventory?: ContractInventory;
  /** Tests only: a synthetic DNS resolver for the egress guard. */
  lookup?: Lookup;
  executor?: OperationExecutor;
  logSink?: LogSink;
  now?: () => Date;
  /** Tests only: re-check interval for open MCP responses (default 5 s). */
  streamRecheckMs?: number;
}

export interface RunningService {
  url: string;
  logger: Logger;
  storage: Storage;
  audit: AuditLog;
  policyStore: PolicyStore;
  consoles: ConsoleRegistry;
  clients: ClientStore;
  approvals: ApprovalService;
  dispatcher: Dispatcher;
  registry: OperationRegistry;
  health: HealthMonitor;
  admins: AdminStore;
  /** The admin interface URL, or undefined when it is disabled (the default). */
  adminUrl: string | undefined;
  stop(): Promise<void>;
}

function createListener(
  tls: { certFile: string; keyFile: string } | undefined,
  listener: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => void,
): Server {
  const server =
    tls === undefined
      ? createHttpServer(listener)
      : createHttpsServer(
          {
            cert: readFileSync(tls.certFile),
            key: readFileSync(tls.keyFile),
            minVersion: 'TLSv1.2',
          },
          listener,
        );
  server.headersTimeout = 20_000;
  server.requestTimeout = 120_000;
  return server;
}

async function listen(server: Server, port: number, bind: string, tls: boolean): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return `${tls ? 'https' : 'http'}://${host}:${String(address.port)}`;
}

async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  server.closeAllConnections();
  await closed;
}

export async function startService(options: ServiceOptions): Promise<RunningService> {
  const { config } = options;
  const now = options.now ?? (() => new Date());
  const logger = createLogger({
    level: config.logLevel,
    sink: options.logSink ?? process.stdout,
    bindings: { service: 'unifi-local-mcp' },
    now,
  });

  let masterKey = options.masterKey;
  if (masterKey === undefined) {
    const loaded = await loadMasterKey(options.env ?? process.env);
    for (const warning of loaded.warnings) logger.warn(warning);
    masterKey = loaded.key;
  }
  // One service per data directory; also keeps key rotation and restore from running beside it.
  const instanceLock = acquireInstanceLock(config.dataDir, 'start the service');
  let storage: Storage;
  try {
    storage = await openStorage({ databasePath: config.databasePath, masterKey, now });
  } catch (error) {
    instanceLock.release();
    throw error;
  }
  try {
    if (storage.preMigrationBackup !== undefined) {
      logger.info('pre-migration backup written', {
        path: storage.preMigrationBackup.path,
        sha256: storage.preMigrationBackup.sha256,
      });
    }
    const audit = new AuditLog(storage.db, { logger, now });
    const policyStore = new PolicyStore(storage.db, audit, now);
    policyStore.current();
    const consoles = new ConsoleRegistry({
      db: storage.db,
      audit,
      secrets: storage.secrets,
      logger,
      now,
    });
    const clients = new ClientStore({ db: storage.db, audit, now });
    const approvals = new ApprovalService({
      db: storage.db,
      audit,
      secrets: storage.secrets,
      policyStore,
      now,
    });

    const inventory = options.inventory ?? (await loadContractInventory(config.apiSpecsDir));
    const registry = new OperationRegistry(inventory);
    for (const descriptor of options.operations ?? []) registry.register(descriptor);
    registry.seal();

    const security: SecurityContextProvider = {
      clientPolicy: (clientId) => clients.policy(clientId),
      consolePolicy: (consoleId) => consoles.policy(consoleId),
      capability: (consoleId, descriptor) => consoles.capability(consoleId, descriptor),
    };
    const executor =
      options.executor ??
      new UnifiExecutor({
        consoles,
        egress: new EgressGuard(config.egress, options.lookup),
        logger,
      });
    const dispatcher = new Dispatcher({
      registry,
      executor,
      security,
      policyStore,
      deployment: config.deployment,
      audit,
      executions: new ExecutionStore(storage.db, now),
      logger,
      approvals,
      now,
    });
    const recovered = dispatcher.recoverInterrupted();
    if (recovered.outcomeUnknown + recovered.cancelled > 0) {
      logger.warn('executions interrupted by the previous shutdown were closed', recovered);
    }

    const health = new HealthMonitor({ now });
    health.register(databaseCheck(storage.db));
    health.register(auditCheck(audit));
    health.register(diskSpaceCheck(config.dataDir));

    const handler = createMcpHandler(
      ({ authInfo }) => {
        // The gate guarantees authInfo; anything else is a wiring error.
        if (authInfo === undefined)
          throw new Error('MCP request reached the handler without identity.');
        return buildMcpServer({
          principal: { clientId: authInfo.clientId },
          registry,
          dispatcher,
          approvals,
          consoles,
          security,
          policyStore,
          deployment: config.deployment,
          audit,
          now,
          serverVersion: SERVICE_VERSION,
        });
      },
      {
        legacy: 'stateless',
        maxRequestBodySize: 1024 * 1024,
        onerror: (error) => {
          logger.warn('MCP protocol error', { err: error });
        },
      },
    );
    const http = new McpHttpService({
      handler,
      clients,
      health,
      audit,
      logger,
      allowedHosts: config.http.allowedHosts,
      allowedOrigins: config.http.allowedOrigins,
    });
    clients.onRevocation((clientId) => {
      const cancelled = dispatcher.cancelClient(clientId);
      const closed = http.closeClientResponses(clientId);
      logger.info('client revoked or disabled', {
        clientId,
        cancelledQueued: cancelled,
        closedResponses: closed,
      });
    });

    const server: Server =
      config.http.tls === undefined
        ? createHttpServer(http.listener)
        : createHttpsServer(
            {
              cert: readFileSync(config.http.tls.certFile),
              key: readFileSync(config.http.tls.keyFile),
              minVersion: 'TLSv1.2',
            },
            http.listener,
          );
    server.headersTimeout = 20_000;
    server.requestTimeout = 120_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.http.port, config.http.bind, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    const url = `${config.http.tls === undefined ? 'http' : 'https'}://${host}:${String(address.port)}`;
    if (config.http.tls === undefined && config.http.allowPlaintext) {
      logger.warn(
        'MCP listener uses plaintext HTTP (UNIFI_MCP_HTTP_ALLOW_PLAINTEXT); TLS must be provided in front of it',
      );
    }

    const admins = new AdminStore({ db: storage.db, audit, now });
    let admin: { server: Server; url: string; sessions: AdminSessionStore } | undefined;
    if (config.admin !== undefined) {
      try {
        admin = await startAdmin(config.admin, {
          db: storage.db,
          admins,
          approvals,
          audit,
          logger,
          now,
          status: async (adminUrl) => {
            const policy = policyStore.current();
            const report = await health.readiness();
            return {
              runtimeMode: policy.document.runtimeMode,
              forceReadOnly: config.deployment.forceReadOnly,
              policyVersion: policy.version,
              ready: report.ready,
              checks: report.checks.map((check) => ({
                name: check.name,
                status: check.status,
                ...(check.detail === undefined ? {} : { detail: check.detail }),
              })),
              mcpListener: url,
              adminListener: adminUrl,
              consoles: consoles.list().map((view) => ({
                alias: view.alias,
                host: view.host,
                state: view.policy?.state ?? 'invalid policy',
                tlsMode: view.tls.mode,
                modules: view.modules.map((module) => ({
                  moduleId: module.moduleId,
                  state: view.policy?.modules[module.moduleId]?.state ?? 'disabled',
                  hasCredential: module.hasCredential,
                  observedVersion: module.observedVersion,
                })),
              })),
              clients: clients.list().length,
              pendingApprovals: approvals.list({ status: 'pending' }).length,
            };
          },
        });
      } catch (error) {
        await closeServer(server);
        throw error;
      }
      logger.info('admin interface listening', { url: admin.url });
    }

    // Revocations made by another process (the CLI) are stored in the database but do not
    // reach the in-process listener above: re-check open responses periodically.
    const recheck = setInterval(() => {
      for (const clientId of http.revalidateOpenResponses()) {
        const inactive = !clients.isClientActive(clientId);
        const cancelled = inactive ? dispatcher.cancelClient(clientId) : 0;
        logger.info('closed MCP responses whose token is no longer valid', {
          clientId,
          cancelledQueued: cancelled,
        });
      }
    }, options.streamRecheckMs ?? STREAM_RECHECK_MS);
    recheck.unref();

    const sweep = setInterval(() => {
      try {
        approvals.expireStale();
      } catch (error) {
        logger.error('approval expiry sweep failed', { err: error });
      }
    }, APPROVAL_SWEEP_MS);
    sweep.unref();
    const prune = (): void => {
      try {
        const cutoff = new Date(now().getTime() - config.auditRetentionDays * 86_400_000);
        audit.prune(cutoff);
        admin?.sessions.prune();
      } catch (error) {
        logger.error('audit retention pruning failed', { err: error });
      }
    };
    prune();
    const pruneTimer = setInterval(prune, AUDIT_PRUNE_MS);
    pruneTimer.unref();

    audit.record({
      eventType: 'system',
      action: 'service.start',
      outcome: 'success',
      actor: { type: 'system' },
      details: {
        schemaVersion: storage.schemaVersion,
        keyId: storage.keyId,
        operations: registry.list().length,
        consoles: consoles.list().length,
        forceReadOnly: config.deployment.forceReadOnly,
        tls: config.http.tls !== undefined,
        adminInterface: admin !== undefined,
      },
    });
    logger.info('service started', {
      url,
      schemaVersion: storage.schemaVersion,
      operations: registry.list().length,
      forceReadOnly: config.deployment.forceReadOnly,
    });

    let stopped = false;
    return {
      url,
      logger,
      storage,
      audit,
      policyStore,
      consoles,
      clients,
      approvals,
      dispatcher,
      registry,
      health,
      admins,
      adminUrl: admin?.url,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        if (admin !== undefined) await closeServer(admin.server);
        clearInterval(recheck);
        clearInterval(sweep);
        clearInterval(pruneTimer);
        const closed = new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        });
        server.closeIdleConnections();
        await Promise.race([
          dispatcher.drain(),
          new Promise((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS).unref()),
        ]);
        server.closeAllConnections();
        await closed;
        await handler.close();
        try {
          audit.record({
            eventType: 'system',
            action: 'service.stop',
            outcome: 'success',
            actor: { type: 'system' },
          });
        } catch {
          // The database may be unavailable during an emergency shutdown.
        }
        storage.close();
        instanceLock.release();
        logger.info('service stopped');
      },
    };
  } catch (error) {
    storage.close();
    instanceLock.release();
    throw error;
  }
}

async function startAdmin(
  config: AdminListenerConfig,
  deps: {
    db: Storage['db'];
    admins: AdminStore;
    approvals: ApprovalService;
    audit: AuditLog;
    logger: Logger;
    now: () => Date;
    status: (adminUrl: string) => Promise<DashboardView>;
  },
): Promise<{ server: Server; url: string; sessions: AdminSessionStore }> {
  const sessions = new AdminSessionStore({
    db: deps.db,
    admins: deps.admins,
    limits: {
      idleMs: config.sessionIdleMinutes * 60_000,
      lifetimeMs: config.sessionMaxHours * 60 * 60_000,
    },
    now: deps.now,
  });
  let url = '';
  const http = new AdminHttpService({
    admins: deps.admins,
    sessions,
    approvals: deps.approvals,
    audit: deps.audit,
    logger: deps.logger,
    status: () => deps.status(url),
    allowedHosts: config.allowedHosts,
    tls: config.tls !== undefined,
    now: deps.now,
  });
  const server = createListener(config.tls, http.listener);
  url = await listen(server, config.port, config.bind, config.tls !== undefined);
  if (config.tls === undefined && config.allowPlaintext) {
    deps.logger.warn(
      'admin interface uses plaintext HTTP (UNIFI_MCP_ADMIN_ALLOW_PLAINTEXT); TLS must be provided in front of it',
    );
  }
  return { server, url, sessions };
}
