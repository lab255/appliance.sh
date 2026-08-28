import type {
  ApiServerUpdateInput,
  ApiServerUpdateOptions,
  BaselineUpdateInput,
  BaselineUpdateOptions,
  BootstrapEvent,
  BootstrapInput,
  BootstrapOptions,
  BootstrapPhase,
  BootstrapPriorOutputs,
  BootstrapResult,
  LatestGhcrTagInput,
  StateDemotionInput,
  StateDemotionOptions,
  StatePromotionInput,
  StatePromotionOptions,
} from '@appliance.sh/bootstrap';

// A cluster is one (api-server URL, API key) pair the user has either
// connected to manually or bootstrapped from this shell. Identity is a
// stable local UUID — the api-server doesn't know it; it's just how
// the shell keys storage (config + keychain) and references the
// cluster from the UI.
export interface Cluster {
  id: string;
  name: string;
  apiServerUrl: string;
  createdAt: string;
  // Pulumi state backend URL (e.g. `s3://us-east-1-state-...`)
  // for clusters bootstrapped from this device. Settings drives
  // post-hoc state promotion (phase 3) against this URL when the
  // bootstrap wizard skipped phase 3 or it failed mid-run. Absent
  // for clusters added manually via Connect.
  stateBackendUrl?: string;
  // Original BootstrapInput the wizard collected. Persisted so the
  // Settings page can run baseline updates against this cluster
  // without forcing the operator to re-enter dns.createZone/etc.
  // (which would risk flipping declarative state). Absent for
  // clusters added via Connect or migrated from older shells.
  lastBootstrapInput?: BootstrapInput;
  installGeneration?: 'cloudformation-v1';
  cloudFormationStackName?: string;
  awsAccountId?: string;
  awsRegion?: string;
}

export interface HostConfig {
  clusters: Cluster[];
  selectedClusterId: string | null;
  // The selected cluster's key, denormalised onto the config so
  // useApplianceClient can construct an SDK client without a second
  // host round-trip per render. Null when no cluster is selected.
  apiKey: { id: string; secret: string } | null;
}

/** Which audience the desktop shell is currently tailored for. */
export type AppMode = 'user' | 'developer';

/**
 * Per-machine desktop preference for the app's audience mode. Optional:
 * browser/web consoles deliberately omit it and always use developer mode.
 * `null` means a desktop has not made its first-run choice yet.
 */
export interface AppModeHost {
  get(): Promise<AppMode | null>;
  set(mode: AppMode): Promise<void>;
}

export interface CatalogueFetchResult {
  /** Exact UTF-8 documents fetched/cached as one pair; the host never parses them. */
  indexJson: string;
  signatureJson: string;
  fetchedAt: string;
  source: 'network' | 'cache' | 'mock';
  refreshError?: string;
  highestGeneration?: number;
  maxSeenWallClock?: string;
  /** DEV mock only. Production callers must use the binary's pinned policy. */
  developmentTrustPolicy?: {
    keys: Readonly<Record<string, string>>;
    generationFloor: number;
  };
}

export interface CatalogueHost {
  fetchCatalogue(): Promise<CatalogueFetchResult>;
  /** Atomically retain only a pair the shared trust verifier accepted. */
  cacheVerified?(pair: CatalogueFetchResult, generation: number, verifiedAt: string): Promise<void>;
  /** AP-173 owns the real installer; absent means the UI must not fake success. */
  installBundle?(path: string): Promise<void>;
}

export interface AddClusterInput {
  name: string;
  apiServerUrl: string;
  apiKey: { id: string; secret: string };
  stateBackendUrl?: string;
  lastBootstrapInput?: BootstrapInput;
  installGeneration?: 'cloudformation-v1';
  cloudFormationStackName?: string;
  awsAccountId?: string;
  awsRegion?: string;
}

