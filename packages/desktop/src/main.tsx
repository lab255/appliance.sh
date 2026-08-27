import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Console, decodeAppWindowDescriptor, renderAppWindow } from '@appliance.sh/app';
import type { ConsoleHost } from '@appliance.sh/app';
import '@appliance.sh/app/styles.css';
import { tauriHost } from './host';

const container = document.getElementById('root');
if (!container) throw new Error('#root element not found');

const appWindow = new URLSearchParams(window.location.search).get('app-window');
if (appWindow) {
  const initial = decodeAppWindowDescriptor(appWindow);
  renderAppWindow(container, initial, {
    status: () => tauriHost.installedApps!.windowStatus(initial.appId, initial.target),
    reopen: async () => {
      await tauriHost.installedApps!.run(initial.appId, initial.target);
      return tauriHost.installedApps!.openWindow(initial.appId, initial.target);
    },
  });
} else {
  // Dev-only browser harness: `pnpm --filter @appliance.sh/desktop dev`,
  // then open http://localhost:1420/?mock-host[&scenario=…] in a plain
  // browser to work on desktop-only pages (Local Runtime, deploy wizard,
  // bootstrap) without a Tauri build. The dynamic import keeps the mock
  // out of production bundles entirely.
  async function resolveHost(): Promise<ConsoleHost> {
    if (import.meta.env.DEV) {
      const { mockHostEnabled, createMockHost } = await import('./mock-host');
      if (mockHostEnabled()) return createMockHost();
    }
    return tauriHost;
  }

  resolveHost().then((host) => {
    createRoot(container).render(
      <StrictMode>
        <Console host={host} />
      </StrictMode>
    );
  });
}
