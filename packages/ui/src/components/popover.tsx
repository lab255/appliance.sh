'use client';

import * as React from 'react';
import * as Primitive from '@radix-ui/react-popover';
import { cn } from '../lib/utils.js';
import { useTransition } from '../motion/use-transition.js';
export const Popover = Primitive.Root;
export const PopoverTrigger = Primitive.Trigger;
export const PopoverAnchor = Primitive.Anchor;
export const PopoverClose = Primitive.Close;
export const PopoverPortal = Primitive.Portal;
export type PopoverContentProps = React.ComponentPropsWithoutRef<typeof Primitive.Content>;
export const PopoverContent = React.forwardRef<React.ElementRef<typeof Primitive.Content>, PopoverContentProps>(
  function PopoverContent({ className, sideOffset = 4, ...props }, ref) {
    const { immediate } = useTransition();
    return (
      <Primitive.Portal>
        <Primitive.Content
          ref={ref}
          sideOffset={sideOffset}
          data-immediate={immediate || undefined}
          className={cn(
            'appliance-ui ui-overlay-fast z-50 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-overlay)] p-2 text-sm shadow-lg outline-none',
            className
          )}
          {...props}
        />
      </Primitive.Portal>
    );
  }
);
