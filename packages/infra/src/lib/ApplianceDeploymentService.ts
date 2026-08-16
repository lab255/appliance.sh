import * as fs from 'node:fs';
import * as path from 'node:path';
import * as pulumi from '@pulumi/pulumi';
import * as auto from '@pulumi/pulumi/automation';
import * as aws from '@pulumi/aws';
import * as awsNative from '@pulumi/aws-native';
import { ApplianceStack, ApplianceStackMetadata, toResourceId } from './aws/ApplianceStack';
import { ApplianceEdgeBase } from './aws/ApplianceEdgeBase';
import { ApplianceSystemSubstrate } from './aws/ApplianceSystemSubstrate';
import { applianceBaseConfig, type ApplianceBaseConfig, type EdgeDeploymentTarget } from '@appliance.sh/sdk';

// Plugin cache + PULUMI_HOME layout in the api-server container image.
// The Dockerfile pre-downloads each pinned Pulumi plugin into
// PLUGIN_CACHE_DIR at build time so cold starts on Lambda don't have to
// fetch them; `ensurePluginCache` symlinks those into CONTAINER_PULUMI_HOME
// on the worker's first deploy. Both paths live under /tmp because
// Lambda's filesystem is read-only outside of it.
//
// LOCAL dev hits neither of these — there's no /opt/pulumi-cache, and
// forcing PULUMI_HOME under /tmp on a developer machine would just
// shadow the developer's normal `~/.pulumi` (with its plugin cache,
// config, telemetry opt-out, etc.). `pulumiHome()` returns undefined
// in that case, so we leave PULUMI_HOME unset and Pulumi falls back
// to its default location with normal auto-downloading.
const CONTAINER_PULUMI_HOME = '/tmp/.pulumi';
const PLUGIN_CACHE_DIR = '/opt/pulumi-cache/plugins';

export type PulumiAction = 'deploy' | 'destroy' | 'refresh';

export interface PulumiResult {
  action: PulumiAction;
  ok: boolean;
  idempotentNoop: boolean;
  message: string;
  stackName: string;
  /**
   * Public URL the deployed appliance can be reached at, when known.
   * Local deploys derive it from the assigned k3d NodePort; cloud
   * deploys leave it undefined for now (a future change will read
   * stack outputs to populate it). Consumers must tolerate undefined.
   */
  url?: string;
  /** Resolved epoch-2 config returned by an edge deployment. */
  baseConfig?: ApplianceBaseConfig;
  /** Edge-only: true only after a no-change verification pass. */
  converged?: boolean;
}

export interface ResolvedBuildParams {
  imageUri?: string;
  codeS3Key?: string;
  runtime?: string;
  handler?: string;
  layers?: string[];
  architectures?: string[];
  environment?: Record<string, string>;
  memory?: number;
  timeout?: number;
  storage?: number;
  // Pre-existing IAM role ARN. When set, ApplianceStack binds the
  // Lambda to this role instead of minting one. Used by the dogfooded
  // bootstrap path for the system api-server + worker appliances,
  // which need broader IAM than ApplianceStack's per-appliance role.
  lambdaRoleArn?: string;
}

export interface ApplianceDeploymentServiceOptions {
  baseConfig?: ApplianceBaseConfig;
}

export class ApplianceDeploymentService {
  private readonly projectName = 'appliance-api-managed-proj';
  private readonly edgeProjectName = 'appliance-edge-managed-proj';
  private readonly baseConfig: ApplianceBaseConfig | undefined;
  private readonly region: string;

  constructor(options?: ApplianceDeploymentServiceOptions) {
    this.baseConfig =
      options?.baseConfig ??
      (process.env.APPLIANCE_BASE_CONFIG
        ? applianceBaseConfig.parse(JSON.parse(process.env.APPLIANCE_BASE_CONFIG))
        : undefined);
    // AWS service: refuse non-AWS bases at construction time so the
    // type-narrowed `.aws!` accesses below have a documented invariant.
    // Other base types (e.g. `appliance-base-local`) route through their
    // own service in the api-server executor.
    if (this.baseConfig && !this.baseConfig.aws) {
      throw new Error(
        `ApplianceDeploymentService requires an AWS-typed base config; got type '${this.baseConfig.type}'`
      );
    }
    this.region = this.baseConfig?.aws?.region || 'us-east-1';
  }

