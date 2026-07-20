//! Windows backend: WSL2-managed distro driven through `wsl.exe`.
//!
//! WSL2 is itself a managed utility VM, so this backend never boots a
//! kernel directly. Instead it imports a purpose-built Alpine distro
//! (`wsl --import` of the hash-pinned minirootfs tarball) and runs the
//! same guest payload the vz backend bakes into its boot media — the
//! non-root `appliance` user, the dev/docker provisioning, k3s + the
//! kubeconfig handoff — as a bootstrap script it pushes into the distro
//! and keeps resident for the VM's lifetime. Same guest contract,
//! different mechanics (docs/microvm.md):
//!
//!   * persistence — the distro's VHDX persists across boots, so
//!     `/persist` is a plain directory (no data disk to format).
//!   * networking — WSL2's NAT provides the guest address; the host
//!     dials it directly, so the standard TCP forwards + the HTTP
//!     kubeconfig handoff work unchanged.
//!   * shell — `wsl.exe -d <distro>` is already a ConPTY channel into
//!     the guest, so there is no vsock agent or relay socket; see
//!     `shell.rs`'s Windows client.
//!   * stop — no SIGTERM on Windows: `appliance-vm stop` drops the
//!     per-VM `stop.request` file and the parking loop terminates the
//!     distro (`wsl --terminate`).
//!
//! Beware: `wsl.exe` prints its OWN messages (--status, --list, import
//! errors) as UTF-16LE, while output of Linux commands passes through
//! as the guest wrote it (UTF-8). `decode_wsl` sniffs per call.

use super::VmBackend;
use crate::spec::{VmPaths, VmSpec};
use anyhow::{bail, Context, Result};
use std::io::Write;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const ALPINE_BRANCH: &str = "v3.21";
const MINIROOTFS_VERSION: &str = "3.21.3";

// Sasha condition #3: committed sha256 for the UNAUTHENTICATED distro
// seed — the minirootfs becomes the guest's entire root filesystem, the
// highest-privilege artifact this backend fetches. Alpine publishes
// these; verify before import, every time (cache-hit included). Bumping
// the Alpine pin is a deliberate change: new artifact + new digest.
const MINIROOTFS_SHA256_X86_64: &str =
    "1a694899e406ce55d32334c47ac0b2efb6c06d7e878102d1840892ad44cd5239";
const MINIROOTFS_SHA256_AARCH64: &str =
    "ead8a4b37867bd19e7417dd078748e2312c0aea364403d96758d63ea8ff261ea";

/// Where the bootstrap script lives inside the distro.
const BOOTSTRAP_GUEST_PATH: &str = "/opt/appliance/bootstrap.sh";

/// The WSL distro registered for a VM. Prefixed so `wsl --list` keeps
/// user distros and appliance VMs visually (and namespace-) separate.
pub fn distro_name(vm: &str) -> String {
    format!("appliance-vm-{vm}")
}

/// A non-interactive `wsl.exe` invocation that never pops a console
/// window: the resident host process runs detached (no console), and
/// without CREATE_NO_WINDOW every background poll would flash one.
/// Interactive shells (`shell.rs`) build their own plain Command — they
/// need the caller's console.
fn wsl_cmd() -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = Command::new("wsl.exe");
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

pub struct WslBackend;

