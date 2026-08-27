import type {
  AddClusterInput,
  AgentInfo,
  AgentLaunchInput,
  AgentAuthKind,
  AgentAuthStatus,
  AppMode,
  BootstrapEvent,
  BootstrapResult,
  Cluster,
  CatalogueFetchResult,
  ConsoleHost,
  HostConfig,
  LocalPreflightCheck,
  InstalledRuntimeApp,
  RuntimeAppWindowDescriptor,
} from '@appliance.sh/app';
import type { InstalledApp } from '@appliance.sh/sdk';

// Browser-runnable stand-in for the Tauri host, so the desktop-only
// pages (Local Runtime, deploy wizard, bootstrap) can be developed and
// audited in a regular browser — no cargo build, no native window, and
// deterministic runtime states a real machine can't hold still in.
//
// Enable by loading the desktop vite dev server with `?mock-host`
// (persisted in sessionStorage so SPA navigation keeps it). Pick the
// preflight/runtime fixture with `?scenario=`:
//
//   ready        all tools installed, daemon up (default)
//   running      daemon up, workloads populated
//   daemon-down  docker installed but VM stopped, auto-startable (colima)
//   daemon-manual docker installed, VM stopped, NOT auto-startable
//   missing        kubectl not installed, docker guidance-only
//   first-run     no stored app mode; show the audience choice
//   user-mode     persisted User mode with local + cloud workspaces
//   user-mode-no-vm persisted User mode before the local sandbox exists
//   developer-mode persisted Developer mode
//   catalogue      verified signed free catalogue
//   catalogue-unverified signature failure / fail-closed empty state
//   catalogue-loading    fetch pending / verification loading state
//   catalogue-stale expired-but-previously-verified read-only catalogue
//   installed-apps       populated Installed Apps page
//   app-window           dedicated running-app window
//   app-exited           dedicated app-exited window
//   installed-apps-empty empty Installed Apps page
//   unknown-publisher    unsigned app requiring the warning dialog
//   install-from-file    file-picker installation path
//
// Transitions are simulated (start ≈2s, stop ≈1s, builds stream log
// lines) so spinners, disabled states, and progress UI are exercised
// for real. DEV-only: main.tsx never references this module outside
// `import.meta.env.DEV`.

type Scenario =
  | 'ready'
  | 'running'
  | 'daemon-down'
  | 'daemon-manual'
  | 'missing'
  | 'first-run'
  | 'user-mode'
  | 'user-mode-no-vm'
  | 'developer-mode'
  | 'catalogue'
  | 'catalogue-unverified'
  | 'catalogue-stale'
  | 'catalogue-loading'
  | 'installed-apps'
  | 'installed-apps-empty'
  | 'app-window'
  | 'app-exited'
  | 'unknown-publisher'
  | 'install-from-file';

const SCENARIO_KEY = 'mock-host:scenario';
const ENABLED_KEY = 'mock-host:enabled';
const CLUSTERS_KEY = 'mock-host:clusters';
const APP_MODE_KEY = 'mock-host:app-mode';

export function mockHostEnabled(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.has('mock-host')) {
    sessionStorage.setItem(ENABLED_KEY, '1');
    const scenario = params.get('scenario');
    if (scenario) {
      sessionStorage.setItem(SCENARIO_KEY, scenario);
      if (scenario === 'first-run') sessionStorage.removeItem(APP_MODE_KEY);
      if (
        scenario === 'user-mode' ||
        scenario === 'user-mode-no-vm' ||
        scenario === 'installed-apps' ||
        scenario === 'installed-apps-empty' ||
        scenario === 'app-window' ||
        scenario === 'app-exited' ||
        scenario === 'unknown-publisher' ||
        scenario === 'install-from-file'
      ) {
        sessionStorage.setItem(APP_MODE_KEY, 'user');
        configureWorkspaceScenario(scenario === 'user-mode-no-vm' ? 'user-mode-no-vm' : 'user-mode');
      }
      if (scenario === 'developer-mode') sessionStorage.setItem(APP_MODE_KEY, 'developer');
    }
  }
  return sessionStorage.getItem(ENABLED_KEY) === '1';
}