// Drives a bootstrap run from the UI. Tauri host implements this by
// spawning the Node sidecar; web host omits the capability entirely
// (bootstrap needs local AWS creds + a local Pulumi, neither of
// which the browser can provide — the Connect page points users at
// the CLI instead).
export interface BootstrapHost {
  run(
    input: BootstrapInput,
    options: BootstrapOptions | undefined,
    onEvent: (event: BootstrapEvent) => void
  ): Promise<BootstrapResult>;
  /**
   * Run phase 3 (state promotion) standalone. Drives the same
   * runStatePromotion entry point the bootstrap engine uses
   * internally, but without re-running phases 1–2. Settings calls
   * this when the user wants to detach an already-bootstrapped
   * cluster's Pulumi state from this device after the fact.
   */
  promoteState(
    input: StatePromotionInput,
    options: StatePromotionOptions | undefined,
    onEvent: (event: BootstrapEvent) => void
  ): Promise<void>;
  /**
   * Inverse of `promoteState`: pull installer Pulumi state out of
   * S3 back to a local file backend on this device. Refuses to
   * overwrite an existing local state dir; the operator must
   * archive or remove it first. The S3 stack is left in place as
   * a backup.
   */
  demoteState(
    input: StateDemotionInput,
    options: StateDemotionOptions | undefined,
    onEvent: (event: BootstrapEvent) => void
  ): Promise<void>;
  /**
   * Self-update the cluster's api-server + api-worker to a new image
   * version. The sidecar mirrors the new image to the cluster ECR
   * (needs docker — Lambda can't pull/push images) and then drives
   * deploys via the cluster's existing deployment API. Worker is
   * updated first; the api-server's deploy goes through the (now
   * upgraded) worker.
   */
  updateApiServer(
    input: ApiServerUpdateInput,
    options: ApiServerUpdateOptions | undefined,
    onEvent: (event: BootstrapEvent) => void
  ): Promise<void>;
  /**
   * Re-run phase 1 (the installer stack) against an already-bootstrapped
   * cluster to apply infra baseline changes that ship with this version
   * of @appliance.sh/infra. Requires the original BootstrapInput; the
   * desktop caches it on the Cluster record at handoff time.
   */
  updateBaseline(
    input: BaselineUpdateInput,
    options: BaselineUpdateOptions | undefined,
    onEvent: (event: BootstrapEvent) => void
  ): Promise<void>;
  /**
   * Resolve the latest semver-shaped tag on the api-server's ghcr.io
   * image. Used by Settings to default the target version field of
   * the self-update flow without making the operator type a number.
   * Optional — hosts that can't reach ghcr.io should omit it; the UI
   * falls back to the desktop's bundled version.
   */
  latestApiServerVersion?(input?: LatestGhcrTagInput): Promise<{ version: string }>;
  /**
   * Destroy the installer stack this device bootstrapped — the inverse
   * of `run`. Runs `pulumi destroy` against the installer state cached
   * in `~/.appliance` and archives the local state, tearing down the
   * base AWS infrastructure (Route53 zone, CloudFront, ACM cert, edge
   * router Lambda, S3 state + data buckets, ECR repo, IAM roles).
   * Does NOT destroy user-deployed appliances — those live in a
   * separate Pulumi project and must be destroyed first or their AWS
   * resources are orphaned. Optional — only the desktop host (which
   * can drive the Node sidecar + local Pulumi) implements it; the UI
   * hides the destroy affordance when it's absent.
   */
  teardown?(input: TeardownInput, onEvent: (event: BootstrapEvent) => void): Promise<void>;
  /**
   * Enumerate AWS profiles from `~/.aws/config` + `~/.aws/credentials`
   * for the wizard's profile picker. Optional — hosts without
   * filesystem access (web shell) can omit it; the wizard then
   * gracefully degrades to a free-text input.
   */
  listAwsProfiles?(): Promise<AwsProfile[]>;
}

export interface AwsProfile {
  name: string;
  /** True when the profile is configured for SSO. */
  isSso: boolean;
  /** Which file the profile was found in. */
  source: 'config' | 'credentials';
}

export interface TeardownInput {
  /**
   * AWS profile to authenticate the destroy with (matches the profile
   * used at bootstrap time). Empty/omitted → the shell's ambient AWS
   * environment.
   */
  awsProfile?: string;
  cluster?: Cluster;
  apiKey?: { id: string; secret: string };
}

/** A pending self-update the updater feed advertised — the running app
 *  is behind `version`. Mirrors the fields the Tauri updater plugin's
 *  `check()` resolves with that the UI actually renders. */
export interface AvailableUpdate {
  /** Version on the feed (e.g. "1.49.0"). Always newer than the
   *  running app — the host only returns this when an update exists. */
  version: string;
  /** The currently-running app version, for a before/after display. */
  currentVersion: string;
  /** Release notes pulled from the update manifest, if the publisher
   *  included them. */
  notes?: string;
  /** ISO-8601 publish date from the manifest, if present. */
  date?: string;
}

/** Progress of an in-flight download+install, surfaced so the UI can
 *  render a determinate bar when the manifest carried a content length
 *  and a spinner otherwise. */
export interface UpdateProgress {
  /** Total bytes to download, if the server sent a Content-Length.
   *  Undefined → render indeterminate. */
  contentLength?: number;
  /** Bytes downloaded so far across the whole transfer. */
  downloaded: number;
}

/**
 * Self-update driver. Desktop-only: the web shell auto-updates by
 * virtue of being a page reload, so it omits this capability entirely
 * (the UI hides the "Check for updates" panel when it's absent). The
 * Tauri host implements it against `@tauri-apps/plugin-updater` +
 * `@tauri-apps/plugin-process`, gated on the signed update feed
 * configured in `tauri.conf.json`'s `plugins.updater`.
 */
export interface UpdaterHost {
  /**
   * Ask the update feed whether a newer signed build exists. Resolves
   * with the update when one is available, or `null` when the running
   * app is current. Rejects only on a genuine failure to reach/verify
   * the feed (offline, signature mismatch, malformed manifest).
   */
  check(): Promise<AvailableUpdate | null>;
  /**
   * Download the pending update and install it in place, reporting
   * byte-level progress through `onProgress`. The update must come
   * from a prior `check()` in the same session (the plugin caches the
   * resolved Update handle). Resolves once the bundle is installed;
   * the caller then invokes `relaunch()` to boot into it.
   */
  downloadAndInstall(onProgress: (progress: UpdateProgress) => void): Promise<void>;
  /** Restart the app into the freshly-installed version. */
  relaunch(): Promise<void>;
}

