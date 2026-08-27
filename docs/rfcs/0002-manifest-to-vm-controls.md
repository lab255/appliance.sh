# RFC 0002: Manifest to VM controls contract

- Status: proposed
- Date: 2026-08-27
- Owners: Appliance Runtime
- Claim: `ap-p0-controls-2b9e44`
- Depends on: RFC 0001 for manifest field shapes

## Summary

This RFC defines how the Appliance Runtime translates the controls requested
by a runnable bundle's root `appliance.json` into host-enforced runtime state.
RFC 0001 owns JSON shapes; this RFC owns semantics, defaults, override limits,
and the mapping to the current microVM engine.

The default topology is one pooled Linux microVM, `appliance-runtime`, for all
apps and all services whose isolation is `shared`. A sub-appliance declaring
`isolation: vm` receives a dedicated Linux microVM. The manifest does not size
either VM. App resource requests become cgroup and storage-quota hints inside
the selected VM.

The security posture is deny by default:

- no `network.egress` means no off-VM egress;
- no mount declarations means no host-path mounts;
- no port declarations means no host-published ports;
- an app may receive only a subset of what its manifest declares; and
- a user override cannot silently widen the publisher-declared ceiling.

TLS interception is a user/runtime control, not a manifest entitlement. It is
on by default in inspection-only mode for allowed HTTPS destinations. It may
observe and log, but must not inject, remove, or rewrite application headers or
bodies. A publisher cannot disable inspection; a user can disable it globally
or per app.

credential injection: deferred (owner, 2026-08-27).

The backend is always Linux. If RFC 0001 later selects a native macOS binary
escape hatch, none of the controls in this RFC apply to that process. The run
and install warning must say: `Runs outside the Linux VM; Appliance egress,
mount, port, and resource controls do not apply.`

## Topology

### Pooled runtime VM

There is exactly one default pool named `appliance-runtime`. Installing or
running a second ordinary app does not create another VM. Compound services
with absent or `shared` isolation join the same pool.

The target pooled `VmSpec` is core-only:

- `agent_only = true`;
- `cluster = false`, so no k3s, Kubernetes API, registry, or BuildKit;
- `docker = false`; a small runtime supervisor owns containerd/process launch;
- `dev = false`; no development workspace or toolchain is provisioned;
- `net_link = Netstack`, so the host userspace netstack is the only off-VM
  network path; and
- the image is a pinned Appliance Runtime Linux image, not a payload target.

The current engine enforces `agent_only implies dev`. The Runtime must split
"core agent/supervisor ready" from "development toolchain ready" so this pool
can be `agent_only = true, dev = false`. Until that change exists, the Runtime
must not pretend that a normal dev VM is the production pool contract.

Initial pool sizing uses the current conservative VM defaults: 2 vCPUs,
4096 MiB memory, and a 10 GiB sparse data disk. This is host configuration,
not a reduction or sum of manifest `resources`.

The default growth policy is:

1. CPU/memory tiers are 2/4 GiB, 4/8 GiB, then 8/16 GiB.
2. Sustained cgroup pressure for 60 seconds marks the next tier recommended.
3. A tier change occurs automatically only while no app is running; otherwise
   `runtime ps` reports `pool resize pending` and the next clean restart grows
   it.
4. CPU is capped at `max(2, min(8, host CPUs - 2))`; memory is capped at the
   lower of 16 GiB or 50% of host RAM.
5. The sparse disk grows by 10 GiB when free space falls below 20%, only when
   at least 20 GiB remains free on the host, and never beyond 100 GiB without
   an explicit user override.
6. The pool never shrinks automatically. App data remains subject to its own
   quota even when the pool disk grows.

NOTE: these sizing caps are a sane default because no owner sizing profile was
given. They are called out in Open for owner.

### Dedicated sub-appliance VM

A sub-appliance with `isolation: vm` gets a VM named from a collision-resistant
slug, for example `appliance-runtime-notes-suite-indexer-7e0c`. It uses the
same core-only fixed `VmSpec` profile and growth rules as the pool. Its app
resource hints still become a cgroup inside the VM; they do not size the VM.

The manifest's `vm` isolation is a locked minimum. A user may strengthen a
`shared` app or service to a dedicated VM, but may not weaken `vm` to `shared`.

### Per-app enforcement inside the pool

