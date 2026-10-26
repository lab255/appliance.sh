import * as React from 'react';
import * as m from 'motion/react-m';
import type { MotionProps } from 'motion/react';

/** Keep native DOM callbacks separate from Motion's gesture/animation props. */
export function createOverlayMotion<P extends { style?: React.CSSProperties; children?: React.ReactNode }>(
  Primitive: React.ComponentType<P>
): React.ComponentType<
  { primitiveProps?: P & { 'data-immediate'?: true } } & MotionProps & React.RefAttributes<HTMLDivElement>
> {
  return m.create(
    React.forwardRef<HTMLDivElement, { primitiveProps: P & { 'data-immediate'?: true }; style?: React.CSSProperties }>(
      ({ primitiveProps, style, ...animationProps }, ref) => (
        <Primitive
          {...primitiveProps}
          {...animationProps}
          style={{ ...primitiveProps.style, ...style }}
          ref={ref}
          children={primitiveProps.children}
        />
      )
    )
  );
}

/** Mirror Radix's controlled/uncontrolled open contract for presence ownership. */
export function useOverlayState({
  open,
  defaultOpen = false,
  onOpenChange,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internal, setInternal] = React.useState(defaultOpen);
  return {
    open: open ?? internal,
    onOpenChange: (next: boolean) => {
      if (open === undefined) setInternal(next);
      onOpenChange?.(next);
    },
  };
}
