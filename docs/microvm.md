# Appliance microVMs

The microVM is Appliance's local runtime: Appliance spins up its own
microVM that runs workloads safely and in isolation — no Docker Desktop,
no colima, no shared host daemon, and no Docker on the host at all.
Think of it as Appliance's sandbox runtime: **one purpose-built VM per
machine** whose entire lifecycle belongs to Appliance. `appliance dev`,
`appliance up`, `appliance agent`, and `appliance deploy` all target
this single managed `appliance` VM (booted dev-capable with the
workspace mounted). It replaced the former k3d-on-docker runtime, which
has been removed.

## What's inside the VM

- **k3s** (containerd) with the **Traefik ingress** serving
  `*.appliance.localhost` on the forwarded host port `8081`.
- The **in-VM image registry** (registry:2, NodePort 30500, host
  forward `5052`).
- **buildkitd** (+ `buildctl`) — all container images are built
  **server-side inside the VM**; the host never runs docker/buildctl.
- The **api-server guest binary** (`appliance-api-server`, a
  bun-compiled linux-musl executable) plus the **web console bundle**,
  running as a plain process on guest port `9091`, supervised by a
  respawn loop in the guest bootstrap. There is no in-cluster
  api-server pod and no image delivery at `vm up`.
- The **dev/agent toolchain** (bash, git, node, python, editors, …) and
  the vsock shell agent — the same VM hosts interactive dev
  environments and coding-agent sessions.

Ports forwarded to the host: `8081` ingress, `6443` kubernetes, `5052`
registry, `5053` egress proxy, `5054` buildkit.

## Why the microVM replaced k3d-on-docker

The former k3d local runtime worked, but it rented someone else's VM. On
macOS the k3d nodes lived inside whatever Docker provider the user
installed (colima, Docker Desktop, OrbStack), which meant:

- **Trust + isolation**: workloads shared a VM with everything else the
  user ran in docker. We can't make isolation promises about a VM we
  don't own.
- **Lifecycle fragility**: most local-runtime failure modes we fixed
  over the k3d era (wedged kubelets after VM restarts, stopped colima
  VMs, registry mirrors lost across restarts, docker contexts pointing
  elsewhere) were symptoms of layering on a runtime we didn't control.
