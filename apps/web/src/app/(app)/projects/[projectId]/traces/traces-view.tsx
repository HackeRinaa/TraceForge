'use client';

import type { TracesResponse } from '@traceforge/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { DemoBadge } from '@/components/data/demo-badge';
import { TraceTable } from '@/components/data/widgets';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/fields';
import { EmptyState, ErrorState, PageHeader, Panel, TableSkeleton } from '@/components/ui/panel';
import { api } from '@/lib/api';
import { useProjectId } from '@/lib/hooks';
import { scopeToApiParams, useScope, useScopedHref, useSetSearchParams } from '@/lib/scope';

const TRACE_ID = /^[0-9a-f]{32}$/i;

export function TracesView() {
  const projectId = useProjectId();
  const router = useRouter();
  const sp = useSearchParams();
  const scope = useScope();
  const scoped = useScopedHref();
  const setParams = useSetSearchParams();

  const status =
    sp.get('status') === 'error' || sp.get('status') === 'ok'
      ? (sp.get('status') as 'ok' | 'error')
      : undefined;
  const minDuration = sp.get('minDuration') ?? '';
  const route = sp.get('route') ?? '';

  const [idInput, setIdInput] = useState('');
  const [idError, setIdError] = useState<string | undefined>();
  // Text filters: `null` means "not editing" and the inputs reflect the URL; while typing, the URL updates after a pause.
  const [routeDraft, setRouteDraft] = useState<string | null>(null);
  const [minDraft, setMinDraft] = useState<string | null>(null);
  useEffect(() => {
    if (routeDraft === null && minDraft === null) return;
    const t = setTimeout(() => {
      setParams({
        route: (routeDraft ?? route) || null,
        minDuration: (minDraft ?? minDuration) || null,
      });
      setRouteDraft(null);
      setMinDraft(null);
    }, 350);
    return () => clearTimeout(t);
  }, [routeDraft, minDraft, route, minDuration, setParams]);

  const params = {
    ...scopeToApiParams(scope),
    status,
    route: route || undefined,
    minDurationMs: minDuration && Number(minDuration) > 0 ? Number(minDuration) : undefined,
    limit: 25,
  };
  const q = useInfiniteQuery({
    queryKey: ['p', projectId, 'traces', params],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api<TracesResponse>(`/v1/projects/${projectId}/traces`, {
        params: { ...params, cursor: pageParam },
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: scope.live ? 30_000 : false,
  });
  const traces = q.data?.pages.flatMap((p) => p.traces) ?? [];

  const lookup = (e: React.FormEvent) => {
    e.preventDefault();
    const id = idInput.trim().toLowerCase();
    if (!TRACE_ID.test(id)) return setIdError('A trace ID is 32 hexadecimal characters.');
    setIdError(undefined);
    router.push(scoped(`/projects/${projectId}/traces/${id}`));
  };

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-4">
      <PageHeader
        title="Traces"
        description="Newest first. Filters apply to the trace's root operation and its service set."
        actions={<DemoBadge />}
      />

      <Panel>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <form onSubmit={lookup} noValidate>
            <Field label="Look up a trace ID" error={idError}>
              {(id, d) => (
                <div className="flex gap-2">
                  <Input
                    id={id}
                    aria-describedby={d}
                    value={idInput}
                    onChange={(e) => setIdInput(e.target.value)}
                    placeholder="4bf92f3577b34da6…"
                    className="font-mono"
                  />
                  <Button type="submit" aria-label="Open trace">
                    <Search className="size-3.5" aria-hidden />
                  </Button>
                </div>
              )}
            </Field>
          </form>
          <Field label="Status">
            {(id) => (
              <Select
                id={id}
                value={status ?? ''}
                onChange={(e) => setParams({ status: e.target.value || null })}
              >
                <option value="">Any status</option>
                <option value="error">Contains an error</option>
                <option value="ok">No errors</option>
              </Select>
            )}
          </Field>
          <Field label="Route contains exactly" hint="e.g. /api/orders">
            {(id, d) => (
              <Input
                id={id}
                aria-describedby={d}
                value={routeDraft ?? route}
                onChange={(e) => setRouteDraft(e.target.value)}
                className="font-mono"
              />
            )}
          </Field>
          <Field label="Minimum duration (ms)">
            {(id) => (
              <Input
                id={id}
                type="number"
                min={0}
                value={minDraft ?? minDuration}
                onChange={(e) => setMinDraft(e.target.value)}
              />
            )}
          </Field>
        </div>
      </Panel>

      <Panel flush>
        {q.isPending && <TableSkeleton rows={8} cols={6} />}
        {q.isError && (
          <div className="p-4">
            <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          </div>
        )}
        {q.isSuccess && traces.length === 0 && (
          <EmptyState title="No traces match">
            Adjust the filters or widen the time range. New traces appear a second or two after they
            are sent.
          </EmptyState>
        )}
        {traces.length > 0 && (
          <>
            <TraceTable traces={traces} label="Trace search results" />
            <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-muted">
              <span>{traces.length} loaded</span>
              {q.hasNextPage ? (
                <Button
                  size="sm"
                  onClick={() => void q.fetchNextPage()}
                  disabled={q.isFetchingNextPage}
                >
                  {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              ) : (
                <span>End of results</span>
              )}
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}
