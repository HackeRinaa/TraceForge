'use client';

import clsx from 'clsx';
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabItem<T extends string> {
  id: T;
  label: string;
  count?: number | undefined;
}

/** Accessible tab list (roving tabindex, arrow keys). The caller renders the active panel. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  const uid = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKey = (e: KeyboardEvent, index: number) => {
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const nextIndex = (index + delta + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    if (next) {
      onChange(next.id);
      refs.current[nextIndex]?.focus();
    }
  };

  return (
    <div role="tablist" aria-label={label} className="flex gap-1 border-b border-line">
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          role="tab"
          id={`${uid}-${t.id}`}
          aria-selected={value === t.id}
          tabIndex={value === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => onKey(e, i)}
          className={clsx(
            '-mb-px cursor-pointer border-b-2 px-3 py-2 text-[13px]',
            value === t.id
              ? 'border-accent font-medium text-text'
              : 'border-transparent text-muted hover:text-text',
          )}
        >
          {t.label}
          {t.count !== undefined && (
            <span className="ml-1.5 rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[11px] text-muted">
              {t.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ children, labelledBy }: { children: ReactNode; labelledBy?: string }) {
  return (
    <div role="tabpanel" aria-labelledby={labelledBy} className="pt-4">
      {children}
    </div>
  );
}