// Capabilities the surrounding shell (web PWA, future Tauri/Electron)
// must provide to the shared app. Kept minimal: anything a browser
// tab can do on its own isn't here. Desktop-only hooks (OS keychain,
// system tray, native notifications, bootstrap driver) are optional
// fields so the web host can omit them entirely.
export interface ConsoleHost {
  getConfig(): Promise<HostConfig>;
  /** Persist a new cluster + its key, and select it. Returns the stored Cluster. */
  addCluster(input: AddClusterInput): Promise<Cluster>;
  /** Switch the active cluster. Pass null to deselect (UI shows "no cluster"). */
  selectCluster(clusterId: string | null): Promise<void>;
  /** Remove a cluster + its key. If it was selected, selection falls back to the first remaining cluster (or null). */
  removeCluster(clusterId: string): Promise<void>;
  /**
   * Set (or clear, with `null`) the cluster's stored
   * `stateBackendUrl`. Settings calls this with `null` after a
   * successful promotion (local state has been archived; no URL to
   * cache) and with the migration URL after a successful demotion
   * (so a future re-promotion can default the input field).
   * Optional: only the desktop host implements it (web shell omits
   * bootstrap entirely).
   */
  setClusterStateBackend?(clusterId: string, url: string | null): Promise<void>;
  openExternal(url: string): Promise<void>;
  notify?(opts: { title: string; body?: string }): Promise<void>;
  /** Desktop-only persisted User / Developer shell preference. */
  appMode?: AppModeHost;
  /** Desktop-owned paired catalogue transport/cache. */
  catalogue?: CatalogueHost;
  bootstrap?: BootstrapHost;
  /**
   * Local-runtime support surface: preflight, prerequisite installs,
   * container-runtime start, the appliance build/deploy file-picker
   * bits, and engine-routed workload/log reads for the microVM. The
   * microVM lifecycle itself lives under `vm`. Optional — the web
   * shell has no shell access, so it can omit this entirely.
   */
  local?: LocalRuntimeHost;
  /**
   * MicroVM engine (appliance-vm): an isolated VM Appliance boots
   * itself — no docker provider required for the cluster. Optional;
   * desktop-only, and only meaningful where a VM backend exists.
   */
  vm?: MicroVmHost;
  /**
   * Interactive PTY terminals into local workloads (`kubectl exec
   * -it`). Optional — desktop-only; needs a pseudo-terminal the web
   * shell can't provide.
   */
  terminal?: TerminalHost;
  /**
   * Self-update from the signed update feed. Optional — desktop-only;
   * the web shell ships continuously and has nothing to self-update.
   * When present, Settings exposes a "Check for updates" panel.
   */
  updater?: UpdaterHost;
  /**
   * Host-side agent credential login (Phase 5, L3 / docs/agent-login.md
   * §4). Lets a DESKTOP-only user authenticate the agent — API key OR
   * subscription OAuth ("Sign in with Claude") — without a terminal. The
   * credential is stored host-side (Keychain) and NEVER sent to the VM;
   * the egress broker injects it host-side at request time. Optional —
   * desktop-only.
   */
  agentAuth?: AgentAuthHost;
}

/** The kind of agent credential stored host-side. Mirrors the CLI's
 *  `AgentAuthKind` (`packages/cli/src/utils/agent.ts`): `api-key` is brokered
 *  bare (`X-Api-Key`) or as `Authorization: Bearer` depending on the agent;
 *  `oauth` is the one-year `sk-ant-oat01-…` Claude subscription token; `pat` is
 *  Copilot's fine-grained GitHub PAT (`Authorization: token …`). The stored
 *  kind selects the broker auth mode per agent (docs/multi-agent-adapters.md §1). */
export type AgentAuthKind = 'api-key' | 'oauth' | 'pat';

/** Whether a host credential is stored, and (best-effort) its kind, so the
 *  UI can show a "signed in as …" indicator. NEVER carries the secret value.
 *  `kind` may be null even when configured (on macOS we avoid reading the
 *  secret just to label it — that would trigger a Keychain access prompt). */
export interface AgentAuthStatus {
  configured: boolean;
  kind: AgentAuthKind | null;
}

/** Store/inspect the host-side agent credential, PER AGENT TYPE (L3 +
 *  multi-agent). Each agent type stores into its own provider store
 *  (`anthropic` / `github-copilot` / `openai`) so three agents' credentials
 *  never collide (docs/multi-agent-adapters.md §4). All operations are
 *  host-global (not per-VM) and the secret is written ONLY to the host store —
 *  it never enters any VM. `agentType` is the registry `--type` key. */
export interface AgentAuthHost {
  /** Is a credential stored for `agentType`, and (best-effort) what kind?
   *  Never returns the secret. Cheap + prompt-free so the UI can poll it. */
  status(agentType: string): Promise<AgentAuthStatus>;
  /** Store an agent credential host-side under `agentType`'s provider store,
   *  tagged by kind. `value` is the bare API key, the `sk-ant-oat01-…` OAuth
   *  token, or a fine-grained `github_pat_…` PAT. Never logged, never sent to
   *  the VM (mirrors the CLI's `writeAgentKey(provider, value, kind)`). */
  login(input: { agentType: string; kind: AgentAuthKind; value: string }): Promise<void>;
  /** Forget the stored host credential for `agentType`'s provider store. */
  logout(agentType: string): Promise<void>;
  /** Is `claude` present + runnable on this HOST? "Sign in with Claude" runs
   *  `claude setup-token` host-side, so this gates claude-code's OAuth path. */
  hasHostClaude(): Promise<boolean>;
  /** Best-effort: launch `claude setup-token` in a VISIBLE host terminal so
   *  the user can complete the browser sign-in and copy the one-year token to
   *  paste back. Resolves `false` where no auto-launch exists (the UI then
   *  shows the manual command). The token is NOT captured here — `setup-token`
   *  shows it on-screen only (docs/agent-login.md §7). */
  runSetupToken(): Promise<boolean>;
}

