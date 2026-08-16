import * as k8s from '@kubernetes/client-node';
import * as fs from 'node:fs';
import { Writable } from 'node:stream';
import {
  ApplianceBaseConfig,
  ApplianceBaseType,
  getKubernetesParams,
  isKubernetesBase,
  Workloads,
} from '@appliance.sh/sdk';

// Egress confinement (see docs/microvm.md): the host (appliance-vm)
// publishes the policy into this ConfigMap; the executor reflects it
// into every workload's pod spec so the desktop's outbound-traffic
// controls apply without per-deploy wiring.
const EGRESS_CONFIGMAP = 'appliance-egress';
// CA the api-server derives for interception: `ca.crt` (the CA alone)
// + `ca-bundle.crt` (system roots + the CA), mounted into workloads.
const EGRESS_CA_BUNDLE_CONFIGMAP = 'appliance-egress-ca-bundle';

export const DEFAULT_LOCAL_CLUSTER_NAME = 'appliance-local';
export const DEFAULT_LOCAL_NAMESPACE = 'appliance';
export const DEFAULT_LOCAL_HOST_PORT = 8081;

// NodePort window the local runtime maps onto the host. Picked small
// (51 ports) so the docker-proxy footprint on macOS stays tractable —
// at ~2700 ports the colima daemon has been observed to fall over. The
// deployment service derives a deterministic NodePort from the stack
// name within this range so each appliance ends up reachable on a stable
// host port.
export const DEFAULT_LOCAL_NODEPORT_MIN = 30000;
export const DEFAULT_LOCAL_NODEPORT_MAX = 30050;

export interface LocalDeploymentMetadata {
  projectId: string;
  projectName: string;
  environmentId: string;
  environmentName: string;
  deploymentId: string;
  stackName: string;
}

export interface LocalResolvedBuild {
  /** Container image reference already present in the local Docker
   *  daemon or k3d-imported (e.g. `demo-node-container:latest`). */
  imageUri: string;
  /** Container port to expose. Falls back to 8080 if unset. */
  port?: number;
  environment?: Record<string, string>;
  /** Desired pod count. When unset, a redeploy preserves the live
   *  Deployment's scale (first deploy: 1). */
  replicas?: number;
}

export interface LocalDeploymentResult {
  action: 'deploy' | 'destroy' | 'refresh';
  ok: boolean;
  idempotentNoop: boolean;
  message: string;
  stackName: string;
  /** Host URL where the deployed service is reachable. Present for
   *  successful deploys; absent for destroy/no-op runs. */
  url?: string;
}

/** Per-pod readiness + restart snapshot for a workload. Mirrors the
 *  `kubectl get pods` READY / RESTARTS columns. */
export interface PodHealth {
  name: string;
  phase: string;
  ready: boolean;
  restarts: number;
  /** Waiting-state reason of the first not-ready container, if any
   *  (e.g. `CrashLoopBackOff`, `ImagePullBackOff`). */
  reason?: string;
}

/** Aggregate CPU/mem usage for a workload, summed across its pods.
 *  Sourced from the metrics-server; absent when it isn't installed. */
export interface ResourceUsage {
  cpuMillicores: number;
  memoryBytes: number;
}

/** Live health of a deployed workload: readiness, restart state, and
 *  (when metrics-server is present) CPU/mem usage. `deployed` is false
 *  when no Deployment exists for the stack (never deployed / destroyed). */
export interface DeploymentHealth {
  deployed: boolean;
  desiredReplicas: number;
  readyReplicas: number;
  restarts: number;
  pods: PodHealth[];
  usage?: ResourceUsage;
}

/** The method surface the api-server consumes from a container-runtime
 * deployment backend. */
export interface ContainerDeploymentBackend {
  deploy(
    stackName: string,
    metadata: LocalDeploymentMetadata,
    build: LocalResolvedBuild
  ): Promise<LocalDeploymentResult>;
  destroy(stackName: string): Promise<LocalDeploymentResult>;
  refresh(stackName: string): Promise<LocalDeploymentResult>;
  getDeploymentImage(stackName: string): Promise<string | undefined>;
  getDeploymentEnv(stackName: string): Promise<Record<string, string> | undefined>;
  getDeploymentHealth(stackName: string): Promise<DeploymentHealth>;
  listWorkloads(opts?: { namespace?: string; labelSelector?: string }): Promise<Workloads>;
  getPodLogs(
    podName: string,
    opts?: { container?: string; tailLines?: number; namespace?: string; sinceSeconds?: number }
  ): Promise<string>;
  streamPodLogs(
    podName: string,
    destination: Writable,
    opts?: { container?: string; tailLines?: number; namespace?: string; sinceSeconds?: number }
  ): Promise<AbortController>;
}

interface ClusterConfig {
  clusterName: string;
  namespace: string;
  hostPort: number;
  /** DNS suffix appended to each deploy's stack name to form the
   *  hostname-based Ingress route, e.g. `appliance.localhost` ->
   *  `<stackName>.appliance.localhost`. Mirrors the cloud router's
   *  `<stackName>.<domain>` shape so local + remote URLs share a
   *  structure. */
  hostnameSuffix: string;
  /** Ingress class the per-appliance Ingress declares — defaults to
   *  k3s/k3d's built-in `traefik` controller. */
  ingressClassName: string;
}

// `.localhost` is reserved by RFC 6761 and resolves to 127.0.0.1
// client-side in every modern browser plus macOS / systemd-resolved /
// Windows 10+. That makes `<project>-<env>.appliance.localhost` Just
// Work in a browser the moment the cluster is up — no /etc/hosts,
// no dnsmasq, no `.local` mDNS collisions. Override via
// `base.local.cluster.hostnameSuffix` if you want a different TLD.
const DEFAULT_LOCAL_HOSTNAME_SUFFIX = 'appliance.localhost';
const DEFAULT_LOCAL_INGRESS_CLASS = 'traefik';

// Rollout-wait budget. Matches the previous kubectl-shell timeout
// (`--timeout=120s`) so behaviour at the deploy boundary is
// unchanged. Polled every ROLLOUT_POLL_INTERVAL_MS until the
// Deployment's observedGeneration catches up and all replicas report
// Ready, or this budget elapses.
const ROLLOUT_TIMEOUT_MS = 120_000;
const ROLLOUT_POLL_INTERVAL_MS = 1_000;

