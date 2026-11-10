'use client';

import type { OverviewResponse } from '@traceforge/contracts';
import { formatCount, formatDuration, formatPercent } from '@traceforge/domain/client';
import Link from 'next/link';
import { useMemo } from 'react';
import { Chart, usePalette } from '@/components/charts/chart';
import { DemoBadge } from '@/components/data/demo-badge';
import { EndpointMiniTable, IncidentRow, Kpi, TraceTable } from '@/components/data/widgets';
import { buttonClass } from '@/components/ui/button';
import {
  EmptyState,
  ErrorState,
  PageHeader,
  Panel,
  Skeleton,
  TableSkeleton,
} from '@/components/ui/panel';
import { Table, Td, Th, rowClass } from '@/components/ui/table';
import { errorRateOption, latencyOption, throughputOption } from '@/lib/chart-options';
import { formatDelta, percentChange, timeAgo } from '@/lib/format';
import { useProjectId, useProjectQuery } from '@/lib/hooks';
import { useScope, useScopedHref } from '@/lib/scope';

export function OverviewView() {
  const projectId = useProjectId();
  const scope = useScope();
  const scoped = useScopedHref();
  const q = useProjectQuery<OverviewResponse>('overview');
  const palette = usePalette();
  const d = q.data;

  const charts = useMemo(() => {
    if (!d || !palette) return null;
    const range = d.range;
    return {
      throughput: throughputOption(d.series, range.bucketSeconds, range, palette),
      errors: errorRateOption(d.series, range, palette),
      latency: latencyOption(d.series, range, palette),
    };
  }, [d, palette]);

  const rangeLabel = scope.range ? `last ${scope.range}` : 'custom range';

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-4">
      <PageHeader
        title="Overview"
        description={`${scope.environment ?? 'All environments'} · ${rangeLabel}${scope.service ? ` · ${scope.service}` : ''}`}
        actions={<DemoBadge />}
      />

      {q.isError && !d && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.isError && d && (
        <p role="alert" className="rounded-control bg-warn-soft px-3 py-2 text-warn-text">
          Showing the last loaded data; refreshing failed: {q.error.message}
        </p>
      )}

      {d && d.totals.requests === 0 && d.ingestion.status === 'idle' && (
        <Panel>
          <EmptyState
            title="No telemetry in this time range"
            action={
              <div className="mt-2 flex gap-2">
                <Link
                  href={scoped(`/projects/${projectId}/settings`)}
                  className={buttonClass('primary')}
                >
                  Create an API key
                </Link>
                <Link
                  href={scoped(`/projects/${projectId}/settings`, {})}
                  className={buttonClass('secondary')}
                >
                  Setup instructions
                </Link>
              </div>
            }
          >
            Point an OpenTelemetry exporter at this project, or run the bundled demo services (
            <span className="font-mono">pnpm dev:demo</span>) and generate traffic from Settings.
          </EmptyState>
        </Panel>
      )}

      <section
        aria-label="Key metrics"
        className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5"
      >
        {!d
          ? Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-[104px]" />)
          : [
              {
                label: 'Requests / min',
                value: formatCount(
                  Math.round(
                    d.totals.requests /
                      ((Date.parse(d.range.to) - Date.parse(d.range.from)) / 60_000) || 0,
                  ),
                ),
                delta: formatDelta(percentChange(d.totals.requests, d.previous.requests)),
                spark: d.series.map((s) => s.requests),
              },
              {
                label: 'Error rate',
                value: d.totals.errorRate === null ? '—' : d.totals.errorRate.toFixed(2),
                unit: d.totals.errorRate === null ? undefined : '%',
                delta:
                  d.totals.errorRate !== null && d.previous.errorRate !== null
                    ? `${d.totals.errorRate - d.previous.errorRate >= 0 ? '+' : '−'}${Math.abs(d.totals.errorRate - d.previous.errorRate).toFixed(2)} pp`
                    : '—',
                deltaTone:
                  d.totals.errorRate !== null &&
                  d.previous.errorRate !== null &&
                  d.totals.errorRate > d.previous.errorRate
                    ? ('bad' as const)
                    : ('neutral' as const),
                spark: d.series.map((s) => s.errorRate),
                sparkColor: 'var(--err)',
              },
              ...(['p50', 'p95', 'p99'] as const).map((k, i) => {
                const change = percentChange(d.totals[k], d.previous[k]);
                return {
                  label: `${k} latency`,
                  value: formatDuration(d.totals[k]),
                  delta: formatDelta(change),
                  deltaTone:
                    change !== null && change > 20 ? ('warn' as const) : ('neutral' as const),
                  spark: d.series.map((s) => s[k]),
                  sparkColor: `var(--series-${i + 1})`,
                };
              }),
            ].map((k) => <Kpi key={k.label} {...k} />)}
      </section>

      <section className="grid gap-3 xl:grid-cols-3" aria-label="Charts">
        <Panel title="Throughput" subtitle="requests per minute">
          <Chart option={charts?.throughput ?? null} label="Requests per minute over time" />
        </Panel>
        <Panel title="Error rate" subtitle="percent of requests that failed">
          <Chart option={charts?.errors ?? null} label="Error rate over time" />
        </Panel>
        <Panel title="Latency" subtitle="p50 · p95 · p99">
          <Chart option={charts?.latency ?? null} label="Latency percentiles over time" />
        </Panel>
      </section>

      <section className="grid gap-3 xl:grid-cols-2">
        <Panel
          title="Slowest endpoints"
          subtitle="ranked by p95"
          flush
          actions={
            <Link
              href={scoped(`/projects/${projectId}/endpoints`)}
              className="text-accent hover:underline"
            >
              All endpoints →
            </Link>
          }
        >
          {!d ? (
            <TableSkeleton />
          ) : d.slowestEndpoints.length === 0 ? (
            <EmptyState title="No endpoints yet" />
          ) : (
            <EndpointMiniTable
              rows={d.slowestEndpoints}
              highlight="p95"
              label="Slowest endpoints"
            />
          )}
        </Panel>
        <Panel title="Highest error rates" subtitle="endpoints with failures in this range" flush>
          {!d ? (
            <TableSkeleton />
          ) : d.errorEndpoints.length === 0 ? (
            <EmptyState title="No failing endpoints">
              Nothing returned an error in this time range.
            </EmptyState>
          ) : (
            <EndpointMiniTable
              rows={d.errorEndpoints}
              highlight="errorRate"
              label="Endpoints with the highest error rate"
            />
          )}
        </Panel>
      </section>

      <section className="grid gap-3 xl:grid-cols-3">
        <Panel
          title="Recent traces"
          flush
          className="xl:col-span-2"
          actions={
            <Link
              href={scoped(`/projects/${projectId}/traces`)}
              className="text-accent hover:underline"
            >
              Open explorer →
            </Link>
          }
        >
          {!d ? (
            <TableSkeleton />
          ) : d.recentTraces.length === 0 ? (
            <EmptyState title="No traces in this range" />
          ) : (
            <TraceTable traces={d.recentTraces} label="Recent traces" />
          )}
        </Panel>
        <div className="flex flex-col gap-3">
          <Panel title="Service health" flush>
            {!d ? (
              <TableSkeleton rows={3} cols={3} />
            ) : d.services.length === 0 ? (
              <EmptyState title="No services reporting" />
            ) : (
              <Table label="Service health" minWidth={300}>
                <thead>
                  <tr>
                    <Th>Service</Th>
                    <Th align="right">Req</Th>
                    <Th align="right">Err</Th>
                    <Th align="right">p95</Th>
                  </tr>
                </thead>
                <tbody>
                  {d.services.map((s) => (
                    <tr key={s.service} className={rowClass}>
                      <Td className="font-mono">{s.service}</Td>
                      <Td align="right" mono>
                        {formatCount(s.requests)}
                      </Td>
                      <Td
                        align="right"
                        mono
                        className={(s.errorRate ?? 0) > 1 ? 'text-err-text' : 'text-muted'}
                      >
                        {formatPercent(s.errorRate, 1)}
                      </Td>
                      <Td align="right" mono>
                        {formatDuration(s.p95)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>
          <Panel title="Active incidents" flush>
            {!d ? (
              <TableSkeleton rows={2} cols={2} />
            ) : d.activeIncidents.length === 0 ? (
              <EmptyState title="No active incidents" />
            ) : (
              d.activeIncidents.map((i) => <IncidentRow key={i.id} incident={i} />)
            )}
          </Panel>
          {d && (
            <Panel title="Ingestion health">
              <dl className="grid grid-cols-2 gap-y-1.5">
                <dt className="text-muted">Status</dt>
                <dd className="text-right font-mono">{d.ingestion.status}</dd>
                <dt className="text-muted">Last span</dt>
                <dd className="text-right font-mono">{timeAgo(d.ingestion.lastSpanAt)}</dd>
                <dt className="text-muted">Spans / min</dt>
                <dd className="text-right font-mono">{d.ingestion.spansLastMinute}</dd>
                <dt className="text-muted">Visibility delay</dt>
                <dd className="text-right font-mono">
                  {d.ingestion.visibilityDelayMs === null
                    ? '—'
                    : formatDuration(d.ingestion.visibilityDelayMs)}
                </dd>
              </dl>
            </Panel>
          )}
        </div>
      </section>
    </div>
  );
}