function scenario(): Scenario {
  const s = sessionStorage.getItem(SCENARIO_KEY);
  return s === 'running' ||
    s === 'daemon-down' ||
    s === 'daemon-manual' ||
    s === 'missing' ||
    s === 'first-run' ||
    s === 'user-mode' ||
    s === 'user-mode-no-vm' ||
    s === 'developer-mode' ||
    s === 'catalogue' ||
    s === 'catalogue-unverified' ||
    s === 'catalogue-stale' ||
    s === 'catalogue-loading' ||
    s === 'installed-apps' ||
    s === 'installed-apps-empty' ||
    s === 'app-window' ||
    s === 'app-exited' ||
    s === 'unknown-publisher' ||
    s === 'install-from-file'
    ? s
    : 'ready';
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Toggle to QA the "you're up to date" branch of the updater panel.
const MOCK_UPDATE_AVAILABLE = true;
// Fixed running version for the mock update feed (the real running
// version isn't available to desktop-package source — see check()).
const MOCK_CURRENT_VERSION = '1.48.0';

// Agent-login mock (Phase 5, L3 / multi-agent G3): the host-side credential
// store, in memory, keyed PER AGENT TYPE (each agent has its own provider
// store). Flip `MOCK_HAS_HOST_CLAUDE` to false to QA the "Sign in with Claude"
// gate (no host `claude` → install guidance / use an API key).
const mockAgentCreds = new Map<string, AgentAuthKind>();
const MOCK_HAS_HOST_CLAUDE = true;

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signedCatalogueFixture(): Promise<CatalogueFetchResult> {
  const { catalogueSigningInput } = await import('@appliance.sh/sdk');
  const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  const keyDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey));
  const keyId = `ed25519:sha256:${Array.from(keyDigest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  const now = Date.now();
  const stale = scenario() === 'catalogue-stale';
  const issuedAt = new Date(now - (stale ? 20 : 1) * 24 * 60 * 60 * 1000);
  const expiresAt = new Date(issuedAt.getTime() + 14 * 24 * 60 * 60 * 1000);
  const common = {
    publisher: { name: 'Lab 255', keyId },
    tier: 'known-publisher',
  } as const;
  const index = {
    schema: 'appliance.catalogue-index/v1',
    generation: 7,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    entries: [
      {
        ...common,
        id: 'journal',
        name: 'Journal',
        version: '1.2.0',
        description: 'Private daily notes with end-to-end local storage.',
        license: 'MIT',
        category: 'Productivity',
        url: 'https://journal.appliance.zip',
        digest: `sha256:${'1'.repeat(64)}`,
      },
      {
        ...common,
        id: 'photos',
        name: 'Photos',
        version: '3.1.2',
        description: 'Self-hosted photo library with on-device face grouping.',
        license: 'GPL-3.0',
        category: 'Media',
        url: 'https://photos.appliance.zip',
        digest: `sha256:${'2'.repeat(64)}`,
      },
      {
        ...common,
        id: 'reader',
        name: 'Reader',
        version: '0.14.0',
        description: 'RSS and newsletter reader, offline-first.',
        license: 'MIT',
        category: 'Productivity',
        url: 'https://reader.appliance.zip',
        digest: `sha256:${'3'.repeat(64)}`,
      },
      {
        ...common,
        id: 'bookmarks',
        name: 'Bookmarks',
        version: '2.0.3',
        description: 'Link archive with full-page snapshots and tags.',
        license: 'Apache-2.0',
        category: 'Productivity',
        url: 'https://bookmarks.appliance.zip',
        digest: `sha256:${'4'.repeat(64)}`,
      },
      {
        ...common,
        id: 'metrics',
        name: 'Metrics',
        version: '1.8.0',
        description: 'Private dashboards for local service data.',
        license: 'MIT',
        category: 'Data',
        url: 'https://metrics.appliance.zip',
        digest: `sha256:${'5'.repeat(64)}`,
      },
      {
        ...common,
        id: 'toolbox',
        name: 'Toolbox',
        version: '5.2.1',
        description: 'Developer utilities in an isolated workspace.',
        license: 'AGPL-3.0',
        category: 'Dev tools',
        url: 'https://toolbox.appliance.zip',
        digest: `sha256:${'6'.repeat(64)}`,
      },
      {
        ...common,
        id: 'paid-hidden',
        name: 'Paid Hidden',
        version: '1.0.0',
        description: 'This must never enter rendered state.',
        license: 'MIT',
        category: 'Data',
        url: 'https://paid-hidden.appliance.zip',
        digest: `sha256:${'7'.repeat(64)}`,
        paid: true,
      },
    ],
  };
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'Ed25519' },
      keys.privateKey,
      (await catalogueSigningInput(index, 'index')).slice().buffer
    )
  );
  if (scenario() === 'catalogue-unverified') signature[0] ^= 0xff;
  return {
    indexJson: JSON.stringify(index),
    signatureJson: JSON.stringify({ alg: 'ed25519', keyId, role: 'index', sig: base64url(signature) }),
    fetchedAt: new Date().toISOString(),
    source: 'mock',
    developmentTrustPolicy: {
      keys: { [keyId]: `ed25519:${base64url(publicKey)}` },
      generationFloor: 1,
    },
  };
}

/** Bump the minor of a semver string for the mock update feed. */
function bumpMinor(version: string): string {
  const [major, minor] = version.split('.');
  const nextMinor = Number.isFinite(Number(minor)) ? Number(minor) + 1 : 1;
  return `${major ?? '0'}.${nextMinor}.0`;
}

// ---- persisted clusters (sessionStorage, console-host style) ----------

interface PersistedState {
  clusters: Array<Cluster & { apiKey: { id: string; secret: string } }>;
  selectedClusterId: string | null;
}

function readState(): PersistedState {
  try {
    const raw = sessionStorage.getItem(CLUSTERS_KEY);
    if (raw) return JSON.parse(raw) as PersistedState;
  } catch {
    // fall through to empty
  }
  return { clusters: [], selectedClusterId: null };
}

function writeState(state: PersistedState): void {
  sessionStorage.setItem(CLUSTERS_KEY, JSON.stringify(state));
}

function configureWorkspaceScenario(s: 'user-mode' | 'user-mode-no-vm'): void {
  const cloud = {
    id: 'mock-acme-prod',
    name: 'acme-prod',
    apiServerUrl: 'https://appliance.acme.example',
    createdAt: '2026-08-27T00:00:00.000Z',
    apiKey: { id: 'apikey_cloud', secret: 'sk_cloud' },
  };
  if (s === 'user-mode-no-vm') {
    writeState({ clusters: [cloud], selectedClusterId: cloud.id });
    return;
  }
  const local = {
    id: 'microvm',
    name: 'Dev Machine',
    apiServerUrl: 'https://127.0.0.1:8443',
    createdAt: '2026-08-27T00:00:00.000Z',
    apiKey: { id: 'apikey_local', secret: 'sk_local' },
  };
  writeState({ clusters: [local, cloud], selectedClusterId: local.id });
}

// ---- runtime state machine ---------------------------------------------

interface RuntimeState {
  daemonRunning: boolean;
}

// Mirror the desktop's sync_microvm_cluster (lib.rs): a `vm up` registers
// the VM as a regular cluster and auto-selects it when nothing else is
// selected. Without this the mock host streams the boot but leaves the
// dashboard on "no cluster", so browser QA of the one-click onboarding
// would dead-end where the real desktop connects.
function mockMicroVmClusterId(name: string): string {
  return name === 'appliance' ? 'microvm' : `microvm-${name}`;
}

function registerMockMicroVmCluster(vm: MockVm): void {
  const clusterId = mockMicroVmClusterId(vm.name);
  const state = readState();
  if (!state.clusters.some((c) => c.id === clusterId)) {
    state.clusters.push({
      id: clusterId,
      name: vm.name === 'appliance' ? 'Dev Machine' : `Dev Machine (${vm.name})`,
      apiServerUrl: `http://api.appliance.localhost:${vm.hostPort}`,
      createdAt: new Date().toISOString(),
      apiKey: { id: 'apikey_mock', secret: 'sk_mock' },
    });
  }
  if (!state.selectedClusterId) state.selectedClusterId = clusterId;
  writeState(state);
}

