/**
 * Token-bucket rate limiting (spec §10). One request takes a token from several buckets
 * at once (client, console, console module, global), all or nothing, so a refused request
 * consumes no capacity anywhere.
 */
export interface RateLimit {
  /** Sustained requests per second. */
  ratePerSecond: number;
  /** Bucket size: the burst allowed after idle time. */
  burst: number;
}

export type RateDecision = { ok: true } | { ok: false; retryAfterMs: number; bucket: string };

interface Bucket {
  tokens: number;
  updatedAt: number;
  limit: RateLimit;
}

const MAX_BUCKETS = 10_000;

export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  take(requests: readonly { key: string; limit: RateLimit }[]): RateDecision {
    const now = this.#now();
    const buckets = requests.map(({ key, limit }) => ({
      key,
      bucket: this.#refill(key, limit, now),
    }));
    for (const { key, bucket } of buckets) {
      if (bucket.tokens < 1) {
        const retryAfterMs = Math.ceil(((1 - bucket.tokens) / bucket.limit.ratePerSecond) * 1000);
        return { ok: false, retryAfterMs, bucket: key };
      }
    }
    for (const { bucket } of buckets) bucket.tokens -= 1;
    return { ok: true };
  }

  #refill(key: string, limit: RateLimit, now: number): Bucket {
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      if (this.#buckets.size >= MAX_BUCKETS) this.#evictIdle(now);
      bucket = { tokens: limit.burst, updatedAt: now, limit };
      this.#buckets.set(key, bucket);
      return bucket;
    }
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(limit.burst, bucket.tokens + (elapsed / 1000) * limit.ratePerSecond);
    bucket.updatedAt = now;
    bucket.limit = limit;
    return bucket;
  }

  /** Full buckets carry no state worth keeping. */
  #evictIdle(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      const refilled =
        bucket.tokens + ((now - bucket.updatedAt) / 1000) * bucket.limit.ratePerSecond;
      if (refilled >= bucket.limit.burst) this.#buckets.delete(key);
    }
  }
}
