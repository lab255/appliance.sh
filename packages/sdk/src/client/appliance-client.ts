import { Result } from '../result';
import { ClientConfig, ListOptions } from './types';
import { Project, ProjectInput } from '../models/project';
import { Environment, EnvironmentInput } from '../models/environment';
import { EnvironmentHealth } from '../models/environment-health';
import { Deployment, type EdgeDeploymentTarget } from '../models/deployment';
import { ApiKeyCreateResponse, ApiKeySummary, ApiKeyRole } from '../models/api-key';
import { InviteCreateResponse, InviteSummary } from '../models/invite';
import { ApplianceBaseConfig } from '../models/appliance-base';
import { Workloads } from '../models/workloads';
import { signRequest } from '../signing';
import { VERSION } from '../version';
import type {
  SelfUpdatePublicJob,
  SelfUpdateStartInput,
  SelfUpdateStartResponse,
  SelfUpdateWatchOptions,
} from '../models/self-update';

/** GET /api/v1/cluster-info response. Mirrors the api-server's
 *  ClusterInfo (routes/cluster-info); every field beyond `version` +
 *  `baseConfig` is optional because older servers omit it — clients
 *  must tolerate absence rather than block. */
export interface ClusterInfoResponse {
  version: string;
  baseConfig: ApplianceBaseConfig;
  /** How this server exposes its web console. Absent on older servers — treat as 'full'. */
  consoleMode?: 'full' | 'bootstrap' | 'off';
  /** Canonical console URL when hosted separately from the api-server. */
  consoleUrl?: string;
  /** The server's own version. Absent on older servers — treat as unknown. */
  serverVersion?: string;
  /**
   * The oldest client version this server supports. ADVISORY: clients
   * compare against their own version and warn with an upgrade hint —
   * nothing is enforced on either side. Absent on older servers.
   */
  minClientVersion?: string;
  /**
   * What this base can do. `uploadBuilds`: whether upload-flow
   * (source zip) builds can run here — POST /api/v1/builds 409s
   * when they can't. Absent on older servers — treat as unknown
   * and let the request's error responses decide.
   */
  capabilities?: { uploadBuilds: boolean };
  /**
   * Operational warnings raised around the server (e.g. the microVM
   * guest's legacy-deploy quarantine watchdog). Human-readable lines,
   * deduplicated; absent when there are none.
   */
  warnings?: string[];
}

export class ApplianceClient {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly credentials?: { keyId: string; secret: string };
  /** `x-appliance-client` header value: `<product>/<version>`. Sent on
   *  every request from NON-BROWSER contexts (CLI, server-side callers);
   *  `undefined` — never sent — when a `document` global exists.
   *  Browser/webview requests would need the header allow-listed in the
   *  server's CORS preflight, and servers deployed before the header
   *  existed don't list it: attaching it there kills every cross-origin
   *  request as a network-shaped TypeError (no 401, so no heal path).
   *  Deliberately OUTSIDE the signed field set (the signing FIELDS_*
   *  stay untouched) so old servers ignore it and a proxy stripping it
   *  can't break signatures. */
  private readonly clientTag?: string;

  constructor(config: ClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.timeout = config.timeout ?? 30000;
    this.credentials = config.credentials;
    this.clientTag = typeof document === 'undefined' ? `${config.product ?? 'sdk'}/${VERSION}` : undefined;
  }

  /** The `x-appliance-client` header — or nothing, in browser contexts
   *  (see `clientTag`). Spread into every request's headers. */
  private clientTagHeaders(): Record<string, string> {
    return this.clientTag ? { 'x-appliance-client': this.clientTag } : {};
  }