export type TerminalEvent = { type: 'data'; data: string } | { type: 'exit'; code?: number };

export interface TerminalOpenOptions {
  /** kubectl target — a pod, or any exec-able ref like `deploy/app`. */
  target: string;
  namespace?: string;
  clusterName?: string;
  /** 'microvm' routes through the microVM's kubeconfig. */
  engine?: 'microvm';
  /** Shell target. Absent → `kubectl exec` into the `target` pod. 'dev'
   *  → a shell in the microVM's dev workspace; 'host' → a raw root
   *  shell on the microVM host. Both ride `kubectl debug node/` +
   *  chroot (microVM engine only). */
  mode?: 'dev' | 'host';
  /** Command to run; defaults to an interactive `/bin/sh`. */
  command?: string[];
  container?: string;
  cols: number;
  rows: number;
  /** Reattachable guest tmux session id (E3.4). Only the vsock host/dev
   *  shell honours it — the argv gains `--session <id>` so the PTY attaches
   *  to (or creates) the named guest tmux session `appliance-<id>`, which
   *  survives this client disconnecting and a desktop restart. Absent for
   *  pod-exec shells (no tmux behind them) — they stay non-reattachable. */
  sessionId?: string;
}

/** A live PTY session. Output arrives on the `onEvent` callback passed
 *  to `open`; input + control go back through these methods. */
export interface TerminalSession {
  id: string;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  close(): Promise<void>;
}

/** One reattachable guest tmux session, as reported by `terminal.list`.
 *  Mirrors SessionInfo in packages/vm/src/shell.rs (the `appliance-`
 *  prefix stripped). */
export interface TerminalSessionInfo {
  /** Host-minted id — the desktop tab's session id (`<mode>-<uuid>`). */
  id: string;
  /** tmux `session_activity` (Unix epoch seconds), when known. */
  lastActivity?: number;
}

export interface TerminalHost {
  open(opts: TerminalOpenOptions, onEvent: (event: TerminalEvent) => void): Promise<TerminalSession>;
  /** Enumerate the VM's live reattachable guest tmux sessions, so the
   *  store can rehydrate dock tabs on app launch (E3.4). Optional — a host
   *  without reattachable sessions omits it. */
  list?(vmName?: string): Promise<TerminalSessionInfo[]>;
  /** Destroy a guest tmux session by id (the explicit tab-close path).
   *  Closing the PTY only *detaches*; this is what actually tears the
   *  in-guest session down. Optional, paired with `list`. */
  kill?(vmName: string | undefined, id: string): Promise<void>;
}

/**
 * Stable cluster id for the microVM engine. Doubles as the CLI
 * profile name in ~/.appliance/profiles.json — mirrors
 * MICROVM_CLUSTER_ID in the desktop's lib.rs and MICROVM_PROFILE in
 * the CLI.
 */
export const MICROVM_CLUSTER_ID = 'microvm';

/** The canonical (default) microVM name — keeps the bare `microvm`
 *  cluster id. Mirrors DEFAULT_VM_NAME in the CLI and MICROVM_NAME in
 *  the desktop's lib.rs. */
export const DEFAULT_MICROVM_NAME = 'appliance';

/** Desktop cluster id a VM registers under. The default VM keeps the
 *  bare `microvm`; others get `microvm-<name>`. Mirrors
 *  microvm_cluster_id in lib.rs and profileForVm in the CLI. */
export function microVmClusterId(name: string): string {
  return name === DEFAULT_MICROVM_NAME ? MICROVM_CLUSTER_ID : `${MICROVM_CLUSTER_ID}-${name}`;
}

/** The VM name behind a cluster id, or null if the id isn't a microVM
 *  cluster. `microvm` → `appliance`; `microvm-<name>` → `<name>`. */
export function microVmNameFromClusterId(clusterId: string): string | null {
  if (clusterId === MICROVM_CLUSTER_ID) return DEFAULT_MICROVM_NAME;
  const prefix = `${MICROVM_CLUSTER_ID}-`;
  return clusterId.startsWith(prefix) ? clusterId.slice(prefix.length) : null;
}

/** Whether a cluster id belongs to the microVM engine (any VM). */
export function isMicroVmClusterId(clusterId: string): boolean {
  return microVmNameFromClusterId(clusterId) !== null;
}

/** Canonical user-facing name for a local VM: the default VM is THE
 *  "Dev Machine"; extra VMs are qualified by name. Used wherever a
 *  microVM-backed target is shown (switcher, machine page, wizard rows)
 *  so the local target never drifts back to "local runtime" /
 *  "sandboxed" / "MicroVM Runtime" wording. */
export function devMachineLabel(vmName: string): string {
  return vmName === DEFAULT_MICROVM_NAME ? 'Dev Machine' : `Dev Machine (${vmName})`;
}

// NOTE: alias detection for CLI profiles that point at a local VM's
// forwarded api-server port lives in lib/dev-machine-targets.ts — that
// module owns the whole dedupe/rebind policy (which entries fold into
// which VM row, and what a stored alias selection resolves to).