- **Onboarding**: "install any container runtime first" was the worst
  step of bringing the runtime up. A built-in VMM removes the only
  prerequisite we can't auto-install.

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│ appliance-vm (single Rust executable)                     │
│                                                           │
│  CLI: create / start / stop / delete / status / console   │
│                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │ vz backend   │  │ kvm backend  │  │ wsl backend  │    │
│  │ macOS        │  │ Linux        │  │ Windows      │    │
│  │ Virtualization│ │ /dev/kvm     │  │ wsl.exe      │    │
│  │ .framework   │  │ (rust-vmm)   │  │ managed distro│   │
│  └──────────────┘  └──────────────┘  └──────────────┘    │
│                                                           │
│  Guest contract (identical on every backend):             │
│   • direct kernel boot, virtio console → log file         │
│   • virtio-blk data disk (persistent, survives delete     │
│     of the VM definition only on explicit flag)           │
│   • virtio-net NAT with host port forwards                │
│   • k3s (containerd) as the workload runtime              │
└───────────────────────────────────────────────────────────┘
```

### The backend trait

`VmBackend` is the seam that keeps platform code contained:

- `availability()` — can this backend run here (hypervisor present,
  entitlements held, /dev/kvm accessible, WSL2 installed)?
- `create(spec)` — materialize disks/config for a named VM.
- `start(name)` / `stop(name)` / `delete(name)` — lifecycle.
- `state(name)` — exists / running, plus backend-specific detail.

The CLI, state store, guest provisioning, and host wiring are all
backend-agnostic. A backend's only job is "boot this kernel with these
devices and keep it running".

### Backend choices

- **macOS — Virtualization.framework, in-process.** The desktop shell
  is already Rust (Tauri); `objc2-virtualization` gives us VZ bindings
  without a Swift helper. This is the same foundation Docker Desktop
  and OrbStack build on, driven directly rather than through an
  external VM manager. Requires the `com.apple.security.virtualization`
  entitlement (ad-hoc signing is sufficient for local dev; the desktop
  app's signing pipeline adds it for release builds).
- **Linux — KVM.** Target shape: an embedded rust-vmm based VMM
  (mmio virtio devices, no device emulation beyond what the guest
  contract needs). Until that lands, the backend reports itself
  unavailable with a clear message. There is no k3d fallback — Linux
  has no local runtime in the interim (use a BYO
  `appliance-base-kubernetes` cluster).
- **Windows 11 — WSL2** _(implemented for the supported scope, pending [owner-run
  certification R01–R72](live-test-runbook-windows.md#results-record))_. The backend drives `wsl.exe` to
  import the hash-pinned Alpine minirootfs as a per-VM distro; its VHDX is the
  persistence layer. The managed distro disables drive automount and Windows
  interop, and host artifacts are streamed over `wsl.exe` stdin into
  Linux-owned paths with guest-side size/SHA verification
  ([backend and tests](../packages/vm/src/backend/wsl.rs)). Runtime published
  ports are authorized through the host forward broker rather than a broad
  mount or listener ([forward-broker tests](../packages/vm/src/runtime_forward.rs)).
  Shells use the `wsl.exe` ConPTY channel and stop terminates the named distro
  through its `stop.request` lifecycle ([backend tests](../packages/vm/src/backend/wsl.rs)).
  Windows egress remains a cooperative, bypassable proxy—not a Netstack hard
  boundary ([Windows egress contract](egress-firewall.md#windows-wsl-backend)).

### Guest

A deliberately tiny, versioned guest — not a general-purpose distro:

- **Boot**: direct kernel boot (no firmware, no bootloader) of a
  pinned Alpine `virt` kernel + a custom initramfs. Sub-second kernel
  start; the image pair is a few tens of MB, downloaded once into
  `~/.appliance/vm/images/<version>/` (same managed-asset model the
  helper uses for kubectl).
- **Init**: our own minimal init (busybox + a shell script baked into
  the initramfs): bring up virtio-net via DHCP, mount the virtio-blk
  data disk (mkfs on first boot), then exec **k3s server** with its
  data dir on the persistent disk.
- **Workload runtime**: k3s directly — not docker+k3d. k3d exists to
  wrap k3s in docker on machines where docker is the only common
  denominator; inside a VM we own end-to-end, that indirection buys
  nothing and costs boot time, memory, and a registry-mirror config
  layer. k3s's embedded containerd runs the containers. (An in-guest
  dockerd also exists, but only as the sandbox engine `appliance up`
  drives for a repo's own Dockerfile/compose runs — it plays no part in
  the deploy pipeline.)
- **Control channel**: virtio-vsock for host↔guest exec and readiness
  (no SSH keys, no TCP exposure). The guest init runs a tiny vsock
  agent; `appliance-vm exec` rides it.

### Host wiring — same DX, new engine

The existing `appliance-base-kubernetes` base is the integration
point; nothing above it changes:

1. **The CLI stages the guest assets.** `appliance vm up` places the
   bun-compiled linux-musl api-server binary and the console bundle
   into `~/.appliance/vm/images/guest-assets/`.
2. **`appliance-vm` embeds them in the boot media.** The Rust engine
   generates a **bootstrap token** (persisted host-side at
   `~/.appliance/vm/<name>/bootstrap-token` and injected into the guest
   at `/etc/appliance/bootstrap-token`, mode 0600), then bakes the
   binary + console + token into the boot media it builds.
3. **The guest bootstrap launches everything.** After the data disk
   mounts, the bootstrap copies the api-server binary into place,
   starts k3s, and runs the api-server under a respawn loop on guest
   port `9091`. An auto-applied manifest creates a **selector-less
   Service + Endpoints** that routes the Traefik ingress host
   `api.appliance.localhost` to the guest binary, so the server is
   reachable at `http://api.appliance.localhost:8081` — the same URL
   surface as before, with no in-cluster pod behind it. The api-server
   authenticates to k3s with its own **ServiceAccount token** (created
   via the auto-applied manifest — bun's fetch cannot do kubeconfig
   client-cert auth) and trusts the k3s CA via `NODE_EXTRA_CA_CERTS`.
