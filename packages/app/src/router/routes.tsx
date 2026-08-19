import type * as React from 'react';
import type { RouteObject } from 'react-router';
import { Navigate, useLocation, useParams } from 'react-router';
import { AppShell } from '@/components/layout/app-shell';
import { useSelectedCluster } from '@/hooks/use-selected-cluster';
import { useDevMachineTargets } from '@/hooks/use-dev-machine-targets';
import { useKeyRole } from '@/hooks/use-key-role';
import { isBootstrapOnlyConsole } from '@/lib/runtime-config';
import { isMicroVmClusterId, microVmNameFromClusterId, DEFAULT_MICROVM_NAME } from '@/lib/host';
import { AppsPage } from '@/pages/apps';
import { SetupPage } from '@/pages/setup';
import { InvitePage, BootstrapHandoffPage } from '@/pages/invite';
import { ConnectPage } from '@/pages/connect';
import { ProjectDetailPage } from '@/pages/projects/detail';
import { EnvironmentDetailPage } from '@/pages/environments/detail';
import { DeploymentsPage } from '@/pages/deployments/list';
import { DeploymentDetailPage } from '@/pages/deployments/detail';
import { SettingsPage } from '@/pages/settings';
import { SetupDoctorPage } from '@/pages/setup/doctor';
import { AgentsPage } from '@/pages/agents';
import { MachinePage } from '@/pages/machine';
import { CloudPage } from '@/pages/cloud';
import { CloudDetailPage } from '@/pages/cloud/detail';
import { DeployPage } from '@/pages/apps/deploy';
import { BootstrapWizardPage } from '@/pages/bootstrap/wizard';
import { BootstrapProgressPage } from '@/pages/bootstrap/progress';

// Default-landing resolver: Setup when the shell is unconfigured (no
// selected cluster), else the Apps home. We hold (render nothing) until
// the host config resolves so we never flash the wrong destination.
function LandingRedirect() {
  const { config, cluster, isLoading } = useSelectedCluster();
  const devMachine = useDevMachineTargets(config?.clusters ?? []);
  const bootstrapOnly = isBootstrapOnlyConsole();
  if (isLoading || (!bootstrapOnly && !cluster && devMachine.isLoading)) return null;
  // A bootstrap-only console (high-security deployments) never shows
  // the app: once connected, hand off to the hardened console.
  if (bootstrapOnly) {
    return <Navigate to={cluster ? '/setup-complete' : '/setup'} replace />;
  }
  return <Navigate to={cluster ? '/projects' : devMachine.machines.length > 0 ? '/machine' : '/setup'} replace />;
}

