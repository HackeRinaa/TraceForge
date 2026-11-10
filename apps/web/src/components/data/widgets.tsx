'use client';

import type { EndpointStat, IncidentDto, TraceSummary } from '@traceforge/contracts';
import { formatCount, formatDuration, formatPercent } from '@traceforge/domain/client';
import clsx from 'clsx';
import Link from 'next/link';
import { Badge, Mono } from '@/components/ui/panel';
import { Table, Td, Th, rowClass } from '@/components/ui/table';
import { METHOD_COLORS, formatTimestamp, timeAgo } from '@/lib/format';
import { useProjectId } from '@/lib/hooks';
import { useScopedHref } from '@/lib/scope';

export function Method({ method }: { method: string }) {
  return (
    <span className={clsx('mr-2 font-mono font-medium', METHOD_COLORS[method] ?? 'text-muted')}>
      {method}
    </span>
  );
}

export function Sparkline({
  values,
  color = 'var(--series-1)',
}: {
  values: Array<number | null>;
  color?: string;
}) {
  const nums = values.map((v) => v ?? 0);
  const max = Math.max(...nums, 0.0001);
  const step = nums.length > 1 ? 120 / (nums.length - 1) : 0;
  const d = nums
    .map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)} ${(26 - (v / max) * 24).toFixed(1)}`)
    .join(' ');
  return (
    <svg viewBox="0 0 120 28" preserveAspectRatio="none" className="h-7 w-full" aria-hidden>
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Kpi({
  label,
  value,
  unit,
  delta,
  deltaTone = 'neutral',
  spark,
  sparkColor,
}: {
  label: string;
  value: string;
  unit?: string;
  delta: string;
  deltaTone?: 'neutral' | 'good' | 'bad' | 'warn';
  spark: Array<number | null>;
  sparkColor?: string;
}) {
  const tone = {
    neutral: 'text-muted',
    good: 'text-ok-text',
    bad: 'text-err-text',
    warn: 'text-warn-text',
  }[deltaTone];
  return (
    <div className="flex flex-col gap-1.5 rounded-panel border border-line bg-surface px-3.5 py-3">
      <div className="flex items-center justify-between text-[12px] text-muted">
        <span>{label}</span>
        <span
          className={clsx('font-mono', tone)}
          title="Change versus the previous period of equal length"
        >
          {delta}
        </span>
      </div>
      <div className="tabular text-[24px] leading-none font-semibold tracking-tight">
        {value}
        {unit && <span className="ml-1 text-[13px] font-normal text-dim">{unit}</span>}
      </div>
      <Sparkline values={spark} color={sparkColor ?? 'var(--series-1)'} />
    </div>
  );
}

export function EndpointLink({ stat }: { stat: Pick<EndpointStat, 'method' | 'route'> }) {
  const projectId = useProjectId();
  const scoped = useScopedHref();
  return (
    <Link
      href={scoped(`/projects/${projectId}/endpoints/detail`, {
        method: stat.method,
        route: stat.route,
      })}
      className="font-mono hover:underline"
    >
      <Method method={stat.method} />
      {stat.route}
    </Link>
  );
}

/** Compact endpoint ranking used on the overview. */
export function EndpointMiniTable({
  rows,
  highlight,
  label,
}: {
  rows: EndpointStat[];
  highlight: 'p95' | 'errorRate';
  label: string;
}) {
  return (
    <Table label={label} minWidth={480}>
      <thead>
        <tr>
          <Th>Endpoint</Th>
          <Th align="right">Requests</Th>
          <Th align="right">Errors</Th>
          <Th align="right">p95</Th>
          <Th align="right">p99</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((e) => (
          <tr key={`${e.service}${e.method}${e.route}`} className={rowClass}>
            <Td>
              <EndpointLink stat={e} />
              <span className="ml-2 text-[11px] text-dim">{e.service}</span>
            </Td>
            <Td align="right" mono>
              {formatCount(e.requests)}
            </Td>
            <Td
              align="right"
              mono
              className={clsx(
                highlight === 'errorRate' && (e.errorRate ?? 0) > 1 && 'text-err-text',
              )}
            >
              {formatPercent(e.errorRate)}
            </Td>
            <Td align="right" mono className={clsx(highlight === 'p95' && 'font-medium')}>
              {formatDuration(e.p95)}
            </Td>
            <Td align="right" mono className="text-muted">
              {formatDuration(e.p99)}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function StatusBadge({ status }: { status: 'ok' | 'error' }) {
  return <Badge tone={status === 'ok' ? 'ok' : 'err'}>{status === 'ok' ? 'OK' : 'ERROR'}</Badge>;
}

export function TraceTable({
  traces,
  label = 'Traces',
}: {
  traces: TraceSummary[];
  label?: string;
}) {
  const projectId = useProjectId();
  const scoped = useScopedHref();
  return (
    <Table label={label} minWidth={680}>
      <thead>
        <tr>
          <Th>Trace</Th>
          <Th>Root operation</Th>
          <Th>Services</Th>
          <Th align="right">Duration</Th>
          <Th align="right">Spans</Th>
          <Th>Status</Th>
          <Th>Started</Th>
        </tr>
      </thead>
      <tbody>
        {traces.map((t) => (
          <tr key={t.traceId} className={rowClass}>
            <Td>
              <Link
                href={scoped(`/projects/${projectId}/traces/${t.traceId}`)}
                className="font-mono text-accent hover:underline"
                title={t.traceId}
              >
                {t.traceId.slice(0, 12)}
              </Link>
            </Td>
            <Td className="max-w-64 truncate font-mono">
              {t.method ? (
                <>
                  <Method method={t.method} />
                  {t.route ?? t.rootName}
                </>
              ) : (
                (t.rootName ?? '—')
              )}
            </Td>
            <Td className="text-muted">{t.services.join(', ')}</Td>
            <Td align="right" mono>
              {formatDuration(t.durationMs)}
            </Td>
            <Td align="right" mono className="text-muted">
              {t.spanCount}
              {t.errorCount > 0 && <span className="ml-1 text-err-text">({t.errorCount} err)</span>}
            </Td>
            <Td>
              <StatusBadge status={t.status} />
            </Td>
            <Td mono className="text-muted" title={t.startTime}>
              {formatTimestamp(t.startTime)}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

const INCIDENT_TONE = { firing: 'err', acknowledged: 'warn', resolved: 'ok' } as const;

export function IncidentBadge({ status }: { status: IncidentDto['status'] }) {
  return <Badge tone={INCIDENT_TONE[status]}>{status.toUpperCase()}</Badge>;
}

export function IncidentRow({ incident }: { incident: IncidentDto }) {
  const projectId = useProjectId();
  const scoped = useScopedHref();
  return (
    <Link
      href={scoped(`/projects/${projectId}/alerts`, { incident: incident.id })}
      className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-2.5 first:border-t-0 hover:bg-surface-2"
    >
      <IncidentBadge status={incident.status} />
      <span className="min-w-0 flex-1 font-medium">{incident.ruleName}</span>
      <Mono className="text-muted">opened {timeAgo(incident.openedAt)}</Mono>
    </Link>
  );
}
