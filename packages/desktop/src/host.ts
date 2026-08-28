import { invoke, Channel } from '@tauri-apps/api/core';
import { open as openShell } from '@tauri-apps/plugin-shell';
import { sendNotification } from '@tauri-apps/plugin-notification';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { check as checkForUpdate, type Update } from '@tauri-apps/plugin-updater';
import { relaunch as relaunchApp } from '@tauri-apps/plugin-process';
import { waitForPublishedPort, type RuntimeAppWindowDescriptor } from '@appliance.sh/app';
import type {
  AvailableUpdate,
  UpdateProgress,
  MicroVmStatus,
  MicroVmSummary,
  AgentInfo,
  AgentLaunchInput,
  AgentAuthStatus,
  AgentAuthKind,
  AppMode,
  AddClusterInput,
  ApiServerUpdateInput,
  ApiServerUpdateOptions,
  AwsProfile,
  BaselineUpdateInput,
  BaselineUpdateOptions,
  BootstrapEvent,
  BootstrapInput,
  BootstrapOptions,
  BootstrapResult,
  Cluster,
  CatalogueFetchResult,
  ConsoleHost,
  HostConfig,
  HostPlatform,
  InstalledRuntimeApp,
  RuntimeOpenResult,
  LatestGhcrTagInput,
  LocalApplianceManifest,
  LocalDeployToCloudInput,
  LocalPackageUploadInput,
  LocalHelperInstallResult,
  LocalLogEvent,
  LocalPreflightCheck,
  StateDemotionInput,
  StateDemotionOptions,
  StatePromotionInput,
  StatePromotionOptions,
  TeardownInput,
  EgressPolicy,
  EgressEvent,
  CredentialsState,
  TerminalEvent,
  TerminalOpenOptions,
  TerminalSession,
  TerminalSessionInfo,
} from '@appliance.sh/app';
import type { EntitlementRecord, EntitlementSuggestion } from '@appliance.sh/sdk';

interface NativeCatalogueCache {
  indexJson: string;
  signatureJson: string;
  fetchedAt: string;
  highestGeneration: number;
  maxSeenWallClock: string;
}

