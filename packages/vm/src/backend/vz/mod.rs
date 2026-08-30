//! macOS backend: Virtualization.framework driven in-process via
//! objc2 bindings — the same foundation Docker Desktop / OrbStack
//! build on, without an external VM manager binary.
//!
//! Threading model: VZVirtualMachine demands that every operation
//! happen on the serial dispatch queue it was created with. We create
//! one queue per hosted VM, hop onto it with `exec_sync` for each
//! operation, and treat completion-handler blocks as channel sends
//! back to the hosting thread. `Retained<VZVirtualMachine>` is !Send
//! (correctly — it's queue-affine), so the small `QueueBound` wrapper
//! asserts the only kind of cross-thread movement we do: moving the
//! reference *onto its own queue*.
//!
//! Requires the `com.apple.security.virtualization` entitlement —
//! `scripts/sign-dev.sh` applies it ad-hoc for local builds.

mod shell;
mod runtime;

use super::VmBackend;
use crate::netstack::Netstack;
use crate::spec::{NetLink, VmPaths, VmSpec};
use anyhow::{anyhow, bail, Result};
use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchRetained};
use objc2::rc::Retained;
use objc2::AnyThread;
use objc2_foundation::{NSArray, NSError, NSFileHandle, NSInteger, NSString, NSURL};
use objc2_virtualization::{
    VZDirectorySharingDeviceConfiguration, VZDiskImageStorageDeviceAttachment,
    VZFileHandleNetworkDeviceAttachment, VZFileSerialPortAttachment, VZLinuxBootLoader, VZMACAddress,
    VZNATNetworkDeviceAttachment, VZNetworkDeviceConfiguration, VZSharedDirectory,
    VZSerialPortConfiguration, VZSingleDirectoryShare, VZSocketDeviceConfiguration,
    VZStorageDeviceConfiguration, VZVirtioBlockDeviceConfiguration,
    VZVirtioConsoleDeviceSerialPortConfiguration, VZVirtioEntropyDeviceConfiguration,
    VZVirtioFileSystemDeviceConfiguration, VZVirtioNetworkDeviceConfiguration,
    VZVirtioSocketDeviceConfiguration, VZVirtualMachine, VZVirtualMachineConfiguration,
    VZVirtualMachineState,
};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub struct VzBackend;

static STOP_REQUESTED: AtomicBool = AtomicBool::new(false);

extern "C" fn on_terminate(_sig: libc::c_int) {
    STOP_REQUESTED.store(true, Ordering::SeqCst);
}

/// Move a !Send objc reference across threads. Sound only because the
/// sole consumer is a closure executing on the VM's own dispatch
/// queue — the exact place Virtualization.framework requires the
/// reference to be used.
struct QueueBound<T>(T);
unsafe impl<T> Send for QueueBound<T> {}

