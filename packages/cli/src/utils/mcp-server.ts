import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createApplianceClient, DeploymentStatus, VERSION } from '@appliance.sh/sdk';
import type { Deployment, Environment } from '@appliance.sh/sdk';
import { getActiveProfileOverride, loadCredentials, setActiveProfileOverride } from './credentials.js';
import { readProfiles, resolveProfile } from './profile-store.js';
import { resolveEnvironment } from './deployment-target.js';
import { extractDeploymentUrl, pollDeploymentUntilDone, urlsByEnvironment } from './deploy-poll.js';
import { remediationHint } from './errors.js';
import { DEFAULT_BUILD_OUTPUT, runDeploy } from './deploy-core.js';
import { deployStackApps, manifestCommand, withDir } from './stack-deploy.js';
import { STACK_FILENAME, loadStack, resolveStackApps } from './stack.js';
import { runPreflight } from './preflight.js';
import { runRuntimeDoctor } from './runtime-doctor.js';
import { DEFAULT_VM_NAME } from './microvm-up.js';

// The Appliance MCP server: the deploy/debug surface of the CLI exposed
// over the Model Context Protocol so external agents (Claude Code,
// Copilot, Codex, any MCP client) can drive deployments and diagnose
// failures without screen-scraping our human-facing terminal output.
//
// Design rules:
//   - Every tool goes through the api-server SDK client wherever one
//     exists, so a tool behaves identically against the local microVM
//     and a cloud installation (same base-URL contract as the console).
//   - Tools return compact JSON — agents parse it reliably, and it
//     keeps us honest about not leaking ANSI/chalk into results.
//   - Errors come back as `isError` results carrying the same
//     remediation hints the CLI prints, so an agent can self-correct
//     ("not logged in → run `appliance init`") instead of stalling.
//   - Nothing here process.exit()s: the server must outlive any one
//     failed tool call.
//
// The stdio wiring (stdout protection, transport) lives in
// appliance-mcp.ts; this module is transport-agnostic and unit-tested
// over an in-memory transport.

export interface McpClientBundle {
  client: ReturnType<typeof createApplianceClient>;
  apiUrl: string;
  profileName: string;
}

/** Everything the tools touch that isn't pure computation, injectable
 *  so tests can run the full server without a network, an engine
 *  binary, or a manifest on disk. */
export interface McpDeps {
  getClient(profile?: string): McpClientBundle;
  /** Run `appliance <args…>` as a child of this same executable and
   *  capture its combined output (used for VM lifecycle, whose engine
   *  helpers print + exit rather than throw). */
  selfInvoke(args: string[], timeoutMs: number): { status: number; output: string };
  runPreflight: typeof runPreflight;
  runRuntimeDoctor: typeof runRuntimeDoctor;
  /** Deploy engine entrypoints (in-process; see deploy tool). */
  runDeploy: typeof runDeploy;
  deployStackApps: typeof deployStackApps;
}

/** Resolve credentials for a profile without disturbing the process-wide
 *  override outside the call. */
function credentialsForProfile(profile?: string) {
  const prev = getActiveProfileOverride();
  if (profile) setActiveProfileOverride(profile);
  try {
    const resolved = resolveProfile(readProfiles(), { override: profile ?? prev });
    const credentials = loadCredentials();
    return { credentials, profileName: resolved?.name };
  } finally {
    setActiveProfileOverride(prev);
  }
}

function defaultGetClient(profile?: string): McpClientBundle {
  const { credentials, profileName } = credentialsForProfile(profile);
  if (!credentials) {
    throw new Error(
      profile
        ? `No credentials for profile "${profile}". List profiles with the overview tool, or run \`appliance login\`.`
        : 'Not logged in — no credentials for the active profile. Start the local runtime with the vm tool ' +
          '(action "up") or `appliance init`, or authenticate with `appliance login`.'
    );
  }
  return {
    client: createApplianceClient({
      baseUrl: credentials.apiUrl,
      credentials: { keyId: credentials.keyId, secret: credentials.secret },
      product: 'mcp',
    }),
    apiUrl: credentials.apiUrl,
    profileName: profileName ?? 'default',
  };
}

/** Argv prefix that re-invokes this same CLI, covering every install
 *  shape userArgs() recognizes: bun-compiled binary (embedded entry or
 *  duplicated argv[0]) and node/bun running a script. */
