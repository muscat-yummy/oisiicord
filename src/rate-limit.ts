/** Sliding token buckets. Denied requests do not extend the wait indefinitely. */
export class RateLimiter {
  private buckets = new Map<
    string,
    { tokens: number; at: number; until: number }
  >();
  constructor(
    private clock = Date.now,
    private maximum = 50000,
  ) {}
  consume(key: string, capacity: number, window: number) {
    const now = this.clock();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maximum) this.prune();
      if (this.buckets.size >= this.maximum) return Math.ceil(window / 1000);
      bucket = { tokens: capacity, at: now, until: now + window };
      this.buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(
      capacity,
      bucket.tokens + (Math.max(0, now - bucket.at) * capacity) / window,
    );
    bucket.at = now;
    bucket.until = now + window;
    if (bucket.tokens < 1)
      return Math.max(
        1,
        Math.ceil(((1 - bucket.tokens) * window) / capacity / 1000),
      );
    bucket.tokens--;
    return 0;
  }
  prune() {
    const now = this.clock();
    for (const [key, bucket] of this.buckets)
      if (bucket.until <= now) this.buckets.delete(key);
  }
}
