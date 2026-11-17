import * as React from 'react';
import { RefreshCw } from 'lucide-react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { paintPending } from '@/lib/paint-pending';
import { cn } from '@/lib/utils';

type RefetchButtonProps = Omit<ButtonProps, 'asChild'> & {
  onRefetch: () => Promise<unknown>;
  pendingLabel?: string;
};

/** User-initiated reads only. Query retries, polling and initial loads stay query-owned. */
export const RefetchButton = React.forwardRef<HTMLButtonElement, RefetchButtonProps>(
  ({ onRefetch, onClick, pendingLabel = 'Retrying…', disabled, children, size, ...props }, ref) => {
    const [pending, setPending] = React.useState(false);
    const mounted = React.useRef(true);
    React.useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
      };
    }, []);
    const busy = pending;
    async function refetch() {
      if (busy || disabled || props['aria-disabled'] === true || props['aria-disabled'] === 'true') return;
      try {
        await paintPending(() => setPending(true));
        if (mounted.current) await onRefetch();
      } finally {
        if (mounted.current) setPending(false);
      }
    }
    return (
      <Button
        {...props}
        ref={ref}
        size={size}
        aria-disabled={busy || disabled || props['aria-disabled']}
        aria-busy={busy}
        aria-label={busy ? pendingLabel : props['aria-label']}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) void refetch();
        }}
      >
        <span className="inline-grid place-items-center">
          <span
            aria-hidden={busy || undefined}
            className={cn('col-start-1 row-start-1 inline-flex items-center gap-2', busy && 'invisible')}
          >
            {children}
          </span>
          <span
            aria-hidden="true"
            className={cn('col-start-1 row-start-1 inline-flex items-center gap-2', !busy && 'invisible')}
          >
            {size === 'icon' ? <RefreshCw className="h-4 w-4 motion-safe:animate-spin" /> : pendingLabel}
          </span>
        </span>
      </Button>
    );
  }
);
RefetchButton.displayName = 'RefetchButton';
