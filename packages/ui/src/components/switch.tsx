'use client';

import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cn } from '../lib/utils.js';
import { selectionControlClassName, useSelectionMotion } from './selection-control.js';

export type SwitchProps = React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>;

export const Switch = React.forwardRef<React.ElementRef<typeof SwitchPrimitive.Root>, SwitchProps>(
  ({ className, style, ...props }, ref) => {
    const motionStyle = useSelectionMotion();
    return (
      <SwitchPrimitive.Root
        ref={ref}
        className={cn(selectionControlClassName, 'ds-switch h-5 w-9 rounded-full', className)}
        style={{ ...motionStyle, ...style }}
        {...props}
      >
        <SwitchPrimitive.Thumb className="ds-switch-thumb h-3.5 w-3.5 rounded-full" />
      </SwitchPrimitive.Root>
    );
  }
);
Switch.displayName = 'Switch';
