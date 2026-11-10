/**
 * Version probes (spec §16 Phase 2; ADR 0018 §3).
 *
 * An operation can run only when the console's module version is known and within the
 * operation's verified range (ADR 0012). A probe learns that version with one documented,
 * reviewed read, for Network `GET /v1/info`, through the same executor and controls as
 * every other request (egress allowlist, TLS trust, fixed headers, response caps).
 *
 * - `VersionProber` runs one probe. It probes only enabled consoles and modules: a
 *   disabled console is never contacted.
 * - `VersionMonitor` keeps versions current from inside the service. It probes unknown
 *   versions soon after a module is enabled (also when the CLI enabled it from another
 *   process), retries failures with backoff, and refreshes known versions periodically.
 */
import { randomUUID } from 'node:crypto';
import type { OperationExecutor, OperationRegistry } from '@unifi-local-mcp/core';
import type { PolicyActor } from '@unifi-local-mcp/policy';
import type { HealthCheck, Logger } from '@unifi-local-mcp/telemetry';
import type { ConsoleRegistry } from './consoles.ts';
import type { ModuleId } from './modules.ts';

/** How a module's version is learned. Provided by the module's adapter. */
export interface VersionProbeSpec {
  moduleId: ModuleId;
  /** A registered read with no arguments that is not site-scoped. */
  operationId: string;
  /** The versions the module's operations accept, shown to administrators. */
  supportedRange: string;
  /** The version from the validated output, or undefined if absent. */
  version(output: unknown): string | undefined;
}

export type ProbeResult =
  | { ok: true; version: string; changed: boolean; previous: string | null }
  | { ok: false; code: string; message: string };

/** What a console may report as a version before it is stored or shown. */
export const PLAUSIBLE_VERSION = /^[0-9][0-9A-Za-z.+-]{0,63}$/;

export interface VersionProberOptions {
  consoles: ConsoleRegistry;
  executor: OperationExecutor;
  registry: OperationRegistry;
  specs: readonly VersionProbeSpec[];
}

export class VersionProber {
  readonly #consoles: ConsoleRegistry;
  readonly #executor: OperationExecutor;
  readonly #registry: OperationRegistry;
  readonly #specs = new Map<ModuleId, VersionProbeSpec>();

  constructor(options: VersionProberOptions) {
    this.#consoles = options.consoles;
    this.#executor = options.executor;
    this.#registry = options.registry;
    for (const spec of options.specs) {
      const descriptor = this.#registry.get(spec.operationId);
      if (
        descriptor?.moduleId !== spec.moduleId ||
        descriptor.effect !== 'read' ||
        descriptor.siteScoped ||
        Object.keys(descriptor.inputSchema.shape).length > 0
      ) {
        throw new TypeError(
          `The ${spec.moduleId} version probe needs a registered, argument-free, ` +
            `console-level read; ${spec.operationId} is not one.`,
        );
      }
      this.#specs.set(spec.moduleId, spec);
    }
  }

  /** Modules that have a probe. */
  modules(): ModuleId[] {
    return [...this.#specs.keys()];
  }

  spec(moduleId: ModuleId): VersionProbeSpec | undefined {
    return this.#specs.get(moduleId);
  }

  async probe(
    consoleId: string,
    moduleId: ModuleId,
    options: { actor?: PolicyActor; signal?: AbortSignal } = {},
  ): Promise<ProbeResult> {
    const spec = this.#specs.get(moduleId);
    if (spec === undefined) {
      return { ok: false, code: 'probe_unavailable', message: `No version probe for ${moduleId}.` };
    }
    const view = this.#consoles.get(consoleId);
    const policy = view?.id === consoleId ? view.policy : null;
    if (policy === null || policy.state === 'disabled') {
      return { ok: false, code: 'console_disabled', message: 'The console is disabled.' };
    }
    if ((policy.modules[moduleId]?.state ?? 'disabled') === 'disabled') {
      return { ok: false, code: 'module_disabled', message: `The ${moduleId} module is disabled.` };
    }
    const descriptor = this.#registry.get(spec.operationId);
    if (descriptor === undefined) {
      return { ok: false, code: 'probe_unavailable', message: 'The probe is not registered.' };
    }
    const signals = [AbortSignal.timeout(descriptor.timeoutMs)];
    if (options.signal !== undefined) signals.push(options.signal);
    const outcome = await this.#executor.execute({
      descriptor,
      arguments: {},
      target: { consoleId },
      signal: AbortSignal.any(signals),
      correlationId: randomUUID(),
      attempt: 1,
    });
    if (!outcome.ok) {
      return { ok: false, code: outcome.error.code, message: outcome.error.message };
    }
    const output = descriptor.outputSchema.safeParse(outcome.data);
    const version = output.success ? spec.version(output.data) : undefined;
    if (version === undefined || !PLAUSIBLE_VERSION.test(version)) {
      return {
        ok: false,
        code: 'upstream_contract_mismatch',
        message: 'The console did not report a usable application version.',
      };
    }
    const recorded = this.#consoles.recordObservedVersion(
      consoleId,
      moduleId,
      version,
      options.actor ?? { type: 'system' },
    );
    return { ok: true, version, ...recorded };
  }
}

