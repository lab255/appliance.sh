//! Guest payload assembly: everything the microVM needs beyond the
//! kernel/initramfs pair, packed into a FAT32 boot-media disk that
//! Alpine's own diskless init consumes:
//!
//!   /boot/modloop-virt          full kernel module tree (squashfs)
//!   /appliance.apkovl.tar.gz    our config overlay (openrc wiring +
//!                               the appliance.start bootstrap script)
//!   /k3s                        pinned k3s binary (arm64/amd64)
//!   /apks/{main,community}      Runtime's signed local Alpine repos
//!
//! Boot flow: the netboot initramfs (ip=dhcp) finds the FAT volume on
//! the second virtio-blk disk, mounts the modloop from it, applies the
//! apkovl, installs the apkovl's /etc/apk/world packages from the
//! selected repo (Runtime uses local signed media; other profiles use
//! the network), then pivots to the real root where openrc runs
//! /etc/local.d/appliance.start — which formats/mounts the persistent
//! data disk (vda) on first boot and starts k3s with its state there.
//!
//! Everything here is plain-Rust file generation: fatfs writes the
//! FAT image, tar+flate2 write the overlay. No host-side mount
//! privileges, no docker, no external tools.

use anyhow::{bail, Context, Result};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const K3S_VERSION: &str = "v1.31.4+k3s1";
const ALPINE_BRANCH: &str = "v3.21";
const ALPINE_NETBOOT: &str = "netboot-3.21.3";

// Sasha condition #3: committed sha256 for the UNAUTHENTICATED root-code
// downloads — `modloop-virt` is the guest's kernel-module squashfs and
// `k3s` runs as root in the guest, both higher-privilege than the agent
// image. k3s-io + Alpine publish these; verify before use, every boot
// (cache-hit included). Bumping K3S_VERSION / the Alpine pin is a
// deliberate change: new artifact + new digest, together.
const MODLOOP_SHA256_AARCH64: &str =
    "9ef26b38fa53be1310368150f947beead9011ce8b9890224a36f6be73dc14d49";
const MODLOOP_SHA256_X86_64: &str =
    "be613fc9d6f70c6b45dcee62787551c76e88ee3006867416bde6bc0cc2aa30f8";
const K3S_SHA256_ARM64: &str =
    "eff4cc82c8c057bd2dc432025b933616637dcf3df91e9e06720d9208743640d3";
const K3S_SHA256_AMD64: &str =
    "74897e4af26ea383ce50f445752f40ca63a0aef0d90994fb74073c43063eeeb2";

/// Kubeconfig HTTP handoff port served by busybox httpd inside the
/// guest (bound to the shared-network interface; the host fetches
/// http://<guest-ip>:9991/k3s.yaml once k3s is up).
pub const KUBECONFIG_PORT: u16 = 9991;

/// NodePort the in-VM registry service binds (inside the NodePort
/// range k3s allows by default).
pub const REGISTRY_NODEPORT: u16 = 30500;

/// Guest TCP port buildkitd's gRPC listener binds. The host forwards
/// 127.0.0.1:<buildkitPort> (5054 by default) here so `buildctl` on the
/// host builds images inside the VM with no Docker anywhere. Clear of
/// the kubeconfig handoff (9991) and the NodePort window (30000+).
pub const BUILDKITD_GUEST_PORT: u16 = 8372;

/// Guest TCP port the appliance api-server binary listens on. Reached
/// from the host via the existing ingress forward: a selector-less
/// Service + Endpoints route `api.appliance.localhost` through traefik
/// to this port, so no extra host forward is needed and every saved
/// profile URL keeps working. Clear of the kubeconfig handoff (9991),
/// buildkitd (8372), and the NodePort window (30000+).
pub const API_SERVER_GUEST_PORT: u16 = 9091;

/// VirtioFS tag the host-folder share is presented under. The VZ
/// backend tags the device with this; the guest bootstrap mounts the
/// same tag at /persist/workspace. Keep both sides in sync (a guest
/// test asserts the bootstrap references this exact value).
pub const WORKSPACE_VIRTIOFS_TAG: &str = "workspace";

/// Guest vsock port the shell agent listens on. The host's resident
/// process connects to it via the VM's VZVirtioSocketDevice and bridges
/// it to a per-VM Unix socket that `appliance-vm shell` drives.
pub const SHELL_VSOCK_PORT: u32 = 1024;
pub const ARTIFACT_VSOCK_PORT: u32 = 1025;

pub struct BootMedia {
    pub image: PathBuf,
    /// Whether THIS media embeds the CLI-staged api-server binary —
    /// captured at build time so readiness (`wait_platform_ready`) keys
    /// off what actually booted, not a later re-probe of the shared
    /// guest-assets cache (which the CLI can change under a running VM).
    pub apiserver_staged: bool,
}

fn arch_tuple() -> Result<(&'static str, &'static str)> {
    // (alpine arch, k3s release-asset suffix)
    match std::env::consts::ARCH {
        "aarch64" => Ok(("aarch64", "k3s-arm64")),
        "x86_64" => Ok(("x86_64", "k3s")),
        other => bail!("unsupported host architecture: {other}"),
    }
}

pub(crate) fn assets_dir() -> PathBuf {
    crate::store::vm_root().join("images").join("guest-assets")
}

/// Download (once) + verify the pinned k3s binary for this arch. Shared
/// by the FAT boot-media assembly (vz/kvm) and the WSL2 backend (which
/// copies it into the imported distro over drvfs and re-verifies it
/// guest-side). Returns the on-disk path and the committed sha256.
/// Sasha #3: hash-pinned and verified before use, every boot — a
/// cached/tampered artifact is rejected, not silently embedded.
pub fn ensure_k3s() -> Result<(PathBuf, &'static str)> {
    let (_, k3s_asset) = arch_tuple()?;
    let k3s_sha = match std::env::consts::ARCH {
        "aarch64" => K3S_SHA256_ARM64,
        "x86_64" => K3S_SHA256_AMD64,
        other => bail!("unsupported host architecture: {other}"),
    };
    let dir = assets_dir();
    fs::create_dir_all(&dir)?;
    let k3s = dir.join(format!("k3s-{K3S_VERSION}"));
    crate::images::download_and_verify(
        &format!(
            "https://github.com/k3s-io/k3s/releases/download/{}/{}",
            K3S_VERSION.replace('+', "%2B"),
            k3s_asset
        ),
        &k3s,
        k3s_sha,
    )?;
    Ok((k3s, k3s_sha))
}

/// Download (once) + verify the module loop every boot. Core-only media
/// deliberately does not resolve the lazy k3s artifact.
#[cfg_attr(windows, allow(dead_code))]
fn ensure_modloop() -> Result<PathBuf> {
    let (alpine_arch, _) = arch_tuple()?;
    let modloop_sha = match std::env::consts::ARCH {
        "aarch64" => MODLOOP_SHA256_AARCH64,
        "x86_64" => MODLOOP_SHA256_X86_64,
        other => bail!("unsupported host architecture: {other}"),
    };
    let dir = assets_dir();
    fs::create_dir_all(&dir)?;

    let modloop = dir.join("modloop-virt");
    crate::images::download_and_verify(
        &format!(
            "https://dl-cdn.alpinelinux.org/alpine/{ALPINE_BRANCH}/releases/{alpine_arch}/{ALPINE_NETBOOT}/modloop-virt"
        ),
        &modloop,
        modloop_sha,
    )?;

    Ok(modloop)
}

/// Volume label of the platform-images media (the FAT wrapper around the
/// k3s airgap tarball, attached as an extra read-only virtio-blk on k3s
/// VMs). The guest probes `blkid` for THIS LABEL — never a device node:
/// `/dev/vdc` remains the contractual agent image on agent-only VMs. The
/// platform image is label-resolved because its optional position is not a
/// contract. A guest test locks these nodes to VZ's attachment order.
pub const K3S_AIRGAP_VOLUME_LABEL: &str = "K3SIMAGES";

const VZ_BOOT_MEDIA_DEVICE: &str = "/dev/vdb";
const VZ_AGENT_IMAGE_DEVICE: &str = "/dev/vdc";

/// File name the airgap tarball rides under, both on the media and in
/// `$PERSIST/k3s/agent/images/` (k3s auto-imports anything there).
pub const K3S_AIRGAP_MEDIA_FILE: &str = "k3s-airgap-images.tar.zst";

/// Resolve (building on first use) the platform-images media: the pinned,
/// hash-verified k3s airgap tarball wrapped in a small FAT volume so the
/// guest can find it by label and mount it read-only. The SOURCE tarball
/// is re-verified against its committed sha256 on every call (cache-hit
/// included, `download_and_verify` semantics); the derived FAT image is a
/// deterministic function of it, re-derived only when absent — the same
/// verified-raw/derived split the normalized kernel uses.
pub fn ensure_k3s_airgap_media() -> Result<PathBuf> {
    let tarball = crate::images::ensure_k3s_airgap_images()?;
    let dir = assets_dir();
    let image_path = dir.join(format!(
        "k3s-airgap-media-{}.img",
        crate::images::K3S_AIRGAP_VERSION
    ));
    if image_path.exists() {
        return Ok(image_path);
    }

    let tar_data = fs::read(&tarball)?;
    let volume_bytes =
        ((tar_data.len() as u64 + 64 * 1024 * 1024) / (16 * 1024 * 1024) + 1) * (16 * 1024 * 1024);
    // Atomic like download_and_verify: build at .partial, rename into
    // place — a killed build never leaves a truncated image at the
    // canonical name.
    let partial = image_path.with_extension("partial");
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(&partial)
        .with_context(|| format!("create {}", partial.display()))?;
    file.set_len(volume_bytes)?;
    // FAT volume labels are exactly 11 bytes, space-padded.
    let mut label = [b' '; 11];
    label[..K3S_AIRGAP_VOLUME_LABEL.len()].copy_from_slice(K3S_AIRGAP_VOLUME_LABEL.as_bytes());
    let buf = fscommon::BufStream::new(&file);
    fatfs::format_volume(
        buf,
        fatfs::FormatVolumeOptions::new().volume_label(label),
    )
    .context("format platform-images FAT volume")?;
    let buf = fscommon::BufStream::new(&file);
    let fs = fatfs::FileSystem::new(buf, fatfs::FsOptions::new())
        .context("open platform-images FAT volume")?;
    {
        let root = fs.root_dir();
        let mut f = root.create_file(K3S_AIRGAP_MEDIA_FILE)?;
        f.write_all(&tar_data)?;
    }
    fs.unmount().context("unmount platform-images FAT volume")?;
    drop(file);
    std::fs::rename(&partial, &image_path)?;
    Ok(image_path)
}

/// CLI-staged api-server guest artifacts: the compiled linux binary
/// (required) and the web-console bundle (optional). The appliance CLI
/// stages these into the shared guest-assets cache before `vm up` —
/// from a repo build or a release download — and the boot media embeds
/// whatever is present. The engine itself never builds or downloads
/// them; a VM booted without them simply has no control plane (the
/// provision block logs that honestly).
pub struct ApiServerAssets {
    pub binary: PathBuf,
    pub console: Option<PathBuf>,
    pub release_evidence: Option<ApiServerReleaseEvidence>,
    /// At least one signed-evidence sidecar exists, but the complete set did
    /// not pass its structural checks. Stream a poison marker so the guest
    /// refuses the seed instead of silently treating it as pre-MV0 unsigned.
    pub evidence_poisoned: bool,
}

pub struct ApiServerReleaseEvidence {
    pub checksums: PathBuf,
    pub properties: PathBuf,
    pub payload: PathBuf,
    pub envelope: PathBuf,
}

/// Release state needed while composing a guest seed gate. The full assets
/// remain owned by the backend's media/streaming path; this view keeps the
/// independently rendered trust pin beside the evidence state it governs.
#[derive(Clone, Copy)]
pub(crate) struct ReleaseGate<'a> {
    pub pinned_key_id: &'a str,
    pub evidence: Option<&'a ApiServerReleaseEvidence>,
    pub poison: bool,
}

impl<'a> ReleaseGate<'a> {
    pub(crate) fn from_assets(
        pinned_key_id: &'a str,
        assets: Option<&'a ApiServerAssets>,
    ) -> Option<Self> {
        assets.map(|assets| Self {
            pinned_key_id,
            evidence: assets.release_evidence.as_ref(),
            poison: assets.evidence_poisoned,
        })
    }

    pub(crate) fn validate(self) -> Result<()> {
        validate_pinned_release_key_id(self.pinned_key_id)?;
        if self.evidence.is_some() && self.poison {
            bail!("api-server release evidence cannot be both verified and poisoned");
        }
        Ok(())
    }
}

pub(crate) const PINNED_RELEASE_KEY_ID_ENV: &str = "APPLIANCE_PINNED_RELEASE_KEY_ID";

pub(crate) fn validate_pinned_release_key_id(value: &str) -> Result<()> {
    if value.is_empty()
        || value.strip_prefix("ed25519:sha256:").is_some_and(|hex| {
            hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    {
        return Ok(());
    }
    bail!("release keyId must be empty or an ed25519:sha256 pin");
}

pub(crate) fn pinned_release_key_id_from_env() -> Result<String> {
    let value = std::env::var(PINNED_RELEASE_KEY_ID_ENV).unwrap_or_default();
    validate_pinned_release_key_id(&value)?;
    Ok(value)
}

fn release_evidence_well_formed(evidence: &ApiServerReleaseEvidence) -> bool {
    let Ok(checksums) = fs::read_to_string(&evidence.checksums) else { return false };
    let mut binary_row = None;
    let mut console_row = None;
    for line in checksums.lines() {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.len() != 3
            || fields[0].len() != 64
            || !fields[0].bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            || fields[2].parse::<u64>().ok().filter(|size| *size > 0).is_none()
        {
            return false;
        }
        let row = (fields[0], fields[2].parse::<u64>().unwrap());
        match fields[1] {
            "appliance-api-server" if binary_row.is_none() => binary_row = Some(row),
            "appliance-console.tar.gz" if console_row.is_none() => console_row = Some(row),
            _ => return false,
        }
    }
    let (Some(binary_row), Some(console_row)) = (binary_row, console_row) else { return false };

    let Ok(properties) = fs::read_to_string(&evidence.properties) else { return false };
    let mut key_id = None;
    let mut version = None;
    let mut generation = None;
    let mut arch = None;
    for line in properties.lines() {
        let Some((key, value)) = line.split_once('=') else { return false };
        match key {
            "keyId" if key_id.is_none() => key_id = Some(value),
            "version" if version.is_none() => version = Some(value),
            "generation" if generation.is_none() => generation = value.parse::<u64>().ok(),
            "arch" if arch.is_none() => arch = Some(value),
            _ => return false,
        }
    }
    if key_id.is_none_or(|value| value.is_empty() || validate_pinned_release_key_id(value).is_err())
        || version.is_none_or(str::is_empty)
        || generation.is_none()
        || !matches!(arch, Some("x64" | "arm64"))
    {
        return false;
    }

    let Some(key_id) = key_id else { return false };
    let Some(version) = version else { return false };
    let Some(generation) = generation else { return false };
    let Some(arch) = arch else { return false };
    let Ok(payload_raw) = fs::read_to_string(&evidence.payload) else { return false };
    let Ok(payload) = serde_json::from_str::<serde_json::Value>(&payload_raw) else { return false };
    let Some(artifacts) = payload.get("artifacts").and_then(serde_json::Value::as_array) else { return false };
    let binary_name = format!("appliance-api-server-linux-{arch}");
    let artifact_matches = |name: &str, row: (&str, u64)| {
        artifacts.iter().any(|artifact| {
            artifact.get("name").and_then(serde_json::Value::as_str) == Some(name)
                && artifact.get("sha256").and_then(serde_json::Value::as_str) == Some(row.0)
                && artifact.get("size").and_then(serde_json::Value::as_u64) == Some(row.1)
        })
    };
    if payload.get("kind").and_then(serde_json::Value::as_str) != Some("control-plane-release")
        || payload.get("version").and_then(serde_json::Value::as_str) != Some(version)
        || payload.get("generation").and_then(serde_json::Value::as_u64) != Some(generation)
        || !artifact_matches(&binary_name, binary_row)
        || !artifact_matches("appliance-console.tar.gz", console_row)
    {
        return false;
    }

    let Ok(envelope_raw) = fs::read_to_string(&evidence.envelope) else { return false };
    let Ok(envelope) = serde_json::from_str::<serde_json::Value>(&envelope_raw) else { return false };
    envelope.get("alg").and_then(serde_json::Value::as_str) == Some("ed25519")
        && envelope.get("role").and_then(serde_json::Value::as_str) == Some("control-plane-release")
        && envelope.get("keyId").and_then(serde_json::Value::as_str) == Some(key_id)
        && envelope.get("sig").and_then(serde_json::Value::as_str).is_some_and(|sig| !sig.is_empty())
}

fn classify_release_evidence(
    evidence: ApiServerReleaseEvidence,
) -> (Option<ApiServerReleaseEvidence>, bool) {
    let paths = [&evidence.checksums, &evidence.properties, &evidence.payload, &evidence.envelope];
    let any_evidence = paths.iter().any(|path| path.exists());
    let valid = paths.iter().all(|path| path.is_file()) && release_evidence_well_formed(&evidence);
    if valid { (Some(evidence), false) } else { (None, any_evidence) }
}

/// Locate the staged api-server artifacts, or None when the binary is
/// absent (agent-only workflows, or an engine invoked without the CLI).
pub fn apiserver_assets() -> Option<ApiServerAssets> {
    let dir = assets_dir();
    let binary = dir.join("appliance-api-server");
    if !binary.is_file() {
        return None;
    }
    let console = dir.join("appliance-console.tar.gz");
    let console = console.is_file().then_some(console);
    let checksums = dir.join("appliance-api-server.sha256");
    let properties = dir.join("control-plane-release.properties");
    let payload = dir.join("control-plane-release.json");
    let envelope = dir.join("control-plane-release.sig.json");
    let (release_evidence, evidence_poisoned) = classify_release_evidence(ApiServerReleaseEvidence {
        checksums,
        properties,
        payload,
        envelope,
    });
    Some(ApiServerAssets {
        binary,
        console,
        release_evidence,
        evidence_poisoned,
    })
}

/// Read (or generate once) the VM's bootstrap token — the shared secret
/// `POST /bootstrap/create-key` requires. Persisted host-side at
/// `~/.appliance/vm/<name>/bootstrap-token` so the CLI can mint keys,
/// and injected into the guest at `/etc/appliance/bootstrap-token`
/// (0600) so the api-server binary can verify them.
pub fn ensure_bootstrap_token(vm_dir: &Path) -> Result<String> {
    let path = vm_dir.join("bootstrap-token");
    if let Ok(existing) = fs::read_to_string(&path) {
        let token = existing.trim().to_string();
        if !token.is_empty() {
            return Ok(token);
        }
    }
    use ring::rand::{SecureRandom, SystemRandom};
    let mut buf = [0u8; 32];
    SystemRandom::new()
        .fill(&mut buf)
        .map_err(|_| anyhow::anyhow!("system rng unavailable for bootstrap token"))?;
    let token: String = buf.iter().map(|b| format!("{b:02x}")).collect();
    fs::create_dir_all(vm_dir)?;
    fs::write(&path, &token)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(token)
}

/// The guest bootstrap that openrc's `local` service runs once the
/// diskless root is up. Owns: persistent disk, k3s launch, kubeconfig
/// handoff.
const APPLIANCE_START: &str = r#"#!/bin/sh
# appliance.start — guest bootstrap (runs from /etc/local.d at boot).
# Output goes to the virtio console so the host's console.log captures
# it — there's no exec channel into the guest yet, so the console is
# the only debugging surface.
exec >/dev/console 2>&1
set -x

# --- egress CA trust (node-side) ------------------------------------
# Trust the per-VM Appliance egress CA the apkovl placed, so node-side
# tooling (containerd, host curl) validates the interception proxy.
# No-op when the file is absent (CA not generated / older media).
if [ -f /usr/local/share/ca-certificates/appliance-egress.crt ]; then
  update-ca-certificates 2>/dev/null || true
fi

# --- persistent data disk (vda) -------------------------------------
# First boot: no filesystem signature -> mkfs. ext4 is built into the
# alpine virt kernel; e2fsprogs comes from the apkovl world file.
PERSIST=/persist
mkdir -p "$PERSIST"
# busybox blkid exits 0 even when it finds no signature — gate on its
# *output* instead of its status.
if [ -z "$(blkid /dev/vda 2>/dev/null)" ]; then
  mkfs.ext4 -q -L appliance-data /dev/vda
fi
if ! mount -t ext4 /dev/vda "$PERSIST"; then
  echo "WARNING: data disk mount failed — falling back to tmpfs (no persistence, limited space)"
fi

# --- isolated control-plane volume (vdb) -----------------------------
__CONTROL_PLANE_PROVISION__

# --- non-root appliance user ----------------------------------------
# Substituted with the provisioning block below on EVERY VM (uid/gid
# pinned at build time). Runs after the /persist mount so HOME +
# workspace land on the persistent disk, and before the vsock shell
# agent so the first shell connection can already `su` to a real user.
__APP_USER_PROVISION__
# --- vsock shell agent (appliance-vm shell) -------------------------
# A PTY login shell served per connection on a fixed vsock port. The
# host's resident process bridges a local Unix socket to this; no SSH,
# no TCP exposure, and it works before k3s is up. Runs on every VM.
if command -v socat >/dev/null 2>&1; then
  # -t 30: post-EOF grace. socat's default (0.5s) tears the PTY child
  # down half a second after the client half-closes, killing any
  # still-running one-shot command (npm installs, builds) mid-flight.
  socat -t 30 VSOCK-LISTEN:__SHELL_VSOCK_PORT__,reuseaddr,fork \
    EXEC:/usr/local/bin/appliance-shell-agent,pty,setsid,ctty,stderr \
    >/var/log/appliance-shell.log 2>&1 &
  echo "appliance-shell: vsock shell agent listening on port __SHELL_VSOCK_PORT__"
else
  echo "appliance-shell: socat not installed — vsock shell unavailable"
fi

__ARTIFACT_PROVISION__

# --- dev environment (appliance vm dev) ------------------------------
# Substituted with the provisioning block below for dev VMs, empty
# otherwise. Runs after /persist is mounted so the workspace, home, and
# apk cache all land on the persistent disk.
__DEV_PROVISION__
# --- pooled Appliance Runtime supervisor ----------------------------
# Core-only runtime VMs get containerd plus the small host-driven
# supervisor below. Empty for ordinary core, dev, and cluster VMs.
__RUNTIME_PROVISION__
# --- docker engine (appliance vm ... --docker) -----------------------
# Substituted with the provisioning block below for docker VMs, empty
# otherwise. Backgrounded and fully decoupled from the bring-up phases:
# k3s readiness below is what `vm up` waits on, never dockerd.
__DOCKER_PROVISION__
# --- buildkit (docker-free image builds) ------------------------------
# Substituted with the provisioning block below on every k3s VM, empty
# for agent-only VMs (no registry to push to). Backgrounded like the
# docker engine: k3s readiness never waits on buildkitd.
__BUILDKIT_PROVISION__
# --- k3s / agent-runtime handoff -------------------------------------
# Substituted with the k3s control-plane block (normal VM) or the
# agent-runtime handoff (agent-only VM). Quinn gap #1: this block carries
# nested port markers, so it is injected BEFORE the port substitutions.
__K3S_PROVISION__
# --- appliance api-server (control plane as a guest binary) -----------
# Substituted with the provisioning block below on k3s VMs whose boot
# media carries the api-server binary; empty otherwise. Runs after the
# k3s block so $PERSIST/k3s and the manifests dir conventions are
# established (k3s itself is already backgrounded).
__APISERVER_PROVISION__
"#;

const VZ_CONTROL_PLANE_PROVISION: &str = r#"CONTROL_PLANE_ROOT=/var/lib/appliance-control-plane
mkdir -p "$CONTROL_PLANE_ROOT"
CONTROL_PLANE_DEVICE=$(blkid -L appliance-control-plane 2>/dev/null || true)
if [ -z "$CONTROL_PLANE_DEVICE" ]; then
  for DEVICE in /dev/vd?; do
    [ -b "$DEVICE" ] || continue
    DEVICE_INFO=$(blkid "$DEVICE" 2>/dev/null || true)
    case "$DEVICE_INFO" in *'TYPE='*|*'LABEL='*) continue;; esac
    if mkfs.ext4 -q -L appliance-control-plane "$DEVICE"; then
      CONTROL_PLANE_DEVICE=$(blkid -L appliance-control-plane 2>/dev/null || true)
      break
    fi
  done
fi
if [ -n "$CONTROL_PLANE_DEVICE" ] && { mount -t ext4 -o nodev,nosuid,nosymfollow "$CONTROL_PLANE_DEVICE" "$CONTROL_PLANE_ROOT" 2>/dev/null || { echo "appliance-control-plane: nosymfollow unavailable; falling back to root-only mount" >&2; mount -t ext4 -o nodev,nosuid "$CONTROL_PLANE_DEVICE" "$CONTROL_PLANE_ROOT"; }; }; then
  if ! resize2fs "$CONTROL_PLANE_DEVICE" >/dev/null 2>&1; then
    echo "appliance-control-plane: filesystem resize failed; retaining the current filesystem capacity" >&2
  fi
  chown root:root "$CONTROL_PLANE_ROOT"
  chmod 0700 "$CONTROL_PLANE_ROOT"
  mkdir -p "$CONTROL_PLANE_ROOT/releases" "$CONTROL_PLANE_ROOT/incoming" /run/appliance/capabilities
  chmod 0700 "$CONTROL_PLANE_ROOT/releases" "$CONTROL_PLANE_ROOT/incoming"
  printf 'artifact-vsock=%s\n' '__ARTIFACT_VSOCK_PORT__' > /run/appliance/capabilities/control-plane-update-v1
  chmod 0600 /run/appliance/capabilities/control-plane-update-v1
else
  echo "appliance-api-server: SECURITY: isolated control-plane volume unavailable; in-place update disabled" >&2
  CONTROL_PLANE_ROOT=
fi
"#;

const VZ_ARTIFACT_PROVISION: &str = r#"if [ -n "${CONTROL_PLANE_ROOT:-}" ] && command -v socat >/dev/null 2>&1; then
  socat -t 30 VSOCK-LISTEN:__ARTIFACT_VSOCK_PORT__,reuseaddr,fork \
    EXEC:/usr/local/bin/appliance-control-plane-artifact-agent,stderr \
    >/var/log/appliance-control-plane-artifact.log 2>&1 &
  echo "appliance-control-plane: raw artifact listener on port __ARTIFACT_VSOCK_PORT__"
fi
"#;

/// The k3s control-plane region of `APPLIANCE_START`, substituted for
/// the `__K3S_PROVISION__` marker on a normal (non-agent-only) VM:
/// byte-for-byte the original inline block — the k3s binary copy
/// (`K3S_MEDIA_COPY`), then `K3S_COMMON` (`registries.yaml`, the in-VM
/// registry manifest, `k3s server`, the kubeconfig handoff). Agent-only
/// VMs swap in `AGENT_HANDOFF` instead. Split in two so the WSL2
/// backend can reuse the common core behind its own copy preamble
/// (there is no FAT boot media inside a WSL distro).
///
/// Carries nested `__REGISTRY_HOST_PORT__` / `__REGISTRY_NODEPORT__` /
/// `__KUBECONFIG_PORT__` markers, so it MUST be injected before those
/// port markers are substituted (Quinn gap #1; see `build_apkovl`).
const K3S_MEDIA_COPY: &str = r#"# --- k3s -------------------------------------------------------------
# The binary lives on the FAT boot media; copy to the root tmpfs so it
# runs without noexec/permission concerns.
MEDIA=$(dirname "$(find /media -maxdepth 2 -name k3s 2>/dev/null | head -1)")
if [ -z "$MEDIA" ]; then
  echo "FATAL: k3s binary not found on boot media"
  exit 1
fi
cp "$MEDIA/k3s" /usr/local/bin/k3s
chmod +x /usr/local/bin/k3s
"#;

/// The backend-neutral half of the k3s provisioning: assumes
/// `/usr/local/bin/k3s` is in place and `$PERSIST` is mounted; wires the
/// registry mirror + manifest, launches `k3s server`, and serves the
/// kubeconfig handoff. Reused verbatim by the WSL2 backend.
pub(crate) const K3S_COMMON: &str = r#"
mkdir -p "$PERSIST/k3s" /etc/rancher/k3s

# --- bring-up progress handoff ---------------------------------------
# Serve /srv/handoff from the START of the k3s block, not once k3s.yaml
# exists: the host polls /progress to advance honest sub-phases through
# the long "cluster" window, and later fetches /k3s.yaml off the same
# httpd. Grippable markers only — the host never scrapes console echo.
mkdir -p /srv/handoff
: > /srv/handoff/progress
httpd -f -p __KUBECONFIG_PORT__ -h /srv/handoff &
echo base-system-ready >> /srv/handoff/progress

# containerd pull-through: image refs pushed from the host as
# localhost:__REGISTRY_HOST_PORT__/<name> resolve to the in-VM registry's
# NodePort. Read by k3s at startup.
cat > /etc/rancher/k3s/registries.yaml <<RYAML
mirrors:
  "localhost:__REGISTRY_HOST_PORT__":
    endpoint:
      - "http://127.0.0.1:__REGISTRY_NODEPORT__"
RYAML

# In-VM image registry, installed via k3s's auto-applying manifests
# dir. Plain registry:2 on a NodePort; the host forwards
# 127.0.0.1:__REGISTRY_HOST_PORT__ here so `docker push` from the host
# lands inside the VM.
mkdir -p "$PERSIST/k3s/server/manifests"
cat > "$PERSIST/k3s/server/manifests/appliance-registry.yaml" <<RMANIFEST
apiVersion: apps/v1
kind: Deployment
metadata:
  name: appliance-registry
  namespace: kube-system
  labels:
    app.kubernetes.io/name: appliance-registry
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: appliance-registry
  template:
    metadata:
      labels:
        app.kubernetes.io/name: appliance-registry
    spec:
      containers:
      - name: registry
        image: registry:2
        ports:
        - containerPort: 5000
        volumeMounts:
        - name: data
          mountPath: /var/lib/registry
      volumes:
      - name: data
        hostPath:
          path: /persist/registry
          type: DirectoryOrCreate
---
apiVersion: v1
kind: Service
metadata:
  name: appliance-registry
  namespace: kube-system
spec:
  type: NodePort
  selector:
    app.kubernetes.io/name: appliance-registry
  ports:
  - port: 5000
    targetPort: 5000
    nodePort: __REGISTRY_NODEPORT__
RMANIFEST

# --- k3s airgap image preload -----------------------------------------
# The preamble line below is substituted per backend: vz arms the probe
# variable (it may attach the platform-images media as an extra
# read-only virtio-blk); WSL substitutes it empty, so the whole block is
# skipped and the images are pulled from the network exactly as before.
# Runs BEFORE the server launch below so the tarball is in the import
# dir when containerd starts.
__K3S_AIRGAP_PREAMBLE__
if [ -n "$APPLIANCE_AIRGAP_PROBE" ]; then
  mkdir -p "$PERSIST/k3s/agent/images"
  # First boot only: the staged tarball persists on the data disk, so
  # its presence is the stamp. Probe by FILESYSTEM LABEL, never a device
  # node — the third disk is the agent image on agent-only VMs, and
  # device order is an attachment detail.
  if [ ! -f "$PERSIST/k3s/agent/images/k3s-airgap-images.tar.zst" ]; then
    AIRGAP_DEV=$(blkid 2>/dev/null | awk -F: '/LABEL="K3SIMAGES"/ {print $1; exit}')
    if [ -n "$AIRGAP_DEV" ]; then
      mkdir -p /media/k3s-images
      if mount -o ro "$AIRGAP_DEV" /media/k3s-images 2>/dev/null; then
        # The stamp name must only ever appear COMPLETE: copy to a .tmp
        # sibling on the same filesystem and mv into place (the commit
        # point). A power-off mid-copy leaves only the .tmp — never a
        # truncated stamp that poisons the preload on every later boot.
        if cp /media/k3s-images/k3s-airgap-images.tar.zst "$PERSIST/k3s/agent/images/k3s-airgap-images.tar.zst.tmp"; then
          mv "$PERSIST/k3s/agent/images/k3s-airgap-images.tar.zst.tmp" "$PERSIST/k3s/agent/images/k3s-airgap-images.tar.zst"
          echo "k3s-airgap: staged platform images for k3s import"
        else
          rm -f "$PERSIST/k3s/agent/images/k3s-airgap-images.tar.zst.tmp"
        fi
        umount /media/k3s-images
      fi
    else
      echo "k3s-airgap: no platform-images media — k3s pulls from the network"
    fi
  fi
  if [ -f "$PERSIST/k3s/agent/images/k3s-airgap-images.tar.zst" ]; then
    echo images-imported >> /srv/handoff/progress
  fi
fi

# Single-node dev cluster. Traefik (bundled) terminates ingress on
# node port 80 via servicelb — the host forwards 127.0.0.1:<hostPort>
# here. The kubeconfig is world-readable on purpose: it never leaves
# the VM except over the host handoff below.
/usr/local/bin/k3s server \
  --data-dir "$PERSIST/k3s" \
  --write-kubeconfig-mode 644 \
  >/var/log/k3s.log 2>&1 &

# --- kubeconfig handoff ----------------------------------------------
# Publish the admin kubeconfig into the already-running handoff httpd
# once k3s writes it, and mark the API up for the progress poller. The
# host rewrites the server address to its forwarded localhost port.
(
  while [ ! -s /etc/rancher/k3s/k3s.yaml ]; do sleep 1; done
  cp /etc/rancher/k3s/k3s.yaml /srv/handoff/k3s.yaml
  echo k3s-api-up >> /srv/handoff/progress
) &
"#;

/// The agent-runtime handoff, substituted for `__K3S_PROVISION__` when
/// the spec is agent-only. This VM runs NO k3s: readiness is the agent
/// runtime — the vsock shell agent (already launched above) plus the
/// Node toolchain `DEV_PROVISION` installs.
///
/// Quinn gap #2: it gates on the toolchain's grippable
/// `/persist/.dev-ready` marker (NOT the shell agent's "listening"
/// console echo, which never lands in a file the host can grip), then
/// serves a one-line `agent-ready` sentinel over the SAME busybox httpd
/// the k3s kubeconfig handoff uses — bound to `__KUBECONFIG_PORT__`, free
/// here since no k3s competes for it. `host_services` fetches it to gate
/// `up`. Because `agent_only ⟹ dev`, `.dev-ready` is always written, so
/// the gate always fires.
///
/// `__AGENT_DOCKER_STUB__` drops a no-op `docker` shim ONLY when this
/// agent VM was provisioned without `--docker`, so an unflagged `docker`
/// call gets an honest "relaunch with --docker" instead of a silent
/// command-not-found. Empty (skipped) on a `--docker` agent VM, so it
/// never shadows the real engine the docker provision installs.
const AGENT_HANDOFF: &str = r#"# --- agent runtime handoff (agent-only VM) --------------------------
# No k3s control plane here. Gate readiness on the agent runtime: the
# vsock shell (already listening above) + the Node toolchain
# DEV_PROVISION installs (agent_only implies dev).
__AGENT_DOCKER_STUB__
# --- prebuilt agent image (read-only squashfs on vdc) ---------------
# Node ≥22 + the pinned agent CLIs, baked + hash-verified host-side and
# attached read-only as the 3rd virtio-blk. Mount it read-only so the
# baked toolchain is on PATH (the login profile prepends its bin) — an
# agent can't shadow or tamper with its own toolchain at runtime
# (docs/fast-spin-up.md §2.1/§2.4). Best-effort: when no verified image
# was attached the device is absent, and the npm self-heal below installs
# the CLIs into /persist/npm-global instead.
mkdir -p /opt/appliance/agents
if mount -t squashfs -o ro __AGENT_IMAGE_DEVICE__ /opt/appliance/agents 2>/dev/null; then
  echo "appliance-agents: mounted prebuilt agent image (read-only) at /opt/appliance/agents"
else
  echo "appliance-agents: no prebuilt agent image on __AGENT_IMAGE_DEVICE__ — CLIs self-heal via npm into /persist/npm-global"
fi
# npm's global prefix lives on the ext4 data disk (/persist/npm-global),
# OFF the VirtioFS workspace mount — this ends the repo pollution and the
# per-project reinstall (docs/fast-spin-up.md §2.5).
mkdir -p /persist/npm-global
# Sasha condition #2: wipe /persist/npm-global on a PROJECT SWITCH so a CLI
# a self-heal installed for one project can't persist on PATH into the
# next (the cross-project PATH-persistence vector). The host stamps the
# mounted project's identity (a hash of its path) into the media; compare
# it against the one this disk was last provisioned for. The read-only
# squashfs already shields the three baked CLIs — this closes the npm
# self-heal residue. Empty identity (no mount) ⇒ no wipe.
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
  # Wait for the dev toolchain (nodejs/npm) — the grippable .dev-ready
  # marker, never the shell agent's console echo. Then serve the
  # agent-ready sentinel the host gates `up` on.
  while [ ! -f /persist/.dev-ready ]; do sleep 1; done
  echo agent-ready > /srv/handoff/agent-ready
  httpd -f -p __KUBECONFIG_PORT__ -h /srv/handoff &
) &
"#;

