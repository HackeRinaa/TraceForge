export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** Injectable for deterministic tests. */
  random?: () => number;
}

/** Exponential backoff with full jitter: uniform in [0, min(maxMs, baseMs * 2^attempt)]. */
export function backoffDelayMs(
  attempt: number,
  { baseMs, maxMs, random = Math.random }: BackoffOptions,
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

export interface RetryOptions extends BackoffOptions {
  /** Total attempts including the first. */
  maxAttempts: number;
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Runs `fn`, retrying retryable failures with backoff. Always terminates after `maxAttempts`. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      const retryable = opts.isRetryable ? opts.isRetryable(error) : true;
      if (!retryable || attempt + 1 >= opts.maxAttempts) throw error;
      const delay = backoffDelayMs(attempt, opts);
      opts.onRetry?.(error, attempt + 1, delay);
      await sleep(delay);
    }
  }
}
