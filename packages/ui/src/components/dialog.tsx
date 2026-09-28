'use client';

import * as React from 'react';
import * as Primitive from '@radix-ui/react-dialog';
import { cn } from '../lib/utils.js';
import { useTransition } from '../motion/use-transition.js';

export const Dialog = Primitive.Root;
export const DialogTrigger = Primitive.Trigger;
export const DialogClose = Primitive.Close;
export const DialogTitle = Primitive.Title;
export const DialogDescription = Primitive.Description;
export const DialogPortal = Primitive.Portal;
export const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof Primitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof Primitive.Overlay>
>(function DialogOverlay({ className, ...props }, ref) {
  const { immediate } = useTransition();
  return (
    <Primitive.Overlay
      ref={ref}
      data-immediate={immediate || undefined}
      className={cn('appliance-ui ui-dialog-scrim fixed inset-0 z-50 bg-black/60', className)}
      {...props}
    />
  );
});

export type DialogContentProps = React.ComponentPropsWithoutRef<typeof Primitive.Content>;
export const DialogContent = React.forwardRef<React.ElementRef<typeof Primitive.Content>, DialogContentProps>(
  function DialogContent({ className, children, forceMount, ...props }, ref) {
    const { immediate } = useTransition();
    return (
      <Primitive.Portal forceMount={forceMount}>
        <DialogOverlay forceMount={forceMount} />
        <Primitive.Content
          ref={ref}
          forceMount={forceMount}
          data-immediate={immediate || undefined}
          className={cn(
            'appliance-ui ui-dialog-content fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-overlay)] p-5 shadow-xl outline-none',
            className
          )}
          {...props}
        >
          {children}
        </Primitive.Content>
      </Primitive.Portal>
    );
  }
);
