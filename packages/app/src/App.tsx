import { MotionProvider } from '@appliance.sh/ui/motion-provider';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { HostProvider } from '@/providers/host-provider';
import { TerminalSessionsProvider } from '@/providers/terminal-sessions-provider';
import { ToastProvider } from '@/components/ui/toast';
import { ConfirmProvider } from '@/components/ui/confirm-dialog';
import { authFailureCause, isAuthShapedError } from '@/components/friendly-error';
import { handleAuthShapedError, registerAuthHeal } from '@/lib/microvm-heal';
import { routes } from '@/router/routes';
import type { ConsoleHost } from '@/lib/host';
import '@/styles.css';

const queryClient = new QueryClient({
  // Any query failing with an auth-shaped error (401/403, bad signature,
  // expired key) first attempts a microVM credential self-heal (re-mint
  // via the VM's bootstrap token) and only raises the global auth-expiry
  // signal — the AppShell's dismissible "connection expired" banner with
  // a Reconnect CTA — when healing isn't possible or didn't work.
  queryCache: new QueryCache({
    onError: (error) => {
      // Newer servers attach a machine-readable cause to the 401 body;
      // it picks the heal strategy (mint vs clock-sync vs nothing).
      // Cause-less errors keep the text-shape heuristic behavior.
      if (isAuthShapedError(error)) handleAuthShapedError(authFailureCause(error));
    },
  }),
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: false },
  },
});

const router = createBrowserRouter(routes);

export interface ConsoleProps {
  host: ConsoleHost;
}

export function Console({ host }: ConsoleProps) {
  // The query cache's error handler runs outside React — hand it the
  // host + client it needs to attempt a credential self-heal.
  registerAuthHeal(host, queryClient);
  return (
    <HostProvider host={host}>
      <QueryClientProvider client={queryClient}>
        <MotionProvider>
          <ToastProvider>
            <ConfirmProvider>
              {/* Above the router so terminal sessions outlive navigation
                (the route `<Outlet/>` swaps, the sessions don't). */}
              <TerminalSessionsProvider>
                <RouterProvider router={router} />
              </TerminalSessionsProvider>
            </ConfirmProvider>
          </ToastProvider>
        </MotionProvider>
      </QueryClientProvider>
    </HostProvider>
  );
}
