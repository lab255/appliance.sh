import * as React from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ToastVariant = 'success' | 'info' | 'warning' | 'error';

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

interface ToastContextValue {
  toast: (message: string, opts?: { variant?: ToastVariant }) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

/** Fire-and-forget notifications for action feedback ("Project
 *  deleted") that doesn't warrant a layout-shifting inline banner.
 *  Errors that block a flow should stay inline next to the action. */
export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);
  const nextId = React.useRef(0);

  const dismiss = React.useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = React.useCallback(
    (message: string, opts?: { variant?: ToastVariant }) => {
      const id = nextId.current++;
      const variant = opts?.variant ?? 'success';
      setToasts((prev) => [...prev, { id, message, variant }]);
      // Errors linger longer; every toast is also manually dismissible.
      window.setTimeout(() => dismiss(id), variant === 'error' ? 8000 : 4000);
    },
    [dismiss]
  );

  const value = React.useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
        {toasts.map((t) => {
          const styles: Record<ToastVariant, string> = {
            success: 'border-[var(--color-success-border)] text-[var(--color-success-foreground)]',
            info: 'border-[var(--color-info-border)] text-[var(--color-info-foreground)]',
            warning: 'border-[var(--color-warning-border)] text-[var(--color-warning-foreground)]',
            error: 'border-[var(--color-destructive-border)] text-[var(--color-destructive-foreground)]',
          };
          const Icon =
            t.variant === 'success'
              ? CheckCircle2
              : t.variant === 'info'
                ? Info
                : t.variant === 'warning'
                  ? AlertTriangle
                  : XCircle;
          return (
            <div
              key={t.id}
              role={t.variant === 'error' ? 'alert' : 'status'}
              className={cn(
                'pointer-events-auto flex items-start gap-2 rounded-md border bg-[var(--color-surface-raised)] px-3 py-2.5 text-sm shadow-lg',
                styles[t.variant]
              )}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <div className="min-w-0 flex-1 break-words text-[var(--color-foreground)]">{t.message}</div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss notification"
                className="rounded p-0.5 text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
