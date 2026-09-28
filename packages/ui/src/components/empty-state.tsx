import * as React from 'react';

/** Shared empty-state card: dashed border, optional icon, centered
 *  message, optional CTA. Keeps the copy pattern consistent across list
 *  pages — a short "what's missing" line plus, when possible, how to get
 *  the first one. */
export function EmptyState({
  title,
  description,
  action,
  icon: Icon,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-[var(--color-border)] px-8 py-12 text-center">
      {Icon ? (
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-muted)] text-[var(--color-muted-foreground)]">
          <Icon className="h-5 w-5" />
        </div>
      ) : null}
      <div className="text-sm font-medium">{title}</div>
      {description ? (
        <div className="mt-1.5 max-w-sm text-sm text-[var(--color-muted-foreground)]">{description}</div>
      ) : null}
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}
