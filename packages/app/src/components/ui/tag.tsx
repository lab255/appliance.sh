import * as React from 'react';
import { cn } from '@/lib/utils';

export interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  emphasis?: 'quiet' | 'sandbox';
  children: React.ReactNode;
}

export function Tag({ emphasis = 'quiet', className, children, ...props }: TagProps) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-micro font-medium leading-4',
        emphasis === 'sandbox'
          ? 'bg-[var(--color-sandbox-background)] text-[var(--color-sandbox-foreground)]'
          : 'bg-[var(--color-muted)] text-[var(--color-muted-foreground)]',
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}
