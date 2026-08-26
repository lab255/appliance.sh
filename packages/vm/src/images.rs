use anyhow::{bail, Context, Result};
use std::fs;
use std::path::{Path, PathBuf};

/// Pinned guest image sets. An image set is a (kernel, initramfs) pair
/// booted directly — no firmware, no bootloader, no disk image to
/// download. Pinning by exact version keeps guest behavior reproducible;
/// bumping the pin is a deliberate code change, not a moving `latest`.
///
/// Phase 1 boots the stock Alpine `virt` netboot artifacts, which is
/// enough to prove the VMM end-to-end (kernel boot → init → console).
/// Phase 2 replaces the initramfs with our own (busybox + appliance
/// init: DHCP, mount data disk, exec k3s, vsock agent).
pub const DEFAULT_IMAGE: &str = "alpine-3.21.3";

struct ImageDef {
    name: &'static str,
    kernel_url_aarch64: &'static str,
    kernel_sha256_aarch64: &'static str,
    initramfs_url_aarch64: &'static str,
    initramfs_sha256_aarch64: &'static str,
    kernel_url_x86_64: &'static str,
    kernel_sha256_x86_64: &'static str,
    initramfs_url_x86_64: &'static str,
    initramfs_sha256_x86_64: &'static str,
}

// Sasha condition #3: the kernel + initramfs are UNAUTHENTICATED root-code
// downloads (they become the guest kernel) — higher privilege than the
// agent image. Alpine publishes these artifacts; the sha256 of each pinned
// netboot file is committed here and verified against the RAW network bytes
// before use, every boot (cache-hit included). Bumping the Alpine pin is a
// deliberate code change: new URLs + new digests, together.
const IMAGES: &[ImageDef] = &[ImageDef {
    name: "alpine-3.21.3",
    kernel_url_aarch64:
        "https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/aarch64/netboot-3.21.3/vmlinuz-virt",
    kernel_sha256_aarch64: "2a49ce5e4f525f3633295e7df03a80280bbc8f56a26ae8578d048f6e45d29efa",
    initramfs_url_aarch64:
        "https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/aarch64/netboot-3.21.3/initramfs-virt",
    initramfs_sha256_aarch64: "c142c9c29d7e38bb1011fd87443410b91d08acfff21b6318ffb1ba6322854259",
    kernel_url_x86_64:
        "https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/x86_64/netboot-3.21.3/vmlinuz-virt",
    kernel_sha256_x86_64: "e1d7a3cdae9a4a62ed629b90a9955754f676a339bc28176aa593f8f029c35e3c",
    initramfs_url_x86_64:
        "https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/x86_64/netboot-3.21.3/initramfs-virt",
    initramfs_sha256_x86_64: "54cfbeb11009f4002b568f4e505547477c8873d6af3ce19acdbfd3a95c5a6a05",
}];

/// Prebuilt agent image (docs/fast-spin-up.md §2): Node ≥22 + the three
/// pinned agent CLIs baked into a read-only squashfs, built + hosted by the
/// project (a GitHub release asset) and attached read-only as the agent-only
/// VM's 3rd virtio-blk (vdc). Mirrors the `IMAGES` table: a per-arch URL +
/// committed sha256, keyed on one version const. A pin bump is one
/// coordinated commit — this version + the two digests, alongside the
/// adapter `install.version` (CI asserts they match — §2.7).
pub const AGENT_IMAGE_VERSION: &str = "0.1.0";

// OWED-LIVE (owner/CI): the squashfs is produced by the
// `release-agent-image.yml` workflow; the per-arch sha256 below is the
// all-zero sentinel until CI first publishes `agent-image-v0.1.0` and the
// real digest is committed in the version-bump commit. Until then
// `ensure_agent_image()` fails verification, the attach is skipped, and the
// guest self-heals the CLIs via npm (the same path as before this work) —
// so agent-only VMs keep working while the artifact build is owed.
const AGENT_IMAGE_SHA256_AARCH64: &str =
    "0000000000000000000000000000000000000000000000000000000000000000";
const AGENT_IMAGE_SHA256_X86_64: &str =
    "0000000000000000000000000000000000000000000000000000000000000000";

/// The k3s release whose airgap-images tarball is preloaded into k3s VMs
/// so first boot imports its core images (registry:2 aside) locally
/// instead of pulling ~300 MB from docker.io through k3s's containerd.
/// MUST equal `guest::K3S_VERSION` — the tarball only matches the binary
/// it shipped with. A pins-equality test locks the two together so a
/// K3S_VERSION bump forces this version + both digests in one commit.
pub const K3S_AIRGAP_VERSION: &str = "v1.31.4+k3s1";

