'use client';

import * as React from 'react';
import * as Primitive from '@radix-ui/react-tooltip';
import { cn } from '../lib/utils.js';
import { useTransition } from '../motion/use-transition.js';
export const Tooltip = Primitive.Root;
export const TooltipTrigger = Primitive.Trigger;
export const TooltipPortal = Primitive.Portal;
export function TooltipProvider(props: React.ComponentProps<typeof Primitive.Provider>) {
  return <Primitive.Provider delayDuration={400} skipDelayDuration={300} {...props} />;
}
export type TooltipContentProps = React.ComponentPropsWithoutRef<typeof Primitive.Content>;
export const TooltipContent = React.forwardRef<React.ElementRef<typeof Primitive.Content>, TooltipContentProps>(
  function TooltipContent({ className, sideOffset = 4, ...props }, ref) {
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
