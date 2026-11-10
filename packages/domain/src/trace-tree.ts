import type { SpanDto } from '@traceforge/contracts';

export interface WaterfallRow {
  span: SpanDto;
  depth: number;
  /** Parent id is set but no such span exists in the trace. */
  orphan: boolean;
  /** Time spent in this span excluding time covered by its children. */
  selfMs: number;
  leftPct: number;
  widthPct: number;
}

export interface ServiceShare {
  service: string;
  selfMs: number;
  pct: number;
}

export interface TraceLayout {
  rows: WaterfallRow[];
  totalMs: number;
  serviceBreakdown: ServiceShare[];
  /** Human-readable explanations of anything that makes the waterfall incomplete or approximate. */
  issues: string[];
}

/** Clock skew below this is ignored; instrumentation rounding routinely produces sub-millisecond overlaps. */
const SKEW_TOLERANCE_MS = 1;

function unionLength(intervals: Array<[number, number]>): number {
  const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = -Infinity;
  let curEnd = -Infinity;
  for (const [s, e] of sorted) {
    if (s > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

/**
 * Builds the depth-first waterfall for a trace. It never invents structure: spans whose parent is absent are shown as
 * orphans, cycles and duplicate ids are reported, and clock skew is flagged instead of silently clamped away.
 */
export function layoutTrace(input: readonly SpanDto[]): TraceLayout {
  const issues: string[] = [];
  const byId = new Map<string, SpanDto>();
  let duplicates = 0;
  for (const s of input) {
    if (byId.has(s.spanId)) duplicates++;
    else byId.set(s.spanId, s);
  }
  if (duplicates > 0) issues.push(`${duplicates} duplicate span record(s) were ignored.`);
  const spans = [...byId.values()];
  if (spans.length === 0) return { rows: [], totalMs: 0, serviceBreakdown: [], issues };

  const children = new Map<string, SpanDto[]>();
  const roots: Array<{ span: SpanDto; orphan: boolean }> = [];
  for (const s of spans) {
    if (s.parentSpanId === null) roots.push({ span: s, orphan: false });
    else if (byId.has(s.parentSpanId)) {
      const list = children.get(s.parentSpanId) ?? [];
      list.push(s);
      children.set(s.parentSpanId, list);
    } else roots.push({ span: s, orphan: true });
  }

  const orphanCount = roots.filter((r) => r.orphan).length;
  const trueRoots = roots.length - orphanCount;
  if (orphanCount > 0) {
    issues.push(
      `${orphanCount} span(s) reference a parent that was not received, so the trace is incomplete. ` +
        `They are shown at the top level.`,
    );
  }
  if (trueRoots > 1)
    issues.push(`${trueRoots} root spans were found; the trace has no single root.`);
  if (trueRoots === 0 && orphanCount === 0)
    issues.push('No root span found; the parent links form a cycle.');

  const byStart = (a: SpanDto, b: SpanDto) =>
    a.offsetMs - b.offsetMs || a.spanId.localeCompare(b.spanId);
  roots.sort((a, b) => byStart(a.span, b.span));

  const origin = Math.min(...spans.map((s) => s.offsetMs));
  const end = Math.max(...spans.map((s) => s.offsetMs + s.durationMs));
  const totalMs = Math.max(end - origin, 0.001);

  const rows: WaterfallRow[] = [];
  const visited = new Set<string>();
  let skewed = 0;
  const walk = (span: SpanDto, depth: number, orphan: boolean) => {
    if (visited.has(span.spanId)) return;
    visited.add(span.spanId);
    const kids = (children.get(span.spanId) ?? []).sort(byStart);
    const spanEnd = span.offsetMs + span.durationMs;
    const covered = unionLength(
      kids.map((k): [number, number] => [
        Math.max(k.offsetMs, span.offsetMs),
        Math.min(k.offsetMs + k.durationMs, spanEnd),
      ]),
    );
    for (const k of kids) {
      if (
        k.offsetMs < span.offsetMs - SKEW_TOLERANCE_MS ||
        k.offsetMs + k.durationMs > spanEnd + SKEW_TOLERANCE_MS
      ) {
        skewed++;
      }
    }
    rows.push({
      span,
      depth,
      orphan,
      selfMs: Math.max(span.durationMs - covered, 0),
      leftPct: ((span.offsetMs - origin) / totalMs) * 100,
      widthPct: Math.max((span.durationMs / totalMs) * 100, 0.2),
    });
    for (const k of kids) walk(k, depth + 1, false);
  };
  for (const r of roots) walk(r.span, 0, r.orphan);

  const unreachable = spans.length - visited.size;
  if (unreachable > 0) {
    issues.push(`${unreachable} span(s) are part of a parent cycle and are not shown.`);
  }
  if (skewed > 0) {
    issues.push(
      `${skewed} child span(s) start before or end after their parent; clocks on different hosts may be skewed, ` +
        `so relative positions across services are approximate.`,
    );
  }

  const selfByService = new Map<string, number>();
  for (const r of rows)
    selfByService.set(r.span.service, (selfByService.get(r.span.service) ?? 0) + r.selfMs);
  const selfTotal = [...selfByService.values()].reduce((a, b) => a + b, 0) || 1;
  const serviceBreakdown = [...selfByService.entries()]
    .map(([service, selfMs]) => ({ service, selfMs, pct: (selfMs / selfTotal) * 100 }))
    .sort((a, b) => b.selfMs - a.selfMs);

  return { rows, totalMs, serviceBreakdown, issues };
}