function unregisterMockMicroVmCluster(name: string): void {
  const clusterId = mockMicroVmClusterId(name);
  const state = readState();
  state.clusters = state.clusters.filter((c) => c.id !== clusterId);
  if (state.selectedClusterId === clusterId) {
    state.selectedClusterId = state.clusters[0]?.id ?? null;
  }
  writeState(state);
}

function initialRuntime(): RuntimeState {
  const s = scenario();
  return {
    daemonRunning: s === 'ready' || s === 'running',
  };
}

// Lazily initialized: module evaluation happens before
// mockHostEnabled() persists `?scenario=` to sessionStorage, so an
// eager initialRuntime() would always see the default scenario.
let runtimeState: RuntimeState | null = null;
function getRuntime(): RuntimeState {
  if (!runtimeState) {
    runtimeState = initialRuntime();
  }
  return runtimeState;
}

function preflight(): LocalPreflightCheck[] {
  const s = scenario();
  const docker: LocalPreflightCheck = {
    tool: 'docker',
    installed: s !== 'missing',
    version: s !== 'missing' ? 'Docker version 29.2.1, build a5c7197d72' : undefined,
    purpose: 'Container runtime Appliance shells out to for `docker build` / `docker save`.',
    installHint:
      'Install any container runtime (Docker Desktop, OrbStack, Colima, Rancher Desktop). https://www.docker.com/products/docker-desktop/',
    autoInstallable: false,
    daemonRunning: s === 'missing' ? undefined : getRuntime().daemonRunning,
    daemonStartable: s === 'daemon-down' ? true : s === 'daemon-manual' ? false : undefined,
    error:
      s === 'daemon-down'
        ? 'Docker is installed but its colima VM isn’t running.'
        : s === 'daemon-manual'
          ? 'Docker isn’t running. Start your container runtime — Docker Desktop, OrbStack, or `colima start` — and retry.'
          : s === 'missing'
            ? 'not on PATH'
            : undefined,
  };
  const installed = s !== 'missing';
  return [
    docker,
    {
      tool: 'kubectl',
      installed,
      version: installed ? 'Client Version: v1.31.4' : undefined,
      purpose: 'Used to read Deployments / Services / pod logs from the microVM.',
      installHint: 'brew install kubectl',
      autoInstallable: true,
      error: installed ? undefined : 'not on PATH',
    },
  ];
}

function mockInstalledApp(
  appId: string,
  name: string,
  version: string,
  license: string,
  overrides: Partial<InstalledApp> = {}
): InstalledApp {
  return {
    appId,
    name,
    version,
    license,
    publisher: { name: 'Lab 255', keyId: `ed25519:sha256:${'1'.repeat(64)}`, tier: 'known-publisher' },
    digest: `sha256:${appId.slice(0, 1).charCodeAt(0).toString(16).padStart(2, '0').repeat(32)}`,
    bundlePath: `/Users/dev/.appliance/runtime/bundles/${appId}.appliance.zip`,
    installedAt: '2026-09-02T08:00:00.000Z',
    source: `https://${appId}.appliance.zip/`,
    verification: { signature: 'valid', indexBound: { generation: 7 } },
    controlsSummary: {
      egressHosts:
        appId === 'dashboard'
          ? []
          : appId === 'journal'
            ? ['sync.example.com', 'updates.example.com']
            : ['api.example.com'],
      mounts: [],
      publishedPorts: [{ name: 'web', guest: 8080, protocol: 'tcp' }],
      resources: { cpus: 1, memoryMib: 512 },
      serviceCount: appId === 'notes-sync' ? 2 : 1,
      serviceNames: appId === 'notes-sync' ? ['web', 'sync'] : [],
    },
    ...overrides,
  };
}

