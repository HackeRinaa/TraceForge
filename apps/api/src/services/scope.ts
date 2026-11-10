import type { ResolvedRange } from '@traceforge/contracts';
import { resolveTimeRange, type ResolvedTimeRange } from '@traceforge/domain';
import type { analytics } from '@traceforge/storage';

interface RangeQuery {
  range?: '15m' | '1h' | '6h' | '24h' | '7d' | undefined;
  from?: string | undefined;
  to?: string | undefined;
  environment?: string | undefined;
  service?: string | undefined;
}

export function buildScope(
  projectId: string,
  q: RangeQuery,
): { scope: analytics.Scope; range: ResolvedTimeRange; rangeDto: ResolvedRange } {
  const range = resolveTimeRange(q);
  return {
    range,
    scope: {
      projectId,
      from: range.from,
      to: range.to,
      environment: q.environment,
      service: q.service,
    },
    rangeDto: {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      bucketSeconds: range.bucketSeconds,
    },
  };
}
