import { z } from 'zod';

export enum ApplianceBaseType {
  ApplianceAwsPublic = 'appliance-base-aws-public',
  ApplianceAwsVpc = 'appliance-base-aws-vpc',
  /**
   * @deprecated Use {@link ApplianceBaseType.ApplianceKubernetes}. This
   * was the host-side k3d local runtime, which has been removed — the
   * microVM (an `appliance-base-kubernetes` cluster under the hood) is
   * now the sole local runtime. The enum value & schema are retained
   * for back-compat: the executor/infra still branch on it for deploys
   * created before the cutover.
   */
  ApplianceLocal = 'appliance-base-local',
  // Generic Kubernetes base: api-server drives an arbitrary k8s
  // cluster identified by URL + credentials (inline kubeconfig or
  // server + token). The microVM local runtime uses this variant. The
  // sole Kubernetes-driven base going forward.
  ApplianceKubernetes = 'appliance-base-kubernetes',
  /**
   * @deprecated The plain-Docker runtime (the host daemon's
   * `--runtime docker`) has been removed — the microVM local runtime
   * is the sole local base. The enum value & schema are retained for
   * back-compat: existing configs still parse, and the api-server's
   * base fork (deployment-backend.ts) maps them to a clear
   * "runtime removed" error with migration guidance.
   */
  ApplianceDocker = 'appliance-base-docker',
}

// True for any base whose deploys go through the Kubernetes API
// client (KubernetesDeploymentService), rather than Pulumi. Use
// this to gate branches that are about "is this a k8s-driven base."
// Stays true for `appliance-base-kubernetes` (the microVM runtime and
// BYO clusters) and the deprecated `appliance-base-local` alias.
// Doubles as a TypeScript type guard: callers that pass a
// discriminated-union value get the union narrowed to the k8s
// variants on the truthy branch and the non-k8s variants on the
// falsy branch.
export function isKubernetesBase<T extends { type: ApplianceBaseType }>(
  config: T
): config is T & { type: ApplianceBaseType.ApplianceLocal | ApplianceBaseType.ApplianceKubernetes } {
  return config.type === ApplianceBaseType.ApplianceLocal || config.type === ApplianceBaseType.ApplianceKubernetes;
}

// True for the plain-Docker base (the single-binary local daemon).
// Deploys are containers on a Docker daemon: no Pulumi, no k8s client.
export function isDockerBase<T extends { type: ApplianceBaseType }>(
  config: T
): config is T & { type: ApplianceBaseType.ApplianceDocker } {
  return config.type === ApplianceBaseType.ApplianceDocker;
}

export const applianceBaseInput = z.object({
  name: z.string(),
  dns: z.object({
    domainName: z.string(),
    createZone: z.boolean().optional().default(true),
    attachZone: z.boolean().optional().default(true),
  }),
});

export const applianceBaseAwsInput = applianceBaseInput.extend({
  region: z.string(),
});

export const applianceAwsPublicInput = applianceBaseAwsInput.extend({
  type: z.literal(ApplianceBaseType.ApplianceAwsPublic),
});

export type ApplianceBaseAwsPublicInput = z.infer<typeof applianceAwsPublicInput>;

export const applianceAwsVpcInput = applianceBaseAwsInput.extend({
  type: z.literal(ApplianceBaseType.ApplianceAwsVpc),
  vpc: z.union([
    z.object({
      vpcCidr: z.string(),
      numberOfAzs: z.number().int().min(1).max(3),
    }),
    z.object({
      vpcId: z.string(),
    }),
  ]),
});

export type ApplianceBaseAwsVpcInput = z.infer<typeof applianceAwsVpcInput>;

/**
 * @deprecated Use {@link applianceKubernetesInput}. The host-side k3d
 * local runtime this described has been removed; retained so deploys
 * created before the cutover still parse. `dns` is omitted because
 * services are reached via a NodePort/Ingress published by the local
 * runtime — there is no Route 53 equivalent.
 */
