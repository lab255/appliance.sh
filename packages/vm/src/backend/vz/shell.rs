//! vsock shell relay: bridges a per-VM Unix socket to a fresh guest
//! vsock connection — the socat PTY agent the guest runs — so
//! `appliance-vm shell` gets an interactive shell with no SSH, no TCP
//! exposure, and no dependency on k3s being up. VZ-specific: it drives
//! the live VM's `VZVirtioSocketDevice` on the VM's dispatch queue.

use super::{error_text, QueueBound};
use crate::guest::{ARTIFACT_VSOCK_PORT, SHELL_VSOCK_PORT};
use crate::shell::clock_set_command;
use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchRetained};
use objc2::rc::Retained;
use objc2_foundation::NSError;
use objc2_virtualization::{VZVirtioSocketConnection, VZVirtioSocketDevice, VZVirtualMachine};
use std::io::Write;
use std::net::Shutdown;
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::io::Read;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Serve the per-VM Unix socket that bridges to guest vsock shells, for
/// the lifetime of the running VM. Detached; any failure is logged, not
/// fatal — the VM (and every other channel) keeps running.
pub fn spawn_relay(
    queue: &DispatchRetained<DispatchQueue>,
    vm: &Retained<VZVirtualMachine>,
    sock_path: PathBuf,
) {
    spawn_port_relay(queue, vm, sock_path, SHELL_VSOCK_PORT, "shell");
}

pub fn spawn_artifact_relay(
    queue: &DispatchRetained<DispatchQueue>,
    vm: &Retained<VZVirtualMachine>,
    sock_path: PathBuf,
) {
    spawn_port_relay(queue, vm, sock_path, ARTIFACT_VSOCK_PORT, "artifact");
}

fn spawn_port_relay(
    queue: &DispatchRetained<DispatchQueue>,
    vm: &Retained<VZVirtualMachine>,
    sock_path: PathBuf,
    port: u32,
    label: &'static str,
) {
    let queue = queue.clone();
    let vm = QueueBound(vm.clone());
    std::thread::spawn(move || {
        let _ = std::fs::remove_file(&sock_path);
        let listener = match UnixListener::bind(&sock_path) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("{label} relay: bind {}: {e}", sock_path.display());
                return;
            }
        };
        // Owner-only: this socket is a direct line to a root shell.
        let _ = std::fs::set_permissions(&sock_path, std::fs::Permissions::from_mode(0o600));
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            match connect_vsock(&queue, &vm, port) {
                Ok(fd) => spawn_session(stream, fd),
                Err(e) => {
                    let _ = (&stream).write_all(format!("appliance {label}: {e}\r\n").as_bytes());
                }
            }
        }
    });
}

/// Interval between periodic clock pushes while the host stays awake.
const CLOCK_RESYNC_INTERVAL: Duration = Duration::from_secs(30);
/// Granularity of the wake watcher: the resync wait sleeps in ticks
/// this short so a macOS wake is noticed within ~one tick instead of
/// the tail of a 30s sleep.
const CLOCK_WATCH_TICK: Duration = Duration::from_secs(2);
/// How much FURTHER than a tick the wall clock must have advanced to
/// call it a sleep/wake jump. Guest skew becomes fatal at the 15s
/// signature tolerance; 45s of slack keeps scheduler-induced oversleep
/// (which is seconds, not tens of seconds) from false-positives while
/// catching any nap long enough to matter.
const WAKE_JUMP_SLACK: Duration = Duration::from_secs(45);

