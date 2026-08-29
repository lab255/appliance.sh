use serde::{Deserialize, Serialize};
use anyhow::{bail, Result};
use std::net::Ipv4Addr;
use std::path::PathBuf;

/// How the guest NIC is wired to the host.
///
/// The egress-firewall epic swaps the framework NAT for a host-resident
/// userspace netstack that owns the only path off-box. This is staged
/// behind a per-VM flag so existing VMs keep NAT until recreated and the
/// NAT path stays the escape hatch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NetLink {
    /// `VZNATNetworkDeviceAttachment` — the framework runs NAT and the
    /// host never sees a packet. Default, fully working, unchanged.
    #[default]
    Nat,
    /// Host-mediated link: the NIC is a `socketpair(AF_UNIX, SOCK_DGRAM)`
    /// whose host end the in-process smoltcp netstack owns. The egress
    /// boundary lives here (F2+); F1 is behaviour-neutral default-allow.
    Netstack,
}

/// Runtime egress posture on the WSL backend.
///
/// WSL cannot provide the host-owned netstack boundary used by VZ. Strict is
/// therefore the safe default: Runtime apps that request network grants are
/// refused. Cooperative is an explicit opt-in to the bypassable HTTP(S)
/// proxy path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WslMode {
    #[default]
    Strict,
    Cooperative,
}

/// Persisted definition of one microVM. Lives at
/// `~/.appliance/vm/<name>/vm.json`; everything else in that
/// directory (disk image, console log, pidfile) is derived state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VmSpec {
    pub name: String,
    /// Virtual CPUs.
    pub cpus: usize,
    /// Memory in MiB.
    pub memory_mib: u64,
    /// Data disk size in GiB (sparse raw image, created on `create`).
    pub disk_gib: u64,
    /// Guest image set (pinned kernel + initramfs pair) this VM boots.
    pub image: String,
    /// Kernel command line.
    pub cmdline: String,
    /// Fixed MAC address — how the host finds the guest's DHCP lease.
    /// Generated once at create; locally administered unicast.
    pub mac: String,
    /// Host loopback port forwarded to the guest's ingress (:80).
    /// Matches the k3d runtime's default so `*.appliance.localhost:8081`
    /// behaves identically on either engine.
    pub host_port: u16,
    /// Host loopback port forwarded to the Kubernetes API (:6443).
    pub api_port: u16,
    /// Host loopback port forwarded to the in-VM image registry.
    /// 5052 by default — deliberately clear of the k3d runtime's 5050
    /// so both engines can coexist on one machine.
    #[serde(default = "default_registry_port")]
    pub registry_port: u16,
    /// Host port the egress proxy binds for this VM (default 5053).
    #[serde(default = "default_egress_port")]
    pub egress_port: u16,
    /// Host loopback port forwarded to the in-guest buildkitd gRPC
    /// listener (default 5054) — the docker-free image build path.
    #[serde(default = "default_buildkit_port")]
    pub buildkit_port: u16,
    /// When set, this VM is provisioned as a development environment:
    /// the guest bootstrap installs a dev toolchain (cached on the data
    /// disk) and creates a persistent `/persist/workspace` + home you
    /// shell into. Toggled on by `appliance vm dev up`; a plain
    /// `vm up` leaves it false, and it is never silently turned back off.
    #[serde(default)]
    pub dev: bool,
    /// Absolute host path shared into the guest over VirtioFS and
    /// mounted at `/persist/workspace` — "edit on the host, run in the
    /// VM". `None` keeps the workspace on the persistent data disk.
    /// Set by `appliance vm dev up --mount <path>`; implies `dev`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev_mount: Option<String>,
    /// When set, the guest bootstrap provisions an in-guest Docker
    /// engine (`dockerd` on the Alpine `docker` aplet, cached on the
    /// data disk) alongside k3s, with its data-root, containerd and
    /// socket all under `/persist/docker`. Decoupled from the bring-up
    /// phases: `vm up` reaches `Ready` on k3s alone and never waits on
    /// dockerd. A plain `vm up` leaves it false; it is never silently
    /// turned back off.
    #[serde(default)]
    pub docker: bool,
    /// When set, this VM provisions NO k3s control plane: the guest
    /// bootstrap skips the `k3s server` / registry / kubeconfig-handoff
    /// block, and `up` gates on the agent runtime (the vsock shell + the
    /// Node toolchain) instead of `kubeconfig.yaml`. The vsock shell
    /// agent, egress proxy, clock-sync and dev toolchain are unaffected
    /// (they are k3s-independent). The sandbox VM (`appliance-sbx`) is
    /// always agent-only; the deploy VM `appliance` never is.
    ///
    /// Invariant: `agent_only ⟹ dev`. The agent-handoff readiness gate
    /// waits on `/persist/.dev-ready` (written by the dev toolchain
    /// install), so an agent-only VM must also be a dev VM — the CLI
    /// forces `dev = true` whenever it sets this. A plain `vm up` leaves
    /// it false; one-way, like `dev`/`docker`.
    #[serde(default)]
    pub agent_only: bool,
    /// Fixed core-only Appliance Runtime profile. Runtime VMs are
    /// agent-only in the sense that they carry the host vsock control
    /// channel, but deliberately omit the development toolchain.
    #[serde(default)]
    pub runtime: bool,
    /// Whether this VM's boot media provisions the lazy Kubernetes
    /// platform layer (k3s, BuildKit, registry, and api-server). Fresh
    /// VMs start core-only; `appliance-vm up --cluster` promotes this
    /// one-way and performs a full reboot with newly assembled media.
    /// Field-less legacy specs adopt the new core-first default too;
    /// their first deploy performs the explicit one-way promotion.
    #[serde(default)]
    pub cluster: bool,
    /// Container ports published from the in-guest Docker engine, each
    /// mapped to a host loopback port drawn from this VM's allocated
    /// block (see `allocate_published_port`). `host_services` reads this
    /// on bring-up and forwards each entry over the NAT subnet. Empty by
    /// default and absent from legacy specs (which parse to `vec![]`).
    #[serde(default)]
    pub published: Vec<PublishedPort>,
    /// Per-app Runtime payload grants. VZ materializes them as boot-configured
    /// VirtioFS devices (changes require a pool restart); WSL retains them as
    /// validation metadata and mounts drvfs payloads on demand.
    #[serde(default)]
    pub runtime_mounts: Vec<RuntimeMount>,
    /// How the guest NIC attaches to the host. Defaults to `Nat`
    /// (behaviour unchanged); `Netstack` swaps in the host-side smoltcp
    /// terminator. Legacy specs lack the field and parse to `Nat`. A
    /// global `APPLIANCE_NETSTACK=1` env override forces `Netstack` on
    /// backends that implement it (see [`VmSpec::net_link`]). WSL always
    /// resolves and persists this as `Nat`.
    #[serde(default)]
    pub net_link: NetLink,
    /// WSL Runtime egress posture. Legacy specs default to strict. Fresh specs
    /// inherit the optional global `wslMode` value in
    /// `~/.appliance/settings.json`, then persist the resolved value here so a
    /// later global edit cannot silently widen an existing VM.
    #[serde(default)]
    pub wsl_mode: WslMode,
}