/// The honest-failure `docker` shim dropped on an agent VM provisioned
/// WITHOUT `--docker` (substituted into `AGENT_HANDOFF`'s
/// `__AGENT_DOCKER_STUB__`). Lives at `/usr/local/bin/docker` — ahead of
/// the real `/usr/bin/docker` on PATH — but is only ever written on a
/// no-docker agent boot (the marker is empty when `--docker` is set), so
/// it never shadows a real engine.
pub(crate) const AGENT_DOCKER_STUB: &str = r#"# docker not provisioned in this agent sandbox: fail honestly instead of
# a silent command-not-found. Skipped (marker empty) on a --docker VM.
mkdir -p /usr/local/bin
cat > /usr/local/bin/docker <<'DOCKERSTUB'
#!/bin/sh
echo "docker is not provisioned in this agent sandbox." >&2
echo "Relaunch the agent with: appliance agent start --docker" >&2
exit 127
DOCKERSTUB
chmod +x /usr/local/bin/docker"#;

/// Non-root `appliance` user provisioning, substituted into
/// `APPLIANCE_START` (the `__APP_USER_PROVISION__` marker) on EVERY VM.
///
/// Diskless Alpine rebuilds `/etc/passwd`, `/etc/group`, `/etc/shadow`
/// and `/etc/sudoers.d` into tmpfs on every boot, so the user is
/// (re)created each boot rather than once. The idempotency story is the
/// **pinned uid/gid** (`__APP_UID__`/`__APP_GID__`, substituted at
/// boot-media build time): stable ids keep ownership of files on the
/// persistent `/persist` disk consistent across reboots, and the
/// `|| true` guards make the re-runs harmless.
///
/// The user lands in `wheel` (passwordless sudo via `/etc/sudoers.d`)
/// here; `docker` group membership is added in `DOCKER_PROVISION` (the
/// group only exists after `apk add docker`). HOME is `/persist/workspace`.
/// The npm global prefix is `/persist/npm-global` — on the ext4 data disk,
/// OFF the VirtioFS workspace mount (no repo pollution, no per-project
/// reinstall — docs/fast-spin-up.md §2.5). PATH prepends the prebuilt agent
/// image's `bin` (agent-only VMs, via `__AGENT_BIN_PATH__`) so the baked,
/// read-only CLIs win and an agent can't shadow them, then the npm prefix
/// `bin` for any self-healed installs.
pub(crate) const APP_USER_PROVISION: &str = r#"
echo "appliance-user: provisioning the non-root appliance user"
# uid/gid are PINNED (host uid/gid on --mount VMs, 1000 otherwise) so
# /persist ownership stays stable across the diskless rebuild each boot.
APP_USER=appliance
APP_UID=__APP_UID__
APP_GID=__APP_GID__
APP_HOME=/persist/workspace

mkdir -p "$APP_HOME"
# Resolve the group that already owns $APP_GID. Alpine baselayout pins
# several gids (e.g. gid 20 is `dialout`), and on a --mount VM $APP_GID is
# the host's primary gid — `staff=20` on macOS — which collides. When a
# group already owns the gid the appliance user joins IT as its primary
# group; `addgroup -g <taken-gid>` would fail ("gid in use") and a
# swallowed failure there leaves the user (and the vsock `su`) broken.
# Only create a fresh `appliance` group when the gid is actually free.
APP_GROUP=$(awk -F: -v g="$APP_GID" '$3==g{print $1; exit}' /etc/group)
if [ -n "$APP_GROUP" ]; then
  echo "appliance-user: gid $APP_GID already owned by group '$APP_GROUP' — using it as the primary group"
else
  addgroup -g "$APP_GID" "$APP_USER"
  APP_GROUP="$APP_USER"
fi
# busybox adduser: -D no password, -H don't create home (it's on
# /persist, made above), -h home, -s login shell, -G primary group,
# -u uid. adduser/addgroup are busybox builtins (always present).
adduser -D -H -u "$APP_UID" -G "$APP_GROUP" -h "$APP_HOME" -s /bin/sh "$APP_USER"
# Verify loudly: a swallowed adduser failure (the gid collision used to
# land exactly here) leaves the vsock shell unable to `su -l appliance`,
# so surface it on the console instead of silently booting a broken shell.
if id "$APP_USER" >/dev/null 2>&1; then
  echo "appliance-user: created $APP_USER (uid=$(id -u "$APP_USER") gid=$(id -g "$APP_USER") group=$(id -gn "$APP_USER"))"
else
  echo "appliance-user: FATAL could not create $APP_USER (uid=$APP_UID gid=$APP_GID group=$APP_GROUP)"
fi
addgroup "$APP_USER" wheel 2>/dev/null || true
# docker group membership is added in DOCKER_PROVISION (the group only
# exists once the docker package is installed), not here.
chown "$APP_UID:$APP_GID" "$APP_HOME" 2>/dev/null || true
chmod 0755 "$APP_HOME" 2>/dev/null || true

# Passwordless sudo for wheel via a drop-in (the diskless rebuild wipes
# /etc/sudoers.d too, so rewrite it every boot).
mkdir -p /etc/sudoers.d
printf '%s\n' "$APP_USER ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/appliance
chmod 0440 /etc/sudoers.d/appliance

# npm's global prefix (NPM_CONFIG_PREFIX below) lives on the root-owned
# /persist disk — create it HERE, owned by the unprivileged user, or the
# first `npm install -g` self-heal EACCESes. The agent-only handoff blocks
# also (re)create it around the project-switch wipe; this covers the
# merged k3s+dev VM, which has no handoff block.
mkdir -p /persist/npm-global
chown "$APP_UID:$APP_GID" /persist/npm-global 2>/dev/null || true

# Login env for the appliance user: npm global prefix under HOME so
# global installs (appliance up) succeed unprivileged. /etc/profile.d/*.sh
# is sourced by the login shell the agent's `su -l` starts.
mkdir -p /etc/profile.d
cat > /etc/profile.d/appliance-user.sh <<'PROFILE'
export NPM_CONFIG_PREFIX="/persist/npm-global"
export PATH="__AGENT_BIN_PATH__/persist/npm-global/bin:$PATH"
PROFILE
"#;

/// The host user's uid/gid. Unix: the real ids, so a shared workspace
/// keeps host-side ownership writable. Windows: there is no host uid to
/// mirror — the WSL2 backend's drvfs automount does its own ownership
/// mapping — so the conventional 1000/1000 is pinned.
fn host_ids() -> (u32, u32) {
    #[cfg(unix)]
    unsafe {
        (libc::getuid(), libc::getgid())
    }
    #[cfg(windows)]
    {
        (1000, 1000)
    }
}

/// Resolve the `appliance` user's uid/gid for the guest. On a
/// VirtioFS-mounted (`--mount`) VM the host folder is shared at the
/// user's HOME (`/persist/workspace`) and presents **host-side
/// ownership**, so the guest user must carry the host user's uid/gid to
/// read/write that tree as the host user does (a fixed 1000 would lose
/// write access). Without a share there is no host ownership to match,
/// so the conventional `1000` is used. Pure so the substitution logic is
/// unit-tested without a live VM.
fn resolve_app_ids(mount: bool, host_uid: u32, host_gid: u32) -> (u32, u32) {
    // A host uid/gid of 0 means `appliance` is itself running as root;
    // pinning (0,0) would make the supposedly "non-root" guest user uid 0
    // and collapse the whole model. Fall back to the conventional
    // 1000/1000 then — a root-owned share's writability stays a manual
    // concern, but the guest user is never root.
    if mount && host_uid != 0 && host_gid != 0 {
        (host_uid, host_gid)
    } else {
        (1000, 1000)
    }
}

/// Dev-environment provisioning, substituted into `APPLIANCE_START`
/// (the `__DEV_PROVISION__` marker) only for VMs created with
/// `appliance vm dev`. Two halves:
///
///   • synchronous + fast — persistent `/persist/workspace` + home, an
///     apk cache symlinked onto the data disk, and a login profile that
///     gives every shell a stable HOME. Ready the instant the VM boots,
///     so `vm dev shell` always lands somewhere sane.
///   • backgrounded + slow — the apk toolchain install. Diskless Alpine
///     reinstalls these into the tmpfs root every boot, but the cache on
///     /persist makes the second boot onward fast and offline. Run in
///     the background so it never delays k3s readiness (what `vm up`
///     waits on); a `.dev-ready` marker records completion for
///     `vm dev status`.
pub(crate) const DEV_PROVISION: &str = r#"
echo "appliance-dev: provisioning development environment"
# HOME is /persist/workspace now (consolidated; the appliance user's
# passwd entry points there), so no separate /persist/home.
mkdir -p /persist/workspace /persist/apk-cache
# Persist apk's download cache on the data disk so reprovisioning each
# boot is fast and works offline once primed (the network repo is only
# hit the first time, or for packages added later).
ln -sfn /persist/apk-cache /etc/apk/cache
__DEV_MOUNT__
# Mark the dev environment and extend PATH. HOME is NOT exported here:
# the appliance user's passwd entry (HOME=/persist/workspace) is the one
# source of truth, and `su -l` derives HOME from it — re-exporting it
# would override the user's HOME and break /persist ownership.
mkdir -p /etc/profile.d
cat > /etc/profile.d/appliance-dev.sh <<'PROFILE'
export APPLIANCE_DEV=1
export PATH="__AGENT_BIN_PATH__/persist/npm-global/bin:$PATH"
PROFILE
# Install the toolchain in the background: first boot pulls from the
# network (slow), later boots hit the persistent cache (fast/offline).
# Backgrounded so the kubeconfig handoff — and `vm dev up` — never wait
# on apk.
(
  rm -f /persist/.dev-ready
  apk update --no-progress >/dev/null 2>&1 || true
  if apk add --no-progress \
      bash bash-completion git git-lfs curl wget vim nano less htop \
      jq ripgrep tar gzip coreutils findutils grep sed gawk procps \
      openssh-client ca-certificates build-base python3 py3-pip nodejs npm; then
    echo "appliance-dev: toolchain ready"
    : > /persist/.dev-ready
  else
    echo "appliance-dev: toolchain install failed (will retry on next boot)"
  fi
) &
"#;

/// Substituted into the dev provisioning block (`__DEV_MOUNT__`) when a
/// host folder is shared in (`appliance vm dev up --mount`). Mounts the
/// VirtioFS `workspace` tag (declared by the VZ backend) over
/// /persist/workspace so host edits and in-VM work share one tree. The
/// tag literal must match `WORKSPACE_VIRTIOFS_TAG`.
const DEV_MOUNT: &str = r#"# Host folder shared in over virtiofs (appliance vm dev up --mount),
# mounted as the workspace so edits flow both ways. The data-disk
# workspace dir created above stays underneath, shadowed by the mount.
modprobe virtiofs 2>/dev/null || true
if mount -t virtiofs workspace /persist/workspace; then
  echo "appliance-dev: mounted shared host folder at /persist/workspace"
else
  echo "appliance-dev: WARNING virtiofs mount of the host folder failed"
fi"#;

/// In-guest Docker engine provisioning, substituted into
/// `APPLIANCE_START` (the `__DOCKER_PROVISION__` marker) only for VMs
/// created with the `docker` flag set. Mirrors `DEV_PROVISION`:
///
///   • the apk install is backgrounded so it never delays k3s readiness
///     (what `vm up` waits on) — first boot pulls `docker` +
///     `docker-cli-compose` from the network, later boots hit the
///     persistent /persist/apk-cache (fast + offline), identical to the
///     dev toolchain.
///   • dockerd runs as its own fully separate engine: `--data-root
///     /persist/docker` (images/volumes/its bundled containerd state all
///     survive vm stop/up on the data disk). It listens on the default
///     `/var/run/docker.sock` (so the in-guest `docker` CLI + scripts
///     work with no DOCKER_HOST) AND on `/persist/docker/docker.sock`
///     (the stable path the host-side vsock relay will bridge). k3s's
///     embedded containerd at /persist/k3s is never shared.
///   • dockerd's egress (registry pulls/builds) is policed cooperatively
///     by injecting HTTP(S)_PROXY/NO_PROXY pointed at the per-VM forward
///     proxy on the subnet gateway. This is NOT a hard boundary and does
///     NOT confine containers (a `docker run` can drop the env, use
///     --network host, or dial a raw IP) — see docs/sandbox.md §6.
///   • a `/persist/.docker-ready` marker records completion for status.
///
/// The gateway is derived at runtime from the guest's default route
/// (the host sits on the .1 of the vz NAT subnet) since the leased IP
/// isn't known when the boot media is built. `__EGRESS_PORT__` is the
/// per-VM egress proxy port, substituted from the spec at build time.
pub(crate) const DOCKER_PROVISION: &str = r#"
echo "appliance-docker: provisioning in-guest Docker engine"
mkdir -p /persist/docker /persist/apk-cache
# Share the persistent apk cache (DEV_PROVISION also points it here; the
# symlink is idempotent so either order is fine) so docker reinstalls
# from disk on later boots — fast and offline once primed.
ln -sfn /persist/apk-cache /etc/apk/cache
# Derive the egress proxy URL from the default-route gateway (host .1 of
# the vz NAT subnet) so dockerd's own pulls/builds flow through the
# per-VM forward proxy. Cooperative only — does NOT confine containers.
APPLIANCE_GW=$(ip route 2>/dev/null | awk '/^default/ {print $3; exit}')
if [ -n "$APPLIANCE_GW" ]; then
  APPLIANCE_DOCKER_PROXY="http://$APPLIANCE_GW:__EGRESS_PORT__"
else
  APPLIANCE_DOCKER_PROXY=""
fi
# Install + launch in the background: never blocks the k3s readiness gate
# (the kubeconfig handoff) that `vm up` waits on.
(
  rm -f /persist/.docker-ready
  apk update --no-progress >/dev/null 2>&1 || true
  # apk takes an exclusive DB lock. The boot-time world install and the
  # dev toolchain install (also backgrounded) may hold it when we fire,
  # so a single `apk add` loses the race with "Unable to lock database".
  # Retry until the lock frees instead of giving up until the next boot.
  i=0
  while :; do
    if apk add --no-progress docker docker-cli-compose; then
      echo "appliance-docker: docker package installed"
      # The `docker` group is created by the docker apk package, so add
      # the non-root appliance user to it now (the user-provisioning block
      # couldn't — the group didn't exist yet). This lets `appliance up` /
      # devcontainer exec reach root dockerd's socket (root:docker 0660)
      # without sudo. dockerd stays a root daemon. No daemon restart
      # needed: any fresh one-shot shell after .docker-ready picks up the
      # group membership from /etc/group.
      addgroup appliance docker 2>/dev/null || true
      # Egress env for dockerd's own traffic (registry pulls/builds). The
      # node-wide egress CA (trusted above via update-ca-certificates) lets
      # MITM'd TLS validate. NO_PROXY keeps daemon-local/bridge traffic and
      # the loopback off the proxy.
      if [ -n "$APPLIANCE_DOCKER_PROXY" ]; then
        export HTTP_PROXY="$APPLIANCE_DOCKER_PROXY"
        export HTTPS_PROXY="$APPLIANCE_DOCKER_PROXY"
        export NO_PROXY="localhost,127.0.0.1,::1,172.17.0.0/16,10.42.0.0/16,10.43.0.0/16"
      fi
      # Fully separate engine: own data-root, own bundled containerd, own
      # socket — k3s keeps its embedded containerd at /persist/k3s.
      dockerd \
        --data-root /persist/docker \
        -H unix:///var/run/docker.sock \
        -H unix:///persist/docker/docker.sock \
        >/var/log/appliance-docker.log 2>&1 &
      : > /persist/.docker-ready
      echo "appliance-docker: dockerd started on /persist/docker/docker.sock"
      break
    fi
    i=$((i + 1))
    if [ "$i" -ge 60 ]; then
      echo "appliance-docker: docker install failed after retries (will retry on next boot)"
      break
    fi
    sleep 5
  done
) &
"#;

/// In-guest BuildKit provisioning, substituted into `APPLIANCE_START`
/// (the `__BUILDKIT_PROVISION__` marker) on every k3s VM (agent-only
/// VMs get an empty block — they have no registry to push to). The
/// docker-free image build path: the host's `buildctl` dials the
/// forwarded gRPC port, buildkitd builds from the streamed context and
/// pushes straight to the in-VM registry.
///
/// Mirrors `DOCKER_PROVISION`'s shape:
///
///   • the apk install is backgrounded with the same DB-lock retry
///     loop — k3s readiness (what `vm up` waits on) never waits on
///     buildkitd; first boot installs from the network, later boots hit
///     the persistent /persist/apk-cache.
///   • the layer/cache root lives at /persist/buildkit, so rebuild
///     caching survives vm stop/up.
///   • pushes target `localhost:__REGISTRY_HOST_PORT__/<name>` — the
///     SAME ref pods pull through the containerd registries.yaml
///     mirror. Nothing in the guest listens on that port (host-side
///     forward only), so a guest-loopback socat alias bridges it to the
///     registry NodePort; one ref then works from the host CLI, from
///     buildkitd, and from the kubelet.
///   • a `/persist/.buildkit-ready` marker records completion.
pub(crate) const BUILDKIT_PROVISION: &str = r#"
echo "appliance-buildkit: provisioning in-guest BuildKit"
mkdir -p /persist/buildkit /persist/apk-cache /etc/buildkit /run/buildkit
# Shared persistent apk cache (same symlink DEV/DOCKER provisioning
# makes; idempotent in any order).
ln -sfn /persist/apk-cache /etc/apk/cache
cat > /etc/buildkit/buildkitd.toml <<BKTOML
root = "/persist/buildkit"
[registry."localhost:__REGISTRY_HOST_PORT__"]
  http = true
[registry."127.0.0.1:__REGISTRY_NODEPORT__"]
  http = true
BKTOML
# Install + launch in the background: never blocks the k3s readiness
# gate. Same apk DB-lock retry loop as the docker provision. socat is
# installed explicitly — the vz base world carries it (vsock shell
# agent) but the WSL bootstrap's base package set does not.
(
  rm -f /persist/.buildkit-ready
  apk update --no-progress >/dev/null 2>&1 || true
  i=0
  while :; do
    if apk add --no-progress buildkit buildctl runc socat; then
      # Guest-loopback alias for the registry ref: pushes address
      # localhost:__REGISTRY_HOST_PORT__ (the host-forwarded port,
      # which has no guest listener) and land on the registry
      # NodePort. Forks per connection, so starting before the
      # registry itself is up is fine.
      socat TCP-LISTEN:__REGISTRY_HOST_PORT__,bind=127.0.0.1,reuseaddr,fork \
        TCP:127.0.0.1:__REGISTRY_NODEPORT__ \
        >/var/log/appliance-registry-alias.log 2>&1 &
      buildkitd \
        --config /etc/buildkit/buildkitd.toml \
        --addr unix:///run/buildkit/buildkitd.sock \
        --addr tcp://0.0.0.0:__BUILDKITD_GUEST_PORT__ \
        >/var/log/appliance-buildkit.log 2>&1 &
      : > /persist/.buildkit-ready
      echo "appliance-buildkit: buildkitd listening on :__BUILDKITD_GUEST_PORT__"
      break
    fi
    i=$((i + 1))
    if [ "$i" -ge 60 ]; then
      echo "appliance-buildkit: buildkit install failed after retries (will retry on next boot)"
      break
    fi
    sleep 5
  done
) &
"#;

/// The vz half of the api-server provisioning: copy the binary (and
/// optional console bundle) off the FAT boot media, exactly like
/// `K3S_MEDIA_COPY`. Prepended to the shared `APISERVER_COMMON`; the
/// WSL2 backend swaps in its own drvfs copy preamble instead.
const APISERVER_MEDIA_COPY: &str = r#"# --- appliance api-server ---------------------------------------------
# The control plane runs as a plain guest binary — no image delivery,
# no docker anywhere. The binary, console, and signed release evidence
# ride the FAT boot media. The shared api-server seed gate verifies before copying.
mkdir -p /persist/appliance
APISERVER_MEDIA_PATH=$(find /media -maxdepth 2 -name appliance-api-server 2>/dev/null | head -1)
APISERVER_MEDIA=
[ -z "$APISERVER_MEDIA_PATH" ] || APISERVER_MEDIA=$(dirname "$APISERVER_MEDIA_PATH")
APISERVER_SRC="$APISERVER_MEDIA/appliance-api-server"
CONSOLE_SRC="$APISERVER_MEDIA/appliance-console.tar.gz"
RELEASE_CHECKSUMS="$APISERVER_MEDIA/appliance-api-server.sha256"
RELEASE_PROPERTIES="$APISERVER_MEDIA/control-plane-release.properties"
RELEASE_PAYLOAD="$APISERVER_MEDIA/control-plane-release.json"
RELEASE_ENVELOPE="$APISERVER_MEDIA/control-plane-release.sig.json"
RELEASE_POISON="$APISERVER_MEDIA/control-plane-release.invalid"
"#;

/// Backend-neutral MV0 seed gate. The host already verified the Ed25519
/// envelope; the minimal Alpine guest deliberately does not carry a second
/// Ed25519 implementation in MV0. It independently binds both exact sizes and
/// SHA-256 digests to the verified payload copied beside the seed.
const APISERVER_SEED_COPY_TEMPLATE: &str = r#"APPLIANCE_WARNINGS_FILE=${APPLIANCE_WARNINGS_FILE:-/var/log/appliance-api-server.warnings}
APPLIANCE_SEED_LOG=${APPLIANCE_SEED_LOG:-/var/log/appliance-api-server.log}
APPLIANCE_SEED_MARKER=${APPLIANCE_SEED_MARKER:-/persist/.apiserver-seed-warning}
APISERVER_DEST=${APISERVER_DEST:-/usr/local/bin/appliance-api-server}
CONSOLE_DEST=${CONSOLE_DEST:-/persist/appliance/console}
rm -f "$APPLIANCE_SEED_MARKER"
seed_warning() {
  MSG="$1"
  echo "appliance-api-server: SECURITY: $MSG" | tee -a "$APPLIANCE_SEED_LOG" >&2
  echo "$MSG" >> "$APPLIANCE_WARNINGS_FILE"
  echo "$MSG" >> "$APPLIANCE_SEED_MARKER"
}
if [ -z "${APISERVER_MEDIA:-}" ]; then
  seed_warning "boot media not found"
elif [ -f "$RELEASE_CHECKSUMS" ] || [ -f "$RELEASE_PROPERTIES" ] || [ -f "$RELEASE_PAYLOAD" ] || [ -f "$RELEASE_ENVELOPE" ] || [ -f "$RELEASE_POISON" ]; then
  SEED_OK=1
  if [ -f "$RELEASE_POISON" ] || [ ! -f "$RELEASE_CHECKSUMS" ] || [ ! -f "$RELEASE_PROPERTIES" ] || [ ! -f "$RELEASE_PAYLOAD" ] || [ ! -f "$RELEASE_ENVELOPE" ]; then
    seed_warning "signed control-plane seed evidence is incomplete or malformed; api-server start refused"
    SEED_OK=0
  fi
  case "$(uname -m)" in
    x86_64) RELEASE_ARCH=x64 ;;
    aarch64|arm64) RELEASE_ARCH=arm64 ;;
    *) RELEASE_ARCH=unsupported ;;
  esac
__APISERVER_SEED_VERIFY__
  if [ -n "${SEED_ERROR:-}" ]; then
    seed_warning "$SEED_ERROR"
  fi
  if [ "$SEED_OK" = 1 ]; then
    cp "$APISERVER_SRC" "$APISERVER_DEST"
    chmod +x "$APISERVER_DEST"
    if [ -f "$CONSOLE_SRC" ]; then
      EXPECTED_CONSOLE_SHA=$(awk '$2 == "appliance-console.tar.gz" { print $1; exit }' "$RELEASE_CHECKSUMS" 2>/dev/null)
      EXPECTED_CONSOLE_SIZE=$(awk '$2 == "appliance-console.tar.gz" { print $3; exit }' "$RELEASE_CHECKSUMS" 2>/dev/null)
      ACTUAL_CONSOLE_SHA=$(sha256sum "$CONSOLE_SRC" 2>/dev/null | cut -d ' ' -f 1)
      ACTUAL_CONSOLE_SIZE=$(wc -c < "$CONSOLE_SRC" 2>/dev/null | awk '{print $1}')
      if [ "$EXPECTED_CONSOLE_SHA" != "$ACTUAL_CONSOLE_SHA" ] || [ "$EXPECTED_CONSOLE_SIZE" != "$ACTUAL_CONSOLE_SIZE" ]; then
        seed_warning "signed console bundle digest/size mismatch; console skipped (api-server remains headless)"
      else
        rm -rf "$CONSOLE_DEST.new"
        mkdir -p "$CONSOLE_DEST.new"
        if tar -xzf "$CONSOLE_SRC" -C "$CONSOLE_DEST.new" 2>/dev/null; then
          rm -rf "$CONSOLE_DEST"
          mv "$CONSOLE_DEST.new" "$CONSOLE_DEST"
        else
          seed_warning "signed console bundle extraction failed; console skipped (api-server remains headless)"
          rm -rf "$CONSOLE_DEST.new"
        fi
      fi
    fi
    # First-install only: persistent current always wins over stale media.
    if [ -n "${CONTROL_PLANE_ROOT:-}" ] && [ ! -e "$CONTROL_PLANE_ROOT/current" ] && [ ! -L "$CONTROL_PLANE_ROOT/current" ]; then
      case "$RELEASE_VERSION" in
        ''|*[!0-9A-Za-z._+-]*) seed_warning "invalid signed release version; persistent seed refused" ;;
        *)
          SEED_SHA12=$(printf '%s' "$EXPECTED_BINARY_SHA" | cut -c1-12)
          SEED_TARGET="releases/$RELEASE_VERSION-$SEED_SHA12"
          SEED_RELEASE="$CONTROL_PLANE_ROOT/$SEED_TARGET"
          rm -rf "$SEED_RELEASE.seed"
          mkdir -p "$SEED_RELEASE.seed"
          cp "$APISERVER_DEST" "$SEED_RELEASE.seed/binary"
          chmod 0500 "$SEED_RELEASE.seed/binary"
          cp "$RELEASE_CHECKSUMS" "$SEED_RELEASE.seed/appliance-api-server.sha256"
          cp "$RELEASE_PROPERTIES" "$SEED_RELEASE.seed/control-plane-release.properties"
          cp "$RELEASE_PAYLOAD" "$SEED_RELEASE.seed/control-plane-release.json"
          cp "$RELEASE_ENVELOPE" "$SEED_RELEASE.seed/control-plane-release.sig.json"
          if [ -f "$CONSOLE_SRC" ]; then cp "$CONSOLE_SRC" "$SEED_RELEASE.seed/console.tar.gz"; fi
          if [ -d "$CONSOLE_DEST" ]; then cp -R "$CONSOLE_DEST" "$SEED_RELEASE.seed/console"; fi
          chmod -R go-rwx "$SEED_RELEASE.seed"
          if [ ! -d "$SEED_RELEASE" ]; then mv "$SEED_RELEASE.seed" "$SEED_RELEASE"; else rm -rf "$SEED_RELEASE.seed"; fi
          printf '%s\n' "$SEED_TARGET" > "$CONTROL_PLANE_ROOT/current.new"
          mv -f "$CONTROL_PLANE_ROOT/current.new" "$CONTROL_PLANE_ROOT/current"
          SEED_GENERATION=0
          if [ -f "$CONTROL_PLANE_ROOT/generation" ] && [ ! -L "$CONTROL_PLANE_ROOT/generation" ]; then
            SEED_GENERATION=$(cat "$CONTROL_PLANE_ROOT/generation" 2>/dev/null || printf '0')
          fi
          case "$SEED_GENERATION" in ''|*[!0-9]*) SEED_GENERATION=0;; esac
          if [ "$RELEASE_GENERATION" -gt "$SEED_GENERATION" ]; then SEED_GENERATION=$RELEASE_GENERATION; fi
          printf '%s\n' "$SEED_GENERATION" > "$CONTROL_PLANE_ROOT/generation.new"
          mv -f "$CONTROL_PLANE_ROOT/generation.new" "$CONTROL_PLANE_ROOT/generation"
          ;;
      esac
    fi
  else
    rm -f "$APISERVER_DEST"
  fi
elif [ -f "$APISERVER_SRC" ]; then
  # Pre-AP-226 releases and explicitly acknowledged development overrides.
  seed_warning "unsigned pre-MV0 control-plane seed accepted; self-update disabled"
  cp "$APISERVER_SRC" "$APISERVER_DEST"
  chmod +x "$APISERVER_DEST"
  if [ -f "$CONSOLE_SRC" ]; then
    rm -rf "$CONSOLE_DEST.new"
    mkdir -p "$CONSOLE_DEST.new"
    if tar -xzf "$CONSOLE_SRC" -C "$CONSOLE_DEST.new" 2>/dev/null; then
      rm -rf "$CONSOLE_DEST"
      mv "$CONSOLE_DEST.new" "$CONSOLE_DEST"
    else
      echo "appliance-api-server: console bundle extraction failed (API still serves)"
      rm -rf "$CONSOLE_DEST.new"
    fi
  fi
fi
"#;

/// Verification-only portion of the seed gate. Keep this restricted to
/// POSIX shell builtins plus the BusyBox-compatible applets exercised by the
/// host-side portability test; the production guest world does not include
/// jq.
pub(crate) const APISERVER_SEED_VERIFY: &str = r#"  EXPECTED_BINARY_SHA=$(awk '$2 == "appliance-api-server" { print $1; exit }' "$RELEASE_CHECKSUMS" 2>/dev/null)
  EXPECTED_BINARY_SIZE=$(awk '$2 == "appliance-api-server" { print $3; exit }' "$RELEASE_CHECKSUMS" 2>/dev/null)
  ACTUAL_BINARY_SHA=$(sha256sum "$APISERVER_SRC" 2>/dev/null | cut -d ' ' -f 1)
  ACTUAL_BINARY_SIZE=$(wc -c < "$APISERVER_SRC" 2>/dev/null | awk '{print $1}')
  RELEASE_KEY_ID=$(awk -F= '$1 == "keyId" { print $2; exit }' "$RELEASE_PROPERTIES" 2>/dev/null)
  RELEASE_VERSION=$(awk -F= '$1 == "version" { print $2; exit }' "$RELEASE_PROPERTIES" 2>/dev/null)
  RELEASE_GENERATION=$(awk -F= '$1 == "generation" { print $2; exit }' "$RELEASE_PROPERTIES" 2>/dev/null)
  SIDECAR_ARCH=$(awk -F= '$1 == "arch" { print $2; exit }' "$RELEASE_PROPERTIES" 2>/dev/null)
  if [ -z "$RELEASE_KEY_ID" ] || [ "$RELEASE_KEY_ID" != "__PINNED_RELEASE_KEY_ID__" ] || [ -z "$RELEASE_VERSION" ] || [ -z "$RELEASE_GENERATION" ] || [ "$SIDECAR_ARCH" != "$RELEASE_ARCH" ] || [ -z "$EXPECTED_BINARY_SHA" ] || [ -z "$ACTUAL_BINARY_SHA" ] || [ "$EXPECTED_BINARY_SHA" != "$ACTUAL_BINARY_SHA" ] || [ "$EXPECTED_BINARY_SIZE" != "$ACTUAL_BINARY_SIZE" ]; then
    SEED_ERROR="signed control-plane seed digest/size mismatch; api-server start refused"
    SEED_OK=0
  fi
"#;

/// Compose the complete backend-neutral seed copy block from the portable
/// verification fragment. Keeping this separate lets backend tests inspect
/// only the seed path rather than unrelated launcher sections that use jq.
pub(crate) fn apiserver_seed_copy() -> String {
    APISERVER_SEED_COPY_TEMPLATE.replace("__APISERVER_SEED_VERIFY__", APISERVER_SEED_VERIFY)
}

pub(crate) const CONTROL_PLANE_UPDATE: &str = r#"#!/bin/sh
set -eu
ROOT=${CONTROL_PLANE_ROOT:-/var/lib/appliance-control-plane}
INCOMING="$ROOT/incoming"
RUN=${APPLIANCE_CONTROL_PLANE_RUN:-/run/appliance/control-plane}
fail() { echo "control-plane update refused: $*" >&2; exit 1; }
evidence_fail() {
  printf '%s\n' "$*" > "$ROOT/control-plane-release.invalid.new"
  mv -f "$ROOT/control-plane-release.invalid.new" "$ROOT/control-plane-release.invalid"
  fail "$*"
}
CAPABILITY=${APPLIANCE_CONTROL_PLANE_CAPABILITY:-/run/appliance/capabilities/control-plane-update-v1}
[ -f "$CAPABILITY" ] || fail "launcher capability missing"
read_pointer() {
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  POINTER=$(cat "$1" 2>/dev/null) || return 1
  case "$POINTER" in releases/*) LEAF=${POINTER#releases/};; *) return 1;; esac
  case "$LEAF" in ''|.|..|*/*|*[!0-9A-Za-z._+-]*) return 1;; esac
  [ "$POINTER" = "releases/$LEAF" ] || return 1
  printf '%s\n' "$POINTER"
}
CURRENT=$(read_pointer "$ROOT/current" 2>/dev/null || true)
PREVIOUS=$(read_pointer "$ROOT/previous" 2>/dev/null || true)
PENDING=$(read_pointer "$ROOT/pending" 2>/dev/null || true)
for DIR in "$ROOT"/releases/*; do
  [ -d "$DIR" ] || continue
  REL="releases/${DIR##*/}"
  [ "$REL" = "$CURRENT" ] || [ "$REL" = "$PREVIOUS" ] || [ "$REL" = "$PENDING" ] || rm -rf "$DIR"
done
NEW="$ROOT/releases/.candidate.$$"
rm -rf "$NEW"
mkdir -p "$NEW"
trap 'rm -rf "$NEW"' EXIT HUP INT TERM
for NAME in binary console.tar.gz appliance-api-server.sha256 control-plane-release.properties control-plane-release.json control-plane-release.sig.json; do
  [ ! -L "$INCOMING/$NAME" ] || fail "$NAME may not be a symlink"
  [ ! -f "$INCOMING/$NAME" ] || cp "$INCOMING/$NAME" "$NEW/$NAME"
done
find "$INCOMING" -mindepth 1 -delete
PROPERTIES="$NEW/control-plane-release.properties"
CHECKSUMS="$NEW/appliance-api-server.sha256"
PAYLOAD="$NEW/control-plane-release.json"
[ -f "$PROPERTIES" ] && [ -f "$CHECKSUMS" ] && [ -f "$PAYLOAD" ] && [ -f "$NEW/binary" ] || fail "incomplete artifact set"
KEY_ID=$(awk -F= '$1 == "keyId" { print $2; exit }' "$PROPERTIES")
VERSION=$(awk -F= '$1 == "version" { print $2; exit }' "$PROPERTIES")
GENERATION=$(awk -F= '$1 == "generation" { print $2; exit }' "$PROPERTIES")
ARCH=$(awk -F= '$1 == "arch" { print $2; exit }' "$PROPERTIES")
[ -n "$KEY_ID" ] && [ "$KEY_ID" = '__PINNED_RELEASE_KEY_ID__' ] || fail "release keyId is not pinned"
case "$VERSION" in ''|*[!0-9A-Za-z._+-]*) fail "invalid release version";; esac
case "$GENERATION" in ''|*[!0-9]*) fail "invalid release generation";; esac
case "$(uname -m)" in x86_64) EXPECTED_ARCH=x64;; aarch64|arm64) EXPECTED_ARCH=arm64;; *) EXPECTED_ARCH=unsupported;; esac
[ "$ARCH" = "$EXPECTED_ARCH" ] || fail "release architecture mismatch"
PAYLOAD_VERSION=$(awk -F'"version"[[:space:]]*:[[:space:]]*"' 'NF > 1 { split($2, value, "\""); print value[1]; exit }' "$PAYLOAD")
PAYLOAD_GENERATION=$(awk -F'"generation"[[:space:]]*:[[:space:]]*' 'NF > 1 { value=$2; sub(/[^0-9].*/, "", value); print value; exit }' "$PAYLOAD")
PAYLOAD_BINARY_SHA=$(tr '}' '\n' < "$PAYLOAD" | awk -v name="appliance-api-server-linux-$ARCH" '$0 ~ "\"name\"[[:space:]]*:[[:space:]]*\"" name "\"" { value=$0; sub(/^.*\"sha256\"[[:space:]]*:[[:space:]]*\"/, "", value); sub(/\".*$/, "", value); print value; exit }')
CHECKSUM_BINARY_SHA=$(awk '$2 == "appliance-api-server" { print $1; exit }' "$CHECKSUMS")
[ "$PAYLOAD_VERSION" = "$VERSION" ] && [ "$PAYLOAD_GENERATION" = "$GENERATION" ] && [ -n "$PAYLOAD_BINARY_SHA" ] && [ "$PAYLOAD_BINARY_SHA" = "$CHECKSUM_BINARY_SHA" ] || evidence_fail "signed release evidence mismatch"
rm -f "$ROOT/control-plane-release.invalid"
SHA12=$(printf '%s' "$CHECKSUM_BINARY_SHA" | cut -c1-12)
TARGET="releases/$VERSION-$SHA12"
PROMOTED_GENERATION=0
if [ -f "$ROOT/generation" ]; then
  [ ! -L "$ROOT/generation" ] || fail "persisted release generation may not be a symlink"
  PROMOTED_GENERATION=$(cat "$ROOT/generation" 2>/dev/null || fail "persisted release generation unreadable")
fi
case "$PROMOTED_GENERATION" in ''|*[!0-9]*) fail "invalid persisted release generation";; esac
if [ "$TARGET" = "$CURRENT" ]; then
  [ "$GENERATION" -ge "$PROMOTED_GENERATION" ] || fail "release generation downgrade"
else
  [ "$GENERATION" -gt "$PROMOTED_GENERATION" ] || fail "release generation must advance for new content"
