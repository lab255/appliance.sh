'use client';

import * as React from 'react';
import * as Primitive from '@radix-ui/react-dialog';
import { cn } from '../lib/utils.js';
import { AnimatePresence } from 'motion/react';
import { createOverlayMotion, useOverlayState } from '../motion/overlay.js';
import { selectTransition, useTransition } from '../motion/use-transition.js';

const OpenContext = React.createContext(false);
export function Dialog(props: React.ComponentProps<typeof Primitive.Root>) {
  const state = useOverlayState(props);
  return (
    <OpenContext.Provider value={state.open}>
      <Primitive.Root {...props} {...state} />
    </OpenContext.Provider>
  );
}
const MotionContent = createOverlayMotion(Primitive.Content);
export const DialogTrigger = Primitive.Trigger;
export const DialogClose = Primitive.Close;
export const DialogTitle = Primitive.Title;
export const DialogDescription = Primitive.Description;
export const DialogPortal = Primitive.Portal;
const MotionOverlay = createOverlayMotion(Primitive.Overlay);
export const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof Primitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof Primitive.Overlay>
>(function DialogOverlay({ className, forceMount, ...props }, ref) {
  const { immediate } = useTransition();
  const open = React.useContext(OpenContext);
  return (
    <AnimatePresence>
      {(open || forceMount) && (
        <MotionOverlay
          key="scrim"
          initial={immediate ? false : { opacity: 0 }}
          animate={{ opacity: open ? 1 : 0 }}
          exit={{ opacity: 0, transition: selectTransition(immediate, 'fast', 'exit') }}
          transition={selectTransition(immediate, 'fast', open ? 'enter' : 'exit')}
          ref={ref}
          primitiveProps={{
            ...props,
            forceMount: true,
            className: cn('appliance-ui ui-dialog-scrim fixed inset-0 z-50 bg-black/60', className),
          }}
        />
      )}
    </AnimatePresence>
  );
});

export type DialogContentProps = React.ComponentPropsWithoutRef<typeof Primitive.Content>;
export const DialogContent = React.forwardRef<React.ElementRef<typeof Primitive.Content>, DialogContentProps>(
  function DialogContent({ className, children, forceMount, ...props }, ref) {
    const { immediate } = useTransition();
    const open = React.useContext(OpenContext);
    return (
      <Primitive.Portal forceMount>
        <DialogOverlay forceMount={forceMount} />
        <AnimatePresence>
          {(open || forceMount) && (
            <MotionContent
              key="content"
              ref={ref}
              initial={immediate ? false : { opacity: 0, scale: 0.98 }}
              animate={{ opacity: open ? 1 : 0, scale: open ? 1 : 0.98 }}
              exit={{ opacity: 0, transition: selectTransition(immediate, 'base', 'exit') }}
              transition={selectTransition(immediate, 'base', open ? 'enter' : 'exit')}
              primitiveProps={{
                ...props,
                forceMount: true,
                children,
                'data-immediate': immediate || undefined,
                className: cn(
                  'appliance-ui ui-dialog-content fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-overlay)] p-5 shadow-xl outline-none',
                  className
                ),
              }}
            />
          )}
        </AnimatePresence>
      </Primitive.Portal>
    );
  }
);
