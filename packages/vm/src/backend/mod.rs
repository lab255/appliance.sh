use crate::spec::VmSpec;
use anyhow::Result;

pub mod runtime_guest;

#[cfg(target_os = "linux")]
pub mod kvm;
#[cfg(target_os = "macos")]
pub mod vz;
#[cfg(target_os = "windows")]
pub mod wsl;

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
