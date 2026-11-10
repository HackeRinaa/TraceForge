/** Local clock time for tables, with the date only when it is not today. */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

export function timeAgo(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** Relative change as a signed percentage, or null when there is no baseline to compare against. */
export function percentChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

export function formatDelta(pct: number | null): string {
  if (pct === null) return '—';
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
  return `${sign}${Math.abs(pct) < 10 ? Math.abs(pct).toFixed(1) : Math.round(Math.abs(pct))}%`;
}

export const METHOD_COLORS: Record<string, string> = {
  GET: 'text-accent',
  POST: 'text-ok-text',
  PUT: 'text-warn-text',
  PATCH: 'text-warn-text',
  DELETE: 'text-err-text',
};
