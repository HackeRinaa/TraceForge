import { describe, expect, it, vi } from 'vitest';
import { backoffDelayMs, withRetry } from './retry';

describe('backoffDelayMs', () => {
  it('grows exponentially, is capped, and is jittered within [0, ceiling]', () => {
    const opts = { baseMs: 100, maxMs: 1000 };
    expect(backoffDelayMs(0, { ...opts, random: () => 0.999 })).toBeLessThan(100);
    expect(backoffDelayMs(2, { ...opts, random: () => 0.999 })).toBeLessThan(400);
    expect(backoffDelayMs(10, { ...opts, random: () => 0.999 })).toBeLessThan(1000);
    expect(backoffDelayMs(3, { ...opts, random: () => 0 })).toBe(0);
  });
});

describe('withRetry', () => {
  const opts = { baseMs: 1, maxMs: 2, maxAttempts: 4, sleep: () => Promise.resolve() };

  it('returns the first success', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue('ok');
    await expect(withRetry(fn, opts)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up after maxAttempts so retries always terminate', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('down'));
    await expect(withRetry(fn, opts)).rejects.toThrow('down');
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('does not retry non-retryable errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('bad input'));
    await expect(withRetry(fn, { ...opts, isRetryable: () => false })).rejects.toThrow('bad input');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reports each retry', async () => {
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('a'))
      .mockRejectedValueOnce(new Error('b'))
      .mockResolvedValue(1);
    await withRetry(fn, { ...opts, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]?.[1]).toBe(1);
  });
});
