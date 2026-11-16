/**
 * The service's metrics (spec §12, §17; ADR 0025).
 *
 * What is measured: requests on the MCP listener, operations and their durations, requests
 * to consoles, the work queue, connected clients, event subscriptions, console modules,
 * pending approvals, health checks and the data volume.
 *
 * What is never a label or a value: console aliases, hosts, addresses and ids, client ids
 * and names, site ids, operation ids and arguments, token ids, upstream text. Every label
 * is declared below with its complete value list (or as a code label for this service's
 * own error codes). tests/contract/metrics-catalogue.test.ts pins the catalogue, and
 * tests/integration-mock/metrics-http.test.ts scans a real scrape for the identifiers of
 * its own setup.
 */
import { statSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import type { EventFeedStatus, OperationObservation } from '@unifi-local-mcp/core';
import { codeLabel, MetricsRegistry, type CheckReport } from '@unifi-local-mcp/telemetry';
import { MODULE_IDS, type UpstreamObservation } from '@unifi-local-mcp/unifi-api';
import type { HttpObservation } from './http.ts';

const MODULES = [...MODULE_IDS, 'unknown'] as const;
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const HTTP_CODES = [
  '200',
  '202',
  '204',
  '400',
  '401',
  '403',
  '404',
  '405',
  '406',
  '413',
  '429',
  '500',
  '503',
  'no_response',
  'other',
];
const HEALTH_CHECKS = [
  'database',
  'audit',
  'disk_space',
  'console_versions',
  'console_tls',
  'other',
];

/** The current state the collectors read at each scrape. All values are counts or flags. */
export interface MetricsSources {
  startedAt: Date;
  dataDir: string;
  databasePath: string;
  hardLock: boolean;
  runtimeMode(): string;
  policyVersion(): number;
  readiness(): Promise<{ ready: boolean; checks: CheckReport[] }>;
  load(): { running: number; queued: number };
  connections(): { clients: number; responses: number };
  eventSubscriptions(): number;
  eventFeeds(): EventFeedStatus[];
  /** One entry per module of every console: its mode and whether its version is known. */
  consoleModules(): { moduleId: string; state: string; versionKnown: boolean }[];
  consoles(): { state: string }[];
  clients(): number;
  pendingApprovals(): number;
}

export interface ServiceMetrics {
  registry: MetricsRegistry;
  observeOperation: (observation: OperationObservation) => void;
  observeUpstream: (observation: UpstreamObservation) => void;
  observeHttp: (observation: HttpObservation) => void;
  /** The collectors need the running service; call once it exists. */
  attach: (sources: MetricsSources) => void;
}

function upstreamResult(status: number | undefined): string {
  if (status === undefined) return 'no_response';
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 300 && status < 400) return '3xx';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500 && status < 600) return '5xx';
  return 'other';
}