impl VmBackend for WslBackend {
    fn name(&self) -> &'static str {
        "wsl"
    }

    fn availability(&self) -> Result<()> {
        match wsl_cmd().arg("--status").output() {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => bail!(
                "WSL is not installed (wsl.exe not found). Install it with `wsl --install` \
                 from an elevated prompt, reboot, then retry."
            ),
            Err(e) => bail!("could not run wsl.exe: {e}"),
            Ok(out) if !out.status.success() => {
                let detail = combined_output(&out);
                let detail = detail.trim();
                match explain_wsl_failure(detail) {
                    Some(fix) => bail!("WSL is not ready: {detail}\n{fix}"),
                    None => bail!(
                        "WSL is not ready: {detail}\nInstall or repair it with `wsl --install` \
                         (elevated), reboot, then retry."
                    ),
                }
            }
            Ok(_) => Ok(()),
        }
    }

    fn run_foreground(&self, spec: &VmSpec) -> Result<()> {
        self.availability()?;
        let paths = VmPaths::for_name(&spec.name);
        let distro = distro_name(&spec.name);

        // First observable stage: any tarball/k3s download happens here.
        crate::bringup::clear(&paths.dir);
        crate::bringup::set(&paths.dir, crate::bringup::Phase::Media, None);
        // The pinned k3s binary is copied into the distro over drvfs and
        // re-verified guest-side. Agent-only VMs run no k3s at all.
        let k3s: Option<(PathBuf, &'static str)> = if spec.agent_only {
            None
        } else {
            Some(crate::guest::ensure_k3s()?)
        };
        ensure_distro(&distro, &paths)?;

        // A previous host process may have died without terminating the
        // distro (crash, hard kill) — its k3s would still be running in
        // there, and launching a second bootstrap beside it doubles every
        // daemon. Terminate best-effort so each boot starts from a clean
        // guest, the WSL equivalent of a fresh VM launch.
        let _ = wsl_cmd().args(["--terminate", &distro]).output();

        // Per-VM egress CA, trusted node-wide by the bootstrap (same
        // best-effort contract as the vz boot media).
        let egress_ca: Option<String> = if crate::mitm::ensure_ca(&spec.name).is_ok() {
            std::fs::read_to_string(crate::mitm::ca_cert_path(&spec.name)).ok()
        } else {
            None
        };
        // CLI-staged api-server artifacts + the VM's bootstrap token
        // (generated once, persisted host-side for the CLI to mint keys).
        let apiserver = if spec.agent_only {
            None
        } else {
            crate::guest::apiserver_assets()
        };
        let bootstrap_token = if apiserver.is_some() {
            crate::guest::ensure_bootstrap_token(&paths.dir)?
        } else {
            String::new()
        };
        let script = build_bootstrap(
            spec,
            k3s.as_ref().map(|(p, sha)| (p.as_path(), *sha)),
            egress_ca.as_deref(),
            apiserver.as_ref(),
            &bootstrap_token,
        );
        push_bootstrap(&distro, &script)?;

        // Fresh boot state: truncate the console log (the primary
        // observable surface) and clear every stale readiness marker,
        // including a stop request left by a previous hard kill.
        std::fs::write(paths.console_log(), b"")?;
        let _ = std::fs::remove_file(paths.kubeconfig());
        let _ = std::fs::remove_file(paths.agent_ready());
        let _ = std::fs::remove_file(paths.guest_ip());
        let _ = std::fs::remove_file(paths.gateway_ip());
        let _ = std::fs::remove_file(paths.stop_request());

        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(paths.console_log())
            .context("open console.log")?;
        let log_err = log.try_clone()?;
        let mut child = wsl_cmd()
            .args(["-d", &distro, "-u", "root", "--", "sh", BOOTSTRAP_GUEST_PATH])
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log_err))
            .spawn()
            .context("launch the WSL guest bootstrap")?;
        eprintln!("VM '{}' started (WSL distro '{distro}')", spec.name);
        crate::bringup::set(&paths.dir, crate::bringup::Phase::Booting, None);

        // Guest-facing host services (IP discovery, port forwards,
        // kubeconfig/agent handoff) on a side thread, so the parking
        // loop below stays the single owner of lifecycle decisions.
        {
            let spec = spec.clone();
            let paths_dir = paths.dir.clone();
            let distro = distro.clone();
            // What THIS boot's bootstrap embeds decides the readiness
            // gate — captured at bootstrap build, never re-probed at
            // readiness time (the shared guest-assets cache can change
            // under a running VM).
            let apiserver_staged = apiserver.is_some();
            std::thread::spawn(move || {
                if let Err(err) = host_services(&spec, &paths_dir, &distro, apiserver_staged) {
                    eprintln!("host services: {err:#}");
                    crate::bringup::set(
                        &paths_dir,
                        crate::bringup::Phase::Failed,
                        Some(format!("{err:#}")),
                    );
                }
            });
        }

        // Park until the guest bootstrap exits on its own or a stop is
        // requested (the stop.request file `appliance-vm stop` drops).
        loop {
            std::thread::sleep(Duration::from_millis(200));
            if let Some(status) = child.try_wait().context("poll WSL guest")? {
                if status.success() {
                    eprintln!("VM '{}' stopped (guest)", spec.name);
                    return Ok(());
                }
                // The bootstrap died (FATAL in the script, or the distro
                // was shut down externally). Record it so `up` fails fast
                // instead of timing out blind.
                crate::bringup::set(
                    &paths.dir,
                    crate::bringup::Phase::Failed,
                    Some(format!("guest bootstrap exited: {status}")),
                );
                bail!(
                    "guest bootstrap exited: {status} (boot log: `appliance-vm console {}`)",
                    spec.name
                );
            }
            if paths.stop_request().exists() {
                eprintln!("stop requested — shutting down VM '{}'", spec.name);
                let _ = std::fs::remove_file(paths.stop_request());
                let out = wsl_cmd()
                    .args(["--terminate", &distro])
                    .output()
                    .context("wsl --terminate")?;
                if !out.status.success() {
                    eprintln!("wsl --terminate: {}", combined_output(&out).trim());
                }
                let _ = child.wait();
                return Ok(());
            }
        }
    }

    fn destroy(&self, name: &str) -> Result<()> {
        let distro = distro_name(name);
        if !distro_registered(&distro)? {
            return Ok(());
        }
        let out = wsl_cmd()
            .args(["--unregister", &distro])
            .output()
            .context("wsl --unregister")?;
        if !out.status.success() {
            bail!(
                "could not unregister WSL distro '{distro}': {}",
                combined_output(&out).trim()
            );
        }
        Ok(())
    }
}

