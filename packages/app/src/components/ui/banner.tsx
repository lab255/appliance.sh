import * as React from 'react';
import { X } from 'lucide-react';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

export type BannerTone = 'neutral' | 'info' | 'sandbox' | 'success' | 'warning' | 'error';

export interface BannerProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: BannerTone;
  title?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  action?: React.ReactNode;
  onDismiss?: () => void;
  children: React.ReactNode;
}

const bannerVariants = cva('flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-sm leading-5', {
  variants: {
    tone: {
      neutral: 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground)]',
      info: 'border-[var(--color-info-border)] bg-[var(--color-info-background)] text-[var(--color-info-foreground)]',
      sandbox:
        'border-[var(--color-sandbox-border)] bg-[var(--color-sandbox-background)] text-[var(--color-sandbox-foreground)]',
      success:
        'border-[var(--color-success-border)] bg-[var(--color-success-background)] text-[var(--color-success-foreground)]',
      warning:
        'border-[var(--color-warning-border)] bg-[var(--color-warning-background)] text-[var(--color-warning-foreground)]',
      error:
        'border-[var(--color-destructive-border)] bg-[var(--color-destructive-background)] text-[var(--color-destructive-foreground)]',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export function Banner({
  tone = 'neutral',
  title,
  icon: Icon,
  action,
  onDismiss,
  children,
  className,
  role,
  ...props
}: BannerProps) {
  const inferredRole = tone === 'error' ? 'alert' : tone === 'success' ? 'status' : undefined;
  return (
    <div role={role ?? inferredRole} className={cn(bannerVariants({ tone }), className)} {...props}>
      {Icon ? <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : null}
      <div className="min-w-0 flex-1">
        {title ? <div className="font-medium">{title}</div> : null}
        <div className={cn(title && 'mt-0.5 text-xs leading-4 opacity-90')}>{children}</div>
      </div>
      {action || onDismiss ? (
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {action}
          {onDismiss ? (
            <button
              type="button"
              aria-label="Dismiss"
              onClick={onDismiss}
              className="rounded p-1 opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export { bannerVariants };