4. **The CLI mints an API key.** Once the server answers, `vm up`
   exchanges the bootstrap token for the first API key automatically
   and saves it to the VM's credential profile (`local` for the default
   VM).
5. `appliance deploy` detects the kubernetes base via `/cluster-info`
   and uploads a **source zip** (manifest + tree); the api-server
   builds the image **inside the VM** with buildkitd and pushes it to
   the in-VM registry — the host never builds or pushes an image.
6. Ingress port forwards: host `:8081 → guest :80` (ingress) and the
   NodePort window, so `<project>-<env>.appliance.localhost:8081` keeps
   working verbatim.

Because `.localhost` names resolve to 127.0.0.1 everywhere, hostname
routing needs zero new machinery — only the port forward.

### Multiple VMs

Several VMs run concurrently — one for interactive development, another
for traffic testing. Each VM persists its own five host ports (ingress /
kubernetes / registry / egress / buildkit) in its `vm.json` and gets a
non-colliding block at create: the default `appliance` VM keeps the
canonical `8081/6443/5052/5053/5054`; any other VM is allocated the lowest
free contiguous block of five from `8100` upward (`VmSpec::allocate_ports`).
Each registers as its own desktop cluster (`local` for the default VM,
`microvm-<name>` for any other — the same string as its CLI credentials
profile; the legacy `microvm` profile name is dual-written for one
release of back-compat), so the deploy wizard, cluster switcher, and
kubectl reads target the right VM. `appliance vm list` reports every VM
with its ports and running state.

### Development environments

A microVM can double as an isolated **dev environment** — the VM host
itself, provisioned to work in, not just to deploy into. `appliance vm
dev up` (desktop: the **dev environment** tick before Start) sets a
one-way `dev` flag on the VM spec; the guest bootstrap then, after the
data disk mounts:

- creates a persistent `/persist/workspace` and home (survive
  `stop`/`up` like all `/persist` state),
- symlinks apk's cache onto `/persist` and installs a toolchain (bash,
  git, build-base, python3, node, editors, …) **in the background** —
  first boot pulls from the network, later boots hit the cache
  (fast/offline) — so dev provisioning never delays k3s readiness or the
  kubeconfig handoff that `up` waits on.

You shell in with `appliance vm dev shell` (or the desktop **Open
shell**), which lands in the workspace with the toolchain on `PATH`. The
interactive shell rides a **vsock** channel: every VM runs a `socat` PTY
agent on a fixed vsock port (`SHELL_VSOCK_PORT`), the resident host
process bridges a per-VM Unix socket to a fresh guest connection
(`backend/vz/shell.rs`), and `appliance-vm shell` drives that Unix socket
in raw mode — no SSH, no TCP exposure, and no dependency on k3s, so it
works before the cluster is ready and leaves no debugger pod behind. It
falls back to `kubectl debug node/` + chroot for older VMs or while the
agent is still starting, and one-shot `-- <cmd>` runs stay on the kubectl
path for clean output + an exit code. The egress proxy + credential
injection confine the dev environment exactly as they confine deployed
workloads.

**Sharing a host folder** (`appliance vm dev up --mount <path>`, desktop:
**Share a folder…**) presents the folder to the guest over VirtioFS — a
`VZVirtioFileSystemDeviceConfiguration` tagged `workspace` on the VZ
backend — and the bootstrap mounts that tag at `/persist/workspace`, so
host edits and in-VM work share one tree. It implies `--dev`, is persisted
on the spec (re-shared every boot until `appliance vm up --no-mount`), and
shadows the data-disk workspace while active. The shared path is resolved

- validated host-side so a bad path fails fast.

One follow-on is designed but not built: honouring a workspace
**`devcontainer.json`** — building/running the referenced image as a
container inside the VM (on k3s/containerd) and shelling into that
container instead of the host, so a repo's declared toolchain comes up
verbatim. The vsock channel above already gives it a clean way in.

### Packaging — one executable

`appliance-vm` builds as a single static-ish binary per platform:

