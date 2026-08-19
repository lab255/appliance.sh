import * as React from 'react';
import { cn } from '@/lib/utils';

export interface PageShellProps extends React.HTMLAttributes<HTMLDivElement> {
  rail?: 'browse' | 'detail' | 'focused';
}

export function PageShell({ rail = 'detail', className, ...props }: PageShellProps) {
  return (
    <div
      className={cn(
        'w-full',
        rail === 'browse' && 'max-w-5xl',
        rail === 'detail' && 'max-w-3xl',
        rail === 'focused' && 'mx-auto max-w-2xl',
        className
      )}
      {...props}
    />
  );
}

export interface PageHeaderProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  focused?: boolean;
}

export function PageHeader({ title, description, action, focused, className, ...props }: PageHeaderProps) {
  return (
    <header className={cn('mb-6 flex flex-wrap items-start justify-between gap-3', className)} {...props}>
      <div className="min-w-0">
        <h1 className={cn('font-semibold tracking-tight', focused ? 'text-2xl' : 'text-xl')}>{title}</h1>
        {description ? (
          <p className="mt-1 text-sm leading-5 text-[var(--color-muted-foreground)]">{description}</p>
        ) : null}
      </div>
      {action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
    </header>
  );
}
