'use client';

import type { ErrorDetailResponse } from '@traceforge/contracts';
import { formatCount } from '@traceforge/domain/client';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useMemo } from 'react';
import { Chart, usePalette } from '@/components/charts/chart';
import { Method } from '@/components/data/widgets';
import { EmptyState, ErrorState, PageHeader, Panel, Skeleton } from '@/components/ui/panel';
import { Table, Td, Th, rowClass } from '@/components/ui/table';
import { countOption } from '@/lib/chart-options';
import { formatTimestamp } from '@/lib/format';
import { useProjectId, useProjectQuery } from '@/lib/hooks';
import { useScopedHref } from '@/lib/scope';

export function ErrorDetailView({ fingerprint }: { fingerprint: string }) {
  const projectId = useProjectId();
  const scoped = useScopedHref();
  const palette = usePalette();
  const q = useProjectQuery<ErrorDetailResponse>(`errors/${fingerprint}`);
  const d = q.data;
  const option = useMemo(
    () => (d && palette ? countOption(d.series, 'Occurrences', d.range, palette) : null),
    [d, palette],
  );

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-4">
      <Link
        href={scoped(`/projects/${projectId}/errors`)}
        className="inline-flex w-fit items-center gap-1.5 text-muted hover:text-text"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> All errors
      </Link>
      {q.isPending && <Skeleton className="h-64" />}
      {q.isError &&
        (q.error.status === 404 ? (
          <Panel>
            <EmptyState title="No occurrences in this time range">
              This error group has no occurrences here. Widen the time range to find it.
            </EmptyState>
          </Panel>
        ) : (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ))}
      {d?.group && (
        <>
          <PageHeader
            title={d.group.errorType}
            description={<span className="break-words">{d.group.message}</span>}
          />
          <section className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="Error statistics">
            {[
              ['Occurrences', formatCount(d.group.count)],
              ['First seen', formatTimestamp(d.group.firstSeen)],
              ['Last seen', formatTimestamp(d.group.lastSeen)],
              ['Services', d.group.services.join(', ')],
            ].map(([k, v]) => (
              <div key={k} className="rounded-panel border border-line bg-surface px-3.5 py-3">
                <p className="text-[12px] text-muted">{k}</p>
                <p className="tabular mt-1 font-mono text-[15px] font-semibold break-words">{v}</p>
              </div>
            ))}
          </section>
          <section className="grid gap-3 xl:grid-cols-2">
            <Panel title="Occurrences over time">
              <Chart option={option} label="Error occurrences over time" />
            </Panel>
            <Panel
              title="Endpoints involved"
              subtitle="HTTP requests that shared a trace with these errors"
            >
              {d.group.endpoints.length === 0 ? (
                <p className="text-muted">No HTTP endpoint is associated with these occurrences.</p>
              ) : (
                <ul className="space-y-1.5">
                  {d.group.endpoints.map((e) => (
                    <li key={e.method + e.route}>
                      <Link
                        href={scoped(`/projects/${projectId}/endpoints/detail`, {
                          method: e.method,
                          route: e.route,
                        })}
                        className="font-mono hover:underline"
                      >
                        <Method method={e.method} />
                        {e.route}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </section>
          {d.stack && (
            <Panel
              title="Example stack trace"
              subtitle="From the most recent occurrence that recorded one"
            >
              <pre className="overflow-x-auto rounded-control bg-surface-2 p-3 font-mono text-[12px] leading-relaxed">
                {d.stack}
              </pre>
            </Panel>
          )}
          <Panel title="Recent occurrences" flush>
            <Table label="Recent occurrences" minWidth={640}>
              <thead>
                <tr>
                  <Th>Time</Th>
                  <Th>Service</Th>
                  <Th>Span</Th>
                  <Th>Environment</Th>
                  <Th>Trace</Th>
                </tr>
              </thead>
              <tbody>
                {d.occurrences.map((o) => (
                  <tr key={o.spanId + o.traceId} className={rowClass}>
                    <Td mono className="text-muted">
                      {formatTimestamp(o.time)}
                    </Td>
                    <Td className="font-mono">{o.service}</Td>
                    <Td className="font-mono">{o.spanName}</Td>
                    <Td className="text-muted">{o.environment}</Td>
                    <Td>
                      <Link
                        href={scoped(`/projects/${projectId}/traces/${o.traceId}`, {
                          span: o.spanId,
                        })}
                        className="font-mono text-accent hover:underline"
                      >
                        {o.traceId.slice(0, 12)}
                      </Link>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Panel>
        </>
      )}
    </div>
  );
}