// Sasha condition #3: like k3s itself, the airgap tarball is an
// UNAUTHENTICATED download whose contents become cluster workloads —
// hash-pinned from the k3s-io release's sha256sum assets and verified
// before use, every boot (cache-hit included).
const K3S_AIRGAP_SHA256_ARM64: &str =
    "02694da4fb6831757f8d198dd5d9f11fcc435bce468426a56109b9d94a025877";
const K3S_AIRGAP_SHA256_AMD64: &str =
    "f7a94dc28b3a8da063a41360f480ace1de3040ffd9c9228283975c8dca74d3b7";

fn k3s_airgap_asset() -> Result<(&'static str, &'static str)> {
    // (release asset name, committed sha256) — k3s names these by the
    // k3s arch suffix (arm64/amd64), not the uname arch.
    match std::env::consts::ARCH {
        "aarch64" => Ok(("k3s-airgap-images-arm64.tar.zst", K3S_AIRGAP_SHA256_ARM64)),
        "x86_64" => Ok(("k3s-airgap-images-amd64.tar.zst", K3S_AIRGAP_SHA256_AMD64)),
        other => bail!("unsupported host architecture: {other}"),
    }
}

/// True when the pinned airgap tarball is already on disk — i.e. the
/// expensive first-run download is done. A cheap presence probe for the
/// boot path to decide whether to ANNOUNCE a download before starting
/// it; `ensure_k3s_airgap_images` still re-verifies the cached bytes.
pub fn k3s_airgap_images_cached() -> bool {
    k3s_airgap_asset()
        .map(|(asset, _)| {
            crate::guest::assets_dir()
                .join(format!("k3s-airgap-{K3S_AIRGAP_VERSION}-{asset}"))
                .is_file()
        })
        .unwrap_or(false)
}

/// Resolve (fetching + verifying on first use, re-verifying on every
/// cache hit) the pinned k3s airgap-images tarball for this arch —
/// `ensure_agent_image`'s pattern, cached under the shared guest-assets
/// dir next to the k3s binary it belongs to. Callers treat an `Err` as
/// "no preload": the guest then pulls from the network exactly as before.
pub fn ensure_k3s_airgap_images() -> Result<PathBuf> {
    let (asset, sha) = k3s_airgap_asset()?;
    let dir = crate::guest::assets_dir();
    fs::create_dir_all(&dir)?;
    // Version-keyed like `k3s-{K3S_VERSION}`: a pin bump fetches fresh
    // instead of failing verification against the old cached bytes.
    let dest = dir.join(format!("k3s-airgap-{K3S_AIRGAP_VERSION}-{asset}"));
    download_and_verify(
        &format!(
            "https://github.com/k3s-io/k3s/releases/download/{}/{asset}",
            K3S_AIRGAP_VERSION.replace('+', "%2B")
        ),
        &dest,
        sha,
    )?;
    Ok(dest)
}

pub struct GuestImage {
    pub kernel: PathBuf,
    pub initramfs: PathBuf,
}

fn cache_dir(image: &str) -> PathBuf {
    crate::store::vm_root().join("images").join(image)
}

/// Resolve (downloading on first use) the kernel + initramfs for an
/// image set. Downloads are atomic: stream to `.partial`, rename into
/// place — a killed download never leaves a truncated file at the
/// canonical name.
pub fn ensure_image(image: &str) -> Result<GuestImage> {
    let def = IMAGES
        .iter()
        .find(|d| d.name == image)
        .with_context(|| format!("unknown guest image '{image}' (known: {DEFAULT_IMAGE})"))?;

    let (kernel_url, kernel_sha, initramfs_url, initramfs_sha) = match std::env::consts::ARCH {
        "aarch64" => (
            def.kernel_url_aarch64,
            def.kernel_sha256_aarch64,
            def.initramfs_url_aarch64,
            def.initramfs_sha256_aarch64,
        ),
        "x86_64" => (
            def.kernel_url_x86_64,
            def.kernel_sha256_x86_64,
            def.initramfs_url_x86_64,
            def.initramfs_sha256_x86_64,
        ),
        other => bail!("unsupported host architecture: {other}"),
    };

    let dir = cache_dir(image);
    fs::create_dir_all(&dir)?;

    // Sasha #3: verify the RAW network bytes of the kernel against the
    // committed sha256 before use, every boot (cache-hit included). The
    // kernel is then NORMALIZED (zboot/gzip unwrap) into the boot image;
    // because normalization mutates the file, the verified raw download is
    // kept under a distinct name so the per-boot check sees the original
    // network bytes, not our derived output. The normalized `kernel` is a
    // deterministic function of the verified raw, re-derived only when
    // absent (the security-relevant surface is the unauthenticated
    // download, which is checked every boot).
    let kernel_raw = dir.join("kernel.raw");
    download_and_verify(kernel_url, &kernel_raw, kernel_sha)?;
    let kernel = dir.join("kernel");
    if !kernel.exists() {
        fs::copy(&kernel_raw, &kernel)?;
        normalize_kernel(&kernel)?;
    }

    // The initramfs is consumed as-is (never normalized), so the canonical
    // file IS the network artifact — verify it directly, every boot.
    let initramfs = dir.join("initramfs");
    download_and_verify(initramfs_url, &initramfs, initramfs_sha)?;

    Ok(GuestImage { kernel, initramfs })
}

