import * as React from 'react';
import { cn } from '@/lib/utils';

export interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  emphasis?: 'quiet' | 'info' | 'sandbox';
  children: React.ReactNode;
}

export function Tag({ emphasis = 'quiet', className, children, ...props }: TagProps) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-micro font-medium leading-4',
        emphasis === 'sandbox'
          ? 'bg-[var(--color-sandbox-background)] text-[var(--color-sandbox-foreground)]'
          : emphasis === 'info'
            ? 'bg-[var(--color-info-background)] text-[var(--color-info-foreground)]'
            : 'bg-[var(--color-muted)] text-[var(--color-muted-foreground)]',
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}