export function createServiceMetrics(version: string): ServiceMetrics {
  const registry = new MetricsRegistry();

  const httpRequests = registry.counter({
    name: 'unifi_mcp_http_requests_total',
    help: 'Requests finished on the MCP listener, by path class and HTTP status.',
    labels: { path: ['mcp', 'health', 'other'], code: HTTP_CODES },
  });
  const operations = registry.counter({
    name: 'unifi_mcp_operations_total',
    help: 'Operation requests by module, effect and result status.',
    labels: {
      module: MODULES,
      effect: ['read', 'write', 'unknown'],
      status: ['ok', 'pending', 'denied', 'approval_required', 'error'],
    },
  });
  const operationFailures = registry.counter({
    name: 'unifi_mcp_operation_failures_total',
    help: 'Denied and failed operation requests by status and error code.',
    labels: { status: ['denied', 'error'], code: codeLabel(64) },
  });
  const operationDuration = registry.histogram({
    name: 'unifi_mcp_operation_duration_seconds',
    help: 'Time from an operation request to its result, including queueing and retries.',
    labels: { module: MODULES, effect: ['read', 'write', 'unknown'] },
    buckets: DURATION_BUCKETS,
  });
  const upstreamRequests = registry.counter({
    name: 'unifi_mcp_upstream_requests_total',
    help: 'Requests sent to consoles by module and HTTP status class.',
    labels: { module: MODULES, result: ['2xx', '3xx', '4xx', '5xx', 'no_response', 'other'] },
  });
  const upstreamDuration = registry.histogram({
    name: 'unifi_mcp_upstream_request_duration_seconds',
    help: 'Duration of one request to a console, including connecting.',
    labels: { module: MODULES },
    buckets: DURATION_BUCKETS,
  });

  const buildInfo = registry.gauge({
    name: 'unifi_mcp_build_info',
    help: 'Always 1; the service version is the label.',
    labels: { version: [version] },
  });
  const startTime = registry.gauge({
    name: 'process_start_time_seconds',
    help: 'Start time of the service process, in seconds since the Unix epoch.',
  });
  const memory = registry.gauge({
    name: 'process_resident_memory_bytes',
    help: 'Resident memory of the service process.',
  });
  const ready = registry.gauge({
    name: 'unifi_mcp_ready',
    help: '1 when every critical health check passes, otherwise 0.',
  });
  const healthChecks = registry.gauge({
    name: 'unifi_mcp_health_check_status',
    help: '1 for the current status of each health check, 0 for the others.',
    labels: { check: HEALTH_CHECKS, status: ['ok', 'degraded', 'fail'] },
  });
  const hardLock = registry.gauge({
    name: 'unifi_mcp_hard_lock',
    help: '1 when the deployment forces read-only operation (UNIFI_MCP_FORCE_READ_ONLY).',
  });
  const runtimeMode = registry.gauge({
    name: 'unifi_mcp_runtime_mode',
    help: '1 for the runtime mode of the security policy, 0 for the other.',
    labels: { mode: ['read_only', 'read_write'] },
  });
  const policyVersion = registry.gauge({
    name: 'unifi_mcp_policy_version',
    help: 'Version counter of the security policy; it rises with every change.',
  });
  const running = registry.gauge({
    name: 'unifi_mcp_operations_running',
    help: 'Operations being executed now.',
  });
  const queued = registry.gauge({
    name: 'unifi_mcp_operations_queued',
    help: 'Operation requests waiting for a free slot.',
  });
  const connectedClients = registry.gauge({
    name: 'unifi_mcp_clients_connected',
    help: 'MCP clients with at least one open request or stream.',
  });
  const openResponses = registry.gauge({
    name: 'unifi_mcp_open_responses',
    help: 'Open MCP responses, including event streams.',
  });
  const configuredClients = registry.gauge({
    name: 'unifi_mcp_clients_configured',
    help: 'MCP clients that exist, whatever their status.',
  });
  const eventSubscriptions = registry.gauge({
    name: 'unifi_mcp_event_subscriptions',
    help: 'Open event subscriptions of MCP clients.',
  });
  const eventFeeds = registry.gauge({
    name: 'unifi_mcp_event_feeds',
    help: 'Event feeds from consoles by module and connection state.',
    labels: {
      module: MODULES,
      state: ['connecting', 'connected', 'retrying', 'unavailable', 'other'],
    },
  });
  const eventDropped = registry.gauge({
    name: 'unifi_mcp_event_messages_dropped',
    help: 'Messages the current event feeds dropped, by module and reason.',
    labels: { module: MODULES, reason: ['contract_mismatch', 'unclassified'] },
  });
  const consoles = registry.gauge({
    name: 'unifi_mcp_consoles',
    help: 'Configured consoles by state.',
    labels: { state: ['enabled', 'read_only', 'disabled', 'invalid'] },
  });
  const consoleModules = registry.gauge({
    name: 'unifi_mcp_console_modules',
    help: 'Modules of configured consoles by mode and by whether their version is known.',
    labels: {
      module: MODULES,
      state: ['read_only', 'read_write', 'disabled'],
      version: ['known', 'unknown'],
    },
  });
  const pendingApprovals = registry.gauge({
    name: 'unifi_mcp_approvals_pending',
    help: 'Approval requests waiting for a human decision (at most 500 are counted).',
  });
  const databaseSize = registry.gauge({
    name: 'unifi_mcp_database_size_bytes',
    help: 'Size of the database file.',
  });
  const freeSpace = registry.gauge({
    name: 'unifi_mcp_data_volume_free_bytes',
    help: 'Free space on the data volume.',
  });

  return {
    registry,
    observeOperation(o) {
      const labels = { module: o.moduleId ?? 'unknown', effect: o.effect ?? 'unknown' };
      operations.inc({ ...labels, status: o.status });
      operationDuration.observe(labels, o.durationMs / 1000);
      if (o.status === 'denied' || o.status === 'error') {
        operationFailures.inc({ status: o.status, code: o.errorCode ?? 'other' });
      }
    },
    observeUpstream(o) {
      upstreamRequests.inc({ module: o.moduleId, result: upstreamResult(o.status) });
      upstreamDuration.observe({ module: o.moduleId }, o.durationMs / 1000);
    },
    observeHttp(o) {
      httpRequests.inc({
        path: o.path,
        code: o.status === undefined ? 'no_response' : String(o.status),
      });
    },
    attach(sources) {
      buildInfo.set({ version }, 1);
      startTime.set({}, Math.floor(sources.startedAt.getTime() / 1000));
      hardLock.set({}, sources.hardLock ? 1 : 0);

      registry.collect(() => {
        memory.set({}, process.memoryUsage().rss);
        const mode = sources.runtimeMode();
        for (const value of ['read_only', 'read_write']) {
          runtimeMode.set({ mode: value }, value === mode ? 1 : 0);
        }
        policyVersion.set({}, sources.policyVersion());
        const load = sources.load();
        running.set({}, load.running);
        queued.set({}, load.queued);
        const connections = sources.connections();
        connectedClients.set({}, connections.clients);
        openResponses.set({}, connections.responses);
        configuredClients.set({}, sources.clients());
        eventSubscriptions.set({}, sources.eventSubscriptions());
        pendingApprovals.set({}, sources.pendingApprovals());
      });

      registry.collect(() => {
        eventFeeds.reset();
        eventDropped.reset();
        const feeds = new Map<string, number>();
        const dropped = new Map<string, number>();
        for (const feed of sources.eventFeeds()) {
          const key = `${feed.moduleId}\u0001${feed.state}`;
          feeds.set(key, (feeds.get(key) ?? 0) + 1);
          for (const [reason, count] of [
            ['contract_mismatch', feed.dropped.contractMismatch],
            ['unclassified', feed.dropped.unclassified],
          ] as const) {
            const droppedKey = `${feed.moduleId}\u0001${reason}`;
            dropped.set(droppedKey, (dropped.get(droppedKey) ?? 0) + count);
          }
        }
        for (const [key, count] of feeds) {
          const [module = 'unknown', state = 'other'] = key.split('\u0001');
          eventFeeds.set({ module, state }, count);
        }
        for (const [key, count] of dropped) {
          const [module = 'unknown', reason = 'unclassified'] = key.split('\u0001');
          eventDropped.set({ module, reason }, count);
        }
      });

      registry.collect(() => {
        consoles.reset();
        consoleModules.reset();
        const byState = new Map<string, number>();
        for (const { state } of sources.consoles()) {
          byState.set(state, (byState.get(state) ?? 0) + 1);
        }
        for (const [state, count] of byState) consoles.set({ state }, count);
        const modules = new Map<string, number>();
        for (const module of sources.consoleModules()) {
          const key = [module.moduleId, module.state, module.versionKnown ? 'known' : 'unknown'];
          modules.set(key.join('\u0001'), (modules.get(key.join('\u0001')) ?? 0) + 1);
        }
        for (const [key, count] of modules) {
          const [module = 'unknown', state = 'disabled', version = 'unknown'] = key.split('\u0001');
          consoleModules.set({ module, state, version }, count);
        }
      });

      registry.collect(async () => {
        const report = await sources.readiness();
        ready.set({}, report.ready ? 1 : 0);
        healthChecks.reset();
        for (const check of report.checks) {
          for (const status of ['ok', 'degraded', 'fail']) {
            healthChecks.set({ check: check.name, status }, check.status === status ? 1 : 0);
          }
        }
      });

      registry.collect(async () => {
        databaseSize.set({}, statSync(sources.databasePath).size);
        const disk = await statfs(sources.dataDir);
        freeSpace.set({}, disk.bavail * disk.bsize);
      });
    },
  };
}
