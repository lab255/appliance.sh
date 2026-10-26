// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { WeightLabel } from './weight-label.js';

afterEach(cleanup);

it('keeps the width reservation in sync through renames and selection, with one accessible name', () => {
  const label = (text: string, active: boolean) => (
    <button role="tab" aria-selected={active}>
      <WeightLabel active={active}>{text}</WeightLabel>
    </button>
  );
  const view = render(label('Terminal', false));
  for (const [text, active] of [
    ['Terminal', false],
    ['Renamed terminal', true],
  ] as const) {
    view.rerender(label(text, active));
    const tab = view.getByRole('tab', { name: text, selected: active });
    const ghost = tab.querySelector('.weight-label-ghost');
    expect(ghost?.getAttribute('aria-hidden')).toBe('true');
    expect(ghost?.textContent).toBe(text);
    expect(ghost?.textContent).toBe(tab.querySelector('.weight-label-text')?.textContent);
    expect(tab.querySelector('.weight-label')?.getAttribute('data-active')).toBe(String(active));
  }
});
