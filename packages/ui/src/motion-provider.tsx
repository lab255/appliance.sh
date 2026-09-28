'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import { TooltipProvider } from './components/tooltip.js';
import { LazyMotion, MotionConfig } from 'motion/react';

const ReadyContext = createContext(false);
export const useMotionReady = () => useContext(ReadyContext);

/** Content remains immediately readable and actionable while features load. */
export function MotionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [loadFeatures] = useState(
    () => () =>
      import('./motion/features.js').then((module) => {
        setReady(true);
        return module.default;
      })
  );
  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion strict features={loadFeatures}>
        <ReadyContext.Provider value={ready}>
          <TooltipProvider>{children}</TooltipProvider>
        </ReadyContext.Provider>
      </LazyMotion>
    </MotionConfig>
  );
}
