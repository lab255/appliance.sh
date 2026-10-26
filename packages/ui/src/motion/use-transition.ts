'use client';

import { useReducedMotion } from 'motion/react';
import { useSyncExternalStore } from 'react';
import { useMotionReady } from '../motion-provider.js';
import { motionTokens } from './tokens.js';

const query = '(prefers-reduced-motion: reduce)';
const subscribe = (notify: () => void) => {
  if (!window.matchMedia) return () => {};
  const media = window.matchMedia(query);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
};
const snapshot = () => window.matchMedia?.(query).matches ?? true;
const serverSnapshot = (): boolean | null => null;

export function selectTransition(
  immediate: boolean,
  speed: 'fast' | 'base' | 'slow' = 'base',
  phase: 'enter' | 'exit' = 'enter'
) {
  if (immediate) return { type: 'tween' as const, duration: 0 };
  const { exit, ...enter } = motionTokens[speed];
  return phase === 'exit' ? { ...exit } : enter;
}

export function useTransition() {
  const reduced = useReducedMotion();
  // Also subscribe explicitly: preference changes must update existing wrappers.
  const preference = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const ready = useMotionReady();
  const immediate = !ready || (preference ?? reduced ?? true);
  return {
    immediate,
    transition: selectTransition(immediate),
    exitTransition: selectTransition(immediate, 'base', 'exit'),
  };
}