/// Decode wsl.exe output: its own messages are UTF-16LE, guest output
/// is UTF-8. Interior NULs in the head are the UTF-16 tell. pub(crate)
/// so `shell.rs`'s Windows capture path decodes wsl.exe-level errors
/// the same way.
pub(crate) fn decode_wsl(bytes: &[u8]) -> String {
    if bytes.iter().take(64).any(|&b| b == 0) {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// Targeted guidance for the WSL failure classes a fresh machine
/// actually hits, keyed on the error text wsl.exe prints. The raw HCS
/// codes are opaque ("0x80370102") — name the real cause and the exact
/// fix. Kept in sync with `classifyWslFailure` in
/// packages/cli/src/utils/preflight.ts — specifically the shared
/// signature keys: 0x80370102/0x80370114/"virtual machine platform"/
/// "hypervisor" (virtualization), 0x800701bc/"kernel" (kernel update),
/// and "wsl --install"/"not installed" (not set up). The surrounding
/// prose may differ; the keys must not.
fn explain_wsl_failure(text: &str) -> Option<&'static str> {
    let lower = text.to_lowercase();
    if lower.contains("0x80370102")
        || lower.contains("0x80370114")
        || lower.contains("virtual machine platform")
        || lower.contains("hypervisor")
        || (lower.contains("virtualization") && (lower.contains("enable") || lower.contains("not")))
    {
        return Some(
            "virtualization is not available to WSL2. Enable it in your BIOS/UEFI \
             (\"Intel VT-x\", \"AMD-V\", or \"SVM\"), then enable the Windows feature from an \
             elevated PowerShell: `Enable-WindowsOptionalFeature -Online -FeatureName \
             VirtualMachinePlatform`, and reboot.",
        );
    }
    if lower.contains("wsl --update") || lower.contains("kernel") || lower.contains("0x800701bc") {
        return Some("the WSL2 kernel is missing or outdated — run `wsl --update`, then retry.");
    }
    if lower.contains("wsl --install")
        || lower.contains("not installed")
        || lower.contains("no installed distributions")
    {
        return Some(
            "WSL is not set up on this machine — open PowerShell as Administrator, run \
             `wsl --install`, reboot, then retry.",
        );
    }
    None
}

/// Both streams of a finished command, decoded — wsl.exe splits its
/// diagnostics between the two inconsistently.
fn combined_output(out: &std::process::Output) -> String {
    let mut s = decode_wsl(&out.stdout);
    let err = decode_wsl(&out.stderr);
    if !err.trim().is_empty() {
        if !s.trim().is_empty() {
            s.push('\n');
        }
        s.push_str(&err);
    }
    s
}

/// Is a distro registered? `wsl --list --quiet` prints one name per
/// line (UTF-16); a machine with no distros at all exits non-zero,
/// which is simply "not registered".
fn distro_registered(distro: &str) -> Result<bool> {
    let out = wsl_cmd()
        .args(["--list", "--quiet"])
        .output()
        .context("wsl --list")?;
    if !out.status.success() {
        return Ok(false);
    }
    Ok(decode_wsl(&out.stdout)
        .lines()
        .any(|line| line.trim() == distro))
}

/// Download (once) + verify the pinned Alpine minirootfs the distro is
/// imported from. Cached beside the other guest assets.
fn ensure_rootfs() -> Result<PathBuf> {
    let (arch, sha) = match std::env::consts::ARCH {
        "x86_64" => ("x86_64", MINIROOTFS_SHA256_X86_64),
        "aarch64" => ("aarch64", MINIROOTFS_SHA256_AARCH64),
        other => bail!("unsupported host architecture: {other}"),
    };
    let dir = crate::store::vm_root().join("images").join("wsl-assets");
    std::fs::create_dir_all(&dir)?;
    let dest = dir.join(format!(
        "alpine-minirootfs-{MINIROOTFS_VERSION}-{arch}.tar.gz"
    ));
    crate::images::download_and_verify(
        &format!(
            "https://dl-cdn.alpinelinux.org/alpine/{ALPINE_BRANCH}/releases/{arch}/alpine-minirootfs-{MINIROOTFS_VERSION}-{arch}.tar.gz"
        ),
        &dest,
        sha,
    )?;
    Ok(dest)
}

/// Import the VM's distro if it isn't registered yet. The VHDX lands
/// under the VM dir (`<vm>/wsl/`), so it travels and dies with the VM.
fn ensure_distro(distro: &str, paths: &VmPaths) -> Result<()> {
    if distro_registered(distro)? {
        return Ok(());
    }
    let rootfs = ensure_rootfs()?;
    let storage = paths.dir.join("wsl");
    std::fs::create_dir_all(&storage)?;
    eprintln!("importing WSL distro '{distro}'");
    let out = wsl_cmd()
        .arg("--import")
        .arg(distro)
        .arg(&storage)
        .arg(&rootfs)
        .args(["--version", "2"])
        .output()
        .context("wsl --import")?;
    if !out.status.success() {
        let detail = combined_output(&out);
        let detail = detail.trim();
        match explain_wsl_failure(detail) {
            Some(fix) => bail!("could not import WSL distro '{distro}': {detail}\n{fix}"),
            None => bail!(
                "could not import WSL distro '{distro}': {detail}\n\
                 (if this mentions the WSL2 kernel, run `wsl --update` and retry)"
            ),
        }
    }
    Ok(())
}

/// Write the bootstrap script into the distro over stdin — no path
/// translation, no automount dependency, works on a distro that has
/// nothing but busybox yet.
fn push_bootstrap(distro: &str, script: &str) -> Result<()> {
    let mut child = wsl_cmd()
        .args([
            "-d",
            distro,
            "-u",
            "root",
            "--",
            "sh",
            "-c",
            &format!(
                "mkdir -p /opt/appliance && cat > {BOOTSTRAP_GUEST_PATH} && chmod 0755 {BOOTSTRAP_GUEST_PATH}"
            ),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .context("provision the bootstrap script")?;
    child
        .stdin
        .take()
        .expect("piped stdin")
        .write_all(script.as_bytes())
        .context("stream the bootstrap script")?;
    let out = child.wait_with_output()?;
    if !out.status.success() {
        bail!(
            "could not provision the bootstrap script: {}",
            combined_output(&out).trim()
        );
    }
    Ok(())
}

/// The WSL guest bootstrap skeleton. Same provisioning contract as the
/// vz boot media's `appliance.start` (guest.rs), minus the pieces WSL
/// makes moot: no data disk to format (the VHDX persists), no modloop /
/// apkovl (packages install straight from the network repo into the
/// persistent root), no vsock shell agent (`wsl.exe` is the channel).
const WSL_BOOTSTRAP: &str = r#"#!/bin/sh
# appliance bootstrap — WSL2 backend. Runs as root inside the imported
# Alpine distro on every boot; stdout/stderr land in the host's
# console.log (the primary debugging surface).
set -x

# WSL wires eth0 + resolv.conf itself. Make the mount table shareable
# and the kernel surface k3s expects available (both best-effort — a
# plain dev VM doesn't need them).
mount --make-rshared / 2>/dev/null || true
# kubelet reads /dev/kmsg, which some WSL kernels don't create.
[ -e /dev/kmsg ] || mknod /dev/kmsg c 1 11 2>/dev/null || true
# cgroups: WSL mounts a v1 hybrid by default, and k3s on a non-systemd
# distro wants the named systemd hierarchy present there. A no-op on
# cgroup v2 kernels (cgroup.controllers exists).
if [ ! -f /sys/fs/cgroup/cgroup.controllers ] && [ ! -d /sys/fs/cgroup/systemd ]; then
  mkdir -p /sys/fs/cgroup/systemd
  mount -t cgroup -o none,name=systemd cgroup /sys/fs/cgroup/systemd 2>/dev/null || true
fi

# --- persistent root --------------------------------------------------
# The distro's VHDX persists across boots, so /persist is just a
# directory — no data disk, no mkfs, no mount.
PERSIST=/persist
mkdir -p "$PERSIST"

# --- base packages ----------------------------------------------------
# Idempotent; served from the persistent apk cache after the first
# boot. busybox-extras brings httpd (the kubeconfig handoff); sudo +
# tmux back the appliance user and reattachable sessions, exactly like
# the vz world file.
cat > /etc/apk/repositories <<'REPOS'
https://dl-cdn.alpinelinux.org/alpine/__ALPINE_BRANCH__/main
https://dl-cdn.alpinelinux.org/alpine/__ALPINE_BRANCH__/community
REPOS
mkdir -p /persist/apk-cache /etc/apk
ln -sfn /persist/apk-cache /etc/apk/cache
apk update --no-progress >/dev/null 2>&1 || true
apk add --no-progress ca-certificates busybox-extras sudo tmux libstdc++ libgcc unzip \
  || echo "WARNING: base package install failed (offline?)"

# --- egress CA trust (node-side) --------------------------------------
__EGRESS_CA__
if [ -f /usr/local/share/ca-certificates/appliance-egress.crt ]; then
  update-ca-certificates 2>/dev/null || true
fi

# --- non-root appliance user -------------------------------------------
__APP_USER_PROVISION__
# --- transparent tmux config (reattachable sessions) --------------------
mkdir -p /etc/appliance
cat > /etc/appliance/tmux.conf <<'TMUXCONF'
__TMUX_CONF__
TMUXCONF

# --- dev environment (appliance vm dev) ---------------------------------
__DEV_PROVISION__
# --- docker engine (appliance vm ... --docker) ---------------------------
__DOCKER_PROVISION__
# --- buildkit (docker-free image builds) ----------------------------------
__BUILDKIT_PROVISION__
# --- k3s / agent-runtime handoff -----------------------------------------
__K3S_PROVISION__
# --- appliance api-server (control plane as a guest binary) ---------------
__APISERVER_PROVISION__
# Keep the boot session resident: the host process owns this child, and
# `appliance-vm stop` terminates the whole distro.
while :; do sleep 3600; done
"#;

/// WSL replacement for `K3S_MEDIA_COPY`: the pinned binary lives in the
/// host's asset cache, reached over the drvfs automount; re-verify the
/// committed sha256 guest-side before first use (the host verified the
/// download; this re-checks the bytes that actually crossed drvfs).
/// Prepended to the shared `guest::K3S_COMMON`.
const WSL_K3S_COPY: &str = r#"# --- k3s -------------------------------------------------------------
K3S_SRC=$(wslpath -u '__K3S_WIN_PATH__')
if [ ! -f "$K3S_SRC" ]; then
  echo "FATAL: k3s binary not reachable at $K3S_SRC (is the Windows drive automounted?)"
  exit 1
fi
mkdir -p /usr/local/bin
# Plain `-c` with output redirected, NOT `-c -s`: `-s` is a busybox-only
# spelling, and once provisioning installs GNU coreutils into the
# persisted distro its sha256sum shadows busybox, rejects `-s`, and
# fails this check (and every subsequent boot) unconditionally.
if ! echo '__K3S_SHA256__  /usr/local/bin/k3s' | sha256sum -c >/dev/null 2>&1; then
  cp "$K3S_SRC" /usr/local/bin/k3s
  chmod +x /usr/local/bin/k3s
fi
if ! echo '__K3S_SHA256__  /usr/local/bin/k3s' | sha256sum -c >/dev/null 2>&1; then
  echo "FATAL: k3s binary failed its sha256 check after copy"
  exit 1
fi
"#;

/// WSL replacement for `guest::APISERVER_MEDIA_COPY`: the CLI-staged
/// api-server binary (and optional console bundle) live in the host's
/// asset cache, reached over the drvfs automount, and the bootstrap
/// token is embedded in this root-only script (the same trust level as
/// the vz apkovl). Prepended to the shared `guest::APISERVER_COMMON`.
const WSL_APISERVER_COPY: &str = r#"# --- appliance api-server ---------------------------------------------
# The control plane runs as a plain guest binary — no image delivery,
# no docker anywhere. Copy it (and the console bundle) over drvfs.
mkdir -p /persist/appliance /usr/local/bin /etc/appliance
APISERVER_SRC=$(wslpath -u '__APISERVER_WIN_PATH__')
if [ -f "$APISERVER_SRC" ]; then
  cp "$APISERVER_SRC" /usr/local/bin/appliance-api-server
  chmod +x /usr/local/bin/appliance-api-server
else
  echo "appliance-api-server: staged binary not reachable at $APISERVER_SRC"
fi
CONSOLE_SRC=$(wslpath -u '__CONSOLE_WIN_PATH__')
if [ -n '__CONSOLE_WIN_PATH__' ] && [ -f "$CONSOLE_SRC" ]; then
  rm -rf /persist/appliance/console.new
  mkdir -p /persist/appliance/console.new
  if tar -xzf "$CONSOLE_SRC" -C /persist/appliance/console.new 2>/dev/null; then
    rm -rf /persist/appliance/console
    mv /persist/appliance/console.new /persist/appliance/console
  else
    echo "appliance-api-server: console bundle extraction failed (API still serves)"
  fi
fi
printf '%s' '__APISERVER_TOKEN__' > /etc/appliance/bootstrap-token
chmod 600 /etc/appliance/bootstrap-token
"#;

/// The agent-runtime handoff for an agent-only VM on WSL. There is no
/// prebuilt agent squashfs here (that's a virtio-blk device) — the CLIs
/// self-heal via npm into /persist/npm-global, the same fallback a vz
/// VM without a verified image takes. Otherwise identical contract to
/// `guest::AGENT_HANDOFF`: gate on the toolchain's grippable
/// `.dev-ready`, then serve the `agent-ready` sentinel over httpd.
const WSL_AGENT_HANDOFF: &str = r#"# --- agent runtime handoff (agent-only VM) --------------------------
# No k3s control plane. Readiness is the agent runtime: the Node
# toolchain DEV_PROVISION installs (agent_only implies dev).
__AGENT_DOCKER_STUB__
mkdir -p /persist/npm-global
# Sasha condition #2: wipe /persist/npm-global on a PROJECT SWITCH so a
# CLI a self-heal installed for one project can't persist on PATH into
# the next. Empty identity (no mount) => no wipe.
APPLIANCE_PROJECT='__PROJECT_ID__'
if [ -n "$APPLIANCE_PROJECT" ] && [ "$(cat /persist/.npm-global-project 2>/dev/null)" != "$APPLIANCE_PROJECT" ]; then
  echo "appliance-agents: project changed — wiping /persist/npm-global"
  rm -rf /persist/npm-global
  mkdir -p /persist/npm-global
  printf '%s' "$APPLIANCE_PROJECT" > /persist/.npm-global-project
fi
# This block runs as root; the npm self-heal runs as the appliance user —
# hand the prefix over or the unprivileged install EACCESes.
chown appliance /persist/npm-global 2>/dev/null || true
mkdir -p /srv/handoff
(
  while [ ! -f /persist/.dev-ready ]; do sleep 1; done
  echo agent-ready > /srv/handoff/agent-ready
  httpd -f -p __KUBECONFIG_PORT__ -h /srv/handoff &
) &
"#;

/// Substituted into `DEV_PROVISION`'s `__DEV_MOUNT__` marker when a
/// host folder is shared in: WSL already presents Windows drives under
/// /mnt, so the share is a bind mount of the translated path — the WSL
/// analogue of the vz VirtioFS mount.
const WSL_DEV_MOUNT: &str = r#"# Host folder shared in over the WSL drvfs automount (appliance vm dev
# up --mount), bind-mounted as the workspace so edits flow both ways.
APPLIANCE_MOUNT_SRC=$(wslpath -u '__MOUNT_WIN_PATH__')
if [ -d "$APPLIANCE_MOUNT_SRC" ] && mount --bind "$APPLIANCE_MOUNT_SRC" /persist/workspace; then
  echo "appliance-dev: mounted shared host folder at /persist/workspace"
else
  echo "appliance-dev: WARNING bind mount of the shared host folder failed"
fi"#;

/// Escape a value for embedding inside a single-quoted shell string.
fn shell_squote(value: &str) -> String {
    value.replace('\'', r#"'\''"#)
}

/// Windows paths come out of `fs::canonicalize` with the `\\?\` verbatim
/// prefix, which `wslpath` refuses — strip it for the guest.
fn strip_verbatim(path: &str) -> &str {
    path.strip_prefix(r"\\?\").unwrap_or(path)
}

/// Assemble the per-VM bootstrap script. Mirrors `guest::build_apkovl`'s
/// substitution rules: provisioning blocks are injected BEFORE the port
/// and path markers, so their nested markers expand too (Quinn gap #1).
fn build_bootstrap(
    spec: &VmSpec,
    k3s: Option<(&Path, &'static str)>,
    egress_ca_pem: Option<&str>,
    // CLI-staged api-server artifacts + the VM's bootstrap token.
    // `None` for agent-only VMs or when nothing was staged.
    apiserver: Option<&crate::guest::ApiServerAssets>,
    bootstrap_token: &str,
) -> String {
    let dev = spec.dev;
    let mount = spec.dev_mount.as_deref().map(strip_verbatim);
    // Project identity for the npm-global wipe: a short hash of the
    // mounted path, mirroring guest.rs (shell-safe, uniquely keyed).
    let project_id = mount
        .map(|p| crate::images::content_sha256_hex(p.as_bytes())[..16].to_string())
        .unwrap_or_default();

    let k3s_block = match k3s {
        // Agent-only: no k3s at all.
        None => WSL_AGENT_HANDOFF.to_string(),
        Some((path, sha)) => format!("{WSL_K3S_COPY}{}", crate::guest::K3S_COMMON)
            .replace("__K3S_WIN_PATH__", &shell_squote(strip_verbatim(&path.to_string_lossy())))
            .replace("__K3S_SHA256__", sha),
    };
    // The api-server guest binary rides k3s VMs whose assets were
    // staged. Same substitution rules as the k3s block: injected before
    // the port markers so its nested markers expand too.
    let apiserver_block = match (spec.agent_only, apiserver) {
        (false, Some(assets)) => format!("{WSL_APISERVER_COPY}{}", crate::guest::APISERVER_COMMON)
            .replace(
                "__APISERVER_WIN_PATH__",
                &shell_squote(strip_verbatim(&assets.binary.to_string_lossy())),
            )
            .replace(
                "__CONSOLE_WIN_PATH__",
                &assets
                    .console
                    .as_ref()
                    .map(|c| shell_squote(strip_verbatim(&c.to_string_lossy())))
                    .unwrap_or_default(),
            )
            .replace("__APISERVER_TOKEN__", &shell_squote(bootstrap_token)),
        _ => String::new(),
    };
    let ca_block = egress_ca_pem
        .map(|pem| {
            let pem = if pem.ends_with('\n') { pem.to_string() } else { format!("{pem}\n") };
            format!(
                "mkdir -p /usr/local/share/ca-certificates\n\
                 cat > /usr/local/share/ca-certificates/appliance-egress.crt <<'EGRESSCA'\n\
                 {pem}EGRESSCA"
            )
        })
        .unwrap_or_default();

    WSL_BOOTSTRAP
        // Blocks first (they carry nested markers), then the markers.
        .replace("__K3S_PROVISION__", &k3s_block)
        .replace("__APISERVER_PROVISION__", &apiserver_block)
        .replace(
            "__AGENT_DOCKER_STUB__",
            if spec.agent_only && !spec.docker {
                crate::guest::AGENT_DOCKER_STUB
            } else {
                ""
            },
        )
        .replace(
            "__APP_USER_PROVISION__",
            &crate::guest::APP_USER_PROVISION
                .replace("__APP_UID__", "1000")
                .replace("__APP_GID__", "1000"),
        )
        .replace(
            "__DEV_PROVISION__",
            if dev { crate::guest::DEV_PROVISION } else { "" },
        )
        .replace(
            "__DEV_MOUNT__",
            &if dev {
                mount
                    .map(|m| WSL_DEV_MOUNT.replace("__MOUNT_WIN_PATH__", &shell_squote(m)))
                    .unwrap_or_default()
            } else {
                String::new()
            },
        )
        .replace(
            "__DOCKER_PROVISION__",
            if spec.docker { crate::guest::DOCKER_PROVISION } else { "" },
        )
        // BuildKit rides every k3s VM, exactly as on the vz backend —
        // injected before the port markers below so its nested
        // __REGISTRY_*__/__BUILDKITD_GUEST_PORT__ markers expand too.
        .replace(
            "__BUILDKIT_PROVISION__",
            if spec.agent_only { "" } else { crate::guest::BUILDKIT_PROVISION },
        )
        .replace("__EGRESS_CA__", &ca_block)
        // No virtio-blk media inside a WSL distro: leave the airgap
        // probe unarmed so the shared K3S_COMMON block is a no-op and
        // k3s pulls from the network exactly as before.
        .replace("__K3S_AIRGAP_PREAMBLE__", "")
        .replace("__TMUX_CONF__\n", crate::guest::TMUX_CONF)
        .replace("__KUBECONFIG_PORT__", &crate::guest::KUBECONFIG_PORT.to_string())
        .replace("__REGISTRY_NODEPORT__", &crate::guest::REGISTRY_NODEPORT.to_string())
        .replace("__REGISTRY_HOST_PORT__", &spec.registry_port.to_string())
        .replace("__BUILDKITD_GUEST_PORT__", &crate::guest::BUILDKITD_GUEST_PORT.to_string())
        .replace("__APISERVER_GUEST_PORT__", &crate::guest::API_SERVER_GUEST_PORT.to_string())
        .replace("__HOST_PORT__", &spec.host_port.to_string())
        .replace("__EGRESS_PORT__", &spec.egress_port.to_string())
        // No prebuilt agent squashfs on WSL — nothing to put PATH-first.
        .replace("__AGENT_BIN_PATH__", "")
        .replace("__PROJECT_ID__", &project_id)
        .replace("__ALPINE_BRANCH__", ALPINE_BRANCH)
}

/// Guest-facing host services — the WSL sibling of `guest::host_services`'
/// NAT branch. The guest address comes from `ip addr` inside the distro
/// (there is no macOS lease table here); everything downstream — the TCP
/// forwards, the kubeconfig/agent handoff, the bringup phases and marker
/// files `up` polls on — is the same contract.
fn host_services(spec: &VmSpec, vm_dir: &Path, distro: &str, apiserver_staged: bool) -> Result<()> {
    let guest_ip = discover_guest_ip(distro, Duration::from_secs(120))?;
    crate::bringup::hostlog(&format!("guest address: {guest_ip}"));
    std::fs::write(vm_dir.join("guest-ip"), guest_ip.to_string())?;
    // The guest reaches host-side services (the egress proxy) at its
    // default gateway. The WSL NAT prefix is a /20 — NOT the vz /24 —
    // so record the real gateway for egress::guest_proxy_url instead of
    // letting it guess `<guest>/24`.1 (which points at nothing here).
    match discover_gateway_ip(distro) {
        Some(gw) => {
            eprintln!("guest gateway: {gw}");
            std::fs::write(vm_dir.join("gateway-ip"), gw.to_string())?;
        }
        None => eprintln!("guest gateway: not found (egress proxy URL falls back to the /24 gateway)"),
    }
    crate::bringup::set(vm_dir, crate::bringup::Phase::Network, Some(guest_ip.to_string()));

    let bind_hint = |port: u16, what: &str| {
        format!(
            "cannot forward 127.0.0.1:{port} ({what}) — the port is taken. Stop the microVM holding it with `appliance vm stop`, or run `appliance doctor` to find what owns the port."
        )
    };

    if !spec.agent_only {
        crate::net::spawn_proxy(spec.api_port, SocketAddr::new(guest_ip, 6443))
            .map_err(|e| anyhow::anyhow!("{}\n{e:#}", bind_hint(spec.api_port, "kubernetes api")))?;
        crate::net::spawn_proxy(spec.host_port, SocketAddr::new(guest_ip, 80))
            .map_err(|e| anyhow::anyhow!("{}\n{e:#}", bind_hint(spec.host_port, "ingress")))?;
        crate::net::spawn_proxy(
            spec.registry_port,
            SocketAddr::new(guest_ip, crate::guest::REGISTRY_NODEPORT),
        )
        .map_err(|e| anyhow::anyhow!("{}\n{e:#}", bind_hint(spec.registry_port, "registry")))?;
        crate::net::spawn_proxy(
            spec.buildkit_port,
            SocketAddr::new(guest_ip, crate::guest::BUILDKITD_GUEST_PORT),
        )
        .map_err(|e| anyhow::anyhow!("{}\n{e:#}", bind_hint(spec.buildkit_port, "buildkit")))?;
        // The deterministic-NodePort window, same as the vz backend.
        for port in 30000..=30050u16 {
            let _ = crate::net::spawn_proxy(port, SocketAddr::new(guest_ip, port));
        }
        crate::bringup::hostlog(&format!(
            "forwarding 127.0.0.1:{} → guest:6443, 127.0.0.1:{} → guest:80, 127.0.0.1:{} → guest:{} (registry), 127.0.0.1:{} → guest:{} (buildkit)",
            spec.api_port,
            spec.host_port,
            spec.registry_port,
            crate::guest::REGISTRY_NODEPORT,
            spec.buildkit_port,
            crate::guest::BUILDKITD_GUEST_PORT
        ));
    }

    if spec.agent_only {
        crate::bringup::hostlog("agent-only: gating on the agent runtime (node toolchain)");
        crate::bringup::set(vm_dir, crate::bringup::Phase::Agent, None);
        let handoff = format!(
            "http://{guest_ip}:{}/agent-ready",
            crate::guest::KUBECONFIG_PORT
        );
        crate::net::wait_http(&handoff, Duration::from_secs(600))?;
        std::fs::write(vm_dir.join("agent-ready"), b"agent-ready\n")?;
        crate::bringup::set(vm_dir, crate::bringup::Phase::Ready, None);
        return Ok(());
    }

    // Shared with the vz backend: honest cluster sub-phases off the
    // guest's /progress markers, and `Ready` only once the kubeconfig,
    // registry, and (when staged) api-server route actually answer.
    crate::guest::wait_platform_ready(
        spec,
        vm_dir,
        guest_ip,
        crate::guest::KUBECONFIG_PORT,
        apiserver_staged,
    )
}

/// Poll `ip addr show eth0` inside the distro until the WSL NAT lease
/// appears (it is there within a second or two of the distro starting).
fn discover_guest_ip(distro: &str, timeout: Duration) -> Result<IpAddr> {
    let deadline = Instant::now() + timeout;
    loop {
        let out = wsl_cmd()
            .args(["-d", distro, "-u", "root", "--", "ip", "addr", "show", "eth0"])
            .output();
        if let Ok(out) = out {
            if out.status.success() {
                if let Some(ip) = parse_inet(&decode_wsl(&out.stdout)) {
                    return Ok(ip);
                }
            }
        }
        if Instant::now() >= deadline {
            // The whole forwarding model (host dials guest_ip directly)
            // assumes classic NAT networking. Mirrored mode has no NAT
            // eth0 lease, so IP discovery times out here — name the real
            // cause instead of a bare timeout.
            if wslconfig_uses_mirrored_networking() {
                bail!(
                    "guest eth0 address did not appear within {timeout:?} — your WSL is in \
                     mirrored networking mode, which the managed VM does not support yet. \
                     Set `networkingMode=NAT` under `[wsl2]` in `%USERPROFILE%\\.wslconfig` \
                     (or remove the setting), run `wsl --shutdown`, then retry."
                );
            }
            bail!("guest eth0 address did not appear within {timeout:?}");
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// Whether `%USERPROFILE%\.wslconfig` opts WSL2 into mirrored
/// networking. A plain-text sniff (ini parsing would be overkill):
/// uncommented `networkingMode` set to `mirrored`, case-insensitive.
fn wslconfig_uses_mirrored_networking() -> bool {
    let Some(home) = std::env::var_os("USERPROFILE") else {
        return false;
    };
    let Ok(text) = std::fs::read_to_string(PathBuf::from(home).join(".wslconfig")) else {
        return false;
    };
    text.lines().any(|line| {
        let line = line.trim();
        !line.starts_with('#')
            && !line.starts_with(';')
            && line.to_lowercase().replace(' ', "").starts_with("networkingmode=mirrored")
    })
}

/// The distro's default-gateway IPv4 — where the Windows host answers on
/// the WSL NAT (`ip route show default` → `default via <gw> dev eth0`).
fn discover_gateway_ip(distro: &str) -> Option<IpAddr> {
    let out = wsl_cmd()
        .args(["-d", distro, "-u", "root", "--", "ip", "route", "show", "default"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_default_via(&decode_wsl(&out.stdout))
}

/// Pull the `via <addr>` gateway out of `ip route show default` output.
fn parse_default_via(raw: &str) -> Option<IpAddr> {
    let mut tokens = raw.split_whitespace();
    while let Some(tok) = tokens.next() {
        if tok == "via" {
            if let Some(addr) = tokens.next() {
                if let Ok(ip) = addr.parse::<std::net::Ipv4Addr>() {
                    return Some(IpAddr::V4(ip));
                }
            }
        }
    }
    None
}

/// First non-loopback IPv4 `inet` address off `ip addr` output.
fn parse_inet(raw: &str) -> Option<IpAddr> {
    for line in raw.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("inet ") {
            if let Some(addr) = rest.split(['/', ' ']).next() {
                if let Ok(ip) = addr.parse::<std::net::Ipv4Addr>() {
                    if !ip.is_loopback() {
                        return Some(IpAddr::V4(ip));
                    }
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str) -> VmSpec {
        VmSpec::defaults(name)
    }

    #[test]
    fn distro_names_are_namespaced() {
        assert_eq!(distro_name("appliance"), "appliance-vm-appliance");
        assert_eq!(distro_name("traffic"), "appliance-vm-traffic");
    }

    #[test]
    fn decodes_utf16_and_utf8_wsl_output() {
        // wsl.exe's own messages: UTF-16LE.
        let utf16: Vec<u8> = "Ubuntu\r\n"
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        assert_eq!(decode_wsl(&utf16), "Ubuntu\r\n");
        // Guest command output passes through as UTF-8.
        assert_eq!(decode_wsl(b"inet 172.20.240.2/20"), "inet 172.20.240.2/20");
    }

    #[test]
    fn parses_the_default_gateway() {
        // The WSL NAT is a /20 — the gateway is NOT the .1 of the
        // guest's /24, so it must come from the route table verbatim.
        assert_eq!(
            parse_default_via("default via 172.25.64.1 dev eth0 \n"),
            Some("172.25.64.1".parse::<IpAddr>().unwrap())
        );
        assert_eq!(parse_default_via(""), None);
        assert_eq!(parse_default_via("default dev eth0 scope link"), None);
    }

    #[test]
    fn parses_the_guest_inet_address() {
        let raw = "5: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500\n    \
                   link/ether 00:15:5d:01:02:03 brd ff:ff:ff:ff:ff:ff\n    \
                   inet 172.20.240.2/20 brd 172.20.255.255 scope global eth0\n    \
                   inet6 fe80::215:5dff:fe01:203/64 scope link\n";
        assert_eq!(
            parse_inet(raw),
            Some("172.20.240.2".parse::<IpAddr>().unwrap())
        );
        // Loopback is never the guest address; absent eth0 parses to none.
        assert_eq!(parse_inet("inet 127.0.0.1/8 scope host lo"), None);
        assert_eq!(parse_inet(""), None);
    }

    #[test]
    fn bootstrap_substitutes_every_marker() {
        let mut s = spec("x");
        s.dev = true;
        s.docker = true;
        s.dev_mount = Some(r"\\?\C:\Users\dev\proj".to_string());
        let assets = crate::guest::ApiServerAssets {
            binary: PathBuf::from(r"C:\Users\dev\.appliance\vm\images\guest-assets\appliance-api-server"),
            console: Some(PathBuf::from(
                r"C:\Users\dev\.appliance\vm\images\guest-assets\appliance-console.tar.gz",
            )),
        };
        let script = build_bootstrap(
            &s,
            Some((Path::new(r"C:\Users\dev\.appliance\vm\images\guest-assets\k3s"), "abc123")),
            Some("-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n"),
            Some(&assets),
            "tok3n",
        );
        for marker in [
            "__K3S_PROVISION__",
            "__K3S_WIN_PATH__",
            "__K3S_SHA256__",
            "__KUBECONFIG_PORT__",
            "__REGISTRY_NODEPORT__",
            "__REGISTRY_HOST_PORT__",
            "__APP_USER_PROVISION__",
            "__APP_UID__",
            "__APP_GID__",
            "__DEV_PROVISION__",
            "__DEV_MOUNT__",
            "__MOUNT_WIN_PATH__",
            "__DOCKER_PROVISION__",
            "__BUILDKIT_PROVISION__",
            "__BUILDKITD_GUEST_PORT__",
            "__K3S_AIRGAP_PREAMBLE__",
            "__APISERVER_PROVISION__",
            "__APISERVER_WIN_PATH__",
            "__CONSOLE_WIN_PATH__",
            "__APISERVER_TOKEN__",
            "__APISERVER_GUEST_PORT__",
            "__HOST_PORT__",
            "__EGRESS_PORT__",
            "__EGRESS_CA__",
            "__AGENT_BIN_PATH__",
            "__AGENT_DOCKER_STUB__",
            "__PROJECT_ID__",
            "__TMUX_CONF__",
            "__ALPINE_BRANCH__",
        ] {
            assert!(
                !script.contains(marker),
                "literal marker {marker} leaked into the WSL bootstrap"
            );
        }
        // The airgap probe stays UNARMED on WSL (no virtio-blk media in a
        // distro): the shared preload block must be a no-op here.
        assert!(
            !script.contains("APPLIANCE_AIRGAP_PROBE=1"),
            "WSL must not arm the k3s airgap probe"
        );
        // The k3s core is the shared fragment, wired to the real ports.
        assert!(script.contains("k3s server"));
        assert!(script.contains(&format!(
            "httpd -f -p {} -h /srv/handoff",
            crate::guest::KUBECONFIG_PORT
        )));
        assert!(script.contains("wslpath -u 'C:\\Users\\dev\\.appliance\\vm\\images\\guest-assets\\k3s'"));
        assert!(script.contains("abc123  /usr/local/bin/k3s"));
        // The verbatim prefix is stripped for wslpath.
        assert!(script.contains(r"wslpath -u 'C:\Users\dev\proj'"));
        assert!(!script.contains(r"\\?\"));
        // Dev + docker + buildkit + CA blocks are present.
        assert!(script.contains("appliance-dev: provisioning development environment"));
        assert!(script.contains("appliance-docker: provisioning in-guest Docker engine"));
        assert!(script.contains("appliance-buildkit: provisioning in-guest BuildKit"));
        assert!(script.contains(&format!(
            "--addr tcp://0.0.0.0:{}",
            crate::guest::BUILDKITD_GUEST_PORT
        )));
        assert!(script.contains("appliance-egress.crt"));
        assert!(script.contains("-----BEGIN CERTIFICATE-----"));
        // The api-server guest binary: drvfs copy, token, launch env,
        // ingress manifest, and the traefik route for the profile URL.
        assert!(script.contains(r"wslpath -u 'C:\Users\dev\.appliance\vm\images\guest-assets\appliance-api-server'"));
        assert!(script.contains(r"wslpath -u 'C:\Users\dev\.appliance\vm\images\guest-assets\appliance-console.tar.gz'"));
        assert!(script.contains("printf '%s' 'tok3n' > /etc/appliance/bootstrap-token"));
        assert!(script.contains(&format!(
            "PORT={} HOST=0.0.0.0",
            crate::guest::API_SERVER_GUEST_PORT
        )));
        assert!(script.contains("host: api.appliance.localhost"));
        assert!(script.contains(&format!("\"hostPort\": {}", s.host_port)));
        assert!(script.contains("/persist/.apiserver-ready"));
        // The user is pinned to the conventional 1000/1000 on WSL.
        assert!(script.contains("APP_UID=1000"));
        assert!(script.contains("APP_GID=1000"));
        // No vz-isms: no vsock agent, no data-disk mkfs, no virtiofs.
        assert!(!script.contains("VSOCK-LISTEN"));
        assert!(!script.contains("mkfs.ext4"));
        assert!(!script.contains("virtiofs"));
    }

    #[test]
    fn plain_vm_omits_dev_docker_and_mount_blocks() {
        let s = spec("x");
        let script = build_bootstrap(&s, Some((Path::new(r"C:\k3s"), "sha")), None, None, "");
        assert!(!script.contains("appliance-dev: provisioning"));
        assert!(!script.contains("appliance-docker: provisioning"));
        assert!(!script.contains("mount --bind"));
        assert!(!script.contains("EGRESSCA"));
        // The k3s control plane and its handoff are present.
        assert!(script.contains("k3s server"));
        assert!(script.contains("/srv/handoff/k3s.yaml"));
        // tmux config is baked for reattachable sessions.
        assert!(script.contains("destroy-unattached off"));
    }

    #[test]
    fn agent_only_swaps_k3s_for_the_agent_handoff() {
        let mut s = spec("sbx");
        s.agent_only = true;
        s.dev = true;
        let script = build_bootstrap(&s, None, None, None, "");
        assert!(!script.contains("k3s server"), "agent-only provisions NO k3s");
        assert!(!script.contains("buildkitd"), "agent-only provisions no buildkit either");
        assert!(script.contains("while [ ! -f /persist/.dev-ready ]"));
        assert!(script.contains("echo agent-ready > /srv/handoff/agent-ready"));
        // The honest-failure docker stub is present without --docker…
        assert!(script.contains("docker is not provisioned in this agent sandbox."));
        // …and absent with it.
        let mut s = spec("sbx");
        s.agent_only = true;
        s.dev = true;
        s.docker = true;
        let script = build_bootstrap(&s, None, None, None, "");
        assert!(!script.contains("docker is not provisioned in this agent sandbox."));
        assert!(script.contains("apk add --no-progress docker docker-cli-compose"));
    }

    #[test]
    fn mounted_project_gets_an_identity_and_the_wipe_guard() {
        let mut s = spec("x");
        s.dev = true;
        s.agent_only = true;
        s.dev_mount = Some(r"C:\Users\dev\proj".to_string());
        let script = build_bootstrap(&s, None, None, None, "");
        assert!(script.contains("rm -rf /persist/npm-global"));
        assert!(!script.contains("APPLIANCE_PROJECT=''"), "a mount must stamp a project id");
        // No mount ⇒ empty identity ⇒ the guard is inert.
        let mut s = spec("x");
        s.dev = true;
        s.agent_only = true;
        let script = build_bootstrap(&s, None, None, None, "");
        assert!(script.contains("APPLIANCE_PROJECT=''"));
    }

    #[test]
    fn every_heredoc_in_the_bootstrap_terminates() {
        // The script is assembled from fragments by string substitution —
        // an off-by-one-newline joint would swallow a heredoc terminator
        // and turn the rest of the script into file content. For every
        // `<<'TAG'` opened, the bare terminator must appear at line start
        // strictly after it.
        let mut s = spec("x");
        s.dev = true;
        s.docker = true;
        s.agent_only = false;
        s.dev_mount = Some(r"C:\proj".to_string());
        for script in [
            build_bootstrap(&s, Some((Path::new(r"C:\k3s"), "sha"))
                , Some("-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n"), None, ""),
            {
                let mut a = spec("sbx");
                a.agent_only = true;
                a.dev = true;
                build_bootstrap(&a, None, None, None, "")
            },
        ] {
            let lines: Vec<&str> = script.lines().collect();
            for (i, line) in lines.iter().enumerate() {
                if let Some(pos) = line.find("<<'") {
                    let tag: &str = line[pos + 3..].split('\'').next().unwrap();
                    assert!(
                        lines[i + 1..].iter().any(|l| l.trim_end() == tag),
                        "heredoc <<'{tag}' opened on line {i} never terminates"
                    );
                }
            }
        }
    }

    #[test]
    fn single_quotes_in_paths_are_escaped() {
        assert_eq!(shell_squote(r"C:\it's"), r"C:\it'\''s");
        assert_eq!(strip_verbatim(r"\\?\C:\x"), r"C:\x");
        assert_eq!(strip_verbatim(r"C:\x"), r"C:\x");
    }
}