/** A microVM bring-up stage, mirrors Phase in packages/vm/src/bringup.rs.
 *  Ordered: media → booting → network → cluster (sliced open by the
 *  cluster-node / cluster-images / cluster-api / ingress sub-phases) →
 *  ready (terminal), or failed (terminal). Engines may add phases; render
 *  code must tolerate unknown strings (it ignores them). */
export type MicroVmPhase =
  | 'media'
  | 'booting'
  | 'network'
  | 'cluster'
  | 'cluster-node'
  | 'cluster-images'
  | 'cluster-api'
  | 'ingress'
  | 'ready'
  | 'failed';

export interface MicroVmStatus {
  /** appliance-vm binary present on this machine. */
  available: boolean;
  /** Not installed, but the host carries a binary it can install. */
  installable: boolean;
  exists: boolean;
  running: boolean;
  /** The lazily provisioned deployment layer is present. This remains
   *  true while a provisioned VM is stopped. */
  clusterProvisioned: boolean;
  /** kubeconfig fetched and the host process alive — the cluster
   *  answers. Gated on `running`, so a stopped VM doesn't read ready. */
  kubeconfigReady: boolean;
  /** Current bring-up stage while starting; absent when not running or
   *  when the engine predates phase reporting. Lets the badge show
   *  "starting (k3s)" / "failed" instead of a blunt "running". */
  phase?: MicroVmPhase;
  /** Free-text context for `phase` (what the engine is waiting on) —
   *  rendered as the live detail line under the in-flight rung. */
  phaseDetail?: string;
  /** Whether this VM is provisioned as a development environment
   *  (`appliance vm dev up`) — drives the dev-shell affordance. */
  dev: boolean;
  /** Host folder shared into `/persist/workspace` (`devMount`), when one
   *  is mounted. The agent launcher gates on this — an agent runs in (and
   *  writes its registry to) the shared workspace. */
  devMount?: string;
  apiServerUrl: string;
  message?: string;
}

/** Outbound-traffic policy for the microVM's egress proxy. Mirrors
 *  EgressPolicy in packages/vm/src/egress.rs.
 *
 *  For a `net_link=Netstack` VM (`enforced: true`) the host returns the
 *  EFFECTIVE policy enforced at the boundary — default-DENY plus the baked
 *  allowlist merged over the operator's rules (egress::effective_policy).
 *  For a `net_link=Nat` VM (`enforced: false`) it's the persisted,
 *  cooperative policy. The fields below are display-only — never write the
 *  whole object back; edits go through the incremental `addRule`/`setDefault`
 *  bridge calls. */
export interface EgressPolicy {
  default: 'allow' | 'deny';
  /** Host suffixes always allowed. For a Netstack VM this includes the
   *  baked allowlist (NETSTACK_BAKED_ALLOWLIST) merged with operator rules. */
  allow: string[];
  /** Host suffixes always denied (deny wins over allow). */
  deny: string[];
  /** TLS interception on — the proxy decrypts allowed HTTPS. */
  mitm: boolean;
  /** Path to the VM's egress CA cert, when interception is on. */
  caPath?: string;
  /** True when the host netstack is the ENFORCED egress boundary
   *  (`net_link=Netstack`): default-DENY + the baked allowlist, the only
   *  path off-box. False for the cooperative NAT proxy. Host-populated from
   *  the VM's persisted spec. */
  enforced?: boolean;
  /** The VM's resolved network link. */
  netLink?: 'netstack' | 'nat';
}

/** The baked, always-on allowlist for `net_link=Netstack` VMs — a mirror
 *  of NETSTACK_ALLOWLIST in packages/vm/src/egress.rs (§5 of
 *  docs/egress-firewall.md). The engine merges these into the effective
 *  policy's `allow`; the desktop partitions them back out to distinguish
 *  the always-on baked set from the operator's own allow rules. Keep in
 *  sync with the engine constant. */
export const NETSTACK_BAKED_ALLOWLIST: readonly string[] = [
  'api.anthropic.com',
  'dl-cdn.alpinelinux.org',
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  'static.crates.io',
  'github.com',
  'codeload.github.com',
  'githubusercontent.com',
  'registry-1.docker.io',
  'auth.docker.io',
  'production.cloudflare.docker.com',
  'ghcr.io',
];

/** One recorded egress request — mirrors TrafficEvent in
 *  packages/vm/src/traffic.rs. */
export interface EgressEvent {
  /** Unix epoch milliseconds. */
  ts: number;
  host: string;
  port: number;
  method: string;
  /** Present for intercepted HTTPS / plain HTTP; absent for blind CONNECT. */
  path?: string;
  /** 'allow' | 'deny' | 'mitm'. */
  decision: 'allow' | 'deny' | 'mitm';
}

export interface MicroVmEgressHost {
  get(): Promise<EgressPolicy>;
  setDefault(action: 'allow' | 'deny'): Promise<void>;
  addRule(action: 'allow' | 'deny', host: string): Promise<void>;
  /** Remove a single operator allow/deny rule for an exact host — the
   *  per-rule counterpart of `reset` (which clears every rule).
   *  Incremental, like `addRule`: never a whole effective-policy
   *  write-back. */
  removeRule(host: string): Promise<void>;
  setMitm(enabled: boolean): Promise<void>;
  reset(): Promise<void>;
  /** Recent recorded traffic, oldest-first. */
  log(tail?: number): Promise<EgressEvent[]>;
  /** Forget all recorded traffic. */
  clearLog(): Promise<void>;
}

