import type { AppMode } from './host';

export type AppNavKey =
  | 'installed-apps'
  | 'catalogue'
  | 'setup'
  | 'projects'
  | 'agents'
  | 'machine'
  | 'cloud'
  | 'settings';

export interface AppNavItem {
  key: AppNavKey;
  to: string;
  label: string;
  group?: 'develop';
  prominent?: boolean;
}

export interface AppNavigationOptions {
  mode: AppMode;
  isOperator: boolean;
  hasVm: boolean;
  configured: boolean;
  isLoading: boolean;
}

/** Pure navigation policy, kept separate from rendering for unit coverage. */
export function getAppNavigation(options: AppNavigationOptions): AppNavItem[] {
  const userItems: AppNavItem[] = [
    { key: 'installed-apps', to: '/apps', label: 'Installed Apps' },
    { key: 'catalogue', to: '/catalogue', label: 'Catalogue' },
  ];
  const settings: AppNavItem = { key: 'settings', to: '/settings', label: 'Settings' };
  if (options.mode === 'user') return [...userItems, settings];

  const developerItems: AppNavItem[] = [
    ...(options.isOperator && !options.isLoading && !options.configured
      ? [{ key: 'setup' as const, to: '/setup', label: 'Setup', prominent: true }]
      : []),
    { key: 'projects', to: '/projects', label: 'Projects' },
    ...(options.isOperator && options.hasVm ? [{ key: 'agents' as const, to: '/agents', label: 'Agents' }] : []),
    ...(options.isOperator && options.hasVm ? [{ key: 'machine' as const, to: '/machine', label: 'Machine' }] : []),
    ...(options.isOperator ? [{ key: 'cloud' as const, to: '/cloud', label: 'Cloud' }] : []),
  ];
  if (developerItems[0]) developerItems[0] = { ...developerItems[0], group: 'develop' };
  return [...userItems, ...developerItems, settings];
}
