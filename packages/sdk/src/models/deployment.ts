import { z } from 'zod';

export enum DeploymentAction {
  Deploy = 'deploy',
  Destroy = 'destroy',
  // Pulumi `refresh` — reconciles the stack's state file with live
  // cloud reality. Used to recover from drift, after a force-cancel,
  // or after manual cloud-side changes. Doesn't change topology.
  Refresh = 'refresh',
}

export enum DeploymentStatus {
  Pending = 'pending',
  InProgress = 'in_progress',
  // Cancellation requested. The worker observes this on its
  // periodic status poll and calls stack.cancel() on the Pulumi
  // operation. Transient — flips to Cancelled or Failed once the
  // worker acknowledges and reconciles state via refresh.
  Cancelling = 'cancelling',
  Succeeded = 'succeeded',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

export const edgeDeploymentTarget = z.object({
  type: z.literal('edge'),
  domainName: z.string().min(1),
  zone: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('create') }),
    z.object({ mode: z.literal('attach'), hostedZoneId: z.string().min(1) }),
  ]),
});

export type EdgeDeploymentTarget = z.infer<typeof edgeDeploymentTarget>;

export const deploymentInput = z
  .object({
    environmentId: z.string(),
    action: z.nativeEnum(DeploymentAction),
    // Explicit infrastructure target. Project/environment names never
    // implicitly select this path; the api-server separately validates
    // that edge targets use the reserved appliance-system/edge record.
    target: edgeDeploymentTarget.optional(),
    buildId: z.string().optional(),
    environment: z.record(z.string(), z.string()).optional(),
    // Per-deploy Lambda runtime overrides. When set, they win over the
    // build resolver's defaults (which come from the manifest in the
    // upload-zip flow, and are absent in the remote-image flow). Useful
    // for remote-image deploys where the manifest never reaches the
    // server, and as a per-deploy escape hatch in general.
    memory: z.number().int().positive().optional(),
    timeout: z.number().int().positive().optional(),
    storage: z.number().int().positive().optional(),
    // Lambda CPU architecture. Must match one of the image manifest's
    // platforms (for container builds) or the Lambda Web Adapter
    // layer's arch (for framework builds). Defaults to ['x86_64'] when
    // omitted, which matches Lambda's own default.
    architectures: z.array(z.enum(['x86_64', 'arm64'])).optional(),
    // Pod count for Kubernetes bases (microVM local runtime + BYO
    // clusters). When omitted, a redeploy preserves the environment's
    // current scale (first deploy: 1). Ignored on Lambda bases, where
    // concurrency is ambient.
    replicas: z.number().int().min(1).max(100).optional(),
    // Reconcile Pulumi state with cloud reality before computing the
    // diff (deploys an effective `pulumi up --refresh`). Used by the
    // dogfood self-update path to recover from stale provider state
    // — `pulumi refresh` standalone uses cached provider state and
    // can't recover from bad provider config, but `up --refresh`
    // re-runs the inline program first and gets fresh providers.
    // Ignored for destroy / refresh actions.
    refresh: z.boolean().optional(),
  })
  .superRefine((input, ctx) => {
    if (!input.target) return;
    const incompatible = [
      ['buildId', input.buildId],
      ['environment', input.environment],
      ['memory', input.memory],
      ['timeout', input.timeout],
      ['storage', input.storage],
      ['architectures', input.architectures],
      ['replicas', input.replicas],
    ] as const;
    for (const [field, value] of incompatible) {
      if (value !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} cannot be used with an edge deployment target`,
        });
      }
    }
  });

export type DeploymentInput = z.infer<typeof deploymentInput>;

export const deployment = z.object({
  environmentId: z.string(),
  action: z.nativeEnum(DeploymentAction),
  target: edgeDeploymentTarget.optional(),
  buildId: z.string().optional(),
  id: z.string(),
  projectId: z.string(),
  status: z.nativeEnum(DeploymentStatus),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  message: z.string().optional(),
  idempotentNoop: z.boolean().optional(),
  // Edge-only continuation lease. A completed bounded worker pass marks
  // `ready`; the polling driver atomically advances it to `running` before
  // dispatching the next invocation.
  edgeConvergence: z
    .object({
      state: z.enum(['running', 'ready', 'converged']),
      attempt: z.number().int().positive(),
    })
    .optional(),
});

export type Deployment = z.infer<typeof deployment>;
