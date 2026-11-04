// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs.js';

beforeEach(() => {
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

function Example({ value, disabled = false }: { value?: string; disabled?: boolean }) {
  return (
    <Tabs defaultValue="one" value={value}>
      <TabsList aria-label="Example">
        <TabsTrigger value="one">One</TabsTrigger>
        <TabsTrigger value="two" disabled={disabled}>
          Two
        </TabsTrigger>
        <TabsTrigger value="three">Three</TabsTrigger>
      </TabsList>
      <TabsContent value="one">First panel</TabsContent>
      <TabsContent value="two">Second panel</TabsContent>
      <TabsContent value="three">Third panel</TabsContent>
    </Tabs>
  );
}

it('roves with arrows, wraps, supports Home/End and skips disabled triggers', async () => {
  const user = userEvent.setup();
  render(<Example disabled />);
  await user.tab();
  const one = screen.getByRole('tab', { name: 'One' });
  const three = screen.getByRole('tab', { name: 'Three' });
  expect(document.activeElement).toBe(one);
  for (const [key, target] of [
    ['{ArrowRight}', three],
    ['{ArrowRight}', one],
    ['{ArrowLeft}', three],
    ['{Home}', one],
    ['{End}', three],
  ] as const) {
    await user.keyboard(key);
    await waitFor(() => expect(document.activeElement).toBe(target));
    expect(target.getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByRole('tab').filter((t) => t.tabIndex === 0)).toEqual([target]);
  }
});

it('wires unique trigger/panel IDs across instances and focuses the active panel', async () => {
  const user = userEvent.setup();
  render(
    <>
      <Example />
      <Example />
    </>
  );
  const triggers = screen.getAllByRole('tab');
  expect(new Set(triggers.map((t) => t.id)).size).toBe(6);
  const panel = screen.getAllByRole('tabpanel')[0];
  expect(triggers[0].getAttribute('aria-controls')).toBe(panel.id);
  expect(panel.getAttribute('aria-labelledby')).toBe(triggers[0].id);
  await user.tab();
  await user.tab();
  expect(document.activeElement).toBe(panel);
});

it('keeps controlled selection authoritative through a disabled-state fallback and restoration', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Example value="two" />);
  expect(screen.getByRole('tabpanel').textContent).toBe('Second panel');
  rerender(<Example value="one" disabled />);
  await user.click(screen.getByRole('tab', { name: 'Two' }));
  expect(screen.getByRole('tabpanel').textContent).toBe('First panel');
  rerender(<Example value="two" />);
  expect(screen.getByRole('tabpanel').textContent).toBe('Second panel');
});
