import type { RangePreset } from '@traceforge/contracts';

export const DEFAULT_RANGE: RangePreset = '1h';

const PRESET_MS: Record<RangePreset, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
};

/** Candidate bucket widths in seconds, smallest first. */
const BUCKET_CANDIDATES = [10, 30, 60, 300, 900, 1800, 3600, 7200, 10_800];
const MAX_POINTS = 180;

export interface ResolvedTimeRange {
  from: Date;
  to: Date;
  bucketSeconds: number;
}

/** Smallest standard bucket that keeps a chart under MAX_POINTS points. */
export function chooseBucketSeconds(rangeMs: number): number {
  const rangeSeconds = Math.max(1, rangeMs / 1000);
  return (
    BUCKET_CANDIDATES.find((s) => rangeSeconds / s <= MAX_POINTS) ??
    BUCKET_CANDIDATES[BUCKET_CANDIDATES.length - 1] ??
    10_800
  );
}

/**
 * Resolves the relative or absolute range from a query into concrete bounds. The start is aligned down to a
 * bucket boundary so the first chart bucket is never a misleading partial bucket of a different width.
 */
export function resolveTimeRange(
  q: { range?: RangePreset | undefined; from?: string | undefined; to?: string | undefined },
  now: Date = new Date(),
): ResolvedTimeRange {
  let from: number;
  let to: number;
  if (q.from !== undefined && q.to !== undefined) {
    from = Date.parse(q.from);
    to = Date.parse(q.to);
  } else {
    to = now.getTime();
    from = to - PRESET_MS[q.range ?? DEFAULT_RANGE];
  }
  const bucketSeconds = chooseBucketSeconds(to - from);
  const bucketMs = bucketSeconds * 1000;
  return {
    from: new Date(Math.floor(from / bucketMs) * bucketMs),
    to: new Date(to),
    bucketSeconds,
  };
}

/** The same-length window immediately before `range`, used for period-over-period deltas. */
export function previousRange(range: ResolvedTimeRange): { from: Date; to: Date } {
  const length = range.to.getTime() - range.from.getTime();
  return { from: new Date(range.from.getTime() - length), to: new Date(range.from.getTime()) };
}

/**
 * Produces one entry per bucket between `from` and `to`, using `rows` where present and `empty(t)` otherwise.
 * Gaps are explicit so charts show zero traffic as zero (counts) or missing (latency), never interpolated.
 */
export function fillBuckets<T>(
  rows: ReadonlyMap<number, T>,
  from: Date,
  to: Date,
  bucketSeconds: number,
  empty: (t: Date) => T,
): T[] {
  const step = bucketSeconds * 1000;
  const out: T[] = [];
  for (let t = Math.floor(from.getTime() / step) * step; t <= to.getTime(); t += step) {
    out.push(rows.get(t) ?? empty(new Date(t)));
  }
  return out;
}
