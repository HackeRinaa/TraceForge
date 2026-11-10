'use client';

import { X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from './button';
import { Input } from './fields';

/** Modal built on the native <dialog> element: focus trapping, Escape to close and the backdrop come from the browser. */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={`m-auto w-[calc(100vw-2rem)] rounded-panel border border-line-strong bg-surface p-0 text-text shadow-2xl backdrop:bg-black/60 ${size === 'lg' ? 'max-w-2xl' : 'max-w-md'}`}
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
            <div>
              <h2 className="text-[14px] font-semibold">{title}</h2>
              {description && <p className="mt-0.5 text-muted">{description}</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              className="rounded p-1 text-dim hover:text-text"
            >
              <X className="size-4" aria-hidden />
            </button>
          </header>
          <div className="overflow-y-auto p-4">{children}</div>
          {footer && (
            <footer className="flex justify-end gap-2 border-t border-line px-4 py-3">
              {footer}
            </footer>
          )}
        </div>
      )}
    </dialog>
  );
}

/** Confirmation for destructive actions. `requireText` makes the user type a name before the button enables. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  requireText,
  pending,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmLabel: string;
  requireText?: string;
  pending?: boolean;
}) {
  const [typed, setTyped] = useState('');
  const ready = !requireText || typed === requireText;
  return (
    <Dialog
      open={open}
      onClose={() => {
        setTyped('');
        onClose();
      }}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!ready || pending} onClick={onConfirm}>
            {pending ? 'Working…' : confirmLabel}
          </Button>
        </>
      }
    >
      {requireText && (
        <div className="flex flex-col gap-1">
          <label htmlFor="confirm-text" className="text-[12px] text-muted">
            Type <span className="font-mono text-text">{requireText}</span> to confirm
          </label>
          <Input
            id="confirm-text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
          />
        </div>
      )}
    </Dialog>
  );
}
