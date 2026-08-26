import * as React from 'react';
import { cn } from '@/lib/utils';

export interface SectionCardProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  tone?: 'neutral' | 'danger';
  as?: 'section' | 'div';
  children: React.ReactNode;
}

export function SectionCard({
  title,
  description,
  action,
  tone = 'neutral',
  as: Comp = 'section',
  children,
  className,
  ...props
}: SectionCardProps) {
  const hasHeader = title || description || action;
  return (
    <Comp
      className={cn(
        'rounded-md border bg-transparent p-4',
        tone === 'danger' ? 'border-[var(--color-destructive-border)]' : 'border-[var(--color-border)]',
        className
      )}
      {...props}
    >
      {hasHeader ? (
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title ? (
              <h2
                className={cn(
                  'text-sm font-semibold',
                  tone === 'danger' && 'text-[var(--color-destructive-foreground)]'
                )}
              >
                {title}
              </h2>
            ) : null}
            {description ? (
              <div className="mt-1 text-xs leading-4 text-[var(--color-muted-foreground)]">{description}</div>
            ) : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      <div className="min-w-0">{children}</div>
    </Comp>
  );
}
