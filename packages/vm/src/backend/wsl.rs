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

mod runtime;

use super::runtime_guest::{shell_squote, strip_verbatim};
use super::VmBackend;
use crate::spec::{VmPaths, VmSpec};
use anyhow::{bail, Context, Result};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
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
const ARTIFACT_GUEST_ROOT: &str = "/opt/appliance/artifacts";
const K3S_GUEST_ARTIFACT: &str = "/opt/appliance/artifacts/k3s";
const APISERVER_GUEST_ARTIFACT: &str = "/opt/appliance/artifacts/appliance-api-server";
const CONSOLE_GUEST_ARTIFACT: &str = "/opt/appliance/artifacts/appliance-console.tar.gz";
const APISERVER_CHECKSUMS_GUEST_ARTIFACT: &str = "/opt/appliance/artifacts/appliance-api-server.sha256";
const APISERVER_RELEASE_GUEST_ARTIFACT: &str = "/opt/appliance/artifacts/control-plane-release.json";
const APISERVER_ENVELOPE_GUEST_ARTIFACT: &str = "/opt/appliance/artifacts/control-plane-release.sig.json";

pub(crate) const WSL_CONF: &str = r#"[automount]
enabled=false
mountFsTab=false

[interop]
enabled=false
appendWindowsPath=false
"#;

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
        if crate::wsl_config::current_uses_mirrored_networking() {
            bail!(
                "WSL mirrored networking is not supported by the managed VM. {}",
                crate::wsl_config::MIRRORED_NETWORKING_REMEDIATION
            );
        }
        match wsl_cmd().arg("--status").output() {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => bail!(
                "WSL is not installed (wsl.exe not found). Install it with `wsl --install` \
                 from an elevated prompt, reboot, then retry."
            ),
            Err(e) => bail!("could not run wsl.exe: {e}"),
            Ok(out) if !out.status.success() => {
                let detail = combined_output(&out);
                let detail = detail.trim();
                match classify_wsl_failure(detail) {
                    Some((_, fix)) => bail!("WSL is not ready: {detail}\n{fix}"),
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
        crate::bringup::set(
            &paths.dir,
            crate::bringup::Phase::Media,
            Some("download (WSL)".to_string()),
        );
        // The pinned k3s binary is streamed into the distro over stdin and
        // verified guest-side. Agent-only VMs run no k3s at all.
        let k3s: Option<(PathBuf, &'static str)> = if spec.runtime || spec.agent_only || !spec.cluster {
            None
        } else {
            Some(crate::guest::ensure_k3s()?)
        };
        let runtime_repositories = if spec.runtime {
            crate::bringup::hostlog("mirroring signed Alpine packages for the WSL Runtime");
            crate::images::ensure_runtime_apk_repositories()?
        } else {
            Vec::new()
        };
        ensure_distro(&distro, &paths)?;

        // Stop any stale resident bootstrap before changing the distro. The
        // one-shot config write is the imported distro's only launch with the
        // WSL defaults; terminating immediately makes the hardened config
        // effective before gateway discovery, artifact receipt, or bootstrap.
        let _ = wsl_cmd().args(["--terminate", &distro]).output();
        push_wsl_conf(&distro)?;
        terminate_distro(&distro).context("apply hardened WSL configuration")?;

        // A short WSL command starts the utility VM and gives us the exact
        // Windows-host gateway before the strict Runtime nft rules are baked.
        // Persist the same value consumed by the host egress URL machinery.
        let runtime_gateway = if spec.runtime {
            let _ = std::fs::remove_file(paths.gateway_ip());
            let gateway = discover_gateway_ip(&distro)
                .and_then(|ip| match ip {
                    IpAddr::V4(ip) => Some(ip),
                    IpAddr::V6(_) => None,
                })
                .context("discover WSL Runtime gateway for strict egress")?;
            std::fs::write(paths.gateway_ip(), gateway.to_string())?;
            Some(gateway)
        } else {
            None
        };

        // Per-VM egress CA, trusted node-wide by the bootstrap (same
        // best-effort contract as the vz boot media).
        let egress_ca: Option<String> = if crate::mitm::ensure_ca(&spec.name).is_ok() {
            std::fs::read_to_string(crate::mitm::ca_cert_path(&spec.name)).ok()
        } else {
            None
        };
        // CLI-staged api-server artifacts + the VM's bootstrap token
        // (generated once, persisted host-side for the CLI to mint keys).
        let apiserver = if spec.runtime || spec.agent_only || !spec.cluster {
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
            &runtime_repositories,
            runtime_gateway,
        )?;
        // Build first so all pure validation (including repository names and
        // mount rendering) succeeds before the distro artifact stage changes.
        crate::bringup::set(
            &paths.dir,
            crate::bringup::Phase::Media,
            Some("streaming artifacts (WSL)".to_string()),
        );
        stream_boot_artifacts(
            &distro,
            k3s.as_ref().map(|(path, sha)| (path.as_path(), *sha)),
            apiserver.as_ref(),
            &runtime_repositories,
        )?;
        crate::bringup::set(
            &paths.dir,
            crate::bringup::Phase::Media,
            Some("artifacts streamed (WSL)".to_string()),
        );
        push_bootstrap(&distro, &script)?;

        // Fresh boot state: truncate the console log (the primary
        // observable surface) and clear every stale readiness marker,
        // including a stop request left by a previous hard kill.
        std::fs::write(paths.console_log(), b"")?;
        let _ = std::fs::remove_file(paths.kubeconfig());
        let _ = std::fs::remove_file(paths.agent_ready());
        let _ = std::fs::remove_file(paths.core_ready());
        let _ = std::fs::remove_file(paths.guest_ip());
        // Keep the last gateway + prefix across boots. Before the new exact
        // guest lease lands, egress admission uses that recorded WSL /20;
        // both files are refreshed as soon as address discovery completes.
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
        let clock_sync_stop = Arc::new(AtomicBool::new(false));
        let _clock_sync_guard = ClockSyncStop(clock_sync_stop.clone());
        spawn_clock_sync(distro.clone(), clock_sync_stop.clone());
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
                clock_sync_stop.store(true, Ordering::Release);
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
                // A sync command starts a stopped distro, so close the gate
                // before termination. The guard closes it on every other
                // return/error path out of run_foreground.
                clock_sync_stop.store(true, Ordering::Release);
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
        destroy_registered_distro(
            &distro,
            || stop_foreground_before_destroy(name),
            |args| {
                let out = wsl_cmd().args(args).output()?;
                Ok((out.status.success(), combined_output(&out)))
            },
        )
    }
}

const DESTROY_STOP_TIMEOUT: Duration = Duration::from_secs(10);

/// Ask the foreground owner to close its clock-sync worker, then wait up to
/// ten seconds for its pidfile to clear or its process to exit. A bounded wait
/// prevents `destroy` from hanging on a stale pid while ensuring a live worker
/// cannot issue a final `wsl -d` that revives the distro after termination.
fn stop_foreground_before_destroy(name: &str) -> Result<()> {
    let paths = VmPaths::for_name(name);
    if paths.dir.exists() {
        std::fs::write(paths.stop_request(), b"stop\n")
            .with_context(|| format!("write {}", paths.stop_request().display()))?;
    }
    let deadline = Instant::now() + DESTROY_STOP_TIMEOUT;
    super::wait_for_foreground_exit(
        || {
            if Instant::now() >= deadline {
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
            false
        },
        || paths.pidfile().exists() && crate::store::read_live_pid(name).is_some(),
    );
    Ok(())
}

/// Termination is best-effort: an already-stopped distro may reject it,
/// but unregister must still run because it owns the destructive result.
/// The stop and runner seams make the cross-process ordering testable without
/// touching WSL or sleeping in unit tests.
fn destroy_registered_distro<S, F>(
    distro: &str,
    mut stop_foreground: S,
    mut run: F,
) -> Result<()>
where
    S: FnMut() -> Result<()>,
    F: FnMut(&[&str]) -> std::io::Result<(bool, String)>,
{
    stop_foreground()?;
    let _ = run(&["--terminate", distro]);
    let (success, detail) = run(&["--unregister", distro]).context("wsl --unregister")?;
    if !success {
        bail!(
            "could not unregister WSL distro '{distro}': {}",
            detail.trim()
        );
    }
    Ok(())
}

const CLOCK_RESYNC_INTERVAL: Duration = Duration::from_secs(30);
const CLOCK_WATCH_TICK: Duration = Duration::from_secs(2);
const WAKE_JUMP_SLACK: Duration = Duration::from_secs(45);

struct ClockSyncStop(Arc<AtomicBool>);

impl Drop for ClockSyncStop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

/// Keep WSL's shared utility-VM clock aligned with the Windows host. WSL's
/// clock commonly stops across host sleep; without this resident push the
/// api-server's 15-second signature tolerance turns the drift into 401s.
fn spawn_clock_sync(distro: String, stop: Arc<AtomicBool>) {
    std::thread::spawn(move || loop {
        if !super::clock_sync_should_tick(&stop) {
            return;
        }
        let epoch = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs());
        if let Ok(epoch) = epoch {
            let command = format!("{}; hwclock -w 2>/dev/null || true", crate::shell::clock_set_command(epoch));
            // Keep the final gate adjacent to the process launch: after a
            // stop is observed this worker must never revive the distro.
            if !super::clock_sync_should_tick(&stop) {
                return;
            }
            match wsl_cmd()
                .args(["-d", &distro, "-u", "root", "--", "sh", "-c", &command])
                .output()
            {
                Ok(out) if !out.status.success() => {
                    eprintln!("clock sync: {}", combined_output(&out).trim());
                }
                Err(e) => eprintln!("clock sync: {e}"),
                _ => {}
            }
        }
        match wait_watching_for_wake(CLOCK_RESYNC_INTERVAL, CLOCK_WATCH_TICK, &stop) {
            Some(true) => eprintln!("clock sync: post-wake clock push"),
            Some(false) => {}
            None => return,
        }
    });
}

fn wait_watching_for_wake(total: Duration, tick: Duration, stop: &AtomicBool) -> Option<bool> {
    let deadline = Instant::now() + total;
    loop {
        let wall_before = std::time::SystemTime::now();
        std::thread::sleep(tick);
        let wall_elapsed = std::time::SystemTime::now()
            .duration_since(wall_before)
            .unwrap_or(tick);
        if !super::clock_sync_should_tick(stop) {
            return None;
        }
        if wall_elapsed > tick + WAKE_JUMP_SLACK {
            return Some(true);
        }
        if Instant::now() >= deadline {
            return Some(false);
        }
    }
}

/// Decode wsl.exe output: its own messages are UTF-16LE, guest output
/// is UTF-8. Interior NULs in the head are the UTF-16 tell. pub(crate)
/// so `shell.rs`'s Windows capture path decodes wsl.exe-level errors
/// the same way.
use crate::wsl_config::classify_wsl_failure;
pub(crate) use crate::wsl_config::decode_wsl;

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
        match classify_wsl_failure(detail) {
            Some((_, fix)) => bail!("could not import WSL distro '{distro}': {detail}\n{fix}"),
            None => bail!(
                "could not import WSL distro '{distro}': {detail}\n\
                 (if this mentions the WSL2 kernel, run `wsl --update` and retry)"
            ),
        }
    }
    Ok(())
}

