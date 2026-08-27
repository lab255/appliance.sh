mod backend;
mod bringup;
mod creds;
mod doctor;
mod egress;
mod guest_exec;
// guest/images/net/netstack carry the vz/kvm boot-media and
// host-networking surfaces. They compile everywhere (their pure parts
// are unit-tested on every platform, and the WSL backend reuses several
// fragments), but only the macOS backend exercises all of them — so the
// dead-code lint is scoped off on Windows and stays live on macOS.
#[cfg_attr(windows, allow(dead_code))]
mod guest;
#[cfg_attr(windows, allow(dead_code))]
mod images;
mod mint;
mod mitm;
#[cfg_attr(windows, allow(dead_code))]
mod net;
#[cfg_attr(windows, allow(dead_code))]
mod netstack;
mod profiles;
mod shell;
mod spec;
mod store;
mod traffic;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use spec::{NetLink, PublishedPort, RuntimeShare, VmPaths, VmSpec, VmStatus};
use std::io::Read;
use std::net::SocketAddr;
use std::process::Command;

/// Appliance microVM manager. One executable, one backend per
/// platform (Virtualization.framework / KVM / WSL2), one guest
/// contract. See docs/microvm.md in the repo for the architecture.
#[derive(Parser)]
#[command(name = "appliance-vm", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Cmd,
}

const DEFAULT_VM: &str = "appliance";

#[derive(Subcommand)]
enum Cmd {
    /// Probe whether this machine can run microVMs. With --vm-checks,
    /// run runtime checks against a VM instead (clock skew, guest
    /// api-server reachability) and print a JSON findings report.
    Doctor {
        /// VM to run runtime checks against (JSON report on stdout).
        #[arg(long, value_name = "VM")]
        vm_checks: Option<String>,
        /// Print the named VM's guest api-server log tail, scrubbed of
        /// secret-shaped tokens — the support-bundle feed.
        #[arg(long, value_name = "VM", conflicts_with = "vm_checks")]
        apiserver_log: Option<String>,
        /// Byte budget for --apiserver-log.
        #[arg(long, default_value_t = 512 * 1024)]
        tail_bytes: usize,
        /// Emit JSON (the default for --vm-checks; opts the plain
        /// backend probe into a machine-readable verdict too).
        #[arg(long, default_value_t = false)]
        json: bool,
    },
    /// List all defined VMs with their ports and running state (JSON).
    List,
    /// Create (or update) a VM definition and its data disk.
    Create {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
        #[arg(long, default_value_t = spec::DEFAULT_CPUS)]
        cpus: usize,
        #[arg(long, default_value_t = spec::DEFAULT_MEMORY_MIB)]
        memory: u64,
        #[arg(long, default_value_t = spec::DEFAULT_DISK_GIB)]
        disk: u64,
        /// Provision this VM as a development environment (dev toolchain
        /// + persistent /persist/workspace you shell into).
        #[arg(long, default_value_t = false)]
        dev: bool,
        /// Share a host folder into the guest over VirtioFS, mounted at
        /// /persist/workspace (implies --dev).
        #[arg(long)]
        mount: Option<String>,
        /// Provision an in-guest Docker engine (dockerd) alongside k3s.
        #[arg(long, default_value_t = false)]
        docker: bool,
        /// Provision this VM as an agent-only sandbox (no k3s; gate on the
        /// agent runtime). Implies --dev.
        #[arg(long, default_value_t = false)]
        agent_only: bool,
        /// Create the fixed core-only pooled Appliance Runtime profile.
        #[arg(long, default_value_t = false, conflicts_with_all = ["dev", "mount", "docker"])]
        runtime: bool,
    },
    /// Start a VM in the background (creates it with defaults first if needed).
    Start {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
    },
    /// Start the VM and wait until its platform is actually ready:
    /// the core vsock shell by default, or the full lazy platform with
    /// --cluster.
    Up {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
        /// Seconds to wait for readiness before giving up. Readiness now
        /// covers the whole platform (not just the kubernetes endpoint),
        /// so the budget carries what used to be the CLI's serial waits.
        #[arg(long, default_value_t = 900)]
        timeout: u64,
        /// Virtual CPUs (persisted; defaults to the VM's current value,
        /// or 2 for a new VM). Takes effect on the next boot.
        #[arg(long)]
        cpus: Option<usize>,
        /// Guest memory in MiB (persisted; defaults to the VM's current
        /// value, or 4096 for a new VM). Takes effect on the next boot.
        #[arg(long)]
        memory: Option<u64>,
        /// Provision this VM as a development environment (persisted):
        /// installs a dev toolchain and a persistent /persist/workspace
        /// you shell into. Takes effect on the next boot; never silently
        /// turned back off.
        #[arg(long, default_value_t = false)]
        dev: bool,
        /// Share a host folder into the guest over VirtioFS, mounted at
        /// /persist/workspace ("edit on the host, run in the VM").
        /// Implies --dev. Persisted; applies on the next boot.
        #[arg(long)]
        mount: Option<String>,
        /// Stop sharing a previously-set host folder; the workspace
        /// reverts to the data disk on the next boot.
        #[arg(long, default_value_t = false)]
        no_mount: bool,
        /// Provision an in-guest Docker engine (dockerd) alongside k3s, so
        /// the VM can build and run containers / compose / devcontainers.
        /// Persisted; applies on the next boot; never silently turned off.
        #[arg(long, default_value_t = false)]
        docker: bool,
        /// Provision the lazy k3s/BuildKit/registry/api-server layer.
        /// Persisted one-way; promoting a running core VM performs a
        /// full stop/re-up so current boot media is rebuilt.
        #[arg(long, default_value_t = false, conflicts_with = "agent_only")]
        cluster: bool,
        /// Provision this VM as an agent-only sandbox: skip the k3s control
        /// plane entirely and gate readiness on the agent runtime (the
        /// vsock shell + Node) instead of kubeconfig. Implies --dev (the
        /// handoff waits on the dev toolchain's .dev-ready). Persisted;
        /// one-way, applies on the next boot; never silently turned off.
        #[arg(long, default_value_t = false)]
        agent_only: bool,
        /// Reconcile the fixed pooled Runtime profile: agent-only core
        /// readiness with no dev, Docker, or cluster layer.
        #[arg(long, default_value_t = false, conflicts_with_all = ["dev", "mount", "docker", "cluster"])]
        runtime: bool,
        /// Fail (exit non-zero) if the whole bring-up takes longer than
        /// this many seconds, even when it eventually succeeds. A
        /// regression tripwire for CI / perf work — readiness itself is
        /// unaffected.
        #[arg(long)]
        time_budget: Option<u64>,
    },
    /// Host a VM in the foreground until it stops. Used internally by
    /// `start`; handy directly when debugging a guest boot.
    Run {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
    },
    /// Gracefully stop a running VM.
    Stop {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
    },
    /// Report VM state as JSON.
    Status {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
    },
    /// Print per-phase timings from the last boot's bring-up history.
    Timings {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
    },
    /// Open an interactive shell in the guest over vsock (no SSH, no
    /// k3s) — or run a single command with `-- <cmd>`. Lands as the
    /// non-root `appliance` user; `--root` lands a root shell.
    Shell {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
        /// Land a root shell instead of dropping to the `appliance` user.
        #[arg(long, default_value_t = false)]
        root: bool,
        /// Attach to (or create) a reattachable named session `<id>`
        /// (tmux): it survives this client disconnecting and a desktop
        /// restart while the VM runs. Interactive only — ignored when a
        /// trailing command is given.
        #[arg(long, short = 's')]
        session: Option<String>,
        /// Command to run instead of an interactive shell.
        #[arg(trailing_var_arg = true)]
        command: Vec<String>,
    },
    /// List or kill reattachable shell sessions (tmux) inside the VM.
    Sessions {
        #[command(subcommand)]
        action: SessionsCmd,
    },
    /// Print the VM's console log (boot log, kernel messages).
    Console {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
        /// Follow the log as it grows.
        #[arg(long, short = 'f', default_value_t = false)]
        follow: bool,
    },
    /// Delete a VM definition, its disk, and logs.
    Delete {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
    },
    /// Push the host's wall-clock time into a running guest, once. The
    /// resident clock-sync keeps drift down while the VM runs; this is
    /// the on-demand recovery when a client still sees clock-skew 401s
    /// (e.g. after host sleep/resume).
    SyncClock {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
    },
    /// Control the VM's outbound traffic (egress proxy + policy).
    Egress {
        #[command(subcommand)]
        action: EgressCmd,
    },
    /// Manage per-host credential capture/injection (apiKeyHelper).
    Creds {
        #[command(subcommand)]
        action: CredsCmd,
    },
    /// Host↔guest lifecycle RPC for pooled packaged applications.
    Runtime {
        #[command(subcommand)]
        action: RuntimeCmd,
    },
}

