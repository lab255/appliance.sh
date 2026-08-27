# RFC 0003: Compound apps and isolation

- Status: proposed
- Date: 2026-08-27
- Claim: `ap-p0-compound-c51d08`
- Depends on: RFC 0001 (bundle manifest v2), RFC 0002 (shared-VM controls)

## Summary

An Appliance Runtime bundle may describe a compound app: one signed top-level
appliance containing a bounded graph of runnable container or Linux binary
services. The bundle manifest remains `appliance.json`, the same filename used
by source appliances today. RFC 0001 owns the complete v2 manifest and payload
shapes; this RFC defines only the graph and lifecycle fields it must adopt.

The runtime has two execution topologies:

1. By default, every installed top-level app and all of its shared services run
   in one pooled, core-only runtime VM.
2. A first-level sub-appliance with `isolation: "vm"` runs in a dedicated,
   core-only VM. Its descendants, if any, inherit that VM.

The pool is separate from the existing development/deploy VM and has no
workspace mount, k3s, BuildKit, or Docker daemon. Its default name is
`appliance-runtime`; isolated VM names are not a stable public interface.

Inside a VM, a small Appliance runtime supervisor manages both OCI containers
through containerd and arbitrary Linux binaries as unprivileged, namespaced
processes. It evaluates the dependency graph, runs health checks, applies
restart policy, reports state and logs, and stops each top-level app as a unit.
An app failure never deliberately stops another app in the pool, though a pool
VM failure is necessarily a shared failure domain.

The graph is limited to top-level app -> sub-appliance -> service and 16
runnable leaves. Validation rejects deeper or larger graphs before extraction.

Shared discovery uses stable loopback ports injected as
`APPLIANCE_SVC_<NAME>_URL`; cross-VM discovery uses runtime-owned
`.appliance.internal` names and host-only netstack relays.

This is a packaging and runtime unit, not a replacement spelling for today's
client-side stacks. `appliance stack` remains useful for source-level fleets of
independent projects and cloud environments; it is not the implementation of
compound bundles.

## Manifest additions

RFC 0001 should adopt the following exact field names. Definitions here are
normative for composition semantics, while RFC 0001 remains normative for the
full manifest schema, common identity fields, payloads, ports, mounts, egress,
resources, signatures, and bundle layout.

### Compound discriminator and graph

Add `"compound"` to the v2 `type` discriminator and add:

```ts
interface CompoundFields {
  services: Service[];
}
```

`services[]` is an ordered serialization of a dependency graph, not an implied
start order. Each item is a nested runnable manifest fragment. It reuses the
RFC 0001 `name`, `type`, `version`, `payload`, `ports`, `mounts`, `egress`, and
`resources` shapes and adds the lifecycle fields below.

A service with `type: "compound"` is a structural sub-appliance and has its
own `services[]`. A service with `type: "container"` or `type: "binary"` is a
runnable leaf and may not contain `services[]`. A top-level compound may also
contain runnable leaves directly; that is the one-level shorthand for apps
that do not need structural sub-appliance grouping.

This RFC does not add an `appliance` wrapper around each service. The service
entry is the nested manifest fragment. This keeps the shape small and lets RFC
0001 reuse its runnable discriminated union recursively with a depth check.

### Dependency and lifecycle fields

Runnable leaf entries add these exact fields:

```ts
interface ServiceLifecycleFields {
  dependsOn?: string[]; // default []
  health?: ServiceHealth;
  restart?: ServiceRestart;
  required?: boolean; // default true
}

type ServiceHealth = (
  | { type: 'http'; port: string; path: string }
  | { type: 'tcp'; port: string }
  | { type: 'exec'; command: string[] }
) & {
  intervalSeconds?: number; // default 5
  timeoutSeconds?: number; // default 2
  failureThreshold?: number; // default 3
};

interface ServiceRestart {
  policy: 'never' | 'on-failure' | 'always'; // default on-failure
  maxAttempts?: number; // default 5 in a rolling 60-second window
  backoffSeconds?: number; // default 2, exponential, capped at 30
}
```

`dependsOn` contains service `name` values in the same top-level app. A
dependency is satisfied only when the target is healthy, or running when it
has no explicit `health` check. Array position has no lifecycle meaning.