function initialInstalledApps(): InstalledRuntimeApp[] {
  if (scenario() === 'installed-apps-empty') return [];
  if (scenario() === 'unknown-publisher') {
    return [
      {
        app: mockInstalledApp('local-tool', 'Local Tool', '0.1.0', 'MIT', {
          publisher: { name: 'Local developer', tier: 'unknown' },
          source: 'file',
          verification: { signature: 'unsigned' },
          lastWarnedAt: undefined,
        }),
        state: 'stopped',
        urls: [],
        ui: { type: 'none' },
      },
    ];
  }
  return [
    {
      app: mockInstalledApp('journal', 'Journal', '1.2.0', 'MIT'),
      state: scenario() === 'app-exited' ? 'exited' : 'running',
      ...(scenario() === 'app-exited' ? { exitCode: 17 } : {}),
      urls: scenario() === 'app-exited' ? [] : ['http://127.0.0.1:8443'],
      ui: { type: 'web', port: 'web', path: '/' },
    },
    {
      app: mockInstalledApp('dashboard', 'Dashboard', '0.9.1', 'Apache-2.0'),
      state: 'stopped',
      urls: [],
      ui: { type: 'none' },
    },
    {
      app: mockInstalledApp('notes-sync', 'Notes+Sync', '2.4.0', 'AGPL-3.0'),
      state: 'running',
      urls: ['http://127.0.0.1:8445'],
      ui: { type: 'web', port: 'web', path: '/' },
    },
  ];
}

// ---- host ---------------------------------------------------------------

