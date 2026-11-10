import type { TimeseriesPoint } from '@traceforge/contracts';
import { formatDuration } from '@traceforge/domain/client';
import type { EChartsCoreOption } from 'echarts/core';
import type { Palette } from '@/components/charts/chart';

export interface SeriesSpec {
  name: string;
  color: string;
  /** [epoch ms, value]; null values render as gaps, never as zero. */
  data: Array<[number, number | null]>;
  kind?: 'line' | 'bar';
  area?: boolean;
}

interface LineOptions {
  from: string;
  to: string;
  series: SeriesSpec[];
  axisFormat: (v: number) => string;
  valueFormat: (v: number) => string;
  p: Palette;
  /** Fix the y-axis floor at zero (counts) or let it float (latency). */
  min?: number;
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

const timeLabel = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

/** Shared time-series chart: explicit window, quiet axes, and a tooltip with exact values and timestamp. */
export function timeSeriesOption({
  from,
  to,
  series,
  axisFormat,
  valueFormat,
  p,
  min = 0,
}: LineOptions): EChartsCoreOption {
  return {
    animation: false,
    textStyle: { color: p.muted, fontFamily: 'inherit' },
    grid: { left: 8, right: 12, top: 10, bottom: 4, containLabel: true },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: p.surface,
      borderColor: p.line,
      textStyle: { color: p.text, fontSize: 12 },
      axisPointer: { type: 'line', lineStyle: { color: p.dim, type: 'dashed' } },
      formatter: (raw: unknown) => {
        const params = (Array.isArray(raw) ? raw : [raw]) as Array<{
          axisValue: number;
          marker: string;
          seriesName: string;
          value: [number, number | null];
        }>;
        const t = params[0]?.axisValue ?? 0;
        const rows = params
          .map(
            (q) =>
              `<div style="display:flex;justify-content:space-between;gap:16px">${q.marker}${esc(q.seriesName)}<b style="font-variant-numeric:tabular-nums">${q.value[1] === null ? 'no data' : esc(valueFormat(q.value[1]))}</b></div>`,
          )
          .join('');
        return `<div style="font-family:var(--font-jetbrains),monospace;font-size:11px;color:${p.muted};margin-bottom:4px">${esc(timeLabel(t))}</div>${rows}`;
      },
    },
    xAxis: {
      type: 'time',
      min: Date.parse(from),
      max: Date.parse(to),
      axisLine: { lineStyle: { color: p.line } },
      axisTick: { show: false },
      axisLabel: { color: p.dim, fontSize: 11, hideOverlap: true },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      min,
      axisLabel: { color: p.dim, fontSize: 11, formatter: (v: number) => axisFormat(v) },
      splitLine: { lineStyle: { color: p.line } },
    },
    series: series.map((s) => ({
      name: s.name,
      type: s.kind ?? 'line',
      data: s.data,
      showSymbol: false,
      connectNulls: false,
      smooth: false,
      lineStyle: { width: 1.75, color: s.color },
      itemStyle: { color: s.color },
      ...(s.area ? { areaStyle: { color: s.color, opacity: 0.14 } } : {}),
      ...(s.kind === 'bar' ? { barMaxWidth: 14 } : {}),
      emphasis: { disabled: true },
    })),
  };
}

const points = (
  rows: TimeseriesPoint[],
  pick: (r: TimeseriesPoint) => number | null,
): Array<[number, number | null]> => rows.map((r) => [Date.parse(r.t), pick(r)]);

export function throughputOption(
  rows: TimeseriesPoint[],
  bucketSeconds: number,
  range: { from: string; to: string },
  p: Palette,
) {
  const perMinute = 60 / bucketSeconds;
  return timeSeriesOption({
    ...range,
    p,
    axisFormat: (v) => `${Math.round(v)}`,
    valueFormat: (v) => `${v.toFixed(1)} req/min`,
    series: [
      {
        name: 'Requests',
        color: p.series[0] ?? '#6b8cff',
        area: true,
        data: points(rows, (r) => r.requests * perMinute),
      },
    ],
  });
}

export function errorRateOption(
  rows: TimeseriesPoint[],
  range: { from: string; to: string },
  p: Palette,
) {
  return timeSeriesOption({
    ...range,
    p,
    axisFormat: (v) => `${v}%`,
    valueFormat: (v) => `${v.toFixed(2)}%`,
    series: [
      { name: 'Error rate', color: p.err, area: true, data: points(rows, (r) => r.errorRate) },
    ],
  });
}

export function latencyOption(
  rows: TimeseriesPoint[],
  range: { from: string; to: string },
  p: Palette,
) {
  return timeSeriesOption({
    ...range,
    p,
    axisFormat: (v) => formatDuration(v),
    valueFormat: (v) => formatDuration(v),
    series: [
      { name: 'p50', color: p.series[0] ?? '#6b8cff', data: points(rows, (r) => r.p50) },
      { name: 'p95', color: p.series[1] ?? '#f5a524', data: points(rows, (r) => r.p95) },
      { name: 'p99', color: p.series[2] ?? '#c084fc', data: points(rows, (r) => r.p99) },
    ],
  });
}

export function countOption(
  rows: Array<{ t: string; count: number }>,
  name: string,
  range: { from: string; to: string },
  p: Palette,
) {
  return timeSeriesOption({
    ...range,
    p,
    axisFormat: (v) => `${Math.round(v)}`,
    valueFormat: (v) => `${Math.round(v)}`,
    series: [
      {
        name,
        color: p.err,
        kind: 'bar',
        data: rows.map((r) => [Date.parse(r.t), r.count] as [number, number]),
      },
    ],
  });
}
