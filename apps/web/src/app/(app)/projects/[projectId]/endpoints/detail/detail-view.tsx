'use client';

import type { EndpointDetailResponse } from '@traceforge/contracts';
import { formatCount, formatDuration, formatPercent } from '@traceforge/domain/client';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMemo } from 'react';
import { Chart, usePalette } from '@/components/charts/chart';
import { DemoBadge } from '@/components/data/demo-badge';
import { Method, TraceTable } from '@/components/data/widgets';
import {
  EmptyState,
  ErrorState,
  PageHeader,
  Panel,
  Skeleton,
  TableSkeleton,
} from '@/components/ui/panel';
import { errorRateOption, latencyOption, throughputOption } from '@/lib/chart-options';
import { useProjectId, useProjectQuery } from '@/lib/hooks';
import { useScopedHref } from '@/lib/scope';

export function EndpointDetailView() {
  const sp = useSearchParams();
  const method = sp.get('method') ?? '';
  const route = sp.get('route') ?? '';
  const projectId = useProjectId();
  const scoped = useScopedHref();
  const palette = usePalette();
  const q = useProjectQuery<EndpointDetailResponse>(
    'endpoints/detail',
    { method, route },
    { enabled: !!method && !!route },
  );
  const d = q.data;

  const charts = useMemo(() => {
    if (!d || !palette) return null;
    return {
      throughput: throughputOption(d.series, d.range.bucketSeconds, d.range, palette),
      errors: errorRateOption(d.series, d.range, palette),
      latency: latencyOption(d.series, d.range, palette),
    };
  }, [d, palette]);

  if (!method || !route) {
    return (
      <EmptyState title="No endpoint selected">
        Choose an endpoint from the endpoints table.
      </EmptyState>
    );
  }

  const stats: Array<[string, string]> = d?.stat
    ? [
        ['Requests', formatCount(d.stat.requests)],
        ['Errors', `${formatCount(d.stat.errors)} (${formatPercent(d.stat.errorRate)})`],
        ['p50', formatDuration(d.stat.p50)],
        ['p95', formatDuration(d.stat.p95)],
        ['p99', formatDuration(d.stat.p99)],
      ]
    : [];

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-4">
      <Link
        href={scoped(`/projects/${projectId}/endpoints`)}
        className="inline-flex w-fit items-center gap-1.5 text-muted hover:text-text"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> All endpoints
      </Link>
      <PageHeader
        title={route}
        description={
          <>
            <Method method={method} />
            {d?.stat ? `served by ${d.stat.service}` : ''}
          </>
        }
        actions={<DemoBadge />}
      />
      {q.isError && !d && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {d && !d.stat && (
        <EmptyState title="No requests for this endpoint in the selected range">
          Widen the time range or clear the environment filter.
        </EmptyState>
      )}

      {(q.isPending || d?.stat) && (
        <>
          <section
            aria-label="Endpoint statistics"
            className="grid grid-cols-2 gap-3 md:grid-cols-5"
          >
            {!d
              ? Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-16" />)
              : stats.map(([k, v]) => (
                  <div key={k} className="rounded-panel border border-line bg-surface px-3.5 py-3">
                    <p className="text-[12px] text-muted">{k}</p>
                    <p className="tabular mt-1 text-[20px] font-semibold">{v}</p>
                  </div>
                ))}
          </section>
          <section className="grid gap-3 xl:grid-cols-3">
            <Panel title="Throughput" subtitle="requests per minute">
              <Chart option={charts?.throughput ?? null} label="Endpoint throughput" />
            </Panel>
            <Panel title="Error rate">
              <Chart option={charts?.errors ?? null} label="Endpoint error rate" />
            </Panel>
            <Panel title="Latency" subtitle="p50 · p95 · p99">
              <Chart option={charts?.latency ?? null} label="Endpoint latency percentiles" />
            </Panel>
          </section>
          <section className="grid gap-3 xl:grid-cols-2">
            <Panel title="Slowest recent traces" flush>
              {!d ? (
                <TableSkeleton />
              ) : d.slowTraces.length === 0 ? (
                <EmptyState title="No traces" />
              ) : (
                <TraceTable traces={d.slowTraces} label="Slowest traces" />
              )}
            </Panel>
            <Panel title="Recent failed traces" flush>
              {!d ? (
                <TableSkeleton />
              ) : d.errorTraces.length === 0 ? (
                <EmptyState title="No failures in this range" />
              ) : (
                <TraceTable traces={d.errorTraces} label="Failed traces" />
              )}
            </Panel>
          </section>
        </>
      )}
    </div>
  );
}