/// One published container port: the in-guest container port and the
/// host loopback port forwarded to it. Persisted with the spec and
/// consumed (later) by the boot-time forwarding code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedPort {
    /// Host loopback port (`127.0.0.1:<host>`), allocated from this VM's
    /// block and never one of the reserved/auto-forwarded ports.
    pub host: u16,
    /// Container port inside the guest the host port forwards to.
    pub container: u16,
    /// Runtime host forwarding is TCP-only. Explicit persistence keeps the
    /// authorization check fail-closed if the schema later grows UDP rows.
    #[serde(default = "tcp_protocol")]
    pub protocol: String,
    /// Runtime-only target identity. Absent preserves the historical root
    /// guest forward; present routes to this principal's namespace `/32`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_target: Option<RuntimeTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeTarget {
    pub principal: String,
    pub address: Ipv4Addr,
}

impl PublishedPort {
    #[allow(dead_code)]
    pub fn for_runtime(host: u16, guest: u16, principal: &str, address: Ipv4Addr) -> Result<Self> {
        validate_principal(principal)?;
        if address.octets()[3] < 10
            || address == Ipv4Addr::new(192, 168, 127, 255)
            || address.octets()[..3] != crate::netstack::GUEST_IP.octets()[..3]
        {
            bail!("published runtime target must be in 192.168.127.10-254");
        }
        Ok(Self {
            host,
            container: guest,
            protocol: tcp_protocol(),
            runtime_target: Some(RuntimeTarget { principal: principal.to_string(), address }),
        })
    }
}