/// Push the host's wall-clock time into the guest, at bring-up and
/// periodically, over the same vsock shell channel.
///
/// The guest verifies signed-request timestamps against its own clock,
/// which lags the host (no NTP under the cooperative-egress model). A
/// host clock ahead of the guest's makes host-signed requests look
/// future-dated → opaque 401s. This thread is the host-authoritative
/// fix: the first successful push corrects the boot offset; the periodic
/// re-push corrects drift; and a wall-clock jump detector inside the
/// wait catches macOS SLEEP/WAKE — the guest clock stops with the VM
/// while the wall clock runs on, so a wake leaves the guest minutes or
/// hours behind and every signed request 401ing until the next push.
/// The detector cuts that window to ~one watch tick, with zero new
/// ObjC notification plumbing. Detached and best-effort — any failure
/// is logged, never fatal, exactly like `spawn_relay`.
pub fn spawn_clock_sync(
    queue: &DispatchRetained<DispatchQueue>,
    vm: &Retained<VZVirtualMachine>,
) {
    let queue = queue.clone();
    let vm = QueueBound(vm.clone());
    std::thread::spawn(move || loop {
        let fd = match connect_vsock(&queue, &vm, SHELL_VSOCK_PORT) {
            Ok(fd) => fd,
            Err(_) => {
                // Guest shell agent not up yet (or transient): retry
                // soon so the first push lands as early as possible.
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
        };
        if let Err(e) = push_clock(fd) {
            eprintln!("clock sync: {e}");
            // Fall through to the wait: a failed push is rare and the
            // next iteration reconnects with a fresh time anyway.
        }
        // Wait out the resync interval in short ticks, watching for a
        // sleep/wake wall-clock jump — on one, loop immediately so the
        // push above lands right after the wake.
        if wait_watching_for_wake(CLOCK_RESYNC_INTERVAL, CLOCK_WATCH_TICK) {
            eprintln!("clock sync: post-wake clock push");
        }
    });
}

/// Sleep for `total`, in `tick`-sized slices, returning early with
/// `true` when a wall-clock jump says the host slept and woke. `false`
/// after an ordinary, fully-awake wait.
fn wait_watching_for_wake(total: Duration, tick: Duration) -> bool {
    // Instant on macOS is CLOCK_UPTIME_RAW: it does NOT advance while
    // the machine sleeps, so it bounds the AWAKE time waited even when
    // ticks straddle a nap.
    let deadline = std::time::Instant::now() + total;
    loop {
        let wall_before = SystemTime::now();
        std::thread::sleep(tick);
        let wall_elapsed = SystemTime::now()
            .duration_since(wall_before)
            .unwrap_or(tick);
        if is_post_wake_jump(tick, wall_elapsed) {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
    }
}

/// Pure jump decision: a single `tick`-long sleep whose wall clock
/// advanced more than `tick + WAKE_JUMP_SLACK` means the host slept
/// through it — time to re-push the guest clock immediately.
fn is_post_wake_jump(tick: Duration, wall_elapsed: Duration) -> bool {
    wall_elapsed > tick + WAKE_JUMP_SLACK
}

/// The size-line handshake clock-sync sends before its `date -s` command.
/// The trailing `root` token keeps the guest shell as **root**: setting
/// the system clock needs root, and dropping to the non-root appliance
/// user would make the push fail silently (the command ends `|| true`)
/// and resurrect the clock-skew 401 bug. The root path also works before
/// the appliance user is fully provisioned, so the first push lands as
/// early as possible. (docs/rootless-guest.md §2.2.)
const CLOCK_SYNC_SIZE_LINE: &str = "rows 24 cols 80 root\n";

/// Send the clock-set command over a connected shell vsock fd, then drain
/// to EOF so the command actually runs before the connection closes.
/// Takes ownership of `fd` and closes it on return.
fn push_clock(fd: RawFd) -> Result<(), String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "host clock is before the Unix epoch".to_string())?
        .as_secs();
    let cmd = clock_set_command(now);

    let mut sock = unsafe { std::fs::File::from_raw_fd(fd) };
    // The agent reads ONE leading `rows R cols C` line as the PTY size,
    // then exec's a login shell running whatever follows on stdin.
    sock.write_all(CLOCK_SYNC_SIZE_LINE.as_bytes())
        .map_err(|e| format!("write size: {e}"))?;
    sock.write_all(cmd.as_bytes())
        .map_err(|e| format!("write command: {e}"))?;
    sock.write_all(b"\nexit\n")
        .map_err(|e| format!("write exit: {e}"))?;
    // Half-close our write side so the guest shell sees EOF on stdin and
    // exits, then drain its output to EOF — i.e. wait for the command to
    // have run before we drop the fd.
    unsafe { libc::shutdown(sock.as_raw_fd(), libc::SHUT_WR) };
    let mut sink = Vec::new();
    sock.read_to_end(&mut sink)
        .map_err(|e| format!("drain: {e}"))?;
    Ok(())
}