impl VmBackend for VzBackend {
    fn name(&self) -> &'static str {
        "vz"
    }

    fn availability(&self) -> Result<()> {
        let supported = unsafe { VZVirtualMachine::isSupported() };
        if !supported {
            bail!("Virtualization.framework reports virtualization unsupported on this machine");
        }
        Ok(())
    }

    fn run_foreground(&self, spec: &VmSpec) -> Result<()> {
        self.availability()?;
        let paths = VmPaths::for_name(&spec.name);
        // First observable stage: any boot-media download happens here.
        // Clear any phase left by a previous boot before publishing ours.
        crate::bringup::clear(&paths.dir);
        crate::bringup::set(&paths.dir, crate::bringup::Phase::Media, None);
        let image = crate::images::ensure_image(&spec.image)?;
        crate::bringup::hostlog("assembling boot media");
        let pinned_release_key_id = crate::guest::pinned_release_key_id_from_env()?;
        let boot_media = crate::guest::build_boot_media(
            &paths.dir,
            spec.registry_port,
            spec.dev,
            spec.dev_mount.as_deref(),
            spec.docker,
            spec.egress_port,
            spec.agent_only,
            spec.cluster,
            spec.host_port,
            &pinned_release_key_id,
        )?;

        // The prebuilt agent image (Node ≥22 + the pinned CLIs) attaches as a
        // read-only 3rd virtio-blk, but ONLY for agent-only VMs. Fetch +
        // verify it here (still the Media phase). Best-effort by contract:
        // a missing-or-unverifiable image is skipped and the guest self-heals
        // the CLIs via npm — but `ensure_agent_image` only returns a path it
        // has hash-verified, so a tampered artifact is never attached
        // (Quinn #3, defence in depth with the attach-time re-verify below).
        let agent_image: Option<std::path::PathBuf> = if spec.agent_only && !spec.runtime {
            match crate::images::ensure_agent_image() {
                Ok(p) => Some(p),
                Err(e) => {
                    crate::bringup::hostlog(&format!(
                        "agent image unavailable ({e:#}); the guest will self-heal the CLIs via npm"
                    ));
                    None
                }
            }
        } else {
            None
        };

        // k3s VMs: the pinned airgap-images tarball (hash-verified, FAT-
        // wrapped) rides as another read-only virtio-blk so first boot
        // imports its core images locally instead of pulling ~300 MB from
        // docker.io. Best-effort by contract: any failure here falls back
        // to today's network pulls — bring-up must never get WORSE. The
        // guest finds the media by volume label, never a device node.
        //
        // The first-run download is BIG and used to be invisible-and-
        // unbounded inside the Media phase: say what is happening (host
        // log + phase detail, so `up`/desktop show it), and bound the
        // synchronous wait to half the remaining bring-up budget — a slow
        // link degrades to the network-pull fallback while the download
        // keeps priming the shared cache in the background for the next
        // boot (its .partial→rename staging is already crash-atomic).
        // Cache-warm boots take the fast path through the same bound.
        let platform_images: Option<std::path::PathBuf> = if spec.agent_only || !spec.cluster {
            None
        } else {
            if !crate::images::k3s_airgap_images_cached() {
                crate::bringup::hostlog("downloading k3s platform images (~300 MB, first run only)");
                crate::bringup::set(
                    &paths.dir,
                    crate::bringup::Phase::Media,
                    Some("downloading k3s platform images (first run only)".into()),
                );
            }
            let bound = std::cmp::max(
                std::time::Duration::from_secs(60),
                crate::bringup::remaining_budget() / 2,
            );
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _ = tx.send(crate::guest::ensure_k3s_airgap_media());
            });
            match rx.recv_timeout(bound) {
                Ok(Ok(p)) => Some(p),
                Ok(Err(e)) => {
                    crate::bringup::hostlog(&format!(
                        "k3s airgap images unavailable ({e:#}); first boot pulls from the network"
                    ));
                    None
                }
                Err(_) => {
                    crate::bringup::hostlog(&format!(
                        "k3s platform images still downloading after {}s — booting without the preload (network pulls); the download continues for the next boot",
                        bound.as_secs()
                    ));
                    None
                }
            }
        };

        // The console log is the VM's primary observable output —
        // truncate per boot so `console` shows the current boot, not
        // an append-forever scroll of every boot since creation.
        std::fs::write(paths.console_log(), b"")?;
        let _ = std::fs::remove_file(paths.kubeconfig());
        // Quinn gap #4c: clear a prior boot's agent-ready marker too, so an
        // agent-only `up` never returns on a stale readiness file.
        let _ = std::fs::remove_file(paths.agent_ready());
        let _ = std::fs::remove_file(paths.core_ready());
        let _ = std::fs::remove_file(paths.guest_ip());

        let built = build_configuration(
            spec,
            &image.kernel,
            &image.initramfs,
            &boot_media.image,
            agent_image.as_deref(),
            platform_images.as_deref(),
            &paths,
        )?;
        let config = built.config;
        unsafe { config.validateWithError() }
            .map_err(|e| anyhow!("invalid VM configuration: {}", error_text(&e)))?;

        // On the host-mediated link, stand up this VM's smoltcp netstack
        // on the socketpair's host end *before* the VM starts emitting
        // frames (the guest DHCPs in initramfs). The netstack leases the
        // guest its deterministic address and owns its only path off-box.
        // Behaviour-neutral in F1: every flow is forwarded, no filtering.
        let netstack: Option<Netstack> = built.host_fd.map(|fd| {
            crate::bringup::hostlog("network: host-mediated smoltcp netstack (net_link=netstack)");
            crate::netstack::start(
                fd,
                crate::netstack::LinkConfig::for_guest_mac(&spec.name, &spec.mac),
            )
        });
        if spec.runtime {
            let runtime_netstack = netstack
                .clone()
                .ok_or_else(|| anyhow!("Runtime profile requires the host netstack"))?;
            runtime::spawn_forward_control(
                spec.name.clone(),
                runtime_netstack,
                paths.runtime_forward_sock(),
            )?;
        }

        let queue = DispatchQueue::new(&format!("sh.appliance.vm.{}", spec.name), None);
        let vm = unsafe {
            VZVirtualMachine::initWithConfiguration_queue(VZVirtualMachine::alloc(), &config, &queue)
        };

        unsafe {
            libc::signal(libc::SIGTERM, on_terminate as *const () as usize);
            libc::signal(libc::SIGINT, on_terminate as *const () as usize);
        }

        start_vm(&queue, &vm)?;
        crate::bringup::hostlog(&format!("VM '{}' started", spec.name));
        // Guest is launching; host_services drives the rest of the phases.
        crate::bringup::set(&paths.dir, crate::bringup::Phase::Booting, None);

        // Serve the per-VM shell socket: each `appliance-vm shell`
        // connection bridges to a fresh guest vsock PTY. Best-effort and
        // independent of k3s.
        shell::spawn_relay(&queue, &vm, paths.shell_sock());
        shell::spawn_artifact_relay(&queue, &vm, paths.artifact_sock());

        // Push host wall-clock time into the guest at bring-up and
        // periodically. The guest clock lags the host (no NTP), and the
        // api-server verifies signed-request timestamps against the guest
        // clock — without this, host-signed requests look future-dated
        // and get rejected with an opaque 401.
        shell::spawn_clock_sync(&queue, &vm);

        // Guest-facing host services (IP discovery, port forwards,
        // kubeconfig handoff) run on a side thread so the parking loop
        // below stays the single owner of lifecycle decisions.
        {
            let spec = spec.clone();
            let paths_dir = paths.dir.clone();
            let netstack = netstack.clone();
            // What THIS boot's media carries decides the readiness gate —
            // captured at media build, never re-probed at readiness time.
            let apiserver_staged = boot_media.apiserver_staged;
            std::thread::spawn(move || {
                if let Err(err) =
                    crate::guest::host_services(&spec, &paths_dir, netstack.as_ref(), apiserver_staged)
                {
                    crate::bringup::hostlog(&format!("host services: {err:#}"));
                    // Record the failure so `up` can stop waiting and
                    // report what broke instead of timing out blind.
                    crate::bringup::set(
                        &paths_dir,
                        crate::bringup::Phase::Failed,
                        Some(format!("{err:#}")),
                    );
                }
            });
        }

        // Park until either the guest powers off on its own or a stop
        // is requested (SIGTERM from `appliance-vm stop`, or ^C).
        loop {
            std::thread::sleep(Duration::from_millis(200));
            let state = vm_state(&queue, &vm);
            if matches!(
                state,
                VZVirtualMachineState::Stopped | VZVirtualMachineState::Error
            ) {
                eprintln!("VM '{}' stopped (guest)", spec.name);
                return Ok(());
            }
            if STOP_REQUESTED.load(Ordering::SeqCst) {
                eprintln!("stop requested — shutting down VM '{}'", spec.name);
                return stop_vm(&queue, &vm);
            }
        }
    }
}

