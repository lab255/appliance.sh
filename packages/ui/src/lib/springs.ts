// Motion tokens. Each tier's value is the ENTER transition — a critically
// damped spring, except the largest tier which keeps a little bounce. Its
// `.exit` is the matching EXIT transition — a plain tween, no bounce, explicitly
// shorter — so a dismissal reads as crisp and final rather than replaying the
// entrance in reverse.
//
//   transition={spring.fast}                              // enter
//   exit={{ opacity: 0, transition: spring.fast.exit }}   // leave
//
// The bigger the thing that moves, the slower the spring. Never hand-write a
// duration — always reach for a tier.
// JS-lane source of truth. CSS duration parity is checked at build time;
// CSS eases stay in theme.css and are never substituted for these springs.
export const spring = {
  fast: {
    type: 'spring',
    duration: 0.08,
    bounce: 0,
    exit: { type: 'tween', duration: 0.06 },
  },
  moderate: {
    type: 'spring',
    duration: 0.16,
    bounce: 0,
    exit: { type: 'tween', duration: 0.12 },
  },
  slow: {
    type: 'spring',
    duration: 0.24,
    bounce: 0.12,
    exit: { type: 'tween', duration: 0.16 },
  },
} as const;

// Fallback delay (ms) for deferred-unmount timers that guard an exit tween:
// popups keep their portal mounted until onAnimationComplete fires, but a
// throttled/background tab can stall the animation, so a timer force-unmounts
// after the tier's exit duration plus a safety buffer. Deriving it here keeps
// the timers in step with the tokens above.
export const exitFallbackMs = (tier: { exit: { duration: number } }) =>
  Math.round(tier.exit.duration * 1000) + 100;