fi
verify_artifact() {
  FILE=$1 NAME=$2 REQUIRED=$3
  EXPECTED_SHA=$(awk -v name="$NAME" '$2 == name { print $1; exit }' "$CHECKSUMS")
  EXPECTED_SIZE=$(awk -v name="$NAME" '$2 == name { print $3; exit }' "$CHECKSUMS")
  if [ ! -f "$FILE" ]; then [ "$REQUIRED" = 0 ] && return 0; fail "$NAME missing"; fi
  [ -n "$EXPECTED_SHA" ] && [ -n "$EXPECTED_SIZE" ] || fail "$NAME signed checksum missing"
  ACTUAL_SIZE=$(wc -c < "$FILE" | tr -d '[:space:]')
  [ "$ACTUAL_SIZE" = "$EXPECTED_SIZE" ] || fail "$NAME size mismatch"
  printf '%s  %s\n' "$EXPECTED_SHA" "$FILE" | sha256sum -c >/dev/null || fail "$NAME sha256 mismatch"
}
verify_artifact "$NEW/binary" appliance-api-server 1
verify_artifact "$NEW/console.tar.gz" appliance-console.tar.gz 0
chmod 0500 "$NEW/binary"
if [ -f "$NEW/console.tar.gz" ]; then
  mkdir -p "$NEW/console"
  if ! tar -xzf "$NEW/console.tar.gz" -C "$NEW/console" 2>/dev/null; then
    echo "control-plane update: signed console extraction failed; candidate will run headless" >&2
    rm -rf "$NEW/console"
  fi
fi
chmod -R go-rwx "$NEW"
EXPECTED_SHA=$(awk '$2 == "appliance-api-server" { print $1; exit }' "$CHECKSUMS")
RELEASE="$ROOT/$TARGET"
if [ -d "$RELEASE" ]; then
  [ -f "$RELEASE/binary" ] && [ ! -L "$RELEASE/binary" ] || fail "existing release content collision"
  EXISTING_SIZE=$(wc -c < "$RELEASE/binary" 2>/dev/null | tr -d '[:space:]')
  EXISTING_SHA=$(sha256sum "$RELEASE/binary" 2>/dev/null | awk '{print $1}')
  NEW_SIZE=$(wc -c < "$NEW/binary" | tr -d '[:space:]')
  [ "$EXISTING_SIZE" = "$NEW_SIZE" ] && [ "$EXISTING_SHA" = "$EXPECTED_SHA" ] || fail "existing release content collision"
  rm -rf "$NEW"
else
  mv "$NEW" "$RELEASE"
fi
trap - EXIT HUP INT TERM
if [ "$CURRENT" = "$TARGET" ]; then
  printf '%s\n' "$GENERATION" > "$ROOT/generation.new"
  mv -f "$ROOT/generation.new" "$ROOT/generation"
  echo "already at $VERSION"
  exit 0
fi
printf '%s\n' "$TARGET" > "$ROOT/pending.new"
mv -f "$ROOT/pending.new" "$ROOT/pending"
mkdir -p "$RUN"
rm -f "$RUN/outcome"
printf '%s\n' "$VERSION" > "$RUN/request.new"
mv -f "$RUN/request.new" "$RUN/request"
if [ -s "$RUN/server.pid" ]; then kill "$(cat "$RUN/server.pid")" 2>/dev/null || true; fi
for _ in $(seq 1 30); do
  if [ -s "$RUN/outcome" ]; then cat "$RUN/outcome"; exit 0; fi
  sleep 5
done
fail "supervisor outcome timed out"
"#;

pub(crate) const CONTROL_PLANE_SUPERVISOR: &str = r#"#!/bin/sh
set -u
ROOT=${CONTROL_PLANE_ROOT:-/var/lib/appliance-control-plane}
RUN=${APPLIANCE_CONTROL_PLANE_RUN:-/run/appliance/control-plane}
LOG=${APPLIANCE_CONTROL_PLANE_LOG:-/var/log/appliance-api-server.log}
PORT=${PORT:-9091}
FD_ROOT=${APPLIANCE_FD_ROOT:-/proc/self/fd}
mkdir -p "$RUN"
write_outcome() { printf '%s\n' "$*" > "$RUN/outcome.new"; mv -f "$RUN/outcome.new" "$RUN/outcome"; }
read_pointer() {
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  POINTER=$(cat "$1" 2>/dev/null) || return 1
  case "$POINTER" in releases/*) LEAF=${POINTER#releases/};; *) return 1;; esac
  case "$LEAF" in ''|.|..|*/*|*[!0-9A-Za-z._+-]*) return 1;; esac
  [ "$POINTER" = "releases/$LEAF" ] || return 1
  printf '%s\n' "$POINTER"
}
write_pointer() { printf '%s\n' "$2" > "$1.new"; mv -f "$1.new" "$1"; }
restore_previous() {
  REJECTED=${1:-}
  PREVIOUS_TARGET=$(read_pointer "$ROOT/previous" 2>/dev/null || true)
  if [ -n "$PREVIOUS_TARGET" ] && [ "$PREVIOUS_TARGET" != "$REJECTED" ] && [ -d "$ROOT/$PREVIOUS_TARGET" ]; then
    write_pointer "$ROOT/current" "$PREVIOUS_TARGET"
    rm -f "$ROOT/previous"
    echo "appliance-api-server: restored previous release $PREVIOUS_TARGET" >> "$LOG"
    return 0
  fi
  rm -f "$ROOT/previous"
  return 1
}
launch_legacy() {
  echo "appliance-api-server: persistent release unavailable — respawning legacy seed" >> "$LOG"
  if [ "${APPLIANCE_TEST_ONCE:-0}" = 1 ]; then return 0; fi
  /usr/local/bin/appliance-api-server >> "$LOG" 2>&1
  sleep 2
}
remove_unreferenced_release() {
  REJECTED=$1
  [ -n "$REJECTED" ] || return 0
  CURRENT_TARGET=$(read_pointer "$ROOT/current" 2>/dev/null || true)
  PREVIOUS_TARGET=$(read_pointer "$ROOT/previous" 2>/dev/null || true)
  [ "$REJECTED" = "$CURRENT_TARGET" ] || [ "$REJECTED" = "$PREVIOUS_TARGET" ] || rm -rf "$ROOT/$REJECTED"
}
rollback_pending() {
  VERSION=$1 REASON=$2
  REJECTED=$(read_pointer "$ROOT/pending" 2>/dev/null || true)
  rm -f "$ROOT/pending"
  remove_unreferenced_release "$REJECTED"
  write_outcome "rollback $VERSION $REASON"
  echo "appliance-api-server: candidate $VERSION rolled back ($REASON)" >> "$LOG"
}
while :; do
  MODE=current
  TARGET=$(read_pointer "$ROOT/current" 2>/dev/null || true)
  PENDING_TARGET=$(read_pointer "$ROOT/pending" 2>/dev/null || true)
  if [ -n "$PENDING_TARGET" ]; then MODE=pending; TARGET=$PENDING_TARGET; fi
  if [ -z "$TARGET" ]; then
    rm -f "$ROOT/current"
    if restore_previous ""; then continue; fi
    launch_legacy
    [ "${APPLIANCE_TEST_ONCE:-0}" = 1 ] && exit 0
    continue
  fi
  RELEASE="$ROOT/$TARGET"
  PROPERTIES="$RELEASE/control-plane-release.properties"
  CHECKSUMS="$RELEASE/appliance-api-server.sha256"
  VERSION=$(awk -F= '$1 == "version" { print $2; exit }' "$PROPERTIES" 2>/dev/null)
  EXPECTED_SHA=$(awk '$2 == "appliance-api-server" { print $1; exit }' "$CHECKSUMS" 2>/dev/null)
  BINARY="$RELEASE/binary"
  if [ -z "$VERSION" ] || [ -z "$EXPECTED_SHA" ] || [ ! -f "$BINARY" ] || [ -L "$BINARY" ]; then
    if [ "$MODE" = pending ]; then
      rollback_pending "${VERSION:-unknown}" invalid-release
    else
      rm -f "$ROOT/current"
      remove_unreferenced_release "$TARGET"
      if ! restore_previous "$TARGET"; then launch_legacy; fi
    fi
    [ "${APPLIANCE_TEST_ONCE:-0}" = 1 ] && exit 0
    [ "$MODE" = pending ] || sleep 2
    continue
  fi
  if ! exec 9< "$BINARY"; then
    if [ "$MODE" = pending ]; then rollback_pending "$VERSION" open-failed; else rm -f "$ROOT/current"; remove_unreferenced_release "$TARGET"; restore_previous "$TARGET" || launch_legacy; fi
    [ "${APPLIANCE_TEST_ONCE:-0}" = 1 ] && exit 0
    [ "$MODE" = pending ] || sleep 2
    continue
  fi
  ACTUAL_SHA=$(sha256sum "$FD_ROOT/9" 2>/dev/null | awk '{print $1}')
  if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
    exec 9<&-
    if [ "$MODE" = pending ]; then rollback_pending "$VERSION" bad-hash; else rm -f "$ROOT/current"; remove_unreferenced_release "$TARGET"; restore_previous "$TARGET" || launch_legacy; fi
    [ "${APPLIANCE_TEST_ONCE:-0}" = 1 ] && exit 0
    sleep 2
    continue
  fi
  if [ -d "$RELEASE/console" ]; then export APPLIANCE_CONSOLE_DIR="$RELEASE/console"; else unset APPLIANCE_CONSOLE_DIR; fi
  echo "appliance-api-server: launching $VERSION from held fd" >> "$LOG"
  if [ -n "${APPLIANCE_EXEC_PREFIX:-}" ]; then
    $APPLIANCE_EXEC_PREFIX "$FD_ROOT/9" >> "$LOG" 2>&1 &
  else
    "$FD_ROOT/9" >> "$LOG" 2>&1 &
  fi
  PID=$!
  printf '%s\n' "$PID" > "$RUN/server.pid"
  if [ "$MODE" = pending ]; then
    HEALTHY=0
    REASON=health-timeout
    for _ in $(seq 1 24); do
      sleep 5
      if ! kill -0 "$PID" 2>/dev/null; then REASON=crash; break; fi
      STATUS=$(wget -qO- "http://127.0.0.1:$PORT/bootstrap/status" 2>/dev/null | tr -d '[:space:]')
      if printf '%s' "$STATUS" | grep -F '"initialized":true' >/dev/null && { printf '%s' "$STATUS" | grep -F "\"serverVersion\":\"$VERSION\"" >/dev/null || printf '%s' "$STATUS" | grep -F "\"serverVersion\":\"v$VERSION\"" >/dev/null; }; then
        HEALTHY=1
        break
      fi
      if printf '%s' "$STATUS" | grep -F '"initialized":true' >/dev/null; then REASON=wrong-version; fi
    done
    if [ "$HEALTHY" = 1 ]; then
      OLD=$(read_pointer "$ROOT/current" 2>/dev/null || true)
      if [ -n "$OLD" ]; then write_pointer "$ROOT/previous" "$OLD"; fi
      write_pointer "$ROOT/current" "$TARGET"
      rm -f "$ROOT/pending"
      GENERATION=$(awk -F= '$1 == "generation" { print $2; exit }' "$PROPERTIES" 2>/dev/null)
      printf '%s\n' "$GENERATION" > "$ROOT/generation.new"
      mv -f "$ROOT/generation.new" "$ROOT/generation"
      write_outcome "success $VERSION"
      echo "appliance-api-server: promoted $VERSION" >> "$LOG"
      if [ "${APPLIANCE_TEST_ONCE:-0}" = 1 ]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; exit 0; fi
    else
      kill "$PID" 2>/dev/null || true
      wait "$PID" 2>/dev/null || true
      exec 9<&-
      rollback_pending "$VERSION" "$REASON"
      [ "${APPLIANCE_TEST_ONCE:-0}" = 1 ] && exit 0
      sleep 2
      continue
    fi
  fi
  wait "$PID" 2>/dev/null || true
  exec 9<&-
  echo "appliance-api-server: exited — respawning in 2s" >> "$LOG"
  sleep 2
done
"#;

/// The backend-neutral half of the api-server provisioning: assumes
/// `/usr/local/bin/appliance-api-server` and `/etc/appliance/bootstrap-token`
/// are in place and `$PERSIST` is mounted. Routes
/// `api.appliance.localhost` through traefik to the guest binary via a
/// selector-less Service + Endpoints (no new host forward — saved
/// profile URLs keep working), provisions the server's OWN
/// ServiceAccount + non-expiring token via the same auto-applied
/// manifest, retires the legacy in-cluster api-server, and supervises
/// the binary with a plain respawn loop. Reused verbatim by the WSL2
/// backend.
///
/// Why token auth (not the admin kubeconfig): the binary is
/// bun-compiled, and bun's fetch ignores the custom https agent
/// `@kubernetes/client-node` uses to carry client certificates — so
/// kubeconfig client-cert auth can never authenticate. A bearer token
/// rides a plain Authorization header (which fetch handles), and the
/// k3s server CA is trusted process-wide via NODE_EXTRA_CA_CERTS.
pub(crate) const APISERVER_COMMON: &str = r#"
mkdir -p /persist/appliance /persist/appliance-data
if [ -x /usr/local/bin/appliance-api-server ]; then
  # Route http://api.appliance.localhost:<hostPort> (the URL every saved
  # profile already uses) through traefik to the guest binary: a
  # selector-less Service + manual Endpoints at the guest's own address.
  # Rewritten every boot — the guest address can change across boots.
  # The same manifest provisions the api-server's ServiceAccount +
  # cluster-admin binding + non-expiring token Secret.
  GUEST_IP=$(ip -4 -o addr show eth0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)
  [ -n "$GUEST_IP" ] || GUEST_IP=127.0.0.1
  mkdir -p "$PERSIST/k3s/server/manifests"
  cat > "$PERSIST/k3s/server/manifests/appliance-api-server.yaml" <<APIMANIFEST
apiVersion: v1
kind: Service
metadata:
  name: appliance-api-server
  namespace: default
spec:
  ports:
  - port: 80
    targetPort: __APISERVER_GUEST_PORT__
---
apiVersion: v1
kind: Endpoints
metadata:
  name: appliance-api-server
  namespace: default
subsets:
- addresses:
  - ip: $GUEST_IP
  ports:
  - port: __APISERVER_GUEST_PORT__
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: appliance-api-server
  namespace: default
spec:
  ingressClassName: traefik
  rules:
  - host: api.appliance.localhost
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: appliance-api-server
            port:
              number: 80
---
apiVersion: v1
kind: Namespace
metadata:
  name: kube-system
  labels:
    appliance.sh/control-plane: "true"
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: appliance-api-server
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  # NOT the bare name: the legacy in-cluster deployment used that name
  # with a different (immutable) roleRef, which would block this apply
  # forever on upgraded VMs. (No backticks here — this is an unquoted
  # heredoc, where a backtick pair runs the api-server as a command.)
  name: appliance-api-server-admin
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
- kind: ServiceAccount
  name: appliance-api-server
  namespace: kube-system
---
apiVersion: v1
kind: Secret
metadata:
  name: appliance-api-server-token
  namespace: kube-system
  annotations:
    kubernetes.io/service-account.name: appliance-api-server
type: kubernetes.io/service-account-token
---
apiVersion: v1
kind: Namespace
metadata:
  name: appliance
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: latest
    appliance.sh/workload-namespace: "true"
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: appliance-workloads-no-hostpath
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
    - apiGroups: [""]
      apiVersions: ["v1"]
      operations: ["CREATE", "UPDATE"]
      resources: ["pods"]
  validations:
  - expression: "!has(object.spec.volumes) || object.spec.volumes.all(v, !has(v.hostPath))"
    message: "hostPath volumes are forbidden in Appliance workload namespaces"
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: appliance-workloads-no-hostpath
spec:
  policyName: appliance-workloads-no-hostpath
  validationActions: [Deny]
  matchResources:
    namespaceSelector:
      matchExpressions:
      - key: appliance.sh/control-plane
        operator: DoesNotExist
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata:
  name: appliance-control-plane-volume-isolation
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
    - apiGroups: [""]
      apiVersions: ["v1"]
      operations: ["CREATE", "UPDATE"]
      resources: ["pods"]
  validations:
  - expression: "!has(object.spec.volumes) || object.spec.volumes.all(v, !has(v.hostPath) || (v.hostPath.path != '/var/lib/appliance-control-plane' && !v.hostPath.path.startsWith('/var/lib/appliance-control-plane/') && !'/var/lib/appliance-control-plane'.startsWith(v.hostPath.path + '/') && v.hostPath.path != '/'))"
    message: "the Appliance control-plane volume is not available to pods"
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata:
  name: appliance-control-plane-volume-isolation
spec:
  policyName: appliance-control-plane-volume-isolation
  validationActions: [Deny]
APIMANIFEST
  # Launcher: wait for k3s + the SA token, write the base config, then
  # supervise the binary. Backgrounded — k3s readiness never waits on it.
  (
    # Secrets flow through this launcher: the bootstrap token and the
    # ServiceAccount token both ride $(…) expansions, and the boot
    # script's `set -x` EXPANDS command substitutions into the traced
    # line — without this they would be painted verbatim into the
    # console log (which support bundles collect). Subshell-local: the
    # rest of the bootstrap keeps tracing.
    set +x
    while [ ! -s /etc/rancher/k3s/k3s.yaml ]; do sleep 1; done
    # Retire the legacy in-cluster api-server (VMs provisioned before
    # the guest-binary control plane): its ingress claims the same
    # hostname, and its cluster-scoped RBAC squats the names. Best-effort.
    /usr/local/bin/k3s kubectl delete namespace appliance-system --ignore-not-found >/dev/null 2>&1 || true
    /usr/local/bin/k3s kubectl delete clusterrolebinding appliance-api-server --ignore-not-found >/dev/null 2>&1 || true
    /usr/local/bin/k3s kubectl delete clusterrole appliance-api-server --ignore-not-found >/dev/null 2>&1 || true
    # The token controller populates the Secret once the manifest above
    # is applied; non-expiring, stable across boots.
    SA_TOKEN=""
    while [ -z "$SA_TOKEN" ]; do
      SA_TOKEN=$(/usr/local/bin/k3s kubectl -n kube-system get secret appliance-api-server-token -o jsonpath='{.data.token}' 2>/dev/null | base64 -d 2>/dev/null)
      [ -n "$SA_TOKEN" ] || sleep 2
    done
    SA_CA=$(base64 -w0 "$PERSIST/k3s/server/tls/server-ca.crt" 2>/dev/null)
    cat > /persist/appliance/base-config.json <<BASECFG
{
  "type": "appliance-base-kubernetes",
  "name": "local-runtime",
  "baseConfigVersion": "__BASE_CONFIG_VERSION__",
  "kubernetes": {
    "server": "https://127.0.0.1:6443",
    "token": "$SA_TOKEN",
    "ca": "$SA_CA",
    "dataDir": "/persist/appliance-data",
    "namespace": "appliance",
    "hostnameSuffix": "appliance.localhost",
    "ingressClassName": "traefik",
    "hostPort": __HOST_PORT__,
    "registry": { "url": "localhost:__REGISTRY_HOST_PORT__", "insecure": true },
    "buildkit": { "addr": "unix:///run/buildkit/buildkitd.sock" }
  }
}
BASECFG
    chmod 600 /persist/appliance/base-config.json
    export APPLIANCE_MODE=server PORT=__APISERVER_GUEST_PORT__ HOST=0.0.0.0
    export BOOTSTRAP_TOKEN="$(cat /etc/appliance/bootstrap-token 2>/dev/null)"
    export APPLIANCE_BASE_CONFIG="$(cat /persist/appliance/base-config.json)"
    export APPLIANCE_CONSOLE_DIR=/persist/appliance/console
    export CONTROL_PLANE_ROOT=/var/lib/appliance-control-plane
    export APPLIANCE_CONTROL_PLANE_RUN=/run/appliance/control-plane
    # Warnings the quarantine watchdog (below) appends; cluster-info
    # surfaces them so an out-of-date CLI is visible in every client.
    export APPLIANCE_WARNINGS_FILE=/var/log/appliance-api-server.warnings
    # bun honors NODE_EXTRA_CA_CERTS: trust the k3s server CA without
    # disabling TLS verification process-wide.
    export NODE_EXTRA_CA_CERTS="$PERSIST/k3s/server/tls/server-ca.crt"
    : > /persist/.apiserver-ready
    echo "appliance-api-server: launching (guest port __APISERVER_GUEST_PORT__)"
    if [ -x /usr/local/bin/appliance-control-plane-supervisor ] && [ -f "$CONTROL_PLANE_ROOT/current" ]; then
      /usr/local/bin/appliance-control-plane-supervisor
    else
      while :; do
        /usr/local/bin/appliance-api-server >> /var/log/appliance-api-server.log 2>&1
        echo "appliance-api-server: exited — respawning in 2s" >> /var/log/appliance-api-server.log
        sleep 2
      done
    fi
  ) &
  # Quarantine watchdog: a CLI older than this VM can re-apply the
  # LEGACY in-cluster api-server deploy (namespace appliance-system +
  # an Ingress claiming api.appliance.localhost), shadowing the
  # canonical default/appliance-api-server route above with a stale
  # image. The one-shot retirement in the launcher only covers boot —
  # this loop keeps the VM clean while it runs. Best-effort throughout;
  # every removal leaves a distinctive line in the api-server log AND
  # the warnings file cluster-info surfaces to clients.
  (
    WARNINGS_FILE=/var/log/appliance-api-server.warnings
    while :; do
      sleep 60
      [ -s /etc/rancher/k3s/k3s.yaml ] || continue
      REMOVED=""
      # Any Ingress OUTSIDE `default` claiming the api hostname is a
      # legacy deploy (per-app ingresses use <stack>.appliance.localhost).
      OFFENDERS=$(/usr/local/bin/k3s kubectl get ingress -A -o jsonpath='{range .items[*]}{.metadata.namespace}{" "}{.metadata.name}{" "}{.spec.rules[*].host}{"\n"}{end}' 2>/dev/null \
        | awk '$1 != "default" { for (i = 3; i <= NF; i++) if ($i == "api.appliance.localhost") { print $1 "/" $2; break } }')
      for ING in $OFFENDERS; do
        NS=${ING%%/*}
        NAME=${ING#*/}
        /usr/local/bin/k3s kubectl -n "$NS" delete ingress "$NAME" --ignore-not-found >/dev/null 2>&1 || true
        REMOVED="ingress $ING"
      done
      # Re-retire the legacy namespace if something re-created it. Only
      # an Active namespace counts — a Terminating one is the previous
      # delete still draining, not a new offense.
      if [ "$(/usr/local/bin/k3s kubectl get namespace appliance-system -o jsonpath='{.status.phase}' 2>/dev/null)" = "Active" ]; then
        /usr/local/bin/k3s kubectl delete namespace appliance-system --ignore-not-found >/dev/null 2>&1 || true
        REMOVED="${REMOVED:+$REMOVED, }namespace appliance-system"
      fi
      if [ -n "$REMOVED" ]; then
        MSG="legacy api-server deploy detected and removed ($REMOVED) — an out-of-date appliance CLI deployed it; update the CLI (run: appliance upgrade)"
        echo "appliance-api-server: WARNING: $MSG" >> /var/log/appliance-api-server.log
        echo "$MSG" >> "$WARNINGS_FILE"
        # Cap the warnings file so a persistent legacy CLI can't grow it
        # unbounded; cluster-info dedupes what remains.
        tail -n 50 "$WARNINGS_FILE" > "$WARNINGS_FILE.tmp" 2>/dev/null && mv "$WARNINGS_FILE.tmp" "$WARNINGS_FILE" || true
      fi
    done
  ) &
else
  echo "appliance-api-server: binary not present — control plane unavailable in this VM"
fi
"#;

/// Per-connection shell run by the vsock agent (socat EXEC target). The
/// host `appliance-vm shell` client sends an initial "rows R cols C"
/// line; we apply it as the PTY size (echo off so it isn't painted into
/// the session), then drop to the non-root `appliance` user with
/// `su -l` — landing in the workspace (=HOME). bash if the dev toolchain
/// installed it, else sh.
///
/// A trailing `root` token on the size line keeps the shell as root
/// instead (the `--root` escape hatch, and the host clock-sync, which
/// needs root for `date -s`). The drop is invisible to the one-shot
/// exit-code sentinel: root sizes the PTY (it owns the tty), then the
/// login shell `su` execs inherits the same PTY stdin/stdout, so the
/// host's trailing `printf '…__APPLIANCE_VM_RC__%d__END__…' "$?"` still
/// runs in that shell with the command's real `$?`.
///
/// An optional trailing **verb** extends the grammar to
/// `rows R cols C [root] [attach <id> | new <id> | list | kill <id>]`,
/// routing to a reattachable tmux session instead of a raw login shell.
/// The verb is stripped *before* the `root` token, so with no verb the
/// parsing — and therefore the one-shot sentinel + clock-sync `root`
/// paths — is byte-for-byte what it was. attach/new attach-or-create the
/// per-id session `appliance-<id>`; list/kill enumerate/remove. Non-root
/// sessions run as the `appliance` user on the `tmux -L appliance` socket;
/// `root` swaps to a separate root-owned `tmux -L appliance-root` socket,
/// so the two privilege levels can never cross-attach. The vsock relay
/// stays a dumb per-connect byte pipe — the durable state is this in-guest
/// tmux server, which is what survives a disconnect / desktop restart.
const SHELL_AGENT: &str = r#"#!/bin/sh
# appliance-vm shell agent — one login shell per vsock connection.
# Runs as root (socat EXEC), sizes the PTY, then drops to `appliance`
# unless the caller appended a `root` token to the size line.
stty -echo 2>/dev/null
IFS= read -r __SZ
# Optional trailing session verb (attach/new/list/kill). Parsed first so
# the grammar is `rows R cols C [root] [verb …]`; with NO verb this whole
# block is a no-op and the legacy one-shot/login path below is unchanged.
__VERB=''; __SID=''
case "$__SZ" in
  *" attach "*) __SID="${__SZ##* attach }"; __SZ="${__SZ% attach *}"; __VERB=attach;;
  *" new "*)    __SID="${__SZ##* new }";    __SZ="${__SZ% new *}";    __VERB=new;;
  *" kill "*)   __SID="${__SZ##* kill }";   __SZ="${__SZ% kill *}";   __VERB=kill;;
  *" list")     __SZ="${__SZ% list}";       __VERB=list;;
esac
__ROOT=0
case "$__SZ" in *" root") __ROOT=1; __SZ="${__SZ% root}";; esac
[ -n "$__SZ" ] && stty $__SZ 2>/dev/null
stty echo 2>/dev/null
# Reattachable sessions: a verb routes to the tmux multiplexer. Non-root
# sessions run as `appliance` on the `appliance` socket; root keeps a
# separate `appliance-root` socket. attach/new exec tmux (replacing this
# agent), so a disconnect detaches but leaves the session running; list/
# kill are one-shots that print/act and close. login (`-l`) only on the
# interactive attach/new path — list/kill stay non-login so profile output
# can't corrupt the machine-readable session list.
if [ -n "$__VERB" ]; then
  # Defense-in-depth: $__SID rides verbatim into `sh -c` below. The host
  # already validates it (validate_session_id), but reject anything outside
  # [A-Za-z0-9._-] here too — belt-and-suspenders, since the vsock is
  # host-only. `list` carries an empty id, which passes (no offending char).
  case "$__SID" in
    *[!A-Za-z0-9._-]*) echo "appliance-shell: invalid session id" >&2; exit 1;;
  esac
  if [ "$__ROOT" = 1 ]; then __L=appliance-root; else __L=appliance; fi
  __TMUX="tmux -L $__L -f /etc/appliance/tmux.conf"
  case "$__VERB" in
    list) __TCMD="$__TMUX list-sessions -F '#{session_name} #{session_activity}' 2>/dev/null"; __LOGIN='';;
    # Echo a marker keyed on tmux's exit status so the host can report the
    # real outcome ("killed" vs "no such session") over the status-less
    # byte pipe — kill-session exits non-zero when the id doesn't exist.
    kill) __TCMD="if $__TMUX kill-session -t appliance-$__SID 2>/dev/null; then echo __APPLIANCE_VM_KILLED__; else echo __APPLIANCE_VM_NO_SESSION__; fi"; __LOGIN='';;
    *)    __TCMD="exec $__TMUX new-session -A -s appliance-$__SID"; __LOGIN='-l';;
  esac
  if [ "$__ROOT" = 1 ]; then
    exec sh -c "$__TCMD"
  else
    exec su -s /bin/sh $__LOGIN -c "$__TCMD" appliance
  fi
fi
if command -v bash >/dev/null 2>&1; then __SH=/bin/bash; else __SH=/bin/sh; fi
if [ "$__ROOT" = 1 ]; then
  cd /persist/workspace 2>/dev/null || cd /root 2>/dev/null || cd /
  exec "$__SH" -l
fi
# su -l: sets HOME/USER/SHELL from passwd, login shell, cd's to HOME
# (=/persist/workspace). Same PTY stdin/stdout → the one-shot sentinel
# still runs here with the command's real $?. (busybox su supports -s/-l.)
exec su -s "$__SH" -l appliance
"#;

/// Transparent tmux config the shell agent points `-f` at for every
/// reattachable session. No status bar (the desktop owns the chrome), a
/// short escape-time so key passthrough feels raw, a large scrollback that
/// survives detach/reattach, and `destroy-unattached off` so a session
/// lives on while no client is attached — the whole point of reattach.
pub(crate) const TMUX_CONF: &str = r#"set -g status off
set -g default-terminal "tmux-256color"
set -g escape-time 10
set -g history-limit 50000
set -g destroy-unattached off
"#;

/// Guest half of the v1 Runtime lifecycle protocol. The host sends a
/// validated JSON request over the existing root vsock one-shot. Long-
/// lived processes stay here: containerd owns the task and this script
/// persists desired/observed state and captured output under
/// /persist/runtime/apps/<app>.
pub(crate) const RUNTIME_SUPERVISOR: &str = r#"#!/bin/sh
set -eu
umask 077
REQ=${1:-'{}'}
ACTION=$(printf '%s' "$REQ" | jq -r '.action // empty')
APP=$(printf '%s' "$REQ" | jq -r '.appId // .plan.appId // empty')
case "$APP" in ''|*[!a-z0-9-]*) echo '{"state":"failed","message":"invalid app id"}'; exit 2;; esac
STATE=/persist/runtime/apps/$APP
NS=ap-$(printf '%s' "$APP" | sha256sum | cut -c1-10)
ROOT_IF=r$(printf '%s' "$APP" | sha256sum | cut -c1-10)
CTR_NS=appliance-$APP
CID=appliance-$APP
MAX_LOG_BYTES=8388608

if [ "$(printf '%s' "$REQ" | jq -r '.plan.kind // empty')" = compound ] || {
  [ -f "$STATE/request.json" ] && [ "$(jq -r '.plan.kind // empty' "$STATE/request.json")" = compound ];
}; then
  exec /usr/local/bin/appliance-runtime-compound-supervisor "$REQ"
fi

task_pid() {
  ctr -n "$CTR_NS" tasks list 2>/dev/null | awk -v id="$CID" '$1 == id { print $2; exit }'
}

cap_log() {
  [ -f "$STATE/current.log" ] || return 0
  SIZE=$(wc -c < "$STATE/current.log")
  if [ "$SIZE" -gt "$MAX_LOG_BYTES" ]; then
    DROP=$((SIZE - MAX_LOG_BYTES))
    BASE=$(cat "$STATE/log-base" 2>/dev/null || echo 0)
    tail -c "$MAX_LOG_BYTES" "$STATE/current.log" > "$STATE/current.log.trim"
    cat "$STATE/current.log.trim" > "$STATE/current.log"
    rm -f "$STATE/current.log.trim"
    echo "$((BASE + DROP))" > "$STATE/log-base"
  fi
}

cleanup_resources() {
  if [ -f "$STATE/relay.pids" ]; then
    while read -r P; do kill "$P" 2>/dev/null || true; done < "$STATE/relay.pids"
  fi
  if [ -f "$STATE/logcap.pid" ]; then
    kill "$(cat "$STATE/logcap.pid")" 2>/dev/null || true
  fi
  ip netns del "$NS" 2>/dev/null || true
  ip link del "$ROOT_IF" 2>/dev/null || true
  if [ -f "$STATE/request.json" ]; then
    OLD_TAG=$(jq -r '.plan.share.tag // empty' "$STATE/request.json")
    /usr/local/bin/runtime-share-unmount "$OLD_TAG" || true
  fi
  rm -rf "$STATE/rootfs"
  rm -f "$STATE/relay.pids" "$STATE/logcap.pid"
}

status() {
  if [ -f "$STATE/exit-code" ]; then
    CODE=$(cat "$STATE/exit-code" 2>/dev/null || echo 1)
    printf '{"state":"exited","exitCode":%s}\n' "$CODE"
  elif [ -n "$(task_pid)" ]; then
    echo '{"state":"running"}'
  elif [ -d "$STATE" ]; then
    echo '{"state":"exited","exitCode":1}'
  else
    echo '{"state":"missing"}'
  fi
}

case "$ACTION" in
  status) status; exit 0;;
  logs)
    OFFSET=$(printf '%s' "$REQ" | jq -r '.offset // 0')
    case "$OFFSET" in ''|*[!0-9]*) echo '{"state":"failed","message":"invalid log offset"}'; exit 2;; esac
    cap_log
    SIZE=0
    [ -f "$STATE/current.log" ] && SIZE=$(wc -c < "$STATE/current.log")
    BASE=$(cat "$STATE/log-base" 2>/dev/null || echo 0)
    RESET=false
    if [ "$OFFSET" -lt "$BASE" ] || [ "$OFFSET" -gt "$((BASE + SIZE))" ]; then
      OFFSET=$BASE
      RESET=true
    fi
    LOCAL_OFFSET=$((OFFSET - BASE))
    AVAILABLE=$((SIZE - LOCAL_OFFSET))
    READ_BYTES=$AVAILABLE
    [ "$READ_BYTES" -le 65536 ] || READ_BYTES=65536
    if [ -f "$STATE/current.log" ]; then
      DATA=$(tail -c "+$((LOCAL_OFFSET + 1))" "$STATE/current.log" | head -c "$READ_BYTES" | base64 | tr -d '\n')
    else
      DATA=
    fi
    printf '{"offset":%s,"reset":%s,"data":"%s"}\n' "$((OFFSET + READ_BYTES))" "$RESET" "$DATA"
    exit 0
    ;;
  stop)
    if [ ! -d "$STATE" ]; then echo '{"state":"missing"}'; exit 0; fi
    ctr -n "$CTR_NS" tasks kill -s SIGTERM "$CID" >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do
      ctr -n "$CTR_NS" tasks list 2>/dev/null | grep -q "$CID" || break
      sleep 0.5
    done
    ctr -n "$CTR_NS" tasks kill -s SIGKILL "$CID" >/dev/null 2>&1 || true
    cleanup_resources
    [ -f "$STATE/pid" ] && kill "$(cat "$STATE/pid")" 2>/dev/null || true
    rm -f "$STATE/pid"
    echo stopped > "$STATE/desired"
    echo '{"state":"stopped"}'
    exit 0
    ;;
  start) ;;
  *) echo '{"state":"failed","message":"unknown runtime action"}'; exit 2;;
esac

if [ -n "$(task_pid)" ]; then
  echo '{"state":"failed","message":"instance already running"}'
  exit 2
