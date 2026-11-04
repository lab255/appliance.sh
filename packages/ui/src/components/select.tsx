'use client';

import * as React from 'react';
import * as Primitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '../lib/utils.js';
import * as m from 'motion/react-m';
import { useOverlayState } from '../motion/overlay.js';
import { selectTransition, useTransition } from '../motion/use-transition.js';

const SelectContext = React.createContext({ open: false });
// Radix reserves the empty string for clearing. Prefix every value so an actual
// empty option (shell credentials) remains selectable without sentinel collisions.
const encode = (value: string) => `value:${value}`;

type RootProps = React.ComponentProps<typeof Primitive.Root>;
export function Select({ value, defaultValue, onValueChange, name, children, ...props }: RootProps) {
  const state = useOverlayState(props);
  const { immediate } = useTransition();
  const [retained, setRetained] = React.useState(state.open);
  const [internalValue, setInternalValue] = React.useState(defaultValue);
  const currentValue = value ?? internalValue;
  // Select has no forceMount API. Keep Radix mounted for the named exit tier;
  // cancelling this timer lets a controlled reopen reverse the current fade.
  React.useEffect(() => {
    if (state.open) {
      setRetained(true);
      return;
    }
    if (immediate) {
      setRetained(false);
      return;
    }
    const timer = window.setTimeout(() => setRetained(false), selectTransition(false, 'fast', 'exit').duration * 1000);
    return () => window.clearTimeout(timer);
  }, [state.open, immediate]);
  return (
    <SelectContext.Provider value={{ open: state.open }}>
      <Primitive.Root
        {...props}
        open={state.open || (!immediate && retained)}
        onOpenChange={state.onOpenChange}
        value={currentValue === undefined ? '' : encode(currentValue)}
        onValueChange={(next) => {
          const decoded = next.slice('value:'.length);
          setInternalValue(decoded);
          onValueChange?.(decoded);
        }}
      >
        {children}
      </Primitive.Root>
      {name && <input type="hidden" name={name} value={currentValue ?? ''} disabled={props.disabled} />}
    </SelectContext.Provider>
  );
}

export const SelectValue = Primitive.Value;
export const SelectGroup = Primitive.Group;
export const SelectLabel = Primitive.Label;
export const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof Primitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof Primitive.Trigger>
>(function SelectTrigger({ children, className, ...props }, ref) {
  return (
    <Primitive.Trigger
      ref={ref}
      className={cn(
        'appliance-ui flex h-9 w-full items-center justify-between gap-2 rounded-md border border-[var(--color-border)] bg-transparent px-3 text-sm text-[var(--color-foreground)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-background)] disabled:cursor-not-allowed disabled:opacity-50 [&>span:first-child]:truncate',
        className
      )}
      {...props}
    >
      {children}
      <Primitive.Icon asChild>
        <ChevronDown className="size-4 shrink-0 text-[var(--color-muted-foreground)]" aria-hidden="true" />
      </Primitive.Icon>
    </Primitive.Trigger>
  );
});

export const SelectContent = React.forwardRef<
  React.ElementRef<typeof Primitive.Content>,
  React.ComponentPropsWithoutRef<typeof Primitive.Content>
>(function SelectContent({ children, className, sideOffset = 4, collisionPadding = 8, ...props }, ref) {
  const { open } = React.useContext(SelectContext);
  const { immediate } = useTransition();
  return (
    <Primitive.Portal>
      <Primitive.Content
        {...props}
        ref={ref}
        asChild
        position="popper"
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        data-immediate={immediate || undefined}
        className={cn(
          'appliance-ui ui-overlay-fast z-50 max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface-overlay)] p-1 text-sm text-[var(--color-foreground)] shadow-lg outline-none',
          className
        )}
      >
        <m.div
          initial={immediate ? false : { opacity: 0 }}
          animate={{ opacity: open ? 1 : 0 }}
          transition={selectTransition(immediate, 'fast', open ? 'enter' : 'exit')}
        >
          <Primitive.ScrollUpButton className="flex justify-center py-1">
            <ChevronUp className="size-4" />
          </Primitive.ScrollUpButton>
          <Primitive.Viewport>{children}</Primitive.Viewport>
          <Primitive.ScrollDownButton className="flex justify-center py-1">
            <ChevronDown className="size-4" />
          </Primitive.ScrollDownButton>
        </m.div>
      </Primitive.Content>
    </Primitive.Portal>
  );
});

export const SelectItem = React.forwardRef<
  React.ElementRef<typeof Primitive.Item>,
  React.ComponentPropsWithoutRef<typeof Primitive.Item>
>(function SelectItem({ value, children, className, ...props }, ref) {
  return (
    <Primitive.Item
      {...props}
      ref={ref}
      value={encode(value)}
      className={cn(
        'relative flex select-none items-center rounded-sm py-1.5 pl-2 pr-8 text-sm outline-none data-[highlighted]:bg-[var(--color-hover)] data-[state=checked]:font-medium data-[disabled]:pointer-events-none data-[disabled]:text-[var(--color-muted-foreground)]',
        className
      )}
    >
      <Primitive.ItemText>{children}</Primitive.ItemText>
      <Primitive.ItemIndicator className="absolute right-2 flex items-center">
        <Check className="size-4" aria-hidden="true" />
      </Primitive.ItemIndicator>
    </Primitive.Item>
  );
});
