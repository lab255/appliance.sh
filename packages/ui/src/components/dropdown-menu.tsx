'use client';

import * as React from 'react';
import * as Primitive from '@radix-ui/react-dropdown-menu';
import { cn } from '../lib/utils.js';
import { useTransition } from '../motion/use-transition.js';
export const DropdownMenu = Primitive.Root;
export const DropdownMenuTrigger = Primitive.Trigger;
export const DropdownMenuGroup = Primitive.Group;
export const DropdownMenuRadioGroup = Primitive.RadioGroup;
export const DropdownMenuItemIndicator = Primitive.ItemIndicator;
export const DropdownMenuPortal = Primitive.Portal;
export type DropdownMenuContentProps = React.ComponentPropsWithoutRef<typeof Primitive.Content>;
export const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof Primitive.Content>,
  DropdownMenuContentProps
>(function DropdownMenuContent({ className, sideOffset = 4, ...props }, ref) {
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
