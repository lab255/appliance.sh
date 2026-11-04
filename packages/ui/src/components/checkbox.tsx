'use client';

import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { cn } from '../lib/utils.js';
import { selectionControlClassName, useSelectionMotion } from './selection-control.js';

export type CheckboxProps = React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>;

export const Checkbox = React.forwardRef<React.ElementRef<typeof CheckboxPrimitive.Root>, CheckboxProps>(
  ({ className, style, ...props }, ref) => {
    const motionStyle = useSelectionMotion();
    return (
      <CheckboxPrimitive.Root
        ref={ref}
        className={cn(selectionControlClassName, 'ds-checkbox h-4 w-4 rounded-sm', className)}
        style={{ ...motionStyle, ...style }}
        {...props}
      >
        <CheckboxPrimitive.Indicator forceMount className="flex h-full w-full items-center justify-center">
          <svg
            viewBox="0 0 16 16"
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path className="ds-checkbox-check" d="m3 8 3 3 7-7" pathLength="1" />
            <path className="ds-checkbox-mixed" d="M3 8h10" />
          </svg>
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
    );
  }
);
Checkbox.displayName = 'Checkbox';
