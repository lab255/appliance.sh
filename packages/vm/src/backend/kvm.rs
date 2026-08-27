use super::VmBackend;
use crate::spec::VmSpec;
use anyhow::{bail, Result};

/// Linux KVM backend — scaffold. Target shape is an embedded
/// rust-vmm based VMM (virtio-mmio devices matching the guest
/// contract: console, net, blk, vsock) speaking directly to /dev/kvm.
/// Until that lands the backend reports itself unavailable, so the
/// CLI surface is already stable on Linux.
pub struct KvmBackend;

impl VmBackend for KvmBackend {
    fn name(&self) -> &'static str {
        "kvm"
    }

    fn availability(&self) -> Result<()> {
        if !std::path::Path::new("/dev/kvm").exists() {
            bail!("/dev/kvm not present — KVM is unavailable on this machine");
        }
        bail!("the KVM backend is not implemented yet — the microVM runtime (`appliance vm`) does not yet support Linux hosts");
    }

    fn run_foreground(&self, spec: &VmSpec) -> Result<()> {
        if !spec.runtime_shares.is_empty() {
            // TODO(AP-163/kvm-virtiofsd): launch one sandboxed virtiofsd
            // per RuntimeShare and attach its vhost-user socket. The KVM
            // VMM itself remains scaffold-only, so fail closed instead of
            // silently booting without a declared payload share.
            bail!("KVM runtime shares require the pending virtiofsd backend integration");
        }
        self.availability()
    }
}
