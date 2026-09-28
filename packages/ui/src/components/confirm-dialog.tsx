'use client';

import * as React from 'react';
import * as m from 'motion/react-m';
import { AnimatePresence, useIsPresent } from 'motion/react';
import { useTransition } from '../motion/use-transition.js';
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
  const dialogRef = React.useRef<HTMLDivElement>(null);
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
    const previous = document.activeElement as HTMLElement | null;
    // Inert every outside branch, including sibling toast/portal roots. Preserve
    // existing inert state so teardown never enables a consumer-disabled region.
    const backgrounds: Array<[HTMLElement, boolean]> = [];
    let branch: HTMLElement | null = dialogRef.current;
    while (branch?.parentElement && branch.parentElement !== document.documentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling !== branch && sibling instanceof HTMLElement) {
          backgrounds.push([sibling, sibling.inert]);
          sibling.inert = true;
        }
      }
      branch = branch.parentElement;
    }
    // Focus lands on Cancel so Enter/Space can't destroy by accident.
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') settle(false);
      if (e.key === 'Tab') {
        const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
        if (!buttons?.length) return;
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      for (const [element, inert] of backgrounds) element.inert = inert;
      previous?.focus();
    };
  }, [pending, settle]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AnimatePresence initial={false}>
        {pending ? (
          <ConfirmSurface
            key="confirm"
            opts={pending.opts}
            settle={settle}
            cancelRef={cancelRef}
            dialogRef={dialogRef}
          />
        ) : null}
      </AnimatePresence>
    </ConfirmContext.Provider>
  );
}

function ConfirmSurface({
  opts,
  settle,
  cancelRef,
  dialogRef,
}: {
  opts: ConfirmOptions;
  settle: (ok: boolean) => void;
  cancelRef: React.RefObject<HTMLButtonElement | null>;
  dialogRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { immediate, transition, exitTransition } = useTransition();
  const present = useIsPresent();
  return (
    <m.div
      inert={!present}
      aria-hidden={!present || undefined}
      style={{ pointerEvents: present ? 'auto' : 'none' }}
      exit={immediate ? undefined : { opacity: 0, transition: exitTransition }}
      initial={immediate ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={exitTransition}
      className="appliance-ui fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) settle(false);
      }}
    >
      <m.div
        ref={dialogRef}
        initial={immediate ? false : { opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={transition}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-overlay)] p-5 shadow-xl"
      >
        <h2 id="confirm-dialog-title" className="text-sm font-semibold">
          {opts.title}
        </h2>
        {opts.description ? (
          <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">{opts.description}</p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button ref={cancelRef} variant="outline" size="sm" onClick={() => settle(false)}>
            Cancel
          </Button>
          <Button
            variant={opts.destructive === false ? 'default' : 'destructive'}
            size="sm"
            onClick={() => settle(true)}
          >
            {opts.confirmLabel ?? 'Confirm'}
          </Button>
        </div>
      </m.div>
    </m.div>
  );
}
