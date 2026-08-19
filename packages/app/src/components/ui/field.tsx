import * as React from 'react';
import { cn } from '@/lib/utils';

export interface FieldProps extends React.HTMLAttributes<HTMLDivElement> {
  label: React.ReactNode;
  htmlFor: string;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  optional?: boolean;
  children: React.ReactNode;
}

export function Field({ label, htmlFor, hint, error, optional, children, className, ...props }: FieldProps) {
  return (
    <div className={cn('space-y-1', className)} {...props}>
      <label htmlFor={htmlFor} className="block text-xs font-medium leading-4">
        {label}
        {optional ? <span className="font-normal text-[var(--color-muted-foreground)]"> (optional)</span> : null}
      </label>
      {children}
      {error ? (
        <div role="alert" className="text-xs leading-4 text-[var(--color-destructive-foreground)]">
          {error}
        </div>
      ) : hint ? (
        <div className="text-xs leading-4 text-[var(--color-muted-foreground)]">{hint}</div>
      ) : null}
    </div>
  );
}