// Operator-only surfaces (machine, cloud, bootstrap, doctor, agents) are
// hidden from member keys — the invite-minted role for teammates. The
// api-server enforces the real boundary (403s on admin routes); this
// guard just keeps members from landing on screens made of dead ends.
function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { role, isLoading } = useKeyRole();
  if (isLoading) return null;
  if (role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

// The deploy wizard's canonical home is `/projects/deploy`; the old
// `/local-runtime/deploy` alias redirects. It carries the deploy intent in
// the query string (`?project=&environment=`), so we redirect PRESERVING
// `location.search` — a bare `<Navigate>` would drop it and dead-end the
// "Set up first deploy" links.
function DeployAliasRedirect() {
  const { search } = useLocation();
  return <Navigate to={`/projects/deploy${search}`} replace />;
}

// Query-preserving redirect to the canonical bootstrap wizard — the old
// wizard paths carried `?mode=` deep links (e.g. the Setup hub's cards).
function BootstrapAliasRedirect() {
  const { search } = useLocation();
  return <Navigate to={`/cloud/bootstrap${search}`} replace />;
}

// Old `/clusters/:id` deep links: a microVM cluster id is the Dev Machine
// (→ /machine, keeping which VM via ?vm=), anything else is a cloud
// installation (→ /cloud/:id).
function ClusterIdRedirect() {
  const { id = '' } = useParams();
  if (isMicroVmClusterId(id)) {
    const vm = microVmNameFromClusterId(id);
    const suffix = vm && vm !== DEFAULT_MICROVM_NAME ? `?vm=${encodeURIComponent(vm)}` : '';
    return <Navigate to={`/machine${suffix}`} replace />;
  }
  return <Navigate to={`/cloud/${id}`} replace />;
}

// Old flat env-detail path → the canonical nested one.
function EnvironmentAliasRedirect() {
  const { projectId = '', id = '' } = useParams();
  return <Navigate to={`/projects/${projectId}/environments/${id}`} replace />;
}

// Five-area IA: Setup (adaptive) / Apps / Agents / Machine / Cloud /
// Settings. Setup / Connect / Bootstrap live INSIDE `AppShell` so the
// terminal dock + target switcher persist during onboarding.
export const routes: RouteObject[] = [
  // Standalone (no AppShell chrome): the invite landing a teammate's
  // link opens, and the "setup only" handoff a bootstrap-scoped console
  // shows once connected. Both are first-run screens — nav, target
  // switcher and the terminal dock would only add noise.
  { path: '/invite', element: <InvitePage /> },
  { path: '/setup-complete', element: <BootstrapHandoffPage /> },
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <LandingRedirect /> },

      // ① Setup — the onboarding hub + its children. `/setup` stays
      // routable even once configured. The microVM EXPRESS boot
      // (FirstRunWelcome's one-click "Get started") navigates to
      // /setup/bootstrap/run with router state, so that path stays a
      // real alias (a redirect would drop `location.state`).
      { path: 'setup', element: <SetupPage /> },
      { path: 'setup/connect', element: <ConnectPage /> },
      { path: 'setup/bootstrap', element: <BootstrapAliasRedirect /> },
      {
        path: 'setup/bootstrap/run',
        element: (
          <RequireAdmin>
            <BootstrapProgressPage />
          </RequireAdmin>
        ),
      },
      {
        path: 'setup/doctor',
        element: (
          <RequireAdmin>
            <SetupDoctorPage />
          </RequireAdmin>
        ),
      },

      // ③ Apps — the overview home, deploy wizard, app detail, and
      // Environments/Deployments folded UNDER the area as nested routes.
      { path: 'projects', element: <AppsPage /> },
      { path: 'projects/deploy', element: <DeployPage /> },
      { path: 'projects/:id', element: <ProjectDetailPage /> },
      { path: 'projects/:projectId/environments/:id', element: <EnvironmentDetailPage /> },

      // ④ Agents — desktop-only (`host.vm`); the nav item is hidden on
      // web and the page renders a "desktop app only" message there.
      // Observe terminals stay in the global dock.
      {
        path: 'agents',
        element: (
          <RequireAdmin>
            <AgentsPage />
          </RequireAdmin>
        ),
      },

      // Machine — THE Dev Machine page (the one managed local VM;
      // lifecycle / egress / credentials / facts / workloads).
      {
        path: 'machine',
        element: (
          <RequireAdmin>
            <MachinePage />
          </RequireAdmin>
        ),
      },

      // Cloud — connected cloud installations + the bootstrap wizard
      // (its canonical home).
      {
        path: 'cloud',
        element: (
          <RequireAdmin>
            <CloudPage />
          </RequireAdmin>
        ),
      },
      {
        path: 'cloud/bootstrap',
        element: (
          <RequireAdmin>
            <BootstrapWizardPage />
          </RequireAdmin>
        ),
      },
      {
        path: 'cloud/bootstrap/run',
        element: (
          <RequireAdmin>
            <BootstrapProgressPage />
          </RequireAdmin>
        ),
      },
      {
        path: 'cloud/:id',
        element: (
          <RequireAdmin>
            <CloudDetailPage />
          </RequireAdmin>
        ),
      },

      // ⑤ Settings
      { path: 'settings', element: <SettingsPage /> },

      // ---- old routes, kept reachable so nothing breaks (one release) ----
      // Stateless → redirect to the new canonical path.
      { path: 'dashboard', element: <Navigate to="/projects" replace /> },
      { path: 'connect', element: <Navigate to="/setup/connect" replace /> },
      // The retired Clusters area: the list is now split into Machine +
      // Cloud; per-id links dispatch on the id kind.
      { path: 'clusters', element: <Navigate to="/machine" replace /> },
      { path: 'clusters/:id', element: <ClusterIdRedirect /> },
      // Bootstrap wizard moved under /cloud. The wizard itself only reads
      // `?mode=` (preserved by the alias redirect); the RUN page carries
      // router state, so it stays a real alias rather than a redirect.
      { path: 'bootstrap', element: <BootstrapAliasRedirect /> },
      {
        path: 'bootstrap/run',
        element: (
          <RequireAdmin>
            <BootstrapProgressPage />
          </RequireAdmin>
        ),
      },
      { path: 'local-runtime', element: <Navigate to="/machine" replace /> },
      // Deploy wizard lives at /projects/deploy; alias preserves the
      // `?project=&environment=` intent on the redirect.
      { path: 'local-runtime/deploy', element: <DeployAliasRedirect /> },
      // The flat environments list is gone (env CRUD lives on the app
      // detail); flat env-detail links bounce to the nested route.
      { path: 'environments', element: <Navigate to="/projects" replace /> },
      { path: 'environments/:projectId/:id', element: <EnvironmentAliasRedirect /> },
      // Deployments keep their flat routes for deep links, nav-less.
      { path: 'deployments', element: <DeploymentsPage /> },
      { path: 'deployments/:id', element: <DeploymentDetailPage /> },
    ],
  },
];