  private inlineProgram(stackName: string, metadata?: ApplianceStackMetadata, build?: ResolvedBuildParams) {
    return async () => {
      if (!this.baseConfig) {
        throw new Error('Missing base config');
      }

      const rid = toResourceId(stackName);
      const regionalProvider = new aws.Provider(`${rid}-regional`, {
        region: (this.baseConfig?.aws?.region as aws.Region) ?? 'ap-southeast-1',
      });
      const globalProvider = new aws.Provider(`${rid}-global`, {
        region: 'us-east-1',
      });
      // `ignoreChanges: ['profile']` defends against state drift on
      // the provider's `profile` field. Local bootstrap runs spawn
      // the api-server container with `AWS_PROFILE` in its env (so
      // SSO / shared-credential profiles work for the local Pulumi
      // process), which pulumi-aws-native captures into provider
      // state on first deploy. Cloud-worker runs of the same stack
      // have no AWS_PROFILE — so the next refresh/up sees a diff
      // and replaces the provider, which forces a re-import of every
      // child resource. pulumi-aws-native@1.58 has a panic in
      // ParseCheckpointObject on that re-import path (`interface
      // conversion: interface {} is nil, not resource.PropertyMap`),
      // which corrupts the resource state with `__inputs` missing.
      // Telling Pulumi to ignore the field stops the replacement and
      // sidesteps the bug entirely.
      const nativeProviderOpts: pulumi.ResourceOptions = { ignoreChanges: ['profile'] };
      const nativeRegionalProvider = new awsNative.Provider(
        `${rid}-native-regional`,
        {
          region: (this.baseConfig?.aws?.region as awsNative.Region) ?? 'ap-southeast-1',
        },
        nativeProviderOpts
      );

      const nativeGlobalProvider = new awsNative.Provider(
        `${rid}-native-global`,
        {
          region: 'us-east-1',
        },
        nativeProviderOpts
      );

      const applianceStack = new ApplianceStack(
        stackName,
        {
          metadata,
          config: this.baseConfig,
          imageUri: build?.imageUri,
          codeS3Key: build?.codeS3Key,
          runtime: build?.runtime,
          handler: build?.handler,
          layers: build?.layers,
          architectures: build?.architectures,
          environment: build?.environment,
          memory: build?.memory,
          timeout: build?.timeout,
          storage: build?.storage,
          lambdaRoleArn: build?.lambdaRoleArn,
        },
        {
          globalProvider,
          provider: regionalProvider,
          nativeProvider: nativeRegionalProvider,
          nativeGlobalProvider: nativeGlobalProvider,
        }
      );

      return {
        applianceStack,
      };
    };
  }

  private inlineEdgeProgram(stackName: string, target: EdgeDeploymentTarget) {
    return async () => {
      if (!this.baseConfig) throw new Error('Missing base config');
      const substrate = ApplianceSystemSubstrate.fromBaseConfig(this.baseConfig);
      const rid = toResourceId(stackName);
      const globalProvider = new aws.Provider(`${rid}-edge-global`, { region: 'us-east-1' });
      const edge = new ApplianceEdgeBase(
        stackName,
        {
          substrate,
          domain: {
            domainName: target.domainName,
            zone: target.zone,
          },
        },
        { globalProvider }
      );
      return {
        baseConfig: edge.config,
        apiServerPublicUrl: edge.apiServerPublicUrl,
      };
    };
  }

  /**
   * Resolve the PULUMI_HOME the spawned pulumi process should use.
   * Container image: returns `/tmp/.pulumi` (Lambda's only writable
   * area), with plugins pre-seeded from /opt. Local dev: returns
   * undefined so Pulumi uses its own default (`~/.pulumi`) and
   * auto-downloads plugins normally — overriding to /tmp on a dev
   * machine would point pulumi at an empty home with no plugins
   * and no auto-install path.
   */
  private pulumiHome(): string | undefined {
    return fs.existsSync(PLUGIN_CACHE_DIR) ? CONTAINER_PULUMI_HOME : undefined;
  }