fn tcp_protocol() -> String {
    "tcp".to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
pub struct RuntimeMount {
    pub principal: String,
    pub slot: String,
    pub tag: String,
    pub host: String,
    pub guest: String,
    pub writable: bool,
}

impl RuntimeMount {
    #[allow(dead_code)]
    pub fn granted(
        principal: &str,
        slot: &str,
        host: &str,
        guest: &str,
        manifest_requests_write: bool,
        user_grants_write: bool,
    ) -> Result<Self> {
        validate_principal(principal)?;
        if !safe_identity_component(slot) {
            bail!("mount slot must be a non-empty safe identity component");
        }
        if !guest.starts_with('/') || guest.contains("/../") || guest.ends_with("/..") {
            bail!("mount guest path must be absolute and normalized");
        }
        Ok(Self {
            principal: principal.to_string(),
            slot: slot.to_string(),
            tag: runtime_mount_tag(principal, slot)?,
            host: host.to_string(),
            guest: guest.to_string(),
            writable: manifest_requests_write && user_grants_write,
        })
    }
}

#[allow(dead_code)]
pub fn runtime_mount_tag(principal: &str, slot: &str) -> Result<String> {
    validate_principal(principal)?;
    if !safe_identity_component(slot) {
        bail!("mount slot must be a non-empty safe identity component");
    }
    let digest = crate::images::content_sha256_hex(format!("{principal}/{slot}").as_bytes());
    Ok(format!("ap-{}", &digest[..32]))
}

#[allow(dead_code)]
fn safe_identity_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

#[allow(dead_code)]
fn validate_principal(principal: &str) -> Result<()> {
    let mut parts = principal.split('/');
    if !parts.by_ref().all(safe_identity_component) || principal.matches('/').count() > 1 {
        bail!("principal must be '<app>' or '<app>/<service>' using safe components");
    }
    Ok(())
}

// NOTE: the allocator below and its constants are exercised by the
// unit tests but not yet wired into a non-test caller — the consumer is
// the boot-dependent published-port forwarding (`host_services` reading
// `VmSpec::published` and calling `spawn_proxy`), which is the rest of
// E2.3 and out of scope for this pure slice. Allow dead_code here so the
// `-D warnings` gate stays green until that code lands.

/// The five canonical host ports reserved for ingress, kubernetes API,
/// registry, egress, and buildkit respectively. The default VM keeps
/// these; a published port may never reuse one (docs/sandbox.md §5,
/// finding C4).
#[allow(dead_code)]
pub const RESERVED_HOST_PORTS: [u16; 5] = [8081, 6443, 5052, 5053, 5054];

/// The deterministic-NodePort window `host_services` blanket-forwards
/// (`guest.rs:631`, `30000..=30050` inclusive). A published port must
/// stay clear of it so the two forwards can never collide.
#[allow(dead_code)]
pub const NODEPORT_FORWARD_RANGE: std::ops::RangeInclusive<u16> = 30000..=30050;

/// Host-port search range published container ports draw from. Starts
/// well above the per-VM four-port block base (8100) the resource
/// allocator hands out, and stops below the auto-forwarded NodePort
/// window so a published port can never shadow either.
#[allow(dead_code)]
const PUBLISHED_PORT_RANGE: std::ops::RangeInclusive<u16> = 20000..=29999;

/// The default VM name. The default VM keeps the canonical host ports
/// (8081/6443/5052/5053/5054) for backward compatibility and parity
/// with the k3d runtime; additional VMs get allocated distinct blocks.
pub const DEFAULT_VM_NAME: &str = "appliance";

/// Default virtual CPU count for a fresh VM.
pub const DEFAULT_CPUS: usize = 2;
/// Default guest memory (MiB) for a fresh VM. 4 GiB comfortably runs
/// k3s plus a couple of small workloads.
pub const DEFAULT_MEMORY_MIB: u64 = 4096;
/// Default data disk size (GiB) for a fresh VM.
pub const DEFAULT_DISK_GIB: u64 = 10;
/// Floor for guest memory. Virtualization.framework rejects anything
/// below 1 MiB, and k3s won't survive far above that floor — keep a
/// usable minimum so a typo can't produce a VM that never boots.
pub const MIN_MEMORY_MIB: u64 = 512;

impl VmSpec {
    pub fn defaults(name: &str) -> Self {
        Self::defaults_for_backend(name, crate::backend::platform_backend_name())
    }

    fn defaults_for_backend(name: &str, backend: &str) -> Self {
        let mut spec = Self {
            name: name.to_string(),
            cpus: DEFAULT_CPUS,
            memory_mib: DEFAULT_MEMORY_MIB,
            disk_gib: DEFAULT_DISK_GIB,
            image: crate::images::DEFAULT_IMAGE.to_string(),
            // hvc0 is the virtio console the vz/kvm backends attach the
            // log file to. `quiet` is deliberately absent — boot logs are
            // the primary debugging surface for a headless VM.
            cmdline: crate::guest::guest_cmdline(),
            mac: random_mac(),
            host_port: 8081,
            api_port: 6443,
            registry_port: 5052,
            egress_port: 5053,
            buildkit_port: 5054,
            dev: false,
            dev_mount: None,
            docker: false,
            agent_only: false,
            runtime: false,
            cluster: false,
            published: Vec::new(),
            runtime_mounts: Vec::new(),
            net_link: NetLink::Nat,
            wsl_mode: global_wsl_mode(),
        };
        spec.normalise_net_link_for_backend(backend);
        spec
    }

    /// The runtime design doc's fixed pooled profile: core supervisor readiness only,
    /// no k3s, Docker, or development toolchain.
    pub fn runtime_defaults(name: &str) -> Self {
        Self::runtime_defaults_for_backend(name, crate::backend::platform_backend_name())
    }

    fn runtime_defaults_for_backend(name: &str, backend: &str) -> Self {
        let mut spec = Self::defaults_for_backend(name, backend);
        spec.agent_only = true;
        spec.runtime = true;
        spec.dev = false;
        spec.docker = false;
        spec.cluster = false;
        spec.net_link = NetLink::Netstack;
        spec.image = crate::images::RUNTIME_IMAGE.to_string();
        spec.cmdline = crate::guest::runtime_guest_cmdline();
        spec.normalise_net_link_for_backend(backend);
        spec
    }

    /// The link this VM should actually use, honouring the global
    /// `APPLIANCE_NETSTACK=1` override (CI/testing) over the persisted
    /// per-VM value on supported backends. WSL always resolves to NAT.
    pub fn net_link(&self) -> NetLink {
        let forced = std::env::var("APPLIANCE_NETSTACK").map(|v| v == "1").unwrap_or(false);
        resolve_net_link(
            self.net_link,
            forced,
            crate::backend::platform_backend_name(),
        )
    }

    /// Resolve and persist the honest link for a backend. WSL has no
    /// host netstack attachment, so even a legacy/forced Netstack value
    /// becomes NAT and its egress boundary remains the cooperative proxy.
    pub fn normalise_net_link_for_backend(&mut self, backend: &str) -> bool {
        let resolved = resolve_net_link(self.net_link, false, backend);
        if resolved == self.net_link {
            return false;
        }
        if backend == "wsl" {
            warn_wsl_cooperative_boundary_once();
        }
        self.net_link = resolved;
        true
    }

    /// Resolve the five host ports for `name` so multiple VMs can run
    /// concurrently without colliding. An existing VM keeps its ports;
    /// the default VM gets the canonical block; any other new VM gets
    /// the lowest free contiguous block of five from 8100 upward
    /// (ingress, api, registry, egress, buildkit).
    pub fn allocate_ports(name: &str) -> (u16, u16, u16, u16, u16) {
        if let Ok(Some(existing)) = crate::store::load_spec(name) {
            return (
                existing.host_port,
                existing.api_port,
                existing.registry_port,
                existing.egress_port,
                existing.buildkit_port,
            );
        }
        if name == DEFAULT_VM_NAME {
            return (8081, 6443, 5052, 5053, 5054);
        }
        let mut used: std::collections::HashSet<u16> = RESERVED_HOST_PORTS.into_iter().collect();
        for spec in crate::store::list_specs() {
            used.extend([
                spec.host_port,
                spec.api_port,
                spec.registry_port,
                spec.egress_port,
                spec.buildkit_port,
            ]);
        }
        let mut slot: u16 = 0;
        loop {
            let base = 8100 + slot * 5;
            let block = [base, base + 1, base + 2, base + 3, base + 4];
            if block.iter().all(|p| !used.contains(p)) {
                return (block[0], block[1], block[2], block[3], block[4]);
            }
            slot += 1;
        }
    }

    /// Allocate a free host loopback port for a container-published
    /// port, drawing from this VM's host-port range. Refuses, in code
    /// (docs/sandbox.md §5, security finding C4), the four reserved
    /// ports (ingress/api/registry/egress) and the auto-forwarded
    /// NodePort window `30000-30050` — both are already blanket-bound on
    /// the host (`guest.rs:host_services`), so handing one out would
    /// guarantee a collision. Also skips any host port in `used`
    /// (this VM's existing published ports plus the caller's reserved
    /// set). Returns the lowest free port, or `None` when the range is
    /// exhausted — never a reserved one.
    #[allow(dead_code)]
    pub fn allocate_published_port(used: &std::collections::HashSet<u16>) -> Option<u16> {
        PUBLISHED_PORT_RANGE.clone().find(|&port| {
            !RESERVED_HOST_PORTS.contains(&port)
                && !NODEPORT_FORWARD_RANGE.contains(&port)
                && !used.contains(&port)
        })
    }

    /// Apply optional per-VM resource overrides in place, validating
    /// them so an absurd value fails fast instead of producing a VM
    /// that can't boot. `None` leaves the existing value untouched, so
    /// re-running `up` without the flags preserves a VM's prior sizing.
    /// Returns whether anything actually changed (the caller persists
    /// only on a change to avoid needless spec rewrites).
    pub fn apply_resource_overrides(
        &mut self,
        cpus: Option<usize>,
        memory_mib: Option<u64>,
    ) -> anyhow::Result<bool> {
        let mut changed = false;
        if let Some(cpus) = cpus {
            if cpus == 0 {
                anyhow::bail!("--cpus must be at least 1");
            }
            if cpus != self.cpus {
                self.cpus = cpus;
                changed = true;
            }
        }
        if let Some(memory_mib) = memory_mib {
            if memory_mib < MIN_MEMORY_MIB {
                anyhow::bail!("--memory must be at least {MIN_MEMORY_MIB} MiB");
            }
            if memory_mib != self.memory_mib {
                self.memory_mib = memory_mib;
                changed = true;
            }
        }
        Ok(changed)
    }
}

fn global_wsl_mode() -> WslMode {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    wsl_mode_from_settings_path(&home.join(".appliance").join("settings.json"))
}

fn wsl_mode_from_settings_path(path: &std::path::Path) -> WslMode {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return WslMode::Strict;
    };
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|value| value.get("wslMode").and_then(serde_json::Value::as_str).map(str::to_owned))
        .and_then(|mode| match mode.to_ascii_lowercase().as_str() {
            "strict" => Some(WslMode::Strict),
            "cooperative" => Some(WslMode::Cooperative),
            _ => None,
        })
        .unwrap_or(WslMode::Strict)
}