/// Open a fresh vsock connection to the guest shell port and hand back a
/// dup'd, independently-owned fd. The connect rides the VM's dispatch
/// queue (Virtualization.framework requires it); the completion fires
/// asynchronously, so we block on a channel for it.
fn connect_vsock(
    queue: &DispatchRetained<DispatchQueue>,
    vm: &QueueBound<Retained<VZVirtualMachine>>,
    port: u32,
) -> Result<RawFd, String> {
    let (tx, rx) = mpsc::channel::<Result<RawFd, String>>();
    let vm = QueueBound(vm.0.clone());
    queue.exec_sync(move || {
        let vm = vm;
        let Some(device) = (unsafe { vm.0.socketDevices() }).firstObject() else {
            let _ = tx.send(Err("VM has no vsock device".into()));
            return;
        };
        let device = match device.downcast::<VZVirtioSocketDevice>() {
            Ok(d) => d,
            Err(_) => {
                let _ = tx.send(Err("vsock device is not virtio".into()));
                return;
            }
        };
        let tx = tx.clone();
        let handler = RcBlock::new(
            move |conn: *mut VZVirtioSocketConnection, err: *mut NSError| {
                if !err.is_null() {
                    let _ = tx.send(Err(error_text(unsafe { &*err })));
                    return;
                }
                if conn.is_null() {
                    let _ = tx.send(Err("guest is not listening on the shell port".into()));
                    return;
                }
                // dup so the fd outlives the framework releasing the
                // VZVirtioSocketConnection once this handler returns.
                let dup = unsafe { libc::dup((*conn).fileDescriptor()) };
                let _ = tx.send(if dup < 0 {
                    Err("dup vsock fd failed".into())
                } else {
                    Ok(dup)
                });
            },
        );
        unsafe { device.connectToPort_completionHandler(port, &handler) };
    });
    rx.recv_timeout(Duration::from_secs(10))
        .map_err(|_| "vsock connect timed out (is the guest shell agent up?)".to_string())?
}

/// Pump bytes both ways between the client's Unix socket and the guest
/// vsock fd until either side closes, on two detached threads. EOF in
/// each direction is forwarded as a half-close so the peer's shell sees
/// it and exits cleanly.
fn spawn_session(stream: UnixStream, vsock_fd: RawFd) {
    let vsock_out = unsafe { std::fs::File::from_raw_fd(vsock_fd) };
    let (Ok(vsock_in), Ok(stream_in)) = (vsock_out.try_clone(), stream.try_clone()) else {
        return;
    };
    // client -> guest
    std::thread::spawn(move || {
        let mut r = stream_in;
        let mut w = vsock_out;
        let _ = std::io::copy(&mut r, &mut w);
        unsafe { libc::shutdown(w.as_raw_fd(), libc::SHUT_WR) };
    });
    // guest -> client
    std::thread::spawn(move || {
        let mut r = vsock_in;
        let mut w = stream;
        let _ = std::io::copy(&mut r, &mut w);
        let _ = w.shutdown(Shutdown::Write);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wake_jump_detection_has_slack_for_oversleep_but_catches_naps() {
        let tick = Duration::from_secs(2);
        // An exact tick, scheduler jitter, even seconds of oversleep:
        // not a wake — re-pushing on every hiccup would be noise.
        assert!(!is_post_wake_jump(tick, Duration::from_secs(2)));
        assert!(!is_post_wake_jump(tick, Duration::from_secs(5)));
        assert!(!is_post_wake_jump(tick, Duration::from_secs(47))); // exactly tick+slack: boundary stays quiet
        // Beyond tick + 45s of slack the host demonstrably slept: the
        // guest clock is now behind by about that much and every signed
        // request would 401 until a push.
        assert!(is_post_wake_jump(tick, Duration::from_secs(48)));
        assert!(is_post_wake_jump(tick, Duration::from_secs(3600)));
    }

    #[test]
    fn wake_watcher_ticks_are_much_finer_than_the_resync_interval() {
        // The detector's whole point is cutting the post-wake 401
        // window from "the tail of a 30s sleep" to ~one tick.
        assert!(CLOCK_WATCH_TICK < CLOCK_RESYNC_INTERVAL / 10);
        // And the slack must exceed the signature tolerance (15s) so a
        // detected jump is always one that actually mattered.
        assert!(WAKE_JUMP_SLACK >= Duration::from_secs(15));
    }

    #[test]
    fn clock_sync_runs_as_root() {
        // The handshake must carry the `root` token so `date -s` runs as
        // root after the shell agent's default drop to the appliance user
        // — otherwise the push fails silently and the clock-skew 401 bug
        // returns. It must still be a well-formed `rows R cols C …` line.
        assert!(CLOCK_SYNC_SIZE_LINE.starts_with("rows 24 cols 80"));
        assert!(CLOCK_SYNC_SIZE_LINE.trim_end().ends_with(" root"));
        assert!(CLOCK_SYNC_SIZE_LINE.ends_with('\n'));
    }
}
