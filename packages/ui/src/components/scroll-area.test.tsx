// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LogPane } from './log-pane.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('follows appended logs only at the tail and forwards the actual viewport ref and scroll event', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  const ref = React.createRef<HTMLDivElement>();
  const onScroll = vi.fn();
  const pane = (text: string) => (
    <LogPane open viewportRef={ref} onViewportScroll={onScroll} copyText={text}>
      {text}
    </LogPane>
  );
  const { rerender } = render(pane('first'));
  const viewport = screen.getByRole('log');
  expect(ref.current).toBe(viewport);
  expect(viewport.hasAttribute('data-radix-scroll-area-viewport')).toBe(true);
  let contentHeight = 1000;
  Object.defineProperties(viewport, {
    scrollHeight: { get: () => contentHeight },
    clientHeight: { get: () => 288 },
  });
  rerender(pane('first\nsecond'));
  expect(viewport.scrollTop).toBe(1000);
  viewport.scrollTop = 120;
  fireEvent.scroll(viewport);
  expect(onScroll).toHaveBeenCalledOnce();
  contentHeight = 1200;
  rerender(pane('first\nsecond\nthird'));
  expect(viewport.scrollTop).toBe(120);
  expect(ref.current).toBe(viewport);
  viewport.scrollTop = contentHeight - 288;
  fireEvent.scroll(viewport);
  contentHeight = 1400;
  rerender(pane('first\nsecond\nthird\nfourth'));
  expect(viewport.scrollTop).toBe(1400);
  expect(screen.getByRole('button', { name: 'Copy log' })).toBeTruthy();
});