HTTP and TCP `health.port` values reference RFC 0001 `ports[].name`, never a
raw port number. HTTP success is any 200-399 response. TCP success is a
completed connection. Exec success is exit code zero and runs inside the
service's container or namespaces as its unprivileged service user.

If `health` is absent, process/container liveness is readiness. This is a
deliberate compatibility default, not a claim that liveness is an adequate
production health signal.

An explicit stop always overrides restart policy. A process healthy for 60
seconds clears its rolling failure count.

### Isolation field

First-level entries in the top-level `services[]` add:

```ts
interface ServiceIsolationFields {
  isolation?: 'shared' | 'vm'; // default shared
}
```

Only first-level entries may set `isolation`; structural sub-appliances pass it
to every descendant. A direct first-level leaf applies it to itself.

`isolation: "vm"` means a dedicated VM for that first-level entry, not one VM
per descendant. Multiple `isolation: "vm"` entries get distinct VMs. Omission
means the pooled runtime VM, even when other top-level apps are already running
there.

### Service identity

Every service and structural sub-appliance name uses RFC 0001's DNS-safe name
schema. Runnable leaf names must be unique across the whole top-level app, not
just within a structural parent. This makes dependency references, CLI
selectors, log prefixes, and `APPLIANCE_SVC_<NAME>_URL` unambiguous.

Structural names are sibling-unique. Storage and diagnostics use the full path,
for example `notes-suite/search/indexer`.

## Validation rules

Validation completes before extraction, VM creation, grants, or listeners and
reports every graph error it can find in one pass.

1. `type: "compound"` requires a non-empty `services[]`.
2. Only v2 top-level or nested compound entries may contain `services[]`.
3. A top-level app may contain first-level entries, and a first-level compound
   may contain runnable leaves. A second-level compound is rejected.
4. There may be at most 16 runnable leaves after flattening. Structural
   compound entries do not count toward 16.
5. Runnable leaf names are globally unique within the top-level app.
6. Every `dependsOn` target exists, names a runnable leaf, is not self, and is
   in the same top-level app.
7. The dependency graph is acyclic. An error prints at least one complete cycle
   such as `web -> indexer -> web`.
8. `dependsOn`, `health`, `restart`, and `required` are rejected on structural
   compound entries; lifecycle belongs to runnable leaves.
9. `isolation` is accepted only on first-level entries and is inherited by
   descendants.
10. Every HTTP/TCP health port names a declared port on the same leaf; paths
    start with `/`; exec commands are non-empty.
11. Numeric health and restart values are positive integers. Intervals are
    1-300 seconds, timeouts are 1-60 seconds and no greater than the interval,
    thresholds are 1-20, attempts are 0-100, and backoff is 1-60 seconds.
12. A discoverable leaf has exactly one RFC 0001 primary port. A worker with no
    inbound API may have no ports and gets no service URL.
13. A top-level UI service reference resolves to a runnable leaf with a primary
    port. Structural entries cannot be UI targets.
14. Bundle paths remain relative, normalized, and contained by the bundle;
    nested payloads may not escape or overlap another service's payload root.
15. A binary payload must target Linux for the host/VM architecture and have an
    executable entrypoint. It receives the same unprivileged user, mount, PID,
    IPC, UTS, and network namespace treatment as a container.
16. Cross-VM dependencies are valid. Validation reserves an internal relay for
    each primary/named port they use and fails before start if the host cannot
    allocate the route.

**NOTE — service counting default:** the owner limit says "16 services". This
RFC counts runnable leaves, because structural compound nodes consume no
process slot. A future schema may impose a separate, lower structural-node
limit without changing runtime capacity.

**NOTE — direct leaves default:** allowing direct runnable leaves under the
top-level compound preserves the mock's simple two-service form. Publishers
only add a structural sub-appliance when they need a nested ownership/version
boundary.

## Shared-VM lifecycle

### Supervisor choice

Use a small Appliance runtime supervisor installed in every runtime VM.

Systemd conflicts with the Alpine/OpenRC guest. Docker Compose cannot supervise
arbitrary binaries or the cross-VM graph. The current shell respawn loop lacks
durable graph state, health, bounded backoff, identity, and structured status.

The supervisor is a single, intentionally small guest binary. It accepts a
validated, flattened execution plan over a host-owned vsock control channel;
persists only runtime state beneath `/persist/runtime/`; starts containers via
containerd and binaries via `clone`/namespace setup; captures stdout/stderr;
and returns structured events and status. `guest_exec.rs` remains useful for
bootstrap and diagnostics, but long-lived lifecycle RPC must not be encoded as
shell command strings.