The unit of policy is a control principal: `<app>` for a simple app and
`<app>/<service>` for a compound service. Every principal receives:

- a stable, unprivileged Linux UID/GID;
- a cgroup v2 subtree;
- a mount namespace;
- a network namespace with a stable private source address; and
- a supervisor-owned process/container lifecycle.

The app receives no `CAP_NET_ADMIN`, `CAP_NET_RAW`, device access, host PID
namespace, or user-controlled privileged container flags. User namespaces are
not used as a substitute for the VM boundary.

The guest root namespace connects each app network namespace with a veth pair.
It routes the app subnet to the VM NIC without source NAT. An nftables rule at
each veth ingress requires the assigned `/32` source address and rejects
spoofed or unknown sources. Inter-app traffic is denied by default. Compound
siblings may reach only the target service ports declared `internal`.

The host netstack carries an atomically updated mapping of
`(vm id, source address) -> control principal`. DHCP/DNS and every terminated
TCP flow are resolved through that mapping before policy evaluation. Unknown
or stale source addresses fail closed. This source address is the attribution
token used by the host egress proxy; `SO_MARK` is not used because skb marks do
not cross the virtio boundary.

The current netstack already sees the source address in DNS and TCP frames,
but discards it when it calls the VM-scoped policy guard. The implementation
must retain it through `Flow`, DNS dispatch, policy selection, logging, and
inbound routing.

Namespace isolation is not a second VM boundary. A guest-kernel compromise
can defeat UID, namespace, cgroup, and source-address anti-spoofing controls.
Apps needing that threat model must use `isolation: vm` (or a user-selected
stronger override). The host netstack still protects the host from arbitrary
off-VM destinations, but a compromised pooled guest could impersonate another
pool principal's allowlist.

## Mapping table

Paths in the source column are semantic references to RFC 0001's
`appliance.json`; this RFC does not redefine their JSON shapes.

### `VmSpec`

| Engine field    | Source                                 | Effective value / mapping                                                                                                             |
| --------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `name`          | topology, not manifest `name` directly | Fixed `appliance-runtime` for the pool; generated stable slug for `isolation: vm`.                                                    |
| `cpus`          | host runtime profile                   | 2 initially; pool growth tiers above. Never from `resources.cpus`.                                                                    |
| `memory_mib`    | host runtime profile                   | 4096 initially; pool growth tiers above. Never from `resources.memoryMib`.                                                            |
| `disk_gib`      | host runtime profile                   | 10 initially; sparse growth policy above. Never from `resources.diskGib`.                                                             |
| `image`         | fixed runtime release                  | Pinned Linux runtime kernel/initramfs image. `payload.targets` selects app payload only.                                              |
| `cmdline`       | fixed runtime release                  | Engine-generated runtime guest command line; n/a to manifest.                                                                         |
| `mac`           | engine allocation                      | Random locally administered unicast MAC persisted at VM creation.                                                                     |
| `host_port`     | host allocation                        | Pool ingress/router listener, default 8081 if free; not an app port grant.                                                            |
| `api_port`      | fixed required slot                    | Allocated with the VM port block but no listener because `cluster = false`; n/a to manifest.                                          |
| `registry_port` | fixed required slot                    | Allocated but unused; packaged payloads do not gain a host registry.                                                                  |
| `egress_port`   | host allocation                        | Pool netstack/control endpoint; app attribution is by namespace source address, not this single field.                                |
| `buildkit_port` | fixed required slot                    | Allocated but unused; runtime execution performs no build.                                                                            |
| `dev`           | fixed                                  | `false`; requires removal of the current `agent_only implies dev` invariant.                                                          |
| `dev_mount`     | fixed                                  | `None`; it is a legacy single workspace mount and cannot represent app grants.                                                        |
| `docker`        | fixed                                  | `false`; app containers use the runtime supervisor/containerd, not dockerd.                                                           |
| `agent_only`    | fixed                                  | `true`; interpreted as core supervisor-only readiness.                                                                                |
| `cluster`       | fixed                                  | `false`; no k3s or platform layer.                                                                                                    |
| `published`     | granted `ports[]`                      | Aggregate of granted public ports. Current `PublishedPort` must gain principal/target identity for duplicate guest ports in the pool. |
| `net_link`      | fixed security control                 | `Netstack`; neither manifest nor ordinary run flags may downgrade it to `Nat`.                                                        |

