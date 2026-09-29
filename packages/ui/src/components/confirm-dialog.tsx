'use client';

import * as React from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './dialog.js';
import { Button } from './button.js';

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
  const previousFocus = React.useRef<HTMLElement | null>(null);
  const lastOptions = React.useRef<ConfirmOptions | null>(null);
  const [pending, setPending] = React.useState<PendingConfirm | null>(null);
  const cancelRef = React.useRef<HTMLButtonElement>(null);

  const confirm = React.useCallback<ConfirmFn>((opts) => {
    if (!lastOptions.current) previousFocus.current = document.activeElement as HTMLElement;
    lastOptions.current = opts;
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

  // Programmatic confirmations have no DialogTrigger. Restore as soon as the
  // promise settles, matching the motion layer while its scrim fades out.
  React.useEffect(() => {
    if (pending) cancelRef.current?.focus();
    else previousFocus.current?.focus();
  }, [pending]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={!!pending}
        onOpenChange={(open) => {
          if (!open) settle(false);
        }}
      >
        <DialogContent
          role="alertdialog"
          aria-modal="true"
          {...(!lastOptions.current?.description ? { 'aria-describedby': undefined } : {})}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            previousFocus.current?.focus();
            lastOptions.current = null;
          }}
        >
          <DialogTitle className="text-sm font-semibold">{lastOptions.current?.title}</DialogTitle>
          {lastOptions.current?.description ? (
            <DialogDescription className="mt-2 text-sm text-[var(--color-muted-foreground)]">
              {lastOptions.current.description}
            </DialogDescription>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <Button ref={cancelRef} variant="outline" size="sm" onClick={() => settle(false)}>
              Cancel
            </Button>
            <Button
              variant={lastOptions.current?.destructive === false ? 'default' : 'destructive'}
              size="sm"
              onClick={() => settle(true)}
            >
              {lastOptions.current?.confirmLabel ?? 'Confirm'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}