/// Resolve the effective link. WSL wins over both persisted state and the
/// force-on override; supported backends otherwise preserve the historical
/// override precedence. Pure so tests do not touch the process environment.
fn resolve_net_link(persisted: NetLink, forced: bool, backend: &str) -> NetLink {
    if backend == "wsl" {
        return NetLink::Nat;
    }
    match (persisted, forced) {
        (_, true) => NetLink::Netstack,
        (link, false) => link,
    }
}

fn warn_wsl_cooperative_boundary_once() {
    static WARNED: std::sync::Once = std::sync::Once::new();
    WARNED.call_once(|| {
        eprintln!("warn: WSL backend: egress is a cooperative proxy, not host-enforced");
    });
}

/// Locally administered, unicast MAC (x2:…): bit 1 of the first octet
/// set (local), bit 0 clear (unicast).
fn random_mac() -> String {
    let mut bytes = [0u8; 6];
    // No external RNG dependency: hash process entropy sources.
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
        ^ (std::process::id() as u128) << 64;
    for (i, slot) in bytes.iter_mut().enumerate() {
        *slot = ((seed >> (i * 8)) & 0xff) as u8;
    }
    bytes[0] = (bytes[0] & 0xfe) | 0x02;
    format!(
        "{:02x}:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]
    )
}

