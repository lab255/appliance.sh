'use client';

import * as React from 'react';
import * as Primitive from '@radix-ui/react-accordion';
import * as m from 'motion/react-m';
import { ChevronDown } from 'lucide-react';
import { cn } from '../lib/utils.js';
import { selectTransition, useTransition } from '../motion/use-transition.js';

const ValuesContext = React.createContext<string[]>([]);
const ItemContext = React.createContext(false);

export function Accordion(props: React.ComponentProps<typeof Primitive.Root>) {
  const [internal, setInternal] = React.useState(props.defaultValue);
  const value = props.value ?? internal;
  const values = typeof value === 'string' ? [value] : (value ?? []);
  return (
    <ValuesContext.Provider value={values}>
      {props.type === 'single' ? (
        <Primitive.Root
          {...props}
          value={typeof value === 'string' ? value : ''}
          onValueChange={(next: string) => {
            if (props.value === undefined) setInternal(next);
            props.onValueChange?.(next);
          }}
        />
      ) : (
        <Primitive.Root
          {...props}
          value={values}
          onValueChange={(next: string[]) => {
            if (props.value === undefined) setInternal(next);
            props.onValueChange?.(next);
          }}
        />
      )}
    </ValuesContext.Provider>
  );
}

export const AccordionItem = React.forwardRef<
  React.ElementRef<typeof Primitive.Item>,
  React.ComponentPropsWithoutRef<typeof Primitive.Item>
>(function AccordionItem({ value, ...props }, ref) {
  const values = React.useContext(ValuesContext);
  return (
    <ItemContext.Provider value={values.includes(value)}>
      <Primitive.Item {...props} value={value} ref={ref} />
    </ItemContext.Provider>
  );
});

export const AccordionTrigger = React.forwardRef<
  React.ElementRef<typeof Primitive.Trigger>,
  Omit<React.ComponentPropsWithoutRef<typeof Primitive.Trigger>, 'asChild'>
>(function AccordionTrigger({ children, className, ...props }, ref) {
  return (
    <Primitive.Header>
      <Primitive.Trigger
        {...props}
        ref={ref}
        className={cn(
          'group flex w-full items-center justify-between gap-2 rounded-sm py-1 text-left text-xs font-medium text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] disabled:cursor-not-allowed',
          className
        )}
      >
        {children}
        <ChevronDown aria-hidden className="h-3.5 w-3.5 shrink-0 group-data-[state=open]:rotate-180" />
      </Primitive.Trigger>
    </Primitive.Header>
  );
});

export type AccordionContentProps = Omit<
  React.ComponentPropsWithoutRef<typeof Primitive.Content>,
  'asChild' | 'forceMount'
>;
export const AccordionContent = React.forwardRef<React.ElementRef<typeof Primitive.Content>, AccordionContentProps>(
  function AccordionContent({ children, className, ...props }, ref) {
    const open = React.useContext(ItemContext);
    const { immediate } = useTransition();
    const inner = React.useRef<HTMLDivElement>(null);
    const [height, setHeight] = React.useState(0);
    // Measure the untransformed inner box, including while the outer box is closed.
    // ResizeObserver also follows wrapping and asynchronous detail updates.
    React.useLayoutEffect(() => {
      const element = inner.current;
      if (!element) return;
      const measure = () => setHeight(element.getBoundingClientRect().height);
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }, []);
    return (
      // Keep one node through interruption; closed details are neither focusable nor announced.
      <Primitive.Content {...props} ref={ref} forceMount className={className} aria-hidden={!open} inert={!open}>
        <m.div
          initial={false}
          animate={immediate ? undefined : { height: open ? height : 0 }}
          transition={selectTransition(immediate, 'base', open ? 'enter' : 'exit')}
          style={{ overflow: 'hidden', ...(immediate ? { height: open ? 'auto' : 0 } : {}) }}
          data-immediate={immediate || undefined}
          data-accordion-height=""
        >
          <div ref={inner} className="flow-root">
            {children}
          </div>
        </m.div>
      </Primitive.Content>
    );
  }
);