export function createMockHost(): ConsoleHost {
  const catalogueFixture = signedCatalogueFixture();
  let catalogueCache: CatalogueFetchResult | null = null;
  let installedApps = initialInstalledApps();
  return {
    async getConfig(): Promise<HostConfig> {
      const state = readState();
      const selected = state.clusters.find((c) => c.id === state.selectedClusterId) ?? null;
      return {
        clusters: state.clusters.map(({ apiKey: _apiKey, ...cluster }) => cluster),
        selectedClusterId: state.selectedClusterId,
        apiKey: selected ? selected.apiKey : null,
      };
    },

    async addCluster(input: AddClusterInput): Promise<Cluster> {
      const state = readState();
      const cluster: Cluster & { apiKey: { id: string; secret: string } } = {
        id: `mock-${Math.random().toString(36).slice(2, 10)}`,
        name: input.name,
        apiServerUrl: input.apiServerUrl,
        createdAt: new Date().toISOString(),
        apiKey: input.apiKey,
      };
      state.clusters.push(cluster);
      state.selectedClusterId = cluster.id;
      writeState(state);
      const { apiKey: _apiKey, ...publicCluster } = cluster;
      return publicCluster;
    },

    async selectCluster(clusterId: string | null): Promise<void> {
      const state = readState();
      state.selectedClusterId = clusterId;
      writeState(state);
    },

    async removeCluster(clusterId: string): Promise<void> {
      const state = readState();
      state.clusters = state.clusters.filter((c) => c.id !== clusterId);
      if (state.selectedClusterId === clusterId) {
        state.selectedClusterId = state.clusters[0]?.id ?? null;
      }
      writeState(state);
    },

    async openExternal(url: string): Promise<void> {
      window.open(url, '_blank', 'noreferrer');
    },

    appMode: {
      async get(): Promise<AppMode | null> {
        const stored = sessionStorage.getItem(APP_MODE_KEY);
        if (stored === 'user' || stored === 'developer') return stored;
        if (scenario().startsWith('catalogue')) return 'user';
        return scenario() === 'first-run' ? null : 'developer';
      },
      async set(mode: AppMode): Promise<void> {
        sessionStorage.setItem(APP_MODE_KEY, mode);
      },
    },

    catalogue: {
      async fetchCatalogue() {
        if (scenario() === 'catalogue-loading') await sleep(60_000);
        return catalogueFixture;
      },
      async cacheVerified(pair, generation, verifiedAt) {
        catalogueCache = {
          ...pair,
          source: 'mock',
          highestGeneration: Math.max(catalogueCache?.highestGeneration ?? 0, generation),
          maxSeenWallClock:
            !catalogueCache?.maxSeenWallClock || Date.parse(verifiedAt) > Date.parse(catalogueCache.maxSeenWallClock)
              ? verifiedAt
              : catalogueCache.maxSeenWallClock,
        };
      },
    },

    installedApps: {
      async list() {
        await sleep(40);
        return installedApps;
      },
      async installBundle(source, _target, options) {
        await sleep(120);
        const catalogueApp = source.startsWith('https://');
        const next = catalogueApp
          ? mockInstalledApp(source.split('://')[1]?.split('.')[0] ?? 'catalogue-app', 'Catalogue App', '1.0.0', 'MIT')
          : mockInstalledApp('local-tool', 'Local Tool', '0.1.0', 'MIT', {
              publisher: { name: 'Local developer', tier: 'unknown' },
              source: 'file',
              verification: { signature: 'unsigned' },
            });
        if (next.publisher.tier === 'unknown' && !options?.acceptUnknownPublisher) {
          throw new Error(
            `UNKNOWN_PUBLISHER:${JSON.stringify({
              appId: next.appId,
              name: next.name,
              version: next.version,
              license: next.license,
              source: next.source,
              digest: next.digest,
              signature: 'unsigned',
              publisher: next.publisher.name,
              controlsSummary: next.controlsSummary,
            })}`
          );
        }
        if (next.publisher.tier === 'unknown') next.lastWarnedAt = new Date().toISOString();
        installedApps = [
          ...installedApps.filter((item) => item.app.appId !== next.appId),
          { app: next, state: 'stopped', urls: [], ui: { type: 'none' } },
        ];
        return next;
      },
      async uninstall(app) {
        installedApps = installedApps.filter((item) => item.app.appId !== app && item.app.name !== app);
      },
      async run(app, _target, options) {
        const item = installedApps.find((candidate) => candidate.app.appId === app || candidate.app.name === app);
        if (!item) throw new Error(`Mock installed app not found: ${app}`);
        if (item.app.publisher.tier === 'unknown' && !item.app.lastWarnedAt && !options?.acceptUnknownPublisher) {
          throw new Error('UNKNOWN_PUBLISHER:{}');
        }
        item.app.lastWarnedAt =
          item.app.publisher.tier === 'unknown' && options?.rememberUnknownPublisher
            ? new Date().toISOString()
            : item.app.lastWarnedAt;
        item.state = 'running';
        item.urls = ['http://127.0.0.1:8443'];
        return { appId: item.app.appId, urls: item.urls };
      },
      async openWindow(app, target) {
        const item = installedApps.find((candidate) => candidate.app.appId === app);
        if (!item) throw new Error(`Mock installed app not found: ${app}`);
        const descriptor = mockAppWindowDescriptor(item, target);
        window.open(
          `/?mock-host&scenario=${item.state === 'exited' ? 'app-exited' : 'app-window'}&app-window=${encodeMockAppWindowDescriptor(descriptor)}`,
          '_blank',
          'popup,width=1100,height=720'
        );
        return descriptor;
      },
      async windowStatus(app, target) {
        const item = installedApps.find((candidate) => candidate.app.appId === app);
        if (!item) throw new Error(`Mock installed app not found: ${app}`);
        return mockAppWindowDescriptor(item, target);
      },
      async stop(app) {
        const item = installedApps.find((candidate) => candidate.app.appId === app);
        if (item) {
          item.state = 'stopped';
          item.urls = [];
        }
      },
      async pickBundle() {
        return '/private/tmp/unsigned-local.appliance.zip';
      },
    },

    // Simulated self-update so the Settings "Check for updates" panel can
    // be developed in a browser. Advertises a bump over the bundled
    // version, then streams a fake download with byte-level progress so
    // the determinate progress bar and "Restart" CTA are exercised.
    // `?scenario=` doesn't gate this — it always offers an update so the
    // happy path is reachable; flip `MOCK_UPDATE_AVAILABLE` to false to
    // QA the "you're up to date" branch.
    updater: {
      async check() {
        await sleep(700);
        if (!MOCK_UPDATE_AVAILABLE) return null;
        // The desktop Vite build doesn't inline __APPLIANCE_VERSION__
        // (that define lives in @appliance.sh/app's build), so the mock
        // uses a fixed pair rather than reading the real running
        // version — only the panel's rendering matters here.
        const current = MOCK_CURRENT_VERSION;
        return {
          version: bumpMinor(current),
          currentVersion: current,
          notes: 'mock: faster cluster switcher, microVM egress log fixes, and this very updater panel.',
          date: new Date().toISOString(),
        };
      },
      async downloadAndInstall(onProgress) {
        const total = 48 * 1024 * 1024; // ~48 MB, like a real DMG
        let downloaded = 0;
        onProgress({ contentLength: total, downloaded });
        while (downloaded < total) {
          await sleep(120);
          downloaded = Math.min(total, downloaded + total / 20);
          onProgress({ contentLength: total, downloaded });
        }
      },
      async relaunch() {
        // A real relaunch swaps the process; in the browser, just reload.
        window.location.reload();
      },
    },

    // Agent credential login (Phase 5, L3). In-memory stand-in for the host
    // Keychain so the launcher's keyless path + the Settings panel can be
    // developed in a browser. `MOCK_HAS_HOST_CLAUDE` toggles the
    // "Sign in with Claude" gate; `runSetupToken` returns false so the UI
    // exercises the manual-command fallback (no real Terminal in a browser).
    agentAuth: {
      async status(agentType: string): Promise<AgentAuthStatus> {
        await sleep(60);
        const kind = mockAgentCreds.get(agentType);
        return kind ? { configured: true, kind } : { configured: false, kind: null };
      },
      async login(input: { agentType: string; kind: AgentAuthKind; value: string }) {
        await sleep(150);
        if (!input.value.trim()) throw new Error('refusing to store an empty credential');
        mockAgentCreds.set(input.agentType, input.kind);
      },
      async logout(agentType: string) {
        await sleep(80);
        mockAgentCreds.delete(agentType);
      },
      async hasHostClaude() {
        await sleep(60);
        return MOCK_HAS_HOST_CLAUDE;
      },
      async runSetupToken() {
        await sleep(80);
        return false; // no real Terminal in a browser → manual-command fallback
      },
    },

    bootstrap: {
      async run(_input, _options, onEvent) {
        const emit = (event: BootstrapEvent) => onEvent(event);
        emit({ type: 'phase-started', phase: 'phase1' });
        emit({ type: 'log', level: 'info', message: 'mock: provisioning installer stack' });
        await sleep(800);
        emit({ type: 'phase-started', phase: 'phase2' });
        emit({ type: 'log', level: 'info', message: 'mock: deploying api-server appliance' });
        await sleep(800);
        return {
          stateBackendUrl: 's3://mock-state-bucket',
          apiServerUrl: 'https://api.mock.appliance.sh',
          apiKey: { id: 'apikey_mock', secret: 'sk_mock' },
        } as BootstrapResult;
      },
      async promoteState() {
        await sleep(500);
      },
      async demoteState() {
        await sleep(500);
      },
      async updateApiServer() {
        await sleep(500);
      },
      async updateBaseline() {
        await sleep(500);
      },
      async listAwsProfiles() {
        return [
          { name: 'default', isSso: false, source: 'credentials' as const },
          { name: 'work-sso', isSso: true, source: 'config' as const },
        ];
      },
      async teardown(_input, onEvent) {
        const emit = (event: BootstrapEvent) => onEvent(event);
        emit({ type: 'log', level: 'info', message: 'mock: destroying installer stack' });
        await sleep(500);
        emit({ type: 'resource', op: 'delete', resourceType: 'aws:s3/bucket:Bucket', name: 'state' });
        await sleep(400);
        emit({ type: 'resource', op: 'delete', resourceType: 'aws:cloudfront/distribution:Distribution', name: 'cdn' });
        await sleep(400);
        emit({ type: 'log', level: 'info', message: 'mock: stack destroyed' });
      },
    },

    local: {
      async preflight() {
        return preflight();
      },

      async installPrereq(tools, onEvent) {
        const targets = tools ?? ['kubectl'];
        for (const tool of targets) {
          onEvent({ type: 'progress', stage: tool, message: `Downloading ${tool} (mock)` });
          await sleep(600);
        }
        return {
          outcomes: targets.map((tool) => ({
            tool,
            status: 'installed' as const,
            message: 'Installed (mock)',
          })),
        };
      },

      async startContainerRuntime() {
        if (scenario() === 'daemon-manual') {
          throw new Error(
            'Docker isn’t running. Start your container runtime — Docker Desktop, OrbStack, or `colima start` — and retry.'
          );
        }
        await sleep(1_500);
        getRuntime().daemonRunning = true;
      },

      async pickDirectory() {
        return '/Users/dev/projects/demo-node-container';
      },

      async readApplianceManifest(path: string) {
        return {
          manifest: 'v1',
          name: 'demo-node-container',
          type: 'container',
          port: 3000,
          platform: 'linux/arm64',
          manifestPath: `${path}/appliance.json`,
        };
      },

      async packageAndUploadBuild(input, onEvent) {
        // Mirror the sidecar-CLI flow: package the source zip, then PUT
        // it to the one-time upload URL. The image is built server-side.
        onEvent({ type: 'log', stream: 'meta', message: `$ appliance build --upload-url … (${input.path})` });
        const lines = [
          'Packaging framework source (built server-side).',
          'Built: appliance.zip (1.2 MB)',
          'Uploading source (1.2 MB)…',
          'Source uploaded.',
        ];
        for (const line of lines) {
          await sleep(300);
          onEvent({ type: 'log', stream: 'meta', message: line });
        }
      },

      // Stand-in for the bundled `appliance deploy` shell (AWS/bundle cloud
      // base). Streams the CLI's real output shape so the wizard's AWS
      // one-click path + its live log pane can be QA'd in a browser.
      async deployToCloud(input, onEvent) {
        onEvent({
          type: 'log',
          stream: 'meta',
          message: `$ appliance deploy ${input.project} ${input.environment} --profile ${input.profile} --yes`,
        });
        const lines = [
          'No appliance.zip found — building first.',
          'Built: appliance.zip (2.4 MB)',
          `Using existing project: ${input.project}`,
          'Uploading build (2.4 MB)...',
          'Build uploaded: build_mock',
          `Deploying ${input.project}/${input.environment} — pending`,
          `Deploying ${input.project}/${input.environment} — in_progress`,
          `▲ Deployed ${input.project}/${input.environment}`,
          `  URL: https://${input.project}.mock.appliance.sh`,
        ];
        for (const message of lines) {
          await sleep(350);
          onEvent({ type: 'log', stream: 'stdout', message });
        }
      },
    },

    vm: {
      async list() {
        await sleep(80);
        if (scenario() === 'user-mode-no-vm') return [];
        return Object.values(microVms).map((vm) => ({
          name: vm.name,
          running: vm.running,
          clusterProvisioned: vm.clusterProvisioned,
          clusterReady: vm.running && vm.clusterProvisioned,
          phase: vm.running ? ('ready' as const) : undefined,
          hostPort: vm.hostPort,
          apiPort: vm.apiPort,
          registryPort: vm.registryPort,
          egressPort: vm.egressPort,
          clusterId: vm.name === 'appliance' ? 'microvm' : `microvm-${vm.name}`,
        }));
      },
      async install() {
        await sleep(800);
      },
      instance(name?: string) {
        const vm = mockVm(name ?? 'appliance');
        return {
          name: vm.name,
          async status() {
            await sleep(60);
            return {
              available: true,
              installable: false,
              exists: vm.exists,
              running: vm.running,
              clusterProvisioned: vm.clusterProvisioned,
              kubeconfigReady: vm.running && vm.clusterProvisioned,
              phase: vm.running ? ('ready' as const) : undefined,
              dev: vm.dev,
              // Mock a shared workspace for dev VMs so the agent launcher
              // (gated on devMount) is exercisable in the browser shell.
              devMount: vm.dev ? `/Users/you/projects/${vm.name}` : undefined,
              apiServerUrl: `http://api.appliance.localhost:${vm.hostPort}`,
            };
          },
          async up(onEvent: (event: { message: string }) => void) {
            const lines = [
              `starting VM '${vm.name}' (host pid 4242)`,
              'waiting for core sandbox......',
              `VM '${vm.name}' is up`,
              '✓ core sandbox ready; deployment layer is lazy',
            ];
            for (const message of lines) {
              await sleep(400);
              onEvent({ message });
            }
            vm.exists = true;
            vm.running = true;
          },
          async devUp(onEvent: (event: { message: string }) => void, opts?: { mount?: string }) {
            const lines = [
              `starting VM '${vm.name}' as a dev environment (host pid 4242)`,
              'waiting for core sandbox......',
              `VM '${vm.name}' is up`,
              '» provisioning dev toolchain in the workspace',
              ...(opts?.mount ? [`» sharing host folder ${opts.mount} into /persist/workspace`] : []),
              '✓ core dev environment ready; deployment layer is lazy',
            ];
            for (const message of lines) {
              await sleep(400);
              onEvent({ message });
            }
            vm.exists = true;
            vm.running = true;
            vm.dev = true;
          },
          async clusterUp(onEvent: (event: { message: string }) => void) {
            const profile = vm.name === 'appliance' ? 'microvm' : `microvm-${vm.name}`;
            const lines = [
              `promoting VM '${vm.name}' to the deployment layer`,
              `stopping VM '${vm.name}' for one-way promotion`,
              'waiting for kubernetes endpoint......',
              '» provisioning registry, BuildKit, and api-server',
              `✓ deployment layer ready; credentials saved to profile ${profile}`,
            ];
            for (const message of lines) {
              await sleep(400);
              onEvent({ message });
            }
            vm.exists = true;
            vm.running = true;
            vm.clusterProvisioned = true;
            registerMockMicroVmCluster(vm);
          },
          async cleanupShell() {
            // Best-effort sweep of debugger pods a shell leaves behind; a no-op in the mock.
            await sleep(120);
          },
          async stop() {
            await sleep(800);
            vm.running = false;
          },
          async remove() {
            await sleep(800);
            vm.running = false;
            vm.exists = false;
            delete microVms[vm.name];
            unregisterMockMicroVmCluster(vm.name);
          },
          egress: {
            async get() {
              await sleep(100);
              const netLink = vm.egress.netLink ?? 'nat';
              return { ...vm.egress, netLink, enforced: netLink === 'netstack' };
            },
            async setDefault(action: 'allow' | 'deny') {
              await sleep(150);
              vm.egress.default = action;
            },
            async addRule(action: 'allow' | 'deny', host: string) {
              await sleep(150);
              const list = action === 'allow' ? vm.egress.allow : vm.egress.deny;
              if (!list.includes(host)) list.push(host);
            },
            async removeRule(host: string) {
              await sleep(150);
              vm.egress.allow = vm.egress.allow.filter((h) => h !== host);
              vm.egress.deny = vm.egress.deny.filter((h) => h !== host);
            },
            async setMitm(enabled: boolean) {
              await sleep(150);
              vm.egress.mitm = enabled;
              vm.egress.caPath = enabled ? `~/.appliance/vm/${vm.name}/egress-ca.pem` : undefined;
            },
            async reset() {
              await sleep(150);
              // Clears the operator's persisted rules; the net link (and so
              // the enforced default-DENY boundary for a Netstack VM) is
              // unchanged.
              vm.egress = { default: 'allow', allow: [], deny: [], mitm: false, netLink: vm.egress.netLink };
            },
            async log(tail?: number) {
              await sleep(100);
              const now = Date.now();
              const events = [
                {
                  ts: now - 60_000,
                  host: 'api.anthropic.com',
                  port: 443,
                  method: 'POST',
                  path: '/v1/messages',
                  decision: 'mitm' as const,
                },
                { ts: now - 50_000, host: 'github.com', port: 443, method: 'CONNECT', decision: 'allow' as const },
                // Repeated + multiple denied destinations so the
                // denied-attempts roll-up shows counts + recency.
                {
                  ts: now - 40_000,
                  host: 'telemetry.evil.test',
                  port: 443,
                  method: 'CONNECT',
                  decision: 'deny' as const,
                },
                {
                  ts: now - 30_000,
                  host: 'telemetry.evil.test',
                  port: 443,
                  method: 'CONNECT',
                  decision: 'deny' as const,
                },
                {
                  ts: now - 20_000,
                  host: 'telemetry.evil.test',
                  port: 443,
                  method: 'CONNECT',
                  decision: 'deny' as const,
                },
                {
                  ts: now - 10_000,
                  host: 'pkgs.example.test',
                  port: 443,
                  method: 'CONNECT',
                  decision: 'deny' as const,
                },
              ];
              return events.slice(-(tail ?? 200));
            },
            async clearLog() {
              await sleep(50);
            },
          },
          creds: {
            async list() {
              await sleep(100);
              return {
                rules: [...vm.creds.rules],
                secrets: vm.creds.secrets.map((s) => ({ ...s })),
              };
            },
            async add(rule: { host: string; capture: boolean; inject: boolean; header?: string; helper?: string }) {
              await sleep(120);
              const next = {
                host: rule.host,
                capture: rule.capture,
                inject: rule.inject,
                header: rule.header || 'authorization',
                helper: rule.helper,
              };
              const i = vm.creds.rules.findIndex((r) => r.host === rule.host);
              if (i >= 0) vm.creds.rules[i] = next;
              else vm.creds.rules.push(next);
            },
            async remove(host: string) {
              await sleep(120);
              vm.creds.rules = vm.creds.rules.filter((r) => r.host !== host);
            },
            async setSecret(host: string, value: string, header?: string) {
              await sleep(120);
              const h = (header || 'authorization').toLowerCase();
              const masked = value.length > 4 ? `••••${value.slice(-4)}` : '••••';
              const i = vm.creds.secrets.findIndex((s) => s.host === host && s.header === h);
              const rec = { host, header: h, masked };
              if (i >= 0) vm.creds.secrets[i] = rec;
              else vm.creds.secrets.push(rec);
            },
            async forget() {
              await sleep(80);
              vm.creds.secrets = [];
            },
          },
          agent: {
            async start(input: AgentLaunchInput) {
              await sleep(400);
              vm.agents.push({
                id: input.sessionId.replace(/^agent-/, ''),
                type: input.type ?? 'claude-code',
                task: input.task,
                status: 'running',
                sessionId: input.sessionId,
                mode: 'interactive',
                live: true,
              });
            },
            async list(): Promise<AgentInfo[]> {
              await sleep(80);
              return vm.agents.map((a) => ({ ...a }));
            },
            async stop(id: string) {
              await sleep(120);
              const bare = id.replace(/^agent-/, '');
              const agent = vm.agents.find((a) => a.id === bare || a.sessionId === id);
              if (agent) {
                agent.status = 'exited';
                agent.live = false;
              }
            },
          },
        };
      },
    },
  };
}

