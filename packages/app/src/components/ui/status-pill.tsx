import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

export type StatusTone = 'neutral' | 'info' | 'sandbox' | 'success' | 'warning' | 'error';

export interface StatusPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone: StatusTone;
  label: React.ReactNode;
  activity?: 'static' | 'pulse' | 'spin';
  dot?: boolean;
}

export const statusToneVariants = cva('', {
  variants: {
    tone: {
      neutral: 'border-[var(--color-border)] bg-[var(--color-muted)] text-[var(--color-muted-foreground)]',
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
});

export function StatusPill({ tone, label, activity = 'static', dot = true, className, ...props }: StatusPillProps) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-micro font-medium leading-4',
        statusToneVariants({ tone }),
        className
      )}
      {...props}
    >
      {dot ? (
        activity === 'spin' ? (
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        ) : (
          <span className={cn('h-1.5 w-1.5 rounded-full bg-current', activity === 'pulse' && 'animate-pulse')} />
        )
      ) : null}
      <span>{label}</span>
    </span>
  );
}
