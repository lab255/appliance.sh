// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IconTooltip } from './tooltip.js';

afterEach(cleanup);

it('names the control and exposes the same changing label on keyboard focus without losing ref or click', async () => {
  const user = userEvent.setup();
  const ref = React.createRef<HTMLButtonElement>();
  const onClick = vi.fn();
  const control = (label: string) => (
    <IconTooltip label={label}>
      <button ref={ref} onClick={onClick}>
        <svg aria-hidden="true" />
      </button>
    </IconTooltip>
  );
  const { rerender } = render(control('Copy command'));
  await user.tab();
  expect(document.activeElement).toBe(ref.current);
  expect((await screen.findByRole('tooltip')).textContent).toBe('Copy command');
  await user.keyboard('{Enter}');
  expect(onClick).toHaveBeenCalledTimes(1);
  rerender(control('Copied'));
  expect(screen.getByRole('button', { name: 'Copied' })).toBe(ref.current);
  await user.tab();
  await user.tab({ shift: true });
  expect((await screen.findByRole('tooltip')).textContent).toBe('Copied');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
});

it('shows a hover hint and preserves native disabled behavior', async () => {
  const user = userEvent.setup();
  const onClick = vi.fn();
  const { rerender } = render(
    <IconTooltip label="Refresh workloads">
      <button onClick={onClick}>
        <svg aria-hidden="true" />
      </button>
    </IconTooltip>
  );
  const trigger = screen.getByRole('button', { name: 'Refresh workloads' });
  await user.hover(trigger);
  expect((await screen.findByRole('tooltip')).textContent).toBe('Refresh workloads');
  await user.unhover(trigger);
  rerender(
    <IconTooltip label="Refresh workloads">
      <button disabled onClick={onClick}>
        <svg aria-hidden="true" />
      </button>
    </IconTooltip>
  );
  expect((trigger as HTMLButtonElement).disabled).toBe(true);
  await user.click(trigger);
  expect(onClick).not.toHaveBeenCalled();
});
