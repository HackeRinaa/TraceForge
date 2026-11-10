'use client';

import { ENDPOINT_SORT_FIELDS, type EndpointsResponse } from '@traceforge/contracts';
import { formatCount, formatDuration, formatPercent } from '@traceforge/domain/client';
import { Search } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { EndpointLink } from '@/components/data/widgets';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/fields';
import { EmptyState, ErrorState, PageHeader, Panel, TableSkeleton } from '@/components/ui/panel';
import { SortTh, Table, Td, Th, rowClass } from '@/components/ui/table';
import { useProjectQuery } from '@/lib/hooks';
import { useScope, useSetSearchParams } from '@/lib/scope';

type SortField = (typeof ENDPOINT_SORT_FIELDS)[number];
const PAGE_SIZE = 25;

export function EndpointsView() {
  const sp = useSearchParams();
  const scope = useScope();
  const setParams = useSetSearchParams();

  const search = sp.get('search') ?? '';
  const sort = (ENDPOINT_SORT_FIELDS as readonly string[]).includes(sp.get('sort') ?? '')
    ? (sp.get('sort') as SortField)
    : 'p95';
  const order = sp.get('order') === 'asc' ? 'asc' : 'desc';
  const offset = Math.max(0, Number(sp.get('offset') ?? 0) || 0);

  // While the user is typing, `draft` holds the text (instant feedback); the URL and query update after a short pause.
  // `null` means "not editing": the box then simply reflects the URL, so back/forward navigation needs no syncing.
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    if (draft === null) return;
    const t = setTimeout(() => {
      setParams({ search: draft || null, offset: null });
      setDraft(null);
    }, 300);
    return () => clearTimeout(t);
  }, [draft, setParams]);

  const q = useProjectQuery<EndpointsResponse>('endpoints', {
    search: search || undefined,
    sort,
    order,
    limit: PAGE_SIZE,
    offset,
  });

  const onSort = (field: SortField) =>
    setParams({
      sort: field,
      order: sort === field && order === 'desc' ? 'asc' : 'desc',
      offset: null,
    });

  const headers: Array<[SortField, string]> = [
    ['requests', 'Requests'],
    ['errors', 'Errors'],
    ['errorRate', 'Error rate'],
    ['p50', 'p50'],
    ['p95', 'p95'],
    ['p99', 'p99'],
  ];

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-4">
      <PageHeader
        title="Endpoints"
        description={`Normalized routes · ${scope.environment ?? 'all environments'} · ${scope.range ? `last ${scope.range}` : 'custom range'}`}
        actions={
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-2 left-2.5 size-3.5 text-dim"
              aria-hidden
            />
            <Input
              aria-label="Filter endpoints"
              placeholder="Filter routes…"
              value={draft ?? search}
              onChange={(e) => setDraft(e.target.value)}
              className="w-64 pl-8"
            />
          </div>
        }
      />
      <Panel flush>
        {q.isPending && <TableSkeleton rows={8} cols={6} />}
        {q.isError && (
          <div className="p-4">
            <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          </div>
        )}
        {q.data && q.data.endpoints.length === 0 && (
          <EmptyState
            title={search ? 'No endpoints match your filter' : 'No endpoints in this time range'}
          >
            {search
              ? 'Try a different search or widen the time range.'
              : 'Endpoints appear once the service receives HTTP requests.'}
          </EmptyState>
        )}
        {q.data && q.data.endpoints.length > 0 && (
          <>
            <Table label="Endpoints" minWidth={820}>
              <thead>
                <tr>
                  <Th>Endpoint</Th>
                  {headers.map(([field, label]) => (
                    <SortTh
                      key={field}
                      label={label}
                      active={sort === field}
                      direction={order}
                      onSort={() => onSort(field)}
                    />
                  ))}
                </tr>
              </thead>
              <tbody>
                {q.data.endpoints.map((e) => (
                  <tr key={`${e.service}${e.method}${e.route}`} className={rowClass}>
                    <Td>
                      <EndpointLink stat={e} />
                      <span className="ml-2 text-[11px] text-dim">{e.service}</span>
                    </Td>
                    <Td align="right" mono>
                      {formatCount(e.requests)}
                    </Td>
                    <Td align="right" mono>
                      {formatCount(e.errors)}
                    </Td>
                    <Td
                      align="right"
                      mono
                      className={(e.errorRate ?? 0) > 1 ? 'text-err-text' : undefined}
                    >
                      {formatPercent(e.errorRate)}
                    </Td>
                    <Td align="right" mono className="text-muted">
                      {formatDuration(e.p50)}
                    </Td>
                    <Td align="right" mono>
                      {formatDuration(e.p95)}
                    </Td>
                    <Td align="right" mono className="text-muted">
                      {formatDuration(e.p99)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-muted">
              <span>
                {offset + 1}–{offset + q.data.endpoints.length} of {q.data.total}
              </span>
              <span className="flex gap-2">
                <Button
                  size="sm"
                  disabled={offset === 0}
                  onClick={() =>
                    setParams({ offset: String(Math.max(0, offset - PAGE_SIZE)) || null })
                  }
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  disabled={offset + PAGE_SIZE >= q.data.total}
                  onClick={() => setParams({ offset: String(offset + PAGE_SIZE) })}
                >
                  Next
                </Button>
              </span>
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}