export const applianceLocalInput = applianceBaseInput.omit({ dns: true }).extend({
  type: z.literal(ApplianceBaseType.ApplianceLocal),
  cluster: z
    .object({
      // Cluster name. Defaults to `appliance-local` when omitted.
      clusterName: z.string().optional(),
      // Kubernetes namespace appliances get deployed into. Auto-created
      // by the deployment service on first deploy when missing.
      namespace: z.string().optional(),
      // Host port the cluster's loadbalancer exposes (mapped to
      // service NodePorts inside the cluster). Defaults to 8081.
      hostPort: z.number().int().min(1).max(65535).optional(),
    })
    .optional(),
});

/** @deprecated Use {@link ApplianceKubernetesInput}. */
export type ApplianceLocalInput = z.infer<typeof applianceLocalInput>;

// Generic Kubernetes base. The caller supplies enough to construct a
// `@kubernetes/client-node` KubeConfig and the api-server takes it
// from there. Exactly one of `token` (with optional `ca` + required
// `server`) or `kubeconfig` (inline YAML) must be supplied — when
// running in-cluster, both can be omitted and the api-server will
// fall back to `kc.loadFromCluster()`.
export const applianceKubernetesInput = applianceBaseInput.omit({ dns: true }).extend({
  type: z.literal(ApplianceBaseType.ApplianceKubernetes),
  kubernetes: z.object({
    // https://kube.example.com:6443. Required when authenticating
    // with a bearer token. Omit when supplying `kubeconfig` or
    // relying on in-cluster discovery.
    server: z.string().optional(),
    // base64-encoded CA bundle for the apiserver's TLS cert.
    ca: z.string().optional(),
    // ServiceAccount bearer token. Mutex with `kubeconfig`.
    token: z.string().optional(),
    // Inline kubeconfig YAML. Mutex with `server`/`token`.
    kubeconfig: z.string().optional(),
    // Path to a kubeconfig file, read lazily at deploy time. The guest
    // api-server binary uses this to point at its local k3s
    // (`/etc/rancher/k3s/k3s.yaml`) without inlining a file that may
    // not exist yet when the server starts.
    kubeconfigPath: z.string().optional(),
    // Namespace appliances deploy into. Defaults to `appliance`.
    namespace: z.string().optional(),
    // DNS suffix appended to per-appliance Ingress hostnames
    // (`<stackName>.<suffix>`). No default — operators must supply
    // a routable suffix for the cluster (e.g. `apps.example.com`).
    hostnameSuffix: z.string().optional(),
    // Ingress controller class. Cluster-dependent; common values
    // are `nginx`, `traefik`, `alb`.
    ingressClassName: z.string().optional(),
    // Host-side port the cluster's ingress/LB is reachable on from
    // the operator's machine — used only to compose the URLs reported
    // back from deploys (`http://<host>[:<hostPort>]`). Defaults to
    // 80 (a directly-routable cluster); the microVM local runtime
    // publishes its ingress on 8081 and sets this.
    hostPort: z.number().int().min(1).max(65535).optional(),
    // Path mounted into the api-server pod that backs the
    // FilesystemObjectStore. Typically a PVC mount such as `/data`.
    dataDir: z.string(),
    // Optional registry hint. When set, builds may tag/push images
    // here before triggering a deploy — leaves the deploy itself
    // pointing at the resulting `<registry.url>/<image>` reference.
    registry: z
      .object({
        url: z.string(),
        insecure: z.boolean().optional(),
      })
      .optional(),
    // Optional buildkitd gRPC address reachable from the operator's
    // machine (e.g. `tcp://127.0.0.1:5054`, the microVM's forwarded
    // in-guest buildkitd). When set the CLI builds images with
    // buildctl instead of a local Docker daemon. BYO clusters omit it.
    buildkit: z
      .object({
        addr: z.string(),
      })
      .optional(),
  }),
});

export type ApplianceKubernetesInput = z.infer<typeof applianceKubernetesInput>;

// Shared shape of the plain-Docker runtime config. Used verbatim by
// both the input schema and the resolved base config — unlike the
// cloud bases there is no provisioning step that enriches it.
const dockerBlock = z.object({
  // Absolute path backing the FilesystemObjectStore (projects,
  // environments, deployments, api-keys). The daemon owns this dir.
  dataDir: z.string(),
  // Optional DOCKER_HOST override for the daemon's docker CLI calls.
  // Omit to use the ambient environment (the common case).
  host: z.string().optional(),
  // Host-port window deploys draw from. Each stack hashes to a stable
  // port inside it. Defaults to 8300-8699.
  portRange: z
    .object({
      min: z.number().int().min(1).max(65535),
      max: z.number().int().min(1).max(65535),
    })
    .optional(),
});

