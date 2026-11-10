/** Compact duration for tables and charts: 0.42 ms, 38 ms, 1.84 s, 2m 05s. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 100) return `${ms.toFixed(ms < 10 ? 1 : 0)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString('en-US');
}

export function formatPercent(p: number | null | undefined, digits = 2): string {
  if (p === null || p === undefined) return '—';
  return `${p.toFixed(digits)}%`;
}

export function shortId(id: string, length = 8): string {
  return id.slice(0, length);
}