/**
 * Drives appliance deploys against an arbitrary Kubernetes cluster
 * (`appliance-base-local`, the deprecated alias, or
 * `appliance-base-kubernetes` for any cluster reachable via URL +
 * credentials — including the microVM runtime). Maps each deploy to a
 * Deployment + Service + Ingress trio in the configured namespace;
 * destroy tears the same trio down.
 *
 * Talks to the cluster via `@kubernetes/client-node` rather than
 * shelling out to `kubectl`, so the same code path works whether
 * api-server runs in-cluster via a ServiceAccount or against a remote
 * control plane.
 *
 * Cluster lifecycle (boot/stop of the underlying runtime) remains the
 * microVM engine's (appliance-vm) responsibility.
 */
export class KubernetesDeploymentService {
  private readonly cluster: ClusterConfig;
  private readonly kc: k8s.KubeConfig;
  private readonly objects: k8s.KubernetesObjectApi;
  private readonly core: k8s.CoreV1Api;
  private readonly apps: k8s.AppsV1Api;
  private readonly metrics: k8s.Metrics;
  private readonly logs: k8s.Log;

  constructor(private readonly baseConfig: ApplianceBaseConfig) {
    if (!isKubernetesBase(baseConfig)) {
      throw new Error(
        `KubernetesDeploymentService requires a Kubernetes-driven base ` +
          `('${ApplianceBaseType.ApplianceLocal}' or '${ApplianceBaseType.ApplianceKubernetes}'), got '${baseConfig.type}'`
      );
    }
    this.cluster = resolveClusterConfig(baseConfig);
    this.kc = createKubeConfig(baseConfig);
    this.objects = k8s.KubernetesObjectApi.makeApiClient(this.kc);
    this.core = this.kc.makeApiClient(k8s.CoreV1Api);
    this.apps = this.kc.makeApiClient(k8s.AppsV1Api);
    // Reads `metrics.k8s.io/v1beta1` — only answers when a
    // metrics-server is installed. getDeploymentHealth() tolerates it
    // being unreachable so health works on clusters without one.
    this.metrics = new k8s.Metrics(this.kc);
    // Streams a pod's log over the k8s watch API (used by
    // streamPodLogs); shares the same KubeConfig as every other client.
    this.logs = new k8s.Log(this.kc);
  }

  /**
   * Snapshot of the workloads in a namespace: Deployments, Pods, and
   * Services, summarised to the columns the console renders. Read-only.
   *
   * Defaults to the configured namespace. Pass `labelSelector` to scope
   * to a single appliance's stack — the deploy path labels every
   * resource `app.kubernetes.io/name: <stackName>` (see renderManifest),
   * so `app.kubernetes.io/name=<stackName>` filters to one environment.
   *
   * Mirrors the desktop's former `kubectl get deploy,pod,svc -o json`
   * read; lists go through the same CoreV1/AppsV1 clients the deploy +
   * health paths already use, so no new RBAC or wiring is required.
   */
  async listWorkloads(opts?: { namespace?: string; labelSelector?: string }): Promise<Workloads> {
    const namespace = opts?.namespace ?? this.cluster.namespace;
    const labelSelector = opts?.labelSelector;
    const [deployments, pods, services] = await Promise.all([
      this.apps.listNamespacedDeployment({ namespace, labelSelector }),
      this.core.listNamespacedPod({ namespace, labelSelector }),
      this.core.listNamespacedService({ namespace, labelSelector }),
    ]);
    return {
      deployments: (deployments.items ?? []).map(summarizeWorkloadDeployment),
      pods: (pods.items ?? []).map(summarizeWorkloadPod),
      services: (services.items ?? []).map(summarizeWorkloadService),
    };
  }

  /**
   * Read a pod's logs as a single text blob (the tail). Drop-in for the
   * desktop's former `kubectl logs` snapshot. `tailLines` bounds the
   * read; `sinceSeconds` limits it to a recent window; `container`
   * selects one of a multi-container pod's containers (required when the
   * pod has more than one). RBAC for `pods/log` is already granted.
   */
  async getPodLogs(
    podName: string,
    opts?: { container?: string; tailLines?: number; namespace?: string; sinceSeconds?: number }
  ): Promise<string> {
    const namespace = opts?.namespace ?? this.cluster.namespace;
    return this.core.readNamespacedPodLog({
      name: podName,
      namespace,
      container: opts?.container,
      tailLines: opts?.tailLines,
      sinceSeconds: opts?.sinceSeconds,
    });
  }

  /**
   * Follow a pod's logs, piping the k8s watch stream straight into the
   * supplied Writable (e.g. the HTTP response) as raw chunked text.
   * Returns the AbortController the watch is bound to — abort it (or
   * end the destination) to tear the stream down. The caller owns the
   * destination's lifecycle; this only opens and pipes the watch.
   */
  async streamPodLogs(
    podName: string,
    destination: Writable,
    opts?: { container?: string; tailLines?: number; namespace?: string; sinceSeconds?: number }
  ): Promise<AbortController> {
    const namespace = opts?.namespace ?? this.cluster.namespace;
    // The Log helper requires a container name positionally; '' lets the
    // apiserver default to the pod's sole container (matching kubectl).
    return this.logs.log(namespace, podName, opts?.container ?? '', destination, {
      follow: true,
      tailLines: opts?.tailLines,
      sinceSeconds: opts?.sinceSeconds,
    });
  }

