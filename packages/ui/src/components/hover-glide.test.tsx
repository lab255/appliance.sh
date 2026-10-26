// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPortal } from 'react-dom';
import { domAnimation, LazyMotion } from 'motion/react';
import { HoverGlide } from './hover-glide.js';

let immediate = false;
vi.mock('../motion/use-transition.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useTransition: () => ({ immediate }),
}));
beforeEach(() => {
  immediate = false;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function List() {
  return (
    <LazyMotion features={domAnimation}>
      <HoverGlide as="ul">
        <li data-hover-glide-item="" data-testid="first">
          First
        </li>
        <li data-hover-glide-item="" data-testid="second">
          Second
        </li>
        <li data-hover-glide-item="" aria-current="page" data-testid="active">
          Active
        </li>
        <li data-hover-glide-item="" aria-disabled="true" data-testid="disabled">
          Disabled
        </li>
        {createPortal(<button data-testid="portal">Portal</button>, document.body)}
      </HoverGlide>
    </LazyMotion>
  );
}

it('moves one highlight across rows, ignores portals, and exits on pointer leave', async () => {
  const view = render(<List />);
  fireEvent.pointerMove(view.getByTestId('first'));
  const highlight = view.container.querySelector('[data-hover-glide-highlight]');
  expect(highlight).not.toBeNull();
  fireEvent.pointerMove(view.getByTestId('second'));
  expect(view.container.querySelectorAll('[data-hover-glide-highlight]')).toHaveLength(1);
  expect(view.container.querySelector('[data-hover-glide-highlight]')).toBe(highlight);
  fireEvent.pointerMove(view.getByTestId('portal'));
  expect(view.container.querySelector('[data-hover-glide-highlight]')).toBe(highlight);
  fireEvent.pointerLeave(view.container.querySelector('ul')!);
  await waitFor(() => expect(view.container.querySelector('[data-hover-glide-highlight]')).toBeNull());
});

it('keeps active routes and disabled rows free of the hover layer', () => {
  const view = render(<List />);
  fireEvent.pointerMove(view.getByTestId('active'));
  expect(view.container.querySelector('[data-hover-glide-highlight]')).toBeNull();
  fireEvent.pointerMove(view.getByTestId('disabled'));
  expect(view.container.querySelector('[data-hover-glide-highlight]')).toBeNull();
});

it('removes the layer immediately when reduced motion changes, including a pending exit', () => {
  const view = render(<List />);
  fireEvent.pointerMove(view.getByTestId('first'));
  fireEvent.pointerLeave(view.container.querySelector('ul')!);
  immediate = true;
  view.rerender(<List />);
  expect(view.container.querySelector('[data-hover-glide-highlight]')).toBeNull();
  expect(view.container.querySelector('ul')?.dataset.hoverGlide).toBe('immediate');
  fireEvent.pointerMove(view.getByTestId('second'));
  expect(view.container.querySelector('[data-hover-glide-highlight]')).toBeNull();
});