  private async request<T>(method: string, path: string, body?: unknown, timeout?: number): Promise<Result<T>> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout ?? this.timeout);

      const url = `${this.baseUrl}${path}`;
      const bodyStr = body ? JSON.stringify(body) : undefined;

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...this.clientTagHeaders(),
      };

      if (this.credentials && bodyStr) {
        const sigHeaders = await signRequest(this.credentials, {
          method: method.toUpperCase(),
          url,
          headers,
          body: bodyStr,
        });
        Object.assign(headers, sigHeaders);
      } else if (this.credentials) {
        const sigHeaders = await signRequest(this.credentials, {
          method: method.toUpperCase(),
          url,
          headers,
        });
        Object.assign(headers, sigHeaders);
      }

      const response = await fetch(url, {
        method,
        headers,
        body: bodyStr,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        return {
          success: false,
          error: new Error(`HTTP ${response.status}: ${errorBody}`),
        };
      }

      // 204 No Content (DELETE handlers) and other empty-body
      // responses must not be fed to JSON.parse — WebKit/WKWebView
      // raises a confusing "String content not expected" / "Unexpected
      // EOF" error that surfaces to the user as a delete failure.
      // Resolve to `undefined as T` instead so `Result<void>` callers
      // see `{ success: true }`.
      if (response.status === 204 || response.headers.get('content-length') === '0') {
        return { success: true, data: undefined as T };
      }

      const data = await response.json();
      return { success: true, data: data as T };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  private async startSelfUpdate(input: SelfUpdateStartInput): Promise<Result<SelfUpdateStartResponse>> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);
      const url = `${this.baseUrl}/api/v1/self-update`;
      const body = JSON.stringify({ targetDigest: input.targetDigest, release: input.release });
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'idempotency-key': input.idempotencyKey,
        ...this.clientTagHeaders(),
      };
      if (this.credentials) {
        Object.assign(headers, await signRequest(this.credentials, { method: 'POST', url, headers, body }));
      }
      const response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
      clearTimeout(timeoutId);
      const data = (await response.json()) as Record<string, unknown>;
      if (response.status === 202) {
        return {
          success: true,
          data: {
            httpStatus: 202,
            jobId: String(data.jobId),
            status: data.status as SelfUpdatePublicJob['status'],
            statusUrl: String(data.statusUrl),
          },
        };
      }
      if (response.status === 409) {
        return {
          success: true,
          data: { httpStatus: 409, jobId: String(data.jobId), statusUrl: String(data.statusUrl) },
        };
      }
      return {
        success: false,
        error: new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`),
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  /** Signed control-plane self-update API and terminal-state polling helper. */
  readonly selfUpdate = {
    start: (input: SelfUpdateStartInput): Promise<Result<SelfUpdateStartResponse>> => this.startSelfUpdate(input),
    status: (jobId: string): Promise<Result<SelfUpdatePublicJob>> =>
      this.request<SelfUpdatePublicJob>('GET', `/api/v1/self-update/${encodeURIComponent(jobId)}`),
    watch: async (
      jobId: string,
      options: SelfUpdateWatchOptions = {}
    ): Promise<Result<SelfUpdatePublicJob>> => {
      const intervalMs = options.intervalMs ?? 2_000;
      if (!Number.isFinite(intervalMs) || intervalMs < 0) {
        return { success: false, error: new Error('selfUpdate.watch intervalMs must be a non-negative number') };
      }
      let previousPhase: SelfUpdatePublicJob['phase'] | undefined;
      for (;;) {
        const current = await this.request<SelfUpdatePublicJob>(
          'GET',
          `/api/v1/self-update/${encodeURIComponent(jobId)}`
        );
        if (!current.success) return current;
        if (current.data.phase !== previousPhase) {
          previousPhase = current.data.phase;
          options.onPhase?.(current.data);
        }
        if (current.data.status === 'succeeded' || current.data.status === 'failed') return current;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    },
  };

  /**
   * Like `request<T>`, but resolves the response as a plain text body
   * instead of JSON. Used by `getPodLogs`, whose endpoint answers
   * `text/plain` (a log tail), not JSON. Signs body-less GETs via the
   * same credential-only path `request` takes for them.
   */
  private async requestText(method: string, path: string, timeout?: number): Promise<Result<string>> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout ?? this.timeout);

      const url = `${this.baseUrl}${path}`;
      const headers: Record<string, string> = { ...this.clientTagHeaders() };

      if (this.credentials) {
        const sigHeaders = await signRequest(this.credentials, {
          method: method.toUpperCase(),
          url,
          headers,
        });
        Object.assign(headers, sigHeaders);
      }

      const response = await fetch(url, { method, headers, signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        return { success: false, error: new Error(`HTTP ${response.status}: ${errorBody}`) };
      }

      const data = await response.text();
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  // Bootstrap methods (no signature auth)
  async bootstrap(token: string, name: string): Promise<Result<ApiKeyCreateResponse>> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(`${this.baseUrl}/bootstrap/create-key`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bootstrap-token': token,
          ...this.clientTagHeaders(),
        },
        body: JSON.stringify({ name }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        return {
          success: false,
          error: new Error(`HTTP ${response.status}: ${errorBody}`),
        };
      }

      const data = await response.json();
      return { success: true, data: data as ApiKeyCreateResponse };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /** `serverVersion` is reported by newer servers on this
   *  unauthenticated probe (pre-credential skew visibility); absent on
   *  older ones. */
  async getBootstrapStatus(): Promise<Result<{ initialized: boolean; serverVersion?: string }>> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(`${this.baseUrl}/bootstrap/status`, {
        method: 'GET',
        headers: this.clientTagHeaders(),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        return {
          success: false,
          error: new Error(`HTTP ${response.status}: ${errorBody}`),
        };
      }

      const data = await response.json();
      return { success: true, data: data as { initialized: boolean; serverVersion?: string } };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  // API key methods

  /**
   * Rotate the *calling* credential. The server mints a replacement key
   * (inheriting this key's name) and revokes the current one, returning
   * the new id + secret. After this resolves the credentials this client
   * was constructed with stop working — callers must persist the new
   * key and rebuild any client they intend to keep using.
   *
   * Authenticated via the same signature path as every other data-plane
   * call, so a caller can only rotate the key it already holds.
   */
  async rotateKey(): Promise<Result<ApiKeyCreateResponse>> {
    // POST with an empty body still gets signed (the signing path
    // covers credential-only requests), so the server can identify the
    // calling key and rotate exactly it.
    return this.request<ApiKeyCreateResponse>('POST', '/api/v1/keys/rotate');
  }

  /**
   * Identify the calling key: id, name, and role. The console uses the
   * role to decide between the simple (member) and advanced (admin)
   * surfaces. Older api-servers 404 this route — treat that as admin
   * (roles didn't exist, every key was full-access).
   */
  async whoami(): Promise<Result<ApiKeySummary>> {
    return this.request<ApiKeySummary>('GET', '/api/v1/keys/self');
  }

  /** Mint a named key (admin only). The secret is returned exactly once. */
  async createKey(name: string, role?: ApiKeyRole): Promise<Result<ApiKeyCreateResponse>> {
    return this.request<ApiKeyCreateResponse>('POST', '/api/v1/keys', { name, ...(role ? { role } : {}) });
  }

  /** List key summaries — never includes secrets (admin only). */
  async listKeys(): Promise<Result<ApiKeySummary[]>> {
    return this.request<ApiKeySummary[]>('GET', '/api/v1/keys');
  }

  /**
   * Revoke a key by id (admin only). The server refuses to revoke the
   * calling key (409) — rotate instead, so an admin can't lock
   * themselves out with a stray click.
   */
  async deleteKey(id: string): Promise<Result<void>> {
    return this.request<void>('DELETE', `/api/v1/keys/${encodeURIComponent(id)}`);
  }

  // Invite methods (admin only, except redeem)

  /**
   * Create a single-use invite. The returned token appears only in this
   * response — the caller turns it into a link
   * (`<console-url>/#invite=<token>&server=<api-url>`) and sends it to
   * the teammate. Redeeming mints a key with the invite's name + role.
   */
  async createInvite(input: {
    name: string;
    role?: ApiKeyRole;
    expiresInHours?: number;
  }): Promise<Result<InviteCreateResponse>> {
    return this.request<InviteCreateResponse>('POST', '/api/v1/invites', input);
  }

  async listInvites(): Promise<Result<InviteSummary[]>> {
    return this.request<InviteSummary[]>('GET', '/api/v1/invites');
  }

  async deleteInvite(id: string): Promise<Result<void>> {
    return this.request<void>('DELETE', `/api/v1/invites/${encodeURIComponent(id)}`);
  }

  /**
   * Redeem an invite token for a fresh API key. Unauthenticated — the
   * token itself is the credential — so the console can call it before
   * it has a key. Single-use: a second redemption of the same token
   * fails with 410.
   */
  async redeemInvite(token: string): Promise<Result<ApiKeyCreateResponse>> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(`${this.baseUrl}/bootstrap/redeem-invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.clientTagHeaders() },
        body: JSON.stringify({ token }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        return { success: false, error: new Error(`HTTP ${response.status}: ${errorBody}`) };
      }

      const data = await response.json();
      return { success: true, data: data as ApiKeyCreateResponse };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  // Project methods
  async createProject(input: ProjectInput): Promise<Result<Project>> {
    return this.request<Project>('POST', '/api/v1/projects', input);
  }

  async getProject(id: string): Promise<Result<Project>> {
    return this.request<Project>('GET', `/api/v1/projects/${id}`);
  }

  async listProjects(options?: ListOptions): Promise<Result<Project[]>> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    const query = params.toString();
    return this.request<Project[]>('GET', `/api/v1/projects${query ? `?${query}` : ''}`);
  }

  async deleteProject(id: string): Promise<Result<void>> {
    return this.request<void>('DELETE', `/api/v1/projects/${id}`);
  }

  // Environment methods
  async createEnvironment(input: EnvironmentInput): Promise<Result<Environment>> {
    return this.request<Environment>('POST', `/api/v1/projects/${input.projectId}/environments`, input);
  }

  async getEnvironment(projectId: string, id: string): Promise<Result<Environment>> {
    return this.request<Environment>('GET', `/api/v1/projects/${projectId}/environments/${id}`);
  }

  async listEnvironments(projectId: string, options?: ListOptions): Promise<Result<Environment[]>> {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    const query = params.toString();
    return this.request<Environment[]>('GET', `/api/v1/projects/${projectId}/environments${query ? `?${query}` : ''}`);
  }

  async deleteEnvironment(projectId: string, id: string): Promise<Result<void>> {
    return this.request<void>('DELETE', `/api/v1/projects/${projectId}/environments/${id}`);
  }

  // Per-environment variables ("environment secrets")
  //
  // Stored server-side on the environment and injected into every
  // deploy. Listing returns key names only — values are write-only from
  // the client's perspective, so they can't be read back out.

  /** List the key names of variables stored for an environment. */
  async listEnvVars(projectId: string, environmentId: string): Promise<Result<{ keys: string[] }>> {
    return this.request<{ keys: string[] }>('GET', `/api/v1/projects/${projectId}/environments/${environmentId}/env`);
  }

  /** Set (merge) one or more variables on an environment. Returns the
   *  resulting key names. */
  async setEnvVars(
    projectId: string,
    environmentId: string,
    variables: Record<string, string>
  ): Promise<Result<{ keys: string[] }>> {
    return this.request<{ keys: string[] }>('PUT', `/api/v1/projects/${projectId}/environments/${environmentId}/env`, {
      variables,
    });
  }

  /** Remove one variable from an environment. Returns the remaining
   *  key names. Idempotent — unknown keys are a no-op. */
  async unsetEnvVar(projectId: string, environmentId: string, key: string): Promise<Result<{ keys: string[] }>> {
    return this.request<{ keys: string[] }>(
      'DELETE',
      `/api/v1/projects/${projectId}/environments/${environmentId}/env/${encodeURIComponent(key)}`
    );
  }

  /**
   * Read the live health of an environment's running workload:
   * readiness (desired vs. ready replicas), pod restart state, and —
   * when the cluster's metrics-server is installed — aggregate
   * CPU/memory usage.
   *
   * Only Kubernetes-driven bases (local microVM + generic Kubernetes)
   * expose pod-level health. On AWS/Lambda bases, or when the cluster
   * is unreachable, the server returns `status: 'unknown'` with a
   * `message` rather than an error — callers should render that as
   * "no data" instead of a failure. `usage` is omitted entirely when
   * metrics-server is absent, so consumers must tolerate it being
   * undefined.
   *
   * Older api-server images that predate this route surface a 404 —
   * callers should treat that as "health unknown".
   */
  async getEnvironmentHealth(projectId: string, id: string): Promise<Result<EnvironmentHealth>> {
    return this.request<EnvironmentHealth>('GET', `/api/v1/projects/${projectId}/environments/${id}/health`);
  }

  // Deployment methods
  async deploy(
    environmentId: string,
    options?: {
      /** Explicit control-plane target. Omit for ordinary workload deploys. */
      target?: EdgeDeploymentTarget;
      /** Reference a build created via POST /api/v1/builds (either uploaded or external). */
      buildId?: string;
      /** Runtime environment variables. */
      environment?: Record<string, string>;
      /** Lambda memory in MB. Overrides the build resolver's default. */
      memory?: number;
      /** Lambda timeout in seconds. Overrides the build resolver's default. */
      timeout?: number;
      /** Lambda ephemeral /tmp storage in MB. Overrides the build resolver's default. */
      storage?: number;
      /** Lambda CPU architecture(s). Must match the image's platform for container builds. */
      architectures?: ('x86_64' | 'arm64')[];
      /**
       * Pod count for Kubernetes bases (microVM local runtime + BYO
       * clusters). Omitted → redeploys preserve the current scale.
       * Ignored on Lambda bases.
       */
      replicas?: number;
      /**
       * Reconcile Pulumi state with cloud reality before applying the
       * diff (sets `pulumi up --refresh`). Use when state may have
       * drifted from reality (e.g. partial prior deploy, manual edits).
       * Adds a few seconds per deploy. Ignored for destroy/refresh.
       */
      refresh?: boolean;
    }
  ): Promise<Result<Deployment>> {
    return this.request<Deployment>(
      'POST',
      '/api/v1/deployments',
      {
        environmentId,
        action: 'deploy',
        target: options?.target,
        ...(options?.buildId ? { buildId: options.buildId } : {}),
        ...(options?.environment ? { environment: options.environment } : {}),
        ...(options?.memory !== undefined ? { memory: options.memory } : {}),
        ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
        ...(options?.storage !== undefined ? { storage: options.storage } : {}),
        ...(options?.architectures ? { architectures: options.architectures } : {}),
        ...(options?.replicas !== undefined ? { replicas: options.replicas } : {}),
        ...(options?.refresh !== undefined ? { refresh: options.refresh } : {}),
      },
      600000
    );
  }

  async destroy(environmentId: string): Promise<Result<Deployment>> {
    return this.request<Deployment>(
      'POST',
      '/api/v1/deployments',
      {
        environmentId,
        action: 'destroy',
      },
      600000
    );
  }

  /**
   * Run `pulumi refresh` against the environment's stack to reconcile
   * the Pulumi state file with live cloud reality. Topology is
   * unchanged. Useful after manual cloud-side edits, after a
   * force-cancel, or when investigating drift.
   */
  async refresh(environmentId: string): Promise<Result<Deployment>> {
    return this.request<Deployment>(
      'POST',
      '/api/v1/deployments',
      {
        environmentId,
        action: 'refresh',
      },
      600000
    );
  }

  async getDeployment(id: string): Promise<Result<Deployment>> {
    return this.request<Deployment>('GET', `/api/v1/deployments/${id}`);
  }

  async deployEdge(
    environmentId: string,
    domainName: string,
    zone: { mode: 'create' } | { mode: 'attach'; hostedZoneId: string }
  ): Promise<Result<Deployment>> {
    return this.request<Deployment>('POST', '/api/v1/deployments', {
      environmentId,
      action: 'deploy',
      target: { type: 'edge', domainName, zone },
    });
  }

  async destroyEdge(environmentId: string, domainName: string, hostedZoneId: string): Promise<Result<Deployment>> {
    return this.request<Deployment>('POST', '/api/v1/deployments', {
      environmentId,
      action: 'destroy',
      target: { type: 'edge', domainName, zone: { mode: 'attach', hostedZoneId } },
    });
  }

  /** Dispatch the next bounded worker pass for an edge deployment. */
  async continueDeployment(id: string): Promise<Result<Deployment>> {
    return this.request<Deployment>('POST', `/api/v1/deployments/${id}/continue`, {});
  }

  // Workloads + pod logs
  //
  // Read-only views of the cluster behind this base. Only available on
  // Kubernetes-driven bases — AWS/Lambda bases answer 409 (surfaced as a
  // failed Result). These move the desktop's former kubectl shell-outs
  // behind the api-server so local and cloud are the same base-URL call.

  /**
   * List the workloads (Deployments / Pods / Services) in a namespace.
   * Defaults to the server's configured namespace (`appliance`) when
   * `namespace` is omitted.
   */
  async listWorkloads(opts?: { namespace?: string }): Promise<Result<Workloads>> {
    const params = new URLSearchParams();
    if (opts?.namespace) params.set('namespace', opts.namespace);
    const query = params.toString();
    return this.request<Workloads>('GET', `/api/v1/workloads${query ? `?${query}` : ''}`);
  }

  /**
   * List the workloads backing a single environment, filtered to its
   * stack via the `app.kubernetes.io/name` label.
   */
  async listEnvironmentWorkloads(environmentId: string): Promise<Result<Workloads>> {
    return this.request<Workloads>('GET', `/api/v1/environments/${environmentId}/workloads`);
  }

  /**
   * Read a pod's logs as a text tail (a snapshot, not a stream). For a
   * live follow use `streamPodLogs`. `tailLines` defaults server-side to
   * 200; `container` is required only for multi-container pods.
   */
  async getPodLogs(
    pod: string,
    opts?: { container?: string; tailLines?: number; namespace?: string; sinceSeconds?: number }
  ): Promise<Result<string>> {
    const params = new URLSearchParams();
    if (opts?.container) params.set('container', opts.container);
    if (opts?.tailLines !== undefined) params.set('tailLines', String(opts.tailLines));
    if (opts?.namespace) params.set('namespace', opts.namespace);
    if (opts?.sinceSeconds !== undefined) params.set('sinceSeconds', String(opts.sinceSeconds));
    const query = params.toString();
    return this.requestText('GET', `/api/v1/pods/${encodeURIComponent(pod)}/logs${query ? `?${query}` : ''}`);
  }

  /**
   * Follow a pod's logs, invoking `onLine` for each line until the
   * supplied `AbortSignal` fires (the caller aborts to stop). Signs a
   * body-less GET — auth is checked once, when the stream opens, so a
   * long-lived follow stays open past the signature's `expires` window
   * (control-plane.md §2). Needs its own fetch path because `request`
   * buffers the whole body via `response.json()` and can't yield
   * incrementally.
   *
   * Resolves `{ success: true }` on a clean end (EOF or abort); a
   * connect/transport failure resolves to a failed Result.
   */
  async streamPodLogs(
    pod: string,
    opts: { container?: string; tailLines?: number; namespace?: string; sinceSeconds?: number; signal: AbortSignal },
    onLine: (line: string) => void
  ): Promise<Result<void>> {
    try {
      const params = new URLSearchParams();
      params.set('follow', '1');
      if (opts.container) params.set('container', opts.container);
      if (opts.tailLines !== undefined) params.set('tailLines', String(opts.tailLines));
      if (opts.namespace) params.set('namespace', opts.namespace);
      if (opts.sinceSeconds !== undefined) params.set('sinceSeconds', String(opts.sinceSeconds));
      const url = `${this.baseUrl}/api/v1/pods/${encodeURIComponent(pod)}/logs?${params.toString()}`;

      const headers: Record<string, string> = { ...this.clientTagHeaders() };
      if (this.credentials) {
        const sigHeaders = await signRequest(this.credentials, { method: 'GET', url, headers });
        Object.assign(headers, sigHeaders);
      }

      const response = await fetch(url, { method: 'GET', headers, signal: opts.signal });

      if (!response.ok) {
        const errorBody = await response.text();
        return { success: false, error: new Error(`HTTP ${response.status}: ${errorBody}`) };
      }
      if (!response.body) {
        return { success: false, error: new Error('Log stream response has no body') };
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newlineIndex: number;
          while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
            buffer = buffer.slice(newlineIndex + 1);
            onLine(line);
          }
        }
        // Flush any trailing partial line (a final line without a newline).
        buffer += decoder.decode();
        if (buffer.length > 0) onLine(buffer.replace(/\r$/, ''));
        return { success: true, data: undefined };
      } catch (err) {
        // The caller aborting is the normal way to stop a follow — treat
        // it as a clean close rather than a failure.
        if (opts.signal.aborted) return { success: true, data: undefined };
        throw err;
      }
    } catch (error) {
      if (opts.signal.aborted) return { success: true, data: undefined };
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Unsigned liveness probe (`GET /healthz`). The desktop resolves this
   * as a base-URL HTTP check for its "cluster ready" badge instead of a
   * kubectl reachability shell-out. No credentials required.
   */
  async healthz(): Promise<Result<{ ok: true }>> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(`${this.baseUrl}/healthz`, {
        method: 'GET',
        headers: this.clientTagHeaders(),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        return { success: false, error: new Error(`HTTP ${response.status}: ${errorBody}`) };
      }

      const data = await response.json();
      return { success: true, data: data as { ok: true } };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Fetch this cluster's metadata: the api-server's running version
   * and its parsed base config (`APPLIANCE_BASE_CONFIG`). The desktop
   * Settings page reads `version` to surface "running 1.37.0" and
   * `baseConfig.stateBackendUrl` to drive state promote/demote
   * without asking the operator to paste anything.
   *
   * Older api-server images that predate this route surface a 404 /
   * 500 — callers should fall back to "version unknown, allow update
   * anyway" rather than blocking on the missing data.
   */
  async getClusterInfo(): Promise<Result<ClusterInfoResponse>> {
    return this.request<ClusterInfoResponse>('GET', '/api/v1/cluster-info');
  }

  /**
   * Request cancellation of an in-flight deployment.
   *
   * Cooperative (default): flips the deployment to `cancelling`;
   * the worker observes the flag on its next status poll, calls
   * stack.cancel() on the running Pulumi op, then runs
   * stack.refresh to reconcile state. Final terminal status is
   * `cancelled` — or `succeeded`/`failed` if the underlying
   * operation finished before cancel was observed.
   *
   * Force ({ force: true }): bypasses worker cooperation. The
   * server immediately writes a terminal `cancelled` status without
   * waiting for the worker. Pulumi state is NOT refreshed, so it
   * may diverge from reality — run `pulumi refresh` manually after
   * the worker is reaped. Use only when the worker is presumed
   * dead/stuck and a graceful cancel isn't completing.
   */
  async cancelDeployment(id: string, opts?: { force?: boolean }): Promise<Result<Deployment>> {
    return this.request<Deployment>(
      'POST',
      `/api/v1/deployments/${id}/cancel`,
      opts?.force ? { force: true } : undefined
    );
  }

  async listDeployments(options?: {
    limit?: number;
    offset?: number;
    environmentId?: string;
    projectId?: string;
  }): Promise<Result<Deployment[]>> {
    const params = new URLSearchParams();
    if (options?.limit !== undefined) params.set('limit', String(options.limit));
    if (options?.offset !== undefined) params.set('offset', String(options.offset));
    if (options?.environmentId) params.set('environmentId', options.environmentId);
    if (options?.projectId) params.set('projectId', options.projectId);
    const query = params.toString();
    return this.request<Deployment[]>('GET', `/api/v1/deployments${query ? `?${query}` : ''}`);
  }

  // Build methods

  /**
   * Create a Build record.
   *   - `createBuild()` — type: upload. Response includes a presigned
   *     `uploadUrl` the caller PUTs their zip to.
   *   - `createBuild({ uploadUrl: "<uri>" })` — type: remote-image.
   *     Caller references an image/content URL that already exists.
   *     Response is `{ buildId }` only. Pass `port` to declare the
   *     container port the image serves on — Kubernetes bases wire
   *     the Service to it (remote images carry no manifest to read
   *     it from).
   */
  async createBuild(options?: {
    uploadUrl?: string;
    port?: number;
  }): Promise<Result<{ buildId: string; uploadUrl?: string }>> {
    const body = options?.uploadUrl
      ? { type: 'remote-image' as const, uploadUrl: options.uploadUrl, port: options.port }
      : { type: 'upload' as const };
    return this.request<{ buildId: string; uploadUrl?: string }>('POST', '/api/v1/builds', body);
  }

  async uploadBuild(data: Buffer | Uint8Array): Promise<Result<{ buildId: string }>> {
    try {
      // Step 1: Request a presigned upload URL
      const createResult = await this.createBuild();
      if (!createResult.success) {
        return createResult;
      }

      const { buildId, uploadUrl } = createResult.data;
      if (!uploadUrl) {
        return { success: false, error: new Error('createBuild did not return an uploadUrl') };
      }

      // Step 2: Upload directly to the presigned URL
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 300000);

      const response = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': 'application/zip', ...this.clientTagHeaders() },
        body: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        return { success: false, error: new Error(`Upload failed: HTTP ${response.status}: ${errorBody}`) };
      }

      return { success: true, data: { buildId } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }
}

export function createApplianceClient(config: ClientConfig): ApplianceClient {
  return new ApplianceClient(config);
}