export function selfInvokeArgv(argv: string[] = process.argv): { command: string; prefix: string[] } {
  const entry = argv[1];
  const isBundled = !entry || entry.startsWith('/$bunfs/') || /^B:[\\/]~BUN[\\/]/.test(entry) || entry === argv[0];
  return { command: argv[0], prefix: isBundled ? [] : [entry] };
}

function defaultSelfInvoke(args: string[], timeoutMs: number): { status: number; output: string } {
  const { command, prefix } = selfInvokeArgv();
  const r = spawnSync(command, [...prefix, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: process.env,
    windowsHide: true,
  });
  const output = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
  if (r.error) {
    const detail =
      (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? `timed out after ${timeoutMs}ms` : r.error.message;
    return {
      status: r.status ?? 1,
      output: [output, `appliance ${args.join(' ')} failed: ${detail}`].filter(Boolean).join('\n'),
    };
  }
  return { status: r.status ?? 1, output };
}

const DEFAULT_DEPS: McpDeps = {
  getClient: defaultGetClient,
  selfInvoke: defaultSelfInvoke,
  runPreflight,
  runRuntimeDoctor,
  runDeploy,
  deployStackApps,
};

// ---- result helpers -------------------------------------------------------

function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err: unknown, apiUrl?: string): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  const hint = remediationHint(message, apiUrl);
  return {
    content: [{ type: 'text', text: hint ? `${message}\n${hint}` : message }],
    isError: true,
  };
}

function summarizeDeployment(d: Deployment) {
  return {
    id: d.id,
    action: d.action,
    status: d.status,
    startedAt: d.startedAt,
    completedAt: d.completedAt ?? null,
    message: d.message ?? null,
    idempotentNoop: d.idempotentNoop ?? false,
    url: extractDeploymentUrl(d.message) ?? null,
  };
}

// Deploys and destroys mutate cwd (stack members deploy from their own
// directories) and share the process-wide profile override, so they
// must never interleave. One promise-chain mutex serializes them.
let deployChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = deployChain.then(fn, fn);
  deployChain = next.catch(() => undefined);
  return next;
}

async function resolveTargetEnvironment(
  bundle: McpClientBundle,
  project: string,
  environment: string
): Promise<Environment> {
  return resolveEnvironment(bundle.client, project, environment);
}

const PROFILE_ARG = z
  .string()
  .optional()
  .describe(
    'Credential profile from ~/.appliance/profiles.json ("local" is the managed VM). Defaults to the active profile.'
  );

// ---- the server -----------------------------------------------------------

