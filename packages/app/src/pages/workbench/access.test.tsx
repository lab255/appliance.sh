import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';
import { RequireWorkbench } from './access';
const state = vi.hoisted(() => ({ mode: 'developer', role: 'admin', pending: false }));
vi.mock('@/hooks/use-app-mode', () => ({ useAppMode: () => ({ mode: state.mode, isLoading: state.pending }) }));
vi.mock('@/hooks/use-key-role', () => ({ useKeyRole: () => ({ role: state.role, isLoading: false }) }));
vi.mock('react-router', () => ({ Navigate: ({ to }: { to: string }) => <span>Refused: {to}</span> }));
describe('Workbench direct-route admission', () => {
  it.each([
    ['user', 'admin'],
    ['user', 'member'],
    ['developer', 'member'],
  ])('refuses %s / %s', (mode, role) => {
    Object.assign(state, { mode, role, pending: false });
    expect(renderToStaticMarkup(<RequireWorkbench>Workspace content</RequireWorkbench>)).toBe(
      '<span>Refused: /apps</span>'
    );
  });
  it('admits only resolved developer operator state', () => {
    Object.assign(state, { mode: 'developer', role: 'admin', pending: false });
    expect(renderToStaticMarkup(<RequireWorkbench>Workspace content</RequireWorkbench>)).toBe('Workspace content');
    state.pending = true;
    expect(renderToStaticMarkup(<RequireWorkbench>Workspace content</RequireWorkbench>)).toBe('');
  });
});
