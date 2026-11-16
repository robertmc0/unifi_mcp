/**
 * Read-only view models for the admin pages (spec §13.1 items 2, 3, 4, 7; ADR 0027),
 * assembled from the service's stores. They are the only data those pages get, and they
 * have no field for a credential, a token or a key: a page cannot show what it is never
 * given.
 *
 * A client's "effective" operations come from `discoverOperations`, the function that
 * builds the client's own tool list, so the page and the client cannot disagree.
 */
import type { AdminViews } from '@unifi-local-mcp/admin-api';
import type { ClientRow, ConsoleDetail, ConsoleRow, SettingsView } from '@unifi-local-mcp/admin-ui';
import type {
  EventFeedStatus,
  EventStreamDescriptor,
  OperationRegistry,
  SecurityContextProvider,
} from '@unifi-local-mcp/core';
import type { PolicyStore } from '@unifi-local-mcp/policy';
import {
  MODULE_SLOTS,
  slotStatus,
  type ConsoleRegistry,
  type ConsoleView,
} from '@unifi-local-mcp/unifi-api';
import type { ClientStore, ClientView } from './clients.ts';
import type { ServiceConfig } from './config.ts';
import { discoverOperations } from './tools.ts';

export interface AdminViewSources {
  config: ServiceConfig;
  serviceVersion: string;
  schemaVersion: number;
  masterKeyId: string;
  consoles: ConsoleRegistry;
  clients: ClientStore;
  policyStore: PolicyStore;
  registry: OperationRegistry;
  eventStreams: () => readonly EventStreamDescriptor[];
  eventFeeds: () => EventFeedStatus[];
  security: SecurityContextProvider;
  now: () => Date;
}

function consoleRow(view: ConsoleView): ConsoleRow {
  return {
    id: view.id,
    alias: view.alias,
    host: view.host,
    state: view.policy?.state ?? 'invalid policy',
    tlsMode: view.tls.mode,
    modules: view.modules.map((module) => ({
      moduleId: module.moduleId,
      state: view.policy?.modules[module.moduleId]?.state ?? 'disabled',
    })),
  };
}