// Plain-Docker base: containers on a Docker daemon, driven by the
// single-binary local server. `dns` is omitted for the same reason as
// the Kubernetes bases — services are reached via published host
// ports, not DNS records.
export const applianceDockerInput = applianceBaseInput.omit({ dns: true }).extend({
  type: z.literal(ApplianceBaseType.ApplianceDocker),
  docker: dockerBlock,
});

export type ApplianceDockerInput = z.infer<typeof applianceDockerInput>;

export const applianceBaseConfigInput = z.discriminatedUnion('type', [
  applianceAwsPublicInput,
  applianceAwsVpcInput,
  applianceLocalInput,
  applianceKubernetesInput,
  applianceDockerInput,
]);

export type ApplianceBaseConfigInput = z.infer<typeof applianceBaseConfigInput>;

// The RESOLVED base config is round-tripped by mixed-version actors:
// the engine writes it into the guest's env file, the api-server parses
// it, tooling may parse-and-rewrite it. Every object node therefore
// carries `.passthrough()` — an OLDER schema parsing a NEWER config
// must preserve the keys it doesn't know instead of silently dropping
// them (incident B: an old parse dropped `kubernetes.buildkit` on
// re-serialization, killing source builds until the VM was recreated).
// The INPUT schemas above stay strict: they validate operator input,
// they are not a round-trip surface.
export const applianceBaseConfig = z
  .object({
    name: z.string(),
    type: z.enum(ApplianceBaseType),
    // Identifies the control-plane owner for new cloud installations.
    // Optional for backwards compatibility: existing three-phase
    // bootstrap installs predate the marker and remain Pulumi-owned.
    provisioner: z.literal('cloudformation-v1').optional(),
    // Cloud bases (aws-*) require this — Pulumi state backend URL,
    // typically `s3://<bucket>`. Local bases don't run Pulumi, so it
    // is optional at the schema level and enforced by the consumer
    // (e.g. ApplianceDeploymentService) when present.
    stateBackendUrl: z.string().optional(),
    domainName: z.string().optional(),
    // SDK version of the `@appliance.sh/infra` package that last
    // applied this base. Stamped by the infra component on every
    // `pulumi up`; surfaced via /api/v1/cluster-info so the desktop
    // can compare against its bundled version and offer a baseline
    // update. Absent for clusters bootstrapped before this field
    // was added — treat as "unknown" / "needs update."
    baselineVersion: z.string().optional(),
    // Version of the WRITER that produced this config (the engine
    // stamps its crate version when it writes the guest's base config).
    // Purely for drift visibility: the api-server logs it on parse so
    // a stale writer/parser pair is diagnosable from the server log.
    // Absent from configs written before the field existed.
    baseConfigVersion: z.string().optional(),
    // AWS-specific runtime config. Present for `appliance-base-aws-*`
    // bases. Optional at the schema level so `appliance-base-local`
    // (and any future non-AWS base) can omit it.
    aws: z
      .object({
        region: z.string(),
        // Absent during a CloudFormation install's substrate epoch. The
        // running endpoint adds it after the typed edge deployment has
        // provisioned/attached Route53.
        zoneId: z.string().optional(),
        cloudfrontDistributionId: z.string().optional(),
        cloudfrontDistributionDomainName: z.string().optional(),
        edgeRouterRoleArn: z.string().optional(),
        certificateArn: z.string().optional(),
        dataBucketName: z.string().optional(),
        stateBucketName: z.string().optional(),
        stateBucketArn: z.string().optional(),
        ecrRepositoryUrl: z.string().optional(),
        kmsAliasName: z.string().optional(),
        // Canonical signed-request authority after the edge epoch.
        // Until present, installer traffic uses the raw api-server
        // Function URL from systemFunctions.apiServer.url.
        apiServerPublicUrl: z.string().url().optional(),
        // KMS key (ARN) used as the Pulumi stack secrets provider for
        // every stack the api-server creates against this base. Replaces
        // PULUMI_CONFIG_PASSPHRASE-based encryption — operator and
        // system Lambda roles authenticate to the key via IAM rather than
        // a shared passphrase.
        kmsKeyArn: z.string().optional(),
        // Pre-created Lambda execution roles for the system api-server and
        // worker appliances. The dogfooded bootstrap deploys those two
        // appliances using these ARNs instead of letting ApplianceStack
        // mint a fresh role per deploy — they need broader IAM than user
        // workloads (Pulumi automation, ECR push, S3 state read/write).
        systemRoleArns: z
          .object({
            apiServer: z.string(),
            worker: z.string(),
          })
          .passthrough()
          .optional(),
        // CFN-owned system functions. Pulumi receives these as plain
        // inputs when it creates the edge and must never recreate them.
        systemFunctions: z
          .object({
            apiServer: z
              .object({
                name: z.string(),
                arn: z.string(),
                url: z.string().url(),
              })
              .passthrough(),
            worker: z
              .object({
                name: z.string(),
                arn: z.string(),
                url: z.string().url(),
              })
              .passthrough(),
          })
          .passthrough()
          .optional(),
        // Optional buildkitd gRPC address reachable from the api-server /
        // worker (e.g. a small BuildKit instance provisioned next to the
        // base). When set, container-type uploads are built server-side
        // from source and pushed to ECR — the same mechanism as the
        // Kubernetes bases' in-VM buildkitd. When absent, container
        // deploys must pass --image-uri (or ship a legacy image.tar zip).
        buildkit: z
          .object({
            addr: z.string(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    // Deprecated local container runtime config. Present only for legacy
    // `appliance-base-local` bases (the host-side k3d runtime has been
    // removed; `appliance-base-kubernetes` + its `kubernetes` block is the
    // replacement). `dataDir` is an absolute path the api-server uses as
    // the filesystem object store root (replaces S3 for
    // projects/environments/deployments). `cluster` mirrors the input
    // shape; defaults are filled in by the consumer.
    local: z
      .object({
        dataDir: z.string(),
        cluster: z
          .object({
            clusterName: z.string().optional(),
            namespace: z.string().optional(),
            hostPort: z.number().int().min(1).max(65535).optional(),
            // DNS suffix appended to each deploy's hostname to form
            // `<stackName>.<suffix>` Ingress routes. Defaults to
            // `appliance.localhost` — `.localhost` is RFC 6761
            // reserved and auto-resolves to 127.0.0.1 in every modern
            // browser + OS resolver, so no /etc/hosts setup is needed.
            // Override to `appliance.local` or your own domain for
            // setups that route via custom DNS.
            hostnameSuffix: z.string().optional(),
            // Ingress class the per-appliance Ingress declares.
            // Defaults to the local runtime's built-in `traefik`
            // controller. Override for clusters that swapped in
            // nginx-ingress or similar.
            ingressClassName: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    // Generic Kubernetes runtime config. Present for
    // `appliance-base-kubernetes` bases. Same role as `local` but the
    // cluster connection is explicit (server URL + credentials or an
    // inline kubeconfig) rather than discovered from the host's
    // default kubeconfig. Omit all of `server`, `kubeconfig`, and
    // `token` to fall back to `kc.loadFromCluster()` when running
    // inside a pod with a mounted ServiceAccount.
    kubernetes: z
      .object({
        server: z.string().optional(),
        ca: z.string().optional(),
        token: z.string().optional(),
        kubeconfig: z.string().optional(),
        // Kubeconfig file path, read lazily at deploy time (the guest
        // api-server points this at its local k3s).
        kubeconfigPath: z.string().optional(),
        namespace: z.string().optional(),
        hostnameSuffix: z.string().optional(),
        ingressClassName: z.string().optional(),
        // Host-side ingress/LB port for reported URLs. See the input
        // schema's field of the same name.
        hostPort: z.number().int().min(1).max(65535).optional(),
        dataDir: z.string(),
        registry: z
          .object({
            url: z.string(),
            insecure: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
        // buildkitd gRPC address for host-side docker-free builds. See
        // the input schema's field of the same name.
        buildkit: z
          .object({
            addr: z.string(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    // Plain-Docker runtime config. Present for `appliance-base-docker`
    // bases (the single-binary local daemon). Same shape as the input —
    // there is no provisioning step that enriches it. `.passthrough()`
    // applies to the CONFIG copy only; the shared input stays strict.
    docker: dockerBlock.passthrough().optional(),
  })
  .passthrough();

export type ApplianceBaseConfig = z.infer<typeof applianceBaseConfig>;

/** Rebuild a schema tree in strip mode: same shape at every level, but
 *  unknown keys are DROPPED instead of preserved. Derived mechanically
 *  from the schema above so the two can never drift. Only the wrapper
 *  kinds the resolved config actually uses need handling (objects and
 *  optionals); other leaves pass through untouched. */
function stripDeep(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodOptional) {
    return stripDeep(schema.unwrap() as z.ZodType).optional();
  }
  if (schema instanceof z.ZodObject) {
    const shape = Object.fromEntries(
      Object.entries(schema.shape).map(([key, value]) => [key, stripDeep(value as z.ZodType)])
    );
    return z.object(shape);
  }
  return schema;
}

/**
 * Strict (strip-mode) twin of {@link applianceBaseConfig}. The
 * passthrough schema exists for the INTERNAL round-trip (engine ⇄ env
 * file ⇄ api-server) where unknown keys must survive; anything leaving
 * the trust boundary — the cluster-info response any authenticated
 * caller can read — must be parsed through this twin instead, so keys
 * the schema doesn't know can't ride along to clients.
 */
export const applianceBaseConfigStrict = stripDeep(applianceBaseConfig) as unknown as typeof applianceBaseConfig;

/**
 * Project a resolved base config for UNTRUSTED wire consumers (any
 * authenticated cluster-info caller — member-role keys included):
 * strict-parse to drop unknown keys at every level, then remove the
 * credential-bearing Kubernetes fields — the ServiceAccount `token`,
 * the inline `kubeconfig` (embeds client credentials), and the `ca`
 * bundle (no client consumer reads it). Everything clients actually
 * use survives: `stateBackendUrl`, `baselineVersion`, base `type`,
 * block presence, registry/buildkit endpoints.
 */
export function sanitizeBaseConfigForWire(config: ApplianceBaseConfig): ApplianceBaseConfig {
  const stripped = applianceBaseConfigStrict.parse(config);
  if (stripped.kubernetes) {
    delete stripped.kubernetes.token;
    delete stripped.kubernetes.kubeconfig;
    delete stripped.kubernetes.ca;
  }
  return stripped;
}

/**
 * Common Kubernetes deploy parameters extracted from either an
 * `appliance-base-local` or `appliance-base-kubernetes` config.
 * Returns null for non-Kubernetes bases (AWS). `dataDir` is required
 * for both variants; the other fields fall back to consumer-side
 * defaults when undefined.
 */
export function getKubernetesParams(config: ApplianceBaseConfig): {
  dataDir: string;
  namespace?: string;
  hostnameSuffix?: string;
  ingressClassName?: string;
} | null {
  if (config.type === ApplianceBaseType.ApplianceLocal) {
    if (!config.local) return null;
    return {
      dataDir: config.local.dataDir,
      namespace: config.local.cluster?.namespace,
      hostnameSuffix: config.local.cluster?.hostnameSuffix,
      ingressClassName: config.local.cluster?.ingressClassName,
    };
  }
  if (config.type === ApplianceBaseType.ApplianceKubernetes) {
    if (!config.kubernetes) return null;
    return {
      dataDir: config.kubernetes.dataDir,
      namespace: config.kubernetes.namespace,
      hostnameSuffix: config.kubernetes.hostnameSuffix,
      ingressClassName: config.kubernetes.ingressClassName,
    };
  }
  return null;
}

/**
 * Docker runtime parameters extracted from an `appliance-base-docker`
 * config. Returns null for every other base type. Defaults for the
 * optional fields (port range) are consumer-side, mirroring
 * getKubernetesParams.
 */
export function getDockerParams(config: ApplianceBaseConfig): {
  dataDir: string;
  host?: string;
  portRange?: { min: number; max: number };
} | null {
  if (config.type !== ApplianceBaseType.ApplianceDocker) return null;
  if (!config.docker) return null;
  return {
    dataDir: config.docker.dataDir,
    host: config.docker.host,
    portRange: config.docker.portRange,
  };
}