fn agent_assets_dir() -> PathBuf {
    crate::store::vm_root().join("images").join("agent-assets")
}

/// The committed sha256 for this host arch's prebuilt agent image.
pub fn agent_image_sha256() -> Result<&'static str> {
    match std::env::consts::ARCH {
        "aarch64" => Ok(AGENT_IMAGE_SHA256_AARCH64),
        "x86_64" => Ok(AGENT_IMAGE_SHA256_X86_64),
        other => bail!("unsupported host architecture: {other}"),
    }
}

fn agent_image_filename() -> Result<String> {
    let arch = match std::env::consts::ARCH {
        "aarch64" => "aarch64",
        "x86_64" => "x86_64",
        other => bail!("unsupported host architecture: {other}"),
    };
    Ok(format!("appliance-agents-{arch}-{AGENT_IMAGE_VERSION}.squashfs"))
}

fn agent_image_url() -> Result<String> {
    Ok(format!(
        "https://github.com/lab255/appliance.sh/releases/download/agent-image-v{AGENT_IMAGE_VERSION}/{}",
        agent_image_filename()?
    ))
}

/// Resolve (fetching + verifying on first use, re-verifying on every cache
/// hit) the prebuilt agent-image squashfs for this arch, returning the
/// verified on-disk path. The returned path is ALWAYS hash-verified against
/// the committed sha256, so a tampered/stale/wrong-hash artifact is never
/// handed back for attach (Quinn gap #3). The caller treats an `Err` as "no
/// image" and lets the guest self-heal the CLIs via npm.
pub fn ensure_agent_image() -> Result<PathBuf> {
    let dir = agent_assets_dir();
    fs::create_dir_all(&dir)?;
    let dest = dir.join(agent_image_filename()?);
    download_and_verify(&agent_image_url()?, &dest, agent_image_sha256()?)?;
    Ok(dest)
}

/// Re-verify an on-disk agent image against the committed sha256. Called
/// immediately before the device is attached (Quinn gap #3): the integrity
/// gate is load-bearing AT ATTACH TIME on the on-disk bytes, every boot —
/// not only right after a fresh download.
pub fn verify_agent_image(path: &Path) -> Result<()> {
    verify_sha256(path, agent_image_sha256()?)
}

/// Lowercase hex of a digest.
fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Hex sha256 of a small in-memory input (project identities, etc).
pub fn content_sha256_hex(bytes: &[u8]) -> String {
    hex(ring::digest::digest(&ring::digest::SHA256, bytes).as_ref())
}

/// Verify a file on disk matches `expected_hex` (sha256). Streams the file
/// so large artifacts (modloop ~130 MB) never load wholesale. The core of
/// the every-boot, cache-hit integrity check.
pub fn verify_sha256(path: &Path, expected_hex: &str) -> Result<()> {
    let mut file = fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = std::io::Read::read(&mut file, &mut buf)?;
        if n == 0 {
            break;
        }
        ctx.update(&buf[..n]);
    }
    let got = hex(ctx.finish().as_ref());
    if got.eq_ignore_ascii_case(expected_hex) {
        Ok(())
    } else {
        bail!(
            "sha256 mismatch for {}: expected {expected_hex}, got {got}",
            path.display()
        );
    }
}

