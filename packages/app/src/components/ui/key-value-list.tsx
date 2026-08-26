import * as React from 'react';
import { cn } from '@/lib/utils';

export interface KeyValueItem {
  key: React.Key;
  label: React.ReactNode;
  value: React.ReactNode;
  mono?: boolean;
}

export interface KeyValueListProps extends React.HTMLAttributes<HTMLDListElement> {
  items: readonly KeyValueItem[];
  columns?: 'compact' | 'wide';
}

export function KeyValueList({ items, columns = 'compact', className, ...props }: KeyValueListProps) {
  return (
    <dl
      className={cn(
        'grid gap-x-4 gap-y-1 text-sm',
        columns === 'wide' ? 'grid-cols-[10rem_minmax(0,1fr)]' : 'grid-cols-[7rem_minmax(0,1fr)]',
        className
      )}
      {...props}
    >
      {items.map((item) => (
        <React.Fragment key={item.key}>
          <dt className="text-xs leading-5 text-[var(--color-muted-foreground)]">{item.label}</dt>
          <dd className={cn('min-w-0 text-sm leading-5', item.mono && 'truncate font-mono text-xs tabular-nums')}>
            {item.value}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}
