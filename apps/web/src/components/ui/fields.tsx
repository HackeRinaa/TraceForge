import clsx from 'clsx';
import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';

const CONTROL =
  'h-8 w-full rounded-control border border-line-strong bg-surface px-2.5 text-text placeholder:text-dim ' +
  'focus-visible:border-accent disabled:opacity-50';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={clsx(CONTROL, className)} {...props} />;
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={clsx(CONTROL, 'cursor-pointer pr-7', className)} {...props}>
      {children}
    </select>
  );
}

/** Label + control + inline error. The control receives the generated id through the render prop. */
export function Field({
  label,
  error,
  hint,
  children,
  className,
}: {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  children: (id: string, describedBy: string | undefined) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const note = error ?? hint;
  const noteId = note ? `${id}-note` : undefined;
  return (
    <div className={clsx('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-[12px] font-medium text-muted">
        {label}
      </label>
      {children(id, noteId)}
      {note && (
        <p
          id={noteId}
          className={clsx('text-[12px]', error ? 'text-err-text' : 'text-dim')}
          role={error ? 'alert' : undefined}
        >
          {note}
        </p>
      )}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative h-[18px] w-8 shrink-0 cursor-pointer rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-accent' : 'bg-line-strong',
      )}
    >
      <span
        className={clsx(
          'absolute top-[3px] left-[3px] size-3 rounded-full bg-white transition-transform',
          checked && 'translate-x-3.5',
        )}
      />
    </button>
  );
}
