# RFC 0003: Compound apps and isolation

- Status: proposed
- Date: 2026-08-27
- Claim: `ap-p0-compound-c51d08`
- Owners: Appliance Runtime
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

The pooled VM is separate from the existing development/deploy VM. It has no
workspace mount, k3s, BuildKit, or Docker daemon. This prevents packaged,
untrusted apps from sharing the developer workspace or control plane while
still amortizing a VM across packaged apps. The default pool name is
`appliance-runtime`; isolated VM names derive from app and sub-appliance
identity but are not a stable public interface.

Inside a VM, a small Appliance runtime supervisor manages both OCI containers
through containerd and arbitrary Linux binaries as unprivileged, namespaced
processes. It evaluates the dependency graph, runs health checks, applies
restart policy, reports state and logs, and stops each top-level app as a unit.
An app failure never deliberately stops another app in the pool, though a pool
VM failure is necessarily a shared failure domain.

The graph is deliberately bounded:

- At most two runnable levels: top-level app -> sub-appliance -> service.
- At most 16 runnable leaf services across one top-level app.
- Validation rejects deeper or larger graphs before extracting payloads or
  starting a VM.

Shared-VM discovery uses stable loopback ports allocated per service and
injected as `APPLIANCE_SVC_<NAME>_URL`. Cross-VM discovery uses runtime-owned
`.appliance.internal` names and a host-only relay built on the existing
netstack and published-port forwarding. No internal service is exposed on a
host LAN interface or counted as public egress.

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

type ServiceHealth =
  | {
      type: 'http';
      port: string;
      path: string;
      intervalSeconds?: number; // default 5
      timeoutSeconds?: number; // default 2
      failureThreshold?: number; // default 3
    }
  | {
      type: 'tcp';
      port: string;
      intervalSeconds?: number; // default 5
      timeoutSeconds?: number; // default 2
      failureThreshold?: number; // default 3
    }
  | {
      type: 'exec';
      command: string[];
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

`restart.maxAttempts` is ignored when `policy: "always"` is used for an
operator-requested stop: an explicit stop always wins. A process that remains
healthy for 60 seconds clears its rolling failure count.

### Isolation field

First-level entries in the top-level `services[]` add:

```ts
interface ServiceIsolationFields {
  isolation?: 'shared' | 'vm'; // default shared
}
```

Only a first-level entry may set `isolation`. A structural sub-appliance passes
its selected topology to every leaf below it. A direct first-level runnable
leaf applies the topology to itself. A second-level service declaring
`isolation` is invalid, because allowing it would make placement ambiguous and
would turn the structural parent into a second scheduler.

`isolation: "vm"` means a dedicated VM for that first-level entry, not one VM
per descendant. Multiple `isolation: "vm"` entries get distinct VMs. Omission
means the pooled runtime VM, even when other top-level apps are already running
there.

### Service identity

Every service and structural sub-appliance name uses RFC 0001's DNS-safe name
schema. Runnable leaf names must be unique across the whole top-level app, not
just within a structural parent. This makes dependency references, CLI
selectors, log prefixes, and `APPLIANCE_SVC_<NAME>_URL` unambiguous.

Structural names need only be unique among siblings. The stable storage and
diagnostic identity is the slash-separated path, for example
`notes-suite/search/indexer`. The public graph identity of a runnable leaf is
still its globally unique leaf name.

Credential injection: deferred (owner, 2026-08-27).

## Validation rules

Validation is deterministic and completes before payload extraction, VM
creation, mount grants, or network listeners. The runtime reports every graph
error it can find in one pass.

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

Do not use systemd units: the guest is Alpine/OpenRC, and introducing systemd
would replace the existing boot model merely to obtain dynamic units. Do not
use Docker Compose: runtime container payloads use containerd, Compose does not
supervise arbitrary binary payloads, and it cannot express the required
cross-VM graph. Do not extend the current shell respawn loop: it has no durable
graph state, health model, bounded backoff, per-service identity, or structured
status API.

The supervisor is a single, intentionally small guest binary. It accepts a
validated, flattened execution plan over a host-owned vsock control channel;
persists only runtime state beneath `/persist/runtime/`; starts containers via
containerd and binaries via `clone`/namespace setup; captures stdout/stderr;
and returns structured events and status. `guest_exec.rs` remains useful for
bootstrap and diagnostics, but long-lived lifecycle RPC must not be encoded as
shell command strings.

Each top-level app has one supervisor namespace. Stop, restart, log selection,
and desired state operate on that namespace even though the process shares a
VM with other apps.

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

Start order is therefore dependency-declared, deterministic at graph edges,
and parallel where the graph permits it. Manifest array order only breaks ties
in logs and status output.

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