/// The outcome of building a VM configuration: the config plus, when the
/// guest runs on the host-mediated link (`net_link = Netstack`), the
/// host end of the socketpair the netstack must own. `None` host fd means
/// the framework NAT path (the host owns no link).
struct BuiltConfig {
    config: Retained<VZVirtualMachineConfiguration>,
    host_fd: Option<std::os::fd::RawFd>,
}

#[allow(clippy::too_many_arguments)]
fn build_configuration(
    spec: &VmSpec,
    kernel: &Path,
    initramfs: &Path,
    boot_media: &Path,
    // The verified prebuilt agent image to attach read-only as `vdc`
    // (agent-only VMs only). `None` ⇒ no third disk.
    agent_image: Option<&Path>,
    // The FAT-wrapped k3s airgap-images media, attached read-only on k3s
    // VMs (mutually exclusive with `agent_image` — the caller gates each
    // on `spec.agent_only`). The guest probes it by volume label.
    platform_images: Option<&Path>,
    paths: &VmPaths,
) -> Result<BuiltConfig> {
    // The host end of the netstack link, set only on the Netstack path.
    let mut host_fd: Option<std::os::fd::RawFd> = None;
    unsafe {
        let boot_loader =
            VZLinuxBootLoader::initWithKernelURL(VZLinuxBootLoader::alloc(), &file_url(kernel));
        boot_loader.setInitialRamdiskURL(Some(&file_url(initramfs)));
        boot_loader.setCommandLine(&NSString::from_str(&spec.cmdline));

        // Console: virtio console (hvc0) → file. Reading guest output
        // back is a follow-up (vsock agent); the boot log alone is the
        // debugging surface for a headless VM.
        let serial = VZVirtioConsoleDeviceSerialPortConfiguration::new();
        let attachment = VZFileSerialPortAttachment::initWithURL_append_error(
            VZFileSerialPortAttachment::alloc(),
            &file_url(&paths.console_log()),
            true,
        )
        .map_err(|e| anyhow!("console attachment: {}", error_text(&e)))?;
        serial.setAttachment(Some(&attachment));

        // Network: exactly ONE virtio-net device (the §8.1 #5 one-NIC
        // invariant). Its attachment is either framework NAT (default) or
        // the host-mediated socketpair link the smoltcp netstack owns.
        let net = VZVirtioNetworkDeviceConfiguration::new();
        match spec.net_link() {
            NetLink::Nat => {
                // NAT through the host. DHCP inside the guest gets a
                // 192.168.64.0/24-style lease from the framework's own server.
                let nat = VZNATNetworkDeviceAttachment::new();
                net.setAttachment(Some(&nat));
            }
            NetLink::Netstack => {
                // Swap NAT → VZFileHandleNetworkDeviceAttachment over a
                // socketpair(AF_UNIX, SOCK_DGRAM). The host end is the
                // guest's ONLY path off-box; the framework owns the guest
                // end (closeOnDealloc) and delivers one datagram per frame.
                let (host, vz) = crate::netstack::make_link()
                    .map_err(|e| anyhow!("netstack link socketpair: {e}"))?;
                let nsfh =
                    NSFileHandle::initWithFileDescriptor_closeOnDealloc(NSFileHandle::alloc(), vz, true);
                let attach = VZFileHandleNetworkDeviceAttachment::initWithFileHandle(
                    VZFileHandleNetworkDeviceAttachment::alloc(),
                    &nsfh,
                );
                attach.setMaximumTransmissionUnit(crate::netstack::LINK_MTU as NSInteger);
                net.setAttachment(Some(&attach));
                host_fd = Some(host);
            }
        }
        // Fixed MAC: the netstack leases this MAC its deterministic
        // address (NAT path: macOS finds it in the DHCP lease table).
        let mac = VZMACAddress::initWithString(VZMACAddress::alloc(), &NSString::from_str(&spec.mac))
            .ok_or_else(|| anyhow!("invalid MAC address in spec: {}", spec.mac))?;
        net.setMACAddress(&mac);

        // Storage: the persistent data disk (sparse raw image).
        let disk_attachment = VZDiskImageStorageDeviceAttachment::initWithURL_readOnly_error(
            VZDiskImageStorageDeviceAttachment::alloc(),
            &file_url(&paths.disk()),
            false,
        )
        .map_err(|e| anyhow!("disk attachment: {}", error_text(&e)))?;
        let block_device = VZVirtioBlockDeviceConfiguration::initWithAttachment(
            VZVirtioBlockDeviceConfiguration::alloc(),
            &disk_attachment,
        );

        // Fixed second disk (vdb): root-only control-plane state, never a
        // VirtioFS workload share and never part of the appliance-user disk.
        let control_plane_attachment = VZDiskImageStorageDeviceAttachment::initWithURL_readOnly_error(
            VZDiskImageStorageDeviceAttachment::alloc(),
            &file_url(&paths.control_plane_disk()),
            false,
        )
        .map_err(|e| anyhow!("control-plane disk attachment: {}", error_text(&e)))?;
        let control_plane_device = VZVirtioBlockDeviceConfiguration::initWithAttachment(
            VZVirtioBlockDeviceConfiguration::alloc(),
            &control_plane_attachment,
        );

        // Boot media (FAT volume with modloop + apkovl + k3s) as the
        // third disk (vdc). Read-only: it's regenerated host-side.
        let media_attachment = VZDiskImageStorageDeviceAttachment::initWithURL_readOnly_error(
            VZDiskImageStorageDeviceAttachment::alloc(),
            &file_url(boot_media),
            true,
        )
        .map_err(|e| anyhow!("boot media attachment: {}", error_text(&e)))?;
        let media_device = VZVirtioBlockDeviceConfiguration::initWithAttachment(
            VZVirtioBlockDeviceConfiguration::alloc(),
            &media_attachment,
        );

        // Storage devices in vda, vdb, vdc[, ...] order: data disk,
        // control-plane disk, boot media,
        // and — only when an agent-only VM has a verified image — the
        // prebuilt agent squashfs (vdc), read-only like the boot media.
        let mut storage: Vec<Retained<VZStorageDeviceConfiguration>> = vec![
            Retained::into_super(block_device),
            Retained::into_super(control_plane_device),
            Retained::into_super(media_device),
        ];
        if let Some(agent_path) = agent_image {
            // Quinn gap #3 — verify-AT-ATTACH-TIME: re-check the on-disk bytes
            // against the committed sha256 immediately before attaching, every
            // boot (cache-hit included), so a tampered/stale cached squashfs
            // can never reach the guest even if the fetch path was skipped.
            crate::images::verify_agent_image(agent_path)
                .map_err(|e| anyhow!("agent image failed verify before attach: {e:#}"))?;
            let agent_attachment = VZDiskImageStorageDeviceAttachment::initWithURL_readOnly_error(
                VZDiskImageStorageDeviceAttachment::alloc(),
                &file_url(agent_path),
                true,
            )
            .map_err(|e| anyhow!("agent image attachment: {}", error_text(&e)))?;
            let agent_device = VZVirtioBlockDeviceConfiguration::initWithAttachment(
                VZVirtioBlockDeviceConfiguration::alloc(),
                &agent_attachment,
            );
            storage.push(Retained::into_super(agent_device));
        }
        if let Some(images_path) = platform_images {
            // Read-only like the boot media: regenerated host-side from
            // the hash-verified tarball (`ensure_k3s_airgap_media` re-
            // verified the source bytes this same boot), never written
            // by the guest.
            let images_attachment = VZDiskImageStorageDeviceAttachment::initWithURL_readOnly_error(
                VZDiskImageStorageDeviceAttachment::alloc(),
                &file_url(images_path),
                true,
            )
            .map_err(|e| anyhow!("platform images attachment: {}", error_text(&e)))?;
            let images_device = VZVirtioBlockDeviceConfiguration::initWithAttachment(
                VZVirtioBlockDeviceConfiguration::alloc(),
                &images_attachment,
            );
            storage.push(Retained::into_super(images_device));
        }

        let entropy = VZVirtioEntropyDeviceConfiguration::new();

        // virtio-vsock: the host↔guest control channel the shell agent
        // rides (no SSH, no TCP exposure). The resident process opens
        // connections to it on demand via `shell::spawn_relay`.
        let vsock = VZVirtioSocketDeviceConfiguration::new();

        let config = VZVirtualMachineConfiguration::new();
        config.setBootLoader(Some(&boot_loader));
        config.setCPUCount(spec.cpus);
        config.setMemorySize(spec.memory_mib * 1024 * 1024);
        config.setSerialPorts(&NSArray::from_retained_slice(&[Retained::into_super(
            serial,
        )
            as Retained<VZSerialPortConfiguration>]));
        // EXACTLY ONE network device — a single-element array, NAT or
        // netstack but never both, no residual second NIC (§8.1 #5): one
        // provable path off-box.
        config.setNetworkDevices(&NSArray::from_retained_slice(&[Retained::into_super(net)
            as Retained<VZNetworkDeviceConfiguration>]));
        config.setStorageDevices(&NSArray::from_retained_slice(&storage));
        config.setEntropyDevices(&NSArray::from_retained_slice(&[Retained::into_super(
            entropy,
        )]));
        config.setSocketDevices(&NSArray::from_retained_slice(&[Retained::into_super(vsock)
            as Retained<VZSocketDeviceConfiguration>]));

        let mut directory_devices: Vec<Retained<VZDirectorySharingDeviceConfiguration>> = Vec::new();
        // Optional development workspace share.
        if let Some(mount) = spec.dev_mount.as_deref() {
            let shared = VZSharedDirectory::initWithURL_readOnly(
                VZSharedDirectory::alloc(),
                &file_url(Path::new(mount)),
                false,
            );
            let share =
                VZSingleDirectoryShare::initWithDirectory(VZSingleDirectoryShare::alloc(), &shared);
            let tag = NSString::from_str(crate::guest::WORKSPACE_VIRTIOFS_TAG);
            // The tag is a fixed short literal; validating it only guards
            // a future rename against the framework's <36-byte rule.
            VZVirtioFileSystemDeviceConfiguration::validateTag_error(&tag)
                .map_err(|e| anyhow!("invalid virtiofs tag: {}", error_text(&e)))?;
            let fs_device = VZVirtioFileSystemDeviceConfiguration::initWithTag(
                VZVirtioFileSystemDeviceConfiguration::alloc(),
                &tag,
            );
            fs_device.setShare(Some(&share));
            directory_devices.push(
                Retained::into_super(fs_device) as Retained<VZDirectorySharingDeviceConfiguration>
            );
        }
        // Runtime payload shares are separate boot-configured devices,
        // each hash-tagged below VZ's 36-byte maximum. They are exported
        // read-only and mounted only by the guest supervisor.
        for runtime_mount in &spec.runtime_mounts {
            let shared = VZSharedDirectory::initWithURL_readOnly(
                VZSharedDirectory::alloc(),
                &file_url(Path::new(&runtime_mount.host)),
                !runtime_mount.writable,
            );
            let share =
                VZSingleDirectoryShare::initWithDirectory(VZSingleDirectoryShare::alloc(), &shared);
            let tag = NSString::from_str(&runtime_mount.tag);
            VZVirtioFileSystemDeviceConfiguration::validateTag_error(&tag)
                .map_err(|e| anyhow!("invalid runtime virtiofs tag '{}': {}", runtime_mount.tag, error_text(&e)))?;
            let fs_device = VZVirtioFileSystemDeviceConfiguration::initWithTag(
                VZVirtioFileSystemDeviceConfiguration::alloc(),
                &tag,
            );
            fs_device.setShare(Some(&share));
            directory_devices.push(
                Retained::into_super(fs_device) as Retained<VZDirectorySharingDeviceConfiguration>
            );
        }
        if !directory_devices.is_empty() {
            config.setDirectorySharingDevices(&NSArray::from_retained_slice(&directory_devices));
        }

        Ok(BuiltConfig { config, host_fd })
    }
}

