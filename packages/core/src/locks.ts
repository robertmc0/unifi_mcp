/**
 * Keyed asynchronous mutex for resource locks (spec §10): conflicting writes to the same
 * console resource run strictly one at a time, in arrival order. Waiting can be cancelled
 * through an AbortSignal without blocking later waiters.
 */
interface Waiter {
  grant: () => void;
  cancelled: boolean;
}

export class KeyedMutex {
  readonly #held = new Map<string, Waiter[]>();

  /** Resolves with a release function once the lock for `key` is held. */
  acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signal.reason as Error);
        return;
      }
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        this.#next(key);
      };
      const waiter: Waiter = {
        cancelled: false,
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve(release);
        },
      };
      const onAbort = (): void => {
        waiter.cancelled = true;
        reject(signal?.reason as Error);
      };
      const queue = this.#held.get(key);
      if (queue === undefined) {
        // Free: the holder is represented by an empty queue entry.
        this.#held.set(key, []);
        waiter.grant();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      queue.push(waiter);
    });
  }

  isLocked(key: string): boolean {
    return this.#held.has(key);
  }

  #next(key: string): void {
    const queue = this.#held.get(key);
    if (queue === undefined) return;
    let waiter = queue.shift();
    while (waiter?.cancelled === true) waiter = queue.shift();
    if (waiter === undefined) {
      this.#held.delete(key);
      return;
    }
    waiter.grant();
  }
}
