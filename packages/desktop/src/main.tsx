import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Console, decodeAppWindowDescriptor, renderAppWindow } from '@appliance.sh/app';
import type { AppWindowMetric, ConsoleHost } from '@appliance.sh/app';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import '@appliance.sh/app/styles.css';
import { createTauriHost, tauriHost } from './host';

const container = document.getElementById('root');
if (!container) throw new Error('#root element not found');

const appWindow = new URLSearchParams(window.location.search).get('app-window');
if (appWindow) {
  const initial = decodeAppWindowDescriptor(appWindow);
  let cleanup = () => {};
  const showAppWindow = (descriptor: typeof initial) => {
    cleanup();
    cleanup = renderAppWindow(container, descriptor, {
      status: () => tauriHost.installedApps!.windowStatus(descriptor.appId, descriptor.target),
      reopen: async () => {
        await tauriHost.installedApps!.run(descriptor.appId, descriptor.target);
        return tauriHost.installedApps!.windowStatus(descriptor.appId, descriptor.target);
      },
      metric: (metric: AppWindowMetric) => invoke('runtime_record_app_metric', { metric }),
    });
  };
  showAppWindow(initial);
  void listen<typeof initial>('runtime-app-open', (event) => showAppWindow(event.payload)).then((unlisten) => {
    window.addEventListener('beforeunload', () => {
      unlisten();
      cleanup();
    });
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
    return createTauriHost();
  }

  resolveHost().then((host) => {
    createRoot(container).render(
      <StrictMode>
        <Console host={host} />
      </StrictMode>
    );
  });
}
