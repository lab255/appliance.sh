# Fast agent spin-up — agent-only VM mode + a prebuilt agent image

> **Status update (single-VM model).** The separate agent-only sandbox VM
> (`appliance-sbx`) is **retired in the CLI**: agent sessions now ride the
> ONE managed `appliance` VM (booted dev-capable with the workspace
> mounted), alongside `appliance dev` and `appliance up`. The Rust
> `agent_only` spec flag remains in `packages/vm` for back-compat, but the
> CLI no longer creates agent-only VMs. The analysis below is kept as the
> historical record of Levers 1 and 2; read `appliance-sbx` as the
> now-retired dedicated VM.

**Status:** S1 (Lever 1, agent-only VM mode) **shipped** — see [§1.6 Invariants](#16-invariants-enforced-as-built). S2 (Lever 2, the prebuilt agent image) **machinery shipped** — the build workflow, fetch + `download_and_verify`, RO squashfs attach (`vdc`), PATH-first, the npm prefix move + wipe-on-project-switch, and the claude-code pin all land in `packages/vm` + `packages/cli` + a CI workflow. **Live verification remaining:** the squashfs artifact must be built by `release-agent-image.yml` and its per-arch sha256 committed into `images.rs` (the all-zero sentinel until then — the attach is skipped and the guest self-heals via npm), then booted and launched on a VM. **Scope:** this document covers two levers; **VM snapshots are ruled out** — see [§0](#0-why-not-snapshots).

> **S2 as built — verify-before-use for all downloads.** `download_and_verify(url, dest, sha256)` verifies the on-disk artifact's sha256 **before use, every boot — on a cache hit as well as a fresh download** (closing the `download_to` early-return-on-`exists()` hole). It is applied not only to the new agent image but **retrofitted to the pre-existing unauthenticated root-code downloads** — k3s, `modloop-virt`, and the Alpine kernel/initramfs (`images.rs`/`guest.rs`) — whose digests are now committed in-source. The agent squashfs is additionally **re-verified at attach time** immediately before the device is attached. See §2.3.

## Context

`appliance agent start` → `runAgent` (`cli/utils/agent.ts:1022`) → `ensureSandboxVm` (`agent.ts:1045`) → `runVm(['up', …])` (`utils/sandbox.ts:510`), which **blocks until k3s is fully up** — `host_services` only writes `kubeconfig.yaml` after the guest's k3s handoff answers (`guest.rs:895-902`, served once `k3s server` writes `k3s.yaml`, `guest.rs:235-249`) — and then `waitForDocker` blocks on the backgrounded `dockerd` (`sandbox.ts:513,520`). `up` itself polls on exactly one host-side file: `paths.kubeconfig().exists()` (`main.rs:539`).

But **agents never use k3s or dockerd**. They ride the vsock `SHELL_AGENT`, which comes up **early** in boot (`guest.rs:137`, before the dev/docker/k3s blocks) and is bridged to the host by the shell relay started in `run_foreground` (`backend/vz/mod.rs:134`) independent of k3s. The agent runtime they actually need is Node + a CLI, installed **on first use** via `command -v <bin> || npm install -g <pkg>` (`installCommandFor`, `agent.ts:172`) into `NPM_CONFIG_PREFIX="$HOME/.local"` (`guest.rs:321`) where `HOME=/persist/workspace` (`guest.rs:275`) **is the VirtioFS-mounted host repo** (`guest.rs:404-412`). So the agent's global npm tree lands **inside the user's project** (`<repo>/.local`) and is reinstalled per-project (each new mount is a different tree).

Two costs, two levers:

| Cost                                                                                  | Today                                                                                                                   | Lever                                           |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `up` waits for the whole **k3s `Cluster` phase** the agent never uses                 | dominant — `bringup.rs:33-34,48`: "first boot pulls images — can take a few minutes"; warm boots still pay k3s election | **Lever 1** — agent-only VM mode                |
| First launch runs `npm install -g` of the CLIs into the **mounted repo**, per-project | tens of seconds + network, repeated, pollutes the repo                                                                  | **Lever 2** — a prebuilt, versioned agent image |

The sandbox VM `appliance-sbx` (`sandbox.ts:19`) **persists** and is **reused** by `ensureSandboxVm` (it reboots only on a mount change, `sandbox.ts:500-507`). It is agent-specific by construction — nothing else runs there.

## 0. Why not snapshots

Ruled out. VZ save/restore is infeasible post egress-firewall: `validateSaveRestoreSupportWithError` rejects a config carrying VirtioFS (the workspace share, `guest.rs:404`) and the file-handle NIC; and the smoltcp netstack / DHCP / MITM state that the egress boundary depends on is **host-side** (`backend/vz/mod.rs:108-114`, `netstack/`), outside anything a guest snapshot could capture. A ~10-line `validateSaveRestoreSupportWithError` spike could confirm the rejection, but **do not build snapshots.** Both levers below are snapshot-free.

---

## Lever 1 — agent-only VM mode

Skip the k3s `Cluster` phase entirely for VMs that only ever host agents, and gate readiness on the agent runtime (vsock shell + Node), not on `kubeconfig.yaml`.

### 1.1 The spec flag

Add to `VmSpec` (`spec.rs`):

```rust
/// When set, this VM provisions NO k3s control plane: the guest
/// bootstrap skips the `k3s server` / registry / kubeconfig-handoff
/// block, and `up` gates on the agent runtime (vsock shell + Node)
/// instead of `kubeconfig.yaml`. The vsock shell agent, egress proxy,
/// clock-sync and dev toolchain are unaffected (they're k3s-independent).
/// A plain `vm up` leaves it false; one-way, like `dev`/`docker`.
#[serde(default)]
pub agent_only: bool,
```

Serializes as `agentOnly` in `vm.json`. Legacy specs lack it and parse to `false` (the unchanged k3s path).

**`appliance-sbx` is ALWAYS agent-only.** `ensureSandboxVm` sets the flag (a new `--agent-only` passed to `appliance-vm up`); the dev/deploy VM `appliance` is **never** agent-only (it keeps k3s for `appliance up`/deploy). This is the cleanest split: the flag is a property of the sandbox role, not a user toggle, so nobody can accidentally get a k3s-less deploy VM.

### 1.2 Guest bootstrap: gate out k3s

Wrap the k3s region of `APPLIANCE_START` (`guest.rs:156-249` — the `k3s` binary copy, `registries.yaml`, the registry manifest, `k3s server`, and the kubeconfig handoff) behind a new substitution marker `__K3S_PROVISION__`, exactly like `__DEV_PROVISION__`/`__DOCKER_PROVISION__` already work (`guest.rs:689-691`):

- `agent_only = false` → marker is the existing k3s block (byte-for-byte unchanged).
- `agent_only = true` → marker is replaced with an **agent-handoff** block: wait for the Node toolchain (`/persist/.dev-ready`, written by `DEV_PROVISION`, `guest.rs:392`) — the **grippable** marker, **not** the shell agent's "listening" console echo (it goes to console/serial, not a file the host can grip) — then serve a one-line `agent-ready` sentinel over `httpd` on `KUBECONFIG_PORT` (free in agent-only mode — no k3s competes for it) at `/srv/handoff/agent-ready`. This **reuses the existing handoff httpd machinery** (`guest.rs:244-249`) and the host's `wait_http` + fetch path verbatim — minimal new code. The host-side belt-and-suspenders probe is the vsock `command -v node` (`waitForAgentRuntime`, `sandbox.ts`).

`build_apkovl`/`build_boot_media` take an `agent_only: bool` and thread it through the substitution (mirrors the existing `dev`/`docker` plumbing at `guest.rs:613-694, 743-767` and `backend/vz/mod.rs:81-88`).

The non-root user, vsock shell agent, dev toolchain, and egress CA trust **all stay** — they're substituted before/independently of the k3s marker (`guest.rs:132-150`), so agent-only loses k3s and nothing else.

### 1.3 The new readiness gate

`host_services` (`guest.rs:831`) gets an `agent_only` branch:

1. Network discovery + the **forwards an agent needs are none** — k3s api/ingress/registry/NodePort forwards (`guest.rs:855-882`) are k3s-specific and are **skipped** in agent-only mode (the agent reaches the world through the egress proxy, not these). The egress proxy itself is unaffected — it's spawned in `Cmd::Run` (`main.rs:611-614`), upstream of and independent from `host_services`.
2. Set a new `Phase::Agent` (kebab `"agent"`, label `"preparing agent runtime (node + shell)"`) instead of `Phase::Cluster`. Small, additive change to `bringup.rs:23-52`; the desktop already renders arbitrary phase strings (`bringup.rs:131-135`).
3. `wait_http` the `agent-ready` sentinel (replacing the kubeconfig handoff fetch, `guest.rs:898-901`), then write a host-side marker file `paths.dir/agent-ready` (new `VmPaths::agent_ready()`, sibling of `kubeconfig()` at `spec.rs:320`) and set `Phase::Ready`.

**What `up` returns on:** `main.rs:539` changes from "poll `kubeconfig().exists()`" to "poll the **readiness marker for this spec**": `agent_ready()` when `spec.agent_only`, else `kubeconfig()`. The final "kubernetes/ingress" banner (`main.rs:591-595`) is swapped for an agent-runtime banner in agent-only mode (no k3s URLs to print). `status`/`list` cluster-readiness (`main.rs:643,692`) likewise keys on the spec's marker.

### 1.4 The agent path stops gating on k3s/docker

`ensureSandboxVm` (`sandbox.ts:492`):

- Pass `--agent-only` to `up` (and **drop `--docker` from the default** — see §1.5). `up` now returns once Node + the vsock shell are ready, **not** once k3s answers.
- **Remove the unconditional `waitForDocker` (`sandbox.ts:513`) from the agent path.** Readiness is now "the agent runtime is up", which `up`'s new gate already guarantees. A thin belt-and-suspenders `waitForAgentRuntime(vm)` — one vsock `command -v node && command -v <bin>` probe over the existing `vmShellCapture` — can replace it, but it returns near-instantly because `up`'s gate covered it.

The mount-change reboot logic (`sandbox.ts:500-507`) is unchanged.

### 1.5 dockerd decision: **skip by default, provision lazily behind a flag**

> **Decision: the agent-only sandbox boots with NO dockerd. `dockerd` is opt-in via `appliance agent start --docker`, which lazily re-ups the sandbox with `--docker` (one reboot, like a mount change) and provisions dockerd backgrounded. The default agent launch never blocks on `.docker-ready`.**

Rationale (the open Q, resolved):

- **Skip entirely is wrong** — an agent task may legitimately `docker build`. Silently having no dockerd would break that task with an opaque "command not found", violating the "don't silently break it" bar.
- **Always-provision is wrong for the common case** — most agent runs never touch Docker, yet today every sandbox pays the `docker docker-cli-compose` apk install + dockerd start and `up` blocks on it (`waitForDocker`, up to a 300 s ceiling, `sandbox.ts:492`). It also enlarges the attack surface (a root daemon + its socket) for runs that don't want it.
- **Flag-gated lazy threads the needle.** Default = fastest + smallest surface. `--docker` (persisted on the sandbox spec via the existing one-way `docker` toggle, `main.rs:469-472`) provisions dockerd exactly as today (`DOCKER_PROVISION`, backgrounded, `guest.rs:441-505`), and only a `--docker` launch waits on `.docker-ready`. The dockerd block is **already fully decoupled from the bring-up phases** (`guest.rs:151-155`, `sandbox.md §2`), so it composes with agent-only with zero new coupling.
- **Honest failure when unflagged:** if an agent invokes `docker` without `--docker`, it gets a clear "docker not provisioned in this sandbox — relaunch with `appliance agent start --docker`" rather than a silent break. (Auto-implying `--docker` from project detection — a `Dockerfile`/compose present, `sandbox.ts:152-157` — is a reasonable follow-up nicety but not required for S1.)

### 1.6 Invariants (enforced, as built)

These are load-bearing and enforced in code + locked by unit tests, not
just documented:

1. **`agent_only ⟹ dev`.** The agent-handoff readiness gate waits on
   `/persist/.dev-ready` (the dev toolchain's Node/npm marker, `guest.rs`),
   so an agent-only VM **must** be a dev VM. The CLI forces `dev = true`
   whenever it sets `agent_only` (`main.rs` `Up`/`Create`, `VmSpec`
   doc-comment), and the sandbox is dev anyway via `--mount`. If this were
   violated `.dev-ready` would never be written and the gate would hang —
   so it is an invariant, not a convenience.

2. **The `KUBECONFIG_PORT` handoff forward is RETAINED in agent-only
   mode.** Agent-only drops the k3s api/ingress/registry/
   NodePort forwards but keeps the handoff: the guest serves the
   `agent-ready` sentinel over the **same** busybox `httpd` on
   `KUBECONFIG_PORT` (free with no k3s competing), and under the netstack
   `host_services` still stands up the ephemeral loopback forward to reach
   it (`guest.rs::host_services`). Without this the host could never fetch
   the readiness sentinel.

3. **Network discovery is preserved.**
   Agent-only **still** runs `discover_guest_ip` / the netstack lease and
   **still writes `guest-ip`** — only the k3s _forwards_ are skipped, never
   the discovery/lease. The broker's exact-lease peer-pin
   (`peer_is_lease`/`should_intercept`) and the netstack boundary's lease
   attribution both depend on `guest-ip`. This is encoded in a pure,
   unit-tested `plan_host_services` (`persist_guest_ip` is unconditionally
   true; only `wire_k3s_forwards` follows `!agent_only`), so a regression
   that gated `guest-ip` on agent-only fails the test.

4. **Marker ordering.** The `__K3S_PROVISION__` branch (k3s
   block _or_ the agent handoff) is substituted **before** the nested
   `__KUBECONFIG_PORT__`/`__REGISTRY_*__`/`__AGENT_DOCKER_STUB__` port/stub
   markers, so an injected `__KUBECONFIG_PORT__` is expanded rather than
   surviving as a literal (`build_apkovl`). A unit test asserts no literal
   marker leaks into the agent-only bootstrap.

5. **Readiness is a grippable proof, never the console echo.**
   The gate is the host-side vsock probe (`command -v node` over
   `vmShellCapture`) plus the `.dev-ready`-gated `agent-ready` sentinel —
   **not** the shell-agent "listening" echo, which goes to console/serial
   and lands in no file the host can grip.

6. **Stale-marker removal.** A prior boot's `agent-ready`
   marker is removed before spawn (`main.rs` `Up`, mirroring the stale
   `kubeconfig` removal; also in the foreground host process,
   `backend/vz/mod.rs`) so `up` can never return on a stale readiness file.

---

## Lever 2 — a real prebuilt agent image

Bake Node ≥ 22 + the three pinned CLIs into a versioned, arch-split, read-only artifact, mount it on PATH at boot, and reduce the runtime `npm install` to a no-op.

### 2.1 Format: **read-only squashfs, attached as a virtio-blk disk**

> **Decision: a single, compressed, content-addressed `squashfs` file per arch, attached as a read-only block device (`vdc`) and mounted at `/opt/appliance/agents`.**

| Option                               | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Bake into the apkovl**             | **Rejected.** The apkovl is overlaid into the **tmpfs root every boot** (`guest.rs:609-612`, `images.rs:11-13`); Node + three CLIs + their transitive `node_modules` are hundreds of MB — that bloats the FAT boot media and burns guest **RAM** on every boot.                                                                                                                                                                                  |
| **Second VirtioFS share (host dir)** | **Rejected.** Workable, but it's a host **directory tree**, not one checksummable artifact (hashing/versioning a tree is awkward), and adds another VirtioFS device to the config.                                                                                                                                                                                                                                                               |
| **Read-only squashfs block device**  | **Chosen.** One file → trivially sha256-pinned, versioned, and compressed. **squashfs support is guaranteed in-guest** — `modloop-virt` is already a squashfs the `modloop` service loops-mounts (`images.rs:5`, `guest.rs:712`). Mounts read-only with one `mount -t squashfs /dev/vdc /opt/appliance/agents`. Read-only means the agent **cannot tamper with its own toolchain at runtime** — an integrity win over a writable `$HOME/.local`. |

Node is **baked into the squashfs** (pinned ≥ 22), not taken from apk — Alpine v3.21's `nodejs` (`guest.rs:390`) is not guaranteed ≥ 22, which `@github/copilot` and `@openai/codex` require (`agent.ts:318,365`). PATH prepends the squashfs `bin` so the baked Node + CLIs win.

### 2.2 Built reproducibly

A CI job (the same place boot-media pins are bumped) builds, **per arch**, in a clean Alpine container:

```sh
npm install -g --prefix /build/agents \
  @anthropic-ai/claude-code@<pin> \
  @github/copilot@1.0.65 \
  @openai/codex@0.142.0
cp "$(which node)" /build/agents/bin/node     # pinned Node ≥22
mksquashfs /build/agents agents-<ver>-<arch>.squashfs -comp zstd -no-xattrs
sha256sum agents-<ver>-<arch>.squashfs        # → committed digest
```

npm installs are not bit-reproducible (timestamps, optional deps), so **the artifact is pinned, not the build**: exact versions in, the resulting **sha256 committed in-source** as the contract (a lockfile by another name). The job also commits an `npm ls --global` / SBOM manifest next to the digest for audit. CI asserts the adapter pins (`install.version`, `agent.ts:241,318,365`) equal the baked manifest, so they can never drift silently.

### 2.3 Hosted, fetched, verified

- **Hosted** as a GitHub release asset on the appliance repo — mirrors how k3s is fetched from `k3s-io` releases (`guest.rs:82-89`). The toolchain is built + hosted by the project, **not pulled live from npm at boot.**
- **Fetched** by a new `ensure_agent_image()` mirroring `ensure_assets` (`guest.rs:67-92`), arch-split via `arch_tuple()` (`guest.rs:54`), into `images/agent-assets/agents-<ver>-<arch>.squashfs`. A new `AGENT_IMAGE` table mirrors the `IMAGES` table (`images.rs:24-34`): per-arch URL **and sha256**, keyed on a single `AGENT_IMAGE_VERSION` const.
- **Verified** by sha256 **before the device is attached** — and **on every cache hit, not only after a fresh download**. `download_to` early-returned on `dest.exists()` with no check; `download_and_verify(url, dest, sha256)` replaces it and verifies the on-disk bytes every boot, so a cached/tampered file can never bypass the hash. The agent image is additionally re-verified (`verify_agent_image`) right before the `VZDiskImageStorageDeviceAttachment` is built. **As built:** `download_and_verify` is also applied to the **pre-existing** unauthenticated root-code downloads — k3s, `modloop-virt`, and the Alpine kernel/initramfs — whose committed sha256s now live in `images.rs`/`guest.rs`. The kernel is verified against its **raw** network bytes (a `kernel.raw` kept beside the normalized boot image) since normalization mutates the file. This closes a pre-existing hole: those run as root / become the guest kernel — higher privilege than the agent image.

### 2.4 Mounted on PATH at boot

`APPLIANCE_START` (agent-only path) mounts the device read-only and the user profile prepends it:

```sh
mkdir -p /opt/appliance/agents
mount -t squashfs -o ro /dev/vdc /opt/appliance/agents 2>/dev/null || true
```

The VZ backend attaches the squashfs as a read-only `VZDiskImageStorageDeviceAttachment` (a sibling of the data disk + boot media, `backend/vz/mod.rs:81-98`) when `spec.agent_only`. PATH is set in `/etc/profile.d/appliance-user.sh` (`guest.rs:320-323`):

```sh
export NPM_CONFIG_PREFIX="/persist/npm-global"
export PATH="/opt/appliance/agents/bin:/persist/npm-global/bin:$PATH"
```

### 2.5 Move the npm prefix off the mounted repo

> **Decision: `NPM_CONFIG_PREFIX` moves from `$HOME/.local` (= `/persist/workspace` = the mounted repo) to `/persist/npm-global` — on the ext4 data disk: VM-persistent, shared across all projects, never the VirtioFS mount.**

Change both profile exports (`APP_USER_PROVISION`, `guest.rs:321-322`; `DEV_PROVISION`, `guest.rs:378`). This **ends the repo pollution** (no more `<repo>/.local`) and **ends the per-project reinstall** (the prefix is VM-global now, not per-mount). `/persist/npm-global` survives `vm stop`/`up` like the rest of `/persist`, so even the self-heal fallback installs once per VM, not once per project.

> **As built — wipe `/persist/npm-global` on a project switch.** Because the prefix is now VM-global and persistent, a CLI a self-heal installed for one project would otherwise linger on PATH into the next project's sandbox (the cross-project PATH-persistence vector). The host stamps the mounted project's identity (a 16-hex sha256 of its absolute path) into the boot media; the guest bootstrap compares it against `/persist/.npm-global-project` and `rm -rf`s the prefix when they differ — and the sandbox already reboots on a mount change, so the wipe rides that reboot. The read-only squashfs PATH-first already shields the three **baked** CLIs; this closes the **self-heal residue**. (No mount ⇒ empty identity ⇒ no wipe.)

### 2.6 Runtime `npm install` → presence-check no-op

`installCommandFor` is **already** `command -v <bin> || npm install -g …` (`agent.ts:172-175`). With the CLIs on PATH from the squashfs, `command -v claude` (etc.) succeeds → the `|| npm install` **never runs**. So the no-op falls out for free; the only intentional changes:

- Keep the `|| npm install` as a **self-heal** — if the image is somehow missing it still installs, now into `/persist/npm-global` (not the repo).
- **Pin the `claude-code` adapter** (currently unpinned, `version: ''`, `agent.ts:238-241`) to the baked version so the presence check and any fallback are version-consistent with the image. Copilot + Codex are already pinned.

### 2.7 Version-bump policy

A CLI pin change is **one coordinated commit**: (1) bump the adapter `install.version`; (2) CI rebuilds the squashfs and emits a new digest; (3) bump `AGENT_IMAGE_VERSION` + the two per-arch sha256s in `images.rs`. The version keys the filename, URL, and digest, so a bump is one const + two hashes. A mismatch (adapter pin ahead of the baked image) is **caught two ways**: the CI equality assertion (§2.2) fails the build, and at runtime the presence check falls through to a real `npm install` of the newer pin (self-heal — slower, still correct).

---

## 3. Measurement (before/after via `bringup.json`)

`bringup.json` already stamps each phase with the `since` Unix-seconds it was entered (`bringup.rs:55-64,79-88`). Per-phase elapsed = the delta between consecutive `since` values; total = `Ready.since − Media.since`.

- **Before (k3s sandbox):** `Media → Booting → Network → Cluster → Ready`, where **`Cluster` dominates** (k3s server start; first boot also pulls registry/traefik images — `bringup.rs:33-34,48`). Plus first-launch `npm install -g` of the CLIs into the mounted repo (off-phase, but on the user's wall clock).
- **After (agent-only + prebuilt image):** `Media → Booting → Network → Agent → Ready` — **no `Cluster` phase at all**. The `Agent` phase is "wait for Node + vsock shell", a few seconds warm. First-launch `npm install` becomes an instant `command -v` no-op.

**Method:** read `~/.appliance/vm/appliance-sbx/bringup.json` phase deltas across a warm-cache boot, before and after. A tiny `appliance vm timings <vm>` that prints per-phase elapsed from the file makes this a one-liner (optional, but cheap and reusable). First boot still pays a one-time `Media` cost for the squashfs fetch (cached thereafter), so compare **warm** boots for the steady-state win.

**Expected:** eliminating `Cluster` removes the single dominant cost (k3s election warm; image pulls cold). The prebuilt image removes the per-project CLI install (tens of seconds + network) from first launch, replaced by a one-time cached fetch + an instant presence check. Net: agent-ready drops from "k3s elected" to "node + shell up".

---

## 4. Security

### 4.1 Agent-only shrinks the attack surface — confirm nothing essential is skipped

Agent-only removes, from the sandbox: the **k3s API server** (`:6443`), **traefik ingress** (`:80`), the **in-VM registry**, **kubelet/containerd**, and their host port-forwards (`guest.rs:855-882`). By default it also drops **dockerd** (§1.5). All net-positive — these were never part of the agent's path.

Confirmed **nothing the broker / egress / shell needs is skipped** (each is k3s-independent and survives agent-only):

| Need                                   | Where it lives                                  | Independent of k3s?                                  |
| -------------------------------------- | ----------------------------------------------- | ---------------------------------------------------- |
| Egress proxy (the only path off-box)   | `egress::spawn` in `Cmd::Run`                   | Yes — `main.rs:611-614`, upstream of `host_services` |
| vsock shell agent + relay + clock-sync | `guest.rs:137-141`; `backend/vz/mod.rs:134-141` | Yes — start before/independent of the k3s block      |
| Egress CA trust (MITM)                 | baked into the apkovl unconditionally           | Yes — `guest.rs:704`, `109-111`                      |
| Credential broker rule + MITM-on       | host-side `creds add` + `egress mitm on`        | Yes — `configureBroker`, `agent.ts:972-978`          |
| Per-agent egress allowlist             | `egressHosts` → `NETSTACK_ALLOWLIST`            | Yes — `agent.ts:149-150,242,323,367`                 |

So the egress firewall, credential brokering, and the host-only vsock shell are **untouched** — agent-only is a strictly smaller surface with the same security envelope.

### 4.2 The prebuilt image is a NEW trust artifact — supply-chain framing

The squashfs bakes three third-party CLIs + Node + their full transitive npm trees, executed with the agent's **brokered credentials**. Trust framing:

- **Build provenance.** Built in CI from **exact pinned versions**, with the `npm ls`/SBOM manifest committed alongside the digest (§2.2). Recommend GitHub Actions build provenance / attestation on the release asset.
- **Checksum pinning.** The per-arch **sha256 is committed in-source and verified after download, before the device is attached** (§2.3) — closing the gap that `images::download_to` has no hash check today (`images.rs:123-140`).
- **Who builds / hosts.** The project builds + hosts it (a GitHub release on the appliance repo), **not a live `npm install` at agent-launch**. This is a **net improvement**: it moves trust from "the npm registry, at the moment each agent launches" to "one versioned, project-controlled, hash-pinned artifact" — no install-time compromise window in the hot path, and reproducible across machines. The read-only mount also means a compromised agent **can't rewrite its own toolchain** at runtime.
- **Residual risk (named, not hidden).** The baked CLIs can still be malicious/compromised **upstream at bake time** — but that risk exists **today** with the live install; pinning + checksum + SBOM make it auditable and **freeze** it to a reviewed point-in-time, rather than re-resolving `@latest`/transitive deps on every first launch (claude-code is `@latest` today, `agent.ts:238-241`).

---

## Open questions

1. **Node source** — bake a pinned Node ≥ 22 into the squashfs (this doc's recommendation; apk `nodejs` on Alpine v3.21 may be < 22 and break copilot/codex). Confirm bake.
2. **dockerd** — explicit `--docker` flag (recommended), or auto-imply from project detection (`Dockerfile`/compose present)? Lean explicit + honest error.
3. **Hosting/attestation** — use a GitHub release on the appliance repo for v1, or require cosign-signed + provenance-attested assets from day one?
4. **Checksum gap** — ~~extend `download_and_verify` to the existing k3s/modloop/alpine assets too~~ **Done:** the retrofit shipped — k3s/modloop/alpine kernel+initramfs now carry committed in-source sha256s and are verified before use every boot (cache-hit included). See §2.3.
5. **claude-code pin** — pinning the adapter (§2.6) means choosing a claude-code version to bake; which release tracks the pin (and how often is it bumped vs the faster-moving copilot/codex)?
