'use client';

import * as React from 'react';
import * as Primitive from '@radix-ui/react-dropdown-menu';
import { cn } from '../lib/utils.js';
import { AnimatePresence } from 'motion/react';
import { createOverlayMotion, useOverlayState } from '../motion/overlay.js';
import { selectTransition, useTransition } from '../motion/use-transition.js';
const OpenContext = React.createContext(false);
export function DropdownMenu(props: React.ComponentProps<typeof Primitive.Root>) {
  const state = useOverlayState(props);
  return (
    <OpenContext.Provider value={state.open}>
      <Primitive.Root {...props} {...state} />
    </OpenContext.Provider>
  );
}
const MotionContent = createOverlayMotion(Primitive.Content);
export const DropdownMenuTrigger = Primitive.Trigger;
export const DropdownMenuGroup = Primitive.Group;
export const DropdownMenuRadioGroup = Primitive.RadioGroup;
export const DropdownMenuItemIndicator = Primitive.ItemIndicator;
export const DropdownMenuPortal = Primitive.Portal;
export type DropdownMenuContentProps = React.ComponentPropsWithoutRef<typeof Primitive.Content>;
export const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof Primitive.Content>,
  DropdownMenuContentProps
>(function DropdownMenuContent({ className, sideOffset = 4, forceMount, ...props }, ref) {
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
});
export const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof Primitive.Item>,
  React.ComponentPropsWithoutRef<typeof Primitive.Item>
>(function DropdownMenuItem({ className, ...props }, ref) {
  return (
    <Primitive.Item
      ref={ref}
      className={cn(
        'relative flex select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-[var(--color-muted-raised)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className
      )}
      {...props}
    />
  );
});
export const DropdownMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof Primitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof Primitive.RadioItem>
>(function DropdownMenuRadioItem({ className, ...props }, ref) {
  return (
    <Primitive.RadioItem
      ref={ref}
      className={cn(
        'relative flex select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-[var(--color-muted-raised)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className
      )}
      {...props}
    />
  );
});
export const DropdownMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof Primitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof Primitive.CheckboxItem>
>(function DropdownMenuCheckboxItem({ className, ...props }, ref) {
  return (
    <Primitive.CheckboxItem
      ref={ref}
      className={cn(
        'relative flex select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-[var(--color-muted-raised)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className
      )}
      {...props}
    />
  );
});
export const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof Primitive.Label>,
  React.ComponentPropsWithoutRef<typeof Primitive.Label>
>(function DropdownMenuLabel({ className, ...props }, ref) {
  return (
    <Primitive.Label
      ref={ref}
      className={cn(
        'relative flex select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-[var(--color-muted-raised)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className
      )}
      {...props}
    />
  );
});
export const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof Primitive.Separator>,
  React.ComponentPropsWithoutRef<typeof Primitive.Separator>
>(function DropdownMenuSeparator({ className, ...props }, ref) {
  return <Primitive.Separator ref={ref} className={cn('h-px my-1 bg-[var(--color-border)]', className)} {...props} />;
});