/// Where a VM keeps its state on the host.
#[derive(Debug, Clone)]
pub struct VmPaths {
    pub dir: PathBuf,
}

impl VmPaths {
    pub fn for_name(name: &str) -> Self {
        Self {
            dir: crate::store::vm_root().join(name),
        }
    }
    pub fn spec(&self) -> PathBuf {
        self.dir.join("vm.json")
    }
    pub fn disk(&self) -> PathBuf {
        self.dir.join("data.img")
    }
    pub fn console_log(&self) -> PathBuf {
        self.dir.join("console.log")
    }
    pub fn pidfile(&self) -> PathBuf {
        self.dir.join("vm.pid")
    }
    pub fn kubeconfig(&self) -> PathBuf {
        self.dir.join("kubeconfig.yaml")
    }
    /// The independent core-ready marker written once the guest's
    /// k3s-independent vsock shell answers a trivial command.
    pub fn core_ready(&self) -> PathBuf {
        self.dir.join("core-ready")
    }
    /// The readiness marker an agent-only VM writes once its agent
    /// runtime (vsock shell + Node) answers — the sibling of
    /// `kubeconfig()` that `up`/`status`/`list` poll on for an agent-only
    /// spec (there is no k3s kubeconfig to wait for).
    pub fn agent_ready(&self) -> PathBuf {
        self.dir.join("agent-ready")
    }
    pub fn guest_ip(&self) -> PathBuf {
        self.dir.join("guest-ip")
    }
    /// The guest's default-gateway address (where the host answers on the
    /// VM NAT), recorded at boot by backends whose NAT prefix isn't the
    /// vz /24 (WSL uses a /20 and the gateway is NOT `<guest>/24`.1).
    /// `egress::guest_proxy_url` prefers this over its /24 derivation.
    pub fn gateway_ip(&self) -> PathBuf {
        self.dir.join("gateway-ip")
    }
    /// Prefix length paired with the WSL lease. Kept across boots with
    /// `gateway-ip` so the egress proxy can admit the new guest from the
    /// real WSL /20 during the short window before its exact lease lands.
    pub fn guest_prefix_len(&self) -> PathBuf {
        self.dir.join("guest-prefix-len")
    }
    pub fn host_log(&self) -> PathBuf {
        self.dir.join("host.log")
    }
    /// Cross-platform stop request: `appliance-vm stop` drops this file
    /// and the resident host process's parking loop acts on it. On Unix
    /// SIGTERM is the primary channel and this file is the fallback; on
    /// Windows (no SIGTERM) it is the only one. Cleared on every boot.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn stop_request(&self) -> PathBuf {
        self.dir.join("stop.request")
    }
    /// Per-VM Unix socket the resident host process serves: it bridges
    /// each connection to a fresh guest vsock shell. `appliance-vm
    /// shell` connects here. Unix engines only — the Windows client
    /// rides `wsl.exe` instead, so no relay socket exists there.
    #[cfg_attr(windows, allow(dead_code))]
    pub fn shell_sock(&self) -> PathBuf {
        self.dir.join("shell.sock")
    }
    /// Owner-only control socket served by the resident Runtime host.
    /// Reconciliation processes request published forwards here so new
    /// apps do not require a pooled-VM restart merely to bind host ports.
    #[cfg_attr(windows, allow(dead_code))]
    pub fn runtime_forward_sock(&self) -> PathBuf {
        self.dir.join("runtime-forward.sock")
    }
}

/// Runtime status reported by `status`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VmStatus {
    pub name: String,
    pub exists: bool,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<i32>,
    pub backend: &'static str,
    /// True once the cluster answers (kubeconfig fetched *and* the host
    /// process is alive). Distinct from `running`, which only means the
    /// host/VM process is up — a VM can be running while k3s is still
    /// coming up or has failed. Lets the UI tell "VM up, cluster
    /// starting" from "ready".
    pub cluster_ready: bool,
    /// True once the k3s-independent vsock shell primitive answers.
    pub core_ready: bool,
    /// Whether the persisted spec includes the lazy cluster layer.
    pub cluster: bool,
    /// The current bring-up stage while a VM is starting (media, booting,
    /// network, cluster + its sub-phases, ready, failed). `None` when not
    /// running.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<crate::bringup::Phase>,
    /// Free-text context for `phase` (guest IP, what ingress is waiting
    /// on, the failure reason) — the desktop renders it as the live
    /// detail line under the in-flight rung.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase_detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Forwarded host ports (present once the VM is defined).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registry_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub egress_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buildkit_port: Option<u16>,
    /// Whether this VM is provisioned as a development environment.
    pub dev: bool,
}

fn default_registry_port() -> u16 {
    5052
}