- The desktop bundles it the same way it bundles the Node sidecar
  today, and drives it in-process on macOS (library) or as a child
  process (CLI parity on all platforms).
- The npm CLI ships it per-platform via optionalDependencies (the
  standard esbuild/turbo pattern) so `appliance vm up` works without
  the desktop app.

### Phasing

1. **Crate + macOS boot** _(done)_: backend trait, CLI, state
   store, VZ backend booting the pinned guest kernel with console
   logging, NAT networking, persistent data disk. The KVM backend remains
   unavailable; the WSL backend's supported scope is pending the [owner-run
   certification R01–R72](live-test-runbook-windows.md#results-record).
2. **Guest image + k3s** _(done)_: rather than a fully custom
   initramfs, the boot media is a host-built FAT volume (pure Rust:
   fatfs + tar) carrying the Alpine modloop, an apkovl overlay, and
   the pinned k3s binary; Alpine's own diskless init handles module
   loading and root assembly, then openrc runs our bootstrap which
   formats/mounts the data disk and starts k3s. Host↔guest
   connectivity needs no agent: the VZ NAT subnet is host-reachable,
   the guest's address is discovered from the macOS DHCP lease table
   via the VM's fixed MAC (the Lima approach), the kubeconfig is
   served once over a guest-local HTTP handoff, and the resident host
   process runs plain TCP forwards (`127.0.0.1:6443 → guest:6443`,
   `127.0.0.1:8081 → guest:80`). `appliance-vm up` returns a working
   kubeconfig; `kubectl get nodes` is Ready ~30s after a warm boot and
   Traefik serves `<name>.appliance.localhost:8081` exactly like the
   k3d runtime.
3. **DX integration** _(done)_: `appliance vm up` boots the VM,
   waits for the in-VM registry (registry:2 via k3s's auto-applying
   manifests dir, NodePort 30500, host forward on 5052), waits for the
   guest api-server (staged + embedded + launched as described under
   "Host wiring"), mints the first API key from the bootstrap token,
   and registers the `local` profile. `appliance deploy` then works
   verbatim: the CLI uploads a source zip, the api-server builds the
   image in-VM with buildkitd, pushes it to the in-VM registry, and the
   resulting app serves at `<project>-<env>.appliance.localhost:8081`.
   State persists across `vm stop`/`vm up` on the data disk (projects,
   credentials, images, running workloads all survive). Architecture:
   there is no binfmt emulation in the guest, so images must match the
   VM (= the host); building inside the VM makes that automatic — the
   server-side build always produces the VM's own architecture,
   regardless of the manifest's `platform`, so a Lambda-targeted amd64
   manifest still runs on Apple Silicon instead of crashlooping.
   **Docker-free builds** _(done)_: every k3s VM provisions
   **buildkitd** in-guest (Alpine `buildkit` package, cache under
   `/persist/buildkit`, gRPC on guest `:8372` forwarded to host
   `127.0.0.1:5054`), with a guest-loopback socat alias bridging
   `localhost:5052 → :30500` so buildkitd pushes the same ref pods
   pull. The api-server drives it with the in-guest `buildctl` for
   every deploy — `framework` apps (node/python/auto) get a
   server-generated Dockerfile; `container` apps ship their own
   Dockerfile + context in the source zip. No Docker anywhere on the
   host.
4. **KVM backend** _(not implemented)_ and **WSL backend** _(implemented for
   the supported scope, pending [Windows owner-run certification
   R01–R72](live-test-runbook-windows.md#results-record))_. The desktop
   presents local execution as one **Local runtime** with a "sandbox with a
   virtual machine" toggle rather than an engine selector; WSL uses its
   `wsl.exe` channel while VZ uses the guest exec channel.

## Egress control (outbound-traffic policy + TLS interception)

Borrowing Docker's sandbox model: the VM's outbound traffic flows
through a forward proxy that Appliance runs and the desktop controls,
so a workload can be confined to known endpoints and (optionally) have
its TLS decrypted for inspection.

- **Proxy + policy** (`packages/vm/src/egress.rs`): an HTTP proxy that
  handles `CONNECT` (HTTPS) and plain HTTP, deciding by destination
  host against an allow/deny policy (deny > allow > default). The
  policy is JSON at `~/.appliance/vm/<name>/egress-policy.json`,
  reloaded per connection so edits apply live. Default port 5053
  (clear of the 5050/5052 registries). Drive it with
  `appliance vm egress proxy|policy|default|allow|deny|reset`.
- **TLS interception** (`packages/vm/src/mitm.rs`): with `egress mitm
on`, allowed HTTPS connections are intercepted — the proxy presents
  a leaf minted on the fly (per SNI) from a per-VM CA the workload
  trusts, terminates the client TLS, re-originates a real TLS
  connection upstream, and so sees the decrypted request for
  host/path-level policy and logging. The CA is generated once
  (`egress ca`, rcgen) and lives at
  `~/.appliance/vm/<name>/egress-ca.pem`; leaves are minted with
  rustls. Off by default (blind tunnel) — turning it on is opt-in
  confinement, not a behavior change.
- **Routing the guest through it**: the proxy starts automatically
  with the VM (`vm run` spawns it on `0.0.0.0:5053`, best-effort) and
  a peer guard refuses anything off the VM subnet, so it is reachable
  by the guest but never an open LAN proxy. Workloads point
  `HTTPS_PROXY` / `HTTP_PROXY` at it on the VM's subnet gateway (the
  `.1` the host sits on under vz NAT, e.g. `http://192.168.64.1:5053`)
  and — for interception — trust the CA. `appliance vm egress gateway`
  prints the exact values. Verified end-to-end against a live VM: a
  real pod with `HTTPS_PROXY` set reaches the host proxy (200 when
  allowed; blocked the instant the policy flips to deny, no restart),
  and with the CA trusted the proxy decrypts the request (`GET /`
  logged) while the workload still gets a valid 200.
- **Desktop control**: the Runtimes page's microVM panel has an
  "Outbound traffic" section — default allow/deny, a TLS-interception
  toggle, allow/deny host rules, and the CA path. Tauri commands
  (`microvm_egress_*`) drive the same `appliance-vm egress` surface so
  the policy file stays single-sourced.

- **Live traffic view**: the proxy records every request decision
  (host/port/method/path/allow|deny|mitm) to a bounded JSONL log
  (`traffic.rs`; `appliance vm egress log`). The desktop polls it and
  renders a Docker-Desktop-style feed with one-click per-host Allow /
  Block that edits the policy live.

- **Credential capture & injection (apiKeyHelper)**: with
  interception on, the proxy can keep secrets out of workloads
  (`creds.rs`). Per host, **capture** lifts a credential header off the
  decrypted request into a host-side store (`egress-secrets.json`,
  0600, under the VM dir — outside the guest); **inject** sets that
  header on the outbound copy, sourced from the stored secret or an
  `apiKeyHelper` command (its stdout is the credential). Hooked into
  `mitm::intercept` alongside the `Connection: close` rewrite. Driven
  by `appliance vm creds …` and the desktop's "Credentials" panel
  (`microvm_creds_*`). Host-side only — the guest never sees the store.

- **Automatic workload injection**: confinement is applied by policy,
  no per-pod wiring. The host mirrors the active policy into the
  cluster as the `appliance-egress` ConfigMap (proxy URL, NO_PROXY,
  mitm flag, CA) on `vm up` and every policy change; an inert policy
  removes it. The api-server's deployment service reads it and injects
  `HTTP(S)_PROXY` + `NO_PROXY` into every workload, and — when
  intercepting — mounts the CA with `NODE_EXTRA_CA_CERTS` (additive)
  plus `SSL_CERT_FILE`/`REQUESTS_CA_BUNDLE`/`GIT_SSL_CAINFO` pointed at
  a combined system-roots+CA bundle the api-server builds from its own
  image roots (so direct TLS to NO_PROXY hosts still validates).
  Node-level vs per-pod trust differ: the guest's system store gets the
  CA at boot (above), while pods — which carry their own image trust
  store — get it via this mount. Taking an api-server change live means
  restaging the guest binary (`vm up` re-embeds the staged assets); the
  guest CA needs the VM's next boot.
