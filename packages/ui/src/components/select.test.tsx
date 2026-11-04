// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MotionProvider } from '../motion-provider.js';
import { useTransition } from '../motion/use-transition.js';
import userEvent from '@testing-library/user-event';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select.js';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});
afterEach(cleanup);
function Example({ disabled = false, onChange = vi.fn() }) {
  const [value, setValue] = React.useState('');
  return (
    <form aria-label="Setup">
      <label htmlFor="profile">AWS profile</label>
      <Select
        name="profile"
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          setValue(next);
          onChange(next);
        }}
      >
        <SelectTrigger id="profile">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">Shell environment</SelectItem>
          <SelectItem value="default">Default</SelectItem>
          <SelectItem value="unavailable" disabled>
            Unavailable
          </SelectItem>
          <SelectItem value="work-sso">Work SSO</SelectItem>
        </SelectContent>
      </Select>
    </form>
  );
}

describe('Select', () => {
  it('labels the trigger, selects with Enter, and preserves raw form values including empty', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Example onChange={onChange} />);
    const trigger = screen.getByRole('combobox', { name: 'AWS profile' });
    const form = screen.getByRole('form') as HTMLFormElement;
    expect(new FormData(form).get('profile')).toBe('');
    trigger.focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('listbox');
    await user.keyboard('{End}{Enter}');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(trigger.textContent).toContain('Work SSO');
    expect(onChange).toHaveBeenLastCalledWith('work-sso');
    expect(new FormData(form).get('profile')).toBe('work-sso');
    await user.keyboard('{Enter}{Home}{Enter}');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(onChange).toHaveBeenLastCalledWith('');
    expect(new FormData(form).get('profile')).toBe('');
  });

  it('supports arrows, skips disabled items, and Escape restores focus without changing selection', async () => {
    const user = userEvent.setup();
    render(<Example />);
    const trigger = screen.getByRole('combobox');
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    await screen.findByRole('listbox');
    await user.keyboard('{Home}{ArrowDown}{ArrowDown}');
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Work SSO'));
    await user.keyboard('{ArrowUp}');
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Default'));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(trigger.textContent).toContain('Shell environment');
  });

  it('supports typeahead and pointer selection', async () => {
    const user = userEvent.setup();
    render(<Example />);
    screen.getByRole('combobox').focus();
    await user.keyboard('{Enter}w');
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Work SSO'));
    await user.click(screen.getByRole('option', { name: 'Default', exact: true }));
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(screen.getByRole('combobox').textContent).toContain('Default');
  });

  it('prevents disabled selection and omits its form value', async () => {
    const user = userEvent.setup();
    render(<Example disabled />);
    await user.click(screen.getByRole('combobox'));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(new FormData(screen.getByRole('form') as HTMLFormElement).has('profile')).toBe(false);
  });
});

describe('Select lifetime', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([false, true])(
    'uses fast exit or immediate reduced motion and supports controlled reopen (reduced=%s)',
    async (reduced) => {
      vi.stubGlobal('matchMedia', (media: string) => ({
        matches: reduced,
        media,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
      }));
      let updateOpen!: React.Dispatch<React.SetStateAction<boolean>>;
      function Harness() {
        const [open, setOpen] = React.useState(false);
        updateOpen = setOpen;
        const { immediate } = useTransition();
        return (
          <Select open={open} onOpenChange={setOpen} defaultValue="a">
            <SelectTrigger data-immediate={String(immediate)}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="a">Alpha</SelectItem>
            </SelectContent>
          </Select>
        );
      }
      render(
        <MotionProvider>
          <Harness />
        </MotionProvider>
      );
      const trigger = screen.getByRole('combobox');
      await waitFor(() => expect(trigger.dataset.immediate).toBe(String(reduced)));
      act(() => updateOpen(true));
      const content = await screen.findByRole('listbox');
      if (!reduced) await waitFor(() => expect(Number(content.style.opacity)).toBeGreaterThan(0.95));
      fireEvent.keyDown(content, { key: 'Escape' });
      if (reduced) {
        expect(screen.queryByRole('listbox')).toBeNull();
      } else {
        expect(content.isConnected).toBe(true);
        act(() => updateOpen(true));
        await waitFor(() => expect(Number(content.style.opacity)).toBeGreaterThan(0.95));
        expect(screen.getByRole('listbox')).toBe(content);
        fireEvent.keyDown(content, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
      }
      await waitFor(() => expect(document.activeElement).toBe(trigger));
      expect(document.body.style.pointerEvents).toBe('');
    }
  );
});