/** Per-host credential capture/injection rule — mirrors
 *  CredentialRule in packages/vm/src/creds.rs. */
export interface CredentialRule {
  host: string;
  capture: boolean;
  inject: boolean;
  header: string;
  helper?: string;
}

/** A stored secret, value masked. */
export interface StoredSecret {
  host: string;
  header: string;
  masked: string;
}

export interface CredentialsState {
  rules: CredentialRule[];
  secrets: StoredSecret[];
}

export interface MicroVmCredsHost {
  list(): Promise<CredentialsState>;
  add(rule: { host: string; capture: boolean; inject: boolean; header?: string; helper?: string }): Promise<void>;
  remove(host: string): Promise<void>;
  /** Manually store a secret (e.g. paste an API key). */
  setSecret(host: string, value: string, header?: string): Promise<void>;
  /** Forget all stored secrets (rules are kept). */
  forget(): Promise<void>;
}

/** A coding agent recorded in a project's `.appliance/agents.json`
 *  registry (Phase 5), reconciled against the VM's live tmux sessions.
 *  Mirrors AgentInfo in the desktop's lib.rs (the CLI's `appliance agent
 *  list --json` row). Surfaced so a rehydrated agent tab can show its
 *  type / task / status. */
export interface AgentInfo {
  /** Host id — the `agent-` prefix stripped from `sessionId`. */
  id: string;
  /** Adapter key, e.g. `claude-code`. */
  type: string;
  /** Autonomous: the prompt. Interactive: an optional label. */
  task?: string;
  status: 'running' | 'done' | 'error' | 'exited';
  /** The `agent-<uuid>` tmux session id — the terminal tab attaches to it. */
  sessionId: string;
  mode?: 'interactive' | 'autonomous';
  /** Reconciled liveness: true/false, or null when the VM was unreachable. */
  live?: boolean | null;
}

/** Launch a coding agent in a VM (Phase 5, A5). The desktop pre-mints the
 *  `agent-<uuid>` session id so it can open the observe tab against a
 *  known id the moment the launch returns. */
export interface AgentLaunchInput {
  /** Adapter type. Defaults to `claude-code`. */
  type?: string;
  /** Optional task prompt (interactive label / autonomous prompt). */
  task?: string;
  /** Pre-minted `agent-<uuid>` session id to launch under. */
  sessionId: string;
}

/** Launch + list coding agents in one microVM (Phase 5, A5). Backed by
 *  the bundled `appliance agent` CLI + its per-project registry. */
export interface MicroVmAgentHost {
  /** Shell `appliance agent start … --no-attach`: spawn a detached,
   *  broker-wired `agent-<id>` tmux session. Resolves once the session
   *  exists (so the caller can attach an observe tab); rejects with the
   *  CLI's stderr (e.g. a missing Anthropic key). */
  start(input: AgentLaunchInput): Promise<void>;
  /** The VM's recorded agents, reconciled against live sessions. */
  list(): Promise<AgentInfo[]>;
  /** Shell `appliance agent stop <id>`: kill the agent's tmux session and
   *  mark its registry record `exited`. Called when an agent tab closes so
   *  no stale `running` row lingers. `id` is the `agent-<uuid>` session id
   *  (the CLI matches it with or without the prefix). Best-effort. */
  stop(id: string): Promise<void>;
}

/** One microVM as reported by the engine — its allocated host ports,
 *  running state, and the desktop cluster id it registers under.
 *  Mirrors MicroVmSummary in the desktop's lib.rs. */
export interface MicroVmSummary {
  name: string;
  running: boolean;
  /** Whether the persisted VM includes the deployment layer. */
  clusterProvisioned: boolean;
  /** Cluster answers (kubeconfig fetched) while running — lets the
   *  switcher show "starting" vs "ready" per VM. */
  clusterReady: boolean;
  /** Current bring-up stage while starting; absent when not running. */
  phase?: MicroVmPhase;
  hostPort: number;
  apiPort: number;
  registryPort: number;
  egressPort: number;
  /** Desktop cluster id this VM registers under (`microvm` / `microvm-<name>`). */
  clusterId: string;
}

/** Operations scoped to a single microVM. Appliance can run several
 *  concurrently (e.g. one for interactive dev, one for traffic
 *  testing); each is addressed by name. */