  async deploy(
    stackName: string,
    metadata: LocalDeploymentMetadata,
    build: LocalResolvedBuild
  ): Promise<LocalDeploymentResult> {
    await this.ensureNamespace();
    // Image delivery is registry-only: the build pipeline pushes the
    // image to a registry the cluster can reach (the microVM's in-VM
    // registry, or a BYO cluster's). There is no host-side image import
    // anymore — k8s pulls from the registry.

    const nodePort = deterministicNodePort(stackName);
    const hostname = applianceHostname(stackName, this.cluster.hostnameSuffix);
    const egress = await this.resolveEgress();
    // No explicit replica count → keep the environment's current scale
    // so a redeploy (or a manual `kubectl scale`) isn't silently reset
    // to 1 by the re-rendered manifest.
    const replicas = build.replicas ?? (await this.getDeploymentReplicas(stackName)) ?? 1;
    const manifest = renderManifest({
      name: stackName,
      namespace: this.cluster.namespace,
      image: build.imageUri,
      port: build.port ?? 8080,
      nodePort,
      env: build.environment ?? {},
      replicas,
      metadata,
      hostname,
      ingressClassName: this.cluster.ingressClassName,
      egress,
    });

    const before = await this.getDeploymentImage(stackName);
    const objects = k8s.loadAllYaml(manifest) as k8s.KubernetesObject[];
    for (const obj of objects) {
      try {
        await this.applyObject(obj);
      } catch (err) {
        // The deterministic NodePort pin can collide with a port the
        // cluster already allocated — two stack names can hash to the
        // same value. Mirror the docker backend's fallback: drop the
        // pin and let the cluster pick a free port; the read-back
        // below reports whatever it chose.
        if (obj.kind !== 'Service' || !isNodePortCollision(err)) throw err;
        const ports = ((obj as k8s.V1Service).spec?.ports ?? []) as Array<{ nodePort?: number }>;
        for (const p of ports) delete p.nodePort;
        await this.applyObject(obj);
      }
    }
    await this.waitForRollout(stackName);
    // Read back the live NodePort — when the pin survived it matches
    // `nodePort`; after a collision fallback the cluster picked one
    // and we report whatever it recorded.
    const liveNodePort = (await this.getServiceNodePort(stackName)) ?? nodePort;

    // Primary URL goes through the cluster's Ingress (Traefik), so it
    // shares the cloud router's hostname-routing model. NodePort URL
    // is reported alongside as a direct-access fallback for setups
    // where the browser/host doesn't resolve `*.localhost`.
    const hostnameUrl = applianceHostnameUrl(hostname, this.cluster.hostPort);
    const nodePortUrl = liveNodePort ? `http://localhost:${liveNodePort}` : undefined;
    const messageBody = idempotentMessage(before === build.imageUri, hostnameUrl, nodePortUrl);

    return {
      action: 'deploy',
      ok: true,
      idempotentNoop: before === build.imageUri,
      message: messageBody,
      stackName,
      url: hostnameUrl,
    };
  }

  /**
   * Resolve the active egress confinement (if any) from the
   * host-published `appliance-egress` ConfigMap. Absent ConfigMap →
   * no confinement (the common case; only the microVM engine
   * publishes it). When interception is on, the per-workload CA
   * bundle is ensured here and its ConfigMap name returned for
   * mounting. Best-effort throughout: egress wiring must never break
   * an otherwise-valid deploy.
   */
  private async resolveEgress(): Promise<EgressInjection | undefined> {
    let data: Record<string, string> | undefined;
    try {
      const cm = await this.core.readNamespacedConfigMap({
        name: EGRESS_CONFIGMAP,
        namespace: this.cluster.namespace,
      });
      data = cm.data ?? undefined;
    } catch {
      return undefined; // not configured (or unreadable) → no confinement
    }
    if (!data?.proxyUrl) return undefined;

    let caConfigMap: string | undefined;
    if (data.mitm === 'true' && data['ca.crt']) {
      try {
        caConfigMap = await this.ensureCaBundleConfigMap(data['ca.crt']);
      } catch (err) {
        // Degrade to blind tunnel: the proxy still enforces allow/deny
        // (the load-bearing control); only TLS decrypt-trust is lost.
        console.warn(`egress: CA bundle unavailable, deploying without interceptor trust: ${String(err)}`);
      }
    }
    return { proxyUrl: data.proxyUrl, noProxy: data.noProxy ?? '', caConfigMap };
  }

  /**
   * Ensure the `appliance-egress-ca-bundle` ConfigMap holds the CA the
   * proxy signs with, both alone (`ca.crt`, for additive trust stores
   * like Node) and combined with this api-server image's own root
   * bundle (`ca-bundle.crt`, for replace-style stores like OpenSSL so
   * direct TLS to NO_PROXY hosts keeps validating). Returns its name.
   */
  private async ensureCaBundleConfigMap(caPem: string): Promise<string> {
    const ca = `${caPem.trim()}\n`;
    const roots = readSystemRootsBundle();
    const data = {
      'ca.crt': ca,
      'ca-bundle.crt': roots ? `${roots.trimEnd()}\n${ca}` : ca,
    };
    const name = EGRESS_CA_BUNDLE_CONFIGMAP;
    const namespace = this.cluster.namespace;
    const body: k8s.V1ConfigMap = { metadata: { name, namespace }, data };
    let exists = false;
    try {
      await this.core.readNamespacedConfigMap({ name, namespace });
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      await this.core.replaceNamespacedConfigMap({ name, namespace, body });
    } else {
      await this.core.createNamespacedConfigMap({ namespace, body });
    }
    return name;
  }

  async destroy(stackName: string): Promise<LocalDeploymentResult> {
    const ns = this.cluster.namespace;
    const existed = await this.resourceExists('Deployment', 'apps/v1', stackName);

    // Delete all three resources; ignoring `not found` is the
    // idempotent path because any of them may already be missing from
    // a previous partial destroy.
    await this.deleteIfExists('Ingress', 'networking.k8s.io/v1', stackName);
    await this.deleteIfExists('Service', 'v1', stackName);
    await this.deleteIfExists('Deployment', 'apps/v1', stackName);

    return {
      action: 'destroy',
      ok: true,
      idempotentNoop: !existed,
      message: existed ? `Stack resources deleted from namespace ${ns}` : 'Stack not found (idempotent)',
      stackName,
    };
  }

  async refresh(stackName: string): Promise<LocalDeploymentResult> {
    // Refresh has no meaningful semantics for a kubectl-driven local
    // deploy — the live state of the cluster IS the source of truth.
    // We report a no-op so the api-server's executor can settle the
    // deployment record without surfacing a misleading error.
    const exists = await this.resourceExists('Deployment', 'apps/v1', stackName);
    return {
      action: 'refresh',
      ok: true,
      idempotentNoop: true,
      message: exists ? 'Local stacks have no separate state to refresh' : 'Stack not found (nothing to refresh)',
      stackName,
    };
  }

