use crate::spec::VmSpec;
use anyhow::Result;

pub mod runtime_guest;
#[cfg(any(windows, test))]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(target_os = "linux")]
pub mod kvm;
#[cfg(target_os = "macos")]
pub mod vz;
#[cfg(target_os = "windows")]
pub mod wsl;
#[cfg(target_os = "windows")]
pub(crate) use wsl::WSL_CONF;

/// Platform-neutral gate for the WSL clock-sync worker, kept here so the
/// no-revival invariant is tested on every host.
#[cfg(any(windows, test))]
pub(super) fn clock_sync_should_tick(stop: &AtomicBool) -> bool {
    !stop.load(Ordering::Acquire)
}

/// Wait until the foreground owner exits, bounded by the caller's deadline.
/// The injected seams keep the WSL destroy ordering testable on every host.
#[cfg(any(windows, test))]
pub(super) fn wait_for_foreground_exit<D, P>(mut deadline_reached: D, mut foreground_live: P)
where
    D: FnMut() -> bool,
    P: FnMut() -> bool,
{
    while foreground_live() {
        if deadline_reached() {
            break;
        }
    }
}

/// The seam between everything platform-neutral (CLI, state store,
/// image cache, guest provisioning) and the hypervisor underneath.
/// One implementation per platform:
///
///   macOS   → Virtualization.framework, in-process (vz)
///   Linux   → KVM (kvm — scaffold, reports unavailable)
///   Windows → WSL2-managed distro (wsl — scaffold, reports unavailable)
///
/// A backend's whole job is "boot this kernel with these devices and
/// keep it running until asked to stop". `run_foreground` hosts the VM
/// in the *current* process and blocks until shutdown; the detached
/// `start` flow (spawn self with `run`) lives above the trait so every
/// backend gets identical daemon semantics for free.
pub trait VmBackend {
    fn name(&self) -> &'static str;

    /// Err with an actionable message when the backend can't work on
    /// this machine (missing hypervisor, no entitlement, no /dev/kvm).
    fn availability(&self) -> Result<()>;

    /// Host the VM in this process; return once the guest has stopped.
    /// Implementations install their own SIGTERM handling so `stop`
    /// (signal to the pidfile's process) triggers a graceful shutdown —
    /// on Windows (no SIGTERM) the stop channel is the per-VM
    /// `stop.request` file the parking loop polls.
    fn run_foreground(&self, spec: &VmSpec) -> Result<()>;

    /// Tear down backend-owned state when a VM is deleted, beyond the
    /// VM dir the store removes. Default: nothing (vz/kvm keep all
    /// their state in the VM dir). The WSL2 backend unregisters the
    /// imported distro, which deletes its VHDX.
    fn destroy(&self, _name: &str) -> Result<()> {
        Ok(())
    }
}

/// Stable backend name for platform-neutral policy resolution.
pub const fn platform_backend_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "vz"
    } else if cfg!(target_os = "windows") {
        "wsl"
    } else {
        "kvm"
    }
}

/// The platform's backend.
pub fn platform_backend() -> Box<dyn VmBackend> {
    #[cfg(target_os = "macos")]
    {
        Box::new(vz::VzBackend)
    }
    #[cfg(target_os = "linux")]
    {
        Box::new(kvm::KvmBackend)
    }
    #[cfg(target_os = "windows")]
    {
        Box::new(wsl::WslBackend)
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clock_sync_never_invokes_after_stop_is_set() {
        let stop = AtomicBool::new(false);
        let mut invocations = 0;
        if clock_sync_should_tick(&stop) {
            invocations += 1;
        }
        stop.store(true, Ordering::Release);
        if clock_sync_should_tick(&stop) {
            invocations += 1;
        }
        assert_eq!(invocations, 1);
    }

    #[test]
    fn foreground_exit_wait_is_bounded_by_deadline() {
        let mut deadline_probes = 0;
        let mut live_probes = 0;
        wait_for_foreground_exit(
            || {
                deadline_probes += 1;
                deadline_probes == 2
            },
            || {
                live_probes += 1;
                true
            },
        );
        assert_eq!(deadline_probes, 2);
        assert_eq!(live_probes, 2);
    }

    #[test]
    fn foreground_exit_wait_stops_when_pidfile_clears_early() {
        let mut deadline_probes = 0;
        let mut live_probes = 0;
        wait_for_foreground_exit(
            || {
                deadline_probes += 1;
                false
            },
            || {
                live_probes += 1;
                live_probes < 2
            },
        );
        assert_eq!(deadline_probes, 1);
        assert_eq!(live_probes, 2);
    }
}