export interface VersionMonitorOptions {
  prober: VersionProber;
  consoles: ConsoleRegistry;
  logger: Logger;
  /** How often to look for modules that need a probe. Default 30 s. */
  intervalMs?: number;
  /** How long a known version stays current. Default 6 h. */
  refreshMs?: number;
  /** Longest wait between retries of a failing probe. Default 30 min. */
  maxBackoffMs?: number;
  now?: () => number;
}

interface ProbeState {
  failures: number;
  nextAttemptAt: number;
  lastError?: string;
}

/** Keeps observed versions current; see the module comment. */
export class VersionMonitor {
  readonly #prober: VersionProber;
  readonly #consoles: ConsoleRegistry;
  readonly #logger: Logger;
  readonly #intervalMs: number;
  readonly #refreshMs: number;
  readonly #maxBackoffMs: number;
  readonly #now: () => number;
  readonly #state = new Map<string, ProbeState>();
  readonly #abort = new AbortController();
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;

  constructor(options: VersionMonitorOptions) {
    this.#prober = options.prober;
    this.#consoles = options.consoles;
    this.#logger = options.logger;
    this.#intervalMs = options.intervalMs ?? 30_000;
    this.#refreshMs = options.refreshMs ?? 6 * 60 * 60 * 1000;
    this.#maxBackoffMs = options.maxBackoffMs ?? 30 * 60 * 1000;
    this.#now = options.now ?? Date.now;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), this.#intervalMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#abort.abort();
    await this.#running;
  }

  /** One pass over all enabled modules; overlapping passes are skipped. */
  tick(): Promise<void> {
    this.#running ??= this.#pass().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #pass(): Promise<void> {
    const modules = new Set<string>(this.#prober.modules());
    const seen = new Set<string>();
    for (const view of this.#consoles.list()) {
      if (view.policy === null || view.policy.state === 'disabled') continue;
      for (const module of view.modules) {
        if (!modules.has(module.moduleId) || !module.hasCredential) continue;
        if ((view.policy.modules[module.moduleId]?.state ?? 'disabled') === 'disabled') continue;
        const key = `${view.id}/${module.moduleId}`;
        seen.add(key);
        const state = this.#state.get(key);
        const now = this.#now();
        const observedAt = module.observedAt === null ? 0 : Date.parse(module.observedAt);
        const due =
          state === undefined
            ? module.observedVersion === null || now - observedAt >= this.#refreshMs
            : state.failures > 0
              ? now >= state.nextAttemptAt
              : now - observedAt >= this.#refreshMs;
        if (!due || this.#abort.signal.aborted) continue;
        await this.#probe(view.id, view.alias, module.moduleId, key);
      }
    }
    // Forget modules that were disabled or removed.
    for (const key of this.#state.keys()) if (!seen.has(key)) this.#state.delete(key);
  }

  async #probe(consoleId: string, alias: string, moduleId: ModuleId, key: string): Promise<void> {
    let result: ProbeResult;
    try {
      result = await this.#prober.probe(consoleId, moduleId, { signal: this.#abort.signal });
    } catch (error) {
      this.#logger.error('version probe failed unexpectedly', { consoleId, moduleId, err: error });
      result = { ok: false, code: 'probe_error', message: 'The probe failed unexpectedly.' };
    }
    const previous = this.#state.get(key);
    if (result.ok) {
      if (previous !== undefined && previous.failures > 0) {
        this.#logger.info('console reachable again', { consoleId, moduleId });
      }
      if (result.changed) {
        this.#logger.info('console version observed', {
          consoleId,
          alias,
          moduleId,
          version: result.version,
          ...(result.previous === null ? {} : { previous: result.previous }),
        });
      }
      this.#state.set(key, { failures: 0, nextAttemptAt: 0 });
      return;
    }
    if (this.#abort.signal.aborted) return;
    const failures = (previous?.failures ?? 0) + 1;
    const backoff = Math.min(this.#intervalMs * 2 ** (failures - 1), this.#maxBackoffMs);
    if (failures === 1 || previous?.lastError !== result.code) {
      this.#logger.warn('console version probe failed', {
        consoleId,
        alias,
        moduleId,
        code: result.code,
        retryInMs: backoff,
      });
    }
    this.#state.set(key, {
      failures,
      nextAttemptAt: this.#now() + backoff,
      lastError: result.code,
    });
  }

  /** Modules whose last probe failed, as `consoleId/moduleId: code`. */
  failing(): string[] {
    return [...this.#state.entries()]
      .filter(([, state]) => state.failures > 0)
      .map(([key, state]) => `${key}: ${state.lastError ?? 'error'}`)
      .sort();
  }

  /** Non-critical: a failing probe degrades the service but never makes it unready. */
  healthCheck(): HealthCheck {
    return {
      name: 'console_versions',
      critical: false,
      run: () => {
        const failing = this.failing();
        return failing.length === 0
          ? { status: 'ok' }
          : { status: 'degraded', detail: `version probe failing: ${failing.join(', ')}` };
      },
    };
  }
}