/// Install the distro policy over stdin. Windows interop is unnecessary: all
/// lifecycle and shell entrypoints invoke `wsl.exe` from the host, while the
/// guest bootstrap contains Linux commands only.
fn push_wsl_conf(distro: &str) -> Result<()> {
    let mut child = wsl_cmd()
        .args([
            "-d",
            distro,
            "-u",
            "root",
            "--",
            "sh",
            "-c",
            "rm -f /etc/wsl.conf && cat > /etc/wsl.conf && chmod 0644 /etc/wsl.conf",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .context("provision /etc/wsl.conf")?;
    let stream_result = child
        .stdin
        .take()
        .expect("piped stdin")
        .write_all(WSL_CONF.as_bytes())
        .context("stream /etc/wsl.conf");
    let out = child.wait_with_output()?;
    if !out.status.success() {
        bail!(
            "could not provision /etc/wsl.conf: {}",
            combined_output(&out).trim()
        );
    }
    stream_result?;
    Ok(())
}

fn terminate_distro(distro: &str) -> Result<()> {
    let out = wsl_cmd()
        .args(["--terminate", distro])
        .output()
        .context("wsl --terminate")?;
    if !out.status.success() {
        bail!(
            "could not terminate WSL distro '{distro}': {}",
            combined_output(&out).trim()
        );
    }
    Ok(())
}

fn digest_open_file(file: &mut std::fs::File) -> Result<String> {
    use std::fmt::Write as _;
    let mut context = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        context.update(&buffer[..read]);
    }
    let mut digest = String::with_capacity(64);
    for byte in context.finish().as_ref() {
        let _ = write!(digest, "{byte:02x}");
    }
    Ok(digest)
}

/// Stream the bytes from the same open file handle used to compute the host
/// digest, then require the guest to verify size + sha256 before installation.
/// Api-server and console callers use this as integrity-only transport: those
/// artifacts are not pinned to a separately authenticated release identity.
fn stream_guest_artifact(
    distro: &str,
    source: &Path,
    destination: &str,
    expected_sha256: Option<&str>,
) -> Result<()> {
    let mut source_file = std::fs::File::open(source)
        .with_context(|| format!("open artifact {}", source.display()))?;
    let size = source_file
        .metadata()
        .with_context(|| format!("stat artifact {}", source.display()))?
        .len();
    let sha256 = digest_open_file(&mut source_file)
        .with_context(|| format!("hash artifact {}", source.display()))?;
    if let Some(expected) = expected_sha256 {
        if !sha256.eq_ignore_ascii_case(expected) {
            bail!(
                "artifact sha256 changed before streaming {}: expected {expected}, got {sha256}",
                source.display()
            );
        }
    }
    source_file.seek(SeekFrom::Start(0))?;
    let receive =
        crate::backend::runtime_guest::artifact_receive_command(destination, size, &sha256)?;
    let mut child = wsl_cmd()
        .args(["-d", distro, "-u", "root", "--", "sh", "-c", &receive])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("start artifact receiver for {destination}"))?;
    let stream_result = {
        let mut stdin = child.stdin.take().expect("piped stdin");
        std::io::copy(&mut source_file, &mut stdin)
            .with_context(|| format!("stream artifact {}", source.display()))
    };
    let out = child.wait_with_output()?;
    if !out.status.success() {
        bail!(
            "guest rejected artifact {}: {}",
            source.display(),
            combined_output(&out).trim()
        );
    }
    stream_result?;
    Ok(())
}