  async getDeploymentImage(stackName: string): Promise<string | undefined> {
    try {
      const dep = await this.apps.readNamespacedDeployment({ name: stackName, namespace: this.cluster.namespace });
      return dep.spec?.template?.spec?.containers?.[0]?.image ?? undefined;
    } catch (err) {
      if (isNotFoundError(err)) return undefined;
      throw err;
    }
  }

  /** The live Deployment's desired replica count, or undefined when the
   *  stack has never been deployed. Lets a deploy without an explicit
   *  `replicas` preserve the current scale instead of resetting it. */
  async getDeploymentReplicas(stackName: string): Promise<number | undefined> {
    try {
      const dep = await this.apps.readNamespacedDeployment({ name: stackName, namespace: this.cluster.namespace });
      return dep.spec?.replicas ?? undefined;
    } catch (err) {
      if (isNotFoundError(err)) return undefined;
      throw err;
    }
  }

  /**
   * Read the current env block off the live Deployment. Used by the
   * api-server's executor when a bare re-deploy (no buildId, no env
   * override) lands locally: re-rendering the manifest with no env
   * would strip the prior values, so we lift them in to keep the
   * container's PORT (and any other deploy-time env) intact.
   * Returns undefined if the deployment doesn't exist.
   */
  async getDeploymentEnv(stackName: string): Promise<Record<string, string> | undefined> {
    try {
      const dep = await this.apps.readNamespacedDeployment({ name: stackName, namespace: this.cluster.namespace });
      const envList = dep.spec?.template?.spec?.containers?.[0]?.env ?? [];
      const out: Record<string, string> = {};
      for (const entry of envList) {
        if (entry?.name && typeof entry.value === 'string') out[entry.name] = entry.value;
      }
      return out;
    } catch (err) {
      if (isNotFoundError(err)) return undefined;
      throw err;
    }
  }

  /**
   * Read the live health of a deployed workload: the Deployment's
   * desired-vs-ready replica counts, each pod's readiness + restart
   * state, and — when a metrics-server is installed — aggregate
   * CPU/memory usage.
   *
   * Degrades gracefully throughout:
   *   - No Deployment for the stack → `deployed: false` (never
   *     deployed, or destroyed), not an error.
   *   - metrics-server absent/unreachable → `usage` omitted; the
   *     readiness/restart half is still returned.
   *
   * Pod readiness mirrors `kubectl get pods` semantics (the READY
   * column = all containers Ready), and restart counts sum the
   * per-container `restartCount` the kubelet reports — the same shape
   * waitForRollout() leans on for the deploy-time rollout gate.
   */
  async getDeploymentHealth(stackName: string): Promise<DeploymentHealth> {
    let dep: k8s.V1Deployment | undefined;
    try {
      dep = await this.apps.readNamespacedDeployment({ name: stackName, namespace: this.cluster.namespace });
    } catch (err) {
      if (isNotFoundError(err)) {
        return { deployed: false, desiredReplicas: 0, readyReplicas: 0, restarts: 0, pods: [] };
      }
      throw err;
    }

    const desiredReplicas = dep.spec?.replicas ?? 1;
    const readyReplicas = dep.status?.readyReplicas ?? 0;

    // Pods carry `app.kubernetes.io/name: <stackName>` (see
    // renderManifest) — the same selector the Service routes on.
    const pods = await this.core.listNamespacedPod({
      namespace: this.cluster.namespace,
      labelSelector: `app.kubernetes.io/name=${stackName}`,
    });

    const podHealth: PodHealth[] = (pods.items ?? []).map((pod) => summarizePod(pod));
    const restarts = podHealth.reduce((acc, p) => acc + p.restarts, 0);

    const usage = await this.collectUsage(podHealth.map((p) => p.name));

    return {
      deployed: true,
      desiredReplicas,
      readyReplicas,
      restarts,
      pods: podHealth,
      ...(usage ? { usage } : {}),
    };
  }

  /**
   * Sum CPU/memory usage across the named pods via the
   * metrics-server. Returns undefined (rather than throwing) when the
   * metrics API is absent or unreachable, when no pods were given, or
   * when none of them have a metrics sample yet — health must work on
   * clusters without a metrics-server.
   */
  private async collectUsage(podNames: string[]): Promise<ResourceUsage | undefined> {
    if (podNames.length === 0) return undefined;
    const wanted = new Set(podNames);
    let list: k8s.PodMetricsList;
    try {
      list = await this.metrics.getPodMetrics(this.cluster.namespace);
    } catch {
      return undefined; // no metrics-server, or it's not ready yet
    }
    let cpuMillicores = 0;
    let memoryBytes = 0;
    let matched = false;
    for (const pod of list.items ?? []) {
      if (!wanted.has(pod.metadata.name)) continue;
      matched = true;
      for (const container of pod.containers ?? []) {
        cpuMillicores += parseCpuToMillicores(container.usage?.cpu);
        memoryBytes += parseMemoryToBytes(container.usage?.memory);
      }
    }
    if (!matched) return undefined;
    return { cpuMillicores, memoryBytes };
  }