fn start_vm(queue: &DispatchRetained<DispatchQueue>, vm: &Retained<VZVirtualMachine>) -> Result<()> {
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let bound = QueueBound(vm.clone());
    queue.exec_sync(move || {
        let vm = bound;
        let tx_done = tx.clone();
        let handler = RcBlock::new(move |err: *mut NSError| {
            let outcome = if err.is_null() {
                Ok(())
            } else {
                Err(error_text(unsafe { &*err }))
            };
            let _ = tx_done.send(outcome);
        });
        unsafe { vm.0.startWithCompletionHandler(&handler) };
    });
    match rx.recv_timeout(Duration::from_secs(60)) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(message)) => bail!("VM start failed: {message}"),
        Err(_) => bail!("VM start timed out after 60s"),
    }
}

fn vm_state(
    queue: &DispatchRetained<DispatchQueue>,
    vm: &Retained<VZVirtualMachine>,
) -> VZVirtualMachineState {
    let (tx, rx) = mpsc::channel();
    let bound = QueueBound(vm.clone());
    queue.exec_sync(move || {
        // Capture the whole wrapper, not the projected field — edition
        // 2021's disjoint captures would otherwise grab the !Send
        // Retained directly and sidestep QueueBound.
        let vm = bound;
        let _ = tx.send(unsafe { vm.0.state() });
    });
    rx.recv().unwrap_or(VZVirtualMachineState::Error)
}

