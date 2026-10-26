import { spring } from '../lib/springs.js';

// JS tiers wrap the pristine FF source; "base" is our name for FF's "moderate".
// CSS durations/eases remain in theme.css, checked by generate-motion.mjs.
const tier = <T extends { exit: { duration: number } }>(t: T) =>
  ({ ...t, exit: { type: 'tween', ...t.exit } }) as const;

export const motionTokens = {
  fast: tier(spring.fast),
  base: tier(spring.moderate),
  // No current consumer — first slow consumer needs a design pass.
  slow: tier(spring.slow),
} as const;