  /**
   * Build the env vars passed to the Pulumi Automation API workspace.
   * PULUMI_HOME is shared across every project the worker handles — this
   * keeps one plugin cache (pre-seeded from /opt at image build time)
   * reused across projects. Per-project isolation is handled via
   * `workDir` instead. In local dev PULUMI_HOME is left unset.
   */
  private buildEnvVars(): Record<string, string> {
    if (!this.baseConfig) {
      throw new Error('Missing base config');
    }
    if (!this.baseConfig.stateBackendUrl) {
      throw new Error('Cloud bases require a stateBackendUrl in APPLIANCE_BASE_CONFIG');
    }
    const home = this.pulumiHome();
    if (home) this.ensurePluginCache(home);
    return {
      AWS_REGION: this.region,
      PULUMI_BACKEND_URL: this.baseConfig.stateBackendUrl,
      ...(home ? { PULUMI_HOME: home } : {}),
    };
  }

  /**
   * Materialise each precached plugin from /opt/pulumi-cache/plugins
   * into ${PULUMI_HOME}/plugins. Plugin *directories* must be real
   * directories at the target path — pulumi's plugin scanner skips
   * symlinks-to-directories (verified against pulumi 3.231) — so for
   * each precached subdir we create a real dir and symlink each file
   * inside. Loose top-level files (e.g. `<plugin>.lock`) get a
   * straight symlink.
   *
   * The result: plugin binaries stay on the read-only /opt cache
   * (no copy, no /tmp bloat), while ${PULUMI_HOME}/plugins remains
   * writable for pulumi's own metadata.
   */
  private ensurePluginCache(pulumiHome: string): void {
    if (!fs.existsSync(PLUGIN_CACHE_DIR)) return;
    const target = path.join(pulumiHome, 'plugins');
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(PLUGIN_CACHE_DIR)) {
      const sourcePath = path.join(PLUGIN_CACHE_DIR, entry);
      const targetPath = path.join(target, entry);
      // lstatSync the SOURCE to know whether it's a dir; lstatSync
      // the TARGET to skip work when already materialised.
      const sourceStat = fs.lstatSync(sourcePath);
      let targetExists = true;
      try {
        fs.lstatSync(targetPath);
      } catch {
        targetExists = false;
      }
      if (targetExists) continue;

      if (sourceStat.isDirectory()) {
        fs.mkdirSync(targetPath, { recursive: true });
        for (const inner of fs.readdirSync(sourcePath)) {
          fs.symlinkSync(path.join(sourcePath, inner), path.join(targetPath, inner));
        }
      } else {
        fs.symlinkSync(sourcePath, targetPath);
      }
    }
  }

  /**
   * Per-project scratch directory that Pulumi uses as the inline program's
   * workDir. Isolating this dir per project prevents concurrent deploys
   * across projects from racing on Pulumi.yaml or the local tmp state
   * that the Automation API writes during a run.
   */
  private workDirFor(projectId?: string): string {
    const dir = projectId ? `/tmp/pulumi-workdir-${projectId}` : '/tmp/pulumi-workdir';
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Build the AWS KMS secrets provider URL for stack init. Pulumi's
   * `awskms://` form takes the key ARN/ID + region. Returns undefined
   * when the base hasn't been provisioned with a state KMS key (older
   * clusters), in which case the workspace falls back to whatever
   * PULUMI_CONFIG_PASSPHRASE is set to.
   */
  private secretsProvider(): string | undefined {
    const arn = this.baseConfig?.aws?.kmsKeyArn;
    if (!arn) return undefined;
    return `awskms://${arn}?region=${this.region}`;
  }

  private async getOrCreateStack(
    stackName: string,
    metadata?: ApplianceStackMetadata,
    build?: ResolvedBuildParams
  ): Promise<auto.Stack> {
    const program = this.inlineProgram(stackName, metadata, build);
    const envVars = this.buildEnvVars();
    const workDir = this.workDirFor(metadata?.projectId);
    const secretsProvider = this.secretsProvider();

    const stack = await auto.LocalWorkspace.createOrSelectStack(
      { projectName: this.projectName, stackName, program },
      { envVars, workDir, ...(secretsProvider ? { secretsProvider } : {}) }
    );
    await stack.setConfig('aws:region', { value: this.baseConfig!.aws!.region });
    await this.clearStaleProfileConfig(stack);
    return stack;
  }

  private async getOrCreateEdgeStack(stackName: string, target: EdgeDeploymentTarget): Promise<auto.Stack> {
    const program = this.inlineEdgeProgram(stackName, target);
    const envVars = this.buildEnvVars();
    const workDir = this.workDirFor('system-edge');
    const secretsProvider = this.secretsProvider();
    const stack = await auto.LocalWorkspace.createOrSelectStack(
      { projectName: this.edgeProjectName, stackName, program },
      { envVars, workDir, ...(secretsProvider ? { secretsProvider } : {}) }
    );
    await stack.setConfig('aws:region', { value: 'us-east-1' });
    await this.clearStaleProfileConfig(stack);
    return stack;
  }

  private async selectExistingStack(
    stackName: string,
    projectId?: string,
    projectName = this.projectName
  ): Promise<auto.Stack> {
    const envVars = this.buildEnvVars();
    const workDir = this.workDirFor(projectId);

    const ws = await auto.LocalWorkspace.create({
      projectSettings: { name: projectName, runtime: 'nodejs' },
      workDir,
      envVars,
    });

    const stack = await auto.Stack.createOrSelect(stackName, ws);
    await this.clearStaleProfileConfig(stack);
    return stack;
  }

  /**
   * Clear any AWS-profile config that may be lingering on the stack.
   * Lambdas authenticate via their execution role; profile lookups
   * always fail in-Lambda (no `~/.aws/config` to read) and surface
   * as `failed to get shared config profile, <X>` errors during
   * resource refresh. We don't set these keys ourselves but defend
   * against stack state that picked them up from elsewhere — e.g.
   * earlier code paths, an operator running `pulumi config set`
   * out-of-band, or a buggy provider version.
   */
  private async clearStaleProfileConfig(stack: auto.Stack): Promise<void> {
    for (const key of ['aws:profile', 'aws-native:profile']) {
      try {
        await stack.removeConfig(key);
      } catch {
        // removeConfig throws when the key isn't set — that's the
        // common case and is fine.
      }
    }
  }

  async deploy(
    stackName: string,
    metadata?: ApplianceStackMetadata,
    build?: ResolvedBuildParams,
    opts?: PulumiOpOptions
  ): Promise<PulumiResult> {
    const stack = await this.getOrCreateStack(stackName, metadata, build);
    opts?.onStack?.(stack);
    // `refresh: true` reconciles Pulumi state with AWS reality before
    // computing the diff. Used by system-stack deploys (dogfood
    // bootstrap), where an earlier failed update can leave state
    // recording resource attributes that AWS never actually applied —
    // a subsequent deploy then sees no diff and skips the fix-up,
    // freezing the function at its broken state. Refresh adds a few
    // seconds per deploy but breaks the loop.
    const result = await stack.up({ onOutput: (m) => console.log(m), refresh: opts?.refresh });
    const changes = result.summary.resourceChanges || {};
    const totalChanges = Object.entries(changes)
      .filter(([k]) => k !== 'same')
      .reduce((acc, [, v]) => acc + (v || 0), 0);
    const idempotentNoop = totalChanges === 0;
    return {
      action: 'deploy',
      ok: true,
      idempotentNoop,
      message: idempotentNoop ? 'No changes (idempotent)' : 'Stack updated',
      stackName,
    };
  }

  /**
   * One bounded edge convergence pass. A successful pass that changed
   * resources deliberately returns `converged:false`; the next invocation
   * verifies a no-change plan before the control plane publishes epoch 2.
   */
  async convergeEdge(stackName: string, target: EdgeDeploymentTarget, opts?: PulumiOpOptions): Promise<PulumiResult> {
    const stack = await this.getOrCreateEdgeStack(stackName, target);
    opts?.onStack?.(stack);
    let softDeadlineReached = false;
    const timer = opts?.softDeadlineMs
      ? setTimeout(() => {
          softDeadlineReached = true;
          // Known live-test watch-item: Pulumi cancel is an unsafe emergency
          // operation. A create that never checkpointed (for example hosted-zone
          // creation or a retried distribution CNAMEAlreadyExists) can orphan or
          // duplicate resources. Keep this bounded-pass behavior under AWS testing.
          // Cancellation is best-effort: the `up` rejection is the signal this
          // pass waits for. Avoid leaking an unhandled rejection if the CLI has
          // already exited by the time the soft-deadline callback runs.
          void stack.cancel().catch((error) => {
            console.warn('Failed to cancel edge Pulumi pass at its soft deadline', error);
          });
        }, opts.softDeadlineMs)
      : undefined;
    let result: auto.UpResult;
    try {
      result = await stack.up({ onOutput: (message) => console.log(message), refresh: opts?.refresh });
    } catch (error) {
      if (!softDeadlineReached) throw error;
      await stack.refresh({ onOutput: (message) => console.log(message) });
      return {
        action: 'deploy',
        ok: true,
        converged: false,
        idempotentNoop: false,
        message: 'Edge still converging; soft deadline reached and Pulumi state was refreshed',
        stackName,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
    const changes = result.summary.resourceChanges || {};
    const totalChanges = Object.entries(changes)
      .filter(([kind]) => kind !== 'same')
      .reduce((total, [, count]) => total + (count || 0), 0);
    const baseConfig = result.outputs.baseConfig?.value as ApplianceBaseConfig | undefined;
    const url = result.outputs.apiServerPublicUrl?.value as string | undefined;
    if (!baseConfig || !url) throw new Error('Edge convergence pass completed without its resolved config outputs');
    const converged = totalChanges === 0;
    return {
      action: 'deploy',
      ok: true,
      converged,
      idempotentNoop: converged,
      message: converged ? 'Edge converged (verified no changes)' : 'Edge applied changes; verification pass required',
      stackName,
      url,
      baseConfig,
    };
  }

  async destroyEdge(stackName: string, opts?: PulumiOpOptions): Promise<PulumiResult> {
    try {
      const stack = await this.selectExistingStack(stackName, 'system-edge', this.edgeProjectName);
      opts?.onStack?.(stack);
      let softDeadlineReached = false;
      const timer = opts?.softDeadlineMs
        ? setTimeout(() => {
            softDeadlineReached = true;
            void stack.cancel().catch((error) => {
              console.warn('Failed to cancel edge destroy pass at its soft deadline', error);
            });
          }, opts.softDeadlineMs)
        : undefined;
      let result: auto.DestroyResult;
      try {
        result = await stack.destroy({ onOutput: (message) => console.log(message) });
      } catch (error) {
        if (!softDeadlineReached) throw error;
        await stack.refresh({ onOutput: (message) => console.log(message) });
        return {
          action: 'destroy',
          ok: true,
          converged: false,
          idempotentNoop: false,
          message: 'Edge destroy still converging; soft deadline reached and Pulumi state was refreshed',
          stackName,
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
      const changes = result.summary.resourceChanges || {};
      const totalChanges = Object.entries(changes)
        .filter(([kind]) => kind !== 'same')
        .reduce((total, [, count]) => total + (count || 0), 0);
      const converged = totalChanges === 0;
      return {
        action: 'destroy',
        ok: true,
        converged,
        idempotentNoop: converged,
        message: converged
          ? 'Edge destroy converged (verified no remaining resources)'
          : 'Edge resources deleted; verification pass required',
        stackName,
      };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (error.message.includes('no stack named') || error.message.includes('not found')) {
        return {
          action: 'destroy',
          ok: true,
          converged: true,
          idempotentNoop: true,
          message: 'Edge stack not found (idempotent)',
          stackName,
        };
      }
      throw error;
    }
  }

  async refreshEdge(stackName: string, opts?: PulumiOpOptions): Promise<PulumiResult> {
    try {
      const stack = await this.selectExistingStack(stackName, 'system-edge', this.edgeProjectName);
      opts?.onStack?.(stack);
      const result = await stack.refresh({ onOutput: (message) => console.log(message) });
      const changes = result.summary.resourceChanges || {};
      const totalChanges = Object.entries(changes)
        .filter(([kind]) => kind !== 'same')
        .reduce((total, [, count]) => total + (count || 0), 0);
      return {
        action: 'refresh',
        ok: true,
        idempotentNoop: totalChanges === 0,
        message: totalChanges === 0 ? 'No edge drift' : 'Edge state refreshed',
        stackName,
      };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (error.message.includes('no stack named') || error.message.includes('not found')) {
        return {
          action: 'refresh',
          ok: true,
          idempotentNoop: true,
          message: 'Edge stack not found (nothing to refresh)',
          stackName,
        };
      }
      throw error;
    }
  }

  async destroy(stackName: string, projectId?: string, opts?: PulumiOpOptions): Promise<PulumiResult> {
    try {
      const stack = await this.selectExistingStack(stackName, projectId);
      opts?.onStack?.(stack);
      await stack.destroy({ onOutput: (m) => console.log(m) });
      return { action: 'destroy', ok: true, idempotentNoop: false, message: 'Stack resources deleted', stackName };
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      const msg = String(e?.message || e);
      if (msg.includes('no stack named') || msg.includes('not found')) {
        return {
          action: 'destroy',
          ok: true,
          idempotentNoop: true,
          message: 'Stack not found (idempotent)',
          stackName,
        };
      }
      throw e;
    }
  }

  async refresh(stackName: string, projectId?: string, opts?: PulumiOpOptions): Promise<PulumiResult> {
    try {
      const stack = await this.selectExistingStack(stackName, projectId);
      opts?.onStack?.(stack);
      const result = await stack.refresh({ onOutput: (m) => console.log(m) });
      const changes = result.summary.resourceChanges || {};
      const totalChanges = Object.entries(changes)
        .filter(([k]) => k !== 'same')
        .reduce((acc, [, v]) => acc + (v || 0), 0);
      const idempotentNoop = totalChanges === 0;
      return {
        action: 'refresh',
        ok: true,
        idempotentNoop,
        message: idempotentNoop ? 'No drift (state matched reality)' : 'State refreshed',
        stackName,
      };
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      const msg = String(e?.message || e);
      if (msg.includes('no stack named') || msg.includes('not found')) {
        return {
          action: 'refresh',
          ok: true,
          idempotentNoop: true,
          message: 'Stack not found (nothing to refresh)',
          stackName,
        };
      }
      throw e;
    }
  }
}

// Options for in-flight Pulumi operations. `onStack` hands the
// caller a structural handle to the live Pulumi Stack so it can
// invoke stack.cancel() / stack.refresh() out of band — used by the
// api-server's cancel-aware executor. Structural typing here avoids
// pinning consumers to a specific @pulumi/pulumi resolution
// (workspace packages can otherwise end up with two parallel copies
// that fail nominal type identity).
export interface PulumiOpOptions {
  onStack?: (stack: PulumiStackHandle) => void;
  /**
   * Deploy-only: refresh Pulumi state from AWS before computing the
   * update plan. Mitigates state-vs-reality drift after a partially
   * failed prior deploy. Ignored for destroy/refresh.
   */
  refresh?: boolean;
  /** Edge-only wall-clock budget before cancel+refresh yields a continuation. */
  softDeadlineMs?: number;
}

export interface PulumiStackHandle {
  cancel(): Promise<void>;
  refresh(opts?: { onOutput?: (m: string) => void }): Promise<unknown>;
}

// Factory function to create the service
export function createApplianceDeploymentService(
  options?: ApplianceDeploymentServiceOptions
): ApplianceDeploymentService {
  return new ApplianceDeploymentService(options);
}