function mockAppWindowDescriptor(item: InstalledRuntimeApp, target: string): RuntimeAppWindowDescriptor {
  return {
    appId: item.app.appId,
    target,
    name: item.app.name,
    version: item.app.version,
    license: item.app.license,
    ui: item.ui,
    state: item.state,
    ...(item.exitCode == null ? {} : { exitCode: item.exitCode }),
    ...(item.urls[0] ? { url: item.urls[0], hostPort: Number(new URL(item.urls[0]).port) } : {}),
    egressHostCount: item.app.controlsSummary.egressHosts.length,
  };
}

function encodeMockAppWindowDescriptor(descriptor: RuntimeAppWindowDescriptor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(descriptor));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// MicroVM mock state (module-level: survives SPA navigation, resets on
// reload like the rest of the mock). Keyed by VM name so the browser
// dev shell can exercise the multi-VM UI — one VM for interactive dev,
// one for traffic testing.
interface MockVm {
  name: string;
  exists: boolean;
  running: boolean;
  clusterProvisioned: boolean;
  /** Provisioned as a development environment (`appliance vm dev up`). */
  dev: boolean;
  hostPort: number;
  apiPort: number;
  registryPort: number;
  egressPort: number;
  egress: {
    default: 'allow' | 'deny';
    allow: string[];
    deny: string[];
    mitm: boolean;
    caPath?: string;
    /** Mirrors the VM's resolved net link; drives the enforced-boundary UI. */
    netLink?: 'netstack' | 'nat';
  };
  creds: {
    rules: Array<{ host: string; capture: boolean; inject: boolean; header: string; helper?: string }>;
    secrets: Array<{ host: string; header: string; masked: string }>;
  };
  /** Coding agents launched into this VM (Phase 5, A5). */
  agents: AgentInfo[];
}

