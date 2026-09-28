// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dialog, DialogTrigger, DialogContent, DialogTitle } from './dialog.js';
import { ConfirmProvider, useConfirm } from './confirm-dialog.js';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from './dropdown-menu.js';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from './tooltip.js';
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
