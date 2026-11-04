import type { CSSProperties } from 'react';
import { selectTransition, useTransition } from '../motion/use-transition.js';

export const selectionControlClassName =
  'appliance-ui shrink-0 inline-flex items-center justify-center border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-primary-foreground)] hover:border-[var(--color-primary)] active:translate-y-px active:bg-[var(--color-active)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-background)] disabled:cursor-not-allowed disabled:text-[var(--color-muted-foreground)] disabled:border-[var(--color-border)]';

/** State colours and press feedback are immediate; only the mark/thumb moves. */
export function useSelectionMotion(): CSSProperties {
  const { immediate } = useTransition();
  return {
    '--selection-enter': `${selectTransition(immediate, 'fast').duration}s`,
    '--selection-exit': `${selectTransition(immediate, 'fast', 'exit').duration}s`,
  } as CSSProperties;
}