const microVms: Record<string, MockVm> = {
  appliance: {
    name: 'appliance',
    exists: true,
    // Default browser scenario: a fast core sandbox is already running,
    // so Egress, Credentials, and Facts are visibly available while
    // Workloads and deploy remain gated on cluster provisioning.
    running: true,
    clusterProvisioned: false,
    dev: false,
    hostPort: 8081,
    apiPort: 6443,
    registryPort: 5052,
    egressPort: 5053,
    egress: { default: 'allow', allow: [], deny: [], mitm: false },
    creds: {
      rules: [{ host: 'api.openai.com', capture: true, inject: true, header: 'authorization' }],
      secrets: [{ host: 'api.openai.com', header: 'authorization', masked: '••••k7Qx' }],
    },
    agents: [],
  },
  traffic: {
    name: 'traffic',
    exists: true,
    running: true,
    clusterProvisioned: true,
    dev: false,
    hostPort: 8100,
    apiPort: 8101,
    registryPort: 8102,
    egressPort: 8103,
    egress: {
      // A Netstack VM: the host netstack is the enforced boundary
      // (default-DENY + baked allowlist). `api.anthropic.com` + `github.com`
      // are baked; the operator added `internal.example.test` and a deny.
      default: 'deny',
      allow: ['api.anthropic.com', 'github.com', 'internal.example.test'],
      deny: ['telemetry.evil.test'],
      mitm: true,
      caPath: '~/.appliance/vm/traffic/egress-ca.pem',
      netLink: 'netstack',
    },
    creds: { rules: [], secrets: [] },
    agents: [],
  },
};

/** Look up (or lazily create) a mock VM by name, so `instance('new')`
 *  followed by `up()` materializes a VM the way the real engine does. */
function mockVm(name: string): MockVm {
  let vm = microVms[name];
  if (!vm) {
    // Mirror the allocator: pick the next free 4-port block from 8100.
    const used = new Set(Object.values(microVms).flatMap((v) => [v.hostPort]));
    let slot = 0;
    while (used.has(8100 + slot * 4)) slot += 1;
    const base = 8100 + slot * 4;
    vm = {
      name,
      exists: false,
      running: false,
      clusterProvisioned: false,
      dev: false,
      hostPort: base,
      apiPort: base + 1,
      registryPort: base + 2,
      egressPort: base + 3,
      egress: { default: 'allow', allow: [], deny: [], mitm: false },
      creds: { rules: [], secrets: [] },
      agents: [],
    };
    microVms[name] = vm;
  }
  return vm;
}