  private async ensureNamespace(): Promise<void> {
    try {
      await this.core.readNamespace({ name: this.cluster.namespace });
      return;
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
    await this.core.createNamespace({
      body: { apiVersion: 'v1', kind: 'Namespace', metadata: { name: this.cluster.namespace } },
    });
  }

  /**
   * `kubectl apply` equivalent for a single object: read existing,
   * replace on hit (preserving immutable fields like Service.clusterIP),
   * create on miss. Strategic-merge would be more accurate for partial
   * field updates, but the manifest we send is the complete intended
   * state for these resources, so a full replace is semantically
   * equivalent and avoids the per-resource patch-type plumbing.
   */
  private async applyObject(desired: k8s.KubernetesObject): Promise<void> {
    if (!desired.metadata?.name) {
      throw new Error(`KubernetesObject of kind '${desired.kind}' is missing metadata.name`);
    }
    // KubernetesObjectApi.read() takes a header-shaped object (the
    // `KubernetesObjectHeader` alias the library doesn't re-export);
    // construct it inline so we don't depend on the alias name.
    const header = {
      apiVersion: desired.apiVersion ?? '',
      kind: desired.kind ?? '',
      metadata: { name: desired.metadata.name, namespace: desired.metadata.namespace },
    };
    try {
      const existing = await this.objects.read(header);
      const merged: k8s.KubernetesObject = {
        ...desired,
        metadata: { ...desired.metadata, resourceVersion: existing.metadata?.resourceVersion },
      };
      // Service.spec.{clusterIP,clusterIPs} are immutable post-create;
      // a replace that omits them gets rejected. Lift the live values
      // back into the desired spec so the round-trip is a no-op for
      // those fields.
      if (desired.kind === 'Service') {
        const existingSpec = (existing as { spec?: Record<string, unknown> }).spec ?? {};
        const desiredSpec = (desired as { spec?: Record<string, unknown> }).spec ?? {};
        (merged as { spec: Record<string, unknown> }).spec = {
          ...desiredSpec,
          clusterIP: existingSpec.clusterIP,
          clusterIPs: existingSpec.clusterIPs,
        };
      }
      await this.objects.replace(merged);
    } catch (err) {
      if (isNotFoundError(err)) {
        await this.objects.create(desired);
        return;
      }
      throw err;
    }
  }

  private async deleteIfExists(kind: string, apiVersion: string, name: string): Promise<void> {
    try {
      await this.objects.delete({ apiVersion, kind, metadata: { name, namespace: this.cluster.namespace } });
    } catch (err) {
      if (isNotFoundError(err)) return;
      throw err;
    }
  }

  /**
   * Poll the Deployment until the controller has observed our latest
   * generation and all desired replicas report Ready, or the rollout
   * budget elapses. Mirrors `kubectl rollout status` semantics: an
   * error from the API surfaces as the rollout failure, a stable but
   * un-ready state surfaces as a timeout.
   */
  private async waitForRollout(stackName: string): Promise<void> {
    const deadline = Date.now() + ROLLOUT_TIMEOUT_MS;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const dep = await this.apps.readNamespacedDeployment({
          name: stackName,
          namespace: this.cluster.namespace,
        });
        const desiredReplicas = dep.spec?.replicas ?? 1;
        const status = dep.status ?? {};
        const observed = status.observedGeneration ?? -1;
        const generation = dep.metadata?.generation ?? 0;
        const ready = status.readyReplicas ?? 0;
        const updated = status.updatedReplicas ?? 0;
        if (observed >= generation && updated >= desiredReplicas && ready >= desiredReplicas) {
          return;
        }
      } catch (err) {
        lastErr = err;
      }
      await sleep(ROLLOUT_POLL_INTERVAL_MS);
    }
    const tail = lastErr instanceof Error ? `: ${lastErr.message}` : '';
    throw new Error(`Rollout did not complete within ${Math.floor(ROLLOUT_TIMEOUT_MS / 1000)}s${tail}`);
  }

  private async resourceExists(kind: string, apiVersion: string, name: string): Promise<boolean> {
    try {
      await this.objects.read({ apiVersion, kind, metadata: { name, namespace: this.cluster.namespace } });
      return true;
    } catch (err) {
      if (isNotFoundError(err)) return false;
      throw err;
    }
  }

  private async getServiceNodePort(stackName: string): Promise<number | undefined> {
    try {
      const svc = await this.core.readNamespacedService({ name: stackName, namespace: this.cluster.namespace });
      const port = svc.spec?.ports?.[0]?.nodePort;
      return typeof port === 'number' && port > 0 ? port : undefined;
    } catch {
      return undefined;
    }
  }
}

// Backwards-compat alias — the executor and any direct consumers
// still import `LocalContainerDeploymentService`. Aliased rather than
// subclassed so the class identity (typeof instances) matches the
// new name. Drop in a follow-up once consumers migrate.
export const LocalContainerDeploymentService = KubernetesDeploymentService;
export type LocalContainerDeploymentService = KubernetesDeploymentService;

/**
 * Build a KubeConfig from the base config. Five supported modes,
 * in priority order:
 *   1. `appliance-base-kubernetes` with inline `kubeconfig` — parsed
 *      verbatim. Covers BYO clusters where the operator already has
 *      a working kubeconfig.
 *   2. `appliance-base-kubernetes` with `kubeconfigPath` — read from
 *      disk lazily at deploy time. The guest api-server binary points
 *      this at its local k3s (`/etc/rancher/k3s/k3s.yaml`), which may
 *      not exist yet when the server process starts.
 *   3. `appliance-base-kubernetes` with `server` + `token` — built
 *      programmatically. The common path for in-cluster API tokens
 *      and ServiceAccount-issued credentials supplied out of band.
 *   4. `appliance-base-kubernetes` with none of the above — falls
 *      back to `loadFromCluster()`, which reads the pod's mounted
 *      ServiceAccount token + CA. The expected path when api-server
 *      itself runs inside the cluster it manages.
 *   5. `appliance-base-local` — loads the host's default kubeconfig
 *      (preserves prior behaviour for k3d-on-laptop dev).
 */
function createKubeConfig(baseConfig: ApplianceBaseConfig): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (baseConfig.type === ApplianceBaseType.ApplianceKubernetes) {
    const cfg = baseConfig.kubernetes;
    if (!cfg) {
      throw new Error(`'kubernetes' block is required for ${ApplianceBaseType.ApplianceKubernetes} bases`);
    }
    if (cfg.kubeconfig) {
      kc.loadFromString(cfg.kubeconfig);
      return kc;
    }
    if (cfg.kubeconfigPath) {
      kc.loadFromFile(cfg.kubeconfigPath);
      return kc;
    }
    if (cfg.server && cfg.token) {
      kc.addCluster({
        name: 'appliance',
        server: cfg.server,
        caData: cfg.ca,
        skipTLSVerify: !cfg.ca,
      });
      kc.addUser({ name: 'appliance', token: cfg.token });
      kc.addContext({
        name: 'appliance',
        cluster: 'appliance',
        user: 'appliance',
        namespace: cfg.namespace,
      });
      kc.setCurrentContext('appliance');
      return kc;
    }
    // No explicit credentials → assume in-cluster ServiceAccount.
    kc.loadFromCluster();
    return kc;
  }
  // appliance-base-local: trust whatever the host kubeconfig points
  // at. The desktop's cluster lifecycle keeps that pointed at the
  // managed k3d cluster.
  kc.loadFromDefault();
  return kc;
}