### `PublishedPort`, app mounts, policy, and resources

| Engine/effective field         | Manifest source                         | Effective value / mapping                                                                                                                           |
| ------------------------------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PublishedPort.host`           | no manifest authority                   | Stable host port allocated from 20000-29999, or an explicit user-selected free port.                                                                |
| `PublishedPort.container`      | `ports[].guest`                         | Declared guest TCP port; rename/generalize to `guest` while retaining serde compatibility.                                                          |
| new published principal        | installed app/service identity          | Required target principal and namespace address; synthesized, never publisher-controlled.                                                           |
| `ports[].name`                 | `ports[].name`                          | Stable display/routing key within its principal.                                                                                                    |
| `ports[].primary`              | `ports[].primary`                       | Selects UI/open behavior; grants no additional reachability.                                                                                        |
| `ports[].expose`               | `ports[].expose`                        | `public` creates a host listener; `internal` permits only declared compound siblings; a declared port defaults to `public` when exposure is absent. |
| port protocol                  | `ports[].protocol` if present           | TCP only in this runtime version; an unsupported declaration fails validation rather than widening.                                                 |
| mount slot id                  | `mounts[].name`                         | Required stable name, unique within the principal; used in grants and mount tags.                                                                   |
| guest mount point              | `mounts[].guest`                        | Manifest-locked absolute guest path. It must not shadow `/proc`, `/sys`, `/dev`, runtime control paths, payload, or another slot.                   |
| suggested host path            | `mounts[].suggestedDefault`             | Display-only suggestion. It is never opened, resolved, or mounted before user confirmation/edit.                                                    |
| confirmed host path            | user grant                              | Canonical host path/bookmark persisted in `effective.json`; no manifest value can grant it.                                                         |
| mount write mode               | `mounts[].rw` plus user grant           | Read-only by default. `rw: true` is only a request; user must grant write. User may downgrade to read-only.                                         |
| `EgressPolicy.default`         | runtime fixed                           | `Deny` for every runtime principal, including when `network.egress` is absent.                                                                      |
| `EgressPolicy.allow`           | granted subset of `network.egress`      | Normalized granted hostname suffixes only; no baked agent/dev allowlist in an app policy.                                                           |
| `EgressPolicy.deny`            | user revocations / runtime safety rules | Explicit revocations and host safety blocks; deny wins. The publisher cannot remove these.                                                          |
| `EgressPolicy.mitm`            | user/global runtime setting             | `true` by default in inspection-only mode; never sourced from the manifest.                                                                         |
| `CredentialRule` (entire type) | n/a                                     | Out of scope; no `appliance.json` key or composition in this RFC. Existing VM broker remains untouched.                                             |
| cgroup `cpu.max`               | `resources.cpus`                        | Per-principal ceiling hint; absent default is 1 CPU; user/host may lower or raise within host policy.                                               |
| cgroup `memory.max`            | `resources.memoryMib`                   | Per-principal ceiling hint; absent default 512 MiB; `memory.high` is 90% and OOM is grouped per principal.                                          |
| app storage quota              | `resources.diskGib`                     | Per-principal writable-data quota; absent default 2 GiB; never maps to `VmSpec.disk_gib`.                                                           |
| cgroup `pids.max`              | fixed runtime control                   | 256 per principal by default; n/a to manifest in v2.                                                                                                |

## Defaults when absent

| Manifest input absent              | Effective behavior                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| `network.egress`                   | `default = Deny`, empty allowlist: no off-VM destination.                      |
| `network.egress` present but empty | Identical to absent: deny all.                                                 |
| mounts                             | No host paths or persistent app volumes are mounted.                           |
| `mounts[].rw`                      | Read-only.                                                                     |
| ports                              | No public host listener and no compound sibling listener.                      |
| `resources.cpus`                   | 1 CPU cgroup ceiling.                                                          |
| `resources.memoryMib`              | 512 MiB cgroup ceiling.                                                        |
| `resources.diskGib`                | 2 GiB writable-data quota.                                                     |
| service `isolation`                | `shared`, meaning its control principal runs in the pooled VM.                 |
| user inspection setting            | Inspection on, inherited from the global default.                              |
| effective policy file              | Fail closed; the app does not start until policy is regenerated or re-granted. |

Absence never inherits the current development VM's
`NETSTACK_ALLOWLIST`. Package registries, Git hosts, model APIs, and image
registries are allowed only when declared and granted for that app. Runtime
bootstrap traffic is host/supervisor traffic and is not charged to an app
principal.

## Egress and TLS inspection

### Allowlist semantics

Each `network.egress` entry is a DNS hostname suffix. The Runtime lowercases,
IDNA-normalizes, removes a trailing dot, and rejects schemes, paths, userinfo,
ports, empty labels, and public-suffix-only entries. `example.com` matches
`example.com` and `api.example.com`, but not `badexample.com`. A leading `*.`
is normalized to the same suffix behavior rather than treated as a regex.

DNS for an app is answered by the host netstack in that app's policy context.
Denied names fail fast. Allowed names are host-resolved, but private,
loopback, link-local, host-LAN, multicast, and reserved answers are rejected.
For TCP/443 the netstack classifies SNI; for TCP/80 it classifies `Host`.
Missing or malformed classification fails closed. Non-DNS UDP, ICMP, QUIC,
raw IP, and arbitrary protocols are denied in v2.

The current `netstack_policy()` always merges `NETSTACK_ALLOWLIST`; that is
correct for agent/dev VMs and wrong for packaged apps. Runtime policy lookup
must accept a policy context and skip the baked list for app principals.

### Inspection mode

Inspection is enabled for allowed HTTPS by default. The host reuses the CA and
leaf-minting primitives in `mitm.rs`, but keys CA material by control principal
and exposes only that principal's CA in its mount namespace. If inspection
material cannot be created or trusted, the allowed TLS flow fails closed with
an actionable error; it must not silently become a blind tunnel.

Inspection-only means the proxy may terminate and re-originate TLS and parse
protocol metadata, but forwards application bytes without adding, deleting,
or changing headers, query parameters, body bytes, or response bytes. The
existing `force_connection_close`, capture, and injection path is not suitable
for this mode and must be split from a non-mutating observer. HTTP/1.1 and h2
must preserve streaming behavior.

Each principal writes a bounded host-side log at
`~/.appliance/runtime/<app>/egress-events.jsonl`; compound service records carry
the service id. The default cap is 512 KiB, retaining the newest complete JSONL
records, matching today's `traffic.rs` bound.

An inspection record contains:

- timestamp, app id, and optional service id;
- allow/deny/inspect decision and reason;
- normalized host, destination port, transport, TLS version, and SNI;
- HTTP method and path with query and fragment removed;
- response status, byte counts, and duration when observable; and
- no headers, cookies, authorization data, query values, or body content.

When the user disables inspection, destination enforcement remains on and the
log contains connection metadata only: timestamp, principal, decision, host,
port, and transport. Disabling logging separately is not part of this RFC.

## Mounts

Multiple host-path mount slots are supported. A suggestion in
`appliance.json` is UX text, not authority. At install/grant time, the CLI or
Desktop shows every named slot, its guest destination, suggested default, and
requested access. The user must confirm or edit every host path independently.
Refused slots remain absent.

The host canonicalizes the selected path after consent and persists a stable
platform identity/bookmark where available. It revalidates identity before
each start so a symlink replacement cannot silently redirect a grant.

The VM backend exports each confirmed path as a separately tagged VirtioFS
share. Guest root mounts shares under a supervisor-only staging directory,
then bind-mounts only that app's tags into its mount namespace at the locked
guest paths. Apps cannot enumerate the staging directory or another app's
shares. Read-only is enforced at both the VirtioFS export and bind mount;
`rw: true` takes effect only after an explicit write grant.

`VmSpec.dev_mount` stays `None`: its single `/persist/workspace` contract would
make a host tree visible VM-wide and cannot safely represent multiple apps.
The engine needs a separate multi-share runtime structure.

## Ports

Only declared and granted ports are reachable outside an app network
namespace. The runtime rejects duplicate names and ambiguous multiple
primaries within one principal.

For each public TCP port, the host allocates the lowest free port in
20000-29999 unless the user requests a specific free port. The allocation is
stable across restarts and persisted in `effective.json`. Listeners bind
`127.0.0.1` and `::1` by default. A non-loopback bind is an explicit user
override with a warning; it is never publisher-selected.

`VmSpec.published` remains the boot-time aggregate, but `PublishedPort` must
identify the control principal and app namespace target. The current pair of
`host` and `container` is insufficient because two pooled apps may both
declare port 3000. The inbound netstack connects to the selected app source
address and guest port, not the VM root address.

Primary web ports may additionally share the pool's HTTP front door at 8081,
routed by `<app>.appliance.localhost`. The named route and the raw allocated
port both target the same declared principal/guest port; the router cannot
create a route to an undeclared port.

An `internal` port creates no host listener. Guest nftables permits it only
from declared compound sibling principals. Unrelated apps in the pool cannot
connect to it, even if they guess its namespace address.

## Resources

Manifest resources are scheduling hints and per-app ceilings, never VM sizing.
The Runtime creates `/sys/fs/cgroup/appliance/<principal>` and launches the
entire app process/container tree in it. A compound app gets a parent cgroup
and one child per service so both aggregate and service observations work.

CPU maps to `cpu.max` with a 100 ms period. Memory maps to `memory.max`, with
`memory.high` at 90% and `memory.oom.group = 1`. PIDs default to 256. Writable
app data uses a project quota, so `resources.diskGib` does not grow the shared
VM disk or consume another app's allowance.

Hints do not reserve capacity. If a requested or user-raised ceiling exceeds
host policy, install shows the clamp before grant. OOM, CPU throttling, PID
limit, and quota events are attributed to the principal and surfaced by
`runtime ps`; they do not resize the VM directly.

## User overrides and effective policy

The manifest is the maximum publisher-requested capability. Effective policy
is the intersection of that ceiling, runtime safety rules, and user grants.

Users may:

- revoke any egress host, port, or mount;
- disable TLS inspection globally or per app;
- choose/edit a mount's host path and downgrade requested write access to
  read-only;
- select a free host port or explicit bind address for a declared public port;
- lower or raise cgroup/storage limits within host policy; and
- strengthen `shared` isolation to `vm`.

Users may not through ordinary install/run controls:

- add an egress destination absent from `network.egress`;
- publish an undeclared guest port or turn an internal port public;
- add an undeclared mount slot, change its guest destination, or upgrade a
  read-only declaration to writable;
- disable source attribution, the host netstack, private-range rejection, or
  deny-by-default; or
- weaken `isolation: vm` to `shared`.

The Runtime persists the complete resolved state at
`~/.appliance/runtime/<app>/effective.json`, mode 0600, using atomic
write-and-rename. It contains no secrets. At minimum it records:

```json
{
  "version": 1,
  "app": "journal",
  "manifestDigest": "sha256:...",
  "topology": { "vm": "appliance-runtime", "principals": {} },
  "requested": { "egress": [], "mounts": [], "ports": [], "resources": {} },
  "effective": { "egress": {}, "mounts": [], "ports": [], "resources": {} },
  "overrides": { "inspection": "inherit", "isolation": {} },
  "updatedAt": "2026-08-27T00:00:00Z"
}
```

The persisted object is the source of truth for display and restart; generated
`VmSpec`, nftables, cgroups, VirtioFS shares, and `EgressPolicy` are derived
artifacts. Missing, invalid, or digest-mismatched state fails closed.

On upgrade, existing grants are intersected with the new manifest. Removed
capabilities disappear immediately. Unchanged capabilities retain grants. New
or widened capabilities remain denied until the user approves the delta; an
upgrade never silently widens effective policy.

Override precedence is: non-overridable runtime safety rules, then manifest
ceiling, then per-app user choice, then global user default. The one deliberate
exception is inspection: per-app choice overrides the global setting because
the manifest has no authority over it.

## What the user sees

Install/run shows requested versus effective controls before launch, including
every denied or clamped item and the selected pool/dedicated topology.

`appliance runtime ps` reports principals, not one misleading row per VM:

```text
APP             STATE    ISOLATION  PORTS                                   EGRESS                    RESOURCES
journal         running  pool      http: 127.0.0.1:20000 -> 3000/tcp       2 hosts, inspect on        1 CPU / 512 MiB
notes-suite/web running  pool      web: internal 3000/tcp                  1 host, inspect on         1 CPU / 512 MiB
notes-suite/idx running  vm        grpc: internal 9000/tcp                 blocked, inspect on        2 CPU / 2 GiB
```

For duplicate guest ports, each row shows its distinct host allocation and
principal. `--json` includes VM name, principal id, guest namespace address,
port name, bind address, host port, guest port, and exposure.

The Desktop status strip uses the mock's compact wording:

- `egress: 2 hosts allowed`;
- `egress: blocked` when the effective allowlist is empty;
- `inspection: on` or `inspection: off (user)`; and
- `ports: 2 published · mounts: 1 ro, 1 rw`.

Selecting the strip opens requested/effective/source details plus the per-app
egress log. A dedicated service displays `isolated VM`; pooled rows display
`shared runtime`. If a pool resize is pending, both CLI and Desktop say so
without presenting app resource hints as VM size.

## Engine changes required

- `packages/vm/src/spec.rs` — add runtime-target identity to published ports,
  a multi-share runtime mount structure, and a core-only readiness profile
  that permits `agent_only = true, dev = false`.
- `packages/vm/src/store.rs` — add runtime principal/state lookup without
  changing existing per-VM dev/agent policy files.
- `packages/vm/src/guest.rs` — add the runtime supervisor bootstrap for stable
  users, network/mount namespaces, cgroup v2, nftables, app payloads, and
  per-principal CA trust.
- `packages/vm/src/backend/vz/mod.rs` — attach multiple tagged VirtioFS shares
  and preserve routed app-subnet frames on the single Netstack NIC.
- `packages/vm/src/backend/kvm.rs` — provide equivalent multi-share and routed
  app-subnet behavior for the Linux/KVM backend.
- `packages/vm/src/netstack/engine.rs` — retain source address on TCP/DNS flows,
  fail closed on unknown principals, and route inbound published ports to an
  app namespace address.
- `packages/vm/src/netstack/guard.rs` — select an app-scoped `EgressPolicy`,
  omit `NETSTACK_ALLOWLIST` for runtime principals, and pass principal identity
  through allow/deny/inspection logging.
- `packages/vm/src/netstack/dns.rs` — evaluate and record DNS per source
  principal while retaining private/internal/host-LAN answer rejection.
- `packages/vm/src/egress.rs` — separate VM policy storage from app policy
  contexts and expose inspection-only forwarding without credential hooks.
- `packages/vm/src/mitm.rs` — add non-mutating HTTP/1.1 and h2 observation that
  preserves streaming and keys CA material per control principal.
- `packages/vm/src/traffic.rs` — move runtime events to per-app logs and extend
  records with principal, reason, redacted path, status, bytes, and duration.
- `packages/vm/src/net.rs` — forward a published host listener to a selected
  principal address/guest port instead of the VM's single guest address.
- `packages/vm/src/main.rs` — add runtime pool lifecycle/control commands while
  leaving existing `vm egress` and credential broker behavior untouched.
- `packages/cli/src/utils/microvm-up.ts` — create/reconcile the fixed pooled VM
  profile without k3s, Docker, or development-toolchain readiness.
- `packages/cli/src/appliance-vm.ts` — expose structured runtime-principal
  status and target-aware published-port/mount operations to the outer CLI.
- `packages/cli/src/appliance-runtime.ts` (new) — implement install/run/ps grant
  flows, `effective.json`, upgrade intersection, and user-visible policy.
- `packages/cli/src/appliance.ts` — register the `runtime` namespace without
  changing builder/deploy behavior.
- `packages/desktop/src-tauri/src/lib.rs` — expose runtime app policy, per-app
  traffic, grants, and pool status rather than only VM-scoped egress controls.
- `packages/app/src/pages/local-runtime/index.tsx` — render the status strip,
  requested/effective controls, grant editing, and per-principal traffic view.

No change to `packages/vm/src/creds.rs` is part of these tasks.

## Open for owner

1. **Pool growth caps.** Default: use the 2/4, 4/8, 8/16 tiers, 50% host
   memory cap, and 100 GiB disk cap specified above.
2. **Automatic stronger isolation.** Default: honor `shared` for both binaries
   and containers; warn that namespaces are not a VM boundary, but do not
   silently promote binaries to `vm`.
3. **Host mount identity across platforms.** Default: persist a security-scoped
   bookmark on macOS and canonical path plus device/inode on Linux; re-prompt
   when identity cannot be proven.
4. **Non-loopback published ports.** Default: allow only through an explicit
   user override on each grant, with a LAN-exposure warning; never inherit it
   from a prior app.
5. **Inspection retention.** Default: 512 KiB per app, path without query,
   connection metadata retained even when TLS inspection is disabled.
