'use client';

import type { ReactNode } from 'react';
import * as m from 'motion/react-m';
import { AnimatePresence, useIsPresent } from 'motion/react';
import { selectTransition, useTransition } from '../motion/use-transition.js';

function Layer({ children, immediate }: { children: ReactNode; immediate: boolean }) {
  const present = useIsPresent();
  return (
    <m.div
      className="col-start-1 row-start-1"
      inert={!present}
      aria-hidden={!present || undefined}
      initial={immediate ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={immediate ? undefined : { opacity: 0 }}
      transition={selectTransition(immediate, 'base', true)}
    >
      {children}
    </m.div>
  );
}

/** Crossfade only when loading changes, never on content/polling updates. */
export function SkeletonSwap({
  loading,
  fallback,
  children,
  className,
}: {
  loading: boolean;
  fallback: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const { immediate } = useTransition();
  return (
    <div className={['appliance-ui grid', className].filter(Boolean).join(' ')} aria-busy={loading}>
      <AnimatePresence initial={false}>
        <Layer key={loading ? 'loading' : 'content'} immediate={immediate}>
          {loading ? fallback : children}
        </Layer>
      </AnimatePresence>
    </div>
  );
}
