'use client';

import { CornerDownLeft, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { useProjectId } from '@/lib/hooks';
import { useScopedHref } from '@/lib/scope';

interface Item {
  id: string;
  label: string;
  hint: string;
  href: string;
}

const TRACE_ID = /^[0-9a-f]{32}$/i;

/** ⌘K / Ctrl+K quick navigation: jump to a page, search endpoints, or open a trace by its 32-character ID. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const projectId = useProjectId();
  const scoped = useScopedHref();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const items = useMemo<Item[]>(() => {
    const base = `/projects/${projectId}`;
    const q = query.trim();
    const pages: Item[] = [
      { id: 'overview', label: 'Overview', hint: 'Page', href: scoped(`${base}/overview`) },
      { id: 'endpoints', label: 'Endpoints', hint: 'Page', href: scoped(`${base}/endpoints`) },
      { id: 'traces', label: 'Traces', hint: 'Page', href: scoped(`${base}/traces`) },
      { id: 'errors', label: 'Errors', hint: 'Page', href: scoped(`${base}/errors`) },
      { id: 'alerts', label: 'Alerts and incidents', hint: 'Page', href: scoped(`${base}/alerts`) },
      {
        id: 'settings',
        label: 'Settings and API keys',
        hint: 'Page',
        href: scoped(`${base}/settings`),
      },
    ];
    const results: Item[] = [];
    if (TRACE_ID.test(q))
      results.push({
        id: 'trace',
        label: `Open trace ${q.toLowerCase()}`,
        hint: 'Trace ID',
        href: scoped(`${base}/traces/${q.toLowerCase()}`),
      });
    if (q && !TRACE_ID.test(q))
      results.push({
        id: 'search',
        label: `Search endpoints for “${q}”`,
        hint: 'Endpoints',
        href: scoped(`${base}/endpoints`, { search: q }),
      });
    return [
      ...results,
      ...pages.filter((p) => !q || p.label.toLowerCase().includes(q.toLowerCase())),
    ];
  }, [query, projectId, scoped]);

  // State resets when the palette closes (rather than syncing in an effect when it opens).
  const close = () => {
    setQuery('');
    setActive(0);
    onClose();
  };

  const go = (item: Item | undefined) => {
    if (!item) return;
    close();
    router.push(item.href);
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Quick navigation"
      description="Jump to a page, search endpoints, or paste a trace ID."
    >
      <div className="flex items-center gap-2 rounded-control border border-line-strong px-2.5 focus-within:border-accent">
        <Search className="size-4 text-dim" aria-hidden />
        <input
          // The dialog has just opened for this input.
          autoFocus
          aria-label="Search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(items.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter') go(items[active]);
          }}
          placeholder="Type a page, endpoint, or trace ID…"
          className="h-9 w-full bg-transparent outline-none placeholder:text-dim"
        />
      </div>
      <ul className="mt-2 max-h-72 overflow-y-auto" role="listbox" aria-label="Results">
        {items.length === 0 && <li className="px-2 py-3 text-muted">No matches.</li>}
        {items.map((item, i) => (
          <li key={item.id} role="option" aria-selected={i === active}>
            <button
              type="button"
              onClick={() => go(item)}
              onMouseEnter={() => setActive(i)}
              className={`flex w-full cursor-pointer items-center justify-between rounded px-2.5 py-2 text-left ${i === active ? 'bg-surface-3' : ''}`}
            >
              <span className="truncate">{item.label}</span>
              <span className="flex items-center gap-1.5 text-[11px] text-dim">
                {item.hint}
                {i === active && <CornerDownLeft className="size-3" aria-hidden />}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
