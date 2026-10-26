import { cn } from '../lib/utils.js';

/** Reserves the selected weight's width; one string owns both rendered copies. */
export function WeightLabel({
  children,
  active,
  className,
}: {
  children: string;
  active: boolean;
  className?: string;
}) {
  return (
    <span className={cn('weight-label', className)} data-active={active}>
      <span className="weight-label-ghost" aria-hidden="true">
        {children}
      </span>
      <span className="weight-label-text">{children}</span>
    </span>
  );
}
