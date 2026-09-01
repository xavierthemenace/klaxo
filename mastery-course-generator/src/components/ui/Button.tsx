'use client';

import { forwardRef, ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

/**
 * The button's classes, on their own.
 *
 * Exported so a link can *look* like a button without a `<button>` sitting
 * inside an `<a>` — that nesting is invalid, and it stopped cmd-clicking
 * "Practice" from opening in a new tab.
 */
export function buttonClasses(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  className?: string,
): string {
  const baseStyles =
    'inline-flex items-center justify-center font-display font-semibold tracking-[-0.01em] transition-all duration-150 ease-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none rounded-lg select-none';

  /* Mineral Rose gives affordance with a hairline and a low shadow, not with
     a drawn outline and an offset block. Pressing lifts the shadow away. */
  const raised = 'border shadow-sm active:translate-y-px active:shadow-none';

  const variants = {
    primary: `${raised} border-transparent bg-primary text-primary-foreground hover:bg-primary-500 active:bg-primary-700`,
    secondary: `${raised} border-primary-border bg-primary-soft text-primary-soft-foreground hover:bg-primary-soft-hover`,
    outline: `${raised} border-border bg-card text-foreground hover:bg-secondary`,
    ghost: 'hover:bg-secondary hover:text-foreground active:scale-[0.98]',
    destructive: `${raised} border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/90`,
  };

  const sizes = {
    sm: 'h-11 rounded-md px-3.5 text-xs sm:h-9',
    md: 'h-11 px-5 py-2 text-sm',
    lg: 'h-12 rounded-lg px-8 text-base',
  };

  return cn(baseStyles, variants[variant], sizes[size], className);
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', loading, disabled, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        className={buttonClasses(variant, size, className)}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading && (
          <svg
            className="mr-2 h-4 w-4 animate-spin"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
              fill="none"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        )}
        {children}
      </button>
    );
  },
);

Button.displayName = 'Button';