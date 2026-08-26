import * as React from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
  invalid?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ mono, invalid, className, 'aria-invalid': ariaInvalid, ...props }, ref) => (
    <input
      ref={ref}
      aria-invalid={invalid ? true : ariaInvalid}
      className={cn(
        'h-9 w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 text-sm text-[var(--color-foreground)] placeholder:text-[var(--color-muted-foreground)] focus-visible:border-[var(--color-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] disabled:cursor-not-allowed disabled:opacity-50',
        mono && 'font-mono text-xs tabular-nums',
        invalid && 'border-[var(--color-destructive-border)]',
        className
      )}
      {...props}
    />
  )
);
Input.displayName = 'Input';
