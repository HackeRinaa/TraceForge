'use client';

import { RANGE_PRESETS } from '@traceforge/contracts';
import clsx from 'clsx';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/fields';
import { useScope, useSetSearchParams } from '@/lib/scope';

const MAX_DAYS = 14;

function toLocalInput(iso: string | undefined, fallbackOffsetMs: number): string {
  const d = iso ? new Date(iso) : new Date(Date.now() - fallbackOffsetMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Global time range: relative presets follow the clock (live); a custom range is fixed and shareable via the URL. */
export function TimeRangePicker() {
  const scope = useScope();
  const setParams = useSetSearchParams();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState<string | undefined>();

  const openCustom = () => {
    setFrom(toLocalInput(scope.from, 3_600_000));
    setTo(toLocalInput(scope.to, 0));
    setError(undefined);
    setOpen(true);
  };

  const apply = () => {
    const f = new Date(from);
    const t = new Date(to);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()))
      return setError('Enter both a start and an end.');
    if (f >= t) return setError('The start must be before the end.');
    if (t.getTime() - f.getTime() > MAX_DAYS * 86_400_000)
      return setError(`Telemetry is retained for ${MAX_DAYS} days; choose a shorter window.`);
    setParams({ range: null, from: f.toISOString(), to: t.toISOString() });
    setOpen(false);
  };

  return (
    <>
      <div
        role="group"
        aria-label="Time range"
        className="flex overflow-hidden rounded-control border border-line-strong"
      >
        {RANGE_PRESETS.map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={scope.range === r}
            onClick={() => setParams({ range: r, from: null, to: null })}
            className={clsx(
              'h-8 cursor-pointer border-r border-line-strong px-2.5 font-mono text-[12px]',
              scope.range === r ? 'bg-surface-3 text-text' : 'text-muted hover:bg-surface-2',
            )}
          >
            {r}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={!scope.live}
          onClick={openCustom}
          className={clsx(
            'h-8 cursor-pointer px-2.5 text-[12px]',
            !scope.live ? 'bg-surface-3 text-text' : 'text-muted hover:bg-surface-2',
          )}
        >
          Custom
        </button>
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Custom time range"
        description="Times are in your local timezone. The view will not auto-refresh for a fixed range."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={apply}>
              Apply
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From">
            {(id) => (
              <Input
                id={id}
                type="datetime-local"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            )}
          </Field>
          <Field label="To">
            {(id) => (
              <Input
                id={id}
                type="datetime-local"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            )}
          </Field>
        </div>
        {error && (
          <p role="alert" className="mt-2 text-err-text">
            {error}
          </p>
        )}
      </Dialog>
    </>
  );
}