/// Graceful-then-forceful shutdown. `requestStop` asks the guest to
/// power down (it may not listen — our phase-1 initramfs has no ACPI
/// handling); after a short grace window we hard-stop, which is fine
/// for a guest whose persistent state is a journaled filesystem on
/// the data disk.
fn stop_vm(queue: &DispatchRetained<DispatchQueue>, vm: &Retained<VZVirtualMachine>) -> Result<()> {
    let bound = QueueBound(vm.clone());
    queue.exec_sync(move || {
        let vm = bound;
        unsafe {
            if vm.0.canRequestStop() {
                let _ = vm.0.requestStopWithError();
            }
        }
    });

    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if vm_state(queue, vm) == VZVirtualMachineState::Stopped {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(200));
    }

    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let bound = QueueBound(vm.clone());
    queue.exec_sync(move || {
        let vm = bound;
        let tx_handler = tx.clone();
        let handler = RcBlock::new(move |err: *mut NSError| {
            let outcome = if err.is_null() {
                Ok(())
            } else {
                Err(error_text(unsafe { &*err }))
            };
            let _ = tx_handler.send(outcome);
        });
        unsafe {
            if vm.0.canStop() {
                vm.0.stopWithCompletionHandler(&handler);
            } else {
                let _ = tx.send(Ok(()));
            }
        }
    });
    match rx.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(message)) => bail!("VM stop failed: {message}"),
        Err(_) => bail!("VM stop timed out"),
    }
}

fn file_url(path: &Path) -> Retained<NSURL> {
    NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()))
}

fn error_text(error: &NSError) -> String {
    error.localizedDescription().to_string()
}
