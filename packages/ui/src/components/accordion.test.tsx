// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from './accordion.js';
import { MotionProvider } from '../motion-provider.js';

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 120 } as DOMRect);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function Items() {
  return (
    <>
      {['One', 'Two', 'Three'].map((value) => (
        <AccordionItem key={value} value={value} disabled={value === 'Two'}>
          <AccordionTrigger>{value}</AccordionTrigger>
          <AccordionContent>
            <button>{value} detail</button>
          </AccordionContent>
        </AccordionItem>
      ))}
    </>
  );
}
it('supports keyboard navigation, skips disabled items and hides closed content from focus and accessibility', async () => {
  const user = userEvent.setup();
  render(
    <Accordion type="single" collapsible>
      <Items />
    </Accordion>
  );
  const first = screen.getByRole('button', { name: 'One' });
  first.focus();
  await user.keyboard('{ArrowDown}');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Three' }));
  await user.keyboard('{Home}{Enter}');
  expect(first.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('button', { name: 'One detail' })).toBeTruthy();
  await user.keyboard('{Enter}');
  expect(screen.queryByRole('button', { name: 'One detail' })).toBeNull();
  expect(screen.getByText('One detail').closest('[inert]')).toBeTruthy();
});
it('supports independent multiple items and authoritative controlled values', () => {
  const change = vi.fn();
  const { rerender } = render(
    <Accordion type="multiple" value={['One']} onValueChange={change}>
      <Items />
    </Accordion>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Three' }));
  expect(change).toHaveBeenCalledWith(['One', 'Three']);
  expect(screen.queryByRole('button', { name: 'Three detail' })).toBeNull();
  rerender(
    <Accordion type="multiple" value={['One', 'Three']} onValueChange={change}>
      <Items />
    </Accordion>
  );
  expect(screen.getByRole('button', { name: 'Three detail' })).toBeTruthy();
});
it('reverses a partial entrance and reopens the same measured-height node during exit', async () => {
  render(
    <MotionProvider>
      <Accordion type="single" collapsible>
        <Items />
      </Accordion>
    </MotionProvider>
  );
  const trigger = screen.getByRole('button', { name: 'One' });
  const panel = screen.getByText('One detail').closest('[data-accordion-height]') as HTMLElement;
  await waitFor(() => expect(panel.dataset.immediate).toBeUndefined());
  const height = () => parseFloat(panel.style.height);
  // Keep the production transitions and RAF driver, but advance animation time
  // explicitly so a busy CI worker cannot skip the entire partial-height window.
  let now = performance.now();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const frames = async (count: number) => {
    for (let i = 0; i < count; i++) {
      now += 16;
      await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    }
  };
  fireEvent.click(trigger);
  await frames(4);
  const midEnter = height();
  expect(midEnter).toBeGreaterThan(0);
  expect(midEnter).toBeLessThan(120);
  fireEvent.click(trigger);
  expect(height()).toBe(midEnter);
  await frames(2);
  const midExit = height();
  expect(midExit).toBeGreaterThan(0);
  expect(midExit).toBeLessThan(midEnter);
  fireEvent.click(trigger);
  expect(height()).toBe(midExit);
  expect(screen.getByText('One detail').closest('[data-accordion-height]')).toBe(panel);
  await frames(30);
  expect(height()).toBe(120);
  expect(panel.style.filter).toBe('');
  expect(panel.style.transform).toBe('');
  fireEvent.click(trigger);
  await frames(10);
  expect(height()).toBe(0);
});
it('settles immediately with reduced motion', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  render(
    <MotionProvider>
      <Accordion type="single" collapsible>
        <Items />
      </Accordion>
    </MotionProvider>
  );
  const panel = screen.getByText('One detail').closest('[data-accordion-height]') as HTMLElement;
  fireEvent.click(screen.getByRole('button', { name: 'One' }));
  expect(panel.style.height).toBe('auto');
  expect(panel.dataset.immediate).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'One' }));
  expect(panel.style.height).toBe('0px');
});

it('keeps default-open content readable before motion features are available', () => {
  render(
    <Accordion type="single" defaultValue="One" collapsible>
      <Items />
    </Accordion>
  );
  const panel = screen.getByRole('button', { name: 'One detail' }).closest('[data-accordion-height]') as HTMLElement;
  expect(panel.style.height).toBe('auto');
  expect(panel.dataset.immediate).toBe('true');
});
