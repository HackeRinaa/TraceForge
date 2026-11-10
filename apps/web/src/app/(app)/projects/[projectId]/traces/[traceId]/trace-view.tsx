'use client';

import type { SpanDto, TraceDetail } from '@traceforge/contracts';
import { formatDuration, layoutTrace, type WaterfallRow } from '@traceforge/domain/client';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { AlertTriangle, ArrowLeft, Check, Copy } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DemoBadge } from '@/components/data/demo-badge';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, ErrorState, Panel, Skeleton } from '@/components/ui/panel';
import { api, type ApiError } from '@/lib/api';
import { useProjectId } from '@/lib/hooks';
import { useScopedHref, useSetSearchParams } from '@/lib/scope';

const ROW_HEIGHT = 34;
const OVERSCAN = 8;
const VIEWPORT_MAX = 560;
const SERIES = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
  'var(--series-6)',
];

/** HTTP client spans are named just "GET"; the URL path makes them readable in the tree. */
function spanLabel(s: SpanDto): string {
  const path = s.attributes['url.path'] ?? s.attributes['http.target'];
  return s.kind === 3 && path && !s.name.includes('/') ? `${s.name} ${path}` : s.name;
}

export function TraceView({ traceId }: { traceId: string }) {
  const projectId = useProjectId();
  const scoped = useScopedHref();
  const q = useQuery<TraceDetail, ApiError>({
    queryKey: ['p', projectId, 'trace', traceId],
    queryFn: ({ signal }) =>
      api<TraceDetail>(`/v1/projects/${projectId}/traces/${traceId}`, { signal }),
    retry: false,
  });
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(traceId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (insecure context); the ID is visible and selectable */
    }
  };

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-4">
      <Link
        href={scoped(`/projects/${projectId}/traces`)}
        className="inline-flex w-fit items-center gap-1.5 text-muted hover:text-text"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> All traces
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[16px] font-semibold">Trace</h1>
        <code className="rounded bg-surface-2 px-2 py-1 font-mono text-[12px] break-all">
          {traceId}
        </code>
        <Button size="sm" onClick={() => void copy()} aria-label="Copy trace ID">
          {copied ? (
            <Check className="size-3.5" aria-hidden />
          ) : (
            <Copy className="size-3.5" aria-hidden />
          )}
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <DemoBadge />
      </div>

      {q.isPending && <Skeleton className="h-96" />}
      {q.isError &&
        (q.error.status === 404 ? (
          <Panel>
            <EmptyState title="Trace not found">
              No spans with this ID exist in this project, or they have passed the retention window.
              Spans can also take a second or two to appear after they are sent.
            </EmptyState>
          </Panel>
        ) : (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ))}
      {q.data && <Waterfall trace={q.data} />}
    </div>
  );
}