Each top-level app has one supervisor namespace for desired state, lifecycle,
status, and logs even when it shares the pool.

### Start

1. The host verifies the signed top-level bundle and validates the entire
   graph before contacting a VM.
2. It materializes each payload in a content-addressed, read-only directory and
   allocates stable service identities, loopback ports, data directories, and
   network namespaces.
3. It boots or reuses `appliance-runtime` and boots each required isolated VM.
4. It sends each VM only the services placed there plus the full dependency
   endpoint map needed by those services.
5. The supervisor starts every zero-dependency leaf concurrently.
6. A dependent starts only after all of its dependencies satisfy readiness.
7. Start succeeds when every required leaf is healthy/running and every
   optional leaf is either healthy/running or terminally failed without
   blocking a required leaf.

Start order is dependency-declared and parallel where possible; array order
only breaks ties in output.

### Health and restart

The supervisor runs probes from the service's own namespaces. A probe cannot
gain network or mount visibility that the workload lacks. Startup readiness and
ongoing health use the same probe. A service becomes unhealthy after
`failureThreshold` consecutive failures; one success resets the consecutive
count.

For `on-failure`, an unhealthy service is terminated and restarted until its
rolling `maxAttempts` is exhausted. A clean exit is terminal. For `always`, a
clean or failed exit restarts until the app is explicitly stopped. For `never`,
any exit is terminal. Backoff is exponential from `backoffSeconds`, capped at
30 seconds, with no jitter in v1 so tests and CLI timing remain deterministic.

### Required and optional failure semantics

During startup, a terminal required-service failure fails the app start and
stops every service already started for that app in reverse dependency order.
A terminal optional-service failure marks the app `degraded`; independent
branches continue. Any dependent of the failed service is `blocked`. If a
blocked dependent is required, the app start fails as though that required
service had failed.

After a successful start, exhausting restart policy on a required service sets
the app to `failed` and stops the app as a unit. Exhausting an optional service
sets the app to `degraded` and stops its transitive dependents; if that closure
contains a required service, the app fails and stops as a unit.

An isolated VM crash is treated as simultaneous failure of the leaves placed
there. The host restarts that VM once and asks its supervisor to reconcile the
app's desired state. If reconciliation fails, normal required/optional rules
apply. A pooled VM crash marks every shared app `recovering`, restarts the pool,
then reconciles each app independently; one app's failed reconciliation does
not prevent others from returning to `running`.

### Stop as a unit

`runtime stop <app>` first marks desired state `stopped`, preventing restart
policy from racing the stop. The supervisor stops leaves in reverse dependency
order, sends SIGTERM, waits 10 seconds, then SIGKILLs survivors. Container stop
uses the equivalent containerd task signals. It unmounts ephemeral mounts and
removes service namespaces only after processes are gone.

Stop is scoped to the top-level app. The pooled VM remains running while any
app uses it and may be idled or stopped later by the runtime's pool policy.
Stopping a top-level app also stops its dedicated isolation VMs; persistent
data and installed payloads remain.

## `isolation: vm` networking

Every runtime VM uses `VmSpec.netLink: "netstack"`. NAT is not acceptable for
the runtime because RFC 0002's host-enforced controls and the private cross-VM
router require the host to own every flow.

For each named port on an isolated target, the runtime reserves a stable entry
in that VM's `VmSpec.published` registry. The host side is loopback-only and
connects to the target guest with today's `Netstack::connect(guest_port)` /
`spawn_proxy_netstack` path. NAT backends may use `spawn_proxy` until they gain
netstack support, but may not claim control enforcement parity.

The source VM never connects to that host loopback listener directly. Its DNS
netstack synthesizes an address for
`<service>.<app>.appliance.internal`; an internal-route table then rewrites a
connection for that address and named service port to the target's loopback
relay. The relay pumps bytes into the destination VM's netstack. For a target
in the pooled VM, the last leg is the same inbound netstack connection to the
service's stable guest-loopback proxy.

This route is symmetric: VM-B reaches a service in VM-A through the same
synthetic name -> source-netstack -> host relay -> target-netstack sequence.
The existing netstack therefore remains the only VM boundary, while
`VmSpec.published` becomes the persistent allocation record already anticipated
by `spec.rs`.