function consoleDetail(view: ConsoleView): ConsoleDetail {
  return {
    ...consoleRow(view),
    description: view.description,
    tlsCustomCa: view.tls.customCa,
    tlsPins: view.tls.pins,
    policy: view.policy,
    modules: view.modules.map((module) => ({
      moduleId: module.moduleId,
      state: view.policy?.modules[module.moduleId]?.state ?? 'disabled',
      port: module.port,
      hasCredential: module.hasCredential,
      versionSource: module.versionSource,
      observedVersion: module.observedVersion,
      observedAt: module.observedAt,
      declaredVersion: module.declaredVersion,
      declarationExpiresAt: module.declarationExpiresAt,
      effectiveVersion: module.effectiveVersion?.version ?? null,
    })),
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

function clientRow(view: ClientView, now: Date): ClientRow {
  const expired =
    view.policy?.expiresAt !== undefined && Date.parse(view.policy.expiresAt) <= now.getTime();
  return {
    clientId: view.clientId,
    description: view.description,
    status: view.policy === null ? 'invalid policy' : expired ? 'expired' : view.policy.status,
    expiresAt: view.policy?.expiresAt ?? null,
    lastUsedAt: view.lastUsedAt,
    activeTokens: view.tokens.filter(
      (token) =>
        token.revokedAt === null &&
        (token.expiresAt === null || Date.parse(token.expiresAt) > now.getTime()),
    ).length,
    consoles: Object.keys(view.policy?.consoles ?? {}).length,
  };
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

function configuration(config: ServiceConfig): SettingsView['configuration'] {
  const entries: [string, string][] = [
    ['Hard lock (UNIFI_MCP_FORCE_READ_ONLY)', yesNo(config.deployment.forceReadOnly)],
    ['Data directory', config.dataDir],
    ['MCP listener', `${config.http.bind}:${String(config.http.port)}`],
    ['MCP listener TLS', yesNo(config.http.tls !== undefined)],
    ['MCP plaintext allowed off loopback', yesNo(config.http.allowPlaintext)],
    ['MCP allowed hosts', config.http.allowedHosts.join(', ')],
    ['MCP allowed origins', config.http.allowedOrigins.join(', ')],
    ['Console addresses allowed (egress)', config.egress.allow.join(', ')],
    ['Log level', config.logLevel],
    ['Audit retention', `${String(config.auditRetentionDays)} days`],
  ];
  if (config.admin !== undefined) {
    entries.push(
      ['Admin listener', `${config.admin.bind}:${String(config.admin.port)}`],
      ['Admin listener TLS', yesNo(config.admin.tls !== undefined)],
      ['Admin allowed hosts', config.admin.allowedHosts.join(', ')],
      [
        'Admin sessions',
        `${String(config.admin.sessionIdleMinutes)} minutes idle, ${String(config.admin.sessionMaxHours)} hours at most`,
      ],
      ['Two-step sign-in required', yesNo(config.admin.requireMfa)],
      ['Changes from this interface (UNIFI_MCP_ADMIN_MANAGEMENT)', yesNo(config.admin.management)],
    );
  }
  entries.push([
    'Metrics listener',
    config.metrics === undefined
      ? 'off'
      : `${config.metrics.bind}:${String(config.metrics.port)}${config.metrics.tls === undefined ? '' : ' (TLS)'}`,
  ]);
  return entries.map(([name, value]) => ({ name, value }));
}

export function buildAdminViews(sources: AdminViewSources): AdminViews {
  const alias = (consoleId: string): string => sources.consoles.get(consoleId)?.alias ?? consoleId;
  return {
    consoles: () => sources.consoles.list().map(consoleRow),
    console: (id) => {
      const view = sources.consoles.list().find((entry) => entry.id === id);
      return view === undefined ? undefined : consoleDetail(view);
    },
    clients: () => sources.clients.list().map((view) => clientRow(view, sources.now())),
    client: (id) => {
      const view = sources.clients.get(id);
      if (view === undefined) return undefined;
      const effective = discoverOperations({
        principal: { clientId: view.clientId },
        security: sources.security,
        policyStore: sources.policyStore,
        registry: sources.registry,
        deployment: sources.config.deployment,
        now: sources.now,
      });
      return {
        ...clientRow(view, sources.now()),
        policy: view.policy,
        createdAt: view.createdAt,
        updatedAt: view.updatedAt,
        tokens: view.tokens,
        effective: effective
          .map(({ descriptor, consoles, approvalRequired }) => ({
            operationId: descriptor.operationId,
            effect: descriptor.effect,
            risk: descriptor.risk,
            approvalRequired,
            consoles: consoles.map(alias).sort(),
          }))
          .sort((a, b) => a.operationId.localeCompare(b.operationId)),
      };
    },
    policy: () => {
      const snapshot = sources.policyStore.current();
      const enabled = new Set(snapshot.document.enabledOperations);
      const operations = sources.registry.list();
      return {
        version: snapshot.version,
        runtimeMode: snapshot.document.runtimeMode,
        forceReadOnly: sources.config.deployment.forceReadOnly,
        document: snapshot.document,
        registeredOperations: operations.length,
        defaultDisabled: operations
          .filter((descriptor) => descriptor.defaultDisabled === true)
          .map((descriptor) => ({
            operationId: descriptor.operationId,
            enabled: enabled.has(descriptor.operationId),
          }))
          .sort((a, b) => a.operationId.localeCompare(b.operationId)),
      };
    },
    settings: () => {
      const operations = sources.registry.list();
      const streams = sources.eventStreams();
      const moduleIds = [
        ...new Set([...operations.map((d) => d.moduleId), ...streams.map((s) => s.moduleId)]),
      ].sort();
      return {
        serviceVersion: sources.serviceVersion,
        schemaVersion: sources.schemaVersion,
        masterKeyId: sources.masterKeyId,
        configuration: configuration(sources.config),
        modules: [
          ...moduleIds.map((moduleId) => {
            const ofModule = operations.filter((d) => d.moduleId === moduleId);
            const moduleStreams = streams.filter((s) => s.moduleId === moduleId);
            return {
              moduleId,
              status: 'supported',
              contractRevisions: [
                ...new Set([
                  ...ofModule.map((d) => d.contractRevision),
                  ...moduleStreams.map((s) => s.contractRevision),
                ]),
              ].sort(),
              operations: ofModule.length,
              eventStreams: moduleStreams.length,
            };
          }),
          ...MODULE_SLOTS.map((slot) => ({
            moduleId: slot.moduleId,
            status: slotStatus(slot),
            contractRevisions: [],
            operations: 0,
            eventStreams: 0,
          })),
        ],
        eventFeeds: sources.eventFeeds().map((feed) => ({
          console: alias(feed.consoleId),
          moduleId: feed.moduleId,
          streamId: feed.streamId,
          state: feed.state,
          subscribers: feed.subscribers,
        })),
      };
    },
  };
}