function Waterfall({ trace }: { trace: TraceDetail }) {
  const layout = useMemo(() => layoutTrace(trace.spans), [trace.spans]);
  const sp = useSearchParams();
  const setParams = useSetSearchParams();
  const selectedId = sp.get('span') ?? layout.rows[0]?.span.spanId;
  const selected = layout.rows.find((r) => r.span.spanId === selectedId) ?? layout.rows[0];

  const colorOf = useMemo(() => {
    const services = [...new Set(trace.spans.map((s) => s.service))].sort();
    return (service: string) =>
      SERIES[services.indexOf(service) % SERIES.length] ?? SERIES[0] ?? '';
  }, [trace.spans]);

  const errors = layout.rows.filter((r) => r.span.status === 'error').length;
  const root = layout.rows.find((r) => r.depth === 0)?.span;

  return (
    <>
      <section
        aria-label="Trace summary"
        className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-panel border border-line bg-surface px-4 py-3"
      >
        <div>
          <p className="font-mono text-[15px] font-semibold">{root ? spanLabel(root) : 'Trace'}</p>
          <p className="text-muted">{new Date(trace.startTime).toLocaleString()}</p>
        </div>
        <Summary label="Duration" value={formatDuration(trace.durationMs)} />
        <Summary label="Spans" value={String(layout.rows.length)} />
        <Summary label="Services" value={String(layout.serviceBreakdown.length)} />
        {errors > 0 ? (
          <Badge tone="err">
            {errors} FAILED SPAN{errors > 1 ? 'S' : ''}
          </Badge>
        ) : (
          <Badge tone="ok">NO ERRORS</Badge>
        )}
      </section>

      {layout.serviceBreakdown.length > 0 && (
        <section
          aria-label="Time by service"
          className="rounded-panel border border-line bg-surface px-4 py-3"
        >
          <div
            className="flex h-2 gap-px overflow-hidden rounded"
            role="img"
            aria-label={layout.serviceBreakdown
              .map((s) => `${s.service} ${s.pct.toFixed(0)}%`)
              .join(', ')}
          >
            {layout.serviceBreakdown.map((s) => (
              <span key={s.service} style={{ flex: s.pct, background: colorOf(s.service) }} />
            ))}
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px]">
            {layout.serviceBreakdown.map((s) => (
              <li key={s.service} className="flex items-center gap-1.5">
                <span
                  className="size-2 rounded-sm"
                  style={{ background: colorOf(s.service) }}
                  aria-hidden
                />
                <span className="font-mono">{s.service}</span>
                <span className="text-muted">
                  {s.pct.toFixed(0)}% · {formatDuration(s.selfMs)} self time
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {layout.issues.length > 0 && (
        <div
          role="note"
          className="flex gap-2 rounded-panel border border-warn/40 bg-warn-soft px-4 py-3 text-warn-text"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <ul className="space-y-1">
            {layout.issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Panel
          title="Waterfall"
          subtitle="Bars show wall-clock time; select a span for details. ↑ ↓ moves the selection."
          flush
        >
          <WaterfallRows
            rows={layout.rows}
            totalMs={layout.totalMs}
            colorOf={colorOf}
            selectedId={selected?.span.spanId}
            onSelect={(id) => setParams({ span: id })}
          />
        </Panel>
        {selected && <SpanDetail row={selected} />}
      </div>
    </>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[12px] text-dim">{label}</p>
      <p className="tabular font-mono text-[15px] font-semibold">{value}</p>
    </div>
  );
}

function WaterfallRows({
  rows,
  totalMs,
  colorOf,
  selectedId,
  onSelect,
}: {
  rows: WaterfallRow[];
  totalMs: number;
  colorOf: (service: string) => string;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const viewport = Math.min(rows.length * ROW_HEIGHT, VIEWPORT_MAX);
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN);
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  const selectedIndex = rows.findIndex((r) => r.span.spanId === selectedId);
  useEffect(() => {
    const el = scroller.current;
    if (!el || selectedIndex < 0) return;
    const top = selectedIndex * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + viewport) el.scrollTop = top + ROW_HEIGHT - viewport;
  }, [selectedIndex, viewport]);

  const onKey = (e: React.KeyboardEvent) => {
    const delta = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = rows[Math.min(rows.length - 1, Math.max(0, selectedIndex + delta))];
    if (next) onSelect(next.span.spanId);
  };

  if (rows.length === 0) return <EmptyState title="No renderable spans" />;

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[640px]">
        <div className="grid grid-cols-[minmax(240px,38%)_1fr] border-b border-line text-[12px] text-dim">
          <div className="px-4 py-2">Service · operation</div>
          <div className="relative h-8" aria-hidden>
            {ticks.map((t) => (
              <span
                key={t}
                className="absolute top-2 font-mono text-[11px]"
                style={{ left: `calc(${t * 100}% - ${t === 1 ? 44 : 0}px)` }}
              >
                {formatDuration(totalMs * t)}
              </span>
            ))}
          </div>
        </div>
        <div
          ref={scroller}
          role="listbox"
          aria-label="Spans"
          aria-activedescendant={selectedId ? `span-${selectedId}` : undefined}
          tabIndex={0}
          onKeyDown={onKey}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          className="relative overflow-y-auto"
          style={{ height: viewport }}
        >
          <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
            {rows.slice(first, last).map((r, i) => {
              const index = first + i;
              const failed = r.span.status === 'error';
              const color = failed ? 'var(--err)' : colorOf(r.span.service);
              // Put the duration label beside the bar where there is room, otherwise inside its right end.
              const spaceRight = 100 - (r.leftPct + r.widthPct);
              const labelStyle =
                spaceRight >= 12
                  ? { left: `calc(${r.leftPct + r.widthPct}% + 6px)` }
                  : r.leftPct >= 12
                    ? { right: `calc(${100 - r.leftPct}% + 6px)` }
                    : { right: `calc(${spaceRight}% + 6px)`, color: 'var(--accent-fg)' };
              return (
                <div
                  key={r.span.spanId}
                  id={`span-${r.span.spanId}`}
                  role="option"
                  aria-selected={r.span.spanId === selectedId}
                  onClick={() => onSelect(r.span.spanId)}
                  className={clsx(
                    'absolute inset-x-0 grid cursor-pointer grid-cols-[minmax(240px,38%)_1fr] items-center border-b border-line',
                    r.span.spanId === selectedId
                      ? 'bg-accent-soft'
                      : failed
                        ? 'bg-err-soft/40 hover:bg-err-soft'
                        : 'hover:bg-surface-2',
                  )}
                  style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
                >
                  <div
                    className="flex min-w-0 items-center gap-1.5 pr-2"
                    style={{ paddingLeft: 16 + Math.min(r.depth, 10) * 14 }}
                  >
                    <span
                      className="h-4 w-[3px] shrink-0 rounded-sm"
                      style={{ background: color }}
                      aria-hidden
                    />
                    <span className="truncate font-mono text-[12px]" title={spanLabel(r.span)}>
                      {spanLabel(r.span)}
                    </span>
                    <span className="shrink-0 text-[11px] text-dim">{r.span.service}</span>
                    {r.orphan && (
                      <Badge tone="warn" className="shrink-0">
                        ORPHAN
                      </Badge>
                    )}
                  </div>
                  <div className="relative h-full" aria-hidden>
                    <span
                      className="absolute top-2.5 h-3.5 rounded-sm"
                      style={{
                        left: `${r.leftPct}%`,
                        width: `${r.widthPct}%`,
                        minWidth: 2,
                        background: color,
                        opacity: 0.92,
                        outline: failed ? '1px solid var(--err)' : undefined,
                      }}
                    />
                    <span
                      className="absolute top-2 font-mono text-[11px] whitespace-nowrap text-muted"
                      style={labelStyle}
                    >
                      {formatDuration(r.span.durationMs)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

const KIND = ['unspecified', 'internal', 'server', 'client', 'producer', 'consumer'];

function SpanDetail({ row }: { row: WaterfallRow }) {
  const s = row.span;
  const exception = s.events.find((e) => e.name === 'exception');
  const attrs = Object.entries(s.attributes).sort(([a], [b]) => a.localeCompare(b));
  const resource = Object.entries(s.resource).sort(([a], [b]) => a.localeCompare(b));
  return (
    <Panel
      title={<span className="font-mono">{spanLabel(s)}</span>}
      subtitle={`${s.service} · ${KIND[s.kind] ?? 'unknown'} · ${formatDuration(s.durationMs)}`}
      flush
      className="xl:sticky xl:top-16"
    >
      <div className="max-h-[70vh] overflow-y-auto">
        {s.status === 'error' && (
          <div role="alert" className="border-b border-line bg-err-soft px-4 py-3 text-err-text">
            <p className="font-semibold">{exception?.attributes['exception.type'] ?? 'Error'}</p>
            <p>
              {exception?.attributes['exception.message'] ??
                (s.statusMessage || 'The span was marked as failed.')}
            </p>
          </div>
        )}
        <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 border-b border-line px-4 py-3 text-[12px]">
          {[
            ['span id', s.spanId],
            ['parent id', s.parentSpanId ?? '— (root)'],
            ['start offset', `+${formatDuration(s.offsetMs)}`],
            ['self time', formatDuration(row.selfMs)],
            ['started', new Date(s.startTime).toISOString().replace('T', ' ').replace('Z', ' UTC')],
            ['status', s.status],
          ].map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-dim">{k}</dt>
              <dd className="font-mono break-all">{v}</dd>
            </div>
          ))}
        </dl>
        <AttrList title="Attributes" entries={attrs} />
        {s.events.length > 0 && (
          <div className="border-b border-line px-4 py-3">
            <h3 className="mb-1.5 text-[12px] font-medium text-dim">Events</h3>
            <ul className="space-y-2">
              {s.events.map((e, i) => (
                <li key={i} className="text-[12px]">
                  <p className="font-mono">
                    <span className="text-dim">
                      +{formatDuration(Math.max(0, e.offsetMs - s.offsetMs))}
                    </span>{' '}
                    {e.name}
                  </p>
                  {Object.entries(e.attributes)
                    .filter(([k]) => k !== 'exception.stacktrace')
                    .map(([k, v]) => (
                      <p key={k} className="pl-3 font-mono text-muted">
                        {k}: {v}
                      </p>
                    ))}
                </li>
              ))}
            </ul>
          </div>
        )}
        <AttrList title="Resource" entries={resource} />
      </div>
    </Panel>
  );
}

function AttrList({ title, entries }: { title: string; entries: Array<[string, string]> }) {
  if (entries.length === 0) return null;
  return (
    <div className="border-b border-line px-4 py-3 last:border-b-0">
      <h3 className="mb-1.5 text-[12px] font-medium text-dim">{title}</h3>
      <dl className="grid grid-cols-[minmax(0,40%)_1fr] gap-x-3 gap-y-1 text-[12px]">
        {entries.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="truncate font-mono text-dim" title={k}>
              {k}
            </dt>
            <dd className="font-mono break-all">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
