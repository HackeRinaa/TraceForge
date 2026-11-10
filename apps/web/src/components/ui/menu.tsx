'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Disclosure menu: closes on outside click and Escape, returns focus to the trigger. */
export function Menu({
  trigger,
  label,
  children,
  align = 'right',
}: {
  trigger: ReactNode;
  label: string;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        className="flex cursor-pointer items-center rounded-control"
      >
        {trigger}
      </button>
      {open && (
        <div
          role="menu"
          className={`absolute top-full z-40 mt-1 min-w-52 rounded-panel border border-line-strong bg-surface-2 p-1 shadow-xl ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  children,
  onClick,
  danger,
}: {
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 text-left hover:bg-surface-3 ${danger ? 'text-err-text' : ''}`}
    >
      {children}
    </button>
  );
}
