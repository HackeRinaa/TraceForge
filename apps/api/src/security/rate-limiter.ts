export interface LimitDecision {
  allowed: boolean;
  /** Seconds until `cost` tokens will be available, for the Retry-After header. */
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * In-memory token bucket keyed by an arbitrary string. State is per process: with N API replicas the effective limit is
 * N times the configured rate. That is a documented trade-off (docs/security.md); a shared limiter would need Redis.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly ratePerSecond: number,
    private readonly capacity: number,
    private readonly now: () => number = Date.now,
  ) {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  take(key: string, cost = 1): LimitDecision {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + ((now - bucket.updatedAt) / 1000) * this.ratePerSecond,
    );
    bucket.updatedAt = now;
    this.buckets.set(key, bucket);

    // A request larger than the whole bucket could never succeed; clamp so it needs a full bucket instead.
    const needed = Math.min(cost, this.capacity);
    if (bucket.tokens >= needed) {
      bucket.tokens -= needed;
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((needed - bucket.tokens) / this.ratePerSecond)),
    };
  }

  /** Drops buckets that have been full and idle, bounding memory under many distinct keys. */
  private sweep(): void {
    const cutoff = this.now() - 10 * 60_000;
    for (const [key, bucket] of this.buckets)
      if (bucket.updatedAt < cutoff) this.buckets.delete(key);
  }

  get size(): number {
    return this.buckets.size;
  }

  close(): void {
    clearInterval(this.sweeper);
  }
}
