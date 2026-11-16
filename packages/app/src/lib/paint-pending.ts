import { flushSync } from 'react-dom';

/** Commit existing pending feedback, then give the visible document a paint opportunity.
 * A promise/microtask or a single rAF resumes before paint. The second frame keeps
 * synchronous bridge setup off the acknowledgment frame. Hidden documents cannot
 * paint and may suspend rAF; let their work continue without claiming visible feedback.
 * Call only from user actions, never while rendering or in a React effect.
 */
export function paintPending(update: () => void): Promise<void> {
  flushSync(update);
  return afterPendingPaint();
}

/** Yield after an externally owned pending-state notification (query mutation/effect). */
export function afterPendingPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (document.visibilityState === 'hidden') {
      setTimeout(resolve, 0);
      return;
    }
    let frame = 0;
    const finish = () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      resolve();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') finish();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(finish);
    });
  });
}
