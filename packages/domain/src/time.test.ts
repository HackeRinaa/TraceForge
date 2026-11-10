import { describe, expect, it } from 'vitest';
import { chooseBucketSeconds, fillBuckets, previousRange, resolveTimeRange } from './time';

describe('chooseBucketSeconds', () => {
  it.each([
    [15 * 60_000, 10],
    [60 * 60_000, 30],
    [6 * 3_600_000, 300],
    [24 * 3_600_000, 900],
    [7 * 86_400_000, 3600],
    [14 * 86_400_000, 7200],
  ])('range %i ms -> %i s buckets', (rangeMs, expected) => {
    expect(chooseBucketSeconds(rangeMs)).toBe(expected);
  });

  it('never yields more than 180 points for supported ranges', () => {
    for (const hours of [0.25, 1, 3, 6, 12, 24, 72, 168, 336]) {
      const points = (hours * 3600) / chooseBucketSeconds(hours * 3_600_000);
      expect(points).toBeLessThanOrEqual(180);
    }
  });
});

describe('resolveTimeRange', () => {
  const now = new Date('2026-10-27T14:32:17Z');

  it('defaults to the last hour and aligns the start to a bucket boundary', () => {
    const r = resolveTimeRange({}, now);
    expect(r.bucketSeconds).toBe(30);
    expect(r.to.toISOString()).toBe('2026-10-27T14:32:17.000Z');
    expect(r.from.toISOString()).toBe('2026-10-27T13:32:00.000Z');
  });

  it('uses absolute bounds when provided', () => {
    const r = resolveTimeRange({ from: '2026-10-27T00:00:00Z', to: '2026-10-27T06:00:00Z' }, now);
    expect(r.from.toISOString()).toBe('2026-10-27T00:00:00.000Z');
    expect(r.bucketSeconds).toBe(300);
  });

  it('computes the preceding window of equal length', () => {
    const r = resolveTimeRange({ range: '15m' }, now);
    const prev = previousRange(r);
    expect(prev.to.getTime()).toBe(r.from.getTime());
    expect(prev.to.getTime() - prev.from.getTime()).toBe(r.to.getTime() - r.from.getTime());
  });
});

describe('fillBuckets', () => {
  it('emits an explicit empty entry for every missing bucket', () => {
    const from = new Date('2026-10-27T10:00:00Z');
    const to = new Date('2026-10-27T10:03:30Z');
    const have = new Map([[Date.parse('2026-10-27T10:01:00Z'), 'data']]);
    const out = fillBuckets(have, from, to, 60, (t) => `empty@${t.toISOString().slice(11, 16)}`);
    expect(out).toEqual(['empty@10:00', 'data', 'empty@10:02', 'empty@10:03']);
  });
});
