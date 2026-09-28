'use client';

import { useReducedMotion } from 'motion/react';
import { useSyncExternalStore } from 'react';
import { useMotionReady } from '../motion-provider.js';
import { motionTokens } from './tokens.js';

const query = '(prefers-reduced-motion: reduce)';
const subscribe = (notify: () => void) => {
  const media = window.matchMedia(query);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
};
const snapshot = () => window.matchMedia(query).matches;
const serverSnapshot = () => true;

export function selectTransition(immediate: boolean, speed: 'fast' | 'base' | 'slow' = 'base', crossfade = false) {
  return {
    duration: immediate ? 0 : motionTokens[speed],
    ease: [...(crossfade ? motionTokens.inOut : motionTokens.outQuart)] as [number, number, number, number],
  };
}

export function useTransition() {
  const reduced = useReducedMotion();
  // Also subscribe explicitly: preference changes must update existing wrappers.
  const preference = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const ready = useMotionReady();
  const immediate = !ready || preference || reduced === true;
  return { immediate, transition: selectTransition(immediate), exitTransition: selectTransition(immediate, 'fast') };
}