fn clear_guest_artifacts(distro: &str) -> Result<()> {
    let command = format!("rm -rf {ARTIFACT_GUEST_ROOT} && mkdir -p {ARTIFACT_GUEST_ROOT}");
    let out = wsl_cmd()
        .args(["-d", distro, "-u", "root", "--", "sh", "-c", &command])
        .output()
        .context("clear stale guest artifacts")?;
    if !out.status.success() {
        bail!(
            "could not clear stale guest artifacts: {}",
            combined_output(&out).trim()
        );
    }
    Ok(())
}

fn stream_boot_artifacts(
    distro: &str,
    k3s: Option<(&Path, &str)>,
    apiserver: Option<&crate::guest::ApiServerAssets>,
    runtime_repositories: &[crate::images::RuntimeApkRepository],
) -> Result<()> {
    clear_guest_artifacts(distro)?;
    if let Some((path, expected_sha256)) = k3s {
        stream_guest_artifact(distro, path, K3S_GUEST_ARTIFACT, Some(expected_sha256))?;
    }
    if let Some(assets) = apiserver {
        stream_guest_artifact(distro, &assets.binary, APISERVER_GUEST_ARTIFACT, None)?;
        if let Some(console) = &assets.console {
            stream_guest_artifact(distro, console, CONSOLE_GUEST_ARTIFACT, None)?;
        }
        if let Some(evidence) = &assets.release_evidence {
            stream_guest_artifact(distro, &evidence.checksums, APISERVER_CHECKSUMS_GUEST_ARTIFACT, None)?;
            stream_guest_artifact(distro, &evidence.payload, APISERVER_RELEASE_GUEST_ARTIFACT, None)?;
            stream_guest_artifact(distro, &evidence.envelope, APISERVER_ENVELOPE_GUEST_ARTIFACT, None)?;
        }
    }
    for repository in runtime_repositories {
        let guest_directory = format!("{ARTIFACT_GUEST_ROOT}/runtime-apks/{}", repository.name);
        stream_guest_artifact(
            distro,
            &repository.index,
            &format!("{guest_directory}/APKINDEX.tar.gz"),
            None,
        )?;
        for package in &repository.packages {
            let filename = package
                .file_name()
                .and_then(|name| name.to_str())
                .context("Runtime APK artifact has no UTF-8 filename")?;
            if filename.contains(['/', '\\', '\0', '\n', '\r']) || matches!(filename, "." | "..") {
                bail!("invalid Runtime APK artifact filename '{filename}'");
            }
            stream_guest_artifact(
                distro,
                package,
                &format!("{guest_directory}/{filename}"),
                None,
            )?;
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

# --- packages ---------------------------------------------------------
__PACKAGE_PROVISION__

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

# --- shared Runtime lifecycle and backend adapters -------------------
mkdir -p /usr/local/bin
cat > /usr/local/bin/appliance-runtime-supervisor <<'APPLIANCE_RUNTIME_SUPERVISOR'
__RUNTIME_SUPERVISOR__
APPLIANCE_RUNTIME_SUPERVISOR
cat > /usr/local/bin/appliance-runtime-compound-supervisor <<'APPLIANCE_RUNTIME_COMPOUND_SUPERVISOR'
__RUNTIME_COMPOUND_SUPERVISOR__
APPLIANCE_RUNTIME_COMPOUND_SUPERVISOR
cat > /usr/local/bin/runtime-share-mount <<'APPLIANCE_RUNTIME_SHARE_MOUNT'
__RUNTIME_SHARE_MOUNT__
APPLIANCE_RUNTIME_SHARE_MOUNT
cat > /usr/local/bin/runtime-share-unmount <<'APPLIANCE_RUNTIME_SHARE_UNMOUNT'
__RUNTIME_SHARE_UNMOUNT__
APPLIANCE_RUNTIME_SHARE_UNMOUNT
cat > /usr/local/bin/runtime-principal-snat <<'APPLIANCE_RUNTIME_PRINCIPAL_SNAT'
__RUNTIME_PRINCIPAL_SNAT__
APPLIANCE_RUNTIME_PRINCIPAL_SNAT
chmod 0755 \
  /usr/local/bin/appliance-runtime-supervisor \
  /usr/local/bin/appliance-runtime-compound-supervisor \
  /usr/local/bin/runtime-share-mount \
  /usr/local/bin/runtime-share-unmount \
  /usr/local/bin/runtime-principal-snat

# --- dev environment (appliance vm dev) ---------------------------------
__DEV_PROVISION__
# --- pooled Appliance Runtime --------------------------------------------
__RUNTIME_PROVISION__
__RUNTIME_BOOTSTRAP_GATE__
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

const WSL_BASE_PACKAGE_PROVISION: &str = r#"# Idempotent; served from the persistent apk cache after the first boot.
cat > /etc/apk/repositories <<'REPOS'
https://dl-cdn.alpinelinux.org/alpine/__ALPINE_BRANCH__/main
https://dl-cdn.alpinelinux.org/alpine/__ALPINE_BRANCH__/community
REPOS
mkdir -p /persist/apk-cache /etc/apk
ln -sfn /persist/apk-cache /etc/apk/cache
apk update --no-progress >/dev/null 2>&1 || true
apk add --no-progress ca-certificates busybox-extras sudo tmux libstdc++ libgcc unzip \
  || echo "WARNING: base package install failed (offline?)"
"#;

/// Fail the resident bootstrap promptly when the shared Runtime provision did
/// not produce a usable lifecycle endpoint. `host_services` independently
/// mirrors these checks before publishing the host-side marker.
const WSL_RUNTIME_BOOTSTRAP_GATE: &str = r#"RUNTIME_READY=0
for _ in $(seq 1 900); do
  if [ -x /usr/local/bin/appliance-runtime-supervisor ] && \
     [ -x /usr/local/bin/appliance-runtime-compound-supervisor ] && \
     [ -S /run/containerd/containerd.sock ] && \
     ctr version >/dev/null 2>&1 && socat -V >/dev/null 2>&1 && \
     nft --version >/dev/null 2>&1 && jq --version >/dev/null 2>&1 && \
     ip -V >/dev/null 2>&1; then
    RUNTIME_READY=1
    break
  fi
  sleep 0.1
done
if [ "$RUNTIME_READY" -ne 1 ]; then
  echo "FATAL: Appliance Runtime provision did not become ready" >&2
  exit 1
fi
"#;

const WSL_RUNTIME_READINESS_PROBE: &str = "test -x /usr/local/bin/appliance-runtime-supervisor \
&& test -x /usr/local/bin/appliance-runtime-compound-supervisor \
&& test -S /run/containerd/containerd.sock \
&& ctr version >/dev/null 2>&1 \
&& socat -V >/dev/null 2>&1 \
&& nft --version >/dev/null 2>&1 \
&& jq --version >/dev/null 2>&1 \
&& ip -V >/dev/null 2>&1";

/// WSL imports the Alpine minirootfs without init. OpenRC supports standalone
/// service invocation once its softlevel marker exists; if that attempt still
/// leaves no containerd socket, launch the daemon directly like dockerd.
const WSL_RUNTIME_OPENRC_STANDALONE: &str = r#"# No init runs in an imported WSL minirootfs. This is OpenRC's standalone
# service-manager state, created before the shared Runtime provision calls
# rc-service. The shared fragment stays byte-identical with VZ.
mkdir -p /run/openrc
touch /run/openrc/softlevel
"#;

const WSL_RUNTIME_CONTAINERD_FALLBACK: &str = r#"# rc-service may be unavailable or ineffective without an OpenRC init process.
for _ in $(seq 1 20); do
  [ -S /run/containerd/containerd.sock ] && break
  sleep 0.1
done
if [ ! -S /run/containerd/containerd.sock ]; then
  echo "appliance-runtime: launching containerd directly (WSL has no init)"
  nohup setsid containerd </dev/null >>/var/log/appliance-runtime-containerd.log 2>&1 &
fi
"#;

/// WSL replacement for `K3S_MEDIA_COPY`: the host streams the pinned binary to
/// a fixed guest path before bootstrap. Re-verify the committed sha256 before
/// installing it, in addition to the receive-time size + digest check.
/// Prepended to the shared `guest::K3S_COMMON`.
const WSL_K3S_COPY: &str = r#"# --- k3s -------------------------------------------------------------
K3S_SRC=/opt/appliance/artifacts/k3s
if [ ! -f "$K3S_SRC" ]; then
  echo "FATAL: streamed k3s binary not present at $K3S_SRC"
  exit 1
fi
mkdir -p /usr/local/bin
# Plain `-c` with output redirected, NOT `-c -s`: `-s` is a busybox-only
# spelling, and once provisioning installs GNU coreutils into the
# persisted distro its sha256sum shadows busybox, rejects `-s`, and
# fails this check (and every subsequent boot) unconditionally.
if ! echo '__K3S_SHA256__  /usr/local/bin/k3s' | sha256sum -c >/dev/null 2>&1; then
  if ! echo '__K3S_SHA256__  /opt/appliance/artifacts/k3s' | sha256sum -c >/dev/null 2>&1; then
    echo "FATAL: streamed k3s binary failed its sha256 check"
    exit 1
  fi
  cp "$K3S_SRC" /usr/local/bin/k3s
  chmod +x /usr/local/bin/k3s
fi
if ! echo '__K3S_SHA256__  /usr/local/bin/k3s' | sha256sum -c >/dev/null 2>&1; then
  echo "FATAL: k3s binary failed its sha256 check after copy"
  exit 1
fi
"#;

/// WSL replacement for `guest::APISERVER_MEDIA_COPY`: the CLI-staged
/// api-server binary (and optional console bundle) are streamed into fixed
/// guest paths before bootstrap, and the bootstrap token is embedded in this
/// root-only script (the same trust level as the vz apkovl). Prepended to the
/// shared `guest::APISERVER_COMMON`.
const WSL_APISERVER_COPY: &str = r#"# --- appliance api-server ---------------------------------------------
# The control plane runs as a plain guest binary — no image delivery,
# no docker anywhere. APISERVER_SEED_COPY verifies this streamed stage.
mkdir -p /persist/appliance /usr/local/bin /etc/appliance
APISERVER_SRC=/opt/appliance/artifacts/appliance-api-server
CONSOLE_SRC=/opt/appliance/artifacts/appliance-console.tar.gz
RELEASE_CHECKSUMS=/opt/appliance/artifacts/appliance-api-server.sha256
RELEASE_PAYLOAD=/opt/appliance/artifacts/control-plane-release.json
RELEASE_ENVELOPE=/opt/appliance/artifacts/control-plane-release.sig.json
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
/// host folder is shared in: mount exactly the validated Windows workspace,
/// without exposing its parent drive through WSL's automount.
const WSL_DEV_MOUNT: &str = r#"# Targeted drvfs workspace mount (appliance vm dev up --mount).
APPLIANCE_MOUNT_SRC='__MOUNT_WIN_PATH__'
if mount -t drvfs "$APPLIANCE_MOUNT_SRC" /persist/workspace -o uid=1000,gid=1000,metadata; then
  echo "appliance-dev: mounted shared host folder at /persist/workspace"
else
  echo "appliance-dev: WARNING targeted drvfs mount of the shared host folder failed"
fi"#;

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
    runtime_repositories: &[crate::images::RuntimeApkRepository],
    runtime_gateway: Option<std::net::Ipv4Addr>,
) -> Result<String> {
    let state_dir = crate::store::canonicalize_with_missing_tail(&crate::store::vm_root());
    build_bootstrap_with_inputs(
        spec,
        BootstrapInputs {
            k3s,
            egress_ca_pem,
            apiserver,
            bootstrap_token,
            runtime_repositories,
            runtime_gateway,
            state_dir: &state_dir,
        },
    )
}

struct BootstrapInputs<'a> {
    k3s: Option<(&'a Path, &'static str)>,
    egress_ca_pem: Option<&'a str>,
    apiserver: Option<&'a crate::guest::ApiServerAssets>,
    bootstrap_token: &'a str,
    runtime_repositories: &'a [crate::images::RuntimeApkRepository],
    runtime_gateway: Option<std::net::Ipv4Addr>,
    state_dir: &'a Path,
}

fn build_bootstrap_with_inputs(spec: &VmSpec, inputs: BootstrapInputs<'_>) -> Result<String> {
    let BootstrapInputs {
        k3s,
        egress_ca_pem,
        apiserver,
        bootstrap_token,
        runtime_repositories,
        runtime_gateway,
        state_dir,
    } = inputs;
    let dev = spec.dev;
    let mount = spec.dev_mount.as_deref().map(strip_verbatim);
    // Project identity for the npm-global wipe: a short hash of the
    // mounted path, mirroring guest.rs (shell-safe, uniquely keyed).
    let project_id = mount
        .map(|p| crate::images::content_sha256_hex(p.as_bytes())[..16].to_string())
        .unwrap_or_default();
    let state_dir = strip_verbatim(&state_dir.to_string_lossy()).to_string();
    let runtime_share_mount =
        crate::backend::runtime_guest::wsl_runtime_share_mount_script(&state_dir);

    let k3s_block = if spec.runtime {
        String::new()
    } else if spec.agent_only {
        WSL_AGENT_HANDOFF.to_string()
    } else if let Some((_path, sha)) = k3s {
        format!("{WSL_K3S_COPY}{}", crate::guest::K3S_COMMON).replace("__K3S_SHA256__", sha)
    } else {
        String::new()
    };
    // The api-server guest binary rides k3s VMs whose assets were
    // staged. Same substitution rules as the k3s block: injected before
    // the port markers so its nested markers expand too.
    let apiserver_block = match (spec.runtime, spec.cluster, spec.agent_only, apiserver) {
        (false, true, false, Some(_assets)) => {
            format!(
                "{WSL_APISERVER_COPY}{}{}",
                crate::guest::APISERVER_SEED_COPY,
                crate::guest::APISERVER_COMMON
            )
                .replace("__APISERVER_TOKEN__", &shell_squote(bootstrap_token))
        }
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
    let package_provision = if spec.runtime {
        let borrowed: Vec<&str> = runtime_repositories
            .iter()
            .map(|repository| repository.name.as_str())
            .collect();
        crate::backend::runtime_guest::wsl_runtime_apk_install(
            &borrowed,
            crate::images::RUNTIME_WORLD,
        )?
    } else {
        WSL_BASE_PACKAGE_PROVISION.to_string()
    };
    let runtime_principal_snat = if spec.runtime {
        crate::backend::runtime_guest::runtime_principal_snat_script(
            crate::backend::runtime_guest::RuntimeGuestBackend::WslDrvFs,
            runtime_gateway,
            spec.egress_port,
        )?
    } else {
        "#!/bin/sh\nset -eu\n".to_string()
    };
    let runtime_provision = if spec.runtime {
        format!(
            "{WSL_RUNTIME_OPENRC_STANDALONE}{}{WSL_RUNTIME_CONTAINERD_FALLBACK}",
            crate::guest::RUNTIME_PROVISION
        )
    } else {
        String::new()
    };

    Ok(WSL_BOOTSTRAP
        // Blocks first (they carry nested markers), then the markers.
        .replace("__PACKAGE_PROVISION__", &package_provision)
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
        .replace(
            "__RUNTIME_PROVISION__",
            &runtime_provision,
        )
        .replace(
            "__RUNTIME_BOOTSTRAP_GATE__",
            if spec.runtime { WSL_RUNTIME_BOOTSTRAP_GATE } else { "" },
        )
        .replace("__RUNTIME_SUPERVISOR__", crate::guest::RUNTIME_SUPERVISOR)
        .replace(
            "__RUNTIME_COMPOUND_SUPERVISOR__",
            crate::guest::RUNTIME_COMPOUND_SUPERVISOR,
        )
        .replace(
            "__RUNTIME_SHARE_MOUNT__",
            &runtime_share_mount,
        )
        .replace(
            "__RUNTIME_SHARE_UNMOUNT__",
            crate::backend::runtime_guest::runtime_share_unmount_script(),
        )
        .replace(
            "__RUNTIME_PRINCIPAL_SNAT__",
            &runtime_principal_snat,
        )
        // BuildKit rides every k3s VM, exactly as on the vz backend —
        // injected before the port markers below so its nested
        // __REGISTRY_*__/__BUILDKITD_GUEST_PORT__ markers expand too.
        .replace(
            "__BUILDKIT_PROVISION__",
            if spec.cluster && !spec.agent_only { crate::guest::BUILDKIT_PROVISION } else { "" },
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
        .replace("__ALPINE_BRANCH__", ALPINE_BRANCH))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WslHostReadiness {
    Core,
    Runtime,
    Agent,
    Platform,
}

fn wsl_host_readiness(spec: &VmSpec) -> WslHostReadiness {
    if spec.runtime {
        WslHostReadiness::Runtime
    } else if spec.agent_only {
        WslHostReadiness::Agent
    } else if spec.cluster {
        WslHostReadiness::Platform
    } else {
        WslHostReadiness::Core
    }
}

/// Guest-facing host services — the WSL sibling of `guest::host_services`'
/// NAT branch. The guest address comes from `ip addr` inside the distro
/// (there is no macOS lease table here); everything downstream — the TCP
/// forwards, the kubeconfig/agent handoff, the bringup phases and marker
/// files `up` polls on — is the same contract.
fn host_services(spec: &VmSpec, vm_dir: &Path, distro: &str, apiserver_staged: bool) -> Result<()> {
    let readiness = wsl_host_readiness(spec);
    let (guest_ip, prefix_len) = discover_guest_ip(distro, Duration::from_secs(120))?;
    crate::bringup::hostlog(&format!("guest address: {guest_ip}"));
    std::fs::write(vm_dir.join("guest-ip"), guest_ip.to_string())?;
    let paths = VmPaths { dir: vm_dir.to_path_buf() };
    std::fs::write(paths.guest_prefix_len(), prefix_len.to_string())?;
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

    if spec.runtime {
        if !matches!(guest_ip, IpAddr::V4(_)) {
            bail!("WSL Runtime requires an IPv4 NAT lease");
        }
        runtime::spawn_forward_control(spec.name.clone(), distro.to_string())?;
    }

    let bind_hint = |port: u16, what: &str| {
        format!(
            "cannot forward 127.0.0.1:{port} ({what}) — the port is taken. Stop the microVM holding it with `appliance vm stop`, or run `appliance doctor` to find what owns the port."
        )
    };

    if spec.cluster && !spec.agent_only {
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

    let (core_message, core_probe) = if readiness == WslHostReadiness::Runtime {
        ("waiting for WSL Runtime provision", WSL_RUNTIME_READINESS_PROBE)
    } else {
        ("waiting for WSL core shell", "true")
    };
    crate::bringup::hostlog(core_message);
    let core_deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if crate::guest_exec::run_wrapped(&spec.name, core_probe).is_ok() {
            break;
        }
        if Instant::now() >= core_deadline {
            if readiness == WslHostReadiness::Runtime {
                bail!("WSL Runtime provision did not become ready within 120s");
            }
            bail!("guest core shell did not answer within 120s");
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    std::fs::write(vm_dir.join("core-ready"), b"core-ready\n")?;

    // Runtime is selected before the agent-only profile: it has no dev
    // provision and must never enter the `.dev-ready`/600-second handoff.
    if readiness == WslHostReadiness::Runtime {
        crate::bringup::hostlog("WSL Runtime provision and supervisor ready");
        crate::bringup::set(vm_dir, crate::bringup::Phase::Ready, None);
        return Ok(());
    }

    if readiness == WslHostReadiness::Core {
        crate::bringup::set(vm_dir, crate::bringup::Phase::Ready, None);
        return Ok(());
    }

    if readiness == WslHostReadiness::Agent {
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
fn discover_guest_ip(distro: &str, timeout: Duration) -> Result<(IpAddr, u8)> {
    let deadline = Instant::now() + timeout;
    loop {
        let out = wsl_cmd()
            .args(["-d", distro, "-u", "root", "--", "ip", "addr", "show", "eth0"])
            .output();
        if let Ok(out) = out {
            if out.status.success() {
                if let Some((ip, prefix_len)) = crate::network_lease::parse_inet_v4(&decode_wsl(&out.stdout)) {
                    return Ok((IpAddr::V4(ip), prefix_len));
                }
            }
        }
        if Instant::now() >= deadline {
            // The whole forwarding model (host dials guest_ip directly)
            // assumes classic NAT networking. Mirrored mode has no NAT
            // eth0 lease, so IP discovery times out here — name the real
            // cause instead of a bare timeout.
            if crate::wsl_config::current_uses_mirrored_networking() {
                bail!(
                    "guest eth0 address did not appear within {timeout:?} — your WSL is in \
                     mirrored networking mode, which the managed VM does not support yet. {}",
                    crate::wsl_config::MIRRORED_NETWORKING_REMEDIATION
                );
            }
            bail!("guest eth0 address did not appear within {timeout:?}");
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// Resolve the lease at bind time so a restarted WSL VM cannot retain a
/// listener aimed at its previous NAT address.
fn current_guest_ipv4(distro: &str) -> Result<std::net::Ipv4Addr> {
    let out = wsl_cmd()
        .args(["-d", distro, "-u", "root", "--", "ip", "addr", "show", "eth0"])
        .output()
        .context("query current WSL guest eth0 address")?;
    if !out.status.success() {
        bail!("current WSL guest eth0 address is unavailable");
    }
    crate::network_lease::parse_inet_v4(&decode_wsl(&out.stdout))
        .map(|(ip, _)| ip)
        .context("current WSL guest has no IPv4 NAT lease")
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

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str) -> VmSpec {
        VmSpec::defaults(name)
    }

    fn build_bootstrap(
        spec: &VmSpec,
        k3s: Option<(&Path, &'static str)>,
        egress_ca_pem: Option<&str>,
        apiserver: Option<&crate::guest::ApiServerAssets>,
        bootstrap_token: &str,
        runtime_repositories: &[crate::images::RuntimeApkRepository],
        runtime_gateway: Option<std::net::Ipv4Addr>,
    ) -> Result<String> {
        super::build_bootstrap_with_inputs(
            spec,
            BootstrapInputs {
                k3s,
                egress_ca_pem,
                apiserver,
                bootstrap_token,
                runtime_repositories,
                runtime_gateway,
                state_dir: Path::new(r"C:\Users\appliance-test\.appliance\vm"),
            },
        )
    }

    #[test]
    fn distro_names_are_namespaced() {
        assert_eq!(distro_name("appliance"), "appliance-vm-appliance");
        assert_eq!(distro_name("traffic"), "appliance-vm-traffic");
    }

    #[test]
    fn wsl_conf_disables_drive_automount_and_interop() {
        let mut section = "";
        let mut values = std::collections::BTreeMap::new();
        for raw in WSL_CONF.lines() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
                continue;
            }
            if let Some(name) = line.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
                section = name;
                continue;
            }
            let (key, value) = line.split_once('=').expect("valid INI assignment");
            values.insert((section, key.trim()), value.trim());
        }
        assert_eq!(values.get(&("automount", "enabled")), Some(&"false"));
        assert_eq!(values.get(&("interop", "enabled")), Some(&"false"));
        assert_eq!(values.get(&("interop", "appendWindowsPath")), Some(&"false"));
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
    fn destroy_stops_foreground_then_terminates_before_unregistering() {
        use std::cell::RefCell;

        let calls = RefCell::new(Vec::<Vec<String>>::new());
        destroy_registered_distro(
            "appliance-vm-test",
            || {
                calls.borrow_mut().push(vec!["stop-and-wait".to_string()]);
                Ok(())
            },
            |args| {
                calls
                    .borrow_mut()
                    .push(args.iter().map(|arg| (*arg).to_string()).collect());
                // Termination failure is deliberately ignored; unregister still
                // owns the final result.
                Ok((args[0] != "--terminate", "already stopped".to_string()))
            },
        )
        .unwrap();
        assert_eq!(
            calls.into_inner(),
            vec![
                vec!["stop-and-wait".to_string()],
                vec!["--terminate".to_string(), "appliance-vm-test".to_string()],
                vec!["--unregister".to_string(), "appliance-vm-test".to_string()],
            ]
        );
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
            crate::network_lease::parse_inet_v4(raw),
            Some(("172.20.240.2".parse().unwrap(), 20))
        );
        // Loopback is never the guest address; absent eth0 parses to none.
        assert_eq!(crate::network_lease::parse_inet_v4("inet 127.0.0.1/8 scope host lo"), None);
        assert_eq!(crate::network_lease::parse_inet_v4(""), None);
    }

    #[test]
    fn bootstrap_substitutes_every_marker() {
        let mut s = spec("x");
        s.dev = true;
        s.docker = true;
        let mount = r"\\?\C:\project";
        s.dev_mount = Some(mount.to_string());
        let assets_dir = crate::guest::assets_dir();
        let k3s = assets_dir.join("k3s");
        let assets = crate::guest::ApiServerAssets {
            binary: assets_dir.join("appliance-api-server"),
            console: Some(assets_dir.join("appliance-console.tar.gz")),
            release_evidence: None,
        };
        let script = build_bootstrap(
            &s,
            Some((&k3s, "abc123")),
            Some("-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n"),
            Some(&assets),
            "tok3n",
            &[],
            None,
        )
        .unwrap();
        for marker in [
            "__K3S_PROVISION__",
            "__PACKAGE_PROVISION__",
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
            "__RUNTIME_PROVISION__",
            "__RUNTIME_BOOTSTRAP_GATE__",
            "__RUNTIME_SUPERVISOR__",
            "__RUNTIME_COMPOUND_SUPERVISOR__",
            "__RUNTIME_SHARE_MOUNT__",
            "__RUNTIME_SHARE_UNMOUNT__",
            "__RUNTIME_PRINCIPAL_SNAT__",
            "__BUILDKIT_PROVISION__",
            "__BUILDKITD_GUEST_PORT__",
            "__K3S_AIRGAP_PREAMBLE__",
            "__APISERVER_PROVISION__",
            "__CONSOLE_PROVISION__",
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
        assert!(script.contains("K3S_SRC=/opt/appliance/artifacts/k3s"));
        assert!(script.contains("abc123  /usr/local/bin/k3s"));
        let mount_path = shell_squote(strip_verbatim(mount));
        assert!(script.contains(&format!("APPLIANCE_MOUNT_SRC='{mount_path}'")));
        assert!(script.contains(
            "mount -t drvfs \"$APPLIANCE_MOUNT_SRC\" /persist/workspace -o uid=1000,gid=1000,metadata"
        ));
        assert!(!script.contains("wslpath"));
        assert!(!script.contains("/mnt/c"));
        // Dev + docker + CA blocks are present; core-ready omits BuildKit.
        assert!(script.contains("appliance-dev: provisioning development environment"));
        assert!(script.contains("appliance-docker: provisioning in-guest Docker engine"));
        assert!(!script.contains("appliance-buildkit: provisioning in-guest BuildKit"));
        assert!(!script.contains(&format!(
            "--addr tcp://0.0.0.0:{}",
            crate::guest::BUILDKITD_GUEST_PORT
        )));
        assert!(script.contains("appliance-egress.crt"));
        assert!(script.contains("-----BEGIN CERTIFICATE-----"));
        // VmSpec::defaults is core-only: even supplied assets are not
        // staged until the spec is promoted to the cluster layer.
        assert!(!script.contains("APISERVER_SRC="));
        assert!(!script.contains("CONSOLE_SRC="));
        assert!(!script.contains("/persist/.apiserver-ready"));
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
        let script = build_bootstrap(
            &s,
            Some((Path::new(r"C:\k3s"), "sha")),
            None,
            None,
            "",
            &[],
            None,
        )
        .unwrap();
        assert!(!script.contains("appliance-dev: provisioning"));
        assert!(!script.contains("appliance-docker: provisioning"));
        assert!(!script.contains("mounted shared host folder at /persist/workspace"));
        assert!(!script.contains("EGRESSCA"));
        // The k3s control plane and its handoff are present.
        assert!(script.contains("k3s server"));
        assert!(script.contains("/srv/handoff/k3s.yaml"));
        // tmux config is baked for reattachable sessions.
        assert!(script.contains("destroy-unattached off"));
    }

    #[test]
    fn runtime_bootstrap_selects_pinned_profile_before_agent() {
        let mut s = spec("runtime");
        s.runtime = true;
        s.agent_only = true;
        s.dev = false;
        s.cluster = false;
        assert_eq!(wsl_host_readiness(&s), WslHostReadiness::Runtime);
        let repositories = vec![
            crate::images::RuntimeApkRepository {
                name: "main".to_string(),
                index: PathBuf::from(r"C:\runtime-apks\main\APKINDEX.tar.gz"),
                packages: Vec::new(),
            },
            crate::images::RuntimeApkRepository {
                name: "community".to_string(),
                index: PathBuf::from(r"C:\runtime-apks\community\APKINDEX.tar.gz"),
                packages: Vec::new(),
            },
        ];
        let script = build_bootstrap(
            &s,
            None,
            None,
            None,
            "",
            &repositories,
            Some("172.25.64.1".parse().unwrap()),
        )
        .unwrap();
        assert!(script.contains("containerd=2.0.0-r5"));
        assert!(script.contains("nftables=1.1.1-r0"));
        assert!(script.contains("--no-network"));
        assert!(script.contains(crate::guest::RUNTIME_PROVISION));
        let openrc = script.find("touch /run/openrc/softlevel").unwrap();
        let shared = script.find(crate::guest::RUNTIME_PROVISION).unwrap();
        let fallback = script
            .find("nohup setsid containerd </dev/null")
            .unwrap();
        assert!(openrc < shared && shared < fallback);
        assert!(script.contains("for _ in $(seq 1 900)"));
        for tool_probe in ["nft --version", "jq --version", "ip -V"] {
            assert!(WSL_RUNTIME_BOOTSTRAP_GATE.contains(tool_probe));
            assert!(WSL_RUNTIME_READINESS_PROBE.contains(tool_probe));
        }
        assert!(script.contains(crate::guest::RUNTIME_SUPERVISOR));
        assert!(script.contains(crate::guest::RUNTIME_COMPOUND_SUPERVISOR));
        assert!(script.contains("runtime-share-mount"));
        assert!(script.contains(
            "mount -t drvfs \"$HOST_PATH\" \"$SHARE\" -o ro,uid=1000,gid=1000,metadata"
        ));
        assert!(script.contains("APK_SOURCE=/opt/appliance/artifacts/runtime-apks/main"));
        assert!(!script.contains("wslpath"));
        assert!(!script.contains("/mnt/c"));
        assert!(script.contains("ip saddr 192.168.127.0/24 oifname \"eth0\" masquerade"));
        assert!(!script.contains("https://dl-cdn.alpinelinux.org"));
        assert!(!script.contains("while [ ! -f /persist/.dev-ready ]"));
        assert!(!script.contains("agent-ready"));
        assert!(!script.contains("k3s server"));
        assert!(!script.contains("__"), "template marker leaked into Runtime bootstrap");
    }

    #[test]
    fn agent_only_swaps_k3s_for_the_agent_handoff() {
        let mut s = spec("sbx");
        s.agent_only = true;
        s.dev = true;
        let script = build_bootstrap(&s, None, None, None, "", &[], None).unwrap();
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
        let script = build_bootstrap(&s, None, None, None, "", &[], None).unwrap();
        assert!(!script.contains("docker is not provisioned in this agent sandbox."));
        assert!(script.contains("apk add --no-progress docker docker-cli-compose"));
    }

    #[test]
    fn mounted_project_gets_an_identity_and_the_wipe_guard() {
        let mut s = spec("x");
        s.dev = true;
        s.agent_only = true;
        s.dev_mount = Some(r"C:\Users\dev\proj".to_string());
        let script = build_bootstrap(&s, None, None, None, "", &[], None).unwrap();
        assert!(script.contains("rm -rf /persist/npm-global"));
        assert!(!script.contains("APPLIANCE_PROJECT=''"), "a mount must stamp a project id");
        // No mount ⇒ empty identity ⇒ the guard is inert.
        let mut s = spec("x");
        s.dev = true;
        s.agent_only = true;
        let script = build_bootstrap(&s, None, None, None, "", &[], None).unwrap();
        assert!(script.contains("APPLIANCE_PROJECT=''"));
    }

    #[test]
    fn cluster_bootstrap_uses_only_streamed_api_artifacts() {
        let mut s = spec("cluster");
        s.cluster = true;
        let assets = crate::guest::ApiServerAssets {
            binary: PathBuf::from(r"C:\Users\Avery\.appliance\guest-assets\appliance-api-server"),
            console: Some(PathBuf::from(
                r"C:\Users\Avery\.appliance\guest-assets\appliance-console.tar.gz",
            )),
            release_evidence: Some(crate::guest::ApiServerReleaseEvidence {
                checksums: PathBuf::from(r"C:\Users\Avery\.appliance\guest-assets\appliance-api-server.sha256"),
                payload: PathBuf::from(r"C:\Users\Avery\.appliance\guest-assets\control-plane-release.json"),
                envelope: PathBuf::from(
                    r"C:\Users\Avery\.appliance\guest-assets\control-plane-release.sig.json",
                ),
            }),
        };
        let script = build_bootstrap(&s, None, None, Some(&assets), "tok3n", &[], None).unwrap();
        assert!(script.contains(
            "APISERVER_SRC=/opt/appliance/artifacts/appliance-api-server"
        ));
        assert!(script.contains(
            "CONSOLE_SRC=/opt/appliance/artifacts/appliance-console.tar.gz"
        ));
        assert!(script.contains("RELEASE_PAYLOAD=/opt/appliance/artifacts/control-plane-release.json"));
        assert!(script.contains("sha256sum \"$APISERVER_SRC\""));
        assert!(script.contains("signed control-plane seed digest/size mismatch; api-server start refused"));
        assert!(!script.contains(r"C:\Users\Avery"));
        assert!(!script.contains("wslpath"));
        assert!(!script.contains("/mnt/c"));

        let mut assets = assets;
        assets.console = None;
        let script = build_bootstrap(&s, None, None, Some(&assets), "tok3n", &[], None).unwrap();
        assert!(!script.contains("__CONSOLE_PROVISION__"));
        assert!(script.contains("CONSOLE_SRC="));
        assert!(script.contains("api-server start refused"));
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
                , Some("-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n"), None, "", &[], None).unwrap(),
            {
                let mut a = spec("sbx");
                a.agent_only = true;
                a.dev = true;
                build_bootstrap(&a, None, None, None, "", &[], None).unwrap()
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