Internal DNS answers are generated only from the verified app graph, are never
forwarded upstream, and cannot be added by app-controlled DNS. Relays bind only
to host loopback and accept only netstack-originated connections tagged with
the same top-level app. Internal routes bypass public egress allowlists but may
reach only declared service ports in their own compound app.

Apps see a stable private URL, never host or peer-guest addresses. Undeclared
ports, cross-app names, UDP, broadcast, and direct guest-IP routes are denied.

## Service discovery

The runtime injects `APPLIANCE_SVC_<NAME>_URL` into every service that may call
the named service; DNS-safe hyphens become underscores and letters uppercase.
For example, `search-api` becomes `APPLIANCE_SVC_SEARCH_API_URL`.

For services in the same VM, the value is
`http://127.0.0.1:<stable-runtime-port>`. The supervisor persists one loopback
port per app/service and proxies it into the target's network namespace and
declared primary port. Runtime allocation avoids collisions between apps whose
containers both listen on `3000`; stability across restarts keeps configs and
connection pools predictable.

For a cross-VM target, the value is
`http://<service>.<app>.appliance.internal:<declared-port>`. Named non-primary
ports additionally use `APPLIANCE_SVC_<NAME>_<PORT_NAME>_URL`. Workers without
ports receive no URL. Explicit manifest env wins for unrelated keys, but the
reserved `APPLIANCE_SVC_` prefix cannot be authored or overridden.

This is preferable to container DNS because it works for binaries, hides the
containerd network, and makes cross-VM placement an app-transparent detail.

## Controls composition

Controls compose as a per-service policy map, never as one enforceable union
for the pooled VM. The installer may display the union of requested egress
hosts and mount slots as a top-level consent summary, but it stores the grant
against each fully qualified service path.

Each leaf's effective egress list is its own declaration; omission means deny.
The supervisor already creates a network namespace and veth identity per leaf,
so RFC 0002 can cheaply key host-netstack policy by source identity. An
isolated sub-appliance gets the same map, enforced at its VM netstack. If a
platform cannot preserve source identity, it must reject mixed-policy shared
placement rather than widen to the union.

Mounts are materialized only in the declaring leaf's mount namespace. A volume
or user-granted host slot requested by one service is not visible to siblings.
Consent UI may group requests, but grants remain service bindings and upgrades
never silently widen them. Structural sub-appliances have no ambient authority.

Credential injection: deferred (owner, 2026-08-27).

## Observability

`appliance runtime ps` prints one top-level row with a `2 services`-style badge,
then indented leaf rows. The app row reports aggregate state, UI URL, pooled VM,
and uptime; each leaf reports state, required/optional, health, restart count,
placement (`shared` or `vm`), VM name, and internal endpoint.

Aggregate states are `starting`, `running`, `degraded`, `recovering`, `failed`,
`stopping`, and `stopped`. JSON output returns the graph rather than terminal
indentation and includes stable app/service IDs.

`appliance runtime logs notes-suite` merges lifecycle events and leaf output by
timestamp with `[notes-suite/web]` prefixes. `--service`, `--since`, `--tail`,
and `--follow` filter the host-fanned supervisor streams across all VMs.

## Upgrades and data

A publisher replaces one sub-appliance by shipping a newly signed top-level
bundle whose nested `version` and payload digest changed. The runtime never
accepts an unsigned loose nested payload. It verifies and stages the whole
bundle, then computes the changed service and reverse-dependent closure.

An in-place upgrade stops that closure in reverse dependency order, switches
content-addressed payload pointers, and restarts it. Independent services keep
running. Failed health restores old payloads; data is not rolled back, so
migrations must be backward-safe.

Persistent data keys use logical paths, never versions or VM names:
`/persist/apps/<app>/<structural-path>/<service>/data`. Shared services receive
only their directory in their mount namespace. Isolated VM disks use the same
logical path and are retained across VM recreation or a change back to shared
placement. Removing a service retains data until explicit
`runtime uninstall --purge-data` confirmation.

## Worked 2-level example

`notes-suite.appliance.zip` contains this `appliance.json` plus the referenced
payloads. `search` is the first-level isolated sub-appliance; `web` and
`indexer` are the two runnable leaves, so the app is within both limits.