function resolveClusterConfig(baseConfig: ApplianceBaseConfig): ClusterConfig {
  // Common k8s params (namespace, hostnameSuffix, ingressClassName)
  // come from whichever subobject the variant uses. hostPort is the
  // host-side port the cluster's ingress/LB answers on, used only for
  // the URLs reported back from deploys. `appliance-base-local`
  // defaults to the k3d serverlb publish port (8081);
  // `appliance-base-kubernetes` honors an explicit `hostPort` (set by
  // the desktop/CLI-managed in-cluster runtime, whose serverlb also
  // publishes on a non-80 port) and otherwise assumes the canonical
  // 80, rendered port-less (applianceHostnameUrl elides :80) —
  // stamping the k3d default onto a generic Kubernetes URL produced a
  // bogus `:8081` suffix on every reported deploy URL.
  const k8sParams = getKubernetesParams(baseConfig);
  const localCluster = baseConfig.local?.cluster ?? {};
  const hostPort =
    baseConfig.type === ApplianceBaseType.ApplianceLocal
      ? (localCluster.hostPort ?? DEFAULT_LOCAL_HOST_PORT)
      : (baseConfig.kubernetes?.hostPort ?? 80);
  return {
    clusterName: localCluster.clusterName ?? DEFAULT_LOCAL_CLUSTER_NAME,
    namespace: k8sParams?.namespace ?? DEFAULT_LOCAL_NAMESPACE,
    hostPort,
    hostnameSuffix: k8sParams?.hostnameSuffix ?? DEFAULT_LOCAL_HOSTNAME_SUFFIX,
    ingressClassName: k8sParams?.ingressClassName ?? DEFAULT_LOCAL_INGRESS_CLASS,
  };
}

/**
 * Build the public hostname for an appliance. Mirrors the cloud
 * router's `<stackName>.<domain>` shape — same structure, just a
 * different domain. Stack names come straight from project-environment
 * which already match RFC 1123 (lowercase, alphanumeric, hyphens)
 * because both names are validated by the api-server, so no
 * additional sanitization is needed.
 */
export function applianceHostname(stackName: string, hostnameSuffix: string): string {
  return `${stackName}.${hostnameSuffix}`;
}

/**
 * Compose a host-reachable URL for an appliance. Omits the port when
 * it's the default 80, matching how browsers render URLs.
 */
export function applianceHostnameUrl(hostname: string, hostPort: number): string {
  if (hostPort === 80) return `http://${hostname}`;
  return `http://${hostname}:${hostPort}`;
}

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  // @kubernetes/client-node v1 surfaces apiserver errors as ApiException
  // with a `.code` (HTTP status). Older shapes used `.statusCode` or
  // `.response.statusCode`; check all three plus the legacy string
  // match for kubectl-shaped errors so the wrapper stays compatible
  // with mocked tests.
  const e = err as { code?: number; statusCode?: number; response?: { statusCode?: number }; message?: string };
  if (e.code === 404 || e.statusCode === 404 || e.response?.statusCode === 404) return true;
  if (typeof e.message === 'string') {
    return /not\s*found/i.test(e.message) || /Error from server \(NotFound\)/i.test(e.message);
  }
  return false;
}

/** True when the apiserver rejected a Service because its pinned
 *  `nodePort` is already taken. The 422's message is stable across
 *  k8s versions: `provided port is already allocated`. */
export function isNodePortCollision(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { message?: string; body?: unknown };
  const text = `${e.message ?? ''} ${typeof e.body === 'string' ? e.body : JSON.stringify(e.body ?? '')}`;
  return /provided port is already allocated/i.test(text);
}

/**
 * Collapse a Pod's container statuses into the single readiness +
 * restart line the console shows. `ready` follows `kubectl`'s READY
 * column (every container Ready); `restarts` sums per-container
 * restartCount; `reason` lifts the waiting-state reason of the first
 * not-ready container (CrashLoopBackOff / ImagePullBackOff / etc.) so
 * the UI can explain *why* a pod isn't healthy.
 */
export function summarizePod(pod: k8s.V1Pod): PodHealth {
  const statuses = pod.status?.containerStatuses ?? [];
  const restarts = statuses.reduce((acc, c) => acc + (c.restartCount ?? 0), 0);
  // A pod with no container statuses yet (just-scheduled) isn't ready.
  const ready = statuses.length > 0 && statuses.every((c) => c.ready === true);
  let reason: string | undefined;
  for (const c of statuses) {
    if (!c.ready && c.state?.waiting?.reason) {
      reason = c.state.waiting.reason;
      break;
    }
  }
  return {
    name: pod.metadata?.name ?? '',
    phase: pod.status?.phase ?? 'Unknown',
    ready,
    restarts,
    ...(reason ? { reason } : {}),
  };
}

/** RFC3339 creation timestamp off a resource's metadata, when present.
 *  client-node surfaces it as a Date; normalise to an ISO string. */
function creationTimestamp(meta: k8s.V1ObjectMeta | undefined): string | undefined {
  const ts = meta?.creationTimestamp;
  if (!ts) return undefined;
  return ts instanceof Date ? ts.toISOString() : new Date(ts).toISOString();
}

/** Collapse a Deployment into the `kubectl get deploy` columns the
 *  console renders (image + desired/ready/available replica counts). */
export function summarizeWorkloadDeployment(dep: k8s.V1Deployment): Workloads['deployments'][number] {
  return {
    name: dep.metadata?.name ?? '',
    image: dep.spec?.template?.spec?.containers?.[0]?.image ?? undefined,
    desired: dep.spec?.replicas ?? 0,
    ready: dep.status?.readyReplicas ?? 0,
    available: dep.status?.availableReplicas ?? 0,
    createdAt: creationTimestamp(dep.metadata),
  };
}

/** Collapse a Pod into the `kubectl get pods` columns: phase, the READY
 *  rollup (every container Ready), summed restarts, and the first
 *  container's image. */