/// Download a URL to `dest` and verify its sha256, or — on a cache hit —
/// verify the EXISTING file. The integrity gate covers BOTH paths
/// (Quinn gap #3): a cached file that no longer matches the committed
/// digest is rejected, never silently trusted or used. Atomic on fresh
/// download: stream to `.partial` (hashing inline), verify, then rename
/// into place — a wrong-hash download never lands at the canonical name.
pub fn download_and_verify(url: &str, dest: &Path, expected_hex: &str) -> Result<()> {
    if dest.exists() {
        // Cache hit — verify the on-disk bytes EVERY time. A complete file at
        // the canonical name is never a partial download (the rename below is
        // atomic), so a mismatch here is corruption or tampering: refuse it
        // rather than re-fetch-and-trust. Remove the bad file to re-pull.
        return verify_sha256(dest, expected_hex).with_context(|| {
            format!(
                "cached artifact {} failed its integrity check (corrupt or tampered cache; \
                 remove it to re-fetch)",
                dest.display()
            )
        });
    }
    eprintln!("downloading {url}");
    let partial = dest.with_extension("partial");
    let response = ureq::get(url).call().with_context(|| format!("GET {url}"))?;
    let mut reader = response.into_reader();
    let mut file = fs::File::create(&partial)?;
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buf = [0u8; 64 * 1024];
    let mut total: u64 = 0;
    loop {
        let n = std::io::Read::read(&mut reader, &mut buf).with_context(|| format!("download {url}"))?;
        if n == 0 {
            break;
        }
        ctx.update(&buf[..n]);
        std::io::Write::write_all(&mut file, &buf[..n])?;
        total += n as u64;
    }
    if total == 0 {
        let _ = fs::remove_file(&partial);
        bail!("downloaded 0 bytes from {url}");
    }
    let got = hex(ctx.finish().as_ref());
    if !got.eq_ignore_ascii_case(expected_hex) {
        let _ = fs::remove_file(&partial);
        bail!("sha256 mismatch for {url}: expected {expected_hex}, got {got}");
    }
    fs::rename(&partial, dest)?;
    Ok(())
}

