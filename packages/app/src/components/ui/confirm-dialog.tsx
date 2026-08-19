import * as React from 'react';
import { Button } from '@/components/ui/button';

export interface ConfirmOptions {
  title: string;
  description?: string;
  /** Label on the confirming button. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Render the confirming button in the destructive style. Defaults to true — every current caller guards a delete/destroy. */
  destructive?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = React.createContext<ConfirmFn | null>(null);

/** Promise-based replacement for window.confirm that matches the
 *  app's dark theme. `const ok = await confirm({ title: ... })`. */
export function useConfirm(): ConfirmFn {
  const ctx = React.useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within <ConfirmProvider>');
  return ctx;
}

interface PendingConfirm {
  opts: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = React.useState<PendingConfirm | null>(null);
  const cancelRef = React.useRef<HTMLButtonElement>(null);

  const confirm = React.useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      // A second confirm while one is open auto-cancels the first —
      // mirrors window.confirm, which can't stack either.
      setPending((prev) => {
        prev?.resolve(false);
        return { opts, resolve };
      });
    });
  }, []);

  const settle = React.useCallback((ok: boolean) => {
    setPending((prev) => {
      prev?.resolve(ok);
      return null;
    });
  }, []);

  React.useEffect(() => {
    if (!pending) return;
    // Focus lands on Cancel so Enter/Space can't destroy by accident.
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') settle(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, settle]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) settle(false);
          }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            className="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-overlay)] p-5 shadow-xl"
          >
            <h2 id="confirm-dialog-title" className="text-sm font-semibold">
              {pending.opts.title}
            </h2>
            {pending.opts.description ? (
              <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">{pending.opts.description}</p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <Button ref={cancelRef} variant="outline" size="sm" onClick={() => settle(false)}>
                Cancel
              </Button>
              <Button
                variant={pending.opts.destructive === false ? 'default' : 'destructive'}
                size="sm"
                onClick={() => settle(true)}
              >
                {pending.opts.confirmLabel ?? 'Confirm'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </ConfirmContext.Provider>
  );
}