```json
{
  "manifest": "v2",
  "type": "compound",
  "name": "notes-suite",
  "version": "2.0.0",
  "license": "AGPL-3.0-only",
  "ui": { "type": "web", "service": "web" },
  "services": [
    {
      "name": "frontend",
      "type": "compound",
      "services": [
        {
          "name": "web",
          "type": "container",
          "version": "2.0.0",
          "payload": { "image": "payload/web/image.oci.tar" },
          "ports": [{ "name": "http", "guest": 3000, "primary": true }],
          "dependsOn": ["indexer"],
          "health": { "type": "http", "port": "http", "path": "/healthz" },
          "restart": { "policy": "on-failure", "maxAttempts": 5 },
          "required": true,
          "egress": { "allow": ["fonts.gstatic.com"] }
        }
      ]
    },
    {
      "name": "search",
      "type": "compound",
      "version": "4.1.0",
      "isolation": "vm",
      "services": [
        {
          "name": "indexer",
          "type": "binary",
          "version": "4.1.0",
          "payload": {
            "entrypoint": "payload/indexer/linux-arm64/indexer",
            "args": ["serve"]
          },
          "ports": [{ "name": "api", "guest": 9000, "primary": true }],
          "dependsOn": [],
          "health": { "type": "tcp", "port": "api" },
          "restart": { "policy": "always" },
          "required": true,
          "mounts": [{ "name": "index", "guest": "/data", "kind": "volume" }],
          "egress": { "allow": [] }
        }
      ]
    }
  ]
}
```

`web` receives
`APPLIANCE_SVC_INDEXER_URL=http://indexer.notes-suite.appliance.internal:9000`.
The binary runs namespaced and unprivileged in the `search` VM with only its
volume and declared port.

## Existing stacks: reuse and retire

Reuse `dnsName` validation, early duplicate detection, deterministic env
injection, combined status, fail-fast start summaries, and best-effort unit
teardown patterns from `packages/sdk/src/models/stack.ts`,
`packages/cli/src/utils/stack.ts`, and `packages/cli/src/appliance-stack.ts`.

Do not reuse array-order deployment, directory references, project/environment
creation, `{{service:...}}` interpolation, or cloud API fan-out. A stack remains
a client-side collection of independently owned source projects. Retire stacks
as the recommended way to package or run a coupled service graph; compound
apps own signing, lifecycle, isolation, upgrades, and data as one runtime unit.

## Engine/CLI changes required

- `packages/sdk/src/models/appliance.ts` — let RFC 0001 add `compound` and these graph/lifecycle fields.
- `packages/cli/src/utils/common.ts` — detect v2 runtime content while retaining `appliance.json`.
- `packages/cli/src/appliance-runtime.ts` — add runtime lifecycle, graph status, logs, and upgrades.
- `packages/cli/src/utils/microvm-up.ts` — manage the core-only pool and isolation VMs.
- `packages/vm/src/spec.rs` — add a runtime role, placement, and internal published ports.
- `packages/vm/src/guest.rs` — install and boot the runtime supervisor in core-only media.
- `packages/vm/src/guest_exec.rs` — delegate structured lifecycle RPC to a framed vsock client.
- `packages/vm/src/netstack/engine.rs` — route tagged internal flows before ordinary egress.
- `packages/vm/src/netstack/dns.rs` — synthesize authorized `.appliance.internal` records.
- `packages/vm/src/net.rs` — generalize proxies into tagged, loopback-only VM relays.
- `packages/cli/src/utils/stack.ts` and `packages/cli/src/appliance-stack.ts` — redirect packaged-composition guidance.
- `ARCHITECTURE.md` and `docs/stacks.md` — document the pool, isolation VMs, and stack boundary.

## Open for owner

1. **Pool sizing:** default to 2 vCPU / 4 GiB and reject over-admission; resizing requires explicit operator action.
2. **Restart jitter:** default to deterministic exponential backoff; add jitter only if restart storms appear.
3. **Exec health:** default to allow safe argv execution inside service namespaces; omit if it delays v1.
4. **Partial upgrades:** default to require a complete, newly signed top-level bundle.
5. **Non-UI public ports:** default to internal-only until RFC 0001 defines explicit public grants.
6. **Data cleanup:** default to explicit `runtime uninstall --purge-data`; never age data out automatically.
