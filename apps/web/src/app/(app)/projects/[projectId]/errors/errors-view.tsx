'use client';

import type { ErrorsResponse } from '@traceforge/contracts';
import { formatCount } from '@traceforge/domain/client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { DemoBadge } from '@/components/data/demo-badge';
import { Method } from '@/components/data/widgets';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/fields';
import { EmptyState, ErrorState, PageHeader, Panel, TableSkeleton } from '@/components/ui/panel';
import { Table, Td, Th, rowClass } from '@/components/ui/table';
import { formatTimestamp, timeAgo } from '@/lib/format';
import { useProjectId, useProjectQuery } from '@/lib/hooks';
import { useScopedHref, useSetSearchParams } from '@/lib/scope';

const PAGE = 25;

export function ErrorsView() {
  const projectId = useProjectId();
  const scoped = useScopedHref();
  const sp = useSearchParams();
  const setParams = useSetSearchParams();
  const sort = sp.get('sort') === 'count' ? 'count' : 'lastSeen';
  const offset = Math.max(0, Number(sp.get('offset') ?? 0) || 0);
  const q = useProjectQuery<ErrorsResponse>('errors', { sort, limit: PAGE, offset });

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-4">
      <PageHeader
        title="Errors"
        description="Failures grouped by a stable fingerprint: service, exception type, message with ids and numbers normalized, operation and throwing function."
        actions={
          <>
            <DemoBadge />
            <label className="sr-only" htmlFor="err-sort">
              Sort errors
            </label>
            <Select
              id="err-sort"
              className="w-44"
              value={sort}
              onChange={(e) => setParams({ sort: e.target.value, offset: null })}
            >
              <option value="lastSeen">Most recent first</option>
              <option value="count">Most frequent first</option>
            </Select>
          </>
        }
      />
      <Panel flush>
        {q.isPending && <TableSkeleton rows={6} cols={5} />}
        {q.isError && !q.data && (
          <div className="p-4">
            <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          </div>
        )}
        {q.data && q.data.groups.length === 0 && (
          <EmptyState title="No errors in this time range">
            Failed spans and 5xx responses are grouped here automatically.
          </EmptyState>
        )}
        {q.data && q.data.groups.length > 0 && (
          <>
            <Table label="Error groups" minWidth={860}>
              <thead>
                <tr>
                  <Th>Error</Th>
                  <Th align="right">Occurrences</Th>
                  <Th>Services</Th>
                  <Th>Endpoints involved</Th>
                  <Th>First seen</Th>
                  <Th>Last seen</Th>
                </tr>
              </thead>
              <tbody>
                {q.data.groups.map((g) => (
                  <tr key={g.fingerprint} className={rowClass}>
                    <Td className="max-w-[28rem]">
                      <Link
                        href={scoped(`/projects/${projectId}/errors/${g.fingerprint}`)}
                        className="font-medium hover:underline"
                      >
                        {g.errorType}
                      </Link>
                      <p className="truncate text-muted" title={g.message}>
                        {g.message}
                      </p>
                    </Td>
                    <Td align="right" mono>
                      {formatCount(g.count)}
                    </Td>
                    <Td className="font-mono text-muted">{g.services.join(', ')}</Td>
                    <Td className="max-w-64">
                      {g.endpoints.length === 0 ? (
                        <span className="text-dim">—</span>
                      ) : (
                        g.endpoints.slice(0, 3).map((e) => (
                          <p key={e.method + e.route} className="truncate font-mono">
                            <Method method={e.method} />
                            {e.route}
                          </p>
                        ))
                      )}
                    </Td>
                    <Td mono className="text-muted" title={g.firstSeen}>
                      {formatTimestamp(g.firstSeen)}
                    </Td>
                    <Td mono className="text-muted" title={g.lastSeen}>
                      {timeAgo(g.lastSeen)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-muted">
              <span>
                {offset + 1}–{offset + q.data.groups.length} of {q.data.total}
              </span>
              <span className="flex gap-2">
                <Button
                  size="sm"
                  disabled={offset === 0}
                  onClick={() =>
                    setParams({ offset: offset - PAGE > 0 ? String(offset - PAGE) : null })
                  }
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  disabled={offset + PAGE >= q.data.total}
                  onClick={() => setParams({ offset: String(offset + PAGE) })}
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