fi
mkdir -p "$STATE" /run/appliance/shares /sys/fs/cgroup/appliance
cleanup_resources
rm -f "$STATE/exit-code" "$STATE/current.log" "$STATE/pid"
echo 0 > "$STATE/log-base"
printf '%s\n' "$REQ" > "$STATE/request.json"
chmod 0600 "$STATE/request.json"
TAG=$(printf '%s' "$REQ" | jq -r '.plan.share.tag')
HOST_PATH=$(printf '%s' "$REQ" | jq -r '.plan.share.hostPath // empty')
IP=$(printf '%s' "$REQ" | jq -r '.plan.principalIp')
UID_NUM=$(printf '%s' "$REQ" | jq -r '.plan.uid')
KIND=$(printf '%s' "$REQ" | jq -r '.plan.kind // empty')
TAG_HEX=${TAG#ap-}
case "$TAG" in ap-*) ;; *) echo '{"state":"failed","message":"invalid share tag"}'; exit 2;; esac
case "$TAG_HEX" in ''|*[!0-9a-f]*) echo '{"state":"failed","message":"invalid share tag"}'; exit 2;; esac
[ "${#TAG_HEX}" -le 32 ] || { echo '{"state":"failed","message":"invalid share tag"}'; exit 2; }
case "$UID_NUM" in ''|*[!0-9]*) echo '{"state":"failed","message":"invalid uid"}'; exit 2;; esac
[ "$UID_NUM" -ge 20000 ] && [ "$UID_NUM" -le 20239 ] || { echo '{"state":"failed","message":"invalid uid"}'; exit 2; }
IP_PREFIX=${IP%.*}
IP_LEAF=${IP##*.}
case "$IP_LEAF" in ''|*[!0-9]*) echo '{"state":"failed","message":"invalid principal ip"}'; exit 2;; esac
[ "$IP_PREFIX" = 192.168.127 ] && [ "$IP_LEAF" -ge 10 ] && [ "$IP_LEAF" -le 239 ] || {
  echo '{"state":"failed","message":"invalid principal ip"}'; exit 2;
}
case "$KIND" in
  container)
    IMAGE_PATH=$(printf '%s' "$REQ" | jq -r '.plan.imagePath // empty')
    case "/$IMAGE_PATH/" in /payload/*) ;; *) echo '{"state":"failed","message":"invalid image path"}'; exit 2;; esac
    case "/$IMAGE_PATH/" in *'/../'*|*'/./'*|*'\\'*) echo '{"state":"failed","message":"invalid image path"}'; exit 2;; esac
    printf '%s' "$REQ" | jq -e '.plan.env | type == "object"' >/dev/null || {
      echo '{"state":"failed","message":"invalid container environment"}'; exit 2;
    }
    ;;
  binary)
    BINARY_PATH=$(printf '%s' "$REQ" | jq -r '.plan.target.path // empty')
    ENTRYPOINT=$(printf '%s' "$REQ" | jq -r '.plan.target.entrypoint // empty')
    BINARY_CWD=$(printf '%s' "$REQ" | jq -r '.plan.target.cwd // empty')
    case "/$BINARY_PATH/" in /payload/*) ;; *) echo '{"state":"failed","message":"invalid binary target path"}'; exit 2;; esac
    case "/$BINARY_PATH/" in *'/../'*|*'/./'*|*'\\'*) echo '{"state":"failed","message":"invalid binary target path"}'; exit 2;; esac
    case "$ENTRYPOINT" in ''|/*|*\\*) echo '{"state":"failed","message":"invalid binary entrypoint"}'; exit 2;; esac
    case "/$ENTRYPOINT/" in *'/../'*|*'/./'*) echo '{"state":"failed","message":"invalid binary entrypoint"}'; exit 2;; esac
    case "$BINARY_CWD" in .) BINARY_CWD=/;; ''|/*|*\\*) echo '{"state":"failed","message":"invalid binary working directory"}'; exit 2;;
      *) case "/$BINARY_CWD/" in *'/../'*|*'/./'*) echo '{"state":"failed","message":"invalid binary working directory"}'; exit 2;; esac
         BINARY_CWD=/$BINARY_CWD;;
    esac
    printf '%s' "$REQ" | jq -e '
      (.plan.target.args | type == "array") and all(.plan.target.args[]; type == "string") and
      (.plan.target.env | type == "object")
    ' >/dev/null || { echo '{"state":"failed","message":"invalid binary arguments or environment"}'; exit 2; }
    ;;
  *) echo '{"state":"failed","message":"invalid runtime workload kind"}'; exit 2;;
esac
[ "$(printf '%s' "$REQ" | jq '.plan.ports | length')" -le 16 ] || {
  echo '{"state":"failed","message":"too many published ports"}'; exit 2;
}
printf '%s' "$REQ" | jq -e --arg ip "$IP" '
  .plan.ports | all(.target == $ip and (.relay | type == "number") and (.guest | type == "number"))
' >/dev/null || { echo '{"state":"failed","message":"invalid published port target"}'; exit 2; }
SHARE=/run/appliance/shares/$TAG
/usr/local/bin/runtime-share-mount "$TAG" "$HOST_PATH"

if [ "$KIND" = binary ]; then
  SOURCE=$SHARE/$BINARY_PATH
  STAGED=$STATE/rootfs
  [ -d "$SOURCE" ] && [ ! -L "$SOURCE" ] || {
    echo '{"state":"failed","message":"binary target is not a regular directory"}'; cleanup_resources; exit 2;
  }
  mkdir -p "$STAGED"
  if cp --help 2>&1 | grep -q -- '--no-preserve'; then
    cp -R --no-preserve=mode,ownership "$SOURCE/." "$STAGED/"
  else
    # Alpine's runtime image ships BusyBox cp. Copy without archive mode,
    # then explicitly discard source modes before validating the private copy.
    cp -R "$SOURCE/." "$STAGED/"
    find "$STAGED" -type d -exec chmod 0755 {} \;
    find "$STAGED" -type f -exec chmod 0644 {} \;
  fi
  if find "$STAGED" -type l -print -quit | grep -q .; then
    echo '{"state":"failed","message":"binary payload symlinks are not allowed"}'; cleanup_resources; exit 2
  fi
  if find "$STAGED" ! -type d ! -type f -print -quit | grep -q .; then
    echo '{"state":"failed","message":"binary payload contains an unsupported file type"}'; cleanup_resources; exit 2
  fi
  chown -R "$UID_NUM:$UID_NUM" "$STAGED"
  [ -f "$STAGED/$ENTRYPOINT" ] && [ ! -L "$STAGED/$ENTRYPOINT" ] || {
    echo '{"state":"failed","message":"binary entrypoint is not a regular file"}'; cleanup_resources; exit 2;
  }
  [ -d "$STAGED$BINARY_CWD" ] && [ ! -L "$STAGED$BINARY_CWD" ] || {
    echo '{"state":"failed","message":"binary working directory is not a directory"}'; cleanup_resources; exit 2;
  }
  chmod 0755 "$STAGED/$ENTRYPOINT"
fi

# A stable unprivileged identity exists even when the image config names
# its own uid; ownership and audit records use this principal uid.
USER_NAME=u$UID_NUM
getent group "$USER_NAME" >/dev/null 2>&1 || addgroup -g "$UID_NUM" "$USER_NAME"
id "$USER_NAME" >/dev/null 2>&1 || adduser -D -H -u "$UID_NUM" -G "$USER_NAME" "$USER_NAME"

# Per-principal cgroup v2 controls. Hints never resize the pooled VM.
CG=/sys/fs/cgroup/appliance/$APP
for CONTROL in cpu memory pids; do
  grep -qw "$CONTROL" /sys/fs/cgroup/cgroup.controllers && echo "+$CONTROL" > /sys/fs/cgroup/cgroup.subtree_control
  grep -qw "$CONTROL" /sys/fs/cgroup/appliance/cgroup.controllers && echo "+$CONTROL" > /sys/fs/cgroup/appliance/cgroup.subtree_control
done
mkdir -p "$CG"
CPUS=$(printf '%s' "$REQ" | jq -r '.plan.resources.cpus')
MEM=$(printf '%s' "$REQ" | jq -r '.plan.resources.memoryMib')
PIDS=$(printf '%s' "$REQ" | jq -r '.plan.resources.pids')
echo "$((CPUS * 100000)) 100000" > "$CG/cpu.max"
echo "$((MEM * 1024 * 1024))" > "$CG/memory.max"
echo "$((MEM * 1024 * 1024 * 9 / 10))" > "$CG/memory.high"
echo 1 > "$CG/memory.oom.group"
echo "$PIDS" > "$CG/pids.max"
printf '%s\n' "$(printf '%s' "$REQ" | jq -r '.plan.resources.diskGib')" > "$STATE/disk-quota-gib"

# Stable /32 network namespace. The guest root routes the leaf through
# its only NIC and proxy-ARPs it; nftables drops source spoofing at the
# veth ingress. Inter-app forwarding remains absent by default.
ip netns del "$NS" 2>/dev/null || true
ip netns add "$NS"
APP_IF=a$(printf '%s' "$APP" | sha256sum | cut -c1-10)
ip link del "$ROOT_IF" 2>/dev/null || true
ip link add "$ROOT_IF" type veth peer name "$APP_IF"
ip link set "$APP_IF" netns "$NS"
ip link set "$ROOT_IF" up
ip route replace "$IP/32" dev "$ROOT_IF"
ip netns exec "$NS" ip link set lo up
ip netns exec "$NS" ip addr add "$IP/32" dev "$APP_IF"
ip netns exec "$NS" ip link set "$APP_IF" up
ip netns exec "$NS" ip route add default dev "$APP_IF"
sysctl -q -w net.ipv4.ip_forward=1 net.ipv4.conf.eth0.proxy_arp=1 "net.ipv4.conf.$ROOT_IF.proxy_arp=1"
if ! nft list table inet appliance_runtime >/dev/null 2>&1; then
  nft add table inet appliance_runtime
fi
if ! nft list chain inet appliance_runtime principal_input >/dev/null 2>&1; then
  nft 'add chain inet appliance_runtime principal_input { type filter hook input priority -10; policy accept; }'
  nft add rule inet appliance_runtime principal_input ct state established,related accept
  nft add rule inet appliance_runtime principal_input iifname "r*" drop
fi
if ! nft list chain inet appliance_runtime principal_forward >/dev/null 2>&1; then
  nft 'add chain inet appliance_runtime principal_forward { type filter hook forward priority -10; policy accept; }'
  nft add rule inet appliance_runtime principal_forward iifname "r*" oifname != "eth0" drop
fi
if ! nft list chain inet appliance_runtime principal_spoof >/dev/null 2>&1; then
  nft 'add chain inet appliance_runtime principal_spoof { type filter hook forward priority -11; policy accept; }'
fi
nft add rule inet appliance_runtime principal_spoof iifname "$ROOT_IF" ip saddr != "$IP" drop
/usr/local/bin/runtime-principal-snat

ETH0_IP=$(ip -4 -o addr show dev eth0 | awk '{ split($4, address, "/"); print address[1]; exit }')
[ -n "$ETH0_IP" ] || { echo '{"state":"failed","message":"guest eth0 has no IPv4 address"}'; exit 2; }

rc-service containerd start >/dev/null 2>&1 || true
for _ in $(seq 1 50); do [ -S /run/containerd/containerd.sock ] && break; sleep 0.1; done
IMAGE=
if [ "$KIND" = container ]; then
  set +e
  IMPORT_OUTPUT=$(ctr -n "$CTR_NS" images import --base-name "appliance.local/$APP" "$SHARE/$IMAGE_PATH" 2>&1)
  IMPORT_CODE=$?
  set -e
  printf '%s\n' "$IMPORT_OUTPUT" >> "$STATE/current.log"
  [ "$IMPORT_CODE" -eq 0 ] || { echo '{"state":"failed","message":"container image import failed"}'; cleanup_resources; exit 2; }
  IMAGE=$(printf '%s\n' "$IMPORT_OUTPUT" | awk '$NF == "saved" { print $1; exit }')
  if [ -z "$IMAGE" ]; then
    IMAGE=$(printf '%s\n' "$IMPORT_OUTPUT" | awk '$1 == "unpacking" { print $2; exit }')
  fi
  [ -n "$IMAGE" ] || {
    echo '{"state":"failed","message":"container image import produced no image"}'
    cleanup_resources
    exit 2
  }
fi

# Root-namespace relays are unique per app. Host listeners terminate at
# these relay ports; each relay's final target is the app's /32.
printf '%s' "$REQ" | jq -r '.plan.ports[] | [.relay,.guest] | @tsv' > "$STATE/ports.tsv"
while IFS="$(printf '\t')" read -r RELAY GUEST; do
  export RELAY GUEST ETH0_IP IP STATE
  nohup setsid sh -c 'exec socat "TCP-LISTEN:$RELAY,bind=$ETH0_IP,reuseaddr,fork" "TCP:$IP:$GUEST"' \
    </dev/null >> "$STATE/current.log" 2>&1 &
  echo $! >> "$STATE/relay.pids"
done < "$STATE/ports.tsv"
sleep 0.1
if [ -f "$STATE/relay.pids" ]; then
  while read -r P; do
    kill -0 "$P" 2>/dev/null || {
      echo '{"state":"failed","message":"published port relay failed closed"}'
      cleanup_resources
      exit 2
    }
  done < "$STATE/relay.pids"
fi

printf '%s' "$REQ" | jq -r '(.plan.target.env // .plan.env) | to_entries[] | [.key,(.value|@base64)] | @tsv' > "$STATE/env.tsv"
chmod 0600 "$STATE/env.tsv"
EGRESS_CA=/usr/local/share/ca-certificates/appliance-egress.crt
if grep -q "^APPLIANCE_EGRESS_CA$(printf '\t')" "$STATE/env.tsv" && [ ! -f "$EGRESS_CA" ]; then
  echo '{"state":"failed","message":"egress CA certificate is unavailable"}'
  cleanup_resources
  exit 2
fi
if [ "$KIND" = binary ]; then
  printf '%s' "$REQ" | jq -r '.plan.target.args[] | @base64' > "$STATE/args.txt"
  if grep -q "^APPLIANCE_EGRESS_CA$(printf '\t')" "$STATE/env.tsv" && [ -f "$EGRESS_CA" ]; then
    cp "$EGRESS_CA" "$STAGED/appliance-egress-ca.pem"
    chown "$UID_NUM:$UID_NUM" "$STAGED/appliance-egress-ca.pem"
    chmod 0444 "$STAGED/appliance-egress-ca.pem"
  fi
else
  : > "$STATE/args.txt"
fi
: > "$STATE/ctr.env"
CR=$(printf '\rx'); CR=${CR%x}
LF=$(printf '\nx'); LF=${LF%x}
while IFS="$(printf '\t')" read -r KEY VALUE; do
  case "$KEY" in HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy) ;; *) continue;; esac
  DECODED=$(printf '%s' "$VALUE" | base64 -d; printf x); DECODED=${DECODED%x}
  case "$DECODED" in *"$CR"*|*"$LF"*)
    echo '{"state":"failed","message":"proxy environment values must not contain newlines"}'
    cleanup_resources
    exit 2
    ;;
  esac
  printf '%s=%s\n' "$KEY" "$DECODED" >> "$STATE/ctr.env"
done < "$STATE/env.tsv"
# The lifecycle RPC uses a one-shot shell transport. Ignore its closing SIGHUP
# so the pooled workload outlives that control connection, and let containerd
# place the actual task (rather than this short-lived launcher) in the app's
# cgroup. Runtime status is task-based, and the child records its own PID
# after setsid so teardown never races a short-lived wrapper.
export STATE CTR_NS NS IMAGE CID CG APP ROOT_IF SHARE UID_NUM KIND STAGED ENTRYPOINT BINARY_CWD EGRESS_CA
nohup setsid sh -c '
  echo $$ > "$STATE/logcap.pid"
  while true; do
    if [ -f "$STATE/current.log" ] && [ "$(wc -c < "$STATE/current.log")" -gt 8388608 ]; then
      SIZE=$(wc -c < "$STATE/current.log")
      DROP=$((SIZE - 8388608))
      BASE=$(cat "$STATE/log-base" 2>/dev/null || echo 0)
      tail -c 8388608 "$STATE/current.log" > "$STATE/current.log.trim"
      cat "$STATE/current.log.trim" > "$STATE/current.log"
      rm -f "$STATE/current.log.trim"
      echo "$((BASE + DROP))" > "$STATE/log-base"
    fi
    sleep 1
  done
' </dev/null >/dev/null 2>&1 &
nohup setsid sh -c '
  echo $$ > "$STATE/pid"
  # ctr 2.0 rejects the Docker-style `--cap-drop ALL`; enumerate every
  # capability in its default OCI set so the resulting sets are empty.
  set -- \
    --cap-drop CAP_CHOWN \
    --cap-drop CAP_DAC_OVERRIDE \
    --cap-drop CAP_FSETID \
    --cap-drop CAP_FOWNER \
    --cap-drop CAP_MKNOD \
    --cap-drop CAP_NET_RAW \
    --cap-drop CAP_SETGID \
    --cap-drop CAP_SETUID \
    --cap-drop CAP_SETFCAP \
    --cap-drop CAP_SETPCAP \
    --cap-drop CAP_NET_BIND_SERVICE \
    --cap-drop CAP_SYS_CHROOT \
    --cap-drop CAP_KILL \
    --cap-drop CAP_AUDIT_WRITE
  while IFS="$(printf "\t")" read -r KEY VALUE; do
    case "$KEY" in HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy) continue;; esac
    DECODED=$(printf "%s" "$VALUE" | base64 -d; printf x); DECODED=${DECODED%x}
    set -- "$@" --env "$KEY=$DECODED"
  done < "$STATE/env.tsv"
  [ ! -s "$STATE/ctr.env" ] || set -- "$@" --env-file "$STATE/ctr.env"
  if [ "$KIND" = container ] && grep -q "^APPLIANCE_EGRESS_CA$(printf "\t")" "$STATE/env.tsv" && [ -f "$EGRESS_CA" ]; then
    set -- "$@" --mount type=bind,src="$EGRESS_CA",dst=/appliance-egress-ca.pem,options=rbind:ro
  fi
  set +e
  if [ "$KIND" = container ]; then
    ctr -n "$CTR_NS" run --rm --user "$UID_NUM:$UID_NUM" --cgroup "appliance/$APP" --seccomp --with-ns "network:/var/run/netns/$NS" "$@" "$IMAGE" "$CID" >> "$STATE/current.log" 2>&1
  else
    set -- "$@" --rootfs --cwd "$BINARY_CWD" "$STAGED" "$CID" "/$ENTRYPOINT"
    while IFS= read -r VALUE; do
      DECODED=$(printf "%s" "$VALUE" | base64 -d)
      set -- "$@" "$DECODED"
    done < "$STATE/args.txt"
    ctr -n "$CTR_NS" run --rm --user "$UID_NUM:$UID_NUM" --cgroup "appliance/$APP" --seccomp --with-ns "network:/var/run/netns/$NS" "$@" >> "$STATE/current.log" 2>&1
  fi
  CODE=$?
  echo "$CODE" > "$STATE/exit-code"
  if [ -f "$STATE/relay.pids" ]; then
    while read -r P; do kill "$P" 2>/dev/null || true; done < "$STATE/relay.pids"
  fi
  [ -f "$STATE/logcap.pid" ] && kill "$(cat "$STATE/logcap.pid")" 2>/dev/null || true
  ip netns del "$NS" 2>/dev/null || true
  ip link del "$ROOT_IF" 2>/dev/null || true
  /usr/local/bin/runtime-share-unmount "${SHARE##*/}" || true
  [ "$KIND" = binary ] && rm -rf "$STAGED"
  rm -f "$STATE/pid" "$STATE/relay.pids" "$STATE/logcap.pid"
  exit "$CODE"
' </dev/null >/dev/null 2>&1 &

TASK_PID=
for _ in $(seq 1 100); do
  TASK_PID=$(task_pid)
  [ -n "$TASK_PID" ] && break
  [ -f "$STATE/exit-code" ] && break
  sleep 0.1
done
if [ -z "$TASK_PID" ]; then
  if [ -f "$STATE/exit-code" ]; then
    CODE=$(cat "$STATE/exit-code" 2>/dev/null || echo 1)
    cleanup_resources
    echo exited > "$STATE/desired"
    printf '{"state":"exited","exitCode":%s}\n' "$CODE"
    exit 0
  fi
  cleanup_resources
  echo '{"state":"failed","message":"runtime task did not start"}'
  exit 2
fi
if ! grep -qx "$TASK_PID" "$CG/cgroup.procs"; then
  ctr -n "$CTR_NS" tasks kill -s SIGKILL "$CID" >/dev/null 2>&1 || true
  cleanup_resources
  echo '{"state":"failed","message":"container task escaped its cgroup"}'
  exit 2
fi
echo running > "$STATE/desired"
echo '{"state":"running"}'
"#;

/// Compound-only Runtime lifecycle path. It reuses one app principal,
/// network namespace, and read-only payload share while giving each leaf
/// its own containerd task, cgroup, logs, health state, and restart worker.
/// The v1 single-workload script above remains unchanged after dispatch.
pub(crate) const RUNTIME_COMPOUND_SUPERVISOR: &str = r#"#!/bin/sh
set -eu
umask 077
REQ=${1:-'{}'}
ACTION=$(printf '%s' "$REQ" | jq -r '.action // empty')
APP=$(printf '%s' "$REQ" | jq -r '.appId // .plan.appId // empty')
case "$APP" in ''|*[!a-z0-9-]*) echo '{"state":"failed","message":"invalid app id"}'; exit 2;; esac
STATE=/persist/runtime/apps/$APP
SERVICES=$STATE/services
NS=ap-$(printf '%s' "$APP" | sha256sum | cut -c1-10)
ROOT_IF=r$(printf '%s' "$APP" | sha256sum | cut -c1-10)
CTR_NS=appliance-$APP
MAX_LOG_BYTES=8388608

task_pid() {
  SVC=$1
  CID=appliance-$APP-$SVC
  ctr -n "$CTR_NS" tasks list 2>/dev/null | awk -v id="$CID" '$1 == id { print $2; exit }'
}

service_ready() {
  SVC_STATE=$(cat "$SERVICES/$1/state" 2>/dev/null || echo missing)
  [ "$SVC_STATE" = running ] || [ "$SVC_STATE" = healthy ]
}

cap_service_log() {
  SVC=$1
  LOG=$SERVICES/$SVC/current.log
  [ -f "$LOG" ] || return 0
  SIZE=$(wc -c < "$LOG")
  if [ "$SIZE" -gt "$MAX_LOG_BYTES" ]; then
    DROP=$((SIZE - MAX_LOG_BYTES))
    BASE=$(cat "$SERVICES/$SVC/log-base" 2>/dev/null || echo 0)
    tail -c "$MAX_LOG_BYTES" "$LOG" > "$LOG.trim"
    cat "$LOG.trim" > "$LOG"
    rm -f "$LOG.trim"
    echo "$((BASE + DROP))" > "$SERVICES/$SVC/log-base"
  fi
}

cleanup_app_resources() {
  if [ -f "$STATE/relay.pids" ]; then
    while read -r P; do kill "$P" 2>/dev/null || true; done < "$STATE/relay.pids"
  fi
  if [ -f "$STATE/monitor.pid" ]; then
    MONITOR=$(cat "$STATE/monitor.pid" 2>/dev/null || true)
    [ -n "$MONITOR" ] && [ "$MONITOR" != "$$" ] && kill "$MONITOR" 2>/dev/null || true
  fi
  ip netns del "$NS" 2>/dev/null || true
  ip link del "$ROOT_IF" 2>/dev/null || true
  if [ -f "$STATE/request.json" ]; then
    TAG=$(jq -r '.plan.share.tag // empty' "$STATE/request.json")
    /usr/local/bin/runtime-share-unmount "$TAG" || true
  fi
  rm -f "$STATE/relay.pids" "$STATE/monitor.pid"
}

stop_all() {
  FINAL=$1
  [ -f "$STATE/request.json" ] || { cleanup_app_resources; return 0; }
  echo stopping > "$STATE/desired"
  jq -r '.plan.services | reverse | .[].name' "$STATE/request.json" | while read -r SVC; do
    CID=appliance-$APP-$SVC
    mkdir -p "$SERVICES/$SVC"
    ctr -n "$CTR_NS" tasks kill -s SIGTERM "$CID" >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do
      [ -z "$(task_pid "$SVC")" ] && break
      sleep 0.5
    done
    ctr -n "$CTR_NS" tasks kill -s SIGKILL "$CID" >/dev/null 2>&1 || true
    if [ -f "$SERVICES/$SVC/worker.pid" ]; then
      kill "$(cat "$SERVICES/$SVC/worker.pid")" 2>/dev/null || true
    fi
    rm -f "$SERVICES/$SVC/worker.pid"
    [ "$FINAL" = stopped ] && echo stopped > "$SERVICES/$SVC/state"
  done
  cleanup_app_resources
  echo "$FINAL" > "$STATE/desired"
}

status() {
  if [ ! -f "$STATE/request.json" ]; then echo '{"state":"missing"}'; return; fi
  ROWS=$STATE/status.rows
  : > "$ROWS"
  jq -r '.plan.services[].name' "$STATE/request.json" | while read -r SVC; do
    SERVICE=$SERVICES/$SVC
    SVC_STATE=$(cat "$SERVICE/state" 2>/dev/null || echo missing)
    HEALTH=$(cat "$SERVICE/health" 2>/dev/null || echo none)
    RESTARTS=$(cat "$SERVICE/restart-count" 2>/dev/null || echo 0)
    EXIT=$(cat "$SERVICE/exit-code" 2>/dev/null || true)
    jq -nc \
      --arg name "$SVC" --arg state "$SVC_STATE" --arg health "$HEALTH" \
      --argjson restarts "$RESTARTS" --arg exitCode "${EXIT:-}" \
      --argjson plan "$(jq -c --arg svc "$SVC" '.plan.services[] | select(.name == $svc)' "$STATE/request.json")" '
        {id: $name, name: $name, state: $state, required: $plan.required,
         health: $health, restarts: $restarts, placement: "shared",
         endpoint: (($plan.ports[]? | select(.primary) | "http://127.0.0.1:\(.guest)") // null)}
        + (if $exitCode == "" then {} else {exitCode: ($exitCode | tonumber)} end)' >> "$ROWS"
  done
  SERVICES_JSON=$(jq -s '.' "$ROWS")
  DESIRED=$(cat "$STATE/desired" 2>/dev/null || echo starting)
  case "$DESIRED" in
    failed|stopping|stopped|degraded|exited) APP_STATE=$DESIRED ;;
    *)
      if printf '%s' "$SERVICES_JSON" | jq -e 'any(.[]; .state == "starting" or .state == "restarting")' >/dev/null; then
        APP_STATE=starting
      elif printf '%s' "$SERVICES_JSON" | jq -e 'any(.[]; (.required == false) and (.state == "failed" or .state == "exited" or .state == "blocked"))' >/dev/null; then
        APP_STATE=degraded
      else APP_STATE=running; fi
      ;;
  esac
  CULPRIT=$(cat "$STATE/culprit" 2>/dev/null || true)
  EXIT_CODE=$(cat "$STATE/exit-code" 2>/dev/null || true)
  jq -nc --arg state "$APP_STATE" --argjson services "$SERVICES_JSON" \
    --arg culprit "$CULPRIT" --arg exitCode "$EXIT_CODE" '
      {state: $state, serviceCount: ($services | length), services: $services}
      + (if $culprit == "" then {} else {culprit: $culprit} end)
      + (if $exitCode == "" then {} else {exitCode: ($exitCode | tonumber)} end)'
}

logs() {
  SVC=$(printf '%s' "$REQ" | jq -r '.service // empty')
  case "$SVC" in ''|*[!a-z0-9-]*) echo '{"state":"failed","message":"compound logs require a valid service"}'; exit 2;; esac
  jq -e --arg svc "$SVC" '.plan.services | any(.name == $svc)' "$STATE/request.json" >/dev/null || {
    echo '{"state":"failed","message":"unknown compound service"}'; exit 2;
  }
  OFFSET=$(printf '%s' "$REQ" | jq -r '.offset // 0')
  case "$OFFSET" in ''|*[!0-9]*) echo '{"state":"failed","message":"invalid log offset"}'; exit 2;; esac
  cap_service_log "$SVC"
  LOG=$SERVICES/$SVC/current.log
  SIZE=0
  [ -f "$LOG" ] && SIZE=$(wc -c < "$LOG")
  BASE=$(cat "$SERVICES/$SVC/log-base" 2>/dev/null || echo 0)
  RESET=false
  if [ "$OFFSET" -lt "$BASE" ] || [ "$OFFSET" -gt "$((BASE + SIZE))" ]; then OFFSET=$BASE; RESET=true; fi
  LOCAL_OFFSET=$((OFFSET - BASE))
  READ_BYTES=$((SIZE - LOCAL_OFFSET))
  [ "$READ_BYTES" -le 65536 ] || READ_BYTES=65536
  if [ -f "$LOG" ]; then
    DATA=$(tail -c "+$((LOCAL_OFFSET + 1))" "$LOG" | head -c "$READ_BYTES" | base64 | tr -d '\n')
  else DATA=; fi
  jq -nc --arg service "$SVC" --argjson offset "$((OFFSET + READ_BYTES))" \
    --argjson reset "$RESET" --arg data "$DATA" '{service: $service, offset: $offset, reset: $reset, data: $data}'
}

case "$ACTION" in
  status) status; exit 0;;
  logs) logs; exit 0;;
  stop)
    if [ ! -d "$STATE" ]; then echo '{"state":"missing"}'; exit 0; fi
    stop_all stopped
    echo '{"state":"stopped"}'
    exit 0
    ;;
  fail)
    CULPRIT=$(printf '%s' "$REQ" | jq -r '.service // "unknown"')
    EXIT_CODE=$(cat "$SERVICES/$CULPRIT/exit-code" 2>/dev/null || echo 1)
    case "$EXIT_CODE" in ''|*[!0-9]*|-*) EXIT_CODE=1;; esac
    echo "$CULPRIT" > "$STATE/culprit"
    echo "$EXIT_CODE" > "$STATE/exit-code"
    stop_all failed
    jq -nc --arg culprit "$CULPRIT" --argjson exitCode "$EXIT_CODE" \
      '{state:"failed", culprit:$culprit, exitCode:$exitCode}'
    exit 0
    ;;
  complete)
    rm -f "$STATE/culprit"
    echo 0 > "$STATE/exit-code"
    stop_all exited
    echo '{"state":"exited","exitCode":0}'
    exit 0
    ;;
  start) ;;
  *) echo '{"state":"failed","message":"unknown runtime action"}'; exit 2;;
esac

mkdir -p "$STATE" "$SERVICES" /run/appliance/shares /sys/fs/cgroup/appliance
if [ -f "$STATE/request.json" ]; then
  RUNNING=0
  for SVC in $(jq -r '.plan.services[].name' "$STATE/request.json"); do
    [ -z "$(task_pid "$SVC")" ] || RUNNING=1
  done
  [ "$RUNNING" -eq 0 ] || { echo '{"state":"failed","message":"instance already running"}'; exit 2; }
fi
cleanup_app_resources
rm -rf "$SERVICES"
mkdir -p "$SERVICES"
printf '%s\n' "$REQ" > "$STATE/request.json"
chmod 0600 "$STATE/request.json"
echo starting > "$STATE/desired"
rm -f "$STATE/culprit" "$STATE/exit-code" "$STATE/start-failed" "$STATE/failed-service" "$STATE/ca-missing" \
  "$STATE/clean-required" "$STATE/degraded"

TAG=$(printf '%s' "$REQ" | jq -r '.plan.share.tag')
HOST_PATH=$(printf '%s' "$REQ" | jq -r '.plan.share.hostPath // empty')
IP=$(printf '%s' "$REQ" | jq -r '.plan.principalIp')
UID_NUM=$(printf '%s' "$REQ" | jq -r '.plan.uid')
case "$TAG" in ap-[0-9a-f]*) ;; *) echo '{"state":"failed","message":"invalid share tag"}'; exit 2;; esac
[ "${#TAG}" -le 35 ] || { echo '{"state":"failed","message":"invalid share tag"}'; exit 2; }
case "$UID_NUM" in ''|*[!0-9]*) echo '{"state":"failed","message":"invalid uid"}'; exit 2;; esac
[ "$UID_NUM" -ge 20000 ] && [ "$UID_NUM" -le 20239 ] || { echo '{"state":"failed","message":"invalid uid"}'; exit 2; }
IP_PREFIX=${IP%.*}; IP_LEAF=${IP##*.}
case "$IP_LEAF" in ''|*[!0-9]*) echo '{"state":"failed","message":"invalid principal ip"}'; exit 2;; esac
[ "$IP_PREFIX" = 192.168.127 ] && [ "$IP_LEAF" -ge 10 ] && [ "$IP_LEAF" -le 239 ] || {
  echo '{"state":"failed","message":"invalid principal ip"}'; exit 2;
}
SHARE=/run/appliance/shares/$TAG
/usr/local/bin/runtime-share-mount "$TAG" "$HOST_PATH"

USER_NAME=u$UID_NUM
getent group "$USER_NAME" >/dev/null 2>&1 || addgroup -g "$UID_NUM" "$USER_NAME"
id "$USER_NAME" >/dev/null 2>&1 || adduser -D -H -u "$UID_NUM" -G "$USER_NAME" "$USER_NAME"

CG=/sys/fs/cgroup/appliance/$APP
for CONTROL in cpu memory pids; do
  grep -qw "$CONTROL" /sys/fs/cgroup/cgroup.controllers && echo "+$CONTROL" > /sys/fs/cgroup/cgroup.subtree_control
  grep -qw "$CONTROL" /sys/fs/cgroup/appliance/cgroup.controllers && echo "+$CONTROL" > /sys/fs/cgroup/appliance/cgroup.subtree_control
done
mkdir -p "$CG"
CPUS=$(printf '%s' "$REQ" | jq -r '.plan.resources.cpus')
MEM=$(printf '%s' "$REQ" | jq -r '.plan.resources.memoryMib')
PIDS=$(printf '%s' "$REQ" | jq -r '.plan.resources.pids')
echo "$((CPUS * 100000)) 100000" > "$CG/cpu.max"
echo "$((MEM * 1024 * 1024))" > "$CG/memory.max"
echo "$PIDS" > "$CG/pids.max"
for CONTROL in cpu memory pids; do
  grep -qw "$CONTROL" "$CG/cgroup.controllers" && echo "+$CONTROL" > "$CG/cgroup.subtree_control"
done

ip netns del "$NS" 2>/dev/null || true
ip netns add "$NS"
APP_IF=a$(printf '%s' "$APP" | sha256sum | cut -c1-10)
ip link del "$ROOT_IF" 2>/dev/null || true
ip link add "$ROOT_IF" type veth peer name "$APP_IF"
ip link set "$APP_IF" netns "$NS"
ip link set "$ROOT_IF" up
ip route replace "$IP/32" dev "$ROOT_IF"
ip netns exec "$NS" ip link set lo up
ip netns exec "$NS" ip addr add "$IP/32" dev "$APP_IF"
ip netns exec "$NS" ip link set "$APP_IF" up
ip netns exec "$NS" ip route add default dev "$APP_IF"
sysctl -q -w net.ipv4.ip_forward=1 net.ipv4.conf.eth0.proxy_arp=1 "net.ipv4.conf.$ROOT_IF.proxy_arp=1"
if ! nft list table inet appliance_runtime >/dev/null 2>&1; then nft add table inet appliance_runtime; fi
if ! nft list chain inet appliance_runtime principal_input >/dev/null 2>&1; then
  nft 'add chain inet appliance_runtime principal_input { type filter hook input priority -10; policy accept; }'
  nft add rule inet appliance_runtime principal_input ct state established,related accept
  nft add rule inet appliance_runtime principal_input iifname "r*" drop
fi
if ! nft list chain inet appliance_runtime principal_forward >/dev/null 2>&1; then
  nft 'add chain inet appliance_runtime principal_forward { type filter hook forward priority -10; policy accept; }'
  nft add rule inet appliance_runtime principal_forward iifname "r*" oifname != "eth0" drop
fi
if ! nft list chain inet appliance_runtime principal_spoof >/dev/null 2>&1; then
  nft 'add chain inet appliance_runtime principal_spoof { type filter hook forward priority -11; policy accept; }'
fi
nft add rule inet appliance_runtime principal_spoof iifname "$ROOT_IF" ip saddr != "$IP" drop
/usr/local/bin/runtime-principal-snat

ETH0_IP=$(ip -4 -o addr show dev eth0 | awk '{ split($4, address, "/"); print address[1]; exit }')
[ -n "$ETH0_IP" ] || { echo '{"state":"failed","message":"guest eth0 has no IPv4 address"}'; exit 2; }
rc-service containerd start >/dev/null 2>&1 || true
for _ in $(seq 1 50); do [ -S /run/containerd/containerd.sock ] && break; sleep 0.1; done

printf '%s' "$REQ" | jq -r '.plan.ports[] | [.relay,.guest] | @tsv' > "$STATE/ports.tsv"
while IFS="$(printf '\t')" read -r RELAY GUEST; do
  export RELAY GUEST ETH0_IP IP
  nohup setsid sh -c 'exec socat "TCP-LISTEN:$RELAY,bind=$ETH0_IP,reuseaddr,fork" "TCP:$IP:$GUEST"' \
    </dev/null >> "$STATE/relays.log" 2>&1 &
  echo $! >> "$STATE/relay.pids"
done < "$STATE/ports.tsv"