export interface MicroVmInstanceHost {
  /** The VM this handle targets. */
  readonly name: string;
  status(): Promise<MicroVmStatus>;
  /** Full `appliance vm up` orchestration, streaming progress lines. */
  up(onEvent: (event: { message: string }) => void): Promise<void>;
  /** Like `up`, but provisions the VM as a development environment
   *  (`appliance vm dev up`): dev toolchain + persistent workspace.
   *  `opts.mount` shares a host folder into /persist/workspace. */
  devUp(onEvent: (event: { message: string }) => void, opts?: { mount?: string }): Promise<void>;
  /** One-way promotion from a core sandbox to the deployment layer.
   *  Stops and re-ups the VM while preserving its persisted dev mode. */
  clusterUp(onEvent: (event: { message: string }) => void): Promise<void>;
  /** Sweep the debugger pods a dev/host shell leaves behind. Called
   *  when a shell terminal closes; best-effort. */
  cleanupShell(): Promise<void>;
  /** Recover from a rejected credential: re-mint via the VM's on-disk
   *  bootstrap token and persist it everywhere the old key lived
   *  (profiles.json, keychain, cluster registry). `failedKeyId` is the
   *  key the server just rejected — the host skips minting when the
   *  store already carries a different (fresher) key. `cause` is the
   *  server's machine-readable 401 classification (AuthFailureCause)
   *  when it sent one — it picks the recovery (mint vs guest clock
   *  sync vs nothing); optional for old cause-less servers. Resolves
   *  `true` when fresh credentials are in place and the caller should
   *  retry; `false` when there's nothing to heal with (no bootstrap
   *  token, attempt too recent). Optional: only hosts that own local
   *  VM state (the desktop) can heal. */
  healCredentials?(failedKeyId?: string, cause?: string): Promise<boolean>;
  stop(): Promise<void>;
  /** Delete the VM and its state (stops first if needed). */
  remove(): Promise<void>;
  /** Control the VM's outbound traffic (allow/deny + TLS MITM). */
  egress: MicroVmEgressHost;
  /** Per-host credential capture/injection (apiKeyHelper). */
  creds: MicroVmCredsHost;
  /** Launch + observe coding agents in this VM (Phase 5, A5). */
  agent: MicroVmAgentHost;
}

export interface MicroVmHost {
  /** All defined VMs (running or not). */
  list(): Promise<MicroVmSummary[]>;
  /** Install the engine binary into the managed bin dir. Engine-wide,
   *  not per-VM (one binary serves every VM). */
  install(): Promise<void>;
  /** A handle scoped to one VM. Defaults to the canonical `appliance`
   *  VM, so single-VM callers can stay terse. */
  instance(name?: string): MicroVmInstanceHost;
}

// Engine-routed input for the kubectl-level reads (workloads, pod
// logs) the desktop exposes. microVM-only now that bare k3d is gone.
export interface LocalRuntimeInput {
  /** Which local engine the read addresses — microVM only, routed
   *  through the microVM's kubeconfig. */
  engine?: 'microvm';
  /** The microVM name whose kubeconfig to read; several VMs run
   *  concurrently, so the name selects which one. */
  clusterName?: string;
}

export interface LocalDeploymentInfo {
  name: string;
  image?: string;
  desired: number;
  ready: number;
  available: number;
  createdAt?: string;
}

export interface LocalPodInfo {
  name: string;
  phase: string;
  ready: boolean;
  restartCount: number;
  containerImage?: string;
  createdAt?: string;
}

export interface LocalServiceInfo {
  name: string;
  serviceType: string;
  clusterIp?: string;
  nodePort?: number;
  targetPort?: number;
}

/** Parsed contents of an appliance manifest (json or sandbox-evaluated ts/js). */
export interface LocalApplianceManifest {
  manifest?: string;
  name: string;
  type?: string;
  port?: number;
  platform?: string;
  /** Env block straight from the manifest (passed through as-is). */
  env?: Record<string, string>;
  /** Absolute path of the manifest file the desktop just read. */
  manifestPath: string;
}

export interface LocalPackageUploadInput {
  /** App folder (manifest + source — the folder the picker returned). */
  path: string;
  /** One-time upload URL minted by `client.createBuild()` (presigned
   *  S3 on cloud bases, token self-URL on Kubernetes bases). The URL
   *  itself carries the authorization, so the host bridge needs no
   *  api-server credentials. */
  uploadUrl: string;
  /** Skip Lambda zip-runtime prep for framework apps — pass true when
   *  the target base builds container images from source (mirrors the
   *  CLI deploy pipeline's `lambdaPrep` decision). */
  noLambdaPrep?: boolean;
}

/** Streaming log event emitted while a child process runs. */
export interface LocalLogEvent {
  type: 'log';
  /** "stdout" / "stderr" for actual output; "meta" for command echoes. */
  stream: 'stdout' | 'stderr' | 'meta';
  message: string;
}

/** Drive the bundled `appliance deploy` for a BYO AWS / bundle cloud base.
 *  Unlike a Kubernetes target (which takes a host-built container image
 *  pushed to a registry), an AWS base deploys an uploaded manifest zip —
 *  which the desktop can't produce itself. So instead of re-authoring the
 *  build/upload host-side, the desktop shells the bundled CLI, which
 *  auto-builds `appliance.zip` from the manifest and uploads it via the
 *  SDK's presigned PUT. */
export interface LocalDeployToCloudInput {
  /** Project folder — used as the CLI's working directory (it holds the
   *  manifest and is where `appliance.zip` is written). */
  path: string;
  /** CLI profile to authenticate the deploy with. This is the selected
   *  cluster's id, which the desktop already mirrors into
   *  `~/.appliance/profiles.json` (secret resolved Keychain-first on
   *  macOS) — so the CLI targets the same cloud + creds the app selected,
   *  with no interactive login. */
  profile: string;
  /** Target project name — passed as a positional arg so the headless
   *  (`--yes`) deploy never needs a prompt or a prior `appliance setup`. */
  project: string;
  /** Target environment name — the second positional arg. */
  environment: string;
}

/**
 * One row in the prerequisite report rendered before the user can start
 * the local runtime. The desktop probes each tool with `<tool> --version`
 * and reports installed/version/install-hint so the UI can show a
 * copy-paste install command instead of an opaque "spawn failed".
 */
