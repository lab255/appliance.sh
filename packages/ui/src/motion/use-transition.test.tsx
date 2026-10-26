// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MotionProvider } from '../motion-provider.js';
import { useTransition } from './use-transition.js';

afterEach(() => vi.unstubAllGlobals());

it('returns springs and exit tweens after readiness, then becomes immediate on preference change', async () => {
  let reduced = false;
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return reduced;
    },
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  const { result, unmount } = renderHook(useTransition, { wrapper: MotionProvider });
  try {
    expect(result.current.transition.duration).toBe(0);
    expect(result.current.exitTransition.duration).toBe(0);
    await waitFor(() => expect(result.current.immediate).toBe(false));
    expect(result.current.transition.type).toBe('spring');
    expect(result.current.transition).toEqual({ type: 'spring', duration: 0.16, bounce: 0 });
    expect(result.current.exitTransition).toEqual({ type: 'tween', duration: 0.12 });
    act(() => {
      reduced = true;
      listeners.forEach((listener) => listener());
    });
    expect(result.current.immediate).toBe(true);
    expect(result.current.transition).toEqual({ type: 'tween', duration: 0 });
    expect(result.current.exitTransition).toEqual({ type: 'tween', duration: 0 });
  } finally {
    unmount();
  }
});