start_service() {
  SVC=$1
  SERVICE=$SERVICES/$SVC
  mkdir -p "$SERVICE"
  jq -c --arg svc "$SVC" '.plan.services[] | select(.name == $svc)' "$STATE/request.json" > "$SERVICE/plan.json"
  chmod 0600 "$SERVICE/plan.json"
  echo starting > "$SERVICE/state"
  echo none > "$SERVICE/health"
  echo 0 > "$SERVICE/restart-count"
  echo 0 > "$SERVICE/log-base"
  : > "$SERVICE/current.log"
  KIND=$(jq -r '.kind' "$SERVICE/plan.json")
  CID=appliance-$APP-$SVC
  SVC_CG=$CG/$SVC
  mkdir -p "$SVC_CG"
  SVC_CPUS=$(jq -r '.resources.cpus' "$SERVICE/plan.json")
  SVC_MEM=$(jq -r '.resources.memoryMib' "$SERVICE/plan.json")
  SVC_PIDS=$(jq -r '.resources.pids' "$SERVICE/plan.json")
  echo "$((SVC_CPUS * 100000)) 100000" > "$SVC_CG/cpu.max"
  echo "$((SVC_MEM * 1024 * 1024))" > "$SVC_CG/memory.max"
  echo "$SVC_PIDS" > "$SVC_CG/pids.max"
  if [ "$KIND" = container ]; then
    IMAGE_PATH=$(jq -r '.imagePath' "$SERVICE/plan.json")
    case "/$IMAGE_PATH/" in /payload/*) ;; *) echo failed > "$SERVICE/state"; return 1;; esac
    case "/$IMAGE_PATH/" in *'/../'*|*'/./'*|*'\\'*) echo failed > "$SERVICE/state"; return 1;; esac
    case "$(uname -m)" in
      aarch64|arm64) OCI_PLATFORM=linux/arm64;;
      x86_64|amd64) OCI_PLATFORM=linux/amd64;;
      *) echo failed > "$SERVICE/state"; return 1;;
    esac
    set +e
    IMPORT_OUTPUT=$(ctr -n "$CTR_NS" images import --local --platform "$OCI_PLATFORM" \
      --base-name "appliance.local/$APP/$SVC" "$SHARE/$IMAGE_PATH" 2>&1)
    IMPORT_CODE=$?
    set -e
    printf '%s\n' "$IMPORT_OUTPUT" >> "$SERVICE/current.log"
    [ "$IMPORT_CODE" -eq 0 ] || { echo failed > "$SERVICE/state"; return 1; }
    IMAGE=$(printf '%s\n' "$IMPORT_OUTPUT" | awk '$NF == "saved" { print $1; exit }')
    [ -n "$IMAGE" ] || IMAGE=$(printf '%s\n' "$IMPORT_OUTPUT" | awk '$1 == "unpacking" { print $2; exit }')
    [ -n "$IMAGE" ] || { echo failed > "$SERVICE/state"; return 1; }
    echo "$IMAGE" > "$SERVICE/image"
    jq -r '.env | to_entries[] | [.key,(.value|@base64)] | @tsv' "$SERVICE/plan.json" > "$SERVICE/env.tsv"
    chmod 0600 "$SERVICE/env.tsv"
    : > "$SERVICE/args.txt"
  elif [ "$KIND" = binary ]; then
    BINARY_PATH=$(jq -r '.target.path' "$SERVICE/plan.json")
    ENTRYPOINT=$(jq -r '.target.entrypoint' "$SERVICE/plan.json")
    BINARY_CWD=$(jq -r '.target.cwd' "$SERVICE/plan.json")
    SOURCE=$SHARE/$BINARY_PATH
    STAGED=$SERVICE/rootfs
    [ -d "$SOURCE" ] && [ ! -L "$SOURCE" ] || { echo failed > "$SERVICE/state"; return 1; }
    find "$SOURCE" -type l -print -quit | grep -q . && { echo failed > "$SERVICE/state"; return 1; }
    find "$SOURCE" ! -type d ! -type f -print -quit | grep -q . && { echo failed > "$SERVICE/state"; return 1; }
    mkdir -p "$STAGED"
    cp -a "$SOURCE/." "$STAGED/"
    [ -f "$STAGED/$ENTRYPOINT" ] && [ ! -L "$STAGED/$ENTRYPOINT" ] || { echo failed > "$SERVICE/state"; return 1; }
    chmod 0755 "$STAGED/$ENTRYPOINT"
    case "$BINARY_CWD" in .) BINARY_CWD=/;; *) BINARY_CWD=/$BINARY_CWD;; esac
    [ -d "$STAGED$BINARY_CWD" ] || { echo failed > "$SERVICE/state"; return 1; }
    printf '%s\n' "$ENTRYPOINT" > "$SERVICE/entrypoint"
    printf '%s\n' "$BINARY_CWD" > "$SERVICE/cwd"
    jq -r '.target.env | to_entries[] | [.key,(.value|@base64)] | @tsv' "$SERVICE/plan.json" > "$SERVICE/env.tsv"
    chmod 0600 "$SERVICE/env.tsv"
    jq -r '.target.args[] | @base64' "$SERVICE/plan.json" > "$SERVICE/args.txt"
  else echo failed > "$SERVICE/state"; return 1; fi

  EGRESS_CA=/usr/local/share/ca-certificates/appliance-egress.crt
  if grep -q "^APPLIANCE_EGRESS_CA$(printf '\t')" "$SERVICE/env.tsv" && [ ! -f "$EGRESS_CA" ]; then
    echo failed > "$SERVICE/state"
    echo 1 > "$SERVICE/exit-code"
    echo 'egress CA certificate is unavailable' >> "$SERVICE/current.log"
    echo 1 > "$STATE/ca-missing"
    return 1
  fi
  if [ "$KIND" = binary ] && grep -q "^APPLIANCE_EGRESS_CA$(printf '\t')" "$SERVICE/env.tsv" && [ -f "$EGRESS_CA" ]; then
    cp "$EGRESS_CA" "$STAGED/appliance-egress-ca.pem"
    chown "$UID_NUM:$UID_NUM" "$STAGED/appliance-egress-ca.pem"
    chmod 0444 "$STAGED/appliance-egress-ca.pem"
  fi

  jq -r '
    .plan.services[] |
    .name as $service |
    (.ports // [])[] |
    . as $port |
    ("APPLIANCE_SVC_" + ($service | ascii_upcase | gsub("-"; "_"))) as $prefix |
    ([($prefix + "_" + ($port.name | ascii_upcase | gsub("-"; "_")) + "_URL"),
      (if $port.primary then ($prefix + "_URL") else empty end)][]) as $key |
    [$key, (("http://127.0.0.1:" + ($port.guest | tostring)) | @base64)] | @tsv
  ' "$STATE/request.json" >> "$SERVICE/env.tsv"

  : > "$SERVICE/ctr.env"
  CR=$(printf '\rx'); CR=${CR%x}
  LF=$(printf '\nx'); LF=${LF%x}
  while IFS="$(printf '\t')" read -r KEY VALUE; do
    case "$KEY" in HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy) ;; *) continue;; esac
    DECODED=$(printf '%s' "$VALUE" | base64 -d; printf x); DECODED=${DECODED%x}
    case "$DECODED" in *"$CR"*|*"$LF"*)
      echo failed > "$SERVICE/state"
      echo 'proxy environment values must not contain newlines' >> "$SERVICE/current.log"
      return 1
      ;;
    esac
    printf '%s=%s\n' "$KEY" "$DECODED" >> "$SERVICE/ctr.env"
  done < "$SERVICE/env.tsv"

  export APP SVC STATE SERVICE SERVICES CTR_NS NS CG UID_NUM KIND CID EGRESS_CA
  nohup setsid sh -c '
    echo $$ > "$SERVICE/worker.pid"
    ATTEMPT=0
    while true; do
      DESIRED=$(cat "$STATE/desired" 2>/dev/null || echo stopped)
      [ "$DESIRED" = starting ] || [ "$DESIRED" = running ] || [ "$DESIRED" = degraded ] || exit 0
      echo starting > "$SERVICE/state"
      echo starting > "$SERVICE/health"
      rm -f "$SERVICE/exit-code"
      STARTED=$(date +%s)
      set -- \
        --cap-drop CAP_CHOWN --cap-drop CAP_DAC_OVERRIDE --cap-drop CAP_FSETID \
        --cap-drop CAP_FOWNER --cap-drop CAP_MKNOD --cap-drop CAP_NET_RAW \
        --cap-drop CAP_SETGID --cap-drop CAP_SETUID --cap-drop CAP_SETFCAP \
        --cap-drop CAP_SETPCAP --cap-drop CAP_NET_BIND_SERVICE \
        --cap-drop CAP_SYS_CHROOT --cap-drop CAP_KILL --cap-drop CAP_AUDIT_WRITE
      while IFS="$(printf "\t")" read -r KEY VALUE; do
        case "$KEY" in HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy) continue;; esac
        DECODED=$(printf "%s" "$VALUE" | base64 -d; printf x); DECODED=${DECODED%x}
        set -- "$@" --env "$KEY=$DECODED"
      done < "$SERVICE/env.tsv"
      [ ! -s "$SERVICE/ctr.env" ] || set -- "$@" --env-file "$SERVICE/ctr.env"
      if [ "$KIND" = container ] && grep -q "^APPLIANCE_EGRESS_CA$(printf "\t")" "$SERVICE/env.tsv" && [ -f "$EGRESS_CA" ]; then
        set -- "$@" --mount type=bind,src="$EGRESS_CA",dst=/appliance-egress-ca.pem,options=rbind:ro
      fi
      set +e
      if [ "$KIND" = container ]; then
        IMAGE=$(cat "$SERVICE/image")
        ctr -n "$CTR_NS" run --rm --user "$UID_NUM:$UID_NUM" --cgroup "appliance/$APP/$SVC" --seccomp --with-ns "network:/var/run/netns/$NS" "$@" "$IMAGE" "$CID" >> "$SERVICE/current.log" 2>&1 &
      else
        ENTRYPOINT=$(cat "$SERVICE/entrypoint"); BINARY_CWD=$(cat "$SERVICE/cwd")
        set -- "$@" --rootfs --cwd "$BINARY_CWD" "$SERVICE/rootfs" "$CID" "/$ENTRYPOINT"
        while IFS= read -r VALUE; do DECODED=$(printf "%s" "$VALUE" | base64 -d); set -- "$@" "$DECODED"; done < "$SERVICE/args.txt"
        ctr -n "$CTR_NS" run --rm --user "$UID_NUM:$UID_NUM" --cgroup "appliance/$APP/$SVC" --seccomp --with-ns "network:/var/run/netns/$NS" "$@" >> "$SERVICE/current.log" 2>&1 &
      fi
      RUNNER=$!
      set -e
      TASK_PID=
      for _ in $(seq 1 100); do
        TASK_PID=$(ctr -n "$CTR_NS" tasks list 2>/dev/null | grep "^$CID " | tr -s " " | cut -d " " -f2)
        [ -n "$TASK_PID" ] && break
        kill -0 "$RUNNER" 2>/dev/null || break
        sleep 0.1
      done
      FAILED_HEALTH=0
      if [ -n "$TASK_PID" ] && grep -qx "$TASK_PID" "$CG/$SVC/cgroup.procs"; then
        HEALTH_TYPE=$(jq -r ".health.type // \"none\"" "$SERVICE/plan.json")
        INTERVAL=$(jq -r ".health.intervalSeconds // 5" "$SERVICE/plan.json")
        TIMEOUT=$(jq -r ".health.timeoutSeconds // 2" "$SERVICE/plan.json")
        THRESHOLD=$(jq -r ".health.failureThreshold // 3" "$SERVICE/plan.json")
        FAILURES=0
        while kill -0 "$RUNNER" 2>/dev/null; do
          OK=0
          case "$HEALTH_TYPE" in
            none) OK=1;;
            http)
              PORT=$(jq -r ".health.port" "$SERVICE/plan.json"); PATH_PART=$(jq -r ".health.path" "$SERVICE/plan.json")
              ip netns exec "$NS" wget -q -T "$TIMEOUT" --spider "http://127.0.0.1:$PORT$PATH_PART" && OK=1 || true
              ;;
            tcp)
              PORT=$(jq -r ".health.port" "$SERVICE/plan.json")
              ip netns exec "$NS" timeout "$TIMEOUT" socat - "TCP:127.0.0.1:$PORT,connect-timeout=$TIMEOUT" </dev/null >/dev/null 2>&1 && OK=1 || true
              ;;
            exec)
              set --
              jq -r ".health.command[] | @base64" "$SERVICE/plan.json" | while IFS= read -r ARG; do printf "%s\n" "$ARG"; done > "$SERVICE/health.args"
              while IFS= read -r ARG; do DECODED=$(printf "%s" "$ARG" | base64 -d); set -- "$@" "$DECODED"; done < "$SERVICE/health.args"
              timeout "$TIMEOUT" ctr -n "$CTR_NS" tasks exec --exec-id "health-$$-$(date +%s%N)" "$CID" "$@" >/dev/null 2>&1 && OK=1 || true
              ;;
          esac
          if [ "$OK" -eq 1 ]; then
            FAILURES=0
            [ "$HEALTH_TYPE" = none ] && echo running > "$SERVICE/health" || echo healthy > "$SERVICE/health"
            [ "$HEALTH_TYPE" = none ] && echo running > "$SERVICE/state" || echo healthy > "$SERVICE/state"
          else
            FAILURES=$((FAILURES + 1))
            echo unhealthy > "$SERVICE/health"
            if [ "$FAILURES" -ge "$THRESHOLD" ]; then
              FAILED_HEALTH=1
              ctr -n "$CTR_NS" tasks kill -s SIGTERM "$CID" >/dev/null 2>&1 || true
              sleep 1
              ctr -n "$CTR_NS" tasks kill -s SIGKILL "$CID" >/dev/null 2>&1 || true
              break
            fi
          fi
          sleep "$INTERVAL"
        done
      fi
      set +e; wait "$RUNNER"; CODE=$?; set -e
      [ "$FAILED_HEALTH" -eq 0 ] || CODE=1
      echo "$CODE" > "$SERVICE/exit-code"
      NOW=$(date +%s)
      [ "$((NOW - STARTED))" -lt 60 ] || ATTEMPT=0
      POLICY=$(jq -r ".restart.policy" "$SERVICE/plan.json")
      MAX=$(jq -r ".restart.maxAttempts" "$SERVICE/plan.json")
      BASE=$(jq -r ".restart.backoffSeconds" "$SERVICE/plan.json")
      DESIRED=$(cat "$STATE/desired" 2>/dev/null || echo stopped)
      [ "$DESIRED" = starting ] || [ "$DESIRED" = running ] || [ "$DESIRED" = degraded ] || exit 0
      RESTART=0
      [ "$POLICY" = always ] && RESTART=1
      [ "$POLICY" = on-failure ] && [ "$CODE" -ne 0 ] && RESTART=1
      if [ "$RESTART" -eq 0 ] || [ "$ATTEMPT" -ge "$MAX" ]; then
        [ "$CODE" -eq 0 ] && echo exited > "$SERVICE/state" || echo failed > "$SERVICE/state"
        exit 0
      fi
      ATTEMPT=$((ATTEMPT + 1))
      echo "$ATTEMPT" > "$SERVICE/restart-count"
      echo restarting > "$SERVICE/state"
      DELAY=$BASE; N=1
      while [ "$N" -lt "$ATTEMPT" ]; do DELAY=$((DELAY * 2)); N=$((N + 1)); done
      [ "$DELAY" -le 30 ] || DELAY=30
      sleep "$DELAY"
    done
  ' </dev/null >/dev/null 2>&1 &
}

START_FAILED=
DEGRADED=0
jq -r '.plan.services[].name' "$STATE/request.json" | while read -r SVC; do
  SERVICE=$SERVICES/$SVC
  mkdir -p "$SERVICE"
  BLOCKED=0
  jq -r --arg svc "$SVC" '.plan.services[] | select(.name == $svc) | .dependsOn[]' "$STATE/request.json" | while read -r DEP; do
    service_ready "$DEP" || exit 1
  done || BLOCKED=1
  if [ "$BLOCKED" -eq 1 ]; then
    echo blocked > "$SERVICE/state"
  else
    start_service "$SVC" || true
    for _ in $(seq 1 1200); do
      SVC_STATE=$(cat "$SERVICE/state" 2>/dev/null || echo starting)
      case "$SVC_STATE" in running|healthy|failed|exited|blocked) break;; esac
      sleep 0.25
    done
  fi
  SVC_STATE=$(cat "$SERVICE/state" 2>/dev/null || echo failed)
  case "$SVC_STATE" in running|healthy) ;;
    *)
      REQUIRED=$(jq -r --arg svc "$SVC" '.plan.services[] | select(.name == $svc) | .required' "$STATE/request.json")
      if [ "$REQUIRED" = true ]; then echo "$SVC" > "$STATE/start-failed"; exit 1; else echo 1 > "$STATE/degraded"; fi
      ;;
  esac
done || START_FAILED=$(cat "$STATE/start-failed" 2>/dev/null || echo unknown)

if [ -n "$START_FAILED" ]; then
  if [ -f "$STATE/ca-missing" ]; then
    stop_all failed
    echo '{"state":"failed","message":"egress CA certificate is unavailable"}'
    exit 0
  fi
  START_EXIT=$(cat "$SERVICES/$START_FAILED/exit-code" 2>/dev/null || echo 1)
  case "$START_EXIT" in ''|*[!0-9]*|-*) START_EXIT=1;; esac
  echo "$START_FAILED" > "$STATE/culprit"
  echo "$START_EXIT" > "$STATE/exit-code"
  stop_all failed
  jq -nc --arg culprit "$START_FAILED" --argjson exitCode "$START_EXIT" \
    '{state:"failed", culprit:$culprit, exitCode:$exitCode, message:("required service " + $culprit + " failed readiness")}'
  exit 0
fi
[ -f "$STATE/degraded" ] && DEGRADED=1
[ "$DEGRADED" -eq 1 ] && echo degraded > "$STATE/desired" || echo running > "$STATE/desired"

export APP STATE SERVICES
nohup setsid sh -c '
  echo $$ > "$STATE/monitor.pid"
  while true; do
    DESIRED=$(cat "$STATE/desired" 2>/dev/null || echo stopped)
    [ "$DESIRED" = running ] || [ "$DESIRED" = degraded ] || exit 0
    CULPRIT=
    rm -f "$STATE/failed-service"
    : > "$STATE/clean-required"
    REQUIRED_TOTAL=$(jq "[.plan.services[] | select(.required)] | length" "$STATE/request.json")
    jq -r ".plan.services[] | select(.required) | .name" "$STATE/request.json" | while read -r SVC; do
      SVC_STATE=$(cat "$SERVICES/$SVC/state" 2>/dev/null || echo failed)
      case "$SVC_STATE" in
        failed|blocked)
          echo "$SVC" > "$STATE/failed-service"
          exit 1
          ;;
        exited)
          EXIT_CODE=$(cat "$SERVICES/$SVC/exit-code" 2>/dev/null || echo 1)
          POLICY=$(jq -r --arg svc "$SVC" ".plan.services[] | select(.name == \$svc) | .restart.policy" "$STATE/request.json")
          if [ "$EXIT_CODE" = 0 ] && [ "$POLICY" = never ]; then
            echo "$SVC" >> "$STATE/clean-required"
          else
            echo "$SVC" > "$STATE/failed-service"
            exit 1
          fi
          ;;
      esac
    done || CULPRIT=$(cat "$STATE/failed-service" 2>/dev/null || echo unknown)
    if [ -n "$CULPRIT" ]; then
      FAIL_REQ=$(printf "{\"action\":\"fail\",\"appId\":\"%s\",\"service\":\"%s\"}" "$APP" "$CULPRIT")
      /usr/local/bin/appliance-runtime-compound-supervisor "$FAIL_REQ" >/dev/null 2>&1
      exit 0
    fi
    CLEAN_REQUIRED=$(wc -l < "$STATE/clean-required" 2>/dev/null || echo 0)
    if [ "$REQUIRED_TOTAL" -gt 0 ] && [ "$CLEAN_REQUIRED" -eq "$REQUIRED_TOTAL" ]; then
      COMPLETE_REQ=$(printf "{\"action\":\"complete\",\"appId\":\"%s\"}" "$APP")
      /usr/local/bin/appliance-runtime-compound-supervisor "$COMPLETE_REQ" >/dev/null 2>&1
      exit 0
    fi
    OPTIONAL_FAILED=0
    jq -r ".plan.services[] | select(.required == false) | .name" "$STATE/request.json" | while read -r SVC; do
      SVC_STATE=$(cat "$SERVICES/$SVC/state" 2>/dev/null || echo failed)
      case "$SVC_STATE" in failed|exited|blocked) exit 1;; esac
    done || OPTIONAL_FAILED=1
    [ "$OPTIONAL_FAILED" -eq 0 ] || echo degraded > "$STATE/desired"
    sleep 0.5
  done
' </dev/null >/dev/null 2>&1 &

status
"#;

pub(crate) const RUNTIME_PROVISION: &str = r#"# Runtime pool: containerd is the only workload engine. No dockerd,
# k3s, registry, BuildKit, Node, or development toolchain is installed.
if ! SOCAT_SELF_CHECK=$(socat -V 2>&1); then
  echo "appliance-runtime: socat self-check failed; offline Runtime APK set is ABI-inconsistent"
  printf '%s\n' "$SOCAT_SELF_CHECK"
  exit 1
fi
rc-service containerd start >/var/log/appliance-runtime-containerd.log 2>&1 || true
mkdir -p /persist/runtime/apps /run/appliance/shares /sys/fs/cgroup/appliance
find /persist/runtime/apps -type f \( -name pid -o -name relay.pids -o -name logcap.pid \) -delete
for CONTROL in cpu memory pids; do
  grep -qw "$CONTROL" /sys/fs/cgroup/cgroup.controllers && echo "+$CONTROL" > /sys/fs/cgroup/cgroup.subtree_control
  grep -qw "$CONTROL" /sys/fs/cgroup/appliance/cgroup.controllers && echo "+$CONTROL" > /sys/fs/cgroup/appliance/cgroup.subtree_control
done
echo "appliance-runtime: supervisor ready"
"#;

/// Build the apkovl (Alpine "local backup" overlay tarball): openrc
/// runlevel wiring, networking config, the world file driving package
/// installs at boot, and the appliance.start bootstrap.
#[allow(clippy::too_many_arguments)]
#[cfg(test)]
fn build_apkovl(
    registry_host_port: u16,
    egress_ca_pem: Option<&str>,
    dev: bool,
    mount: bool,
    docker: bool,
    egress_port: u16,
    agent_only: bool,
    // Sasha #2: a stable identity (hash of the mounted project path) the
    // guest compares to decide whether to wipe /persist/npm-global on a
    // project switch. Empty ⇒ no mount ⇒ no wipe.
    project_id: &str,
    // Host ingress port for deploy-result URLs (spec.host_port),
    // embedded into the guest api-server's base config.
    host_port: u16,
    // The VM's bootstrap token (`ensure_bootstrap_token`); baked into
    // the overlay at /etc/appliance/bootstrap-token (0600). Empty when
    // the api-server isn't provisioned.
    bootstrap_token: &str,
    // Whether the boot media carries the staged api-server binary; the
    // provision block is only injected when it does.
    apiserver: bool,
) -> Result<Vec<u8>> {
    let release_gate = apiserver.then_some(ReleaseGate {
        pinned_key_id: "",
        evidence: None,
        poison: false,
    });
    build_apkovl_for_readiness(
        registry_host_port,
        egress_ca_pem,
        dev,
        mount,
        docker,
        egress_port,
        readiness_for(agent_only, !agent_only, dev),
        project_id,
        host_port,
        bootstrap_token,
        release_gate,
    )
}

#[allow(clippy::too_many_arguments)]
fn build_apkovl_for_readiness(
    registry_host_port: u16,
    egress_ca_pem: Option<&str>,
    dev: bool,
    mount: bool,
    docker: bool,
    egress_port: u16,
    readiness: HostReadiness,
    project_id: &str,
    host_port: u16,
    bootstrap_token: &str,
    release_gate: Option<ReleaseGate<'_>>,
) -> Result<Vec<u8>> {
    if let Some(gate) = release_gate {
        gate.validate()?;
    }
    let agent_only = readiness == HostReadiness::Agent;
    let runtime = readiness == HostReadiness::Runtime;
    let cluster = readiness == HostReadiness::K3s;
    let gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut tar = tar::Builder::new(gz);

    let mut file = |path: &str, mode: u32, data: &[u8]| -> Result<()> {
        let mut header = tar::Header::new_gnu();
        header.set_size(data.len() as u64);
        header.set_mode(mode);
        header.set_mtime(0);
        header.set_cksum();
        tar.append_data(&mut header, path, data)?;
        Ok(())
    };

    file("etc/hostname", 0o644, b"appliance\n")?;
    file(
        "etc/network/interfaces",
        0o644,
        b"auto lo\niface lo inet loopback\n\nauto eth0\niface eth0 inet dhcp\n",
    )?;
    // Packages the diskless init installs from the network repo while
    // building the root. alpine-base brings openrc + busybox userland;
    // e2fsprogs provides mkfs.ext4 for the data disk; ca-certificates
    // lets containerd pull from TLS registries.
    // socat backs the vsock shell agent (appliance-vm shell); it's tiny
    // and gives every VM a k3s-independent host shell.
    // sudo gives the non-root `appliance` user passwordless escalation
    // (wheel + /etc/sudoers.d); the diskless init installs it from the
    // network repo before appliance.start provisions the user.
    // tmux backs the reattachable shell sessions (appliance vm shell
    // --session / sessions): an in-guest multiplexer whose named sessions
    // survive a client disconnect + desktop restart. Unconditional, like
    // the shell agent itself — every VM, not just dev VMs.
    // libstdc++/libgcc back the bun-compiled api-server binary; unzip
    // (zipinfo included) backs its server-side build pipeline. All three
    // are small and ride every VM so the world file stays static.
    let world = if runtime {
        format!("{}\n", crate::images::RUNTIME_WORLD.join("\n"))
    } else {
        "alpine-base\ne2fsprogs\nca-certificates\nbusybox-extras\nsocat\nsudo\ntmux\nlibstdc++\nlibgcc\nunzip\n".to_string()
    };
    file("etc/apk/world", 0o644, world.as_bytes())?;
    let apk_repositories = if runtime {
        "/media/vdc/apks/main\n/media/vdc/apks/community\n".to_string()
    } else {
        format!(
            "https://dl-cdn.alpinelinux.org/alpine/{ALPINE_BRANCH}/main\nhttps://dl-cdn.alpinelinux.org/alpine/{ALPINE_BRANCH}/community\n"
        )
    };
    file("etc/apk/repositories", 0o644, apk_repositories.as_bytes())?;
    // cgroups v2 unified hierarchy — kubelet requires it.
    file(
        "etc/rc.conf",
        0o644,
        b"rc_cgroup_mode=\"unified\"\nrc_logger=\"YES\"\n",
    )?;
    // The non-root appliance user is provisioned on every VM. uid/gid
    // are pinned here: the host user's own ids on a VirtioFS-mounted VM
    // (so the shared workspace stays writable), 1000 otherwise.
    let (host_uid, host_gid) = host_ids();
    let (app_uid, app_gid) = resolve_app_ids(mount, host_uid, host_gid);
    let app_user_provision = APP_USER_PROVISION
        .replace("__APP_UID__", &app_uid.to_string())
        .replace("__APP_GID__", &app_gid.to_string());
    file(
        "etc/local.d/appliance.start",
        0o755,
        APPLIANCE_START
            // Quinn gap #1: inject the k3s-or-agent branch FIRST. Both
            // branches carry nested markers — k3s carries
            // __KUBECONFIG_PORT__/__REGISTRY_NODEPORT__/__REGISTRY_HOST_PORT__,
            // the agent handoff carries __KUBECONFIG_PORT__ +
            // __AGENT_DOCKER_STUB__ — so the branch must land before the
            // port/stub substitutions below expand those nested markers.
            // Substituting it after the ports (the old order) would leave
            // an injected __KUBECONFIG_PORT__ as a literal.
            .replace(
                "__K3S_PROVISION__",
                &match readiness {
                    HostReadiness::Core => String::new(),
                    HostReadiness::Runtime => String::new(),
                    HostReadiness::Agent => AGENT_HANDOFF.to_string(),
                    HostReadiness::K3s => format!("{K3S_MEDIA_COPY}{K3S_COMMON}"),
                },
            )
            .replace(
                "__AGENT_DOCKER_STUB__",
                if agent_only && !docker { AGENT_DOCKER_STUB } else { "" },
            )
            // BuildKit rides every k3s VM (agent-only VMs have no
            // registry to push to). Injected before the port
            // substitutions below — it carries nested
            // __REGISTRY_HOST_PORT__/__REGISTRY_NODEPORT__/
            // __BUILDKITD_GUEST_PORT__ markers (Quinn gap #1, same as
            // the k3s branch).
            .replace(
                "__BUILDKIT_PROVISION__",
                if cluster { BUILDKIT_PROVISION } else { "" },
            )
            // The api-server guest binary rides k3s VMs whose media
            // carries the staged binary. Injected before the port
            // substitutions — it carries nested __HOST_PORT__/
            // __REGISTRY_HOST_PORT__/__APISERVER_GUEST_PORT__ markers
            // (Quinn gap #1, same as the k3s branch).
            .replace(
                "__APISERVER_PROVISION__",
                &if !cluster || release_gate.is_none() {
                    String::new()
                } else {
                    format!(
                        "{APISERVER_MEDIA_COPY}{}{APISERVER_COMMON}",
                        apiserver_seed_copy()
                    )
                },
            )
            .replace(
                "__CONTROL_PLANE_PROVISION__",
                if cluster && release_gate.is_some() { VZ_CONTROL_PLANE_PROVISION } else { "" },
            )
            .replace(
                "__ARTIFACT_PROVISION__",
                if cluster && release_gate.is_some() { VZ_ARTIFACT_PROVISION } else { "" },
            )
            // vz boot media: arm the guest-side probe for the
            // platform-images media. Harmless when the media wasn't
            // attached (the probe finds no label and k3s pulls from the
            // network); the WSL bootstrap substitutes this to empty.
            .replace("__K3S_AIRGAP_PREAMBLE__", "APPLIANCE_AIRGAP_PROBE=1")
            .replace("__APISERVER_GUEST_PORT__", &API_SERVER_GUEST_PORT.to_string())
            .replace(
                "__PINNED_RELEASE_KEY_ID__",
                release_gate.map_or("", |gate| gate.pinned_key_id),
            )
            // Writer-version stamp on the guest's base config, logged by
            // the api-server on parse — makes engine/guest schema drift
            // visible in the server log (incident B follow-up).
            .replace("__BASE_CONFIG_VERSION__", env!("CARGO_PKG_VERSION"))
            .replace("__HOST_PORT__", &host_port.to_string())
            .replace("__KUBECONFIG_PORT__", &KUBECONFIG_PORT.to_string())
            .replace("__REGISTRY_NODEPORT__", &REGISTRY_NODEPORT.to_string())
            .replace("__REGISTRY_HOST_PORT__", &registry_host_port.to_string())
            .replace("__BUILDKITD_GUEST_PORT__", &BUILDKITD_GUEST_PORT.to_string())
            .replace("__SHELL_VSOCK_PORT__", &SHELL_VSOCK_PORT.to_string())
            .replace("__ARTIFACT_VSOCK_PORT__", &ARTIFACT_VSOCK_PORT.to_string())
            .replace("__AGENT_IMAGE_DEVICE__", VZ_AGENT_IMAGE_DEVICE)
            .replace("__APP_USER_PROVISION__", &app_user_provision)
            .replace("__DEV_PROVISION__", if dev { DEV_PROVISION } else { "" })
            .replace("__RUNTIME_PROVISION__", if runtime { RUNTIME_PROVISION } else { "" })
            .replace("__DEV_MOUNT__", if dev && mount { DEV_MOUNT } else { "" })
            .replace("__DOCKER_PROVISION__", if docker { DOCKER_PROVISION } else { "" })
            .replace("__EGRESS_PORT__", &egress_port.to_string())
            // PATH-first for the read-only squashfs `bin` (agent-only VMs):
            // the baked CLIs win and can't be shadowed. Expanded AFTER the
            // block injections above so the marker inside DEV_PROVISION /
            // APP_USER_PROVISION resolves. Empty for non-agent VMs (no
            // squashfs), where the nonexistent dir would just be skipped.
            .replace(
                "__AGENT_BIN_PATH__",
                if agent_only { "/opt/appliance/agents/bin:" } else { "" },
            )
            // The mounted project's identity for the npm-global wipe (Sasha
            // #2). Expanded after the agent handoff is injected.
            .replace("__PROJECT_ID__", project_id)
            .as_bytes(),
    )?;
    // The vsock shell agent (socat EXEC target). Always present — every
    // VM gets a k3s-independent host shell.
    file("usr/local/bin/appliance-shell-agent", 0o755, SHELL_AGENT.as_bytes())?;
    let artifact_agent = crate::backend::runtime_guest::control_plane_artifact_agent();
    file(
        "usr/local/bin/appliance-control-plane-artifact-agent",
        0o700,
        artifact_agent.as_bytes(),
    )?;
    file(
        "usr/local/bin/appliance-control-plane-supervisor",
        0o700,
        CONTROL_PLANE_SUPERVISOR.as_bytes(),
    )?;
    let control_plane_update = CONTROL_PLANE_UPDATE.replace(
        "__PINNED_RELEASE_KEY_ID__",
        release_gate.map_or("", |gate| gate.pinned_key_id),
    );
    file(
        "usr/local/bin/appliance-control-plane-update",
        0o700,
        control_plane_update.as_bytes(),
    )?;
    file(
        "usr/local/bin/appliance-runtime-supervisor",
        0o755,
        RUNTIME_SUPERVISOR.as_bytes(),
    )?;
    file(
        "usr/local/bin/appliance-runtime-compound-supervisor",
        0o755,
        RUNTIME_COMPOUND_SUPERVISOR.as_bytes(),
    )?;
    file(
        "usr/local/bin/runtime-share-mount",
        0o755,
        crate::backend::runtime_guest::runtime_share_mount_script(
            crate::backend::runtime_guest::RuntimeGuestBackend::VirtioFs,
        )
        .as_bytes(),
    )?;
    file(
        "usr/local/bin/runtime-share-unmount",
        0o755,
        crate::backend::runtime_guest::runtime_share_unmount_script().as_bytes(),
    )?;
    file(
        "usr/local/bin/runtime-principal-snat",
        0o755,
        crate::backend::runtime_guest::runtime_principal_snat_script(
            crate::backend::runtime_guest::RuntimeGuestBackend::VirtioFs,
            None,
            egress_port,
        )
        ?
        .as_bytes(),
    )?;
    // Transparent tmux config for the agent's reattachable sessions.
    file("etc/appliance/tmux.conf", 0o644, TMUX_CONF.as_bytes())?;
    // The bootstrap token the guest api-server verifies create-key
    // requests against. Root-only, exactly like the host-side copy.
    // Gated like the provision block itself — agent-only VMs carry no
    // control plane and therefore no secret.
    if cluster && release_gate.is_some() && !bootstrap_token.is_empty() {
        file("etc/appliance/bootstrap-token", 0o600, bootstrap_token.as_bytes())?;
    }

    // The per-VM egress CA, trusted node-wide by appliance.start's
    // update-ca-certificates step. Placed even when interception is
    // off — harmless until the proxy actually intercepts.
    if let Some(pem) = egress_ca_pem {
        file("usr/local/share/ca-certificates/appliance-egress.crt", 0o644, pem.as_bytes())?;
    }

    // openrc runlevels. Normally `lbu` captures these from a
    // setup-alpine'd system; we declare the minimal diskless set by
    // hand. Symlink targets resolve once the packages are installed.
    let mut links: Vec<(String, &str)> = Vec::new();
    for svc in ["devfs", "dmesg", "mdev", "hwdrivers", "modloop", "cgroups"] {
        links.push((format!("etc/runlevels/sysinit/{svc}"), "/etc/init.d/"));
    }
    for svc in ["modules", "sysctl", "hostname", "bootmisc", "syslog"] {
        links.push((format!("etc/runlevels/boot/{svc}"), "/etc/init.d/"));
    }
    for svc in ["networking", "local"] {
        links.push((format!("etc/runlevels/default/{svc}"), "/etc/init.d/"));
    }
    for svc in ["mount-ro", "killprocs", "savecache"] {
        links.push((format!("etc/runlevels/shutdown/{svc}"), "/etc/init.d/"));
    }
    for (path, target_dir) in links {
        let svc = path.rsplit('/').next().unwrap().to_string();
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        header.set_mode(0o777);
        header.set_mtime(0);
        header.set_cksum();
        tar.append_link(&mut header, path, format!("{target_dir}{svc}"))?;
    }

    let gz = tar.into_inner()?;
    Ok(gz.finish()?)
}

/// Assemble the FAT32 boot-media image. Rebuilt whenever inputs
/// change is overkill for now — we rebuild on every `up`/`run`; it
/// takes well under a second and guarantees the media matches the
/// code that produced it.
#[allow(clippy::too_many_arguments)]
pub fn build_boot_media(
    vm_dir: &Path,
    registry_host_port: u16,
    dev: bool,
    // The mounted host project (`spec.dev_mount`), or `None` when no folder
    // is shared. Its presence drives the dev mount; a hash of its path is the
    // project identity the guest uses to wipe npm-global on a switch (Sasha
    // #2).
    mount_path: Option<&str>,
    docker: bool,
    egress_port: u16,
    agent_only: bool,
    cluster: bool,
    // Host ingress port (spec.host_port) — embedded in the guest
    // api-server's base config for deploy-result URLs.
    host_port: u16,
    // Trust pin supplied by the CLI from PINNED_RELEASE_TRUST. This is
    // deliberately independent of the release sidecar carried on media.
    pinned_release_key_id: &str,
) -> Result<BootMedia> {
    validate_pinned_release_key_id(pinned_release_key_id)?;
    let readiness = readiness_for(agent_only, cluster, dev);
    let (alpine_arch, _) = arch_tuple()?;
    let modloop = ensure_modloop()?;
    let runtime_repositories = if readiness == HostReadiness::Runtime {
        crate::bringup::hostlog("mirroring signed Alpine packages into Runtime boot media");
        crate::images::ensure_runtime_apk_repositories()?
    } else {
        Vec::new()
    };
    let k3s = if readiness == HostReadiness::K3s {
        Some(ensure_k3s()?.0)
    } else {
        None
    };
    // The CLI-staged api-server binary + console bundle (guest control
    // plane). Optional by contract: agent-only VMs never carry them,
    // and an engine invoked without the CLI simply boots without a
    // control plane (the guest logs that honestly).
    let apiserver = if readiness == HostReadiness::K3s { apiserver_assets() } else { None };
    let release_gate = ReleaseGate::from_assets(pinned_release_key_id, apiserver.as_ref());
    let bootstrap_token = if apiserver.is_some() {
        ensure_bootstrap_token(vm_dir)?
    } else {
        String::new()
    };
    // Generate (once) and bake the per-VM egress CA into the overlay so
    // the guest's system trust store includes it. Best-effort: a CA
    // failure must not block boot media assembly.
    let egress_ca_pem: Option<String> = vm_dir
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|name| crate::mitm::ensure_ca(name).is_ok())
        .and_then(|name| fs::read_to_string(crate::mitm::ca_cert_path(name)).ok());
    // Project identity = a short hash of the mounted path. Hashing keeps the
    // value shell-safe (no quoting concerns from arbitrary host paths) and
    // still uniquely keys each project for the npm-global wipe.
    let project_id = mount_path
        .map(|p| crate::images::content_sha256_hex(p.as_bytes())[..16].to_string())
        .unwrap_or_default();
    let apkovl = build_apkovl_for_readiness(
        registry_host_port,
        egress_ca_pem.as_deref(),
        dev,
        mount_path.is_some(),
        docker,
        egress_port,
        readiness,
        &project_id,
        host_port,
        &bootstrap_token,
        release_gate,
    )?;

    let modloop_data = fs::read(&modloop)?;
    let k3s_data = k3s.as_ref().map(fs::read).transpose()?;
    let apiserver_data = apiserver
        .as_ref()
        .map(|a| fs::read(&a.binary))
        .transpose()?;
    let console_data = apiserver
        .as_ref()
        .and_then(|a| a.console.as_ref())
        .map(fs::read)
        .transpose()?;
    let mut release_evidence_data = Vec::new();
    if let Some(assets) = &apiserver {
        if let Some(evidence) = &assets.release_evidence {
            release_evidence_data.extend([
                ("appliance-api-server.sha256", fs::read(&evidence.checksums)?),
                ("control-plane-release.properties", fs::read(&evidence.properties)?),
                ("control-plane-release.json", fs::read(&evidence.payload)?),
                ("control-plane-release.sig.json", fs::read(&evidence.envelope)?),
            ]);
        } else if assets.evidence_poisoned {
            release_evidence_data.push((
                "control-plane-release.invalid",
                b"incomplete-or-malformed\n".to_vec(),
            ));
        }
    }

    // Size the volume to fit contents + FAT overhead, rounded up.
    let content = modloop_data.len()
        + k3s_data.as_ref().map_or(0, Vec::len)
        + apkovl.len()
        + apiserver_data.as_ref().map_or(0, Vec::len)
        + console_data.as_ref().map_or(0, Vec::len)
        + release_evidence_data.iter().map(|(_, data)| data.len()).sum::<usize>()
        + runtime_repositories.iter().map(|repository| {
            fs::metadata(&repository.index).map(|metadata| metadata.len() as usize).unwrap_or(0)
                + repository.packages.iter().map(|package| {
                    fs::metadata(package).map(|metadata| metadata.len() as usize).unwrap_or(0)
                }).sum::<usize>()
        }).sum::<usize>();
    let volume_bytes = ((content as u64 + 64 * 1024 * 1024) / (16 * 1024 * 1024) + 1) * (16 * 1024 * 1024);

    let image_path = vm_dir.join("boot-media.img");
    // Build away from the canonical path and durably flush the FAT image
    // before VZ/KVM can attach it. Without this boundary a cold VZ boot can
    // observe the directory entry before the apkovl payload has reached the
    // backing file, producing an intermittent "invalid magic / short read".
    let partial = vm_dir.join("boot-media.img.partial");
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(&partial)
        .with_context(|| format!("create {}", partial.display()))?;
    file.set_len(volume_bytes)?;

    let buf = fscommon::BufStream::new(&file);
    fatfs::format_volume(
        buf,
        fatfs::FormatVolumeOptions::new().volume_label(*b"APPLIANCE  "),
    )
    .context("format FAT volume")?;

    let buf = fscommon::BufStream::new(&file);
    let fs = fatfs::FileSystem::new(buf, fatfs::FsOptions::new()).context("open FAT volume")?;
    {
        let root = fs.root_dir();
        let boot = root.create_dir("boot")?;
        let mut f = boot.create_file("modloop-virt")?;
        f.write_all(&modloop_data)?;
        let mut f = root.create_file("appliance.apkovl.tar.gz")?;
        f.write_all(&apkovl)?;
        if !runtime_repositories.is_empty() {
            let apks = root.create_dir("apks")?;
            for repository in &runtime_repositories {
                let directory = apks.create_dir(&repository.name)?;
                directory.create_file(".boot_repository")?;
                // `apk --repository <base>` appends its architecture, just
                // like Alpine's own ISO layout (`apks/aarch64/...`).
                let architecture = directory.create_dir(alpine_arch)?;
                let mut index = architecture.create_file("APKINDEX.tar.gz")?;
                index.write_all(&fs::read(&repository.index)?)?;
                for package in &repository.packages {
                    let filename = package.file_name().and_then(|name| name.to_str())
                        .context("Runtime APK path has no UTF-8 filename")?;
                    let mut output = architecture.create_file(filename)?;
                    output.write_all(&fs::read(package)?)?;
                }
            }
        }
        if let Some(data) = &k3s_data {
            let mut f = root.create_file("k3s")?;
            f.write_all(data)?;
        }
        if let Some(data) = &apiserver_data {
            let mut f = root.create_file("appliance-api-server")?;
            f.write_all(data)?;
        }
        if let Some(data) = &console_data {
            let mut f = root.create_file("appliance-console.tar.gz")?;
            f.write_all(data)?;
        }
        for (name, data) in &release_evidence_data {
            let mut f = root.create_file(name)?;
            f.write_all(data)?;
        }
    }
    fs.unmount().context("unmount FAT volume")?;
    file.sync_all().context("sync FAT boot media")?;
    drop(file);
    fs::rename(&partial, &image_path)
        .with_context(|| format!("publish {}", image_path.display()))?;

    Ok(BootMedia {
        image: image_path,
        apiserver_staged: apiserver.is_some(),
    })
}

/// Kernel command line for the k3s guest. The netboot initramfs
/// handles ip=dhcp itself (before openrc exists), pulls the base
/// system from alpine_repo, and finds modloop + apkovl on the FAT
/// media automatically once it can mount it.
pub fn guest_cmdline() -> String {
    format!(
        "console=hvc0 ip=dhcp alpine_repo=https://dl-cdn.alpinelinux.org/alpine/{ALPINE_BRANCH}/main modloop=/media/{}/boot/modloop-virt",
        VZ_BOOT_MEDIA_DEVICE.trim_start_matches("/dev/")
    )
}

/// Runtime auto-discovers the signed local repositories copied into its FAT media.
/// DHCP remains enabled for the Netstack link, but no package/rootfs bytes
/// traverse that boundary before the supervisor is ready.
pub fn runtime_guest_cmdline() -> String {
    format!(
        "console=hvc0 ip=dhcp alpine_repo=auto modloop=/media/{}/boot/modloop-virt",
        VZ_BOOT_MEDIA_DEVICE.trim_start_matches("/dev/")
    )
}

/// Which independently observable guest layer `host_services` gates on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HostReadiness {
    Core,
    Runtime,
    Agent,
    K3s,
}

fn readiness_for(agent_only: bool, cluster: bool, dev: bool) -> HostReadiness {
    if agent_only && !dev {
        HostReadiness::Runtime
    } else if agent_only {
        HostReadiness::Agent
    } else if cluster {
        HostReadiness::K3s
    } else {
        HostReadiness::Core
    }
}

/// What `host_services` should do for a spec, computed purely so all
/// three readiness modes are unit-testable without a live guest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct HostServicePlan {
    /// SASHA #1 (acceptance criterion): the guest-ip lease is persisted
    /// for EVERY spec — the broker's exact-lease peer-pin and the netstack
    /// boundary's lease attribution both depend on `guest-ip`. ALWAYS
    /// true; agent-only never skips it. A regression that gated this on
    /// `agent_only` would flip it false and fail `agent_only_*` below.
    persist_guest_ip: bool,
    /// Wire the k3s api/ingress/registry/NodePort host forwards. Skipped
    /// for agent-only (the agent reaches the world via the egress proxy,
    /// not these); the KUBECONFIG_PORT handoff forward is separate and
    /// always retained.
    wire_k3s_forwards: bool,
    readiness: HostReadiness,
}

/// Decide the host-services plan for a spec. Pure — the invariants
/// (guest-ip always persisted; only the k3s forwards dropped for
/// agent-only) are locked by unit tests, not a live boot.
fn plan_host_services(spec: &crate::spec::VmSpec) -> HostServicePlan {
    HostServicePlan {
        persist_guest_ip: true,
        wire_k3s_forwards: readiness_for(spec.agent_only, spec.cluster, spec.dev) == HostReadiness::K3s,
        readiness: readiness_for(spec.agent_only, spec.cluster, spec.dev),
    }
}

/// Guest-facing host services, run inside the resident VM host
/// process for the lifetime of the VM:
///
///   1. discover the guest's address from its DHCP lease
///   2. forward 127.0.0.1:<apiPort> → guest:6443 and
///      127.0.0.1:<hostPort> → guest:80
///   3. fetch the admin kubeconfig over the guest's handoff endpoint,
///      rewrite it to the forwarded port, persist it next to the VM
///
/// Files written (guest-ip, kubeconfig.yaml) plus the terminal `Ready`
/// phase are the contract `up` polls on from the calling process —
/// kubeconfig.yaml lands as soon as the cluster answers (a debugging
/// surface), Ready only once the whole platform does.
pub fn host_services(
    spec: &crate::spec::VmSpec,
    vm_dir: &Path,
    netstack: Option<&crate::netstack::Netstack>,
    // Whether this boot's media embeds the api-server binary (captured
    // at media-build time; see `BootMedia::apiserver_staged`).
    apiserver_staged: bool,
) -> Result<()> {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};
    use std::time::Duration;

    // The plan encodes the agent-only invariants (Sasha #1: guest-ip
    // always persisted; only the k3s forwards dropped) in a unit-tested
    // pure function rather than scattering `spec.agent_only` checks.
    let plan = plan_host_services(spec);

    // Bind failures here are almost always another microVM already
    // holding the port — name the fix, don't let it surface as a
    // generic timeout.
    let bind_hint = |port: u16, what: &str| {
        format!(
            "cannot forward 127.0.0.1:{port} ({what}) — the port is taken. Stop the microVM holding it with `appliance vm stop`, or run `appliance doctor` to find what owns the port."
        )
    };

    // Discover the guest address and wire the inbound forwards. The two
    // links differ only here: NAT routes `TcpStream::connect` over the
    // framework subnet; the netstack assigns the lease (so the IP is
    // known a-priori) and dials the guest *through* the userspace stack.
    let (guest_ip, handoff_host, handoff_port) = match netstack {
        Some(ns) => {
            // Sasha #1: the netstack assigns the deterministic lease
            // regardless of agent-only — guest_ip is known a-priori. The
            // broker's exact-lease peer-pin and the netstack boundary's
            // lease attribution depend on it, so the lease is NEVER skipped;
            // only the k3s-specific forwards are.
            let guest_ip = IpAddr::V4(ns.guest_ip());
            if plan.wire_k3s_forwards {
                crate::net::spawn_proxy_netstack(spec.api_port, 6443, ns.clone())
                    .map_err(|e| anyhow::anyhow!("{}\n{e:#}", bind_hint(spec.api_port, "kubernetes api")))?;
                crate::net::spawn_proxy_netstack(spec.host_port, 80, ns.clone())
                    .map_err(|e| anyhow::anyhow!("{}\n{e:#}", bind_hint(spec.host_port, "ingress")))?;
                crate::net::spawn_proxy_netstack(spec.registry_port, REGISTRY_NODEPORT, ns.clone())
                    .map_err(|e| anyhow::anyhow!("{}\n{e:#}", bind_hint(spec.registry_port, "registry")))?;
                crate::net::spawn_proxy_netstack(spec.buildkit_port, BUILDKITD_GUEST_PORT, ns.clone())
                    .map_err(|e| anyhow::anyhow!("{}\n{e:#}", bind_hint(spec.buildkit_port, "buildkit")))?;
                for port in 30000..=30050u16 {
                    let _ = crate::net::spawn_proxy_netstack(port, port, ns.clone());
                }
            }
            // The kubeconfig/agent-ready handoff has no OS route under the
            // netstack — forward it onto a loopback port and fetch from
            // there. RETAINED in agent-only mode (Quinn gap #4b): the
            // agent-ready sentinel is served over it too.
            let hport = crate::net::spawn_proxy_netstack_ephemeral(KUBECONFIG_PORT, ns.clone())?;
            (guest_ip, IpAddr::V4(Ipv4Addr::LOCALHOST), hport)
        }
        None => {
            // Sasha #1: discover_guest_ip writes the NAT lease the broker's
            // exact-lease peer-pin reads — preserved in agent-only mode;
            // only the k3s forwards below are skipped.
            let guest_ip = crate::net::discover_guest_ip(&spec.mac, Duration::from_secs(120))?;
            if plan.wire_k3s_forwards {
                crate::net::spawn_proxy(spec.api_port, SocketAddr::new(guest_ip, 6443))
                    .map_err(|e| anyhow::anyhow!("{}\n{e:#}", bind_hint(spec.api_port, "kubernetes api")))?;
                crate::net::spawn_proxy(spec.host_port, SocketAddr::new(guest_ip, 80))
                    .map_err(|e| anyhow::anyhow!("{}\n{e:#}", bind_hint(spec.host_port, "ingress")))?;
                crate::net::spawn_proxy(spec.registry_port, SocketAddr::new(guest_ip, REGISTRY_NODEPORT))
                    .map_err(|e| anyhow::anyhow!("{}\n{e:#}", bind_hint(spec.registry_port, "registry")))?;
                crate::net::spawn_proxy(spec.buildkit_port, SocketAddr::new(guest_ip, BUILDKITD_GUEST_PORT))
                    .map_err(|e| anyhow::anyhow!("{}\n{e:#}", bind_hint(spec.buildkit_port, "buildkit")))?;
                // The deterministic-NodePort window KubernetesDeploymentService
                // assigns from — forwarded so the "direct" URLs in deploy
                // results work exactly as they do on k3d.
                for port in 30000..=30050u16 {
                    let _ = crate::net::spawn_proxy(port, SocketAddr::new(guest_ip, port));
                }
            }
            // Under NAT the handoff httpd is reachable directly at the guest
            // IP (k3s.yaml or agent-ready) — no loopback forward needed.
            (guest_ip, guest_ip, KUBECONFIG_PORT)
        }
    };

    // Sasha #1 (acceptance criterion): agent-only STILL writes guest-ip —
    // NAT and the netstack lease attribution depend on it. The forwards are
    // skipped above, never the discovery/lease. `persist_guest_ip` is
    // always true (the plan locks it); guarding the write through it keeps
    // the invariant a single tested decision.
    crate::bringup::hostlog(&format!("guest address: {guest_ip}"));
    if plan.persist_guest_ip {
        fs::write(vm_dir.join("guest-ip"), guest_ip.to_string())?;
    }
    crate::bringup::set(vm_dir, crate::bringup::Phase::Network, Some(guest_ip.to_string()));

    // Core readiness is independent of both handoff HTTP paths: the
    // shell agent is provisioned before k3s and DEV_PROVISION, so a
    // successful trivial exec proves the usable sandbox primitive.
    crate::bringup::hostlog("waiting for core vsock shell");
    let core_deadline = std::time::Instant::now() + Duration::from_secs(120);
    loop {
        if crate::guest_exec::run_wrapped(&spec.name, "true").is_ok() {
            break;
        }
        if std::time::Instant::now() >= core_deadline {
            anyhow::bail!("guest core vsock shell did not answer within 120s");
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    fs::write(vm_dir.join("core-ready"), b"core-ready\n")?;
    crate::bringup::hostlog("core vsock shell ready");

    if matches!(plan.readiness, HostReadiness::Core | HostReadiness::Runtime) {
        crate::bringup::set(vm_dir, crate::bringup::Phase::Ready, None);
        return Ok(());
    }

    if plan.readiness == HostReadiness::Agent {
        // Agent-only: no k3s control plane. Gate on the agent runtime — the
        // guest serves an `agent-ready` sentinel once the Node toolchain
        // (.dev-ready) is up (Quinn gap #2). Then write the host-side
        // readiness marker `up`/`status`/`list` poll on for this spec.
        crate::bringup::hostlog("agent-only: gating on the agent runtime (node + vsock shell)");
        crate::bringup::set(vm_dir, crate::bringup::Phase::Agent, None);
        let handoff = format!("http://{handoff_host}:{handoff_port}/agent-ready");
        crate::net::wait_http(&handoff, Duration::from_secs(600))?;
        fs::write(vm_dir.join("agent-ready"), b"agent-ready\n")?;
        crate::bringup::hostlog(&format!(
            "agent runtime ready: {}",
            vm_dir.join("agent-ready").display()
        ));
        crate::bringup::set(vm_dir, crate::bringup::Phase::Ready, None);
        return Ok(());
    }

    crate::bringup::hostlog(&format!(
        "forwarding 127.0.0.1:{} → guest:6443, 127.0.0.1:{} → guest:80, 127.0.0.1:{} → guest:{} (registry), 127.0.0.1:{} → guest:{} (buildkit)",
        spec.api_port, spec.host_port, spec.registry_port, REGISTRY_NODEPORT, spec.buildkit_port, BUILDKITD_GUEST_PORT
    ));

    wait_platform_ready(spec, vm_dir, handoff_host, handoff_port, apiserver_staged)
}

/// Drive the honest cluster sub-phases through the long "cluster" window
/// and only declare `Ready` once the platform actually answers:
/// kubeconfig fetched, the in-VM registry's `/v2/` reachable through its
/// host forward, and — when the media carried the api-server — its
/// traefik route answering. Backend-neutral (plain HTTP polling of
/// host-reachable endpoints): the vz and WSL host services both end here.
///
/// `apiserver_staged` is whether THIS boot's media carries the
/// api-server binary — captured at media-build time by the backend and
/// plumbed through, never re-probed off the shared guest-assets cache
/// here (a CLI staging or pruning the binary mid-boot must not change
/// what readiness means for a VM already booted without/with it).
pub(crate) fn wait_platform_ready(
    spec: &crate::spec::VmSpec,
    vm_dir: &Path,
    handoff_host: std::net::IpAddr,
    handoff_port: u16,
    apiserver_staged: bool,
) -> Result<()> {
    use crate::bringup::{hostlog, set, Phase};
    use std::time::{Duration, Instant};

    // Publish the coarse phase FIRST: older desktops ignore the unknown
    // sub-phases below, so `cluster` is what keeps their ladder moving.
    set(vm_dir, Phase::Cluster, None);

    // Poll the guest's grippable /progress markers to advance sub-phases
    // while waiting on the k3s API — same 600s cold budget the plain
    // k3s.yaml wait had (first boot installs packages / imports images).
    let progress_url = format!("http://{handoff_host}:{handoff_port}/progress");
    let kubeconfig_url = format!("http://{handoff_host}:{handoff_port}/k3s.yaml");
    let deadline = Instant::now() + Duration::from_secs(600);
    let mut node_seen = false;
    let mut images_seen = false;
    loop {
        if let Some(progress) = crate::net::http_get_text(&progress_url) {
            if !node_seen && progress.contains("base-system-ready") {
                set(vm_dir, Phase::ClusterNode, None);
                hostlog("guest base system up");
                node_seen = true;
            }
            if !images_seen && progress.contains("images-imported") {
                set(vm_dir, Phase::ClusterImages, Some("airgap tarball staged".into()));
                hostlog("platform images staged for k3s import");
                images_seen = true;
            }
            if progress.contains("k3s-api-up") {
                break;
            }
        }
        // Belt and braces: the kubeconfig answering IS the API being up,
        // marker or no marker (e.g. a guest predating the marker).
        if crate::net::http_get_text(&kubeconfig_url).is_some() {
            break;
        }
        if Instant::now() >= deadline {
            anyhow::bail!("guest kubeconfig handoff did not answer within 600s");
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    set(vm_dir, Phase::ClusterApi, None);
    hostlog("kubernetes api up (kubeconfig served)");
    // The marker can beat a first fetch by a beat — give it patience.
    crate::net::wait_http(&kubeconfig_url, Duration::from_secs(30))?;
    let kubeconfig = crate::net::fetch_kubeconfig(handoff_host, handoff_port, spec.api_port)?;
    // Persist the kubeconfig the moment it exists — BEFORE the last-mile
    // waits below, exactly like main always did. A registry/ingress
    // failure then still leaves kubectl usable for debugging (the CLI's
    // kubeconfig path helpers gate on this file); it no longer implies
    // readiness — `up` gates on the terminal `Ready` phase, which only
    // lands after the last mile answers.
    fs::write(vm_dir.join("kubeconfig.yaml"), kubeconfig)?;
    hostlog(&format!(
        "kubeconfig written to {}",
        vm_dir.join("kubeconfig.yaml").display()
    ));

    // Last mile — what `ready` must actually mean. The registry rides
    // every k3s VM (first boot may still be pulling registry:2); the
    // api-server route only exists when the media carried the binary,
    // and traefik's own install shares the same cold window. Each cold
    // budget is capped by what REMAINS of the total bring-up budget
    // (`up --timeout`, threaded in via the env var), so the serial waits
    // can never add up past what the caller is polling against. On
    // failure the error propagates to the backend's host-services
    // supervisor, which publishes Phase::Failed with the detail —
    // kubeconfig.yaml stays on disk.
    let budgeted = |what: &str, cold: Duration| {
        let (wait, truncated) = crate::bringup::budgeted_wait(cold, crate::bringup::remaining_budget());
        if truncated {
            hostlog(&format!(
                "{what} wait capped at {}s by the remaining bring-up budget (cold budget {}s)",
                wait.as_secs(),
                cold.as_secs()
            ));
        }
        wait
    };
    set(vm_dir, Phase::Ingress, Some("in-VM registry".into()));
    let registry_url = format!("http://127.0.0.1:{}/v2/", spec.registry_port);
    crate::net::wait_http(&registry_url, budgeted("in-VM registry", Duration::from_secs(300)))?;
    hostlog("in-VM registry answering");
    if apiserver_staged {
        set(vm_dir, Phase::Ingress, Some("api-server route".into()));
        let ingress_url = format!("http://127.0.0.1:{}/bootstrap/status", spec.host_port);
        crate::net::wait_http_host(
            &ingress_url,
            "api.appliance.localhost",
            budgeted("api-server ingress", Duration::from_secs(600)),
        )?;
        hostlog("api-server ingress answering");
    }

    // Terminal success — the phase `up` gates readiness on (together
    // with the kubeconfig marker), deliberately LAST so `Ready` means
    // "actually usable", not just "k3s elected itself".
    set(vm_dir, Phase::Ready, None);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn apkovl_paths(ovl: &[u8]) -> Vec<String> {
        let gz = flate2::read::GzDecoder::new(ovl);
        let mut ar = tar::Archive::new(gz);
        let mut paths = Vec::new();
        for entry in ar.entries().unwrap() {
            let entry = entry.unwrap();
            paths.push(entry.path().unwrap().to_string_lossy().into_owned());
        }
        paths
    }

    /// Read one file's contents out of an apkovl tarball.
    fn apkovl_file(ovl: &[u8], want: &str) -> Option<String> {
        let gz = flate2::read::GzDecoder::new(ovl);
        let mut ar = tar::Archive::new(gz);
        for entry in ar.entries().unwrap() {
            let mut entry = entry.unwrap();
            if entry.path().unwrap().to_string_lossy() == want {
                let mut s = String::new();
                entry.read_to_string(&mut s).unwrap();
                return Some(s);
            }
        }
        None
    }

    #[test]
    fn apkovl_embeds_egress_ca_when_provided() {
        let pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
        let ovl = build_apkovl(5052, Some(pem), false, false, false, 5053, false, "", 8081, "", false).unwrap();
        let paths = apkovl_paths(&ovl);
        assert!(paths.iter().any(|p| p == "usr/local/share/ca-certificates/appliance-egress.crt"));
        // And the bootstrap trusts it node-wide.
        assert!(APPLIANCE_START.contains("update-ca-certificates"));
        assert!(APPLIANCE_START.contains("appliance-egress.crt"));
    }

    #[test]
    fn apkovl_omits_egress_ca_when_absent() {
        let ovl = build_apkovl(5052, None, false, false, false, 5053, false, "", 8081, "", false).unwrap();
        let paths = apkovl_paths(&ovl);
        assert!(!paths.iter().any(|p| p.contains("appliance-egress.crt")));
    }

    #[test]
    fn apkovl_ca_pem_round_trips() {
        let pem = "-----BEGIN CERTIFICATE-----\nROUNDTRIP\n-----END CERTIFICATE-----\n";
        let ovl = build_apkovl(5052, Some(pem), false, false, false, 5053, false, "", 8081, "", false).unwrap();
        assert_eq!(
            apkovl_file(&ovl, "usr/local/share/ca-certificates/appliance-egress.crt").as_deref(),
            Some(pem)
        );
    }

    #[test]
    fn dev_provisioning_present_only_for_dev_vms() {
        // Non-dev: the marker is substituted to empty and no dev wiring
        // leaks into the bootstrap.
        let plain = build_apkovl(5052, None, false, false, false, 5053, false, "", 8081, "", false).unwrap();
        let start = apkovl_file(&plain, "etc/local.d/appliance.start").unwrap();
        assert!(!start.contains("__DEV_PROVISION__"), "marker must be substituted");
        // The base user block references /persist/workspace on every VM,
        // and buildkit's own apk install rides every k3s VM — so assert
        // on dev-only wiring (the toolchain package set) instead.
        assert!(!start.contains("appliance-dev: provisioning"));
        assert!(!start.contains("bash bash-completion git"));

        // Dev: the workspace, persistent apk cache, login profile, and
        // backgrounded toolchain install are all present.
        let dev = build_apkovl(5052, None, true, false, false, 5053, false, "", 8081, "", false).unwrap();
        let start = apkovl_file(&dev, "etc/local.d/appliance.start").unwrap();
        assert!(!start.contains("__DEV_PROVISION__"));
        assert!(start.contains("mkdir -p /persist/workspace"));
        assert!(start.contains("ln -sfn /persist/apk-cache /etc/apk/cache"));
        assert!(start.contains("/etc/profile.d/appliance-dev.sh"));
        assert!(start.contains("bash bash-completion git"));
        assert!(start.contains("/persist/.dev-ready"));
    }

    #[test]
    fn appliance_user_provisioned_on_every_vm() {
        // The non-root user is unconditional — present even on a plain
        // (non-dev, non-docker, non-mount) VM, just like the shell agent.
        let plain = build_apkovl(5052, None, false, false, false, 5053, false, "", 8081, "", false).unwrap();
        let start = apkovl_file(&plain, "etc/local.d/appliance.start").unwrap();
        assert!(!start.contains("__APP_USER_PROVISION__"), "marker must be substituted");
        // User + primary group, pinned uid/gid, on the persistent home.
        assert!(start.contains("APP_USER=appliance"));
        assert!(start.contains("adduser -D -H -u \"$APP_UID\" -G \"$APP_GROUP\" -h \"$APP_HOME\" -s /bin/sh \"$APP_USER\""));
        // The user's primary group is resolved from /etc/group so a host
        // gid that collides with a baselayout group (e.g. staff=20 →
        // dialout) reuses that group instead of failing `addgroup`.
        assert!(start.contains("APP_GROUP=$(awk -F: -v g=\"$APP_GID\" '$3==g{print $1; exit}' /etc/group)"));
        assert!(start.contains("addgroup -g \"$APP_GID\" \"$APP_USER\""));
        assert!(start.contains("APP_HOME=/persist/workspace"));
        // wheel (sudo) membership + a passwordless sudoers drop-in.
        assert!(start.contains("addgroup \"$APP_USER\" wheel"));
        assert!(start.contains("/etc/sudoers.d/appliance"));
        assert!(start.contains("ALL=(ALL) NOPASSWD:ALL"));
        // npm global prefix on the data disk (OFF the workspace mount) so
        // global installs don't pollute the repo or reinstall per project
        // (docs/fast-spin-up.md §2.5).
        assert!(start.contains("/etc/profile.d/appliance-user.sh"));
        assert!(start.contains("NPM_CONFIG_PREFIX=\"/persist/npm-global\""));
        assert!(!start.contains("NPM_CONFIG_PREFIX=\"$HOME/.local\""), "prefix moved off the mounted HOME");
        // sudo is in the base package set so it's installed before the
        // bootstrap provisions the user.
        let world = apkovl_file(&plain, "etc/apk/world").unwrap();
        assert!(world.lines().any(|l| l == "sudo"));
        // The provisioning runs after the /persist mount and before the
        // shell agent listens (so the first connection can `su`).
        let mount_at = start.find("mount -t ext4 /dev/vda").unwrap();
        let user_at = start.find("provisioning the non-root appliance user").unwrap();
        let agent_at = start.find("VSOCK-LISTEN:").unwrap();
        assert!(mount_at < user_at && user_at < agent_at, "user block must sit between the persist mount and the shell agent");
    }

    #[test]
    fn appliance_user_uid_gid_pinned_per_mount() {
        // Pure resolver: a share matches the host ids; no share is 1000.
        assert_eq!(resolve_app_ids(false, 501, 20), (1000, 1000));
        assert_eq!(resolve_app_ids(true, 501, 20), (501, 20));

        // A non-mount VM pins the conventional 1000/1000.
        let plain = build_apkovl(5052, None, true, false, false, 5053, false, "", 8081, "", false).unwrap();
        let start = apkovl_file(&plain, "etc/local.d/appliance.start").unwrap();
        assert!(start.contains("APP_UID=1000"));
        assert!(start.contains("APP_GID=1000"));

        // A --mount VM pins the host user's own uid/gid so the shared
        // workspace (host-side ownership over virtiofs) stays writable —
        // except when the host is root, where the resolver falls back to
        // 1000 (asserted separately), so derive the expected ids the same
        // way and don't hard-code the live host's values.
        let (host_uid, host_gid) = host_ids();
        let (exp_uid, exp_gid) = resolve_app_ids(true, host_uid, host_gid);
        let shared = build_apkovl(5052, None, true, true, false, 5053, false, "", 8081, "", false).unwrap();
        let start = apkovl_file(&shared, "etc/local.d/appliance.start").unwrap();
        assert!(start.contains(&format!("APP_UID={exp_uid}")), "mounted VM must pin the resolved uid");
        assert!(start.contains(&format!("APP_GID={exp_gid}")), "mounted VM must pin the resolved gid");
    }

    #[test]
    fn resolve_app_ids_falls_back_when_host_is_root() {
        // Running `appliance` as root must NOT mint a uid-0 "non-root"
        // user: the mount path falls back to the conventional 1000/1000
        // whenever the host uid or gid is 0.
        assert_eq!(resolve_app_ids(true, 0, 0), (1000, 1000));
        assert_eq!(resolve_app_ids(true, 0, 20), (1000, 1000));
        assert_eq!(resolve_app_ids(true, 501, 0), (1000, 1000));
        // A non-root host still carries its own ids onto the shared tree.
        assert_eq!(resolve_app_ids(true, 501, 20), (501, 20));
        // No share is always 1000/1000, root host or not.
        assert_eq!(resolve_app_ids(false, 0, 0), (1000, 1000));
        assert_eq!(resolve_app_ids(false, 501, 20), (1000, 1000));
    }

    #[test]
    fn vsock_shell_agent_is_baked_into_every_vm() {
        let ovl = build_apkovl(5052, None, false, false, false, 5053, false, "", 8081, "", false).unwrap();
        // socat backs the agent and is in the base package set.
        let world = apkovl_file(&ovl, "etc/apk/world").unwrap();
        assert!(world.lines().any(|l| l == "socat"));
        // The bootstrap starts the agent on the shared vsock port.
        let start = apkovl_file(&ovl, "etc/local.d/appliance.start").unwrap();
        assert!(!start.contains("__SHELL_VSOCK_PORT__"), "port marker must be substituted");
        assert!(start.contains(&format!("VSOCK-LISTEN:{SHELL_VSOCK_PORT}")));
        assert!(start.contains("/usr/local/bin/appliance-shell-agent"));
        // The agent script is present, reads the size line, and drops to
        // the non-root appliance user via a login `su` by default.
        let agent = apkovl_file(&ovl, "usr/local/bin/appliance-shell-agent").unwrap();
        assert!(agent.contains("read"));
        assert!(agent.contains("exec su -s \"$__SH\" -l appliance"), "default drop to appliance");
        // The `root` token on the size line keeps a root login shell (the
        // --root escape hatch + clock-sync); its branch execs the shell
        // directly, not via su.
        assert!(agent.contains("*\" root\")"), "root token is stripped from the size line");
        assert!(agent.contains("exec \"$__SH\" -l"), "root branch keeps a root login shell");
    }

    #[test]
    fn tmux_is_in_the_base_world_set() {
        // The reattachable-session multiplexer ships on EVERY VM (not just
        // dev VMs), next to socat/sudo — the feature is unconditional.
        let ovl = build_apkovl(5052, None, false, false, false, 5053, false, "", 8081, "", false).unwrap();
        let world = apkovl_file(&ovl, "etc/apk/world").unwrap();
        assert!(world.lines().any(|l| l == "tmux"), "tmux must be in the base world set");
    }

    #[test]
    fn transparent_tmux_conf_is_baked_in() {
        let ovl = build_apkovl(5052, None, false, false, false, 5053, false, "", 8081, "", false).unwrap();
        let conf = apkovl_file(&ovl, "etc/appliance/tmux.conf").expect("tmux.conf present");
        // Invisible multiplexer: no status bar, short escape passthrough,
        // large scrollback, and sessions outlive a detach.
        assert!(conf.contains("status off"));
        assert!(conf.contains("history-limit 50000"));
        assert!(conf.contains("destroy-unattached off"));
        // The agent points `-f` at exactly this path.
        let agent = apkovl_file(&ovl, "usr/local/bin/appliance-shell-agent").unwrap();
        assert!(agent.contains("-f /etc/appliance/tmux.conf"));
    }

    #[test]
    fn shell_agent_routes_session_verbs_to_tmux() {
        let ovl = build_apkovl(5052, None, false, false, false, 5053, false, "", 8081, "", false).unwrap();
        let agent = apkovl_file(&ovl, "usr/local/bin/appliance-shell-agent").unwrap();

        // The four verbs are parsed off the size line.
        assert!(agent.contains("*\" attach \"*)"), "attach verb parsed");
        assert!(agent.contains("*\" new \"*)"), "new verb parsed");
        assert!(agent.contains("*\" kill \"*)"), "kill verb parsed");
        assert!(agent.contains("*\" list\")"), "list verb parsed");
        // attach/new is attach-or-create on the named per-id session.
        assert!(agent.contains("new-session -A -s appliance-$__SID"));
        assert!(agent.contains("list-sessions"));
        assert!(agent.contains("kill-session -t appliance-$__SID"));
        // Two owner-isolated sockets: appliance (default) vs appliance-root.
        assert!(agent.contains("__L=appliance-root"));
        assert!(agent.contains("else __L=appliance"));
        // Non-root sessions drop to the appliance user; root keeps a root
        // tmux on its own socket (no su).
        assert!(agent.contains("exec su -s /bin/sh $__LOGIN -c \"$__TCMD\" appliance"));
        assert!(agent.contains("exec sh -c \"$__TCMD\""));

        // kill reports the real outcome: it echoes a marker keyed on tmux's
        // exit status so the host can say "killed" vs "no such session"
        // over the status-less byte pipe.
        assert!(agent.contains("__APPLIANCE_VM_KILLED__"), "kill echoes a success marker");
        assert!(agent.contains("__APPLIANCE_VM_NO_SESSION__"), "kill echoes a no-session marker");
        // Defense-in-depth guest-side id guard: reject anything outside the
        // host-validated charset before $__SID rides into `sh -c`.
        assert!(agent.contains("*[!A-Za-z0-9._-]*)"), "guest-side session-id charset guard");

        // CRITICAL: the verb block is gated on a verb being present, so the
        // no-verb one-shot/login path is byte-for-byte the legacy behavior.
        assert!(agent.contains("if [ -n \"$__VERB\" ]; then"));
        // The verb parse sits before the `root` parse (grammar order) and
        // before the legacy shell selection, so a verb-less line lands on
        // the unchanged path.
        let verb_at = agent.find("__VERB=''").unwrap();
        let root_at = agent.find("case \"$__SZ\" in *\" root\")").unwrap();
        let legacy_su_at = agent.find("exec su -s \"$__SH\" -l appliance").unwrap();
        assert!(verb_at < root_at, "verb parse precedes the root-token parse");
        assert!(root_at < legacy_su_at, "legacy drop-to-appliance is still the fall-through");
    }

    #[test]
    fn virtiofs_mount_present_only_with_a_share() {
        // Both markers must always be substituted away.
        for (dev, mount) in [(false, false), (true, false), (true, true)] {
            let start =
                apkovl_file(&build_apkovl(5052, None, dev, mount, false, 5053, false, "", 8081, "", false).unwrap(), "etc/local.d/appliance.start").unwrap();
            assert!(!start.contains("__DEV_MOUNT__"), "marker must be substituted (dev={dev} mount={mount})");
        }

        // Dev without a share: no virtiofs mount.
        let dev_only = apkovl_file(&build_apkovl(5052, None, true, false, false, 5053, false, "", 8081, "", false).unwrap(), "etc/local.d/appliance.start").unwrap();
        assert!(!dev_only.contains("mount -t virtiofs"));

        // Dev + share: the bootstrap mounts the workspace tag, and the
        // tag literal matches the constant the VZ backend tags with.
        let shared = apkovl_file(&build_apkovl(5052, None, true, true, false, 5053, false, "", 8081, "", false).unwrap(), "etc/local.d/appliance.start").unwrap();
        assert!(shared.contains(&format!("mount -t virtiofs {WORKSPACE_VIRTIOFS_TAG} /persist/workspace")));
        assert!(DEV_MOUNT.contains(WORKSPACE_VIRTIOFS_TAG));
    }

    #[test]
    fn docker_provisioning_present_only_for_docker_vms() {
        // Non-docker: the marker is substituted to empty and no docker
        // provisioning leaks into the bootstrap. (The section-header
        // comment legitimately names dockerd even when off, so assert on
        // the provisioning strings that only the block emits.)
        let plain = build_apkovl(5052, None, false, false, false, 5053, false, "", 8081, "", false).unwrap();
        let start = apkovl_file(&plain, "etc/local.d/appliance.start").unwrap();
        assert!(!start.contains("__DOCKER_PROVISION__"), "marker must be substituted");
        assert!(!start.contains("apk add --no-progress docker docker-cli-compose"));
        assert!(!start.contains("--data-root /persist/docker"));
        assert!(!start.contains("/persist/.docker-ready"));

        // Docker: the apk install, the separate dockerd engine, the
        // egress env injection, and the readiness marker are all present.
        let docker = build_apkovl(5052, None, false, false, true, 5053, false, "", 8081, "", false).unwrap();
        let start = apkovl_file(&docker, "etc/local.d/appliance.start").unwrap();
        assert!(!start.contains("__DOCKER_PROVISION__"));
        // Packaged from the Alpine community repo, cached on /persist.
        assert!(start.contains("apk add --no-progress docker docker-cli-compose"));
        assert!(start.contains("ln -sfn /persist/apk-cache /etc/apk/cache"));
        // The non-root appliance user joins the docker group (created by
        // the docker package) so `appliance up` reaches dockerd without
        // sudo — added after the install, where the group exists.
        assert!(start.contains("addgroup appliance docker"));
        // Fully separate engine: own data-root, listening on the default
        // socket (in-guest CLI) + the stable /persist path (vsock relay).
        assert!(start.contains("--data-root /persist/docker"));
        assert!(start.contains("-H unix:///var/run/docker.sock"));
        assert!(start.contains("-H unix:///persist/docker/docker.sock"));
        // dockerd is backgrounded and launched only inside the provision
        // subshell — it must not gate the k3s readiness handoff. (k3s is
        // still launched below it.)
        assert!(start.contains("dockerd \\\n"));
        assert!(start.contains("k3s server"));
        // Cooperative egress: dockerd's own traffic is pointed at the
        // per-VM forward proxy on the subnet gateway.
        assert!(start.contains("HTTP_PROXY="));
        assert!(start.contains("HTTPS_PROXY="));
        assert!(start.contains("NO_PROXY="));
        // Readiness marker for status.
        assert!(start.contains("/persist/.docker-ready"));
    }

    #[test]
    fn docker_provision_embeds_the_vm_egress_port() {
        // The egress port is substituted into the proxy URL the guest
        // builds at boot from its default-route gateway — the marker must
        // be gone and the actual port present.
        let docker = build_apkovl(5052, None, false, false, true, 8203, false, "", 8081, "", false).unwrap();
        let start = apkovl_file(&docker, "etc/local.d/appliance.start").unwrap();
        assert!(!start.contains("__EGRESS_PORT__"), "port marker must be substituted");
        assert!(start.contains(":8203"), "the per-VM egress port must be embedded");
    }

    #[test]
    fn buildkit_provisioned_on_k3s_vms_but_not_agent_only() {
        // Normal (k3s) VM: buildkitd is provisioned unconditionally —
        // marker substituted, apk install + tcp listener + persistent
        // cache root + registry alias + readiness marker all present.
        let plain = build_apkovl(5052, None, false, false, false, 5053, false, "", 8081, "", false).unwrap();
        let start = apkovl_file(&plain, "etc/local.d/appliance.start").unwrap();
        assert!(!start.contains("__BUILDKIT_PROVISION__"), "marker must be substituted");
        // socat rides the same install: present in the vz world file
        // but NOT in the WSL bootstrap's base packages.
        assert!(start.contains("apk add --no-progress buildkit buildctl runc socat"));
        assert!(start.contains("root = \"/persist/buildkit\""));
        assert!(start.contains(&format!("--addr tcp://0.0.0.0:{BUILDKITD_GUEST_PORT}")));
        assert!(start.contains("/persist/.buildkit-ready"));
        // The guest-loopback registry alias bridges the host-forwarded
        // ref (localhost:<registryPort>) to the registry NodePort so
        // buildkitd pushes the SAME ref pods pull.
        assert!(start.contains("socat TCP-LISTEN:5052,bind=127.0.0.1,reuseaddr,fork"));
        assert!(start.contains(&format!("TCP:127.0.0.1:{REGISTRY_NODEPORT}")));
        // Insecure (plain-HTTP) push for both spellings of the registry.
        assert!(start.contains("[registry.\"localhost:5052\"]"));
        assert!(start.contains(&format!("[registry.\"127.0.0.1:{REGISTRY_NODEPORT}\"]")));
        // No literal port markers survive.
        assert!(!start.contains("__BUILDKITD_GUEST_PORT__"));
        assert!(!start.contains("__REGISTRY_HOST_PORT__"));

        // Agent-only VM: no k3s, no registry — no buildkit either. (The
        // section-header comment legitimately names buildkitd even when
        // off, so assert on strings only the provision block emits.)
        let agent = build_apkovl(5052, None, true, false, false, 5053, true, "", 8081, "", false).unwrap();
        let start = apkovl_file(&agent, "etc/local.d/appliance.start").unwrap();
        assert!(!start.contains("__BUILDKIT_PROVISION__"), "marker must be substituted");
        assert!(!start.contains("apk add --no-progress buildkit buildctl runc socat"), "agent-only VMs provision no buildkit");
        assert!(!start.contains("/persist/.buildkit-ready"));
    }

    #[test]
    fn buildkit_heredoc_terminates() {
        // The BKTOML heredoc must close: an unterminated heredoc would
        // swallow the rest of the bootstrap silently.
        let opens = BUILDKIT_PROVISION.matches("<<BKTOML").count();
        let closes = BUILDKIT_PROVISION.lines().filter(|l| l.trim() == "BKTOML").count();
        assert_eq!(opens, 1);
        assert_eq!(closes, 1, "the BKTOML heredoc must terminate at column 0");
    }

    #[test]
    fn apiserver_provisioned_on_k3s_vms_with_staged_assets_only() {
        // k3s VM with the api-server staged: media copy, base config,
        // ingress route, token launch env, respawn loop — all present,
        // no literal markers.
        let pinned_key_id = format!("ed25519:sha256:{}", "a".repeat(64));
        let plain = build_apkovl_for_readiness(
            5052,
            None,
            false,
            false,
            false,
            5053,
            HostReadiness::K3s,
            "",
            8081,
            "tok3n",
            Some(ReleaseGate {
                pinned_key_id: &pinned_key_id,
                evidence: None,
                poison: false,
            }),
        )
        .unwrap();
        let start = apkovl_file(&plain, "etc/local.d/appliance.start").unwrap();
        assert!(!start.contains("__APISERVER_PROVISION__"), "marker must be substituted");
        assert!(!start.contains("__APISERVER_GUEST_PORT__"));
        assert!(!start.contains("__HOST_PORT__"));
        assert!(start.contains("APISERVER_SRC=\"$APISERVER_MEDIA/appliance-api-server\""));
        assert!(start.contains("sha256sum \"$APISERVER_SRC\""));
        assert!(start.contains("control-plane-release.sig.json"));
        assert!(start.contains("control-plane-release.properties"));
        assert!(!start.contains("jq "), "the minimal api-server guest does not install jq");
        assert!(start.contains(&format!("RELEASE_KEY_ID\" != \"{pinned_key_id}")));
        assert!(start.contains("signed control-plane seed digest/size mismatch; api-server start refused"));
        // Token auth against the local k3s: bun's fetch can't carry the
        // kubeconfig's client certificates, so the server gets its own
        // ServiceAccount token + the k3s CA via NODE_EXTRA_CA_CERTS.
        assert!(start.contains("\"server\": \"https://127.0.0.1:6443\""));
        assert!(start.contains("type: kubernetes.io/service-account-token"));
        assert!(start.contains("NODE_EXTRA_CA_CERTS"));
        assert!(start.contains("\"hostPort\": 8081"));
        assert!(start.contains("\"registry\": { \"url\": \"localhost:5052\", \"insecure\": true }"));
        assert!(start.contains("\"buildkit\": { \"addr\": \"unix:///run/buildkit/buildkitd.sock\" }"));
        assert!(start.contains("host: api.appliance.localhost"));
        assert!(start.contains(&format!("PORT={API_SERVER_GUEST_PORT} HOST=0.0.0.0")));
        assert!(start.contains("BOOTSTRAP_TOKEN=\"$(cat /etc/appliance/bootstrap-token 2>/dev/null)\""));
        assert!(start.contains("/persist/.apiserver-ready"));
        // The token itself lands in the overlay, root-only.
        assert_eq!(apkovl_file(&plain, "etc/appliance/bootstrap-token").as_deref(), Some("tok3n"));
        // The runtime deps for the bun binary + server-side builds ride
        // the world file.
        let world = apkovl_file(&plain, "etc/apk/world").unwrap();
        assert!(world.contains("libstdc++"));
        assert!(world.contains("libgcc"));
        assert!(world.contains("unzip"));

        // Without staged assets: block and token absent.
        let unstaged = build_apkovl(5052, None, false, false, false, 5053, false, "", 8081, "", false).unwrap();
        let start = apkovl_file(&unstaged, "etc/local.d/appliance.start").unwrap();
        assert!(!start.contains("__APISERVER_PROVISION__"), "marker must be substituted");
        assert!(!start.contains("base-config.json"));
        assert!(apkovl_file(&unstaged, "etc/appliance/bootstrap-token").is_none());

        // Agent-only: never provisioned, even with a token passed.
        let agent = build_apkovl(5052, None, true, false, false, 5053, true, "", 8081, "tok3n", true).unwrap();
        let start = apkovl_file(&agent, "etc/local.d/appliance.start").unwrap();
        assert!(!start.contains("__APISERVER_PROVISION__"), "marker must be substituted");
        assert!(!start.contains("base-config.json"));
    }

    #[test]
    fn incomplete_or_malformed_release_evidence_is_poisoned() {
        let root = std::env::temp_dir().join(format!(
            "appliance-release-evidence-test-{}-{:?}",
            std::process::id(), std::thread::current().id()
        ));
        fs::create_dir_all(&root).unwrap();
        let evidence = || ApiServerReleaseEvidence {
            checksums: root.join("appliance-api-server.sha256"),
            properties: root.join("control-plane-release.properties"),
            payload: root.join("control-plane-release.json"),
            envelope: root.join("control-plane-release.sig.json"),
        };
        fs::write(
            root.join("appliance-api-server.sha256"),
            format!(
                "{}  appliance-api-server  15\n{}  appliance-console.tar.gz  20\n",
                "a".repeat(64), "b".repeat(64)
            ),
        ).unwrap();
        fs::write(
            root.join("control-plane-release.properties"),
            format!("keyId=ed25519:sha256:{}\nversion=1.57.0\ngeneration=225\narch=x64\n", "c".repeat(64)),
        ).unwrap();
        fs::write(
            root.join("control-plane-release.json"),
            format!(
                r#"{{"kind":"control-plane-release","version":"1.57.0","generation":225,"artifacts":[{{"name":"appliance-api-server-linux-x64","sha256":"{}","size":15}},{{"name":"appliance-console.tar.gz","sha256":"{}","size":20}}]}}"#,
                "a".repeat(64), "b".repeat(64)
            ),
        ).unwrap();

        let (missing, poisoned) = classify_release_evidence(evidence());
        assert!(missing.is_none());
        assert!(poisoned, "one missing sidecar must not downgrade the seed to unsigned");

        fs::write(root.join("control-plane-release.sig.json"), "not-json\n").unwrap();
        let (malformed, poisoned) = classify_release_evidence(evidence());
        assert!(malformed.is_none());
        assert!(poisoned, "malformed sidecars must produce the guest refusal marker");

        fs::write(
            root.join("control-plane-release.sig.json"),
            format!(
                r#"{{"alg":"ed25519","role":"control-plane-release","keyId":"ed25519:sha256:{}","sig":"fixture"}}"#,
                "c".repeat(64)
            ),
        ).unwrap();
        let (valid, poisoned) = classify_release_evidence(evidence());
        assert!(valid.is_some());
        assert!(!poisoned);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn apiserver_seed_gate_runs_with_restricted_posix_userland_and_rejects_tampering() {
        use std::process::Command;

        fn posix_shell() -> PathBuf {
            #[cfg(windows)]
            {
                for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
                    if let Some(root) = std::env::var_os(variable) {
                        let candidate = PathBuf::from(root).join("Git/bin/sh.exe");
                        if candidate.is_file() {
                            return candidate;
                        }
                    }
                }
                panic!("Git for Windows sh.exe is required for the seed-gate test");
            }
            #[cfg(not(windows))]
            {
                PathBuf::from("/bin/sh")
            }
        }

        fn command_path(shell: &Path, command: &str) -> String {
            let output = Command::new(shell)
                .args(["-c", &format!("command -v {command}")])
                .output()
                .unwrap();
            assert!(output.status.success(), "missing POSIX test tool {command}");
            String::from_utf8(output.stdout).unwrap().trim().to_string()
        }

        fn shell_path(shell: &Path, path: &Path) -> String {
            #[cfg(windows)]
            {
                let output = Command::new(shell)
                    .args(["-c", "cygpath -u \"$1\"", "sh"])
                    .arg(path)
                    .output()
                    .unwrap();
                assert!(output.status.success(), "could not translate Windows test path");
                String::from_utf8(output.stdout).unwrap().trim().to_string()
            }
            #[cfg(not(windows))]
            {
                let _ = shell;
                path.to_string_lossy().into_owned()
            }
        }

        fn write_wrapper(path: &Path, target: &str, arguments: &str) {
            fs::write(
                path,
                format!("#!/bin/sh\nexec \"{target}\"{arguments} \"$@\"\n"),
            )
            .unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
            }
        }

        let root = std::env::temp_dir().join(format!(
            "appliance-seed-gate-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let shell = posix_shell();
        write_wrapper(&bin.join("sh"), "/bin/sh", "");
        // The gate uses only POSIX awk field operations, shared by BSD awk,
        // GNU awk, and BusyBox awk. Deliberately expose no broader userland.
        for tool in ["awk", "cat", "chmod", "cp", "cut", "mkdir", "mv", "rm", "tee", "uname", "wc"] {
            write_wrapper(&bin.join(tool), &command_path(&shell, tool), "");
        }
        let sha256sum = Command::new(&shell)
            .args(["-c", "command -v sha256sum"])
            .output()
            .unwrap();
        if sha256sum.status.success() {
            write_wrapper(
                &bin.join("sha256sum"),
                String::from_utf8(sha256sum.stdout).unwrap().trim(),
                "",
            );
        } else {
            write_wrapper(
                &bin.join("sha256sum"),
                &command_path(&shell, "shasum"),
                " -a 256",
            );
        }
        let restricted_path = shell_path(&shell, &bin);
        let jq_absent = Command::new(&shell)
            .args(["-c", "! command -v jq >/dev/null 2>&1"])
            .env("PATH", &restricted_path)
            .status()
            .unwrap();
        assert!(jq_absent.success(), "restricted seed-gate PATH unexpectedly exposes jq");
        assert!(!APISERVER_SEED_VERIFY.contains("jq"));

        let source = root.join("appliance-api-server");
        fs::write(&source, b"verified-binary").unwrap();
        let digest = crate::images::content_sha256_hex(b"verified-binary");
        let key_id = format!("ed25519:sha256:{}", "a".repeat(64));
        let checksums = root.join("appliance-api-server.sha256");
        fs::write(
            &checksums,
            format!("{digest}  appliance-api-server  {}\n{}  appliance-console.tar.gz  1\n", 15, "b".repeat(64)),
        )
        .unwrap();
        let properties = root.join("control-plane-release.properties");
        let arch = if std::env::consts::ARCH == "aarch64" { "arm64" } else { "x64" };
        fs::write(&properties, format!("keyId={key_id}\nversion=1.57.0\ngeneration=225\narch={arch}\n")).unwrap();
        let script = APISERVER_SEED_VERIFY.replace("__PINNED_RELEASE_KEY_ID__", &key_id);
        let source_path = shell_path(&shell, &source);
        let checksums_path = shell_path(&shell, &checksums);
        let properties_path = shell_path(&shell, &properties);

        let run = |expected: &str| {
            Command::new(&shell)
                .arg("-c")
                .arg(format!("SEED_OK=1\nSEED_ERROR=\n{script}\n[ \"$SEED_OK\" = {expected} ]"))
                .env("PATH", &restricted_path)
                .env("APISERVER_SRC", &source_path)
                .env("RELEASE_CHECKSUMS", &checksums_path)
                .env("RELEASE_PROPERTIES", &properties_path)
                .env("RELEASE_ARCH", arch)
                .output()
                .unwrap()
        };

        let accepted = run("1");
        assert!(accepted.status.success(), "seed gate failed: {}", String::from_utf8_lossy(&accepted.stderr));

        fs::write(&source, b"tampered-binary").unwrap();
        let rejected = run("0");
        assert!(rejected.status.success(), "tampered seed was accepted: {}", String::from_utf8_lossy(&rejected.stderr));

        // Exercise the complete copy/refusal path as well as the verification
        // fragment: a digest mismatch must remove any previously installed
        // binary and persist the warning marker the host doctor reads.
        let payload = root.join("control-plane-release.json");
        let envelope = root.join("control-plane-release.sig.json");
        fs::write(&payload, "{}\n").unwrap();
        fs::write(&envelope, "{}\n").unwrap();
        let destination = root.join("installed-appliance-api-server");
        let warnings = root.join("warnings");
        let seed_log = root.join("seed.log");
        let marker = root.join("seed-warning");
        fs::write(&destination, b"previously-installed-binary").unwrap();
        let full_script = apiserver_seed_copy().replace("__PINNED_RELEASE_KEY_ID__", &key_id);
        let full_rejection = Command::new(&shell)
            .arg("-c")
            .arg(&full_script)
            .env("PATH", &restricted_path)
            .env("APISERVER_MEDIA", shell_path(&shell, &root))
            .env("APISERVER_SRC", &source_path)
            .env("CONSOLE_SRC", shell_path(&shell, &root.join("missing-console.tar.gz")))
            .env("RELEASE_CHECKSUMS", &checksums_path)
            .env("RELEASE_PROPERTIES", &properties_path)
            .env("RELEASE_PAYLOAD", shell_path(&shell, &payload))
            .env("RELEASE_ENVELOPE", shell_path(&shell, &envelope))
            .env("RELEASE_POISON", shell_path(&shell, &root.join("missing-release-poison")))
            .env("APISERVER_DEST", shell_path(&shell, &destination))
            .env("CONSOLE_DEST", shell_path(&shell, &root.join("console")))
            .env("APPLIANCE_WARNINGS_FILE", shell_path(&shell, &warnings))
            .env("APPLIANCE_SEED_LOG", shell_path(&shell, &seed_log))
            .env("APPLIANCE_SEED_MARKER", shell_path(&shell, &marker))
            .output()
            .unwrap();
        assert!(
            full_rejection.status.success(),
            "complete seed refusal failed: {}",
            String::from_utf8_lossy(&full_rejection.stderr)
        );
        assert!(!destination.exists(), "tampered seed must remove the installed api-server");
        let marker_text = fs::read_to_string(&marker).unwrap();
        assert!(marker_text.contains("digest/size mismatch"));
        assert!(marker_text.contains("api-server start refused"));

        // A missing/corrupt current pointer may re-enter the seed path, but
        // stale boot media must never lower the persistent generation floor.
        fs::write(&source, b"verified-binary").unwrap();
        let control_root = root.join("control-plane");
        fs::create_dir_all(control_root.join("releases")).unwrap();
        fs::write(control_root.join("generation"), "300\n").unwrap();
        let seed_accept = Command::new(&shell)
            .arg("-c")
            .arg(&full_script)
            .env("PATH", &restricted_path)
            .env("APISERVER_MEDIA", shell_path(&shell, &root))
            .env("APISERVER_SRC", &source_path)
            .env("CONSOLE_SRC", shell_path(&shell, &root.join("missing-console.tar.gz")))
            .env("RELEASE_CHECKSUMS", &checksums_path)
            .env("RELEASE_PROPERTIES", &properties_path)
            .env("RELEASE_PAYLOAD", shell_path(&shell, &payload))
            .env("RELEASE_ENVELOPE", shell_path(&shell, &envelope))
            .env("RELEASE_POISON", shell_path(&shell, &root.join("missing-release-poison")))
            .env("APISERVER_DEST", shell_path(&shell, &destination))
            .env("CONSOLE_DEST", shell_path(&shell, &root.join("console")))
            .env("CONTROL_PLANE_ROOT", shell_path(&shell, &control_root))
            .env("APPLIANCE_WARNINGS_FILE", shell_path(&shell, &warnings))
            .env("APPLIANCE_SEED_LOG", shell_path(&shell, &seed_log))
            .env("APPLIANCE_SEED_MARKER", shell_path(&shell, &marker))
            .output()
            .unwrap();
        assert!(
            seed_accept.status.success(),
            "valid persistent seed failed: {}",
            String::from_utf8_lossy(&seed_accept.stderr)
        );
        assert_eq!(fs::read_to_string(control_root.join("generation")).unwrap(), "300\n");
        assert!(full_script.contains("[ ! -L \"$CONTROL_PLANE_ROOT/generation\" ]"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn apiserver_ships_the_legacy_quarantine_watchdog() {
        // The watchdog rides only the guest-binary bootstrap: pure-legacy
        // VMs (no staged api-server) must never run it.
        let plain = build_apkovl(5052, None, false, false, false, 5053, false, "", 8081, "tok3n", true).unwrap();
        let start = apkovl_file(&plain, "etc/local.d/appliance.start").unwrap();
        // Sweep: hostname-claiming ingresses outside `default`…
        assert!(start.contains("kubectl get ingress -A -o jsonpath="));
        assert!(start.contains(r#"$1 != "default""#));
        assert!(start.contains(r#"$i == "api.appliance.localhost""#));
        // …and a re-created legacy namespace, but only when Active (a
        // Terminating one is the previous delete still draining).
        assert!(start.contains("kubectl get namespace appliance-system -o jsonpath='{.status.phase}'"));
        // Distinctive warning line lands in the log AND the surfaced file.
        assert!(start.contains("legacy api-server deploy detected and removed"));
        assert!(start.contains("APPLIANCE_WARNINGS_FILE=/var/log/appliance-api-server.warnings"));
        assert!(start.contains(r#"echo "$MSG" >> "$WARNINGS_FILE""#));

        // Gated on the staged binary: absent without assets and on
        // agent-only VMs.
        let unstaged = build_apkovl(5052, None, false, false, false, 5053, false, "", 8081, "", false).unwrap();
        let start = apkovl_file(&unstaged, "etc/local.d/appliance.start").unwrap();
        assert!(!start.contains("APPLIANCE_WARNINGS_FILE"));
        assert!(!start.contains("legacy api-server deploy detected"));
        let agent = build_apkovl(5052, None, true, false, false, 5053, true, "", 8081, "tok3n", true).unwrap();
        let start = apkovl_file(&agent, "etc/local.d/appliance.start").unwrap();
        assert!(!start.contains("APPLIANCE_WARNINGS_FILE"));
    }

    #[test]
    fn apiserver_launcher_never_traces_its_tokens() {
        // The boot script runs under `set -x`, and xtrace EXPANDS
        // command substitutions — so the launcher lines
        // `BOOTSTRAP_TOKEN="$(cat …)"` and `SA_TOKEN=$(kubectl get
        // secret …)` would paint both secrets verbatim into the console
        // log unless the launcher subshell turns tracing off first.
        // Assert `set +x` exists and precedes EVERY token expansion.
        let off = APISERVER_COMMON
            .find("set +x")
            .expect("the api-server launcher must disable xtrace");
        // The launcher subshell's close: every token expansion must sit
        // inside it, or it runs OUTSIDE the `set +x` scope and traces.
        let close = APISERVER_COMMON
            .find("  ) &\n  # Quarantine watchdog")
            .expect("the launcher subshell must close with `) &`");
        let mut last_token = 0usize;
        for token_read in ["SA_TOKEN=", "BOOTSTRAP_TOKEN=", "base64 -d"] {
            let first = APISERVER_COMMON
                .find(token_read)
                .unwrap_or_else(|| panic!("{token_read} expected in the launcher"));
            assert!(
                off < first,
                "`set +x` must come before {token_read} or the secret leaks into console.log"
            );
            let last = APISERVER_COMMON.rfind(token_read).unwrap();
            assert!(
                last < close,
                "every {token_read} expansion must occur inside the launcher subshell (before `) &`)"
            );
            last_token = last_token.max(last);
        }
        // No re-enable between the trace-off and the LAST token
        // expansion — a stray `set -x` there would undo the protection.
        assert!(
            !APISERVER_COMMON[off..last_token].contains("set -x"),
            "`set -x` must not re-enable tracing between `set +x` and the last token expansion"
        );
        // The trace-off is scoped to the backgrounded launcher subshell
        // — it must appear after the subshell opens, so the rest of the
        // bootstrap keeps its (deliberate) tracing.
        let subshell = APISERVER_COMMON.find("(\n").expect("backgrounded launcher subshell");
        assert!(off > subshell, "`set +x` must be inside the launcher subshell");
        // And the boot script itself still traces (the console log is
        // the primary debugging surface).
        assert!(APPLIANCE_START.contains("set -x"));
    }

    #[test]
    fn apiserver_heredocs_terminate() {
        // BASECFG + APIMANIFEST must close — an unterminated heredoc
        // would swallow the rest of the bootstrap silently.
        for tag in ["BASECFG", "APIMANIFEST"] {
            let opens = APISERVER_COMMON.matches(&format!("<<{tag}")).count();
            let closes = APISERVER_COMMON.lines().filter(|l| l.trim() == tag).count();
            assert_eq!(opens, 1, "{tag} must open once");
            assert_eq!(closes, 1, "the {tag} heredoc must terminate at column 0");
        }
    }

    #[test]
    fn apiserver_manifest_heredoc_has_no_command_substitution() {
        // The APIMANIFEST heredoc is unquoted (it must expand $GUEST_IP at
        // runtime), so a backtick pair anywhere in its body runs as a
        // command during expansion. A stray `appliance-api-server` in a
        // comment once did exactly that — launching the server binary
        // mid-heredoc, which never exits, so the `cat` hung and the manifest
        // was written empty (no Service/Endpoints/token Secret → the guest
        // control plane never became reachable). Guard the body.
        let body = APISERVER_COMMON
            .split_once("<<APIMANIFEST")
            .and_then(|(_, rest)| rest.split_once("\nAPIMANIFEST"))
            .map(|(body, _)| body)
            .expect("APIMANIFEST heredoc present");
        assert!(
            !body.contains('`'),
            "the unquoted APIMANIFEST heredoc must not contain backticks (they run as commands)"
        );
    }

    #[test]
    fn bootstrap_token_persists_and_round_trips() {
        let dir = std::env::temp_dir().join(format!("appliance-token-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let first = ensure_bootstrap_token(&dir).unwrap();
        assert_eq!(first.len(), 64, "32 random bytes, hex-encoded");
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        let second = ensure_bootstrap_token(&dir).unwrap();
        assert_eq!(first, second, "the token is generated once and reused");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn k3s_provisioned_only_for_non_agent_only_vms() {
        // Normal VM: the k3s block is present and the marker is gone.
        let k3s = build_apkovl(5052, None, true, false, false, 5053, false, "", 8081, "", false).unwrap();
        let start = apkovl_file(&k3s, "etc/local.d/appliance.start").unwrap();
        assert!(!start.contains("__K3S_PROVISION__"), "marker must be substituted");
        assert!(start.contains("k3s server"), "k3s launches on a normal VM");
        assert!(start.contains("/srv/handoff/k3s.yaml"), "the kubeconfig handoff is served");
        // No agent-runtime handoff on a normal VM.
        assert!(!start.contains("agent-ready"));

        // Agent-only VM: the k3s block is GONE, replaced by the agent
        // handoff that waits on .dev-ready and serves the agent-ready
        // sentinel.
        let agent = build_apkovl(5052, None, true, false, false, 5053, true, "", 8081, "", false).unwrap();
        let start = apkovl_file(&agent, "etc/local.d/appliance.start").unwrap();
        assert!(!start.contains("__K3S_PROVISION__"), "marker must be substituted");
        assert!(!start.contains("k3s server"), "agent-only provisions NO k3s");
        assert!(!start.contains("registries.yaml"), "no in-VM registry on an agent VM");
        // Gates on the grippable .dev-ready marker (Quinn gap #2), NOT the
        // shell agent's console echo.
        assert!(start.contains("while [ ! -f /persist/.dev-ready ]"));
        assert!(start.contains("echo agent-ready > /srv/handoff/agent-ready"));
    }

    #[test]
    fn k3s_bringup_serves_grippable_progress_markers() {
        let ovl = build_apkovl(5052, None, false, false, false, 5053, false, "", 8081, "", false).unwrap();
        let start = apkovl_file(&ovl, "etc/local.d/appliance.start").unwrap();
        // The handoff httpd starts at the TOP of the k3s block (not gated
        // on k3s.yaml existing) so the host can poll /progress through the
        // whole cluster window.
        let httpd_at = start
            .find(&format!("httpd -f -p {KUBECONFIG_PORT} -h /srv/handoff"))
            .unwrap();
        // Anchor on the LAUNCH LINE itself ("/usr/local/bin/k3s server"),
        // never bare "k3s server" — prose in the bootstrap's comments
        // could shadow a bare needle and let the ordering rot unnoticed.
        let k3s_at = start.find("/usr/local/bin/k3s server").unwrap();
        assert!(httpd_at < k3s_at, "handoff httpd must start before k3s launches");
        // Grippable markers (never console echo), appended in order:
        // base system up before k3s, the API marker after it.
        assert!(start.contains(": > /srv/handoff/progress"));
        let base_at = start.find("echo base-system-ready >> /srv/handoff/progress").unwrap();
        let api_at = start.find("echo k3s-api-up >> /srv/handoff/progress").unwrap();
        assert!(base_at < k3s_at, "base-system-ready precedes the k3s launch");
        assert!(k3s_at < api_at, "k3s-api-up follows the k3s launch");
        // The kubeconfig is still published for the host fetch, before the
        // API marker fires (the marker means "the file is fetchable").
        let copy_at = start.find("cp /etc/rancher/k3s/k3s.yaml /srv/handoff/k3s.yaml").unwrap();
        assert!(copy_at < api_at, "k3s.yaml is published before k3s-api-up");
    }

    #[test]
    fn k3s_airgap_preload_probes_by_label_and_marks_progress() {
        let ovl = build_apkovl(5052, None, false, false, false, 5053, false, "", 8081, "", false).unwrap();
        let start = apkovl_file(&ovl, "etc/local.d/appliance.start").unwrap();
        // The vz boot media arms the probe; the marker itself must be gone.
        assert!(!start.contains("__K3S_AIRGAP_PREAMBLE__"), "marker must be substituted");
        assert!(start.contains("APPLIANCE_AIRGAP_PROBE=1"), "vz arms the airgap probe");
        // Device discovery is BY VOLUME LABEL, never a hard-coded node —
        // /dev/vdc is the agent image on agent VMs (a separate test pins
        // that a k3s VM's bootstrap has no /dev/vdc at all).
        assert!(
            start.contains(&format!("LABEL=\"{K3S_AIRGAP_VOLUME_LABEL}\"")),
            "the guest must probe blkid for the platform-images label"
        );
        assert!(!start.contains("AIRGAP_DEV=/dev/"), "no hard-coded airgap device node");
        // Stamp-guarded copy into k3s's auto-import dir, with the T2 hook.
        assert!(start.contains(&format!("$PERSIST/k3s/agent/images/{K3S_AIRGAP_MEDIA_FILE}")));
        assert!(start.contains(&format!("cp /media/k3s-images/{K3S_AIRGAP_MEDIA_FILE}")));
        assert!(start.contains("echo images-imported >> /srv/handoff/progress"));
        // Crash-atomic staging: the copy lands at a .tmp sibling and mv
        // (same filesystem) is the commit point — the stamp name never
        // exists truncated, and a failed cp sweeps only the .tmp.
        assert!(start.contains(&format!(
            "cp /media/k3s-images/{K3S_AIRGAP_MEDIA_FILE} \"$PERSIST/k3s/agent/images/{K3S_AIRGAP_MEDIA_FILE}.tmp\""
        )));
        assert!(start.contains(&format!(
            "mv \"$PERSIST/k3s/agent/images/{K3S_AIRGAP_MEDIA_FILE}.tmp\" \"$PERSIST/k3s/agent/images/{K3S_AIRGAP_MEDIA_FILE}\""
        )));
        assert!(start.contains(&format!("rm -f \"$PERSIST/k3s/agent/images/{K3S_AIRGAP_MEDIA_FILE}.tmp\"")));
        // The preload runs before k3s server starts (containerd imports at
        // startup) and after the persist mount. Anchored on the REAL code
        // lines — the probe's `if` and the launch line — never on comment
        // prose that could shadow the needles.
        let preload_at = start.find(r#"if [ -n "$APPLIANCE_AIRGAP_PROBE" ]"#).unwrap();
        let k3s_at = start.find("/usr/local/bin/k3s server").unwrap();
        let mount_at = start.find("mount -t ext4 /dev/vda").unwrap();
        assert!(mount_at < preload_at && preload_at < k3s_at, "preload sits between the persist mount and k3s launch");

        // Agent-only VMs run no k3s: the preload block is absent entirely.
        let agent = build_apkovl(5052, None, true, false, false, 5053, true, "", 8081, "", false).unwrap();
        let start = apkovl_file(&agent, "etc/local.d/appliance.start").unwrap();
        assert!(!start.contains("APPLIANCE_AIRGAP_PROBE"), "no airgap preload on agent-only VMs");
        assert!(!start.contains("__K3S_AIRGAP_PREAMBLE__"));
    }

    #[test]
    fn vz_media_nodes_match_the_storage_attachment_contract() {
        assert!(guest_cmdline().contains("modloop=/media/vdb/"));
        assert!(runtime_guest_cmdline().contains("modloop=/media/vdb/"));

        let agent = build_apkovl(5052, None, true, false, false, 5053, true, "agent", 8081, "", false)
            .unwrap();
        let start = apkovl_file(&agent, "etc/local.d/appliance.start").unwrap();
        assert!(start.contains("mount -t squashfs -o ro /dev/vdc /opt/appliance/agents"));

        let source = include_str!("backend/vz/mod.rs");
        let data = source.find("Retained::into_super(block_device)").unwrap();
        let boot = source.find("Retained::into_super(media_device)").unwrap();
        let agent = source.find("storage.push(Retained::into_super(agent_device))").unwrap();
        let platform = source.find("storage.push(Retained::into_super(images_device))").unwrap();
        let control = source.find("storage.push(Retained::into_super(control_plane_device))").unwrap();
        assert!(data < boot && boot < agent && agent < platform && platform < control);
    }

    #[test]
    fn airgap_volume_label_fits_fat_and_matches_the_probe() {
        // FAT labels are at most 11 bytes (the builder space-pads to
        // exactly 11); an oversized const would panic the copy there.
        assert!(K3S_AIRGAP_VOLUME_LABEL.len() <= 11);
        // The guest probe greps blkid for the label VERBATIM — busybox
        // blkid prints it space-trimmed, so it must carry none itself.
        assert_eq!(K3S_AIRGAP_VOLUME_LABEL, K3S_AIRGAP_VOLUME_LABEL.trim());
        // And distinct from the boot media's label, so the probe can never
        // grab the wrong FAT volume.
        assert_ne!(K3S_AIRGAP_VOLUME_LABEL, "APPLIANCE");
    }

    #[test]
    fn agent_only_substitution_leaks_no_literal_port_markers() {
        // Quinn gap #1: the branch is injected before the port markers, so
        // the agent handoff's nested __KUBECONFIG_PORT__ must be expanded —
        // never survive as a literal. Assert no marker survives and the
        // real port is embedded on the handoff httpd.
        let agent = build_apkovl(5052, None, true, false, false, 5053, true, "", 8081, "", false).unwrap();
        let start = apkovl_file(&agent, "etc/local.d/appliance.start").unwrap();
        for marker in [
            "__K3S_PROVISION__",
            "__KUBECONFIG_PORT__",
            "__REGISTRY_NODEPORT__",
            "__REGISTRY_HOST_PORT__",
            "__AGENT_DOCKER_STUB__",
            "__BUILDKIT_PROVISION__",
            "__BUILDKITD_GUEST_PORT__",
        ] {
            assert!(!start.contains(marker), "literal marker {marker} leaked into agent-only bootstrap");
        }
        // The sentinel httpd binds the real KUBECONFIG_PORT, not a literal.
        assert!(start.contains(&format!("httpd -f -p {KUBECONFIG_PORT} -h /srv/handoff")));
    }

    #[test]
    fn agent_only_docker_stub_gated_on_the_docker_flag() {
        // No --docker: the honest-failure docker shim is dropped so an
        // unflagged `docker` call doesn't silently break.
        let no_docker = build_apkovl(5052, None, true, false, false, 5053, true, "", 8081, "", false).unwrap();
        let start = apkovl_file(&no_docker, "etc/local.d/appliance.start").unwrap();
        assert!(start.contains("/usr/local/bin/docker"), "no-docker agent VM gets the honest-error shim");
        assert!(start.contains("Relaunch the agent with: appliance agent start --docker"));

        // --docker: the shim is skipped so it never shadows the real engine
        // the docker provision installs.
        let with_docker = build_apkovl(5052, None, true, false, true, 5053, true, "", 8081, "", false).unwrap();
        let start = apkovl_file(&with_docker, "etc/local.d/appliance.start").unwrap();
        assert!(!start.contains("/usr/local/bin/docker"), "--docker agent VM must not shim docker");
        assert!(start.contains("apk add --no-progress docker docker-cli-compose"), "real docker is provisioned");
        // A normal (non-agent) VM never carries the shim either.
        let normal = build_apkovl(5052, None, false, false, false, 5053, false, "", 8081, "", false).unwrap();
        let start = apkovl_file(&normal, "etc/local.d/appliance.start").unwrap();
        assert!(!start.contains("/usr/local/bin/docker"));
    }

    #[test]
    fn agent_only_mounts_the_prebuilt_squashfs_and_puts_its_bin_first_on_path() {
        // Agent-only: the read-only squashfs (vdc) is mounted at
        // /opt/appliance/agents and its bin is PATH-FIRST so the baked CLIs
        // win and an agent can't shadow them (docs/fast-spin-up.md §2.4).
        let agent = build_apkovl(5052, None, true, false, false, 5053, true, "", 8081, "", false).unwrap();
        let start = apkovl_file(&agent, "etc/local.d/appliance.start").unwrap();
        assert!(
            start.contains("mount -t squashfs -o ro /dev/vdc /opt/appliance/agents"),
            "agent-only VM mounts the prebuilt image read-only on vdc"
        );
        assert!(
            start.contains("export PATH=\"/opt/appliance/agents/bin:/persist/npm-global/bin:$PATH\""),
            "the squashfs bin must be first on PATH for agent-only VMs"
        );
        assert!(!start.contains("__AGENT_BIN_PATH__"), "the PATH marker must be substituted");

        // A normal (non-agent) VM has no squashfs: no mount, and its bin is
        // NOT on PATH (the marker expands to empty).
        let normal = build_apkovl(5052, None, true, false, false, 5053, false, "", 8081, "", false).unwrap();
        let start = apkovl_file(&normal, "etc/local.d/appliance.start").unwrap();
        assert!(!start.contains("/dev/vdc"), "non-agent VM attaches no agent image");
        assert!(!start.contains("/opt/appliance/agents/bin"), "non-agent VM keeps the squashfs bin off PATH");
        assert!(
            start.contains("export PATH=\"/persist/npm-global/bin:$PATH\""),
            "non-agent dev VM still moves the npm prefix off the mounted HOME"
        );
        assert!(!start.contains("__AGENT_BIN_PATH__"));
    }

    #[test]
    fn npm_global_wipes_on_a_project_switch_only_with_a_project_identity() {
        // Sasha #2: with a project identity (a mounted project), the
        // bootstrap wipes /persist/npm-global when the recorded project
        // differs — closing the cross-project PATH-persistence vector.
        let with_project = build_apkovl(5052, None, true, true, false, 5053, true, "deadbeefcafe0001", 8081, "", false).unwrap();
        let start = apkovl_file(&with_project, "etc/local.d/appliance.start").unwrap();
        assert!(start.contains("APPLIANCE_PROJECT='deadbeefcafe0001'"), "the project identity is stamped in");
        assert!(
            start.contains("rm -rf /persist/npm-global"),
            "a project switch wipes the npm prefix"
        );
        assert!(
            start.contains("/persist/.npm-global-project"),
            "the last-provisioned project is recorded for the next-boot comparison"
        );
        assert!(!start.contains("__PROJECT_ID__"), "the project marker must be substituted");

        // No mount ⇒ empty identity ⇒ the guard is inert (the `-n` test is
        // false), so npm-global is never wiped out from under a project.
        let no_project = build_apkovl(5052, None, true, false, false, 5053, true, "", 8081, "", false).unwrap();
        let start = apkovl_file(&no_project, "etc/local.d/appliance.start").unwrap();
        assert!(start.contains("APPLIANCE_PROJECT=''"), "no mount ⇒ empty project identity");
    }

    #[test]
    fn core_agent_and_k3s_host_service_plans_preserve_network_invariants() {
        let core = crate::spec::VmSpec::defaults("core");
        let plan = plan_host_services(&core);
        assert!(plan.persist_guest_ip, "core VMs write guest-ip");
        assert!(!plan.wire_k3s_forwards, "core VMs skip k3s host forwards");
        assert_eq!(plan.readiness, HostReadiness::Core);

        // SASHA #1 (acceptance criterion): the host-services plan persists
        // guest-ip for an agent-only VM exactly as for a k3s VM — the
        // broker peer-pin + the netstack lease attribution depend on it.
        // Only the k3s forwards are dropped.
        let mut agent = crate::spec::VmSpec::defaults("sbx");
        agent.agent_only = true;
        agent.dev = true;
        let plan = plan_host_services(&agent);
        assert!(plan.persist_guest_ip, "agent-only MUST still write guest-ip (Sasha #1)");
        assert!(!plan.wire_k3s_forwards, "agent-only skips the k3s host forwards");
        assert_eq!(plan.readiness, HostReadiness::Agent);

        let runtime = crate::spec::VmSpec::runtime_defaults("appliance-runtime");
        let plan = plan_host_services(&runtime);
        assert!(plan.persist_guest_ip, "runtime VMs write guest-ip");
        assert!(!plan.wire_k3s_forwards, "runtime VMs skip k3s host forwards");
        assert_eq!(plan.readiness, HostReadiness::Runtime);

        // A normal (k3s) VM persists guest-ip AND wires the k3s forwards,
        // and gates on the kubeconfig handoff.
        let mut k3s = crate::spec::VmSpec::defaults("appliance");
        k3s.cluster = true;
        let plan = plan_host_services(&k3s);
        assert!(plan.persist_guest_ip, "k3s VMs write guest-ip too");
        assert!(plan.wire_k3s_forwards, "k3s VMs wire the api/ingress/registry forwards");
        assert_eq!(plan.readiness, HostReadiness::K3s);
    }

    #[test]
    fn runtime_overlay_selects_only_local_signed_repositories() {
        let overlay = build_apkovl_for_readiness(
            8102,
            None,
            false,
            false,
            false,
            8103,
            HostReadiness::Runtime,
            "",
            8100,
            "",
            None,
        )
        .unwrap();
        let repositories = apkovl_file(&overlay, "etc/apk/repositories").unwrap();
        assert_eq!(repositories, "/media/vdc/apks/main\n/media/vdc/apks/community\n");
        assert!(!repositories.contains("https://"));
        let world = apkovl_file(&overlay, "etc/apk/world").unwrap();
        assert!(world.lines().any(|package| package == "containerd=2.0.0-r5"));
        assert!(world.lines().any(|package| package == "containerd-ctr=2.0.0-r5"));
        assert!(world.lines().any(|package| package == "nftables=1.1.1-r0"));
        assert!(world.lines().any(|package| package == "socat=1.8.1.3-r0"));
        assert!(world.lines().any(|package| package == "openssl=3.3.7-r0"));
        assert!(world.lines().any(|package| package == "libssl3=3.3.7-r0"));
        assert!(world.lines().any(|package| package == "libcrypto3=3.3.7-r0"));
        let start = apkovl_file(&overlay, "etc/local.d/appliance.start").unwrap();
        assert!(start.contains("cgroup.subtree_control"));
        let self_check = start.find("socat -V").unwrap();
        let ready = start.find("appliance-runtime: supervisor ready").unwrap();
        assert!(self_check < ready, "socat ABI self-check must gate Runtime readiness");
        assert!(start.contains("offline Runtime APK set is ABI-inconsistent"));
    }

    #[test]
    fn runtime_supervisor_enforces_principal_isolation_and_bounded_logs() {
        let supervisor = RUNTIME_SUPERVISOR;
        assert!(supervisor.contains("--user \"$UID_NUM:$UID_NUM\" --cgroup \"appliance/$APP\""));
        assert!(supervisor.contains("--seccomp --with-ns"));
        for capability in [
            "CAP_CHOWN",
            "CAP_DAC_OVERRIDE",
            "CAP_FSETID",
            "CAP_FOWNER",
            "CAP_MKNOD",
            "CAP_NET_RAW",
            "CAP_SETGID",
            "CAP_SETUID",
            "CAP_SETFCAP",
            "CAP_SETPCAP",
            "CAP_NET_BIND_SERVICE",
            "CAP_SYS_CHROOT",
            "CAP_KILL",
            "CAP_AUDIT_WRITE",
        ] {
            assert!(supervisor.contains(&format!("--cap-drop {capability}")));
        }
        assert!(!supervisor.contains("echo $$ > \"$CG/cgroup.procs\""));
        assert!(supervisor.contains("grep -qx \"$TASK_PID\" \"$CG/cgroup.procs\""));
        assert!(supervisor.contains("net.ipv4.ip_forward=1"));
        assert!(supervisor.contains("net.ipv4.conf.eth0.proxy_arp=1"));
        assert!(supervisor.contains("net.ipv4.conf.$ROOT_IF.proxy_arp=1"));
        assert!(supervisor.contains("principal_input iifname \"r*\" drop"));
        assert!(supervisor.contains("principal_forward iifname \"r*\" oifname != \"eth0\" drop"));
        assert!(supervisor.contains("TCP-LISTEN:$RELAY,bind=$ETH0_IP"));
        assert!(supervisor.contains("MAX_LOG_BYTES=8388608"));
        assert!(supervisor.contains("$STATE/log-base"));
        assert!(supervisor.contains("APPLIANCE_EGRESS_CA"));
        assert!(supervisor.contains("dst=/appliance-egress-ca.pem"));
        assert!(supervisor.contains("[ ! -f \"$EGRESS_CA\" ]"));
        assert!(supervisor.contains("[ -f \"$EGRESS_CA\" ]"));
        assert!(supervisor.contains(
            "{\"state\":\"failed\",\"message\":\"egress CA certificate is unavailable\"}"
        ));

        for line in supervisor.lines().filter(|line| line.trim_start().starts_with("nft ")) {
            assert!(!line.contains("|| true"), "nft rule must fail closed: {line}");
        }
    }

    #[test]
    fn runtime_supervisor_creates_plan_files_owner_only_and_keeps_proxy_credentials_out_of_argv() {
        let supervisor = format!("{RUNTIME_SUPERVISOR}\n{RUNTIME_COMPOUND_SUPERVISOR}");
        for script in [RUNTIME_SUPERVISOR, RUNTIME_COMPOUND_SUPERVISOR] {
            let umask = script.find("umask 077").expect("owner-only umask");
            let first_state_write = script
                .find("> \"$STATE/")
                .expect("supervisor writes runtime state");
            assert!(
                umask < first_state_write,
                "owner-only umask must be active when the first state file is created"
            );
        }
        for protected_creation in [
            "> \"$STATE/request.json\"",
            "> \"$STATE/env.tsv\"",
            "> \"$STATE/ctr.env\"",
            "> \"$SERVICE/plan.json\"",
            "> \"$SERVICE/env.tsv\"",
            "> \"$SERVICE/ctr.env\"",
        ] {
            assert!(
                supervisor.contains(protected_creation),
                "protected file must be created while umask 077 is active: {protected_creation}"
            );
        }
        assert_eq!(supervisor.matches("--env-file").count(), 2);
        assert_eq!(supervisor.matches("set -- \"$@\" --env \"$KEY=$DECODED\"").count(), 2);
        assert!(supervisor.contains(
            "HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy"
        ));
        assert!(supervisor.contains("proxy environment values must not contain newlines"));
    }

    // These launcher probes execute /bin/sh and therefore only run on Unix hosts.
    #[cfg(unix)]
    fn assert_generated_launcher_argv_is_secret_safe(
        supervisor: &str,
        launcher_marker: &str,
        ctr_marker: &str,
        label: &str,
        compound: bool,
    ) {
        use base64::Engine as _;

        let launcher = &supervisor[supervisor
            .find(launcher_marker)
            .unwrap_or_else(|| panic!("{label}: generated launcher marker"))..];
        let ctr_start = launcher
            .find(ctr_marker)
            .unwrap_or_else(|| panic!("{label}: generated ctr invocation"));
        let ctr_end = ctr_start
            + launcher[ctr_start..]
                .find('\n')
                .unwrap_or_else(|| panic!("{label}: ctr invocation line ending"))
            + 1;
        // Keep the generated outer single-quoted sh -c syntax in the probe:
        // that outer parse is exactly where an inner `printf '\t'` loses its
        // quotes. Stop after the first ctr launch so compound restart/health
        // policy does not obscure the argv boundary under test.
        let mut probe = launcher[..ctr_end].replacen("nohup setsid sh -c", "/bin/sh -c", 1);
        if compound {
            probe.push_str("      fi\n      wait\n      break\n    done\n    exit 0\n  '\n");
        } else {
            probe.push_str("      fi\n      wait\n      exit 0\n    '\n");
        }

        let dir = std::env::temp_dir().join(format!(
            "appliance-runtime-launcher-{label}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create launcher probe directory");
        let state = dir.join("state");
        let service = state.join("service");
        fs::create_dir_all(&service).expect("create launcher probe state");

        let credential = "http://user:secret-with-token-0@proxy.internal:8080";
        let multiline = "-----BEGIN VALUE-----\nline two\n-----END VALUE-----\n";
        let encode = |value: &str| base64::engine::general_purpose::STANDARD.encode(value);
        let encoded_credential = encode(credential);
        assert!(
            encoded_credential.contains('t'),
            "the credential fixture must exercise the historical IFS=t split"
        );
        let env_tsv = format!(
            "HTTPS_PROXY\t{encoded_credential}\nHTTP_PROXY\t{}\nMULTILINE_VALUE\t{}\n",
            encode(credential),
            encode(multiline)
        );
        let runtime_dir = if compound { &service } else { &state };
        fs::write(runtime_dir.join("env.tsv"), env_tsv).expect("write env.tsv fixture");
        let proxy_env = format!("HTTPS_PROXY={credential}\nHTTP_PROXY={credential}\n");
        fs::write(runtime_dir.join("ctr.env"), &proxy_env).expect("write proxy env-file fixture");
        fs::write(runtime_dir.join("current.log"), "").expect("create launcher log");
        if compound {
            fs::write(state.join("desired"), "starting\n").expect("write desired-state fixture");
            fs::write(service.join("image"), "fixture-image\n").expect("write image fixture");
        }

        let argv_log = dir.join("ctr.argv");
        let ctr_stub = dir.join("ctr");
        fs::write(
            &ctr_stub,
            r#"#!/bin/sh
: > "$CTR_ARGV"
for ARG do
  printf '%s' "$ARG" | base64 | tr -d '\n'
  printf '\n'
done >> "$CTR_ARGV"
"#,
        )
        .expect("write ctr stub");
        let chmod = std::process::Command::new("chmod")
            .args(["0700", ctr_stub.to_str().expect("utf-8 ctr stub path")])
            .status()
            .expect("chmod ctr stub");
        assert!(chmod.success(), "make ctr stub executable");

        let path = format!(
            "{}:{}",
            dir.display(),
            std::env::var("PATH").expect("PATH for shell probe")
        );
        let mut command = std::process::Command::new("/bin/sh");
        command
            .args(["-c", &probe])
            .env("PATH", path)
            .env("CTR_ARGV", &argv_log)
            .env("STATE", &state)
            .env("SERVICE", &service)
            .env("KIND", "container")
            .env("EGRESS_CA", dir.join("missing-egress-ca.crt"))
            .env("CTR_NS", "fixture-ns")
            .env("UID_NUM", "20000")
            .env("APP", "fixture-app")
            .env("SVC", "fixture-service")
            .env("NS", "fixture-netns")
            .env("IMAGE", "fixture-image")
            .env("CID", "fixture-cid");
        let output = command.output().expect("execute generated launcher with /bin/sh");
        assert!(
            output.status.success(),
            "{label}: generated launcher probe failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        let encoded_argv = fs::read_to_string(&argv_log).expect("read captured ctr argv");
        let argv: Vec<String> = encoded_argv
            .lines()
            .map(|arg| {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(arg)
                    .expect("decode captured ctr argument");
                String::from_utf8(bytes).expect("captured ctr argument is utf-8")
            })
            .collect();
        assert!(
            !argv.iter().any(|arg| arg.contains(credential)),
            "{label}: proxy credential must never appear in ctr argv: {argv:?}"
        );
        assert!(
            !argv.iter().any(|arg| arg.contains("HTTP_PROXY") || arg.contains("HTTPS_PROXY")),
            "{label}: proxy variables belong only in the env-file: {argv:?}"
        );
        assert!(
            argv.windows(2).any(|pair| pair[0] == "--env-file"
                && pair[1] == runtime_dir.join("ctr.env").to_string_lossy()),
            "{label}: ctr must receive the proxy env-file: {argv:?}"
        );
        assert!(
            argv.windows(2).any(|pair| pair[0] == "--env"
                && pair[1] == format!("MULTILINE_VALUE={multiline}")),
            "{label}: multiline non-proxy value must remain one --env argument: {argv:?}"
        );
        assert_eq!(
            fs::read_to_string(runtime_dir.join("ctr.env")).expect("read proxy env-file"),
            proxy_env,
            "{label}: proxy values must remain intact in the env-file"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn runtime_single_app_generated_launcher_keeps_proxy_credentials_out_of_executed_ctr_argv() {
        assert_generated_launcher_argv_is_secret_safe(
            RUNTIME_SUPERVISOR,
            "nohup setsid sh -c '\n  echo $$ > \"$STATE/pid\"",
            "ctr -n \"$CTR_NS\" run --rm --user \"$UID_NUM:$UID_NUM\" --cgroup \"appliance/$APP\"",
            "single-app",
            false,
        );
    }

    #[cfg(unix)]
    #[test]
    fn runtime_compound_generated_launcher_keeps_proxy_credentials_out_of_executed_ctr_argv() {
        assert_generated_launcher_argv_is_secret_safe(
            RUNTIME_COMPOUND_SUPERVISOR,
            "nohup setsid sh -c '\n    echo $$ > \"$SERVICE/worker.pid\"",
            "ctr -n \"$CTR_NS\" run --rm --user \"$UID_NUM:$UID_NUM\" --cgroup \"appliance/$APP/$SVC\"",
            "compound",
            true,
        );
    }

    #[test]
    fn runtime_supervisor_passes_multiline_non_proxy_environment_as_one_argv_entry() {
        let value = "-----BEGIN CERTIFICATE-----\nline two\n-----END CERTIFICATE-----\n";
        let script = r#"
            KEY=TLS_CERT
            VALUE=$1
            EXPECTED=$2
            DECODED=$(printf '%s' "$VALUE" | base64 -d; printf x); DECODED=${DECODED%x}
            set -- --env "$KEY=$DECODED"
            test "$2" = "TLS_CERT=$EXPECTED"
        "#;
        use base64::Engine as _;
        let encoded = base64::engine::general_purpose::STANDARD.encode(value);
        let status = std::process::Command::new("sh")
            .args(["-c", script, "runtime-env-test", &encoded, value])
            .status()
            .expect("run argv-preservation shell probe");
        assert!(status.success(), "multiline value must remain one --env argument");
    }

    #[test]
    fn runtime_supervisor_stages_binary_without_following_symlinks_and_reuses_hardening() {
        let supervisor = RUNTIME_SUPERVISOR;
        let copy = supervisor
            .find("cp -R --no-preserve=mode,ownership \"$SOURCE/.\" \"$STAGED/\"")
            .expect("binary payload is copied into private staging");
        let busybox_copy = supervisor
            .find("cp -R \"$SOURCE/.\" \"$STAGED/\"")
            .expect("BusyBox has an equivalent non-archive staging path");
        let symlink_check = supervisor
            .find("find \"$STAGED\" -type l -print -quit")
            .expect("staged payload rejects symlinks");
        let special_file_check = supervisor
            .find("find \"$STAGED\" ! -type d ! -type f -print -quit")
            .expect("staged payload rejects special files");
        assert!(copy < symlink_check);
        assert!(busybox_copy < symlink_check);
        assert!(copy < special_file_check);
        assert!(busybox_copy < special_file_check);
        assert!(!supervisor.contains("find \"$SOURCE\""));
        assert!(supervisor.contains("chown -R \"$UID_NUM:$UID_NUM\" \"$STAGED\""));
        assert!(supervisor.contains("chmod 0755 \"$STAGED/$ENTRYPOINT\""));
        assert!(supervisor.contains(".plan.target.args[] | @base64"));
        assert!(supervisor.contains(
            "set -- \"$@\" --rootfs --cwd \"$BINARY_CWD\" \"$STAGED\" \"$CID\" \"/$ENTRYPOINT\""
        ));
        assert!(supervisor.contains("set -- \"$@\" \"$DECODED\""));
        assert!(supervisor.contains("\"network:/var/run/netns/$NS\" \"$@\" >>"));
        assert!(!supervisor.contains("eval "));
        assert!(supervisor.contains("--rootfs --cwd \"$BINARY_CWD\" \"$STAGED\" \"$CID\" \"/$ENTRYPOINT\""));
        assert!(supervisor.contains("printf '{\"state\":\"exited\",\"exitCode\":%s}\\n' \"$CODE\""));
        assert_eq!(
            supervisor
                .matches(
                    "--user \"$UID_NUM:$UID_NUM\" --cgroup \"appliance/$APP\" --seccomp --with-ns \"network:/var/run/netns/$NS\"",
                )
                .count(),
            2,
            "container and binary launchers must share the hardened ctr flags"
        );
    }

    #[test]
    fn mv1_overlay_composes_isolated_volume_raw_listener_psa_and_supervisor() {
        let key = format!("ed25519:sha256:{}", "a".repeat(64));
        let overlay = build_apkovl_for_readiness(
            5052, None, false, false, false, 5053, HostReadiness::K3s,
            "", 8081, "token", Some(ReleaseGate { pinned_key_id: &key, evidence: None, poison: false }),
        ).unwrap();
        let start = apkovl_file(&overlay, "etc/local.d/appliance.start").unwrap();
        assert!(start.contains("blkid -L appliance-control-plane"));
        assert!(start.contains("nosymfollow"));
        let control_plane_mount = start.find("mount -t ext4 -o nodev,nosuid").unwrap();
        let control_plane_resize = start.find("resize2fs \"$CONTROL_PLANE_DEVICE\"").unwrap();
        assert!(control_plane_mount < control_plane_resize);
        assert!(!start.contains("mkfs.ext4 -q -L appliance-control-plane /dev/vdb"));
        assert!(start.contains("/run/appliance/capabilities/control-plane-update-v1"));
        assert!(start.contains(&format!("VSOCK-LISTEN:{ARTIFACT_VSOCK_PORT}")));
        assert!(start.contains("EXEC:/usr/local/bin/appliance-control-plane-artifact-agent,stderr"));
        assert!(start.contains("pod-security.kubernetes.io/enforce: restricted"));
        assert!(start.contains("!has(v.hostPath)"));
        assert!(start.contains("operator: DoesNotExist"));
        assert!(start.contains("v.hostPath.path.startsWith('/var/lib/appliance-control-plane/')"));
        assert!(start.contains("'/var/lib/appliance-control-plane'.startsWith(v.hostPath.path + '/')"));
        assert!(start.contains("v.hostPath.path != '/'"));
        assert!(start.contains("appliance-control-plane-supervisor"));
        let receiver = apkovl_file(&overlay, "usr/local/bin/appliance-control-plane-artifact-agent").unwrap();
        assert!(receiver.contains("PARTIAL=\"$DEST.partial.$$\""));
        let update = apkovl_file(&overlay, "usr/local/bin/appliance-control-plane-update").unwrap();
        assert!(update.contains(&key));
        assert!(!update.contains("__PINNED_RELEASE_KEY_ID__"));
        assert!(update.contains("find \"$INCOMING\" -mindepth 1 -delete"));
        assert!(update.contains("[ ! -L \"$ROOT/generation\" ]"));
    }

    #[cfg(unix)]
    #[test]
    fn control_plane_update_binds_evidence_and_generation_to_content() {
        use std::os::unix::fs::PermissionsExt;
        use std::process::Command;

        fn stage(
            incoming: &Path,
            key_id: &str,
            arch: &str,
            release: (&str, u64),
            payload: (&str, u64),
            digest: &str,
            binary: &[u8],
        ) {
            let (version, generation) = release;
            let (payload_version, payload_generation) = payload;
            fs::create_dir_all(incoming).unwrap();
            fs::write(incoming.join("binary"), binary).unwrap();
            fs::write(
                incoming.join("appliance-api-server.sha256"),
                format!("{digest}  appliance-api-server  {}\n", binary.len()),
            )
            .unwrap();
            fs::write(
                incoming.join("control-plane-release.properties"),
                format!("keyId={key_id}\nversion={version}\ngeneration={generation}\narch={arch}\n"),
            )
            .unwrap();
            fs::write(
                incoming.join("control-plane-release.json"),
                format!(
                    r#"{{"version":"{payload_version}","generation":{payload_generation},"artifacts":[{{"name":"appliance-api-server-linux-{arch}","sha256":"{digest}"}}]}}"#,
                ),
            )
            .unwrap();
            fs::write(incoming.join("control-plane-release.sig.json"), "{}\n").unwrap();
        }

        let root = std::env::temp_dir().join(format!(
            "appliance-control-plane-update-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let state = root.join("state");
        let incoming = state.join("incoming");
        let capability = root.join("capability");
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(
            bin.join("sha256sum"),
            "#!/bin/sh\nif [ \"$1\" = -c ]; then read expected file; [ \"$expected\" = \"$TEST_SHA\" ] && [ -f \"$file\" ]; exit; fi\ncase \"$(cat \"$1\")\" in collision-bytes) actual=$(printf 'b%.0s' $(seq 1 64));; *) actual=$TEST_SHA;; esac\nprintf '%s  %s\\n' \"$actual\" \"$1\"\n",
        )
        .unwrap();
        fs::set_permissions(bin.join("sha256sum"), fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(
            bin.join("sleep"),
            "#!/bin/sh\nprintf 'success 3.0.0\\n' > \"$TEST_RUN/outcome\"\n",
        )
        .unwrap();
        fs::set_permissions(bin.join("sleep"), fs::Permissions::from_mode(0o755)).unwrap();
        let test_path = format!(
            "{}:{}",
            bin.display(),
            std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into())
        );
        fs::create_dir_all(state.join("releases/1.0.0-old")).unwrap();
        fs::create_dir_all(state.join("releases/stale-gc-target")).unwrap();
        fs::write(state.join("current"), "releases/1.0.0-old\n").unwrap();
        fs::write(state.join("generation"), "2\n").unwrap();
        fs::write(&capability, "capable=1\n").unwrap();
        let binary = b"verified-update";
        let digest = crate::images::content_sha256_hex(binary);
        let key_id = format!("ed25519:sha256:{}", "a".repeat(64));
        let arch = if std::env::consts::ARCH == "aarch64" { "arm64" } else { "x64" };
        let script = root.join("update.sh");
        fs::write(&script, CONTROL_PLANE_UPDATE.replace("__PINNED_RELEASE_KEY_ID__", &key_id)).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let run = || {
            Command::new("/bin/sh")
                .arg(&script)
                .env("CONTROL_PLANE_ROOT", &state)
                .env("APPLIANCE_CONTROL_PLANE_CAPABILITY", &capability)
                .env("APPLIANCE_CONTROL_PLANE_RUN", root.join("run"))
                .env("PATH", &test_path)
                .env("TEST_SHA", &digest)
                .env("TEST_RUN", root.join("run"))
                .output()
                .unwrap()
        };

        stage(&incoming, &key_id, arch, ("2.0.0", 3), ("9.9.9", 3), &digest, binary);
        fs::write(incoming.join(".stale"), "must be cleared\n").unwrap();
        let mismatch = run();
        assert!(!mismatch.status.success());
        assert!(String::from_utf8_lossy(&mismatch.stderr).contains("signed release evidence mismatch"));
        assert_eq!(
            fs::read_to_string(state.join("control-plane-release.invalid")).unwrap(),
            "signed release evidence mismatch\n"
        );
        assert!(!state.join("releases/stale-gc-target").exists(), "GC must remove unreferenced releases");
        assert!(fs::read_dir(&incoming).unwrap().next().is_none(), "incoming dotfiles must be cleared");

        stage(&incoming, &key_id, arch, ("2.0.0", 2), ("2.0.0", 2), &digest, binary);
        let equal_new_content = run();
        assert!(!equal_new_content.status.success());
        assert!(String::from_utf8_lossy(&equal_new_content.stderr)
            .contains("release generation must advance for new content"));
        assert!(!state.join("control-plane-release.invalid").exists());

        let target = format!("releases/2.0.0-{}", &digest[..12]);
        let release = state.join(&target);
        fs::create_dir_all(&release).unwrap();
        fs::write(release.join("binary"), binary).unwrap();
        fs::write(state.join("current"), format!("{target}\n")).unwrap();
        stage(&incoming, &key_id, arch, ("2.0.0", 2), ("2.0.0", 2), &digest, binary);
        let equal_current = run();
        assert!(
            equal_current.status.success(),
            "same content/generation no-op failed: {}",
            String::from_utf8_lossy(&equal_current.stderr)
        );
        assert!(String::from_utf8_lossy(&equal_current.stdout).contains("already at 2.0.0"));

        stage(&incoming, &key_id, arch, ("3.0.0", 3), ("3.0.0", 3), &digest, binary);
        let advanced = run();
        assert!(
            advanced.status.success(),
            "higher-generation content-addressed stage failed: {}",
            String::from_utf8_lossy(&advanced.stderr)
        );
        let advanced_target = format!("releases/3.0.0-{}", &digest[..12]);
        assert_eq!(fs::read_to_string(state.join("pending")).unwrap(), format!("{advanced_target}\n"));
        assert_eq!(fs::read(state.join(&advanced_target).join("binary")).unwrap(), binary);

        let collision_target = format!("releases/4.0.0-{}", &digest[..12]);
        let collision = state.join(&collision_target);
        fs::create_dir_all(&collision).unwrap();
        fs::write(collision.join("binary"), b"collision-bytes").unwrap();
        fs::write(state.join("previous"), format!("{collision_target}\n")).unwrap();
        stage(&incoming, &key_id, arch, ("4.0.0", 4), ("4.0.0", 4), &digest, binary);
        let collided = run();
        assert!(!collided.status.success());
        assert!(String::from_utf8_lossy(&collided.stderr).contains("existing release content collision"));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn control_plane_supervisor_executable_path_promotes_or_rolls_back() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        use std::process::Command;

        fn link(bin: &Path, name: &str, target: &str) {
            symlink(target, bin.join(name)).unwrap();
        }
        fn run_case(case: &str, health: &str, digest: &str, crash: bool) -> (String, String) {
            let root = std::env::temp_dir().join(format!(
                "appliance-supervisor-{case}-{}-{}", std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
            ));
            let bin = root.join("bin");
            let releases = root.join("state/releases");
            let run = root.join("run");
            fs::create_dir_all(&bin).unwrap();
            fs::create_dir_all(releases.join("1.0.0-old")).unwrap();
            fs::create_dir_all(releases.join("2.0.0-new/console")).unwrap();
            for name in ["mkdir", "rm", "mv", "cat"] { link(&bin, name, &format!("/bin/{name}")); }
            for name in ["awk", "grep", "tr", "seq"] { link(&bin, name, &format!("/usr/bin/{name}")); }
            fs::write(bin.join("sha256sum"), "#!/bin/sh\nprintf '%s  %s\\n' \"$TEST_SHA\" \"$1\"\n").unwrap();
            fs::write(bin.join("wget"), "#!/bin/sh\nprintf '{\"initialized\":true,\"serverVersion\":\"%s\"}\\n' \"$HEALTH_VERSION\"\n").unwrap();
            fs::write(bin.join("sleep"), "#!/bin/sh\nexec /bin/sleep 0.01\n").unwrap();
            for name in ["sha256sum", "wget", "sleep"] {
                fs::set_permissions(bin.join(name), fs::Permissions::from_mode(0o755)).unwrap();
            }
            let binary = if crash { "#!/bin/sh\nexit 7\n" } else { "#!/bin/sh\nwhile :; do /bin/sleep 60; done\n" };
            fs::write(releases.join("2.0.0-new/binary"), binary).unwrap();
            fs::set_permissions(releases.join("2.0.0-new/binary"), fs::Permissions::from_mode(0o500)).unwrap();
            fs::write(releases.join("2.0.0-new/control-plane-release.properties"), "version=2.0.0\ngeneration=2\n").unwrap();
            fs::write(releases.join("2.0.0-new/appliance-api-server.sha256"), format!("{}  appliance-api-server  {}\n", "a".repeat(64), binary.len())).unwrap();
            fs::write(root.join("state/current"), "releases/1.0.0-old\n").unwrap();
            fs::write(root.join("state/pending"), "releases/2.0.0-new\n").unwrap();
            let script = root.join("supervisor.sh");
            fs::write(&script, CONTROL_PLANE_SUPERVISOR).unwrap();
            let status = Command::new("/bin/sh").arg(&script)
                .env("PATH", &bin).env("CONTROL_PLANE_ROOT", root.join("state"))
                .env("APPLIANCE_CONTROL_PLANE_RUN", &run).env("APPLIANCE_CONTROL_PLANE_LOG", root.join("server.log"))
                .env("APPLIANCE_FD_ROOT", "/dev/fd").env("APPLIANCE_EXEC_PREFIX", "/bin/sh")
                .env("APPLIANCE_TEST_ONCE", "1").env("TEST_SHA", digest).env("HEALTH_VERSION", health)
                .status().unwrap();
            assert!(status.success());
            let result = (fs::read_to_string(run.join("outcome")).unwrap(), fs::read_to_string(root.join("state/current")).unwrap().trim().to_string());
            assert!(!root.join("state/pending").exists());
            fs::remove_dir_all(root).unwrap();
            result
        }
        assert_eq!(run_case("good", "2.0.0", &"a".repeat(64), false), ("success 2.0.0\n".into(), "releases/2.0.0-new".into()));
        assert_eq!(run_case("good-v-prefix", "v2.0.0", &"a".repeat(64), false), ("success 2.0.0\n".into(), "releases/2.0.0-new".into()));
        assert_eq!(run_case("hash", "2.0.0", &"b".repeat(64), false), ("rollback 2.0.0 bad-hash\n".into(), "releases/1.0.0-old".into()));
        assert_eq!(run_case("wrong", "9.9.9", &"a".repeat(64), false), ("rollback 2.0.0 wrong-version\n".into(), "releases/1.0.0-old".into()));
        assert_eq!(run_case("crash", "2.0.0", &"a".repeat(64), true), ("rollback 2.0.0 crash\n".into(), "releases/1.0.0-old".into()));

        let root = std::env::temp_dir().join(format!(
            "appliance-supervisor-invalid-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let bin = root.join("bin");
        let state = root.join("state");
        let broken = state.join("releases/broken");
        let run = root.join("run");
        let log = root.join("server.log");
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(&broken).unwrap();
        for name in ["cat", "mkdir", "mv", "rm"] {
            link(&bin, name, &format!("/bin/{name}"));
        }
        link(&bin, "awk", "/usr/bin/awk");
        fs::write(state.join("current"), "releases/broken\n").unwrap();
        fs::write(state.join("previous"), "releases/broken\n").unwrap();
        let script = root.join("supervisor.sh");
        fs::write(&script, CONTROL_PLANE_SUPERVISOR).unwrap();
        let status = Command::new("/bin/sh")
            .arg(&script)
            .env("PATH", &bin)
            .env("CONTROL_PLANE_ROOT", &state)
            .env("APPLIANCE_CONTROL_PLANE_RUN", &run)
            .env("APPLIANCE_CONTROL_PLANE_LOG", &log)
            .env("APPLIANCE_TEST_ONCE", "1")
            .status()
            .unwrap();
        assert!(status.success());
        assert!(fs::read_to_string(&log).unwrap().contains("respawning legacy seed"));
        assert!(!state.join("current").exists());
        assert!(!state.join("previous").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn core_overlay_omits_lazy_platform_without_reordering_shared_bootstrap() {
        let core = build_apkovl_for_readiness(
            5052,
            None,
            true,
            false,
            false,
            5053,
            HostReadiness::Core,
            "",
            8081,
            "",
            None,
        )
        .unwrap();
        let start = apkovl_file(&core, "etc/local.d/appliance.start").unwrap();
        assert!(start.contains("appliance-shell-agent"));
        assert!(start.contains("appliance-dev: provisioning development environment"));
        assert!(!start.contains("k3s server"));
        assert!(!start.contains("appliance-buildkit: provisioning in-guest BuildKit"));
        assert!(!start.contains("agent-ready"));
        }
    }

    #[test]
    fn compound_supervisor_is_valid_shell_and_scopes_lifecycle_per_leaf() {
        use std::io::Write;
        use std::process::{Command, Stdio};

        let mut child = Command::new("sh")
            .arg("-n")
            .stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn shell syntax check");
        child
            .stdin
            .take()
            .expect("shell stdin")
            .write_all(RUNTIME_COMPOUND_SUPERVISOR.as_bytes())
            .expect("write compound supervisor");
        let output = child.wait_with_output().expect("wait for shell syntax check");
        assert!(
            output.status.success(),
            "compound supervisor shell syntax: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        let supervisor = RUNTIME_COMPOUND_SUPERVISOR;
        assert!(supervisor.contains(".plan.services | reverse | .[].name"));
        assert!(supervisor.contains("--cgroup \"appliance/$APP/$SVC\""));
        assert!(supervisor.contains("--with-ns \"network:/var/run/netns/$NS\""));
        assert!(supervisor.contains("images import --local --platform \"$OCI_PLATFORM\""));
        assert!(supervisor.contains("tasks list 2>/dev/null | grep \"^$CID \""));
        assert!(supervisor.contains("wget -q -T \"$TIMEOUT\" --spider"));
        assert!(supervisor.contains("--exec-id \"health-$$-$(date +%s%N)\""));
        assert!(supervisor.contains("APPLIANCE_SVC_"));
        assert!(supervisor.contains("echo \"$CULPRIT\" > \"$STATE/culprit\""));
        assert!(supervisor.contains("stop_all exited"));
        assert!(supervisor.contains("echo \"$ATTEMPT\" > \"$SERVICE/restart-count\""));
        assert!(supervisor.contains("[ \"$DELAY\" -le 30 ] || DELAY=30"));
        assert!(supervisor.contains("$SERVICES/$SVC/current.log"));
        assert!(supervisor.contains("APPLIANCE_EGRESS_CA"));
        assert!(supervisor.contains("dst=/appliance-egress-ca.pem"));
        assert!(supervisor.contains("[ ! -f \"$EGRESS_CA\" ]"));
        assert!(supervisor.contains("[ -f \"$EGRESS_CA\" ]"));
        assert!(supervisor.contains(
            "{\"state\":\"failed\",\"message\":\"egress CA certificate is unavailable\"}"
        ));
        assert!(RUNTIME_SUPERVISOR.contains("appliance-runtime-compound-supervisor"));
    }
