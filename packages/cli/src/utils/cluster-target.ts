import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_LOCAL_NAMESPACE } from '@appliance.sh/helper';

// Resolve which local cluster a CLI command should talk to, and how to
// reach it with `kubectl`. Observability commands (`appliance logs`,
// `appliance deployment health`) drive `kubectl` directly against the
// resolved cluster rather than going through the SDK — the api-server
// exposes no log/health stream today, and the workloads it schedules
// carry well-known labels we can select on.
//
// The microVM is the sole local runtime, so the default target is its
// kubeconfig. The mapping from a credentials profile to a cluster
// mirrors how `appliance vm` lays things out on disk:
//
//   profile `microvm`           → ~/.appliance/vm/appliance/kubeconfig.yaml
//   profile `microvm-<name>`    → ~/.appliance/vm/<name>/kubeconfig.yaml
//   anything else / unset       → the default microVM's kubeconfig
//
// `appliance vm` labels workloads via
// (see packages/infra/.../LocalContainerDeploymentService.renderManifest):
// the Deployment/Service share `app.kubernetes.io/name: <stackName>`,
// where <stackName> is the environment's `stackName` (`<project>-<env>`).

/** Label key carrying the stack name on a deployment's pods. */
export const STACK_NAME_LABEL = 'app.kubernetes.io/name';
/** Label key marking every appliance-managed resource. */
export const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by';
export const MANAGED_BY_VALUE = 'appliance.sh';

const DEFAULT_VM_NAME = 'appliance';

/** How to address a cluster with `kubectl`: either an explicit
 *  kubeconfig file (the microVM engine ships one) or a named context in
 *  the user's default kubeconfig (an explicit `--context` override, e.g.
 *  for a BYO cluster). */
export interface ClusterTarget {
  /** Absolute path to a kubeconfig file, when the engine ships one. */
  kubeconfig?: string;
  /** kubectl context name, when targeting a context in the default
   *  kubeconfig (via an explicit `--context` override). */
  context?: string;
  /** Kubernetes namespace the workloads live in. */
  namespace: string;
  /** Human-readable description of how the target was resolved, for
   *  diagnostics. */
  source: string;
}

export interface ResolveClusterOptions {
  /** Active credentials profile name (from --profile / APPLIANCE_PROFILE
   *  / activeProfile). Drives the default engine mapping. */
  profile?: string;
  /** Explicit kubeconfig override (--kubeconfig). Wins over the profile
   *  mapping. */
  kubeconfig?: string;
  /** Explicit kubectl context override (--context). Wins over the
   *  profile mapping. */
  context?: string;
  /** Namespace override (-n / --namespace). */
  namespace?: string;
}

/** Path to a microVM's kubeconfig (`appliance vm` writes it here). */
export function vmKubeconfigPath(vmName: string): string {
  return path.join(os.homedir(), '.appliance', 'vm', vmName, 'kubeconfig.yaml');
}

/**
 * Map a credentials profile name to its microVM name, or null when the
 * profile isn't a microVM profile. Mirrors `profileForVm` in
 * appliance-vm.ts: the default VM owns the bare `microvm` profile, and
 * each additional VM owns `microvm-<name>`.
 */
export function vmNameForProfile(profile: string | undefined, apiUrl?: string): string | null {
  // `local` is user-selectable: only the loopback endpoint identifies the
  // canonical default-VM profile, never a remote login with the same name.
  if (profile === 'local' && apiUrl) {
    try {
      const { hostname, protocol } = new URL(apiUrl);
      if (
        (protocol === 'http:' || protocol === 'https:') &&
        (hostname === 'localhost' ||
          hostname.endsWith('.localhost') ||
          /^127\.\d+\.\d+\.\d+$/.test(hostname) ||
          hostname === '[::1]')
      )
        return DEFAULT_VM_NAME;
    } catch {
      /* An invalid URL is not evidence of a local VM. */
    }
  }
  if (!profile) return null;
  if (profile === 'microvm') return DEFAULT_VM_NAME;
  if (profile.startsWith('microvm-')) return profile.slice('microvm-'.length);
  return null;
}

/**
 * Resolve a usable kubectl target from explicit overrides + the active
 * profile. Throws with an actionable message when the microVM kubeconfig
 * isn't on disk (VM not up).
 *
 * Resolution order:
 *   1. --kubeconfig / --context overrides (either, validated).
 *   2. microVM profile → that VM's kubeconfig file.
 *   3. anything else / unset → the default microVM's kubeconfig (the
 *      sole local runtime).
 */
export function resolveClusterTarget(opts: ResolveClusterOptions): ClusterTarget {
  const namespace = opts.namespace ?? DEFAULT_LOCAL_NAMESPACE;

  // Explicit overrides win. Allow either a kubeconfig path or a context
  // name (or both); the caller's kubectl invocation honors whichever is
  // present.
  if (opts.kubeconfig || opts.context) {
    if (opts.kubeconfig && !fs.existsSync(opts.kubeconfig)) {
      throw new ClusterTargetError(`kubeconfig not found: ${opts.kubeconfig}`);
    }
    return {
      kubeconfig: opts.kubeconfig,
      context: opts.context,
      namespace,
      source: 'override',
    };
  }

  // A microVM profile names its VM; anything else (no profile, a cloud
  // profile, …) falls back to the default microVM, the sole local
  // runtime. Either way the target is the VM's on-disk kubeconfig.
  const vmName = vmNameForProfile(opts.profile) ?? DEFAULT_VM_NAME;
  const kubeconfig = vmKubeconfigPath(vmName);
  if (!fs.existsSync(kubeconfig)) {
    throw new ClusterTargetError(
      `no kubeconfig for microVM "${vmName}" at ${kubeconfig} — is it up? Run \`appliance vm up${
        vmName === DEFAULT_VM_NAME ? '' : ` --name ${vmName}`
      }\`.`
    );
  }
  return { kubeconfig, namespace, source: `microvm:${vmName}` };
}

/**
 * Build the leading `kubectl` argv that targets the resolved cluster
 * (kubeconfig / context) and namespace. Subcommand-specific args are
 * appended by the caller.
 */
export function kubectlBaseArgs(target: ClusterTarget): string[] {
  const args: string[] = [];
  if (target.kubeconfig) args.push('--kubeconfig', target.kubeconfig);
  if (target.context) args.push('--context', target.context);
  args.push('-n', target.namespace);
  return args;
}

/** A label selector matching a stack's pods/resources by stack name. */
export function stackSelector(stackName: string): string {
  return `${STACK_NAME_LABEL}=${stackName}`;
}

/** Thrown when a cluster target can't be resolved. Carries a
 *  user-facing remediation message. */
export class ClusterTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClusterTargetError';
  }
}
