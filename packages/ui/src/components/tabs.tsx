'use client';

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as m from 'motion/react-m';
import { AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils.js';
import { selectTransition, useTransition } from '../motion/use-transition.js';

export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;

type Rect = { x: number; y: number; width: number; height: number };

/** Radix owns selection, roving focus and panel IDs; only the indicator moves.
 * Measurement supports wrapping, resizing, RTL and vertical lists without scaling text.
 */
export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & { variant?: 'line' | 'segment' }
>(({ className, children, variant = 'line', ...props }, forwardedRef) => {
  const ref = React.useRef<HTMLDivElement>(null);
  const [rect, setRect] = React.useState<Rect | null>(null);
  const { immediate } = useTransition();
  React.useImperativeHandle(forwardedRef, () => ref.current!);
  React.useLayoutEffect(() => {
    const list = ref.current;
    if (!list) return;
    const measure = () => {
      const active = list.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
      if (!active) {
        setRect(null);
        return;
      }
      const a = active.getBoundingClientRect();
      const b = list.getBoundingClientRect();
      const next = {
        x: a.left - b.left + list.scrollLeft - list.clientLeft,
        y: a.top - b.top + list.scrollTop - list.clientTop + (variant === 'line' ? a.height - 2 : 0),
        width: a.width,
        height: variant === 'line' ? 2 : a.height,
      };
      setRect((previous) =>
        previous && Object.keys(next).every((key) => previous[key as keyof Rect] === next[key as keyof Rect])
          ? previous
          : next
      );
    };
    measure();
    const mutations = new MutationObserver(measure);
    mutations.observe(list, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-state', 'disabled'],
    });
    const resize = new ResizeObserver(measure);
    resize.observe(list);
    list.querySelectorAll('[role="tab"]').forEach((tab) => resize.observe(tab));
    return () => {
      mutations.disconnect();
      resize.disconnect();
    };
  }, [variant, children]);
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn(
        'appliance-ui relative isolate flex flex-wrap gap-1',
        variant === 'line'
          ? 'border-b border-[var(--color-border)]'
          : 'inline-flex rounded-md border border-[var(--color-border)] p-0.5',
        className
      )}
      {...props}
    >
      <AnimatePresence>
        {rect && (
          <m.div
            key="indicator"
            aria-hidden="true"
            data-tabs-indicator=""
            className={cn(
              'pointer-events-none absolute left-0 top-0 -z-10',
              variant === 'line' ? 'bg-[var(--color-primary)]' : 'rounded bg-[var(--color-active)]'
            )}
            initial={false}
            animate={{ ...rect, opacity: 1 }}
            exit={{ opacity: 0, transition: selectTransition(immediate, 'fast', 'exit') }}
            transition={selectTransition(immediate, 'fast')}
          />
        )}
      </AnimatePresence>
      {children}
    </TabsPrimitive.List>
  );
});
TabsList.displayName = 'TabsList';

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'inline-flex items-center justify-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium text-[var(--color-muted-foreground)] data-[state=inactive]:hover:bg-[var(--color-hover)] hover:text-[var(--color-foreground)] data-[state=active]:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] disabled:pointer-events-none disabled:text-[var(--color-border-strong)] disabled:cursor-not-allowed',
      className
    )}
    {...props}
  />
));
TabsTrigger.displayName = 'TabsTrigger';
