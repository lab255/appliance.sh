'use client';

import * as React from 'react';

/** How close to the bottom (px) still counts as "reading the tail".
 *  Wider than a line-height so momentum scrolling can't un-pin. */
const PIN_THRESHOLD_PX = 40;

/**
 * Keep a streaming log pane pinned to its tail — but only while the
 * user is already reading the tail. Scrolling up to study an earlier
 * line must not be fought by the stream: new lines re-pin only after
 * the user returns to the bottom. Attach `ref` and `onScroll` to the
 * scrollable element and pass the stream state in `deps`.
 */
export function useTailAutoscroll<T extends HTMLElement>(deps: React.DependencyList) {
  const ref = React.useRef<T | null>(null);
  const pinned = React.useRef(true);

  const onScroll = React.useCallback((event: React.UIEvent<T>) => {
    const el = event.currentTarget;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX;
  }, []);

  // The caller owns the dep list — this hook can't know what drives the
  // stream it tails.
  React.useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, deps);

  return { ref, onScroll };
}
