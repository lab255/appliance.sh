import { cn } from '../lib/utils.js';

/** Loading placeholder block. Compose into card/row-shaped layouts so
 *  loading states keep the destination's geometry instead of swapping
 *  a "Loading…" string in. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn('appliance-ui', 'appliance-ui animate-pulse rounded-md bg-[var(--color-muted)]', className)} />
  );
}

/** Skeleton for the bordered row-list layout the list pages share —
 *  mirrors a few rows of title + meta so the page doesn't reflow when
 *  real data lands. */
export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className="divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]"
    >
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3">
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-64" />
          </div>
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  );
}
