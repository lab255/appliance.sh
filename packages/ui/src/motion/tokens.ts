import { spring } from '../lib/springs.js';

// JS tiers alias the FF source; "base" is our name for FF's "moderate".
// CSS durations/eases remain in theme.css, checked by generate-motion.mjs.
export const motionTokens = {
  fast: spring.fast,
  base: spring.moderate,
  slow: spring.slow,
} as const;
