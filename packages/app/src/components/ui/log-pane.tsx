import * as React from 'react';
import { Check, ChevronRight, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTailAutoscroll } from '@/hooks/use-tail-autoscroll';

export interface LogPaneProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children' | 'onScroll'> {
  label?: string;
  children?: React.ReactNode;
  empty?: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  viewportRef?: React.Ref<HTMLDivElement>;
  onViewportScroll?: React.UIEventHandler<HTMLDivElement>;
  height?: 'compact' | 'default' | 'fill';
  copyText?: string;
  live?: 'off' | 'polite';
}

function assignRef<T>(ref: React.Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}

export function LogPane({
  label = 'Details (log)',
  children,
  empty = 'Waiting…',
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  viewportRef,
  onViewportScroll,
  height = 'default',
  copyText,
  live = 'off',
  className,
  ...props
}: LogPaneProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const [copied, setCopied] = React.useState(false);
  const copyTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const open = controlledOpen ?? uncontrolledOpen;
  const tail = useTailAutoscroll<HTMLDivElement>([children, open]);

  React.useEffect(() => () => void (copyTimer.current && clearTimeout(copyTimer.current)), []);

  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  const onCopy = async () => {
    if (copyText === undefined) return;
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  const hasContent = React.Children.count(children) > 0;
  return (
    <div
      className={cn(
        'overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-background)]',
        height === 'fill' && 'flex min-h-0 flex-1 flex-col',
        className
      )}
      {...props}
    >
      <div className="flex items-center">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex w-full flex-1 items-center justify-between gap-3 px-3 py-2 text-xs font-medium text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-ring)]"
        >
          <span>{label}</span>
          <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-90')} aria-hidden />
        </button>
        {copyText !== undefined ? (
          <button
            type="button"
            onClick={() => void onCopy()}
            disabled={!copyText}
            aria-label={copied ? 'Copied' : 'Copy log'}
            className="mr-2 rounded p-1 text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] disabled:opacity-50"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-[var(--color-success-foreground)]" aria-hidden />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden />
            )}
          </button>
        ) : null}
      </div>
      {open ? (
        <div
          ref={(node) => {
            tail.ref.current = node;
            assignRef(viewportRef, node);
          }}
          role="log"
          aria-label={label}
          aria-live={live === 'polite' ? 'polite' : undefined}
          aria-relevant={live === 'polite' ? 'additions' : undefined}
          onScroll={(event) => {
            tail.onScroll(event);
            onViewportScroll?.(event);
          }}
          className={cn(
            'overflow-auto whitespace-pre-wrap border-t border-[var(--color-border)] px-3 py-2 font-mono text-xs leading-relaxed tabular-nums text-[var(--color-foreground)]',
            height === 'compact' && 'max-h-40',
            height === 'default' && 'h-72',
            height === 'fill' && 'min-h-0 flex-1'
          )}
        >
          {hasContent ? children : <span className="text-[var(--color-muted-foreground)]">{empty}</span>}
        </div>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? 'Log copied' : ''}
      </span>
    </div>
  );
}
