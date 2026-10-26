// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dialog, DialogTrigger, DialogContent, DialogTitle } from './dialog.js';
import { ConfirmProvider, useConfirm } from './confirm-dialog.js';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from './dropdown-menu.js';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from './tooltip.js';
import { MotionProvider } from '../motion-provider.js';
import { useTransition } from '../motion/use-transition.js';
import { Popover, PopoverTrigger, PopoverContent } from './popover.js';

afterEach(cleanup);
function ConfirmExample() {
  const confirm = useConfirm();
  const [decision, setDecision] = React.useState('Waiting');
  return (
    <>
      <button
        onClick={async () =>
          setDecision((await confirm({ title: 'Remove target?', description: 'Cannot undo.' })) ? 'Yes' : 'No')
        }
      >
        Remove
      </button>
      <output>{decision}</output>
    </>
  );
}
describe('Overlay design system interactions', () => {
  it('keeps controlled state authoritative and forwards dismissal requests', async () => {
    const user = userEvent.setup();
    const requests: boolean[] = [];
    const { rerender } = render(
      <Dialog open onOpenChange={(open) => requests.push(open)}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Controlled</DialogTitle>
        </DialogContent>
      </Dialog>
    );
    await user.keyboard('{Escape}');
    expect(requests).toEqual([false]);
    expect(screen.getByRole('dialog')).toBeTruthy();
    rerender(
      <Dialog open={false}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Controlled</DialogTitle>
        </DialogContent>
      </Dialog>
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.style.pointerEvents).toBe('');
  });
  it('preserves caller-owned mounting, refs and asChild content', async () => {
    const ref = React.createRef<HTMLDivElement>();
    const { rerender } = render(
      <Popover open={false}>
        <PopoverTrigger>Details</PopoverTrigger>
        <PopoverContent forceMount asChild ref={ref}>
          <div data-testid="custom">Kept mounted</div>
        </PopoverContent>
      </Popover>
    );
    const content = screen.getByTestId('custom');
    expect(ref.current).toBe(content);
    expect(content.dataset.state).toBe('closed');
    rerender(
      <Popover open>
        <PopoverTrigger>Details</PopoverTrigger>
        <PopoverContent forceMount asChild ref={ref}>
          <div data-testid="custom">Kept mounted</div>
        </PopoverContent>
      </Popover>
    );
    expect(screen.getByTestId('custom')).toBe(content);
    expect(content.dataset.state).toBe('open');
  });
  it('supports a non-modal dialog without hiding its content with the scrim', async () => {
    const user = userEvent.setup();
    render(
      <Dialog modal={false}>
        <DialogTrigger>Inspect</DialogTrigger>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Inspection</DialogTitle>
        </DialogContent>
      </Dialog>
    );
    await user.click(screen.getByRole('button', { name: 'Inspect' }));
    expect(screen.getByRole('dialog').textContent).toBe('Inspection');
    expect(screen.getByRole('button', { name: 'Inspect' }).closest('[aria-hidden="true"]')).toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('traps focus, isolates background, cancels on Escape and restores the programmatic opener', async () => {
    const user = userEvent.setup();
    render(
      <ConfirmProvider>
        <ConfirmExample />
      </ConfirmProvider>
    );
    const opener = screen.getByRole('button', { name: 'Remove' });
    await user.click(opener);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);
    expect(screen.getByRole('alertdialog').getAttribute('aria-modal')).toBe('true');
    expect(opener.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(document.body.style.pointerEvents).toBe('none');
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Confirm' }));
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    opener.focus();
    expect(document.activeElement).toBe(cancel);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByText('No')).toBeTruthy();
    expect(document.activeElement).toBe(opener);
    expect(opener.closest('[aria-hidden="true"]')).toBeNull();
    expect(document.body.style.pointerEvents).toBe('');
  });
  it('confirms through the unchanged promise API', async () => {
    const user = userEvent.setup();
    render(
      <ConfirmProvider>
        <ConfirmExample />
      </ConfirmProvider>
    );
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(screen.getByText('Yes')).toBeTruthy();
  });
  it('cancels a replaced confirmation and moves focus back to Cancel', async () => {
    const user = userEvent.setup();
    let confirm!: ReturnType<typeof useConfirm>;
    function Capture() {
      confirm = useConfirm();
      return <button>Opener</button>;
    }
    render(
      <ConfirmProvider>
        <Capture />
      </ConfirmProvider>
    );
    screen.getByRole('button', { name: 'Opener' }).focus();
    let first!: Promise<boolean>;
    act(() => {
      first = confirm({ title: 'First decision' });
    });
    screen.getByRole('button', { name: 'Confirm' }).focus();
    let second!: Promise<boolean>;
    act(() => {
      second = confirm({ title: 'Second decision', confirmLabel: 'Proceed' });
    });
    expect(await first).toBe(false);
    expect(screen.getByRole('alertdialog').textContent).toContain('Second decision');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Proceed' }));
    expect(await second).toBe(true);
  });
  it('navigates menus, skips disabled items, typeaheads and restores focus', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Targets</DropdownMenuTrigger>
        <DropdownMenuContent loop>
          <DropdownMenuItem>Alpha</DropdownMenuItem>
          <DropdownMenuItem disabled>Disabled</DropdownMenuItem>
          <DropdownMenuItem>Bravo</DropdownMenuItem>
          <DropdownMenuItem>Charlie</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    const trigger = screen.getByRole('button', { name: 'Targets' });
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.textContent).toBe('Alpha');
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.textContent).toBe('Bravo');
    await user.keyboard('c');
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Charlie'));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
  it('delays the first tooltip and opens subsequent hints without delay', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider disableHoverableContent>
        <Tooltip>
          <TooltipTrigger>Hint one</TooltipTrigger>
          <TooltipContent>One</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger>Hint two</TooltipTrigger>
          <TooltipContent>Two</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
    await user.hover(screen.getByRole('button', { name: 'Hint one' }));
    expect(screen.queryByRole('tooltip')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect((await screen.findByRole('tooltip')).textContent).toBe('One');
    await user.hover(screen.getByRole('button', { name: 'Hint two' }));
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe('Two'), { timeout: 100 });
  });
  it('shows the popover gallery with immediate motion while features are unavailable', async () => {
    const user = userEvent.setup();
    render(
      <Popover>
        <PopoverTrigger>Details</PopoverTrigger>
        <PopoverContent>Gallery details</PopoverContent>
      </Popover>
    );
    await user.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByRole('dialog').dataset.immediate).toBe('true');
    expect(screen.getByText('Gallery details')).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('Overlay animated lane', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  async function openAnimatedDialog() {
    let setOpen!: React.Dispatch<React.SetStateAction<boolean>>;
    function Harness() {
      const [open, updateOpen] = React.useState(false);
      setOpen = updateOpen;
      const { immediate } = useTransition();
      return (
        <Dialog open={open} onOpenChange={updateOpen}>
          <DialogTrigger data-immediate={immediate || undefined}>Animated dialog</DialogTrigger>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>Animated content</DialogTitle>
          </DialogContent>
        </Dialog>
      );
    }
    render(
      <MotionProvider>
        <Harness />
      </MotionProvider>
    );
    const trigger = screen.getByRole('button', { name: 'Animated dialog' });
    await waitFor(() => expect(trigger.hasAttribute('data-immediate')).toBe(false));
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog');
    const opacity = () => Number(dialog.style.opacity);
    // Observe a real partial entrance; never substitute a test-only transition.
    await waitFor(
      () => {
        expect(opacity()).toBeGreaterThan(0);
        expect(opacity()).toBeLessThan(0.95);
      },
      { interval: 1 }
    );
    return { dialog, trigger, opacity, reopen: () => act(() => setOpen(true)) };
  }

  it('Escape mid-enter decreases opacity without a reset, then releases modal state and focus', async () => {
    const { dialog, trigger, opacity } = await openAnimatedDialog();
    const midEnter = opacity();
    const samples = [midEnter];
    const observer = new MutationObserver(() => samples.push(opacity()));
    observer.observe(dialog, { attributes: true, attributeFilter: ['style'] });
    try {
      fireEvent.keyDown(dialog, { key: 'Escape' });
      expect(dialog.dataset.state).toBe('closed');
      expect(opacity()).toBeLessThanOrEqual(midEnter);
      await waitFor(() => expect(dialog.isConnected).toBe(false));
      expect(samples.length).toBeGreaterThan(2);
      expect(samples.some((value) => value < midEnter)).toBe(true);
      // Motion flushes one pending entrance frame when the exit takes over.
      // It must stay partial (never reset to 1), then decrease on every update.
      expect(Math.max(...samples)).toBeLessThan(1);
      const changes = samples.filter((value, index) => index === 0 || value !== samples[index - 1]);
      changes.slice(2).forEach((value, index) => expect(value).toBeLessThanOrEqual(changes[index + 1]));
      expect(document.querySelector('.ui-dialog-scrim')).toBeNull();
      expect(document.body.style.pointerEvents).toBe('');
      expect(document.activeElement).toBe(trigger);
    } finally {
      observer.disconnect();
    }
  });

  it('reopening during exit retains one dialog and scrim and settles back to visible', async () => {
    const { dialog, opacity, reopen } = await openAnimatedDialog();
    const midEnter = opacity();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(
      () => {
        expect(dialog.isConnected).toBe(true);
        expect(opacity()).toBeGreaterThan(0);
        expect(opacity()).toBeLessThan(midEnter);
      },
      { interval: 1 }
    );
    const midExit = opacity();
    reopen();
    expect(screen.getAllByRole('dialog')).toEqual([dialog]);
    expect(document.querySelectorAll('.ui-dialog-scrim')).toHaveLength(1);
    await waitFor(() => expect(opacity()).toBeGreaterThan(midExit));
    await waitFor(() => expect(opacity()).toBe(1));
    expect(screen.getAllByRole('dialog')).toEqual([dialog]);
    expect(document.querySelectorAll('.ui-dialog-scrim')).toHaveLength(1);
  });
});
