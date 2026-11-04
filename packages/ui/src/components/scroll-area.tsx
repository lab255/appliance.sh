'use client';

import * as React from 'react';
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import { cn } from '../lib/utils.js';

export interface ScrollAreaProps extends React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> {
  viewportRef?: React.Ref<HTMLDivElement>;
  viewportProps?: React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Viewport>;
}

/** Native scrolling with overlay rails: refs and scroll events belong to the viewport.
 * Rails appear only for overflow and stay still; no hover fade or smooth scrolling.
 */
export function ScrollArea({ children, className, viewportRef, viewportProps, ...props }: ScrollAreaProps) {
  return (
    <ScrollAreaPrimitive.Root
      type="auto"
      className={cn('appliance-ui relative flex min-h-0 flex-col overflow-hidden', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        {...viewportProps}
        ref={viewportRef}
        tabIndex={viewportProps?.tabIndex ?? 0}
        className={cn(
          'min-h-0 flex-1 rounded-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-ring)]',
          viewportProps?.className
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {(['vertical', 'horizontal'] as const).map((orientation) => (
        <ScrollAreaPrimitive.Scrollbar
          key={orientation}
          orientation={orientation}
          className={cn('flex touch-none select-none p-0.5', orientation === 'vertical' ? 'w-2.5' : 'h-2.5 flex-col')}
        >
          <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-[var(--color-border-strong)]" />
        </ScrollAreaPrimitive.Scrollbar>
      ))}
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}