export function summarizeWorkloadPod(pod: k8s.V1Pod): Workloads['pods'][number] {
  const statuses = pod.status?.containerStatuses ?? [];
  const restartCount = statuses.reduce((acc, c) => acc + (c.restartCount ?? 0), 0);
  const ready = statuses.length > 0 && statuses.every((c) => c.ready === true);
  return {
    name: pod.metadata?.name ?? '',
    phase: pod.status?.phase ?? 'Unknown',
    ready,
    restartCount,
    containerImage: pod.spec?.containers?.[0]?.image ?? undefined,
    createdAt: creationTimestamp(pod.metadata),
  };
}

/** Collapse a Service into the `kubectl get svc` columns: type, cluster
 *  IP, and the first port's nodePort/targetPort. A named (string)
 *  targetPort is omitted — the console field is numeric-only. */
export function summarizeWorkloadService(svc: k8s.V1Service): Workloads['services'][number] {
  const firstPort = svc.spec?.ports?.[0];
  const targetPort = typeof firstPort?.targetPort === 'number' ? firstPort.targetPort : undefined;
  return {
    name: svc.metadata?.name ?? '',
    serviceType: svc.spec?.type ?? 'ClusterIP',
    clusterIp: svc.spec?.clusterIP ?? undefined,
    nodePort: typeof firstPort?.nodePort === 'number' ? firstPort.nodePort : undefined,
    targetPort,
  };
}

/**
 * Parse a Kubernetes CPU quantity into millicores. metrics-server
 * reports CPU as nanocores (`123456789n`) or millicores (`12m`); plain
 * numbers are whole cores (`0.5`, `2`). Unparseable / missing → 0.
 */
export function parseCpuToMillicores(value: string | undefined): number {
  if (!value) return 0;
  const v = value.trim();
  if (v.endsWith('n')) return Number.parseFloat(v.slice(0, -1)) / 1_000_000; // nanocores → millicores
  if (v.endsWith('u')) return Number.parseFloat(v.slice(0, -1)) / 1_000; // microcores → millicores
  if (v.endsWith('m')) return Number.parseFloat(v.slice(0, -1)); // already millicores
  const cores = Number.parseFloat(v);
  return Number.isFinite(cores) ? cores * 1000 : 0;
}

/**
 * Parse a Kubernetes memory quantity into bytes. Handles the binary
 * (Ki/Mi/Gi/Ti/Pi/Ei) and decimal (k/M/G/T/P/E) SI suffixes the
 * metrics-server emits, plus bare byte counts. Unparseable / missing → 0.
 */
export function parseMemoryToBytes(value: string | undefined): number {
  if (!value) return 0;
  const v = value.trim();
  const binary: Record<string, number> = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    Ei: 1024 ** 6,
  };
  const decimal: Record<string, number> = {
    k: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
    P: 1e15,
    E: 1e18,
  };
  for (const [suffix, factor] of Object.entries(binary)) {
    if (v.endsWith(suffix)) return Number.parseFloat(v.slice(0, -suffix.length)) * factor;
  }
  for (const [suffix, factor] of Object.entries(decimal)) {
    if (v.endsWith(suffix)) return Number.parseFloat(v.slice(0, -suffix.length)) * factor;
  }
  const bytes = Number.parseFloat(v);
  return Number.isFinite(bytes) ? bytes : 0;
}

/**
 * Build the user-visible deploy message. Surfaces both the
 * hostname-based URL (the canonical "live URL" via the cluster's
 * Ingress) and the NodePort URL (direct-access fallback). When the
 * deploy is a no-op we keep the message short — the URLs haven't
 * changed.
 */
function idempotentMessage(noop: boolean, hostnameUrl: string, nodePortUrl: string | undefined): string {
  if (noop) return 'No changes (idempotent)';
  if (nodePortUrl) {
    return `Stack updated. URL: ${hostnameUrl} (direct: ${nodePortUrl})`;
  }
  return `Stack updated. URL: ${hostnameUrl}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ManifestParams {
  name: string;
  namespace: string;
  image: string;
  port: number;
  /** Explicit NodePort the Service should bind. When omitted, k8s
   *  picks any free port in 30000-32767. The local runtime only
   *  publishes a small NodePort window, so the executor sets this
   *  deterministically per stack via deterministicNodePort(). */
  nodePort?: number;
  env: Record<string, string>;
  /** Desired pod count. Defaults to 1 when omitted. */
  replicas?: number;
  metadata: LocalDeploymentMetadata;
  /** Public hostname Traefik routes to this appliance via the
   *  generated Ingress. Typically `<stackName>.appliance.localhost`. */
  hostname: string;
  /** IngressClass the Ingress declares (the local runtime ships `traefik`). */
  ingressClassName: string;
  /** Outbound-traffic confinement. When set, the workload is wired to
   *  route egress through the runtime's proxy (HTTP(S)_PROXY) so the
   *  desktop's allow/deny policy applies. Absent → no confinement. */
  egress?: EgressInjection;
}

export interface EgressInjection {
  /** Forward-proxy URL workloads send outbound traffic through
   *  (e.g. `http://192.168.64.1:5053`). */
  proxyUrl: string;
  /** Comma-separated NO_PROXY value bypassing cluster-internal
   *  destinations (kube API, services, pod/service CIDRs). */
  noProxy: string;
  /** When TLS interception is on, the name of a ConfigMap holding the
   *  CA the proxy signs with. Mounted into the pod so it trusts the
   *  interceptor. Expected keys: `ca.crt` (the CA alone, for
   *  additive trust stores like Node) and `ca-bundle.crt` (system
   *  roots + the CA, for replace-style stores like OpenSSL). Omitted →
   *  blind tunnel, no CA needed. */
  caConfigMap?: string;
}

/** Where the egress CA ConfigMap is mounted inside workloads. */
const EGRESS_CA_MOUNT = '/etc/appliance-egress';

/**
 * Proxy env + (when intercepting) CA-trust env a confined workload
 * gets. Egress vars take precedence over user env so confinement
 * can't be silently disabled by an app's own PROXY settings.
 */
