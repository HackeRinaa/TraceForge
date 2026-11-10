import clsx from 'clsx';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type { ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';

/** Horizontally scrollable table wrapper: wide tables scroll inside their panel rather than the page. */
export function Table({
  children,
  minWidth = 560,
  label,
}: {
  children: ReactNode;
  minWidth?: number;
  label: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table
        aria-label={label}
        className="w-full border-collapse text-[12.5px]"
        style={{ minWidth }}
      >
        {children}
      </table>
    </div>
  );
}

export function Th({
  align = 'left',
  className,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & { align?: 'left' | 'right' }) {
  return (
    <th
      scope="col"
      className={clsx(
        'px-3 py-2 text-[12px] font-medium whitespace-nowrap text-dim first:pl-4 last:pr-4',
        align === 'right' ? 'text-right' : 'text-left',
        className,
      )}
      {...props}
    />
  );
}

/** Column header that sorts when activated; announces its state through aria-sort. */
export function SortTh({
  label,
  active,
  direction,
  onSort,
  align = 'right',
}: {
  label: string;
  active: boolean;
  direction: 'asc' | 'desc';
  onSort: () => void;
  align?: 'left' | 'right';
}) {
  return (
    <th
      scope="col"
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={clsx(
        'px-3 py-2 text-[12px] font-medium whitespace-nowrap first:pl-4 last:pr-4',
        align === 'right' ? 'text-right' : 'text-left',
      )}
    >
      <button
        type="button"
        onClick={onSort}
        className={clsx(
          'inline-flex cursor-pointer items-center gap-1 rounded hover:text-text',
          active ? 'text-text' : 'text-dim',
        )}
      >
        {label}
        {active &&
          (direction === 'asc' ? (
            <ArrowUp className="size-3" aria-hidden />
          ) : (
            <ArrowDown className="size-3" aria-hidden />
          ))}
      </button>
    </th>
  );
}

export function Td({
  align = 'left',
  mono,
  className,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & { align?: 'left' | 'right'; mono?: boolean }) {
  return (
    <td
      className={clsx(
        'px-3 py-2 first:pl-4 last:pr-4',
        align === 'right' && 'text-right',
        mono && 'tabular font-mono',
        className,
      )}
      {...props}
    />
  );
}

export const rowClass = 'border-t border-line';
export const rowLinkClass =
  'border-t border-line cursor-pointer hover:bg-surface-2 focus-within:bg-surface-2';
