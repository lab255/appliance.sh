'use client';

import * as React from 'react';
import * as Primitive from '@radix-ui/react-popover';
import { cn } from '../lib/utils.js';
import { AnimatePresence } from 'motion/react';
import { createOverlayMotion, useOverlayState } from '../motion/overlay.js';
import { selectTransition, useTransition } from '../motion/use-transition.js';
const OpenContext = React.createContext(false);
export function Popover(props: React.ComponentProps<typeof Primitive.Root>) {
  const state = useOverlayState(props);
  return (
    <OpenContext.Provider value={state.open}>
      <Primitive.Root {...props} {...state} />
    </OpenContext.Provider>
  );
}
const MotionContent = createOverlayMotion(Primitive.Content);
export const PopoverTrigger = Primitive.Trigger;
export const PopoverAnchor = Primitive.Anchor;
export const PopoverClose = Primitive.Close;
export const PopoverPortal = Primitive.Portal;
export type PopoverContentProps = React.ComponentPropsWithoutRef<typeof Primitive.Content>;
export const PopoverContent = React.forwardRef<React.ElementRef<typeof Primitive.Content>, PopoverContentProps>(
  function PopoverContent({ className, sideOffset = 4, forceMount, ...props }, ref) {
    const { immediate } = useTransition();
    const open = React.useContext(OpenContext);
    return (
      <Primitive.Portal forceMount>
        <AnimatePresence>
          {(open || forceMount) && (
            <MotionContent
              key="content"
              ref={ref}
              initial={immediate ? false : { opacity: 0 }}
              animate={{ opacity: open ? 1 : 0 }}
              exit={{ opacity: 0, transition: selectTransition(immediate, 'fast', 'exit') }}
              transition={selectTransition(immediate, 'fast', open ? 'enter' : 'exit')}
              primitiveProps={{
                ...props,
                forceMount: true,
                sideOffset,
                'data-immediate': immediate || undefined,
                className: cn(
                  'appliance-ui ui-overlay-fast z-50 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-overlay)] p-2 text-sm shadow-lg outline-none',
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