function egressEnv(egress: EgressInjection): Record<string, string> {
  const env: Record<string, string> = {
    HTTP_PROXY: egress.proxyUrl,
    HTTPS_PROXY: egress.proxyUrl,
    NO_PROXY: egress.noProxy,
    // Lowercase variants — many runtimes only read one casing.
    http_proxy: egress.proxyUrl,
    https_proxy: egress.proxyUrl,
    no_proxy: egress.noProxy,
  };
  if (egress.caConfigMap) {
    const ca = `${EGRESS_CA_MOUNT}/ca.crt`;
    const bundle = `${EGRESS_CA_MOUNT}/ca-bundle.crt`;
    // NODE_EXTRA_CA_CERTS is additive (keeps Node's built-ins) → the
    // CA alone. The OpenSSL-family vars replace the trust store, so
    // they get the combined bundle to avoid breaking direct TLS to
    // NO_PROXY hosts.
    env.NODE_EXTRA_CA_CERTS = ca;
    env.SSL_CERT_FILE = bundle;
    env.REQUESTS_CA_BUNDLE = bundle;
    env.GIT_SSL_CAINFO = bundle;
  }
  return env;
}

/**
 * Hash the stack name into [DEFAULT_LOCAL_NODEPORT_MIN,
 * DEFAULT_LOCAL_NODEPORT_MAX] so each appliance gets a stable
 * NodePort across deploys. Same name → same port — important for
 * the demo, where the script wants to curl the deployed Service
 * without first having to look up the assigned port.
 */
export function deterministicNodePort(stackName: string): number {
  const range = DEFAULT_LOCAL_NODEPORT_MAX - DEFAULT_LOCAL_NODEPORT_MIN + 1;
  let hash = 0;
  for (let i = 0; i < stackName.length; i++) {
    hash = (hash * 31 + stackName.charCodeAt(i)) | 0;
  }
  return DEFAULT_LOCAL_NODEPORT_MIN + (Math.abs(hash) % range);
}

export function renderManifest(params: ManifestParams): string {
  const { name, namespace, image, port, nodePort, metadata, hostname, ingressClassName, egress } = params;
  const replicas = params.replicas ?? 1;
  // Egress confinement overlays proxy/CA vars on the user env (egress
  // wins) and, when intercepting, mounts the CA the proxy signs with.
  const env: Record<string, string> = egress ? { ...params.env, ...egressEnv(egress) } : params.env;
  const mountCa = Boolean(egress?.caConfigMap);
  const volumeMountsSection = mountCa
    ? `\n        volumeMounts:\n        - name: appliance-egress-ca\n          mountPath: ${yamlString(EGRESS_CA_MOUNT)}\n          readOnly: true`
    : '';
  const volumesSection = mountCa
    ? `\n      volumes:\n      - name: appliance-egress-ca\n        configMap:\n          name: ${yamlString(egress!.caConfigMap!)}`
    : '';
  // Cluster-IP for in-cluster reachability would be ideal, but the
  // dev story is "hit the appliance from a browser on the host", so
  // we publish via NodePort. k3d's built-in loadbalancer hairpins
  // host ports onto the node — but until a NodePort range is mapped
  // at cluster creation, NodePort still surfaces a unique
  // host-reachable port (30000-32767) for each service.
  const envEntries = Object.entries(env);
  const envBlock =
    envEntries.length === 0
      ? ''
      : envEntries.map(([k, v]) => `        - name: ${yamlString(k)}\n          value: ${yamlString(v)}`).join('\n');
  const envSection = envBlock ? `\n        env:\n${envBlock}` : '';

  // `imagePullPolicy: IfNotPresent` so k3d picks up the imported
  // image instead of trying to re-pull from a registry it cannot
  // reach (host-built images aren't in any remote registry).
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${yamlString(name)}
  namespace: ${yamlString(namespace)}
  labels:
    app.kubernetes.io/managed-by: appliance.sh
    appliance.sh/project: ${yamlString(metadata.projectName)}
    appliance.sh/environment: ${yamlString(metadata.environmentName)}
  annotations:
    appliance.sh/deployment-id: ${yamlString(metadata.deploymentId)}
    appliance.sh/project-id: ${yamlString(metadata.projectId)}
    appliance.sh/environment-id: ${yamlString(metadata.environmentId)}
spec:
  replicas: ${replicas}
  selector:
    matchLabels:
      app.kubernetes.io/name: ${yamlString(name)}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${yamlString(name)}
        app.kubernetes.io/managed-by: appliance.sh
    spec:
      containers:
      - name: app
        image: ${yamlString(image)}
        imagePullPolicy: IfNotPresent
        ports:
        - containerPort: ${port}${envSection}${volumeMountsSection}${volumesSection}
---
apiVersion: v1
kind: Service
metadata:
  name: ${yamlString(name)}
  namespace: ${yamlString(namespace)}
  labels:
    app.kubernetes.io/managed-by: appliance.sh
spec:
  type: NodePort
  selector:
    app.kubernetes.io/name: ${yamlString(name)}
  ports:
  - port: ${port}
    targetPort: ${port}
    protocol: TCP${nodePort ? `\n    nodePort: ${nodePort}` : ''}
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${yamlString(name)}
  namespace: ${yamlString(namespace)}
  labels:
    app.kubernetes.io/managed-by: appliance.sh
    appliance.sh/project: ${yamlString(metadata.projectName)}
    appliance.sh/environment: ${yamlString(metadata.environmentName)}
  annotations:
    appliance.sh/deployment-id: ${yamlString(metadata.deploymentId)}
spec:
  ingressClassName: ${yamlString(ingressClassName)}
  rules:
  - host: ${yamlString(hostname)}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: ${yamlString(name)}
            port:
              number: ${port}
`;
}

/**
 * Always-quoted YAML string emitter. Quoting unconditionally
 * sidesteps the `:`, `#`, leading-dash, etc. parsing rules and
 * makes the rendered manifest unambiguous regardless of caller
 * input. Escapes only `\` and `"` inside the quoted form.
 */
/** Read this process's system CA root bundle (the api-server runs in
 *  a container whose image ships public roots) so the egress CA can be
 *  appended to it rather than replacing it. Empty when none is found. */
function readSystemRootsBundle(): string {
  for (const p of ['/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt', '/etc/ssl/cert.pem']) {
    try {
      const pem = fs.readFileSync(p, 'utf8');
      if (pem.includes('BEGIN CERTIFICATE')) return pem;
    } catch {
      // try next
    }
  }
  return '';
}

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
