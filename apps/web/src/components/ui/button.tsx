import clsx from 'clsx';
import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:brightness-110 border border-transparent font-semibold',
  secondary: 'bg-transparent text-text border border-line-strong hover:bg-surface-2',
  ghost: 'bg-transparent text-muted border border-transparent hover:bg-surface-2 hover:text-text',
  danger: 'bg-transparent text-err-text border border-err/50 hover:bg-err-soft',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-[12px]',
  md: 'h-8 px-3 text-[13px]',
};

/** Class names shared by <Button> and link-styled buttons so both look identical. */
export function buttonClass(
  variant: ButtonVariant = 'secondary',
  size: ButtonSize = 'md',
  extra?: string,
): string {
  return clsx(
    'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-control whitespace-nowrap transition-colors',
    'disabled:cursor-not-allowed disabled:opacity-50',
    VARIANTS[variant],
    SIZES[size],
    extra,
  );
}

export function Button({
  variant,
  size,
  className,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} className={buttonClass(variant, size, className)} {...props} />;
}
