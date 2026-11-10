/**
 * Bounded, fair job scheduler (spec §10).
 *
 * - Concurrency is capped globally and per key (a console module, e.g. `console-1/network`).
 * - Queues are bounded globally, per key and per client. There is no unbounded backlog:
 *   a full queue is refused immediately with `queue_full`.
 * - Within a key, waiting clients are served round-robin, and keys are served round-robin,
 *   so one busy client or console cannot starve the others.
 * - A job that has not started by its deadline fails with `deadline_exceeded`. Running jobs
 *   are never interrupted by the scheduler; callers bound them with their own timeouts.
 * - Queued jobs can be cancelled per client (token revocation) or all at once (hard lock,
 *   shutdown) with `cancelled`.
 */
export interface SchedulerLimits {
  globalConcurrency: number;
  perKeyConcurrency: number;
  globalQueue: number;
  perKeyQueue: number;
  perClientQueued: number;
}

export type SchedulerErrorCode = 'queue_full' | 'deadline_exceeded' | 'cancelled' | 'shutting_down';

export class SchedulerError extends Error {
  override readonly name = 'SchedulerError';
  readonly code: SchedulerErrorCode;

  constructor(code: SchedulerErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface JobOptions {
  key: string;
  clientId: string;
  /** Epoch milliseconds by which the job must have started. */
  startBy: number;
}

interface QueuedJob {
  options: JobOptions;
  start: () => void;
  fail: (error: SchedulerError) => void;
  timer: NodeJS.Timeout;
}

interface KeyState {
  running: number;
  queued: number;
  clients: Map<string, QueuedJob[]>;
}

export class Scheduler {
  readonly #limits: SchedulerLimits;
  readonly #now: () => number;
  readonly #keys = new Map<string, KeyState>();
  readonly #clientQueued = new Map<string, number>();
  readonly #idleWaiters: (() => void)[] = [];
  #running = 0;
  #queued = 0;
  #accepting = true;

  constructor(limits: SchedulerLimits, now: () => number = () => Date.now()) {
    this.#limits = limits;
    this.#now = now;
  }

  get running(): number {
    return this.#running;
  }

  get queued(): number {
    return this.#queued;
  }

  /** Runs `task` when capacity allows. Rejects with SchedulerError if it cannot start. */
  run<T>(options: JobOptions, task: () => Promise<T>): Promise<T> {
    if (!this.#accepting) {
      return Promise.reject(new SchedulerError('shutting_down', 'The service is shutting down.'));
    }
    const state = this.#state(options.key);
    const startNow =
      this.#running < this.#limits.globalConcurrency &&
      state.running < this.#limits.perKeyConcurrency &&
      state.queued === 0;
    if (startNow) return this.#execute(state, task);

    if (
      this.#queued >= this.#limits.globalQueue ||
      state.queued >= this.#limits.perKeyQueue ||
      (this.#clientQueued.get(options.clientId) ?? 0) >= this.#limits.perClientQueued
    ) {
      return Promise.reject(
        new SchedulerError('queue_full', 'Too many requests are waiting; try again later.'),
      );
    }
    const delay = Math.max(0, options.startBy - this.#now());
    return new Promise<T>((resolve, reject) => {
      const job: QueuedJob = {
        options,
        start: () => {
          this.#execute(state, task).then(resolve, reject);
        },
        fail: reject,
        timer: setTimeout(() => {
          if (this.#remove(job)) {
            reject(
              new SchedulerError(
                'deadline_exceeded',
                'The request could not start before its deadline.',
              ),
            );
            this.#pump();
          }
        }, delay),
      };
      job.timer.unref();
      const queue = state.clients.get(options.clientId);
      if (queue === undefined) state.clients.set(options.clientId, [job]);
      else queue.push(job);
      state.queued++;
      this.#queued++;
      this.#clientQueued.set(options.clientId, (this.#clientQueued.get(options.clientId) ?? 0) + 1);
    });
  }

  /** Cancels this client's queued jobs (token revocation). Running jobs are unaffected. */
  cancelClient(clientId: string): number {
    return this.#cancelWhere((job) => job.options.clientId === clientId);
  }

  /** Cancels every queued job (hard lock, policy invalidation). */
  cancelAll(): number {
    return this.#cancelWhere(() => true);
  }

  /** Stops accepting work, cancels queued jobs and resolves once running jobs finish. */
  async drain(): Promise<void> {
    this.#accepting = false;
    this.cancelAll();
    if (this.#running === 0) return;
    await new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
  }

  #cancelWhere(predicate: (job: QueuedJob) => boolean): number {
    let cancelled = 0;
    for (const state of this.#keys.values()) {
      for (const queue of state.clients.values()) {
        for (const job of [...queue]) {
          if (predicate(job) && this.#remove(job)) {
            cancelled++;
            job.fail(new SchedulerError('cancelled', 'The queued request was cancelled.'));
          }
        }
      }
    }
    return cancelled;
  }

  #state(key: string): KeyState {
    let state = this.#keys.get(key);
    if (state === undefined) {
      state = { running: 0, queued: 0, clients: new Map() };
      this.#keys.set(key, state);
    }
    return state;
  }

  #remove(job: QueuedJob): boolean {
    const state = this.#keys.get(job.options.key);
    const queue = state?.clients.get(job.options.clientId);
    const index = queue?.indexOf(job) ?? -1;
    if (state === undefined || queue === undefined || index < 0) return false;
    queue.splice(index, 1);
    if (queue.length === 0) state.clients.delete(job.options.clientId);
    clearTimeout(job.timer);
    state.queued--;
    this.#queued--;
    const remaining = (this.#clientQueued.get(job.options.clientId) ?? 1) - 1;
    if (remaining <= 0) this.#clientQueued.delete(job.options.clientId);
    else this.#clientQueued.set(job.options.clientId, remaining);
    return true;
  }

  async #execute<T>(state: KeyState, task: () => Promise<T>): Promise<T> {
    state.running++;
    this.#running++;
    try {
      return await task();
    } finally {
      state.running--;
      this.#running--;
      this.#pump();
      if (this.#running === 0) {
        for (const resolve of this.#idleWaiters.splice(0)) resolve();
      }
    }
  }

  /** Starts queued jobs while capacity allows, rotating over keys and clients. */
  #pump(): void {
    let progressed = true;
    while (progressed && this.#running < this.#limits.globalConcurrency && this.#queued > 0) {
      progressed = false;
      for (const [key, state] of [...this.#keys]) {
        if (this.#running >= this.#limits.globalConcurrency) break;
        if (state.queued === 0 || state.running >= this.#limits.perKeyConcurrency) continue;
        const [clientId, queue] = state.clients.entries().next().value ?? [];
        const job = queue?.[0];
        if (clientId === undefined || job === undefined) continue;
        this.#remove(job);
        // Rotate: this client goes to the back of its key, this key to the back of all keys.
        if (state.clients.has(clientId)) {
          const rest = state.clients.get(clientId) ?? [];
          state.clients.delete(clientId);
          state.clients.set(clientId, rest);
        }
        this.#keys.delete(key);
        this.#keys.set(key, state);
        job.start();
        progressed = true;
      }
    }
    for (const [key, state] of this.#keys) {
      if (state.running === 0 && state.queued === 0) this.#keys.delete(key);
    }
  }
}
