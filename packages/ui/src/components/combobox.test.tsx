// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Combobox } from './combobox.js';

afterEach(cleanup);
const options = [
  { value: 'journal', label: 'Journal', keywords: 'notes' },
  { value: 'tasks', label: 'Tasks', keywords: 'planning' },
];
function Example() {
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState('');
  return (
    <>
      <Combobox
        label="Apps"
        options={options}
        query={query}
        onQueryChange={setQuery}
        onSelect={(option) => setSelected(option.value)}
      />
      <output data-testid="selection">{selected}</output>
      <button>Next</button>
    </>
  );
}

describe('Combobox', () => {
  it('filters keywords, keeps input focus and selects using arrows and Enter', async () => {
    const user = userEvent.setup();
    render(<Example />);
    const input = screen.getByRole('combobox', { name: 'Apps' });
    await user.click(input);
    expect(input.getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id);
    await user.type(input, 'plan');
    expect(screen.getAllByRole('option').map((node) => node.textContent)).toEqual(['Tasks']);
    await user.keyboard('{ArrowDown}');
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option').id);
    expect(document.activeElement).toBe(input);
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('selection').textContent).toBe('tasks');
    expect((input as HTMLInputElement).value).toBe('Tasks');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
  });
  it('wraps arrows, closes on Escape without clearing text and tabs away', async () => {
    const user = userEvent.setup();
    render(<Example />);
    const input = screen.getByRole('combobox');
    await user.click(input);
    await user.keyboard('{ArrowUp}');
    expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')[0].getAttribute('aria-selected')).toBe('true');
    await user.type(input, 'Jo');
    await user.keyboard('{Escape}');
    expect((input as HTMLInputElement).value).toBe('Jo');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    await user.keyboard('{ArrowDown}{Tab}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }));
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });
  it('handles empty results, resets stale active descendants and ignores IME Enter', async () => {
    const user = userEvent.setup();
    render(<Example />);
    const input = screen.getByRole('combobox');
    await user.click(input);
    await user.keyboard('{ArrowDown}');
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(screen.getByTestId('selection').textContent).toBe('');
    await user.type(input, 'zz');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(screen.getByText('No matches')).toBeTruthy();
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    await user.clear(input);
    await user.click(screen.getByRole('option', { name: 'Journal' }));
    expect(screen.getByTestId('selection').textContent).toBe('journal');
    expect(document.activeElement).toBe(input);
  });
});