export interface LocalPreflightCheck {
  /** Tool name as invoked on the command line (`docker`, `kubectl`, …). */
  tool: string;
  /** True iff `<tool> --version` exited 0. */
  installed: boolean;
  /** First line of stdout from `<tool> --version`, when installed. */
  version?: string;
  /** One-line human description of what this tool is for. */
  purpose: string;
  /** Platform-appropriate install command (empty on unsupported OS). */
  installHint: string;
  /**
   * True when `host.local.installPrereq(tool)` can drive an automatic
   * install (docker engine is guidance-only).
   */
  autoInstallable: boolean;
  /** stderr or io::Error captured when the version check failed. */
  error?: string;
  /**
   * For docker only: whether a daemon is actually reachable, not just
   * whether the CLI is installed (`docker --version` exits 0 even with
   * a stopped engine). Undefined for tools with no daemon (kubectl).
   * `false` means "installed but not running".
   */
  daemonRunning?: boolean;
  /**
   * For docker only, when `daemonRunning` is false: whether appliance
   * can start the runtime itself (colima is the active runtime). Drives
   * a "Start runtime" button vs. manual-start guidance.
   */
  daemonStartable?: boolean;
}

/**
 * Outcome of a helper-driven install for a single tool. The sidecar
 * surfaces these so the UI can render per-tool success/failure rather
 * than collapsing the batch into a single boolean.
 */
export interface LocalHelperInstallOutcome {
  tool: string;
  status: 'installed' | 'already' | 'guidance' | 'failed';
  message: string;
}

export interface LocalHelperInstallResult {
  outcomes: LocalHelperInstallOutcome[];
}

/**
 * Streamed progress event from a helper-install run. Mirrors the
 * bootstrap channel shape so callers can use the same Tauri Channel
 * plumbing.
 */
export interface LocalHelperProgressEvent {
  type: string;
  stage?: string;
  message?: string;
}

export interface LocalRuntimeHost {
  /** Probe the local-runtime prerequisites (docker, kubectl). */
  preflight(): Promise<LocalPreflightCheck[]>;
  /**
   * Drive the helper to install missing prerequisites. `tools` is
   * either explicit names or `undefined` to install everything
   * required. Progress events stream onto `onEvent`; the returned
   * promise resolves with per-tool outcomes once the run completes.
   * Optional on hosts (web shell) that can't drive a Node sidecar.
   */
  installPrereq?(
    tools: string[] | undefined,
    onEvent: (event: LocalHelperProgressEvent) => void,
    opts?: { force?: boolean }
  ): Promise<LocalHelperInstallResult>;
  /**
   * Start the container runtime (colima) when appliance can do so
   * safely — wired to the doctor view's "Start runtime" button. Same
   * code path the implicit cluster-start uses. Optional: only the
   * desktop host can manage a local runtime; rejects with an actionable
   * message for runtimes appliance can't auto-start.
   */
  startContainerRuntime?(): Promise<void>;

  // Workloads + pod logs are no longer read here: the console reads them
  // through the in-VM api-server via `ApplianceClient.listWorkloads()` /
  // `getPodLogs()` / `streamPodLogs()` (control-plane.md §4), the same
  // signed base-URL path that powers projects/deployments. No kubectl.

  /** Open a native folder picker. Returns null on cancel. */
  pickDirectory(): Promise<string | null>;
  /** Resolve an appliance manifest in the given folder. `.json` is
   *  read directly; `.ts` / `.js` (and `.mts` / `.cts` / `.mjs` /
   *  `.cjs`) are evaluated through the CLI's QuickJS sandbox via the
   *  sidecar. Errors if no manifest is found or the sandbox rejects. */
  readApplianceManifest(path: string): Promise<LocalApplianceManifest>;
  /** Shell the bundled `appliance deploy` for a BYO AWS / bundle cloud
   *  base: the CLI builds the manifest `appliance.zip` and uploads it via
   *  the SDK's base-URL-agnostic presigned PUT, authenticated by the
   *  selected cluster's mirrored CLI profile (`--profile`). Runs headless
   *  (`--yes` + explicit project/environment args, no prompts) and streams
   *  the CLI's stdout/stderr onto onEvent. Resolves once the CLI exits 0;
   *  rejects with its stderr tail otherwise. Optional — only the desktop
   *  can shell the CLI; the web shell omits it and the wizard falls back
   *  to the copyable `appliance deploy` snippet. */
  deployToCloud?(input: LocalDeployToCloudInput, onEvent: (event: LocalLogEvent) => void): Promise<void>;
  /** Package the app folder as a source zip and PUT it to the one-time
   *  upload URL minted by `client.createBuild()` — the desktop drives
   *  the bundled CLI (`appliance build --upload-url …`) so the wizard
   *  ships byte-identical artifacts to a terminal `appliance deploy`.
   *  The image is then built server-side; no Docker on this machine.
   *  Streams packaging/upload progress to onEvent. */
  packageAndUploadBuild(input: LocalPackageUploadInput, onEvent: (event: LocalLogEvent) => void): Promise<void>;
}

export type {
  ApiServerUpdateInput,
  ApiServerUpdateOptions,
  BaselineUpdateInput,
  BaselineUpdateOptions,
  BootstrapEvent,
  BootstrapInput,
  BootstrapOptions,
  BootstrapPhase,
  BootstrapPriorOutputs,
  BootstrapResult,
  LatestGhcrTagInput,
  StateDemotionInput,
  StateDemotionOptions,
  StatePromotionInput,
  StatePromotionOptions,
};