// Tauri host: each cluster's URL/name lives in a JSON config file
// under the app config dir; each cluster's API key lives in the OS
// keychain at account `cluster:<id>`. Both are read/written through
// Rust commands defined in src-tauri/src/lib.rs. Bootstrap runs
// through a Node sidecar the Rust side spawns — progress events
// stream back over a Tauri Channel.
export const tauriHost: Omit<ConsoleHost, 'platform'> = {
  async getConfig(): Promise<HostConfig> {
    return invoke<HostConfig>('get_config');
  },

  async addCluster(input: AddClusterInput): Promise<Cluster> {
    return invoke<Cluster>('add_cluster', { input });
  },

  async selectCluster(clusterId: string | null): Promise<void> {
    await invoke('select_cluster', { clusterId });
  },

  async removeCluster(clusterId: string): Promise<void> {
    await invoke('remove_cluster', { clusterId });
  },

  async setClusterStateBackend(clusterId: string, url: string | null): Promise<void> {
    await invoke('set_cluster_state_backend', { clusterId, url });
  },

  async openExternal(url) {
    await openShell(url);
  },

  async notify({ title, body }) {
    await sendNotification({ title, body });
  },

  appMode: {
    get() {
      return invoke<AppMode | null>('get_app_mode');
    },
    async set(mode: AppMode) {
      await invoke('set_app_mode', { mode });
    },
  },

  catalogue: {
    async fetchCatalogue(): Promise<CatalogueFetchResult> {
      const origin = 'https://www.appliance.sh';
      const nativeCache = await invoke<NativeCatalogueCache | null>('get_catalogue_cache');
      const cached: CatalogueFetchResult | null = nativeCache ? { ...nativeCache, source: 'cache' } : null;
      try {
        const [indexResponse, signatureResponse] = await Promise.all([
          fetch(`${origin}/catalogue/index.json`, { headers: { Accept: 'application/json' } }),
          fetch(`${origin}/catalogue/index.json.sig`, { headers: { Accept: 'application/json' } }),
        ]);
        if (!indexResponse.ok || !signatureResponse.ok) {
          throw new Error(`catalogue refresh failed (${indexResponse.status}/${signatureResponse.status})`);
        }
        return {
          indexJson: await indexResponse.text(),
          signatureJson: await signatureResponse.text(),
          fetchedAt: new Date().toISOString(),
          source: 'network',
          highestGeneration: cached?.highestGeneration,
          maxSeenWallClock: cached?.maxSeenWallClock,
        };
      } catch (cause) {
        if (!cached) throw cause;
        return {
          ...cached,
          source: 'cache',
          refreshError: cause instanceof Error ? cause.message : 'catalogue refresh failed',
        };
      }
    },
    async cacheVerified(pair: CatalogueFetchResult, generation: number, verifiedAt: string): Promise<void> {
      // The native host writes the exact pair atomically under
      // ~/.appliance/catalogue and advances both rollback floors monotonically.
      await invoke('set_catalogue_cache', {
        input: {
          indexJson: pair.indexJson,
          signatureJson: pair.signatureJson,
          fetchedAt: pair.fetchedAt,
          generation,
          verifiedAt,
        },
      });
    },
  },

  installedApps: {
    list(target: string) {
      return invoke<InstalledRuntimeApp[]>('runtime_installed_list', { target });
    },
    installBundle(source: string, target: string, options) {
      return invoke('runtime_install_bundle', {
        input: {
          source,
          target,
          acceptUnknownPublisher: options?.acceptUnknownPublisher ?? false,
          grantIds: options?.grantIds,
        },
      });
    },
    async uninstall(app: string, target: string, options) {
      await invoke('runtime_uninstall_bundle', {
        input: { app, target, keepData: options?.keepData ?? false },
      });
    },
    run(app: string, target: string, options) {
      return invoke<RuntimeOpenResult>('runtime_run_installed', {
        input: {
          app,
          target,
          acceptUnknownPublisher: options?.acceptUnknownPublisher ?? false,
          rememberUnknownPublisher: options?.rememberUnknownPublisher ?? false,
        },
      });
    },
    async openWindow(app: string, target: string, openMetric) {
      const resolved = await invoke<RuntimeAppWindowDescriptor>('runtime_open_descriptor', {
        selector: app,
        target,
      });
      const descriptor = openMetric ? { ...resolved, openMetric } : resolved;
      if (descriptor.ui.type !== 'web' || !descriptor.url) return descriptor;
      await waitForPublishedPort(async () => {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 500);
        try {
          await fetch(descriptor.url!, { mode: 'no-cors', signal: controller.signal });
          return true;
        } catch {
          return false;
        } finally {
          window.clearTimeout(timeout);
        }
      });
      await invoke('runtime_open_window', { descriptor, stopOnClose: false });
      return descriptor;
    },
    windowStatus(app: string, target: string) {
      return invoke<RuntimeAppWindowDescriptor>('runtime_open_descriptor', { selector: app, target });
    },
    async stop(app: string) {
      await invoke('runtime_stop_installed', { app });
    },
    async pickBundle() {
      const picked = await openDialog({
        directory: false,
        multiple: false,
        title: 'Install an Appliance bundle',
        filters: [{ name: 'Appliance bundle', extensions: ['appliance.zip', 'zip'] }],
      });
      return typeof picked === 'string' ? picked : null;
    },
  },

  entitlements: {
    list() {
      return invoke<EntitlementRecord[]>('runtime_entitlements_list');
    },
    suggestions(days = 30) {
      return invoke<EntitlementSuggestion[]>('runtime_entitlements_suggestions', { days });
    },
    async revoke(appId, grantId) {
      await invoke('runtime_entitlements_revoke', { appId, grantId });
    },
  },

  bootstrap: {
    async run(
      input: BootstrapInput,
      options: BootstrapOptions | undefined,
      onEvent: (event: BootstrapEvent) => void
    ): Promise<BootstrapResult> {
      const channel = new Channel<BootstrapEvent>();
      channel.onmessage = onEvent;
      return invoke<BootstrapResult>('run_bootstrap', {
        input: { bootstrapInput: input, options: options ?? {} },
        onEvent: channel,
      });
    },
    async promoteState(
      input: StatePromotionInput,
      options: StatePromotionOptions | undefined,
      onEvent: (event: BootstrapEvent) => void
    ): Promise<void> {
      const channel = new Channel<BootstrapEvent>();
      channel.onmessage = onEvent;
      await invoke('promote_state', {
        input: { input, options: options ?? {} },
        onEvent: channel,
      });
    },
    async demoteState(
      input: StateDemotionInput,
      options: StateDemotionOptions | undefined,
      onEvent: (event: BootstrapEvent) => void
    ): Promise<void> {
      const channel = new Channel<BootstrapEvent>();
      channel.onmessage = onEvent;
      await invoke('demote_state', {
        input: { input, options: options ?? {} },
        onEvent: channel,
      });
    },
    async updateApiServer(
      input: ApiServerUpdateInput,
      options: ApiServerUpdateOptions | undefined,
      onEvent: (event: BootstrapEvent) => void
    ): Promise<void> {
      const channel = new Channel<BootstrapEvent>();
      channel.onmessage = onEvent;
      await invoke('update_api_server', {
        input: { input, options: options ?? {} },
        onEvent: channel,
      });
    },
    async updateBaseline(
      input: BaselineUpdateInput,
      options: BaselineUpdateOptions | undefined,
      onEvent: (event: BootstrapEvent) => void
    ): Promise<void> {
      const channel = new Channel<BootstrapEvent>();
      channel.onmessage = onEvent;
      await invoke('update_baseline', {
        input: { input, options: options ?? {} },
        onEvent: channel,
      });
    },
    async latestApiServerVersion(input?: LatestGhcrTagInput): Promise<{ version: string }> {
      const channel = new Channel<BootstrapEvent>();
      // We don't surface progress for the version lookup — but the
      // Tauri command always wires a Channel for parity with the
      // event-streaming sidecar calls.
      channel.onmessage = () => {};
      return invoke<{ version: string }>('latest_api_server_version', {
        input: { input: input ?? {} },
        onEvent: channel,
      });
    },
    async listAwsProfiles(): Promise<AwsProfile[]> {
      return invoke<AwsProfile[]>('list_aws_profiles');
    },
    async teardown(input: TeardownInput, onEvent: (event: BootstrapEvent) => void): Promise<void> {
      const channel = new Channel<BootstrapEvent>();
      channel.onmessage = onEvent;
      await invoke('teardown_cluster', { input: { input }, onEvent: channel });
    },
  },

  local: {
    async preflight(): Promise<LocalPreflightCheck[]> {
      return invoke<LocalPreflightCheck[]>('local_preflight');
    },
    async installPrereq(
      tools: string[] | undefined,
      onEvent: (event: { type: string; stage?: string; message?: string }) => void,
      opts?: { force?: boolean }
    ): Promise<LocalHelperInstallResult> {
      const channel = new Channel<{ type: string; stage?: string; message?: string }>();
      channel.onmessage = onEvent;
      return invoke<LocalHelperInstallResult>('local_helper_install', {
        input: { tools, force: opts?.force ?? false },
        onEvent: channel,
      });
    },
    async startContainerRuntime(): Promise<void> {
      await invoke('start_container_runtime');
    },
    async pickDirectory(): Promise<string | null> {
      // Tauri's dialog plugin returns the chosen folder path, or null
      // on cancel. multiple:false guarantees a single string back.
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: 'Select an appliance folder',
      });
      return typeof picked === 'string' ? picked : null;
    },
    async readApplianceManifest(path: string): Promise<LocalApplianceManifest> {
      return invoke<LocalApplianceManifest>('read_appliance_manifest', { path });
    },
    async packageAndUploadBuild(
      input: LocalPackageUploadInput,
      onEvent: (event: LocalLogEvent) => void
    ): Promise<void> {
      // The sidecar CLI emits `{type:'log', level, message}` lines
      // without a stream tag — normalize to the LocalLogEvent shape so
      // the wizard's log pane renders them like any other progress.
      const channel = new Channel<LocalLogEvent & { stream?: LocalLogEvent['stream'] }>();
      channel.onmessage = (event) => {
        if (event?.message) onEvent({ type: 'log', stream: event.stream ?? 'meta', message: event.message });
      };
      await invoke('package_and_upload_build', { input, onEvent: channel });
    },
    async deployToCloud(input: LocalDeployToCloudInput, onEvent: (event: LocalLogEvent) => void): Promise<void> {
      // Shells the SAME bundled `appliance` sidecar the helper-install /
      // agent paths use (src-tauri: app.shell().sidecar("appliance")), with
      // `deploy <project> <env> --profile <clusterId> --yes` run from the
      // project folder. The Rust side streams the CLI's stdout/stderr back
      // as LocalLogEvents over this Channel.
      const channel = new Channel<LocalLogEvent>();
      channel.onmessage = onEvent;
      await invoke('deploy_to_cloud', { input, onEvent: channel });
    },
  },

  vm: {
    list() {
      return invoke<MicroVmSummary[]>('microvm_list');
    },
    async install() {
      await invoke('microvm_install');
    },
    instance(name?: string) {
      // `name` rides along on every call; the Rust side defaults a
      // null/empty name to the canonical "appliance" VM.
      const vm = name ?? null;
      return {
        name: name ?? 'appliance',
        status() {
          return invoke<MicroVmStatus>('microvm_status', { name: vm });
        },
        async up(onEvent: (event: { message: string }) => void) {
          const channel = new Channel<{ type: string; message?: string }>();
          channel.onmessage = (event) => {
            if (event?.message) onEvent({ message: event.message });
          };
          await invoke('microvm_up', { name: vm, onEvent: channel });
        },
        async devUp(onEvent: (event: { message: string }) => void, opts?: { mount?: string }) {
          const channel = new Channel<{ type: string; message?: string }>();
          channel.onmessage = (event) => {
            if (event?.message) onEvent({ message: event.message });
          };
          await invoke('microvm_dev_up', { name: vm, mount: opts?.mount ?? null, onEvent: channel });
        },
        async clusterUp(onEvent: (event: { message: string }) => void) {
          const channel = new Channel<{ type: string; message?: string }>();
          channel.onmessage = (event) => {
            if (event?.message) onEvent({ message: event.message });
          };
          await invoke('microvm_cluster_up', { name: vm, onEvent: channel });
        },
        async cleanupShell() {
          await invoke('microvm_dev_cleanup', { name: vm });
        },
        healCredentials(failedKeyId?: string, cause?: string) {
          return invoke<boolean>('microvm_heal_credentials', {
            name: vm,
            failedKeyId: failedKeyId ?? null,
            cause: cause ?? null,
          });
        },
        stop() {
          return invoke('microvm_stop', { name: vm });
        },
        remove() {
          return invoke('microvm_delete', { name: vm });
        },
        egress: {
          get() {
            return invoke<EgressPolicy>('microvm_egress_get', { name: vm });
          },
          async setDefault(action: 'allow' | 'deny') {
            await invoke('microvm_egress_default', { name: vm, action });
          },
          async addRule(action: 'allow' | 'deny', host: string) {
            await invoke('microvm_egress_rule', { name: vm, action, host });
          },
          async removeRule(host: string) {
            await invoke('microvm_egress_remove', { name: vm, host });
          },
          async setMitm(enabled: boolean) {
            await invoke('microvm_egress_mitm', { name: vm, enabled });
          },
          async reset() {
            await invoke('microvm_egress_reset', { name: vm });
          },
          log(tail?: number) {
            return invoke<EgressEvent[]>('microvm_egress_log', { name: vm, tail: tail ?? null });
          },
          async clearLog() {
            await invoke('microvm_egress_clear_log', { name: vm });
          },
        },
        creds: {
          list() {
            return invoke<CredentialsState>('microvm_creds_list', { name: vm });
          },
          async add(rule: { host: string; capture: boolean; inject: boolean; header?: string; helper?: string }) {
            await invoke('microvm_creds_add', { name: vm, input: rule });
          },
          async remove(host: string) {
            await invoke('microvm_creds_remove', { name: vm, host });
          },
          async setSecret(host: string, value: string, header?: string) {
            await invoke('microvm_creds_set', { name: vm, host, value, header: header ?? null });
          },
          async forget() {
            await invoke('microvm_creds_forget', { name: vm });
          },
        },
        agent: {
          // Shell `appliance agent start … --no-attach` (the Rust side
          // resolves the VM's mounted workspace for --dir + the registry).
          // The caller pre-mints `sessionId` so it can attach the observe
          // tab the moment this resolves.
          async start(input: AgentLaunchInput) {
            await invoke('microvm_agent_start', {
              input: {
                name: vm,
                type: input.type ?? 'claude-code',
                task: input.task ?? null,
                sessionId: input.sessionId,
              },
            });
          },
          list() {
            return invoke<AgentInfo[]>('microvm_agent_list', { name: vm });
          },
          // Shell `appliance agent stop <id>` (the Rust side resolves the
          // VM's mounted workspace for the registry). Kills the agent's
          // tmux session and flips its registry row to `exited`.
          async stop(id: string) {
            await invoke('microvm_agent_stop', { name: vm, id });
          },
        },
      };
    },
  },

  terminal: {
    async open(opts: TerminalOpenOptions, onEvent: (event: TerminalEvent) => void): Promise<TerminalSession> {
      const channel = new Channel<TerminalEvent>();
      channel.onmessage = onEvent;
      // `opts` carries `sessionId` straight through; the Rust side appends
      // `--session <id>` to the vsock host/dev argv so the PTY attaches to
      // the named guest tmux session (E3.4).
      const id = await invoke<string>('terminal_open', { input: opts, onEvent: channel });
      return {
        id,
        write: (data: string) => invoke('terminal_write', { id, data }),
        resize: (cols: number, rows: number) => invoke('terminal_resize', { id, cols, rows }),
        // Closing the PTY kills the local `appliance-vm shell` client, which
        // only *detaches* from tmux — the guest session lives on. Explicit
        // destruction goes through `kill`.
        close: () => invoke('terminal_close', { id }),
      };
    },
    list(vmName?: string): Promise<TerminalSessionInfo[]> {
      return invoke<TerminalSessionInfo[]>('terminal_sessions', { name: vmName ?? null });
    },
    async kill(vmName: string | undefined, id: string): Promise<void> {
      await invoke('terminal_kill_session', { name: vmName ?? null, id });
    },
  },

  updater: {
    async check(): Promise<AvailableUpdate | null> {
      // `check()` pulls + verifies the signed manifest from the
      // `plugins.updater.endpoints` feed. It resolves to null when the
      // running build is already current, and to an Update handle (which
      // we stash for downloadAndInstall) when a newer signed bundle
      // exists. A bad pubkey / unreachable feed throws — surfaced to the
      // Settings panel verbatim.
      const update = await checkForUpdate();
      pendingUpdate = update;
      if (!update) return null;
      return {
        version: update.version,
        currentVersion: update.currentVersion,
        // The plugin exposes the manifest's release notes as `body`.
        notes: update.body || undefined,
        date: update.date || undefined,
      };
    },
    async downloadAndInstall(onProgress: (progress: UpdateProgress) => void): Promise<void> {
      if (!pendingUpdate) {
        // Defensive: the UI only enables install after a successful
        // check, but a stale render could call through. Re-resolve so
        // we never install an unverified bundle.
        pendingUpdate = await checkForUpdate();
      }
      if (!pendingUpdate) {
        throw new Error('No pending update — run a check first.');
      }
      let downloaded = 0;
      let contentLength: number | undefined;
      // The plugin streams typed progress events: Started carries the
      // (optional) Content-Length, Progress carries each chunk's size,
      // Finished closes the transfer. Accumulate into the host's
      // UpdateProgress shape the React panel renders.
      await pendingUpdate.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            contentLength = event.data.contentLength;
            downloaded = 0;
            onProgress({ contentLength, downloaded });
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            onProgress({ contentLength, downloaded });
            break;
          case 'Finished':
            onProgress({ contentLength, downloaded: contentLength ?? downloaded });
            break;
          default:
            break;
        }
      });
    },
    async relaunch(): Promise<void> {
      await relaunchApp();
    },
  },

  // Host-side agent credential login (Phase 5, L3 / multi-agent G3). Stores
  // each agent's credential under ITS OWN provider store — the same per-provider
  // Keychain item / 0600 file the CLI's `writeAgentKey(provider, value, kind)`
  // uses — so three agents' credentials never collide. `agentType` selects the
  // provider (claude-code→anthropic, copilot→github-copilot, codex→openai). The
  // value never enters the VM; the egress broker injects it host-side. The Rust
  // side never logs the value.
  agentAuth: {
    status(agentType: string): Promise<AgentAuthStatus> {
      return invoke<AgentAuthStatus>('microvm_agent_login_status', { agentType });
    },
    async login(input: { agentType: string; kind: AgentAuthKind; value: string }): Promise<void> {
      await invoke('microvm_agent_login', { agentType: input.agentType, kind: input.kind, value: input.value });
    },
    async logout(agentType: string): Promise<void> {
      await invoke('microvm_agent_logout', { agentType });
    },
    hasHostClaude(): Promise<boolean> {
      return invoke<boolean>('microvm_agent_has_host_claude');
    },
    runSetupToken(): Promise<boolean> {
      return invoke<boolean>('microvm_agent_run_setup_token');
    },
  },
};

/** Resolve immutable OS copy before the shared React tree is mounted. */
export async function createTauriHost(): Promise<ConsoleHost> {
  const platform = await invoke<HostPlatform>('host_platform');
  return { ...tauriHost, platform };
}

// The Update handle resolved by the most recent `updater.check()`.
// downloadAndInstall needs the same handle check() produced (it carries
// the verified download URL + signature), so we keep it module-scoped
// between the two calls rather than round-tripping it through React.
let pendingUpdate: Update | null = null;
