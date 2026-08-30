# Control-plane: one api-server, two base URLs

**Status:** Implemented (E4.x shipped; placement + build pipeline since overhauled — see "Placement & builds" below).

## Goal & invariant

Desktop console and CLI manage all cluster state through **one** appliance
api-server. The local server runs as a **plain binary inside the microVM**;
the cloud server is the _same api-server code_ running on the installation's
cloud compute. A client picks which one by **base URL** — nothing else
differs.

```
  desktop console ─┐                         ┌─ in-VM api-server  (guest binary; FilesystemObjectStore /persist/appliance-data)
                   ├─ ApplianceClient(baseUrl, creds, RFC 9421) ─┤
  CLI ─────────────┘                         └─ cloud api-server (S3ObjectStore)
```

This holds for projects / environments / deployments / health / workloads /
logs. The E4.x work below closed the last divergence (the desktop's kubectl
shell-outs).

## Placement & builds (current state)

**Local placement — a guest binary, not a pod.** The api-server ships as a
bun-compiled linux-musl executable. `appliance vm up` stages it (plus the web
console bundle) into `~/.appliance/vm/images/guest-assets/`; `appliance-vm`
embeds them in the boot media; the guest bootstrap launches the binary on
guest port `9091` under a respawn loop. It is reached through the existing
Traefik ingress at `http://api.appliance.localhost:8081` via a selector-less
Service + Endpoints that point at the guest process. It authenticates to k3s
with its own ServiceAccount token (created by the auto-applied manifest —
bun's fetch cannot do kubeconfig client-cert auth) and trusts the k3s CA via
`NODE_EXTRA_CA_CERTS`. There is **no in-cluster api-server pod, no image
delivery at `vm up`, and no host-side daemon** (`appliance server start` is a
deprecation shim that boots the VM). Credentials: `appliance-vm` generates a
bootstrap token persisted at `~/.appliance/vm/<name>/bootstrap-token` and
injected into the guest at `/etc/appliance/bootstrap-token`; the CLI mints an
API key from it automatically.

**One fork point.** The api-server's base-type branch lives in exactly one
place — `packages/api-server/src/services/deployment-backend.ts`: Kubernetes
bases (the microVM + BYO clusters) resolve to the container backend
(`LocalContainerDeploymentService`); cloud (AWS/Lambda) bases resolve to
`null` and take the Pulumi path; the removed docker base throws
`RemovedDockerBaseError` naming the migration (`appliance dev`).

**Server-side builds.** The CLI never runs docker/buildctl/crane.
`appliance deploy` uploads a **source zip** (manifest + tree) and the
api-server builds the container image server-side with BuildKit — the in-VM
buildkitd + in-VM registry locally, the installation's builder + ECR on
cloud. `framework` apps (node/python/auto) get a server-generated Dockerfile
and are first-class on every base; `container` apps ship their Dockerfile +
context in the zip. On Kubernetes bases the upload lands via
`PUT /api/v1/builds/:id/content?token=…` — a **one-time token** minted by
`POST /api/v1/builds`, the self-hosted analogue of a presigned S3 URL; on
cloud bases it is still a presigned S3 PUT.

### Verified facts (file:line)

- In-VM server: `packages/helper/src/api-server.ts:11` (`IN_CLUSTER_API_SERVER_HOSTNAME = 'api.appliance.localhost'`), `mintApiKey` (`:46`). Guest binary provisioning: `packages/vm/src/guest.rs` (`APISERVER_MEDIA_COPY` / `APISERVER_COMMON`, `API_SERVER_GUEST_PORT = 9091`); CLI staging in `packages/cli/src/utils/api-server-artifact.ts`; key minting in `packages/cli/src/utils/microvm-up.ts`. Reachable at `http://api.appliance.localhost:8081`. VM data dir `/persist/appliance-data`. The microVM is the sole local runtime; the former host-side k3d bootstrap and the host-daemon runtime have been removed.
- **Single ObjectStore per server (confirmed):** `packages/api-server/src/services/storage.service.ts` builds exactly one store — `FilesystemObjectStore(k8s.dataDir)` for k8s bases (`:66`) or one `S3ObjectStore` for cloud (`:72`) — behind a process singleton (`:76-83`). All services go through `getStorageService()`. "Unified state" follows automatically. See [§6](#6-one-objectstore-per-server-confirmed) for the _only_ place a second store sneaks in.
- Auth: clients resolve `apiUrl` via `APPLIANCE_API_URL` → `~/.appliance/profiles.json` profile (`packages/cli/src/utils/credentials.ts:45-52`), then sign with RFC 9421 (`packages/sdk/src/client/appliance-client.ts:35-49`; verify `packages/api-server/src/middleware/auth.ts`). The microVM uses `profileForVm(name)` (`packages/cli/src/utils/microvm-up.ts`) — `local` for the default VM, `microvm-<name>` otherwise.
- Desktop frontend **already** drives the server via the SDK: `packages/app/src/hooks/use-appliance-client.ts:26-29` builds an `ApplianceClient` from `selected.apiServerUrl` + `config.apiKey.{id,secret}`. The migration reuses this exact wiring.

## 1. Migrate-to-HTTP vs stay-host-local

The boundary rule: **anything that is a CRUD/read against cluster state moves
behind the api-server** (it is the one component with cluster RBAC + the
ObjectStore, in both local and cloud). **Anything that drives host hardware,
the VM lifecycle, the local toolchain, or signs/inspects traffic stays in the
desktop** — those have no meaning on a remote cloud server and cannot be
expressed as a base-URL-selected HTTP call.

| `lib.rs` command                                                                                   | Disposition        | Why                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_local_workloads` (`:4100`, `kubectl get deploy,pod,svc -o json` `:4110`)                     | **MIGRATE → HTTP** | Pure cluster read. Server already has CoreV1/AppsV1 + RBAC.                                                                                                  |
| `tail_local_pod_logs` (`:4241`, `kubectl logs` `:4255`)                                            | **MIGRATE → HTTP** | Cluster read; RBAC `pods/log` already granted (`api-server.ts:166`).                                                                                         |
| cluster _readiness_ (the "is k3s/api-server serving" signal inside `local_cluster_status` `:1685`) | **MIGRATE → HTTP** | A reachability probe of the server (`GET /healthz`) is the real readiness test.                                                                              |
| `microvm_*` — install/up/stop/delete/status (`:3187`–`:3709`)                                      | **STAY**           | VM lifecycle on the host hypervisor. Distinct from cluster-ready (`microvm_status` reports VM phases).                                                       |
| `terminal_*` / PTY (`:4267`+)                                                                      | **STAY**           | Interactive `kubectl exec` / `kubectl debug node` + chroot into the VM host — a bidirectional PTY, not a request/response; host-only `debug node` semantics. |
| egress / MITM — `microvm_egress_*` (`:3772`+)                                                      | **STAY**           | Host-side proxy + CA injection on the VM's network edge.                                                                                                     |
| code-signing, AWS profile reading                                                                  | **STAY**           | Local toolchain / host credentials; no cluster-state meaning. (Image builds moved server-side entirely — neither surface runs docker.)                       |
| `promote_state` / `demote_state` (`:1181` / `:1206`), `update_baseline`                            | **STAY**           | Operate on Pulumi **installer** state (a _separate_ backend, see §6), need docker + host AWS creds. Not app state.                                           |

Net: exactly two reads (`list_local_workloads`, `tail_local_pod_logs`) plus the
readiness sub-signal migrate; the `kube_target_args` kubeconfig plumbing
(`:4071`) they depend on can then be deleted. Everything else is correctly
host-local.

## 2. New api-server endpoints (E4.1)

| Endpoint                                 | Authentication                | Scope                                                                |
| ---------------------------------------- | ----------------------------- | -------------------------------------------------------------------- |
| `GET /api/v1/workloads`                  | signed key                    | Kubernetes workload snapshot                                         |
| `GET /api/v1/environments/:id/workloads` | signed key                    | Environment-filtered Kubernetes workload snapshot                    |
| `GET /api/v1/pods/:name/logs`            | signed key                    | Snapshot or streaming Kubernetes logs                                |
| `POST /api/v1/self-update`               | signed owner-tenant admin key | Verify evidence, persist/lease, and dispatch a cloud self-update job |
| `GET /api/v1/self-update/:jobId`         | signed owner-tenant admin key | Read durable phase/result and resume an expired-lease cloud job      |
| `GET /healthz`                           | none                          | Process liveness only                                                |

The SDK exposes the self-update contract as `client.selfUpdate`:

- `start({targetDigest, release, idempotencyKey})` signs `POST /api/v1/self-update` and returns a typed `202` accepted or `409`
  live-lease response.
- `status(jobId)` signs `GET /api/v1/self-update/:jobId` and returns the shared `SelfUpdatePublicJob`, including redacted failure and
  additive `phaseDurationsMs` timing evidence and terminal `totalMs`.
- `watch(jobId, {intervalMs, onPhase, deadlineMs, signal, maxConsecutiveErrors})` polls status, calls `onPhase` once per phase
  transition, tolerates five consecutive transient failures by default with capped exponential backoff, and resolves on `succeeded`
  or `failed`. The deadline and abort signal bound polling; a give-up error retains the job id and its `--follow` recovery command.

CLI and Desktop CloudFormation-v1 updates use this same client. Desktop retains the argv-based Tauri sidecar only for the legacy
two-release deprecation path; baseline updates and other host/AWS operations remain host-local.

The server already talks to the cluster via `@kubernetes/client-node`
(`CoreV1Api` + `AppsV1Api`, authed with its ServiceAccount token) inside
`packages/infra/src/lib/local/LocalContainerDeploymentService.ts:141-158,642`,
and already lists pods for health (`listNamespacedPod` `:390`). RBAC for
`pods`, `services`, `deployments`, `replicasets`, `ingresses`, **and
`pods/log`** is already bound (`packages/helper/src/api-server.ts:156-167`).
So E4.1 is additive: new read methods on the infra client + thin routes. No new
RBAC, no new k8s wiring.

All routes mount under the existing `signatureAuth` (`main.ts:49-54`) and are
gated to Kubernetes bases — on AWS/Lambda bases they return `409` with an
explanatory body, mirroring `environment-health.service.ts:35-40` (`isKubernetesBase`).

**`GET /api/v1/workloads?namespace=<ns>`** — defaults to the server's
configured namespace (`appliance`, `lib.rs:1308`). Returns the shape the desktop
already renders (`LocalWorkloads`, `lib.rs:4023-4061`):

```jsonc
{ "deployments": [{ "name","image","desired","ready","available","createdAt" }],
  "pods":        [{ "name","phase","ready","restartCount","containerImage","createdAt" }],
  "services":    [{ "name","type","clusterIP","nodePort","targetPort" }] }
```

(Optional environment-scoped variant `GET /api/v1/environments/:id/workloads`
filters by `app.kubernetes.io/name=<stackName>` — the selector the infra layer
already uses, `LocalContainerDeploymentService.ts:391`.)

**`GET /api/v1/pods/:name/logs`** — query: `container`, `tailLines` (default
200), `namespace`, `follow` (bool), `sinceSeconds`.

- **Snapshot** (`follow` unset): `Content-Type: text/plain`, the tail as one
  body. Drop-in for `tail_local_pod_logs`.
- **Streaming** (`follow=1`): **chunked `text/plain`** via the client-node `Log`
  helper with `{ follow: true, tailLines }`, piping the k8s watch stream
  straight to the HTTP response. (SSE is unnecessary — raw chunked log lines are
  simpler for both the Rust side and the browser; pick SSE only if the console
  later wants typed events.)

**How streaming authenticates with signed requests.** The signature covers a
GET with **no body**, so only the derived components (`@method`, `@authority`,
`@path`, `created`, `expires`) are signed — the SDK already takes this branch
for body-less requests (`appliance-client.ts:42-49`) and the verifier skips the
content-digest when there is no body (`auth.ts:24`). Auth is checked **once, at
connection open**; the `expires` window gates _establishing_ the stream, not its
duration, so a long-lived `follow` stream stays open past the signature window.
The client closes by aborting the request.

**Readiness:** add an unauthenticated **`GET /healthz`** (liveness only, no
state) so the desktop's cluster-ready probe is a base-URL HTTP check rather than
`kubectl`. (The signed `GET /api/v1/cluster-info` already exists for richer
status, `main.ts:54`.)

## 3. SDK client methods (E4.2)

Add to `ApplianceClient` (`packages/sdk/src/client/appliance-client.ts`). The
existing `request<T>` helper covers the JSON snapshot calls; **log streaming
needs a new method** because `request` buffers via `response.json()` and cannot
yield incrementally.

```ts
// JSON, via the existing request<T> path
listWorkloads(opts?: { namespace?: string }): Promise<Result<Workloads>>;
listEnvironmentWorkloads(environmentId: string): Promise<Result<Workloads>>;

// Snapshot tail — text body, not JSON
getPodLogs(pod: string, opts?: {
  container?: string; tailLines?: number; namespace?: string; sinceSeconds?: number;
}): Promise<Result<string>>;

// Streaming — signs a body-less GET, returns lines until aborted
streamPodLogs(
  pod: string,
  opts: { container?: string; tailLines?: number; namespace?: string; signal: AbortSignal },
  onLine: (line: string) => void,
): Promise<Result<void>>;

healthz(): Promise<Result<{ ok: true }>>; // unsigned liveness probe
```

`Workloads` is a new exported SDK model matching the §2 shape (and the existing
`LocalWorkloads` Rust struct, so the desktop UI types are unchanged).

## 4. Desktop migration (E4.3)

The desktop **already** has the base URL + credentials for the active cluster:
`use-appliance-client.ts` reads `selected.apiServerUrl` and `config.apiKey`
(synced from `cluster:<id>` / profiles.json) and builds the signed client. The
local-runtime workloads page and the log viewer call the Tauri commands today
via `host.ts:207` (`list_local_workloads`) and `:210` (`tail_local_pod_logs`).

Migration:

1. Replace those two `host.local.*` calls with `client.listWorkloads()` and
   `client.getPodLogs()` / `client.streamPodLogs()` from `useApplianceClient()`
   — the same hook already powering projects/deployments. No new auth or URL
   plumbing; the in-VM server is reached at `apiServerUrl`
   (`http://api.appliance.localhost:8081`) exactly as the rest of the console is.
2. The live-tail panel switches from periodic `tailPodLogs` polling to one
   `streamPodLogs(..., { signal })` call, aborted on unmount / pod switch.
3. Cluster-ready badge: probe `client.healthz()` (or reuse `cluster-info`)
   instead of the kubectl reachability path; keep `microvm_status` for the
   VM-running-vs-cluster-ready distinction.
4. Delete `list_local_workloads`, `tail_local_pod_logs`, and `kube_target_args`
   from `lib.rs`, plus their `invoke_handler` registrations (`:5109-5110`).
   `kubectl` stays a declared dependency only for the surviving PTY/terminal and
   `kubectl apply` deploy paths.

The CLI gets the same reads for free (`appliance vm` could grow
`workloads` / `logs` subcommands calling the new SDK methods) but that is not
required for E4.3.

## 5. Credential unification (E4.4) — platform stores (IMPLEMENTED)

Desktop and CLI share `profiles.json` for cluster discovery and metadata, but
the platform determines where the secret is canonical:

| Platform | Secret source                                                              | File posture                                        | Evidence                                                                         |
| -------- | -------------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------- |
| macOS    | Keychain                                                                   | metadata plus empty secret after reconciliation     | [`keychain.spec.ts`](../packages/cli/src/utils/keychain.spec.ts)                 |
| Windows  | Credential Manager through the packaged sibling `appliance-credhelper.exe` | metadata plus empty secret after verified migration | [`credential-store.spec.ts`](../packages/cli/src/utils/credential-store.spec.ts) |
| Linux    | owner-only files                                                           | cleartext secret remains at rest in `profiles.json` | [`file.rs`](../packages/credential-store/src/file.rs)                            |

The Windows CLI and desktop use the same typed Credential Manager contract;
there is no DPAPI-unreadable CLI exception and no planned DPAPI-wrapped file
DEK in this design. The helper uses private binary pipes and distinct
fail-closed statuses, and its release digest is pinned. See
[credentials.md](credentials.md#windows-helper-contract) and
[`windows_cli.rs`](../packages/credhelper/tests/windows_cli.rs).

Windows migration is lazy, idempotent, and read-back verified. Equal legacy
copies are scrubbed; differing copies remain intact and report `conflict`.
After a successful scrub, an older Windows binary must be upgraded or the user
must sign in again. [`credential-store.spec.ts`](../packages/cli/src/utils/credential-store.spec.ts)
covers this downgrade boundary and conflict preservation.

### Doctor coherence states

Windows checks every profile; it does not return `not-applicable`. macOS checks
desktop-managed profiles, while Linux has no OS-store coherence row. Doctor
distinguishes `missing`, `denied`, `malformed`, `migrated`, `conflict`,
`helper-missing`, and `legacy-name`. `doctor --fix` retries only safe
write-back/migration cases; conflicts preserve both values for an explicit
re-login decision. [`runtime-doctor.spec.ts`](../packages/cli/src/utils/runtime-doctor.spec.ts)
asserts each rendered state and [`credential-store.spec.ts`](../packages/cli/src/utils/credential-store.spec.ts)
asserts the underlying Windows probes.

### Remaining boundaries

Control-plane image/binary update and recovery boundaries are decided in [control-plane-self-update.md](control-plane-self-update.md).

Linux credential files remain cleartext at rest; owner-only mode/ACL limits
ordinary cross-user reads but is not encryption. Desktop and CLI also do not
share one cross-process metadata lock: each writes atomically, but a concurrent
desktop/CLI read-modify-write remains last-writer-wins. The CLI lock behavior
is covered by [`profiles-lock.spec.ts`](../packages/cli/src/utils/profiles-lock.spec.ts).

On macOS, `/usr/bin/security` writes still place a rotated value on that
utility's argv and Keychain access can prompt. On Windows, Credential Manager
does not defend against same-user, Administrator, SYSTEM, or allowed WSL
interop execution. The full residual and managed-distro interop mitigation are
in [credentials.md](credentials.md#windows-residual-risk).

## 6. One ObjectStore per server (confirmed)

`getStorageService()` is a process singleton over a single store (§1 facts).
There is exactly one app-state ObjectStore per api-server, so once the desktop
reads workloads/logs through the server, local and cloud share the same
single-source state automatically.

**The only "second store" to keep out:** the desktop's own kubectl read path
_is_ a divergent, ObjectStore-bypassing view of cluster state today — that is
the gap §1–§4 close. Do **not** reintroduce direct cluster reads in the desktop
after migration. Separately, the Pulumi **installer** state backend
(`stateBackendUrl`; `promote_state`/`demote_state`, `lib.rs:1181`/`:1206`) is a
_distinct_ store by design — it holds infra/installer state, not appliance app
data, and correctly stays host-local; it is not a second app-state store and
must not be folded into the api-server ObjectStore.
