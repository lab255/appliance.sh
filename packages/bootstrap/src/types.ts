import type { ApplianceBaseConfig, ApplianceBaseConfigInput } from '@appliance.sh/sdk';

export type BootstrapPhase = 'phase1' | 'phase2' | 'phase3';

export interface BootstrapInput {
  /**
   * The single base to install. Multi-base bootstraps are out of
   * scope for v1; they can be driven as subsequent stack updates
   * once the installer stack exists.
   */
  base: {
    name: string;
    config: ApplianceBaseConfigInput;
  };

  /**
   * OCI image URI for the api-server container that phase 2 will
   * deploy as a Lambda. Required for phase 2; ignored for phase 1.
   *
   * In workspace engine the caller supplies a pre-pushed image
   * reference (e.g. `ghcr.io/appliance-sh/api-server:1.27.3` or an
   * image in the user's own ECR). The download engine will source
   * this from the bundled OCI tarball + crane push to the base's
   * ECR in a follow-up commit.
   */
  apiServerImageUri?: string;

  /**
   * AWS auth source. When `profile` is set, every AWS-touching
   * subprocess (Pulumi workspace, the local api-server container in
   * phase 2) is launched with `AWS_PROFILE=<profile>` and any
   * existing access-key env vars are cleared, so the AWS SDK loads
   * credentials from `~/.aws/config` + `~/.aws/credentials` instead
   * of the operator's shell. SSO profiles work transparently — the
   * SDK reads cached tokens from `~/.aws/sso/cache/`. When this
   * field is omitted the bootstrap falls back to whatever AWS env
   * vars are already in the operator's shell.
   */
  aws?: {
    profile?: string;
  };
}

export type BootstrapEngineKind = 'workspace' | 'download';

export interface BootstrapOptions {
  /**
   * Root cache directory for the installer stack. Contains the
   * Pulumi state backend (phase 1), workdir, plugin cache, and —
   * for the download engine — the extracted bootstrapper bundle.
   * Defaults to `~/.appliance`.
   */
  cacheDir?: string;

  /**
   * `workspace`: use the in-repo `@appliance.sh/infra` package
   * directly via Pulumi Automation API. Intended for dev and CI.
   *
   * `download`: fetch a pinned, pre-built bootstrapper bundle for
   * the current platform, extract to cacheDir, spawn its Node
   * entrypoint with this input, and forward events. Intended for
   * production CLI + Desktop installs. Not implemented in v1.
   *
   * Defaults to `workspace`.
   */
  engine?: BootstrapEngineKind;

  /** Override the pinned bootstrapper version (download engine only). */
  bootstrapperVersion?: string;

  /** Stream of progress events. Drivers plug in their own UI here. */
  onEvent?: (event: BootstrapEvent) => void;

  /**
   * Phase gating. Defaults to running all three. Setting this to
   * e.g. `['phase1']` runs only the base infra and stops — useful
   * when the api-server image isn't ready yet.
   */
  phases?: BootstrapPhase[];

  /**
   * Outputs of phases that have already succeeded in a prior run.
   * When set, the engine seeds its internal state from these instead
   * of requiring the producing phase to be re-executed. Used to
   * implement per-phase retry from the UI: a phase 2 failure can
   * be retried as `{ phases: ['phase2', 'phase3'], prior: { phase1: ... } }`
   * without re-running phase 1. Each entry must come from a real
   * prior success of that phase — there is no validation that
   * `stateBackendUrl` actually points at a live Pulumi backend.
   */
  prior?: BootstrapPriorOutputs;
}

export interface BootstrapPriorOutputs {
  phase1?: { stateBackendUrl: string; baseConfig: ApplianceBaseConfig };
  phase2?: { apiServerUrl: string; apiKey: { id: string; secret: string } };
}

export interface BootstrapResult {
  /** Pulumi state backend URL for this installation (phase 1). */
  stateBackendUrl: string;
  /** Lambda Function URL of the hoisted api-server (phase 2). */
  apiServerUrl?: string;
  /** First-boot API key returned by `/bootstrap/create-key` (phase 2). */
  apiKey?: { id: string; secret: string };
  /** `true` once state has been moved from local file to S3 (phase 3). */
  statePromoted?: boolean;
  /** Present only when the desktop sidecar used the new CFN installer. */
  installGeneration?: 'cloudformation-v1';
  cloudFormationStackName?: string;
  awsAccountId?: string;
  awsRegion?: string;
}

export interface CloudFormationInstallationRef {
  installGeneration: 'cloudformation-v1';
  cloudFormationStackName: string;
  awsAccountId: string;
  awsRegion: string;
}

export type BootstrapEvent =
  | { type: 'phase-started'; phase: BootstrapPhase }
  | { type: 'phase-skipped'; phase: BootstrapPhase; reason: string }
  | { type: 'phase-completed'; phase: BootstrapPhase }
  | { type: 'phase-failed'; phase: BootstrapPhase; error: string }
  | { type: 'phase-output'; phase: 'phase1'; output: NonNullable<BootstrapPriorOutputs['phase1']> }
  | { type: 'phase-output'; phase: 'phase2'; output: NonNullable<BootstrapPriorOutputs['phase2']> }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | {
      type: 'resource';
      op: 'create' | 'update' | 'delete' | 'same' | 'replace';
      resourceType: string;
      name: string;
    };
