import { describe, expect, it } from 'vitest';
import { getAppNavigation } from './app-navigation';

const labels = (options: Parameters<typeof getAppNavigation>[0]) => getAppNavigation(options).map((item) => item.label);

describe('getAppNavigation', () => {
  it('shows only the runner surfaces in user mode', () => {
    expect(labels({ mode: 'user', isOperator: true, hasVm: true, configured: false, isLoading: false })).toEqual([
      'Installed Apps',
      'Catalogue',
      'Settings',
    ]);
  });

  it('appends the full eligible developer set under Develop', () => {
    const nav = getAppNavigation({
      mode: 'developer',
      isOperator: true,
      hasVm: true,
      configured: false,
      isLoading: false,
    });
    expect(nav.map((item) => item.label)).toEqual([
      'Installed Apps',
      'Catalogue',
      'Setup',
      'Projects',
      'Agents',
      'Machine',
      'Cloud',
      'Settings',
    ]);
    expect(nav.find((item) => item.group === 'develop')?.label).toBe('Setup');
  });

  it('preserves configured, role, and VM capability gates in developer mode', () => {
    const nav = getAppNavigation({
      mode: 'developer',
      isOperator: false,
      hasVm: false,
      configured: true,
      isLoading: false,
    });
    expect(nav.map((item) => item.label)).toEqual(['Installed Apps', 'Catalogue', 'Projects', 'Settings']);
    expect(nav.find((item) => item.group === 'develop')?.label).toBe('Projects');
  });
});