/// Unwrap distro kernel packaging into the raw image the hypervisor
/// boot loaders expect. Two cases:
///
///   * EFI zboot (arm64, kernel ≥ 6.x distros): a PE stub whose
///     header is `MZ..zimg` with a gzip payload at a header-declared
///     offset. Virtualization.framework's VZLinuxBootLoader (and a
///     direct-boot KVM VMM) need the *decompressed* arm64 `Image`
///     inside.
///   * Plain gzip (`1f 8b`): decompress in place (arm64 direct boot
///     takes uncompressed images; x86 bzImage is not gzip at the file
///     level and passes through untouched).
///
/// Idempotent — a normalized image matches neither signature.
fn normalize_kernel(path: &PathBuf) -> Result<()> {
    let data = fs::read(path)?;

    let gzip_payload: Option<Vec<u8>> = if data.len() > 0x1c && &data[4..8] == b"zimg" {
        let off = u32::from_le_bytes(data[8..12].try_into().unwrap()) as usize;
        let len = u32::from_le_bytes(data[12..16].try_into().unwrap()) as usize;
        if &data[0x18..0x1c] != b"gzip" {
            bail!("zboot kernel uses unsupported compression (only gzip handled)");
        }
        if off + len > data.len() {
            bail!("zboot payload out of bounds (corrupt kernel download?)");
        }
        Some(data[off..off + len].to_vec())
    } else if data.len() > 2 && data[0] == 0x1f && data[1] == 0x8b {
        Some(data)
    } else {
        None
    };

    let Some(compressed) = gzip_payload else {
        return Ok(());
    };

    eprintln!("unwrapping compressed kernel image");
    let mut decoder = flate2::read::GzDecoder::new(&compressed[..]);
    let mut out: Vec<u8> = Vec::new();
    std::io::Read::read_to_end(&mut decoder, &mut out).context("decompress kernel")?;
    let partial = path.with_extension("partial");
    fs::write(&partial, &out)?;
    fs::rename(&partial, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn gz(data: &[u8]) -> Vec<u8> {
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(data).unwrap();
        enc.finish().unwrap()
    }

    fn write_temp(name: &str, data: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!("vmm-kernel-test-{}-{name}", std::process::id()));
        fs::write(&path, data).unwrap();
        path
    }

    #[test]
    fn unwraps_zboot_kernels() {
        // Synthetic zboot: MZ + zimg magic, payload offset/len header,
        // gzip method, padding, then the gzip payload.
        let payload = b"raw arm64 Image bytes".to_vec();
        let compressed = gz(&payload);
        let off: u32 = 0x40;
        let mut file = Vec::new();
        file.extend_from_slice(b"MZ\0\0zimg");
        file.extend_from_slice(&off.to_le_bytes());
        file.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        file.extend_from_slice(&[0u8; 8]); // reserved
        file.extend_from_slice(b"gzip\0\0\0\0");
        while file.len() < off as usize {
            file.push(0);
        }
        file.extend_from_slice(&compressed);

        let path = write_temp("zboot", &file);
        normalize_kernel(&path).unwrap();
        assert_eq!(fs::read(&path).unwrap(), payload);
        fs::remove_file(&path).ok();
    }

    #[test]
    fn unwraps_plain_gzip_kernels() {
        let payload = b"plain image".to_vec();
        let path = write_temp("gzip", &gz(&payload));
        normalize_kernel(&path).unwrap();
        assert_eq!(fs::read(&path).unwrap(), payload);
        fs::remove_file(&path).ok();
    }

    #[test]
    fn passes_raw_kernels_through() {
        let payload = b"\x4d\x5a__not_zimg_raw_kernel".to_vec();
        let path = write_temp("raw", &payload);
        normalize_kernel(&path).unwrap();
        assert_eq!(fs::read(&path).unwrap(), payload);
        fs::remove_file(&path).ok();
    }

    fn sha256_of(data: &[u8]) -> String {
        content_sha256_hex(data)
    }

    #[test]
    fn content_sha256_is_lowercase_hex_of_the_digest() {
        // sha256("") is the well-known empty digest.
        assert_eq!(
            sha256_of(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn verify_sha256_accepts_matching_and_rejects_wrong() {
        let data = b"prebuilt agent image bytes";
        let good = sha256_of(data);
        let path = write_temp("verify", data);

        verify_sha256(&path, &good).expect("matching digest verifies");
        // Case-insensitive comparison.
        verify_sha256(&path, &good.to_uppercase()).expect("uppercase digest still verifies");

        let wrong = "0000000000000000000000000000000000000000000000000000000000000000";
        assert!(verify_sha256(&path, wrong).is_err(), "wrong digest must reject");
        fs::remove_file(&path).ok();
    }

    #[test]
    fn airgap_pin_matches_the_k3s_version() {
        // The airgap tarball only matches the k3s binary it shipped with:
        // bumping K3S_VERSION MUST bump this pin (and both digests) in the
        // same commit, or the preload would import a different release's
        // images than the binary expects.
        assert_eq!(K3S_AIRGAP_VERSION, crate::guest::K3S_VERSION);
    }

    #[test]
    fn airgap_digests_are_committed_not_sentinels() {
        // Unlike the agent image (whose all-zero sentinel is an explicit
        // OWED-LIVE fallback), the airgap digests come straight off the
        // k3s-io release's sha256sum assets — a zero digest here would
        // silently disable the preload on every boot.
        for sha in [K3S_AIRGAP_SHA256_ARM64, K3S_AIRGAP_SHA256_AMD64] {
            assert_eq!(sha.len(), 64);
            assert!(sha.chars().all(|c| c.is_ascii_hexdigit()));
            assert_ne!(sha, "0000000000000000000000000000000000000000000000000000000000000000");
        }
        assert_ne!(K3S_AIRGAP_SHA256_ARM64, K3S_AIRGAP_SHA256_AMD64);
    }

    #[test]
    fn download_and_verify_rejects_a_wrong_hash_cached_file() {
        // Quinn gap #3 — the attach-time / cache-hit path: a file already on
        // disk whose contents do NOT match the committed digest must be
        // REJECTED, never silently trusted (the early-return-on-exists bug
        // this closes). No network is touched: the cache-hit branch verifies
        // and refuses.
        let dest = write_temp("cached-bad", b"tampered cached squashfs");
        let expected = sha256_of(b"the real, expected squashfs bytes");
        let err = download_and_verify("https://unused.invalid/agents.squashfs", &dest, &expected);
        assert!(err.is_err(), "a wrong-hash cached file must be rejected");
        // The file is left in place (the operator removes it to re-fetch); we
        // never attach it because the Err propagates to skip the attach.
        fs::remove_file(&dest).ok();
    }

    #[test]
    fn download_and_verify_accepts_a_correct_cached_file_without_network() {
        // A cache hit whose digest matches returns Ok and never dials out
        // (the URL is unreachable on purpose).
        let data = b"correct cached agent image";
        let dest = write_temp("cached-good", data);
        download_and_verify("https://unused.invalid/agents.squashfs", &dest, &sha256_of(data))
            .expect("a matching cached file verifies offline");
        fs::remove_file(&dest).ok();
    }
}
