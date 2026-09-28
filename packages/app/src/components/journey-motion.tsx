import * as React from 'react';
import { AnimatePresence, usePresence, usePresenceData, useReducedMotion } from 'motion/react';
import * as m from 'motion/react-m';
import { flushSync } from 'react-dom';
import { useNavigate, type NavigateOptions, type To } from 'react-router';
import { useMotionReady } from '@appliance.sh/ui/motion-provider';
import './journey-motion.css';

const subscribe = (notify: () => void) => {
  const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  media?.addEventListener('change', notify);
  return () => media?.removeEventListener('change', notify);
};
const snapshot = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? null;

export function useJourneyImmediate() {
  const reduced = useReducedMotion();
  const preference = React.useSyncExternalStore(subscribe, snapshot, () => true);
  const ready = useMotionReady();
  return !ready || (preference ?? reduced ?? true);
}

/** CSS owns token timing; presence only retains the outgoing, inert surface. */
export function JourneySwap({
  children,
  step,
  direction = 1,
}: {
  children: React.ReactNode;
  step: string;
  direction?: number;
}) {
  return (
    <div className="journey-stack">
      <AnimatePresence initial={false} custom={direction}>
        <JourneyFrame key={step} direction={direction}>
          {children}
        </JourneyFrame>
      </AnimatePresence>
    </div>
  );
}

function JourneyFrame({ children, direction }: { children: React.ReactNode; direction: number }) {
  const immediate = useJourneyImmediate();
  const [present, remove] = usePresence();
  const exitDirection = usePresenceData() as number;
  React.useEffect(() => {
    if (!present && immediate) remove?.();
  }, [present, immediate, remove]);
  return (
    <m.div
      className="journey-frame"
      data-present={present}
      data-immediate={immediate}
      inert={!present}
      aria-hidden={!present || undefined}
      style={{ '--journey-offset': `${(present ? direction : exitDirection) * 12}px` } as React.CSSProperties}
      initial={false}
      onAnimationEnd={(event) => {
        // Only visual cleanup; navigation and focus have already happened.
        if (event.target === event.currentTarget && !present) remove?.();
      }}
    >
      {children}
    </m.div>
  );
}

export function JourneyReveal({
  children,
  order = 0,
  className = '',
}: {
  children: React.ReactNode;
  order?: number;
  className?: string;
}) {
  const immediate = useJourneyImmediate();
  return (
    <div
      className={`journey-reveal ${className}`}
      data-immediate={immediate}
      style={{ '--journey-order': order } as React.CSSProperties}
    >
      {children}
    </div>
  );
}

/** Stable key: polls and rerenders cannot replay the hosting acknowledgement. */
export function HostingStatus({ on, children }: { on: boolean; children: React.ReactNode }) {
  const immediate = useJourneyImmediate();
  const previous = React.useRef(on);
  const [revision, setRevision] = React.useState(0);
  React.useEffect(() => {
    if (on && !previous.current) setRevision((value) => value + 1);
    previous.current = on;
  }, [on]);
  return (
    <span role="status" aria-live="polite" aria-atomic="true">
      <span
        key={revision}
        className={
          revision > 0 && on ? 'journey-hosting inline-flex items-center gap-2' : 'inline-flex items-center gap-2'
        }
        data-immediate={immediate}
      >
        {children}
      </span>
    </span>
  );
}

/** Snapshot crossfade across route owners, without retaining running operations. */
export function useJourneyNavigate() {
  const navigate = useNavigate();
  const immediate = useJourneyImmediate();
  return React.useCallback(
    (to: To, options?: NavigateOptions) => {
      if (immediate || !document.startViewTransition) return navigate(to, options);
      document.documentElement.classList.add('journey-handoff');
      const transition = document.startViewTransition(() => {
        flushSync(() => {
          void navigate(to, { ...options, flushSync: true });
        });
      });
      void transition.finished
        .catch(() => {})
        .finally(() => {
          document.documentElement.classList.remove('journey-handoff');
        });
    },
    [navigate, immediate]
  );
}
