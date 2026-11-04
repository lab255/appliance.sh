// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Checkbox } from './checkbox.js';
import { Switch } from './switch.js';

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
for (const [role, Control] of [
  ['checkbox', Checkbox],
  ['switch', Switch],
] as const) {
  describe(role, () => {
    it('toggles through its wrapping label and keyboard Space without submitting', async () => {
      const user = userEvent.setup();
      let submits = 0;
      render(
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submits++;
          }}
        >
          <label>
            <Control />
            Enable
          </label>
        </form>
      );
      const control = screen.getByRole(role);
      await user.click(screen.getByText('Enable'));
      expect(control.getAttribute('aria-checked')).toBe('true');
      control.focus();
      await user.keyboard(' ');
      expect(control.getAttribute('aria-checked')).toBe('false');
      expect(submits).toBe(0);
    });
    it('honours explicit labels, disabled state, and refs', async () => {
      const user = userEvent.setup();
      const ref = React.createRef<HTMLButtonElement>();
      render(
        <>
          <label htmlFor="toggle">Enable</label>
          <Control id="toggle" ref={ref} disabled />
        </>
      );
      await user.click(screen.getByText('Enable'));
      expect(ref.current).toBe(screen.getByRole(role));
      expect(ref.current?.getAttribute('aria-checked')).toBe('false');
    });
    it('associates with an external form and submits only checked values', async () => {
      const user = userEvent.setup();
      render(
        <>
          <form id="settings" aria-label="Settings" />
          <Control form="settings" name="enabled" value="yes" aria-label="Enable" />
        </>
      );
      const form = screen.getByRole('form') as HTMLFormElement;
      expect(new FormData(form).get('enabled')).toBeNull();
      await user.click(screen.getByRole(role));
      expect(new FormData(form).get('enabled')).toBe('yes');
      await user.click(screen.getByRole(role));
      expect(new FormData(form).get('enabled')).toBeNull();
    });
    it('leaves controlled state authoritative', async () => {
      const user = userEvent.setup();
      const changes: unknown[] = [];
      render(<Control checked={false} onCheckedChange={(value) => changes.push(value)} />);
      await user.click(screen.getByRole(role));
      expect(changes).toEqual([true]);
      expect(screen.getByRole(role).getAttribute('aria-checked')).toBe('false');
    });
  });
}
it('supports an indeterminate checkbox', async () => {
  const user = userEvent.setup();
  render(<Checkbox defaultChecked="indeterminate" />);
  expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('mixed');
  await user.click(screen.getByRole('checkbox'));
  expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('true');
});