#[derive(Subcommand)]
enum RuntimeCmd {
    /// Reconcile a validated app's boot-time share and published ports.
    Prepare { name: String, plan: String },
    /// Start one app through the guest Runtime supervisor.
    Start { name: String, plan: String },
    Stop { name: String, app: String },
    Status { name: String, app: String },
    Logs { name: String, app: String },
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimePreparePlan {
    app_id: String,
    share: RuntimePlanShare,
    ports: Vec<RuntimePlanPort>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimePlanShare {
    tag: String,
    host_path: String,
    read_only: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimePlanPort {
    name: String,
    host: u16,
    guest: u16,
    relay: u16,
    target: String,
}

#[derive(Subcommand)]
enum SessionsCmd {
    /// List the VM's reattachable shell sessions as JSON.
    List {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
        /// List root sessions (the separate root-owned tmux socket) instead
        /// of the default non-root `appliance` sessions. Root sessions are
        /// the ones created with `vm shell --root --session <id>`.
        #[arg(long, default_value_t = false)]
        root: bool,
    },
    /// Kill a reattachable shell session by id.
    Kill {
        /// Session id (as shown by `sessions list`).
        id: String,
        #[arg(long, default_value = DEFAULT_VM)]
        name: String,
        /// Kill a root session (the separate root-owned tmux socket) instead
        /// of a default non-root `appliance` session.
        #[arg(long, default_value_t = false)]
        root: bool,
    },
}

#[derive(Subcommand)]
enum CredsCmd {
    /// Print credential rules + stored secrets (masked) as JSON.
    List {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
    },
    /// Add or update a per-host credential rule.
    Add {
        /// Host suffix (e.g. api.openai.com).
        host: String,
        #[arg(long, default_value = DEFAULT_VM)]
        name: String,
        /// Capture the credential header off requests into the store.
        #[arg(long, default_value_t = false)]
        capture: bool,
        /// Inject the credential header onto outbound requests.
        #[arg(long, default_value_t = false)]
        inject: bool,
        /// Header to capture/inject (default: authorization).
        #[arg(long)]
        header: Option<String>,
        /// Command whose stdout is the credential to inject (apiKeyHelper).
        #[arg(long)]
        helper: Option<String>,
    },
    /// Remove a host's credential rule.
    Rm {
        host: String,
        #[arg(long, default_value = DEFAULT_VM)]
        name: String,
    },
    /// Manually store a secret for a host (e.g. paste an API key).
    Set {
        host: String,
        value: String,
        #[arg(long, default_value = DEFAULT_VM)]
        name: String,
        #[arg(long)]
        header: Option<String>,
    },
    /// Forget all stored secrets (rules are kept).
    Forget {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
    },
}

#[derive(Subcommand)]
enum EgressCmd {
    /// Run the egress proxy in the foreground until killed.
    Proxy {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
        /// Address to listen on (host:port).
        #[arg(long)]
        addr: Option<String>,
        /// Log every allow/deny decision to stderr.
        #[arg(long, default_value_t = false)]
        log: bool,
    },
    /// Print the VM's current egress policy as JSON. For a Netstack VM
    /// this is the EFFECTIVE policy enforced at the boundary (default-Deny
    /// plus the baked allowlist plus your rules), not the permissive
    /// persisted default. A NAT VM prints its persisted policy unchanged.
    Policy {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
    },
    /// Show the EFFECTIVE egress policy as a readable report —
    /// distinguishing the baked allowlist, your allow rules, and your
    /// deny rules. For a Netstack VM the default is Deny (host-enforced)
    /// even though the persisted file keeps the serde-default allow.
    List {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
    },
    /// Show blocked egress attempts (host + count + last-seen) and the
    /// exact `egress allow` command to permit each — the blocked→allow
    /// loop that turns an opaque "it hung" into a one-line fix.
    Denied {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
        /// Most-recent traffic events to scan for denials.
        #[arg(long, default_value_t = 1000)]
        tail: usize,
    },
    /// Set the default action when no rule matches (allow | deny).
    Default {
        action: String,
        #[arg(long, default_value = DEFAULT_VM)]
        name: String,
    },
    /// Add an allow rule (host suffix, e.g. github.com).
    Allow {
        host: String,
        #[arg(long, default_value = DEFAULT_VM)]
        name: String,
    },
    /// Add a deny rule (host suffix). Deny wins over allow.
    Deny {
        host: String,
        #[arg(long, default_value = DEFAULT_VM)]
        name: String,
    },
    /// Remove a single operator allow/deny rule for an exact host — the
    /// per-rule counterpart of `reset` (which nukes every rule).
    /// Incremental: load → drop this exact host from both lists → save.
    Remove {
        host: String,
        #[arg(long, default_value = DEFAULT_VM)]
        name: String,
    },
    /// Clear all rules and reset to the permissive default.
    Reset {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
    },
    /// Print the path to the VM's egress CA cert (generating it on
    /// first use). Inject this into the guest trust store to let the
    /// proxy intercept TLS.
    Ca {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
    },
    /// Enable or disable TLS interception (MITM) on allowed HTTPS.
    Mitm {
        /// on | off
        state: String,
        #[arg(long, default_value = DEFAULT_VM)]
        name: String,
    },
    /// Print the proxy URL guest workloads should use (and the CA path
    /// when interception is on) — the values to inject as HTTPS_PROXY
    /// + trusted CA so the VM's egress flows through the proxy.
    Gateway {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
    },
    /// Publish the current policy into the cluster (the api-server
    /// reads it to inject proxy + CA into workloads). Runs
    /// automatically after policy changes and on `vm up`.
    Sync {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
    },
    /// Print recorded egress traffic (one JSON event per line / array)
    /// — the live feed the desktop traffic view consumes.
    Log {
        #[arg(default_value = DEFAULT_VM)]
        name: String,
        /// Maximum number of most-recent events to print.
        #[arg(long, default_value_t = 200)]
        tail: usize,
        /// Forget all recorded traffic instead of printing.
        #[arg(long, default_value_t = false)]
        clear: bool,
    },
}

fn main() {
    if let Err(err) = run() {
        eprintln!("error: {err:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    let backend = backend::platform_backend();

    match cli.command {
        Cmd::Doctor { vm_checks, apiserver_log, tail_bytes, json } => {
            // Support-bundle feed: the scrubbed guest api-server log.
            if let Some(name) = apiserver_log {
                match doctor::apiserver_log_tail(&name, tail_bytes) {
                    Ok(text) => {
                        print!("{text}");
                        if !text.ends_with('\n') {
                            println!();
                        }
                        return Ok(());
                    }
                    Err(e) => bail!("apiserver log tail for '{name}': {e}"),
                }
            }
            // Runtime checks against one VM — always JSON (the CLI's
            // runtime doctor folds the findings in verbatim).
            if let Some(name) = vm_checks {
                let report = doctor::run_vm_checks(&name);
                println!("{}", serde_json::to_string_pretty(&report)?);
                return Ok(());
            }
            // Legacy backend probe, unchanged (plus an opt-in JSON form).
            match backend.availability() {
                Ok(()) => {
                    if json {
                        println!(
                            "{}",
                            serde_json::json!({ "ok": true, "backend": backend.name() })
                        );
                    } else {
                        println!("ok: backend '{}' is available", backend.name());
                    }
                }
                Err(err) => {
                    if json {
                        println!(
                            "{}",
                            serde_json::json!({ "ok": false, "backend": backend.name(), "error": format!("{err:#}") })
                        );
                    } else {
                        println!("unavailable: {err:#}");
                    }
                    std::process::exit(1);
                }
            }
            Ok(())
        }

        Cmd::Create {
            name,
            cpus,
            memory,
            disk,
            dev,
            mount,
            docker,
            agent_only,
            runtime,
        } => {
            // A shared host folder only makes sense in a dev environment,
            // so --mount implies --dev. Agent-only implies --dev too: its
            // readiness handoff waits on the dev toolchain's .dev-ready.
            let dev_mount = match mount.as_deref() {
                Some(path) => Some(resolve_mount(path)?),
                None => None,
            };
            let dev = if runtime { false } else { dev || dev_mount.is_some() || agent_only };
            // Allocate a non-colliding port block so this VM can run
            // alongside others (the default VM keeps the canonical
            // 8081/6443/5052/5053; an existing VM keeps its ports).
            let (host_port, api_port, registry_port, egress_port, buildkit_port) =
                VmSpec::allocate_ports(&name);
            let mut spec = if runtime {
                VmSpec::runtime_defaults(&name)
            } else {
                VmSpec::defaults(&name)
            };
            spec = VmSpec {
                cpus,
                memory_mib: memory,
                disk_gib: disk,
                host_port,
                api_port,
                registry_port,
                egress_port,
                buildkit_port,
                dev,
                dev_mount,
                docker,
                agent_only: agent_only || runtime,
                runtime,
                net_link: if runtime { NetLink::Netstack } else { spec.net_link },
                ..spec
            };
            store::save_spec(&spec)?;
            store::ensure_disk(&spec)?;
            prefetch_boot_artifacts(&spec)?;
            println!(
                "created VM '{name}' ({cpus} cpus, {memory} MiB, {disk} GiB disk{})",
                if dev { ", dev environment" } else { "" }
            );
            println!("  ingress :{host_port}  kubernetes :{api_port}  registry :{registry_port}  egress :{egress_port}  buildkit :{buildkit_port}");
            Ok(())
        }

        Cmd::Start { name } => {
            backend.availability()?;
            if let Some(pid) = store::read_live_pid(&name) {
                println!("VM '{name}' is already running (pid {pid})");
                return Ok(());
            }
            let spec = ensure_spec(&name)?;
            store::ensure_disk(&spec)?;
            prefetch_boot_artifacts(&spec)?;

            // Re-exec ourselves detached to host the VM: the hypervisor
            // session lives inside a process, so something must stay
            // resident. Spawning the same binary keeps it to one
            // executable, and gives every backend identical daemon
            // semantics.
            let child = spawn_host_process(&name, bringup::DEFAULT_BUDGET_SECS)?;
            println!("starting VM '{name}' (host pid {})", child.id());
            println!("console: appliance-vm console {name} -f");
            Ok(())
        }

        Cmd::Up {
            name,
            timeout,
            cpus,
            memory,
            dev,
            mount,
            no_mount,
            docker,
            cluster,
            agent_only,
            runtime,
            time_budget,
        } => {
            let up_started = std::time::Instant::now();
            backend.availability()?;
            let mut spec = ensure_spec(&name)?;
            // Persist resource overrides into the spec *before* spawning
            // the host process — `run` reads sizing from disk, and a
            // persisted spec is what makes the new sizing survive a
            // restart. A running VM keeps its current sizing until the
            // next boot, so warn rather than silently mislead.
            let resized = spec.apply_resource_overrides(cpus, memory)?;
            // `--dev` is a one-way toggle: it promotes a VM to a dev
            // environment but its absence never demotes one, mirroring
            // the "None preserves" semantics of the resource overrides.
            let was_dev = spec.dev;
            if dev {
                spec.dev = true;
            }
            // `--docker` is a one-way toggle too: it provisions dockerd but
            // its absence never deprovisions, matching --dev's semantics.
            let was_docker = spec.docker;
            if docker {
                spec.docker = true;
            }
            // `--cluster` is a one-way promotion like `--docker`, but it
            // must take effect immediately through a full re-up: the
            // current CLI's staged api-server is part of boot media and
            // must never be injected into a running guest.
            let was_cluster = spec.cluster;
            if cluster {
                if spec.agent_only {
                    bail!("an agent-only VM cannot be promoted to --cluster");
                }
                spec.cluster = true;
            }
            // `--agent-only` is a one-way toggle as well, and it carries the
            // invariant `agent_only ⟹ dev`: the agent-handoff readiness gate
            // waits on the dev toolchain's .dev-ready, so force dev on too.
            let was_agent_only = spec.agent_only;
            if runtime {
                if spec.cluster || spec.dev || spec.docker || spec.dev_mount.is_some() {
                    bail!("the Runtime profile cannot reuse a dev, Docker, mounted-workspace, or cluster VM");
                }
                spec.runtime = true;
                spec.agent_only = true;
                spec.net_link = NetLink::Netstack;
                spec.image = images::RUNTIME_IMAGE.to_string();
                spec.cmdline = guest::runtime_guest_cmdline();
            } else if agent_only {
                spec.agent_only = true;
                spec.dev = true;
            }
            // Mount override: --no-mount stops sharing; --mount sets or
            // replaces the shared host folder (and implies a dev env).
            let mount_changed = if no_mount {
                spec.dev_mount.take().is_some()
            } else if let Some(path) = mount.as_deref() {
                let abs = resolve_mount(path)?;
                let changed = spec.dev_mount.as_deref() != Some(abs.as_str());
                spec.dev_mount = Some(abs);
                spec.dev = true;
                changed
            } else {
                false
            };
            let dev_enabled = spec.dev && !was_dev;
            let docker_enabled = spec.docker && !was_docker;
            let cluster_enabled = spec.cluster && !was_cluster;
            let agent_only_enabled = spec.agent_only && !was_agent_only;
            let runtime_enabled = runtime && spec.runtime;
            if resized || dev_enabled || mount_changed || docker_enabled || cluster_enabled || agent_only_enabled || runtime_enabled {
                store::save_spec(&spec)?;
                if store::read_live_pid(&name).is_some() {
                    if resized {
                        println!(
                            "note: VM '{name}' is already running — new sizing ({} cpus, {} MiB) applies on its next boot",
                            spec.cpus, spec.memory_mib
                        );
                    }
                    if dev_enabled {
                        println!(
                            "note: VM '{name}' is already running — dev provisioning applies on its next boot"
                        );
                    }
                    if docker_enabled {
                        println!(
                            "note: VM '{name}' is already running — docker provisioning applies on its next boot"
                        );
                    }
                    if cluster_enabled {
                        println!("promoting VM '{name}' to the lazy cluster layer — performing a full re-up");
                    }
                    if agent_only_enabled {
                        println!(
                            "note: VM '{name}' is already running — agent-only mode applies on its next boot"
                        );
                    }
                    if mount_changed {
                        println!(
                            "note: VM '{name}' is already running — the shared folder applies on its next boot"
                        );
                    }
                }
            }
            if cluster_enabled {
                if let Some(pid) = store::read_live_pid(&name) {
                    request_stop(&name, pid)?;
                    let stop_deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
                    while store::read_live_pid(&name).is_some() {
                        if std::time::Instant::now() >= stop_deadline {
                            bail!("timed out stopping VM '{name}' for the --cluster re-up");
                        }
                        std::thread::sleep(std::time::Duration::from_millis(200));
                    }
                }
            }
            let paths = VmPaths::for_name(&name);
            // The readiness marker `up` polls on is spec-keyed: an
            // agent-only VM has no k3s kubeconfig — it answers with the
            // agent-ready sentinel marker instead.
            let ready_marker = if spec.agent_only && spec.dev {
                paths.agent_ready()
            } else if spec.cluster {
                paths.kubeconfig()
            } else {
                paths.core_ready()
            };
            if store::read_live_pid(&name).is_none() {
                // Clear stale readiness markers from a previous boot
                // *before* spawning — the poll below must only ever
                // observe files written by this boot. Remove BOTH markers
                // (Quinn gap #4c): a prior boot under the other mode, or a
                // mode flip, must not leave a marker that fakes readiness.
                let _ = std::fs::remove_file(paths.kubeconfig());
                let _ = std::fs::remove_file(paths.agent_ready());
                let _ = std::fs::remove_file(paths.core_ready());
                let _ = std::fs::remove_file(paths.guest_ip());
                bringup::clear(&paths.dir);
                let child = spawn_host_process(&name, timeout)?;
                println!("starting VM '{name}' (host pid {})", child.id());
            }

            // The resident host process publishes its bring-up phase as it
            // goes (boot media → booting → network → k3s → ingress → ready)
            // and writes kubeconfig.yaml as soon as the cluster answers —
            // deliberately BEFORE the last-mile registry/ingress waits, so a
            // last-mile failure still leaves kubectl usable for debugging.
            // Readiness is therefore the marker file AND the terminal Ready
            // phase (`up_bringup_ready`), with Failed checked FIRST each
            // poll: the marker alone no longer implies success.
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout);
            println!("bringing up VM '{name}'…");
            // The spawned host process needs a beat to write its
            // pidfile — only treat "no live pid" as fatal after the
            // grace period, or `up` races its own child.
            let liveness_grace = std::time::Instant::now() + std::time::Duration::from_secs(10);
            let mut shown: Option<(bringup::Phase, Option<String>)> = None;
            loop {
                let b = bringup::read(&paths.dir);
                if let Some(b) = &b {
                    // Reflect the current phase: a new stage OR a new detail
                    // (the Ingress sub-steps reuse one phase) starts a fresh
                    // line; staying put appends dots so progress is visible.
                    let key = (b.phase, b.detail.clone());
                    if shown.as_ref() != Some(&key) {
                        if shown.is_some() {
                            println!();
                        }
                        let detail = b
                            .detail
                            .as_deref()
                            .map(|d| format!(" ({d})"))
                            .unwrap_or_default();
                        print!("  {}{}", b.phase.label(), detail);
                        std::io::Write::flush(&mut std::io::stdout())?;
                        shown = Some(key);
                    }
                    // Failed BEFORE the readiness break: a failed last mile
                    // leaves kubeconfig.yaml on disk by design, so the error
                    // must win over any marker.
                    if b.phase == bringup::Phase::Failed {
                        println!();
                        bail!(
                            "VM bring-up failed: {}\n(boot log: `appliance-vm console {name}`)",
                            b.detail.as_deref().unwrap_or("see host log"),
                        );
                    }
                }
                if up_bringup_ready(b.as_ref().map(|b| b.phase), ready_marker.exists()) {
                    break;
                }
                if std::time::Instant::now() > liveness_grace && store::read_live_pid(&name).is_none() {
                    println!();
                    bail!(
                        "VM host process exited during startup:\n{}",
                        tail_of(&paths.host_log(), 8)
                    );
                }
                if std::time::Instant::now() >= deadline {
                    println!();
                    let stuck = shown
                        .as_ref()
                        .map(|(p, d)| match d {
                            Some(d) => format!("{} ({d})", p.label()),
                            None => p.label().to_string(),
                        })
                        .unwrap_or_else(|| "starting up".to_string());
                    bail!(
                        "timed out after {timeout}s — still {stuck}.\nHost log tail:\n{}\n(boot log: `appliance-vm console {name}`)",
                        tail_of(&paths.host_log(), 8)
                    );
                }
                print!(".");
                std::io::Write::flush(&mut std::io::stdout())?;
                std::thread::sleep(std::time::Duration::from_secs(2));
            }
            println!();
            // Regression tripwire: readiness was reached, but did it fit
            // the budget? Checked on BOTH readiness shapes (k3s and
            // agent-only); failures already exit non-zero above.
            let check_time_budget = |budget: Option<u64>| -> Result<()> {
                let Some(budget) = budget else { return Ok(()) };
                let elapsed = up_started.elapsed().as_secs_f64();
                if elapsed > budget as f64 {
                    bail!(
                        "VM '{name}' is up, but bring-up took {elapsed:.1}s — over the --time-budget of {budget}s.\nSee `appliance-vm timings {name}` for the per-phase breakdown."
                    );
                }
                println!("  bring-up:    {elapsed:.1}s (within the {budget}s budget)");
                Ok(())
            };
            if spec.runtime {
                println!("VM '{name}' is up (pooled runtime core-ready)");
                println!("  runtime supervisor: containerd + vsock control ready");
                println!("  shell: appliance-vm shell {name} --root");
                check_time_budget(time_budget)?;
                return Ok(());
            }
            if spec.agent_only {
                // No k3s API to confirm — readiness is the agent runtime,
                // already proven by the agent-ready marker above. Reach the
                // guest over the k3s-independent vsock shell.
                println!("VM '{name}' is up (agent-only)");
                println!("  agent runtime: node + vsock shell ready");
                println!("  shell: appliance-vm shell {name}");
                check_time_budget(time_budget)?;
                return Ok(());
            }
            if !spec.cluster {
                println!("VM '{name}' is up (core sandbox ready)");
                println!("  shell: appliance-vm shell {name}");
                println!("  cluster: lazy (run again with --cluster, or deploy with the Appliance CLI)");
                check_time_budget(time_budget)?;
                return Ok(());
            }
            net::wait_tcp(
                std::net::SocketAddr::from(([127, 0, 0, 1], spec.api_port)),
                std::time::Duration::from_secs(60),
            )?;
            println!("VM '{name}' is up");
            println!("  kubeconfig:  {}", paths.kubeconfig().display());
            println!("  kubernetes:  https://127.0.0.1:{}", spec.api_port);
            println!("  ingress:     http://*.appliance.localhost:{}", spec.host_port);
            check_time_budget(time_budget)?;
            println!();
            println!("try: KUBECONFIG={} kubectl get nodes", paths.kubeconfig().display());
            Ok(())
        }

        Cmd::Runtime { action } => run_runtime_command(action),

        Cmd::Timings { name } => {
            let paths = VmPaths::for_name(&name);
            let history = bringup::read_history(&paths.dir);
            if history.is_empty() {
                bail!(
                    "no bring-up history for VM '{name}' — it hasn't booted under this engine version yet (boot it with `appliance-vm up {name}`)"
                );
            }
            print!("{}", bringup::render_timings(&history));
            Ok(())
        }

        Cmd::Run { name } => {
            // Pin the bring-up clock before anything slow so hostlog
            // prefixes measure from the very top of the host process.
            bringup::init_host_clock();
            backend.availability()?;
            let spec = ensure_spec(&name)?;
            store::ensure_disk(&spec)?;
            prefetch_boot_artifacts(&spec)?;
            store::write_pidfile(&name)?;
            // Start the egress proxy alongside the VM so the desktop's
            // outbound-traffic policy takes effect without a separate
            // command. Bound where the guest can reach it (the peer
            // guard refuses anything off the VM subnet, so this is not
            // an open LAN proxy). Best-effort: a bind clash must not
            // stop the VM from booting.
            let egress_addr = SocketAddr::from(([0, 0, 0, 0], spec.egress_port));
            if let Err(e) = egress::spawn(&name, egress_addr, false) {
                eprintln!("warn: egress proxy not started ({e:#}); `appliance vm egress proxy` still works");
            }
            // The engine owns the FIRST api key: mint one at bring-up
            // (over the vsock shell, before k3s is even up) whenever the
            // guest key store or the host profile is missing, so an
            // engine-only start never strands clients on a dead
            // credential. No-op when the api-server isn't staged.
            mint::spawn_bringup_mint(&spec);
            let result = backend.run_foreground(&spec);
            store::clear_pidfile(&name);
            result
        }

        Cmd::Stop { name } => {
            match store::read_live_pid(&name) {
                Some(pid) => {
                    request_stop(&name, pid)?;
                    println!("stop requested for VM '{name}' (pid {pid})");
                }
                None => println!("VM '{name}' is not running"),
            }
            Ok(())
        }

        Cmd::Status { name } => {
            let spec = store::load_spec(&name)?;
            let pid = store::read_live_pid(&name);
            let paths = VmPaths::for_name(&name);
            // Cluster readiness is gated on the host process being alive:
            // the marker file lingers on disk after a stop, so the file
            // alone would falsely report a stopped VM as "ready". The marker
            // is spec-keyed — an agent-only VM answers with agent-ready, not
            // kubeconfig.
            let ready_marker = match spec.as_ref() {
                Some(s) if s.agent_only && s.dev => paths.agent_ready(),
                Some(s) if s.cluster => paths.kubeconfig(),
                _ => paths.core_ready(),
            };
            let cluster_ready = pid.is_some() && ready_marker.exists();
            let core_ready = pid.is_some() && paths.core_ready().exists();
            let bringup = if pid.is_some() { bringup::read(&paths.dir) } else { None };
            let status = VmStatus {
                name: name.clone(),
                exists: spec.is_some(),
                running: pid.is_some(),
                pid,
                backend: backend.name(),
                cluster_ready,
                core_ready,
                cluster: spec.as_ref().map(|s| s.cluster).unwrap_or(false),
                phase: bringup.as_ref().map(|b| b.phase),
                phase_detail: bringup.and_then(|b| b.detail),
                message: backend.availability().err().map(|e| format!("{e:#}")),
                host_port: spec.as_ref().map(|s| s.host_port),
                api_port: spec.as_ref().map(|s| s.api_port),
                registry_port: spec.as_ref().map(|s| s.registry_port),
                egress_port: spec.as_ref().map(|s| s.egress_port),
                buildkit_port: spec.as_ref().map(|s| s.buildkit_port),
                dev: spec.as_ref().map(|s| s.dev).unwrap_or(false),
            };
            println!("{}", serde_json::to_string_pretty(&status)?);
            Ok(())
        }

        Cmd::List => {
            #[derive(serde::Serialize)]
            #[serde(rename_all = "camelCase")]
            struct VmEntry {
                name: String,
                running: bool,
                /// Cluster answers (kubeconfig present) while running —
                /// lets the switcher show "starting" vs "ready" per VM.
                cluster_ready: bool,
                core_ready: bool,
                cluster: bool,
                #[serde(skip_serializing_if = "Option::is_none")]
                phase: Option<bringup::Phase>,
                #[serde(skip_serializing_if = "Option::is_none")]
                phase_detail: Option<String>,
                #[serde(skip_serializing_if = "Option::is_none")]
                pid: Option<i32>,
                host_port: u16,
                api_port: u16,
                registry_port: u16,
                egress_port: u16,
                dev: bool,
            }
            let entries: Vec<VmEntry> = store::list_specs()
                .into_iter()
                .map(|spec| {
                    let pid = store::read_live_pid(&spec.name);
                    let paths = VmPaths::for_name(&spec.name);
                    // Spec-keyed readiness marker: agent-only answers with
                    // agent-ready, k3s VMs with kubeconfig.
                    let ready_marker = if spec.agent_only && spec.dev {
                        paths.agent_ready()
                    } else if spec.cluster {
                        paths.kubeconfig()
                    } else {
                        paths.core_ready()
                    };
                    let cluster_ready = pid.is_some() && ready_marker.exists();
                    let core_ready = pid.is_some() && paths.core_ready().exists();
                    let bringup = if pid.is_some() { bringup::read(&paths.dir) } else { None };
                    VmEntry {
                        running: pid.is_some(),
                        cluster_ready,
                        core_ready,
                        cluster: spec.cluster,
                        phase: bringup.as_ref().map(|b| b.phase),
                        phase_detail: bringup.and_then(|b| b.detail),
                        pid,
                        host_port: spec.host_port,
                        api_port: spec.api_port,
                        registry_port: spec.registry_port,
                        egress_port: spec.egress_port,
                        dev: spec.dev,
                        name: spec.name,
                    }
                })
                .collect();
            println!("{}", serde_json::to_string_pretty(&entries)?);
            Ok(())
        }

        Cmd::Shell { name, root, command, session } => {
            let cmd = (!command.is_empty()).then(|| command.join(" "));
            let code = shell::run_client(&name, cmd.as_deref(), root, session.as_deref())?;
            std::process::exit(code);
        }

        Cmd::Sessions { action } => run_sessions(action),

        Cmd::Console { name, follow } => {
            let paths = VmPaths::for_name(&name);
            let path = paths.console_log();
            if !path.exists() {
                bail!("no console log at {} — has the VM been started?", path.display());
            }
            let mut file = std::fs::File::open(&path)?;
            let mut buf = String::new();
            file.read_to_string(&mut buf)?;
            print!("{buf}");
            if follow {
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    let mut chunk = String::new();
                    file.read_to_string(&mut chunk)?;
                    if !chunk.is_empty() {
                        print!("{chunk}");
                        use std::io::Write;
                        std::io::stdout().flush().ok();
                    }
                }
            }
            Ok(())
        }

        Cmd::Delete { name } => {
            if let Some(pid) = store::read_live_pid(&name) {
                bail!("VM '{name}' is running (pid {pid}) — stop it first");
            }
            // Backend-owned state first (e.g. the WSL2 backend's registered
            // distro), then the on-disk VM dir.
            backend.destroy(&name)?;
            store::delete_vm_dir(&name)?;
            println!("deleted VM '{name}'");
            // Prune the credential profiles this VM owned — previously
            // only the CLI's deleteVmAndProfile did this, so an
            // engine-side delete left orphan clusters behind in both
            // the CLI and the desktop (they read the same
            // ~/.appliance/profiles.json). Best-effort: a store hiccup
            // must not fail a delete that already happened.
            for profile in profiles::vm_profile_ids(&name) {
                match profiles::remove_profile(&profile) {
                    Ok(true) => println!("removed credential profile '{profile}'"),
                    Ok(false) => {}
                    Err(e) => eprintln!("warn: could not remove credential profile '{profile}': {e}"),
                }
            }
            Ok(())
        }

        Cmd::SyncClock { name } => {
            fn host_epoch() -> Result<u64> {
                Ok(std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .context("host clock is before the Unix epoch")?
                    .as_secs())
            }
            // Root shell: setting the clock needs root, and the root path
            // works before the appliance user is provisioned — mirrors
            // the resident clock-sync thread (backend/vz/shell.rs).
            let (code, _out) = shell::run_captured(&name, &shell::clock_set_command(host_epoch()?), true)?;
            if code != 0 {
                bail!("clock-sync shell exited with code {code}");
            }
            // clock_set_command ends `|| true` (it is shared with the
            // resident sync loop, which must never die on a failed set),
            // so exit 0 proves nothing. This one-shot is the heal path —
            // callers clear the auth banner when it succeeds — so verify
            // by read-back: the guest clock must actually be within a few
            // seconds of the host now, or this run must fail loudly.
            let (code, out) = shell::run_captured(&name, "date -u +%s", true)?;
            if code != 0 {
                bail!("clock read-back shell exited with code {code}");
            }
            let guest = shell::parse_epoch_output(&out).ok_or_else(|| {
                anyhow::anyhow!("clock read-back returned no epoch (output: {})", out.trim())
            })?;
            let host_now = host_epoch()?;
            if guest.abs_diff(host_now) > 5 {
                bail!("clock sync did not take: guest reports {guest}, host is {host_now}");
            }
            println!("VM '{name}' clock set to host time");
            Ok(())
        }

        Cmd::Egress { action } => run_egress(action),

        Cmd::Creds { action } => run_creds(action),
    }
}

fn run_runtime_command(action: RuntimeCmd) -> Result<()> {
    match action {
        RuntimeCmd::Prepare { name, plan } => {
            let plan: RuntimePreparePlan = serde_json::from_str(&plan).context("parse runtime plan")?;
            validate_runtime_app_id(&plan.app_id)?;
            if !plan.share.read_only {
                bail!("runtime payload shares must be read-only");
            }
            if plan.share.tag.len() > 35
                || !plan.share.tag.is_ascii()
                || !plan.share.tag.starts_with("ap-")
            {
                bail!("invalid runtime VirtioFS tag");
            }
            let host_path = std::fs::canonicalize(&plan.share.host_path)
                .with_context(|| format!("resolve runtime share {}", plan.share.host_path))?;

            let prior = store::load_spec(&name)?;
            let mut spec = match prior.clone() {
                Some(existing) => {
                    if !existing.runtime {
                        bail!("VM '{name}' already exists and is not an Appliance Runtime pool");
                    }
                    existing
                }
                None => {
                    let mut fresh = VmSpec::runtime_defaults(&name);
                    let ports = VmSpec::allocate_ports(&name);
                    fresh.host_port = ports.0;
                    fresh.api_port = ports.1;
                    fresh.registry_port = ports.2;
                    fresh.egress_port = ports.3;
                    fresh.buildkit_port = ports.4;
                    fresh
                }
            };
            // Reassert the fixed profile on every reconciliation.
            spec.cpus = spec::DEFAULT_CPUS;
            spec.memory_mib = spec::DEFAULT_MEMORY_MIB;
            spec.disk_gib = spec::DEFAULT_DISK_GIB;
            spec.agent_only = true;
            spec.runtime = true;
            spec.dev = false;
            spec.dev_mount = None;
            spec.docker = false;
            spec.cluster = false;
            spec.net_link = NetLink::Netstack;
            spec.image = images::RUNTIME_IMAGE.to_string();
            spec.cmdline = guest::runtime_guest_cmdline();

            spec.runtime_shares.retain(|share| share.app_id != plan.app_id);
            spec.runtime_shares.push(RuntimeShare {
                app_id: plan.app_id.clone(),
                tag: plan.share.tag,
                host_path: host_path.to_string_lossy().into_owned(),
                read_only: true,
            });
            spec.runtime_shares.sort_by(|a, b| a.app_id.cmp(&b.app_id));
            spec.published
                .retain(|published| published.principal.as_deref() != Some(plan.app_id.as_str()));
            for port in plan.ports {
                if !(20000..=29999).contains(&port.host) {
                    bail!("runtime host port {} is outside 20000-29999", port.host);
                }
                let target: std::net::Ipv4Addr = port.target.parse().context("parse runtime principal target")?;
                let octets = target.octets();
                if octets[..3] != [192, 168, 127] || !(10..=239).contains(&octets[3]) {
                    bail!("runtime principal target must be an allocated 192.168.127.10-239 /32");
                }
                spec.published.push(PublishedPort {
                    host: port.host,
                    container: port.relay,
                    name: Some(port.name),
                    principal: Some(plan.app_id.clone()),
                    target: Some(port.target),
                    guest: Some(port.guest),
                });
            }
            spec.published.sort_by_key(|published| published.host);
            let restart_required = store::read_live_pid(&name).is_some()
                && prior.as_ref().is_some_and(|old| {
                    old.runtime_shares != spec.runtime_shares || old.published != spec.published
                });
            store::save_spec(&spec)?;
            store::ensure_disk(&spec)?;
            println!(
                "{}",
                serde_json::json!({
                    "poolVm": name,
                    "restartRequired": restart_required,
                    "profile": {
                        "agentOnly": true,
                        "dev": false,
                        "docker": false,
                        "cluster": false,
                        "cpus": spec.cpus,
                        "memoryMib": spec.memory_mib,
                        "netLink": "netstack"
                    }
                })
            );
            Ok(())
        }
        RuntimeCmd::Start { name, plan } => {
            let value: serde_json::Value = serde_json::from_str(&plan).context("parse runtime start plan")?;
            let app = value
                .get("appId")
                .and_then(serde_json::Value::as_str)
                .context("runtime plan missing appId")?;
            validate_runtime_app_id(app)?;
            ensure_runtime_running(&name)?;
            let request = serde_json::json!({ "action": "start", "appId": app, "plan": value });
            let response = guest_exec::runtime_request(&name, &request.to_string())
                .map_err(|error| anyhow::anyhow!("runtime start RPC: {error}"))?;
            println!("{response}");
            Ok(())
        }
        RuntimeCmd::Stop { name, app } => runtime_simple_request(&name, &app, "stop", false),
        RuntimeCmd::Status { name, app } => runtime_simple_request(&name, &app, "status", false),
        RuntimeCmd::Logs { name, app } => runtime_simple_request(&name, &app, "logs", true),
    }
}

fn validate_runtime_app_id(app: &str) -> Result<()> {
    if app.is_empty()
        || app.len() > 63
        || app.starts_with('-')
        || app.ends_with('-')
        || !app.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        bail!("invalid runtime app id '{app}'");
    }
    Ok(())
}

fn ensure_runtime_running(name: &str) -> Result<()> {
    let spec = store::load_spec(name)?.with_context(|| format!("runtime pool '{name}' does not exist"))?;
    if !spec.runtime {
        bail!("VM '{name}' is not an Appliance Runtime pool");
    }
    if store::read_live_pid(name).is_none() {
        bail!("runtime pool '{name}' is not running");
    }
    Ok(())
}

fn runtime_simple_request(name: &str, app: &str, action: &str, raw: bool) -> Result<()> {
    validate_runtime_app_id(app)?;
    ensure_runtime_running(name)?;
    let request = serde_json::json!({ "action": action, "appId": app });
    let response = guest_exec::runtime_request(name, &request.to_string())
        .map_err(|error| anyhow::anyhow!("runtime {action} RPC: {error}"))?;
    if raw {
        print!("{response}");
        if !response.is_empty() && !response.ends_with('\n') {
            println!();
        }
    } else {
        println!("{response}");
    }
    Ok(())
}

fn run_sessions(action: SessionsCmd) -> Result<()> {
    match action {
        SessionsCmd::List { name, root } => {
            let sessions = shell::list_sessions(&name, root)?;
            println!("{}", serde_json::to_string_pretty(&sessions)?);
            Ok(())
        }
        SessionsCmd::Kill { id, name, root } => {
            // Report the real outcome: the agent echoes a marker keyed on
            // tmux's exit status, so killing a bogus id says so instead of
            // claiming a phantom success (mirrors `creds rm`'s no-op path).
            if shell::kill_session(&name, &id, root)? {
                println!("killed session '{id}' in VM '{name}'");
            } else {
                println!("no such session '{id}' in VM '{name}'");
            }
            Ok(())
        }
    }
}

fn run_creds(action: CredsCmd) -> Result<()> {
    use creds::CredentialRule;
    match action {
        CredsCmd::List { name } => {
            #[derive(serde::Serialize)]
            struct Listing {
                rules: Vec<CredentialRule>,
                secrets: Vec<creds::StoredSecret>,
            }
            let listing = Listing {
                rules: creds::load_config(&name).rules,
                secrets: creds::list_secrets(&name),
            };
            println!("{}", serde_json::to_string_pretty(&listing)?);
            Ok(())
        }
        CredsCmd::Add { host, name, capture, inject, header, helper } => {
            let rule = CredentialRule {
                host: host.clone(),
                capture,
                inject,
                header: header.unwrap_or_else(|| "authorization".to_string()).to_ascii_lowercase(),
                helper,
            };
            creds::upsert_rule(&name, rule)?;
            println!("credential rule for '{host}' saved (capture={capture}, inject={inject})");
            Ok(())
        }
        CredsCmd::Rm { host, name } => {
            let removed = creds::remove_rule(&name, &host)?;
            println!(
                "{}",
                if removed {
                    format!("removed credential rule for '{host}'")
                } else {
                    format!("no credential rule for '{host}'")
                }
            );
            Ok(())
        }
        CredsCmd::Set { host, value, name, header } => {
            let header = header.unwrap_or_else(|| "authorization".to_string()).to_ascii_lowercase();
            creds::store_secret(&name, &host, &header, &value)?;
            println!("stored secret for '{host}' ({header})");
            Ok(())
        }
        CredsCmd::Forget { name } => {
            creds::forget_secrets(&name);
            println!("forgot all stored secrets for '{name}'");
            Ok(())
        }
    }
}

fn run_egress(action: EgressCmd) -> Result<()> {
    match action {
        EgressCmd::Proxy { name, addr, log } => {
            let addr: SocketAddr = match addr {
                Some(a) => a.parse().with_context(|| format!("invalid --addr '{a}'"))?,
                None => SocketAddr::from(([127, 0, 0, 1], egress::vm_egress_port(&name))),
            };
            egress::run_proxy(&name, addr, log)
        }
        EgressCmd::Policy { name } => {
            // The EFFECTIVE policy enforced at the boundary — for a
            // Netstack VM that's default-Deny + the baked allowlist (not
            // the persisted serde-default Allow), so the JSON the desktop
            // and CLI read matches what's actually enforced. NAT is
            // unchanged (its persisted, cooperative policy).
            let policy = egress::effective_policy(&name);
            println!("{}", serde_json::to_string_pretty(&policy)?);
            Ok(())
        }
        EgressCmd::List { name } => {
            // Human-readable effective view: distinguishes baked-allow vs
            // operator-allow vs operator-deny and reconciles the persisted
            // default with the netstack-enforced one.
            let persisted = egress::load_policy(&name);
            let netstack = egress::is_netstack(&name);
            print!("{}", egress::render_effective_policy(&name, &persisted, netstack));
            Ok(())
        }
        EgressCmd::Denied { name, tail } => {
            let denied = traffic::denied(&name, tail);
            let report =
                traffic::render_denied_report(&name, name == DEFAULT_VM, &denied, traffic::now_millis());
            print!("{report}");
            Ok(())
        }
        EgressCmd::Default { action, name } => {
            let parsed = match action.to_ascii_lowercase().as_str() {
                "allow" => egress::Action::Allow,
                "deny" => egress::Action::Deny,
                other => bail!("default action must be 'allow' or 'deny', got '{other}'"),
            };
            let mut policy = egress::load_policy(&name);
            policy.default = parsed;
            egress::save_policy(&name, &policy)?;
            let _ = egress::publish_configmap(&name);
            println!("egress default for '{name}' set to {:?}", parsed);
            Ok(())
        }
        EgressCmd::Allow { host, name } => {
            let mut policy = egress::load_policy(&name);
            if !policy.allow.iter().any(|h| h == &host) {
                policy.allow.push(host.clone());
            }
            policy.deny.retain(|h| h != &host);
            egress::save_policy(&name, &policy)?;
            let _ = egress::publish_configmap(&name);
            println!("egress: allow {host}");
            Ok(())
        }
        EgressCmd::Deny { host, name } => {
            let mut policy = egress::load_policy(&name);
            if !policy.deny.iter().any(|h| h == &host) {
                policy.deny.push(host.clone());
            }
            policy.allow.retain(|h| h != &host);
            egress::save_policy(&name, &policy)?;
            let _ = egress::publish_configmap(&name);
            println!("egress: deny {host}");
            Ok(())
        }
        EgressCmd::Remove { host, name } => {
            // Per-rule remove: drop this exact host from both lists,
            // mirroring the load→edit→save contract of allow/deny so the
            // persisted file stays minimal (never write the effective
            // merged policy back).
            let mut policy = egress::load_policy(&name);
            policy.allow.retain(|h| h != &host);
            policy.deny.retain(|h| h != &host);
            egress::save_policy(&name, &policy)?;
            let _ = egress::publish_configmap(&name);
            println!("egress: remove {host}");
            Ok(())
        }
        EgressCmd::Reset { name } => {
            egress::save_policy(&name, &egress::EgressPolicy::default())?;
            let _ = egress::publish_configmap(&name);
            println!("egress policy for '{name}' reset (default allow, no rules)");
            Ok(())
        }
        EgressCmd::Ca { name } => {
            mitm::ensure_ca(&name)?;
            println!("{}", mitm::ca_cert_path(&name).display());
            Ok(())
        }
        EgressCmd::Mitm { state, name } => {
            let on = match state.to_ascii_lowercase().as_str() {
                "on" | "true" | "enable" | "enabled" => true,
                "off" | "false" | "disable" | "disabled" => false,
                other => bail!("mitm state must be 'on' or 'off', got '{other}'"),
            };
            if on {
                // Ensure the CA exists so the operator can fetch + trust
                // it before sending traffic through the interceptor.
                mitm::ensure_ca(&name)?;
            }
            let mut policy = egress::load_policy(&name);
            policy.mitm = on;
            egress::save_policy(&name, &policy)?;
            let _ = egress::publish_configmap(&name);
            println!("egress TLS interception for '{name}': {}", if on { "on" } else { "off" });
            if on {
                println!("CA: {}", mitm::ca_cert_path(&name).display());
            }
            Ok(())
        }
        EgressCmd::Gateway { name } => {
            let policy = egress::load_policy(&name);
            let port = egress::vm_egress_port(&name);
            let url = egress::guest_proxy_url(&name, port);
            println!("HTTPS_PROXY={url}");
            println!("HTTP_PROXY={url}");
            if policy.mitm {
                println!("CA={}", mitm::ca_cert_path(&name).display());
            } else {
                println!("# TLS interception is off — workloads need no CA (blind tunnel).");
            }
            println!(
                "# The egress proxy starts automatically with the VM. To run it standalone: appliance-vm egress proxy {name} --addr 0.0.0.0:{port}"
            );
            Ok(())
        }
        EgressCmd::Sync { name } => {
            egress::publish_configmap(&name)?;
            println!("egress policy published to the cluster for '{name}'");
            Ok(())
        }
        EgressCmd::Log { name, tail, clear } => {
            if clear {
                traffic::clear(&name);
                println!("egress traffic log cleared for '{name}'");
                return Ok(());
            }
            let events = traffic::tail(&name, tail);
            println!("{}", serde_json::to_string(&events)?);
            Ok(())
        }
    }
}

/// Canonicalize + validate a host path for `--mount`: it must exist and
/// be a directory. Returns the absolute path persisted into the spec —
/// the VirtioFS share needs a real, stable path, and resolving it
/// host-side fails fast with a clear message instead of a cryptic boot
/// error.
fn resolve_mount(path: &str) -> Result<String> {
    let abs = std::fs::canonicalize(path).with_context(|| format!("--mount path '{path}' not found"))?;
    if !abs.is_dir() {
        bail!("--mount path '{}' is not a directory", abs.display());
    }
    Ok(abs.to_string_lossy().into_owned())
}

fn ensure_spec(name: &str) -> Result<VmSpec> {
    if let Some(spec) = store::load_spec(name)? {
        return Ok(spec);
    }
    // A VM started without an explicit `create` still needs a
    // non-colliding port block so it can run beside existing VMs.
    let (host_port, api_port, registry_port, egress_port, buildkit_port) = VmSpec::allocate_ports(name);
    let spec = VmSpec {
        host_port,
        api_port,
        registry_port,
        egress_port,
        buildkit_port,
        ..VmSpec::defaults(name)
    };
    store::save_spec(&spec)?;
    Ok(spec)
}

/// Ask a resident host process to stop its VM. Unix: SIGTERM — the
/// host's signal handler requests a guest stop and exits. Windows has
/// no SIGTERM, so drop the stop-request file the host's parking loop
/// polls (the WSL backend clears it on every boot).
#[cfg(unix)]
fn request_stop(_name: &str, pid: i32) -> Result<()> {
    let rc = unsafe { libc::kill(pid, libc::SIGTERM) };
    if rc != 0 {
        bail!("failed to signal pid {pid}");
    }
    Ok(())
}

#[cfg(windows)]
fn request_stop(name: &str, _pid: i32) -> Result<()> {
    let paths = VmPaths::for_name(name);
    std::fs::write(paths.stop_request(), b"stop\n")
        .with_context(|| format!("write {}", paths.stop_request().display()))?;
    Ok(())
}

/// Pre-fetch the boot artifacts a backend needs before the VM can run.
/// The vz/kvm backends boot a pinned kernel + initramfs pair; the WSL2
/// backend imports a distro instead and fetches its own tarball inside
/// `run_foreground`, so on Windows there is nothing to prefetch here.
fn prefetch_boot_artifacts(spec: &VmSpec) -> Result<()> {
    #[cfg(not(windows))]
    images::ensure_image(&spec.image)?;
    #[cfg(windows)]
    let _ = spec;
    Ok(())
}

/// Spawn the resident VM host process (this same binary, `run`),
/// detached, with its output captured in the per-VM host.log — a
/// silently discarded stderr turns every host-side failure (a proxy
/// port already taken, a lease that never appears) into an
/// undebuggable timeout.
fn spawn_host_process(name: &str, budget_secs: u64) -> Result<std::process::Child> {
    let paths = VmPaths::for_name(name);
    std::fs::create_dir_all(&paths.dir)?;
    let log = std::fs::File::create(paths.host_log()).context("create host.log")?;
    let log_err = log.try_clone()?;
    let exe = std::env::current_exe().context("resolve current executable")?;
    let mut cmd = Command::new(exe);
    cmd.args(["run", name])
        // Thread the caller's bring-up budget (`up --timeout`; the
        // default for `start`) into the resident host process, so its
        // internal readiness waits size themselves off the SAME budget
        // the caller polls against instead of fixed worst-case sums.
        .env(bringup::BUDGET_ENV, budget_secs.to_string())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(log))
        .stderr(std::process::Stdio::from(log_err));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS: the host must outlive the launching terminal
        // (a console child dies with its console on Windows).
        // CREATE_NEW_PROCESS_GROUP: Ctrl-C in that terminal never
        // reaches it.
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    cmd.spawn().context("spawn VM host process")
}

/// One `up` poll's readiness verdict, pure so the ordering contract is
/// unit-testable: the engine writes the marker file (kubeconfig.yaml /
/// agent-ready) BEFORE it finishes the last-mile waits, so the marker
/// alone means "k3s answered", not "platform ready". Readiness needs the
/// marker AND the engine's terminal `Ready` phase. `None` (no readable
/// bring-up state — e.g. a VM booted by an engine predating phase
/// reporting, still running across an engine upgrade) falls back to the
/// marker alone, exactly the old contract. Failed is handled by the loop
/// BEFORE this is consulted; it returns false here regardless.
fn up_bringup_ready(phase: Option<bringup::Phase>, marker_exists: bool) -> bool {
    marker_exists && matches!(phase, Some(bringup::Phase::Ready) | None)
}

/// Last `n` lines of a log file, or a placeholder when unreadable.
fn tail_of(path: &std::path::Path, n: usize) -> String {
    match std::fs::read_to_string(path) {
        Ok(raw) => {
            let lines: Vec<&str> = raw.lines().collect();
            let start = lines.len().saturating_sub(n);
            lines[start..].join("\n")
        }
        Err(_) => format!("(no host log at {})", path.display()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn up_readiness_needs_marker_and_terminal_ready_phase() {
        use bringup::Phase;
        // The happy exit: Ready phase + marker on disk.
        assert!(up_bringup_ready(Some(Phase::Ready), true));
        // F1 contract: kubeconfig.yaml now lands at ClusterApi, BEFORE the
        // last-mile waits — the marker alone (mid-Ingress, or after a
        // last-mile failure) must NOT read as ready.
        assert!(!up_bringup_ready(Some(Phase::ClusterApi), true));
        assert!(!up_bringup_ready(Some(Phase::Ingress), true));
        assert!(!up_bringup_ready(Some(Phase::Failed), true));
        // Ready phase without the marker isn't ready either (the marker is
        // the file the rest of the CLI consumes).
        assert!(!up_bringup_ready(Some(Phase::Ready), false));
        // No readable bring-up state (pre-phase-reporting engine still
        // hosting the VM): the marker alone decides, the old contract.
        assert!(up_bringup_ready(None, true));
        assert!(!up_bringup_ready(None, false));
    }
}