export function createApplianceMcpServer(overrides: Partial<McpDeps> = {}): McpServer {
  const deps: McpDeps = { ...DEFAULT_DEPS, ...overrides };

  const server = new McpServer(
    { name: 'appliance', version: VERSION.replace(/^v/, '') },
    {
      instructions:
        'Deploy and debug applications on the Appliance platform (local managed microVM or cloud installations). ' +
        'Start with `overview` to see profiles, projects, environments, and URLs. Deploy with `deploy` ' +
        '(point it at a directory containing an appliance.json manifest or an appliance.stack.json). ' +
        'When something is broken: `health` shows whether the workload is up and why not (crashloops, image pulls), ' +
        '`logs` fetches container logs, `doctor` diagnoses the host and runtime, and `vm` manages the local VM. ' +
        'All tools accept an optional `profile` to target a specific installation.',
    }
  );

  server.registerTool(
    'overview',
    {
      title: 'Appliance overview',
      description:
        'The "where am I" tool: lists credential profiles (no secrets), then for the selected profile reports api-server ' +
        'reachability, every project and environment with status, and the latest deployment URL per environment. ' +
        'Call this first.',
      inputSchema: { profile: PROFILE_ARG },
    },
    async ({ profile }) => {
      const profilesFile = readProfiles();
      const profiles = Object.entries(profilesFile.profiles ?? {}).map(([name, p]) => ({
        name,
        apiUrl: p.apiUrl,
        active: name === (profile ?? profilesFile.activeProfile),
      }));

      let bundle: McpClientBundle;
      try {
        bundle = deps.getClient(profile);
      } catch (err) {
        // No credentials at all is still a useful overview: report the
        // profile list and what to do next instead of a bare failure.
        return jsonResult({
          profiles,
          server: null,
          note: err instanceof Error ? err.message : String(err),
        });
      }

      try {
        const health = await bundle.client.healthz();
        if (!health.success) {
          return jsonResult({
            profiles,
            server: { profile: bundle.profileName, apiUrl: bundle.apiUrl, reachable: false },
            note:
              `The api-server at ${bundle.apiUrl} is not reachable (${health.error.message}). ` +
              'For the local runtime, boot it with the vm tool (action "up"); the doctor tool diagnoses deeper issues.',
          });
        }
        const projectsResult = await bundle.client.listProjects();
        if (!projectsResult.success) throw new Error(`Failed to list projects: ${projectsResult.error.message}`);

        const deployments = await bundle.client.listDeployments({ limit: 200 });
        const urls = urlsByEnvironment(deployments.success ? deployments.data : undefined);

        const projects = await Promise.all(
          projectsResult.data.map(async (p) => {
            const envs = await bundle.client.listEnvironments(p.id);
            return {
              id: p.id,
              name: p.name,
              status: p.status,
              environments: (envs.success ? envs.data : []).map((e) => ({
                id: e.id,
                name: e.name,
                status: e.status,
                lastDeployedAt: e.lastDeployedAt ?? null,
                url: urls.get(e.id) ?? null,
              })),
            };
          })
        );

        return jsonResult({
          profiles,
          server: {
            profile: bundle.profileName,
            apiUrl: bundle.apiUrl,
            reachable: health.success,
          },
          projects,
        });
      } catch (err) {
        return errorResult(err, bundle.apiUrl);
      }
    }
  );

  server.registerTool(
    'deploy',
    {
      title: 'Deploy an app or stack',
      description:
        'Deploy the app in a directory (appliance.json/appliance.ts manifest), or every member of a multi-service stack ' +
        'when the directory carries an appliance.stack.json. Packages the source, uploads it, builds server-side, waits ' +
        'for a terminal status, and returns the outcome with the deployed URL. Single apps need `project`/`environment` ' +
        'unless the directory is linked (.appliance/link.json) or the manifest carries a `name`. May take a few minutes ' +
        'on a first build.',
      inputSchema: {
        directory: z
          .string()
          .optional()
          .describe('Directory of the app or stack. Defaults to the current working directory.'),
        project: z.string().optional().describe('Project name (single-app deploys).'),
        environment: z
          .string()
          .optional()
          .describe('Environment name, e.g. "dev" or "production" (single-app deploys).'),
        profile: PROFILE_ARG,
      },
    },
    async ({ directory, project, environment, profile }) =>
      serialized(async () => {
        let bundle: McpClientBundle;
        try {
          bundle = deps.getClient(profile);
        } catch (err) {
          return errorResult(err);
        }

        const dir = path.resolve(directory ?? process.cwd());
        if (!fs.existsSync(dir)) return errorResult(new Error(`Directory not found: ${dir}`));

        try {
          return await withDir(dir, async () => {
            // Stack folder + no explicit single-app target → deploy the
            // whole stack, mirroring `appliance deploy`'s auto-detect.
            if (!project && fs.existsSync(path.join(dir, STACK_FILENAME))) {
              const loaded = loadStack(undefined, dir);
              const apps = resolveStackApps(loaded, environment);
              const result = await deps.deployStackApps({ client: bundle.client, apiUrl: bundle.apiUrl, apps });
              return jsonResult({
                stack: loaded.stack.name,
                failed: result.failed,
                apps: result.rows.map((r) => ({
                  app: r.app,
                  target: r.target,
                  status: r.status,
                  url: r.url ?? null,
                })),
              });
            }

            const outcome = await deps.runDeploy({
              client: bundle.client,
              apiUrl: bundle.apiUrl,
              program: manifestCommand(),
              cliProject: project,
              cliEnvironment: environment,
              opts: { build: DEFAULT_BUILD_OUTPUT, yes: true },
              // The per-call profile never touches the process-wide
              // override (credentialsForProfile restores it before this
              // runs), so the link file must be told explicitly which
              // profile this deploy used.
              linkProfile: profile,
            });
            return jsonResult({
              project: outcome.projectName,
              environment: outcome.environmentName,
              deployment: summarizeDeployment(outcome.deployment),
              succeeded: outcome.deployment.status === DeploymentStatus.Succeeded,
              url: outcome.url ?? null,
            });
          });
        } catch (err) {
          return errorResult(err, bundle.apiUrl);
        }
      })
  );

  server.registerTool(
    'deployment_status',
    {
      title: 'Deployment status',
      description: 'Fetch one deployment record by id (status, message, timing, URL when deployed).',
      inputSchema: {
        deploymentId: z.string().describe('Deployment id returned by the deploy tool or the overview.'),
        profile: PROFILE_ARG,
      },
    },
    async ({ deploymentId, profile }) => {
      try {
        const bundle = deps.getClient(profile);
        const result = await bundle.client.getDeployment(deploymentId);
        if (!result.success) return errorResult(new Error(result.error.message), bundle.apiUrl);
        return jsonResult(summarizeDeployment(result.data));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'health',
    {
      title: 'Environment health',
      description:
        'Live workload health for a deployed environment: healthy / degraded / unhealthy / not_deployed, replica ' +
        'readiness, restart counts, and per-pod failure reasons (CrashLoopBackOff, ImagePullBackOff, …). The first ' +
        'debugging call when a deployed app misbehaves; follow up with the logs tool.',
      inputSchema: {
        project: z.string().describe('Project name.'),
        environment: z.string().describe('Environment name.'),
        profile: PROFILE_ARG,
      },
    },
    async ({ project, environment, profile }) => {
      let bundle: McpClientBundle;
      try {
        bundle = deps.getClient(profile);
      } catch (err) {
        return errorResult(err);
      }
      try {
        const env = await resolveTargetEnvironment(bundle, project, environment);
        const result = await bundle.client.getEnvironmentHealth(env.projectId, env.id);
        if (!result.success) return errorResult(new Error(result.error.message), bundle.apiUrl);
        const h = result.data;
        return jsonResult({
          project,
          environment,
          status: h.status,
          readyReplicas: h.readyReplicas,
          desiredReplicas: h.desiredReplicas,
          restarts: h.restarts,
          pods: h.pods.map((p) => ({
            name: p.name,
            phase: p.phase,
            ready: p.ready,
            restarts: p.restarts,
            reason: p.reason ?? null,
          })),
          usage: h.usage ?? null,
          message: h.message ?? null,
          hint:
            h.status === 'unhealthy' || h.status === 'degraded'
              ? 'Fetch container logs with the logs tool to see why pods are failing.'
              : null,
        });
      } catch (err) {
        return errorResult(err, bundle.apiUrl);
      }
    }
  );

  server.registerTool(
    'logs',
    {
      title: 'Container logs',
      description:
        "Fetch recent container logs for an environment's pods through the api-server (works on the local VM and BYO " +
        "Kubernetes bases; cloud/Lambda bases have no pod logs). Returns each pod's logs labeled by pod name.",
      inputSchema: {
        project: z.string().describe('Project name.'),
        environment: z.string().describe('Environment name.'),
        pod: z
          .string()
          .optional()
          .describe('Only this pod (name from the health tool). Default: all pods of the environment.'),
        container: z.string().optional().describe('Only this container. Default: the first/only container per pod.'),
        tailLines: z
          .number()
          .int()
          .positive()
          .max(5000)
          .optional()
          .describe('Lines per pod from the end (default 200).'),
        sinceSeconds: z.number().int().positive().optional().describe('Only logs newer than this many seconds.'),
        profile: PROFILE_ARG,
      },
    },
    async ({ project, environment, pod, container, tailLines, sinceSeconds, profile }) => {
      let bundle: McpClientBundle;
      try {
        bundle = deps.getClient(profile);
      } catch (err) {
        return errorResult(err);
      }
      try {
        const env = await resolveTargetEnvironment(bundle, project, environment);
        const workloads = await bundle.client.listEnvironmentWorkloads(env.id);
        if (!workloads.success) {
          return errorResult(
            new Error(
              `${workloads.error.message} — pod logs are only available on Kubernetes-driven bases ` +
                '(the local VM or a BYO cluster), not on cloud/Lambda installations.'
            ),
            bundle.apiUrl
          );
        }
        const pods = workloads.data.pods.filter((p) => !pod || p.name === pod);
        if (pods.length === 0) {
          return errorResult(
            new Error(
              pod
                ? `Pod "${pod}" not found for ${project}/${environment}. The health tool lists current pod names.`
                : `No pods found for ${project}/${environment} — is it deployed? Check with the health tool.`
            )
          );
        }

        const MAX_PODS = 10;
        const sections = await Promise.all(
          pods.slice(0, MAX_PODS).map(async (p) => {
            const logs = await bundle.client.getPodLogs(p.name, {
              container,
              tailLines: tailLines ?? 200,
              sinceSeconds,
            });
            const body = logs.success ? logs.data.trimEnd() || '(no log output)' : `(failed: ${logs.error.message})`;
            return `=== pod ${p.name} (${p.phase}${p.ready ? '' : ', not ready'}) ===\n${body}`;
          })
        );
        const truncated = pods.length > MAX_PODS ? `\n(showing ${MAX_PODS} of ${pods.length} pods)` : '';
        return { content: [{ type: 'text', text: sections.join('\n\n') + truncated }] };
      } catch (err) {
        return errorResult(err, bundle.apiUrl);
      }
    }
  );

  server.registerTool(
    'destroy',
    {
      title: 'Destroy an environment',
      description:
        "Tear down an environment's deployed workload. Destructive — requires confirm: true. The project and " +
        'environment records survive; a later deploy recreates the workload.',
      inputSchema: {
        project: z.string().describe('Project name.'),
        environment: z.string().describe('Environment name.'),
        confirm: z.boolean().describe('Must be true. Set it only when the user has asked for the teardown.'),
        profile: PROFILE_ARG,
      },
    },
    async ({ project, environment, confirm, profile }) =>
      serialized(async () => {
        if (!confirm) {
          return errorResult(new Error(`Refusing to destroy ${project}/${environment} without confirm: true.`));
        }
        let bundle: McpClientBundle;
        try {
          bundle = deps.getClient(profile);
        } catch (err) {
          return errorResult(err);
        }
        try {
          const env = await resolveTargetEnvironment(bundle, project, environment);
          const started = await bundle.client.destroy(env.id);
          if (!started.success) return errorResult(new Error(started.error.message), bundle.apiUrl);
          const { deployment } = await pollDeploymentUntilDone(bundle.client, started.data.id, {});
          return jsonResult({
            project,
            environment,
            destroyed: deployment.status === DeploymentStatus.Succeeded,
            deployment: summarizeDeployment(deployment),
          });
        } catch (err) {
          return errorResult(err, bundle.apiUrl);
        }
      })
  );

  server.registerTool(
    'doctor',
    {
      title: 'Diagnose host + runtime',
      description:
        'Run the same diagnostics as `appliance doctor`: host preflight (prerequisites, free ports) plus runtime checks ' +
        'on the managed VM (auth keys, clock skew, ingress claims, profile wiring). Read-only — it never applies fixes. ' +
        'Each finding carries a remediation an agent can act on.',
      inputSchema: {
        vm: z.string().optional().describe(`microVM to diagnose (default "${DEFAULT_VM_NAME}").`),
      },
    },
    async ({ vm }) => {
      try {
        const report = await deps.runPreflight();
        const runtime = await deps.runRuntimeDoctor({ vm: vm ?? DEFAULT_VM_NAME, vmExplicit: Boolean(vm), fix: false });
        return jsonResult({
          ok: report.ok && runtime.ok,
          preflight: report.results.map((r) => ({
            id: r.id,
            label: r.label,
            status: r.status,
            detail: r.detail ?? null,
            remediation: r.remediation ?? null,
          })),
          runtime: runtime.findings.map((f) => ({
            id: f.id,
            title: f.title,
            severity: f.severity,
            detail: f.detail ?? null,
            remediation: f.remediation ?? null,
          })),
          serverVersion: runtime.serverVersion ?? null,
          hint:
            report.ok && runtime.ok ? null : 'Run `appliance doctor --fix` in a terminal to apply the safe auto-fixes.',
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'vm',
    {
      title: 'Manage the local VM',
      description:
        'Lifecycle of the managed microVM that runs local deploys: "status" reports state, "up" boots it (first boot ' +
        'downloads images and can take several minutes — use a generous timeout), "stop" parks it preserving all state. ' +
        'Runs the real `appliance vm …` command and returns its output.',
      inputSchema: {
        action: z.enum(['status', 'up', 'stop']).describe('What to do.'),
        name: z.string().optional().describe(`VM name (default "${DEFAULT_VM_NAME}").`),
      },
    },
    async ({ action, name }) => {
      const vmName = name ?? DEFAULT_VM_NAME;
      const args =
        action === 'up'
          ? ['vm', 'up', '--name', vmName]
          : action === 'stop'
            ? ['vm', 'stop', '--name', vmName]
            : ['vm', 'status', '--name', vmName];
      // First boot pulls images; give `up` real headroom.
      const timeoutMs = action === 'up' ? 20 * 60_000 : 2 * 60_000;
      const { status, output } = deps.selfInvoke(args, timeoutMs);
      const result: CallToolResult = {
        content: [{ type: 'text', text: output || `appliance ${args.join(' ')} exited ${status}` }],
      };
      if (status !== 0) result.isError = true;
      return result;
    }
  );

  return server;
}
