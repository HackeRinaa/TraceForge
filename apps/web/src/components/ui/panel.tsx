import clsx from 'clsx';
import { AlertTriangle, Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import { ApiError } from '@/lib/api';
import { Button } from './button';

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className,
  flush,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Remove body padding (for tables). */
  flush?: boolean;
}) {
  return (
    <section className={clsx('min-w-0 rounded-panel border border-line bg-surface', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
          <div className="min-w-0">
            {title && <h2 className="text-[13px] font-semibold">{title}</h2>}
            {subtitle && <p className="text-[12px] text-dim">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={flush ? '' : 'p-4'}>{children}</div>
    </section>
  );
}

const BADGE_TONES = {
  neutral: 'bg-surface-3 text-muted',
  ok: 'bg-ok-soft text-ok-text',
  warn: 'bg-warn-soft text-warn-text',
  err: 'bg-err-soft text-err-text',
  accent: 'bg-accent-soft text-accent',
} as const;

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: keyof typeof BADGE_TONES;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[11px] leading-none font-medium',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={clsx('animate-pulse rounded bg-surface-3', className)} />;
}

export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2 p-4" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }, (_, c) => (
            <Skeleton key={c} className={clsx('h-4', c === 0 ? 'w-2/5' : 'flex-1')} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <Inbox className="size-6 text-dim" aria-hidden />
      <p className="font-semibold">{title}</p>
      {children && <p className="max-w-md text-muted">{children}</p>}
      {action}
    </div>
  );
}

/** Query failure with the request id (for support) and a retry action. Never shows invented data. */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const api = error instanceof ApiError ? error : null;
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-2 rounded-panel border border-err/40 bg-err-soft p-4"
    >
      <div className="flex items-center gap-2 font-semibold text-err-text">
        <AlertTriangle className="size-4" aria-hidden />
        {api?.code === 'QUERY_TIMEOUT' ? 'The query timed out' : 'Could not load this data'}
      </div>
      <p className="text-muted">{api?.message ?? 'An unexpected error occurred.'}</p>
      {api?.requestId && (
        <p className="font-mono text-[11px] text-dim">Request ID {api.requestId}</p>
      )}
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[20px] font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={clsx('font-mono', className)}>{children}</span>;
}