fn default_egress_port() -> u16 {
    5053
}

fn default_buildkit_port() -> u16 {
    5054
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_macs_are_locally_administered_unicast() {
        let mac = random_mac();
        let first = u8::from_str_radix(&mac[0..2], 16).unwrap();
        assert_eq!(first & 0x01, 0, "must be unicast");
        assert_eq!(first & 0x02, 0x02, "must be locally administered");
        assert_eq!(mac.split(':').count(), 6);
    }

    #[test]
    fn resource_overrides_apply_validate_and_preserve() {
        let mut spec = VmSpec::defaults("x");
        // None leaves both values untouched and reports no change.
        assert!(!spec.apply_resource_overrides(None, None).unwrap());
        assert_eq!(spec.cpus, DEFAULT_CPUS);
        assert_eq!(spec.memory_mib, DEFAULT_MEMORY_MIB);

        // A real override mutates the spec and reports the change.
        assert!(spec.apply_resource_overrides(Some(4), Some(8192)).unwrap());
        assert_eq!(spec.cpus, 4);
        assert_eq!(spec.memory_mib, 8192);

        // Re-applying the same values is a no-op (no needless rewrite).
        assert!(!spec.apply_resource_overrides(Some(4), Some(8192)).unwrap());

        // Out-of-range values fail fast and don't mutate the spec.
        assert!(spec.apply_resource_overrides(Some(0), None).is_err());
        assert!(spec.apply_resource_overrides(None, Some(0)).is_err());
        assert_eq!(spec.cpus, 4);
        assert_eq!(spec.memory_mib, 8192);
    }

    #[test]
    fn spec_round_trips_through_json_with_defaults() {
        // Old persisted specs lack registry_port — must still parse.
        let legacy = r#"{"name":"x","cpus":2,"memoryMib":4096,"diskGib":10,"image":"alpine-3.21.3","cmdline":"console=hvc0","mac":"02:00:00:00:00:01","hostPort":8081,"apiPort":6443}"#;
        let spec: VmSpec = serde_json::from_str(legacy).unwrap();
        assert_eq!(spec.registry_port, 5052);
        // Old specs predate the buildkit port — it must default to 5054.
        assert_eq!(spec.buildkit_port, 5054);
        // Old specs predate the dev flag — it must default to off.
        assert!(!spec.dev);
        // Old specs predate the docker flag too — default off.
        assert!(!spec.docker);
        // AP-205 is fail-safe for every legacy WSL Runtime spec.
        assert_eq!(spec.wsl_mode, WslMode::Strict);
    }

    #[test]
    fn wsl_mode_round_trips_and_global_config_defaults_fail_closed() {
        let mut spec = VmSpec::defaults("runtime");
        spec.wsl_mode = WslMode::Cooperative;
        let json = serde_json::to_string(&spec).unwrap();
        assert!(json.contains("\"wslMode\":\"cooperative\""));
        let back: VmSpec = serde_json::from_str(&json).unwrap();
        assert_eq!(back.wsl_mode, WslMode::Cooperative);

        let root = std::env::temp_dir().join(format!(
            "appliance-wsl-mode-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let settings = root.join("settings.json");
        assert_eq!(wsl_mode_from_settings_path(&settings), WslMode::Strict);
        std::fs::write(&settings, r#"{"wslMode":"cooperative"}"#).unwrap();
        assert_eq!(wsl_mode_from_settings_path(&settings), WslMode::Cooperative);
        std::fs::write(&settings, r#"{"wslMode":"unsafe"}"#).unwrap();
        assert_eq!(wsl_mode_from_settings_path(&settings), WslMode::Strict);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn buildkit_port_round_trips_as_camel_case() {
        let mut spec = VmSpec::defaults("x");
        assert_eq!(spec.buildkit_port, 5054, "fresh specs get the canonical buildkit port");
        spec.buildkit_port = 8104;
        let json = serde_json::to_string(&spec).unwrap();
        assert!(json.contains("\"buildkitPort\":8104"), "wire form is camelCase buildkitPort");
        let back: VmSpec = serde_json::from_str(&json).unwrap();
        assert_eq!(back.buildkit_port, 8104);
    }

    #[test]
    fn allocate_published_port_never_returns_a_reserved_or_nodeport() {
        use std::collections::HashSet;
        // With nothing used, the allocator returns the lowest port in
        // its range — and it is neither reserved nor in the NodePort
        // window.
        let port = VmSpec::allocate_published_port(&HashSet::new()).unwrap();
        assert!(!RESERVED_HOST_PORTS.contains(&port));
        assert!(!NODEPORT_FORWARD_RANGE.contains(&port));

        // Even if the caller marks everything *except* a reserved port
        // and a NodePort-window port as used, the allocator refuses both
        // and keeps searching rather than handing one out.
        let mut used: HashSet<u16> = PUBLISHED_PORT_RANGE.clone().collect();
        // Free up exactly two slots: one reserved-valued (which is below
        // the range anyway) and the bottom of the NodePort window.
        used.remove(&20000);
        let port = VmSpec::allocate_published_port(&used).unwrap();
        assert_eq!(port, 20000, "the one free in-range slot must be chosen");
        for &reserved in &RESERVED_HOST_PORTS {
            assert_ne!(port, reserved);
        }
        for nodeport in NODEPORT_FORWARD_RANGE {
            assert_ne!(port, nodeport);
        }
    }

    #[test]
    fn allocate_published_port_skips_used_and_errors_when_exhausted() {
        use std::collections::HashSet;
        // The lowest in-range port marked used is skipped for the next.
        let mut used: HashSet<u16> = HashSet::new();
        let first = VmSpec::allocate_published_port(&used).unwrap();
        used.insert(first);
        let second = VmSpec::allocate_published_port(&used).unwrap();
        assert!(second > first, "a used port must not be handed out twice");
        assert!(!used.contains(&second));

        // Marking the whole range used exhausts the allocator: it
        // returns None rather than falling back to a reserved port.
        let all: HashSet<u16> = PUBLISHED_PORT_RANGE.clone().collect();
        assert_eq!(VmSpec::allocate_published_port(&all), None);
    }

    #[test]
    fn published_ports_round_trip_and_default_empty_for_legacy_specs() {
        // A legacy spec predates the published field — it must parse to
        // an empty vec, not fail.
        let legacy = r#"{"name":"x","cpus":2,"memoryMib":4096,"diskGib":10,"image":"alpine-3.21.3","cmdline":"console=hvc0","mac":"02:00:00:00:00:01","hostPort":8081,"apiPort":6443}"#;
        let spec: VmSpec = serde_json::from_str(legacy).unwrap();
        assert!(spec.published.is_empty(), "legacy specs default to no published ports");

        // A populated published map survives a JSON round-trip with its
        // host→container mapping intact.
        let mut spec = VmSpec::defaults("x");
        assert!(spec.published.is_empty(), "fresh specs publish nothing");
        spec.published = vec![
            PublishedPort { host: 20000, container: 8080, protocol: tcp_protocol(), runtime_target: None },
            PublishedPort { host: 20001, container: 5432, protocol: tcp_protocol(), runtime_target: None },
        ];
        let json = serde_json::to_string(&spec).unwrap();
        let back: VmSpec = serde_json::from_str(&json).unwrap();
        assert_eq!(back.published, spec.published);
        let legacy_port: PublishedPort =
            serde_json::from_str(r#"{"host":20002,"container":3000}"#).unwrap();
        assert_eq!(legacy_port.protocol, "tcp");
        // camelCase: the container field serializes as `container`,
        // host as `host`.
        assert!(json.contains("\"host\":20000"));
        assert!(json.contains("\"container\":8080"));
    }

    #[test]
    fn net_link_defaults_to_nat_for_legacy_and_fresh_specs() {
        // A legacy spec predates the field — it must parse to Nat, the
        // behaviour-neutral default, not fail or flip to Netstack.
        let legacy = r#"{"name":"x","cpus":2,"memoryMib":4096,"diskGib":10,"image":"alpine-3.21.3","cmdline":"console=hvc0","mac":"02:00:00:00:00:01","hostPort":8081,"apiPort":6443}"#;
        let spec: VmSpec = serde_json::from_str(legacy).unwrap();
        assert_eq!(spec.net_link, NetLink::Nat);
        // A fresh spec is Nat too.
        assert_eq!(VmSpec::defaults("x").net_link, NetLink::Nat);

        // The flag round-trips and serialises lowercase (wire form the
        // desktop reads).
        let mut spec = VmSpec::defaults("x");
        spec.net_link = NetLink::Netstack;
        let json = serde_json::to_string(&spec).unwrap();
        assert!(json.contains("\"netLink\":\"netstack\""));
        let back: VmSpec = serde_json::from_str(&json).unwrap();
        assert_eq!(back.net_link, NetLink::Netstack);
    }

    #[test]
    fn netstack_env_override_only_forces_on() {
        // The global override forces Netstack regardless of the persisted
        // value, but never downgrades a VM persisted as Netstack.
        assert_eq!(resolve_net_link(NetLink::Nat, false, "vz"), NetLink::Nat);
        assert_eq!(resolve_net_link(NetLink::Nat, true, "vz"), NetLink::Netstack);
        assert_eq!(resolve_net_link(NetLink::Netstack, false, "vz"), NetLink::Netstack);
        assert_eq!(resolve_net_link(NetLink::Netstack, true, "vz"), NetLink::Netstack);
    }

    #[test]
    fn wsl_specs_create_and_load_as_nat_while_vz_is_unchanged() {
        let fresh = VmSpec::runtime_defaults_for_backend("runtime", "wsl");
        assert_eq!(fresh.net_link, NetLink::Nat);

        let mut persisted = VmSpec::defaults_for_backend("legacy", "vz");
        persisted.net_link = NetLink::Netstack;
        let raw = serde_json::to_string(&persisted).unwrap();
        let mut loaded: VmSpec = serde_json::from_str(&raw).unwrap();
        assert!(loaded.normalise_net_link_for_backend("wsl"));
        assert_eq!(loaded.net_link, NetLink::Nat);

        assert_eq!(
            VmSpec::runtime_defaults_for_backend("runtime", "vz").net_link,
            NetLink::Netstack
        );
        assert_eq!(resolve_net_link(NetLink::Netstack, true, "wsl"), NetLink::Nat);
    }

    #[test]
    fn docker_flag_round_trips_through_json() {
        // A docker-enabled spec serializes the flag and reads it back.
        let mut spec = VmSpec::defaults("x");
        assert!(!spec.docker, "default must be off");
        spec.docker = true;
        let json = serde_json::to_string(&spec).unwrap();
        let back: VmSpec = serde_json::from_str(&json).unwrap();
        assert!(back.docker, "docker flag must survive a JSON round-trip");

        // A serialized default spec carries docker:false explicitly.
        let default_json = serde_json::to_string(&VmSpec::defaults("x")).unwrap();
        let back: VmSpec = serde_json::from_str(&default_json).unwrap();
        assert!(!back.docker);
    }

    #[test]
    fn agent_only_flag_defaults_off_and_round_trips() {
        // A legacy spec predates the agent_only flag — it must parse to
        // false (the unchanged k3s path), not fail.
        let legacy = r#"{"name":"x","cpus":2,"memoryMib":4096,"diskGib":10,"image":"alpine-3.21.3","cmdline":"console=hvc0","mac":"02:00:00:00:00:01","hostPort":8081,"apiPort":6443}"#;
        let spec: VmSpec = serde_json::from_str(legacy).unwrap();
        assert!(!spec.agent_only, "legacy specs are not agent-only");
        // A fresh default spec is not agent-only either.
        assert!(!VmSpec::defaults("x").agent_only);

        // The flag serializes as camelCase `agentOnly` and round-trips.
        let mut spec = VmSpec::defaults("x");
        spec.agent_only = true;
        let json = serde_json::to_string(&spec).unwrap();
        assert!(json.contains("\"agentOnly\":true"), "wire form is camelCase agentOnly");
        let back: VmSpec = serde_json::from_str(&json).unwrap();
        assert!(back.agent_only, "agent_only must survive a JSON round-trip");
    }

    #[test]
    fn runtime_profile_is_core_only_and_netstack_enforced() {
        let spec = VmSpec::runtime_defaults_for_backend("appliance-runtime", "vz");
        assert_eq!(spec.name, "appliance-runtime");
        assert_eq!(spec.cpus, 2);
        assert_eq!(spec.memory_mib, 4096);
        assert_eq!(spec.disk_gib, 10);
        assert!(spec.agent_only);
        assert!(spec.runtime);
        assert!(!spec.dev);
        assert!(!spec.docker);
        assert!(!spec.cluster);
        assert_eq!(spec.net_link, NetLink::Netstack);
        assert_eq!(spec.image, crate::images::RUNTIME_IMAGE);
        assert!(spec.cmdline.contains("alpine_repo=auto"));
    }

    #[test]
    fn agent_ready_marker_is_a_sibling_of_kubeconfig() {
        // The agent-only readiness marker lives next to kubeconfig.yaml in
        // the same VM dir — `up` polls one or the other per spec.
        let paths = VmPaths::for_name("x");
        assert_eq!(paths.agent_ready().parent(), paths.kubeconfig().parent());
        assert_eq!(paths.agent_ready().file_name().unwrap(), "agent-ready");
    }

    #[test]
    fn core_ready_marker_is_a_sibling_of_other_readiness_markers() {
        let paths = VmPaths::for_name("marker-test");
        assert_eq!(paths.core_ready(), paths.dir.join("core-ready"));
    }

    #[test]
    fn fresh_and_fieldless_specs_default_to_core_only() {
        assert!(!VmSpec::defaults("fresh").cluster);
        let legacy = r#"{"name":"x","cpus":2,"memoryMib":4096,"diskGib":10,"image":"alpine-3.21.3","cmdline":"console=hvc0","mac":"02:00:00:00:00:01","hostPort":8081,"apiPort":6443}"#;
        let parsed: VmSpec = serde_json::from_str(legacy).unwrap();
        assert!(!parsed.cluster, "pre-field specs adopt the core-first default");
    }

    #[test]
    fn runtime_mount_tags_are_stable_bounded_and_write_is_intersection() {
        let tag = runtime_mount_tag("journal/indexer", "workspace").unwrap();
        assert!(tag.starts_with("ap-"));
        assert_eq!(tag.len(), 35);
        assert_eq!(tag, runtime_mount_tag("journal/indexer", "workspace").unwrap());
        assert_ne!(tag, runtime_mount_tag("journal/indexer", "cache").unwrap());

        let ro = RuntimeMount::granted(
            "journal/indexer", "workspace", "/host/journal", "/data", true, false,
        )
        .unwrap();
        assert!(!ro.writable, "manifest write request alone never grants write");
        let rw = RuntimeMount::granted(
            "journal/indexer", "workspace", "/host/journal", "/data", true, true,
        )
        .unwrap();
        assert!(rw.writable);
    }

    #[test]
    fn runtime_published_port_carries_principal_target() {
        let address = Ipv4Addr::new(192, 168, 127, 10);
        let port = PublishedPort::for_runtime(20_000, 3_000, "journal", address).unwrap();
        let target = port.runtime_target.unwrap();
        assert_eq!(target.principal, "journal");
        assert_eq!(target.address, address);
        assert!(PublishedPort::for_runtime(20_000, 3_000, "journal", crate::netstack::GUEST_IP).is_err());
    }
}
