/**
 * Liveness and readiness (spec §12, §7.3; ADR 0008).
 *
 * - **Liveness**: the process is running and its event loop responds. Never depends on the
 *   database or consoles, so a container orchestrator does not restart a healthy process
 *   because a dependency is down.
 * - **Readiness**: every *critical* check passes (database usable, audit trail writable,
 *   data volume not full). Non-critical checks (for example an optional console being
 *   unreachable) can only mark the service `degraded`; they never make it not ready.
 * - The unauthenticated HTTP endpoints return only `alive` / `ready` / `not_ready`. Check
 *   names and details may reveal console identifiers or internal state and are available
 *   only through `HealthMonitor.readiness()` for the admin API and CLI.
 */
import { statfs } from 'node:fs/promises';
import type { SqliteDatabase } from '@unifi-local-mcp/storage';
import type { AuditLog } from './audit.ts';
import { redactString } from './redact.ts';

export type CheckStatus = 'ok' | 'degraded' | 'fail';

export interface HealthCheckResult {
  status: CheckStatus;
  /** For administrators only. Never exposed on the public endpoints. */
  detail?: string;
}

export interface HealthCheck {
  name: string;
  /** Critical checks decide readiness; non-critical checks can only degrade it. */
  critical: boolean;
  /** Default 2000 ms. A check that does not finish in time fails. */
  timeoutMs?: number;
  run(): HealthCheckResult | Promise<HealthCheckResult>;
}

export interface CheckReport {
  name: string;
  critical: boolean;
  status: CheckStatus;
  detail?: string;
  durationMs: number;
}

export interface ReadinessReport {
  ready: boolean;
  /** True when ready but a check is degraded or a non-critical check failed. */
  degraded: boolean;
  checkedAt: string;
  checks: CheckReport[];
}

const DEFAULT_TIMEOUT_MS = 2000;
const CHECK_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;

function withTimeout(check: HealthCheck): Promise<HealthCheckResult> {
  const timeoutMs = check.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<HealthCheckResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({ status: 'fail', detail: `timed out after ${String(timeoutMs)} ms` });
    }, timeoutMs);
    timer.unref();
  });
  const run = (async () => check.run())().catch((error: unknown): HealthCheckResult => ({
    status: 'fail',
    detail: redactString(error instanceof Error ? error.message : String(error), 512),
  }));
  return Promise.race([run, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

export class HealthMonitor {
  readonly #checks = new Map<string, HealthCheck>();
  readonly #now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  register(check: HealthCheck): void {
    if (!CHECK_NAME_PATTERN.test(check.name)) {
      throw new TypeError(`Invalid health check name "${check.name}".`);
    }
    if (this.#checks.has(check.name)) {
      throw new TypeError(`Health check "${check.name}" is already registered.`);
    }
    this.#checks.set(check.name, check);
  }

  unregister(name: string): void {
    this.#checks.delete(name);
  }

  liveness(): { status: 'alive' } {
    return { status: 'alive' };
  }

  /** Runs all checks concurrently, each bounded by its timeout. */
  async readiness(): Promise<ReadinessReport> {
    const checks = await Promise.all(
      [...this.#checks.values()].map(async (check): Promise<CheckReport> => {
        const started = performance.now();
        const result = await withTimeout(check);
        const report: CheckReport = {
          name: check.name,
          critical: check.critical,
          status: result.status,
          durationMs: Math.round(performance.now() - started),
        };
        if (result.detail !== undefined) report.detail = result.detail;
        return report;
      }),
    );
    const ready = checks.every((check) => !check.critical || check.status !== 'fail');
    const degraded = ready && checks.some((check) => check.status !== 'ok');
    return { ready, degraded, checkedAt: this.#now().toISOString(), checks };
  }
}

/** Critical: the database connection is open and answers a query. */
export function databaseCheck(db: SqliteDatabase): HealthCheck {
  return {
    name: 'database',
    critical: true,
    run: () => {
      if (!db.isOpen) return { status: 'fail', detail: 'database connection is closed' };
      db.get('SELECT 1 AS ok');
      return { status: 'ok' };
    },
  };
}

/**
 * Critical: the audit trail is writable (audited operations are refused otherwise). After
 * a failure, each check re-probes with an `audit.recovered` entry (see `AuditLog.probe`).
 */
export function auditCheck(audit: AuditLog): HealthCheck {
  return {
    name: 'audit',
    critical: true,
    run: () =>
      audit.probe()
        ? { status: 'ok' }
        : {
            status: 'fail',
            detail: 'the audit trail cannot be written; audited operations are refused',
          },
  };
}

/**
 * Critical: free space on the volume holding `path`. Below `failBelowBytes` the service
 * is not ready; below `warnBelowBytes` it is degraded.
 */
export function diskSpaceCheck(
  path: string,
  thresholds: { failBelowBytes: number; warnBelowBytes: number } = {
    failBelowBytes: 64 * 1024 * 1024,
    warnBelowBytes: 512 * 1024 * 1024,
  },
): HealthCheck {
  return {
    name: 'disk_space',
    critical: true,
    run: async () => {
      const stats = await statfs(path);
      const free = stats.bavail * stats.bsize;
      const detail = `${String(Math.floor(free / (1024 * 1024)))} MiB free on the data volume`;
      if (free < thresholds.failBelowBytes) return { status: 'fail', detail };
      if (free < thresholds.warnBelowBytes) return { status: 'degraded', detail };
      return { status: 'ok', detail };
    },
  };
}

export interface HealthEndpointPaths {
  livenessPath: string;
  readinessPath: string;
}

export const DEFAULT_HEALTH_PATHS: HealthEndpointPaths = {
  livenessPath: '/livez',
  readinessPath: '/readyz',
};

function json(status: number, body: unknown, method: string): Response {
  return new Response(method === 'HEAD' ? null : JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * Fetch-style handler for the unauthenticated health endpoints. Returns `undefined` for
 * any other path so the listener can route it elsewhere. Bodies carry only the overall
 * status, never check names or details.
 */
export function createHealthHandler(
  monitor: HealthMonitor,
  paths: HealthEndpointPaths = DEFAULT_HEALTH_PATHS,
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname !== paths.livenessPath && pathname !== paths.readinessPath) return undefined;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const response = json(405, { error: 'method_not_allowed' }, request.method);
      response.headers.set('allow', 'GET, HEAD');
      return response;
    }
    if (pathname === paths.livenessPath) return json(200, monitor.liveness(), request.method);
    const report = await monitor.readiness();
    return report.ready
      ? json(200, { status: 'ready' }, request.method)
      : json(503, { status: 'not_ready' }, request.method);
  };
}
