//! Backend-specific adapters used by the otherwise shared Runtime guest.
//!
//! Keep these generators platform-neutral: WSL itself only compiles on
//! Windows, while quoting, target confinement, and nft policy are pure logic
//! that every development host can test.

use anyhow::{bail, Result};
use std::net::Ipv4Addr;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeGuestBackend {
    VirtioFs,
    #[allow(dead_code)] // Constructed by the cfg(windows) WSL assembler.
    WslDrvFs,
}

const VIRTIOFS_SHARE_MOUNT: &str = r#"#!/bin/sh
set -eu
TAG=${1:-}
case "$TAG" in ap-[0-9a-f]*) ;; *) echo "invalid runtime share tag" >&2; exit 2;; esac
TAG_HEX=${TAG#ap-}
case "$TAG_HEX" in ''|*[!0-9a-f]*) echo "invalid runtime share tag" >&2; exit 2;; esac
[ "${#TAG_HEX}" -le 32 ] || { echo "invalid runtime share tag" >&2; exit 2; }
SHARE=/run/appliance/shares/$TAG
mkdir -p "$SHARE"
grep -qs " $SHARE " /proc/mounts || mount -t virtiofs -o ro "$TAG" "$SHARE"
"#;

const WSL_DRVFS_SHARE_MOUNT: &str = r#"#!/bin/sh
set -eu
TAG=${1:-}
HOST_PATH=${2:-}
STATE_DIR_WIN='__STATE_DIR_WIN__'
case "$TAG" in ap-[0-9a-f]*) ;; *) echo "invalid runtime share tag" >&2; exit 2;; esac
TAG_HEX=${TAG#ap-}
case "$TAG_HEX" in ''|*[!0-9a-f]*) echo "invalid runtime share tag" >&2; exit 2;; esac
[ "${#TAG_HEX}" -le 32 ] || { echo "invalid runtime share tag" >&2; exit 2; }
HOST_PATH=${HOST_PATH#\\\\?\\}
case "$HOST_PATH" in ''|\\\\*|//* ) echo "unsupported WSL runtime share path" >&2; exit 2;; esac
case "$HOST_PATH" in [A-Za-z]:[\\/]* ) ;; *) echo "unsupported WSL runtime share path" >&2; exit 2;; esac
case "$HOST_PATH" in *'\'..'\'*|*'\'..'/'*|*/..'\'*|*/../*|*'\'..|*/..) echo "unsupported WSL runtime share path" >&2; exit 2;; esac
case "$HOST_PATH" in [A-Za-z]:[\\/] ) echo "WSL runtime share path must not be a drive root" >&2; exit 2;; esac
case "$HOST_PATH" in "$STATE_DIR_WIN"|"$STATE_DIR_WIN"[\\/]*) echo "WSL runtime share path must not include appliance state" >&2; exit 2;; esac
SHARE=/run/appliance/shares/$TAG
mkdir -p "$SHARE"
if ! grep -qs " $SHARE " /proc/mounts; then
  # Guest root can still issue its own drvfs mounts; accepted pending the
  # Runtime owner model. drvfs metadata also leaves 0777 cross-principal
  # reads as a follow-up even though this appliance-managed mount is read-only.
  mount -t drvfs "$HOST_PATH" "$SHARE" -o ro,uid=1000,gid=1000,metadata
fi
"#;

const SHARE_UNMOUNT: &str = r#"#!/bin/sh
set -eu
TAG=${1:-}
case "$TAG" in ap-[0-9a-f]*) ;; *) echo "invalid runtime share tag" >&2; exit 2;; esac
TAG_HEX=${TAG#ap-}
case "$TAG_HEX" in ''|*[!0-9a-f]*) echo "invalid runtime share tag" >&2; exit 2;; esac
[ "${#TAG_HEX}" -le 32 ] || { echo "invalid runtime share tag" >&2; exit 2; }
SHARE=/run/appliance/shares/$TAG
grep -qs " $SHARE " /proc/mounts && umount "$SHARE" || true
"#;

/// Mount helper selected at guest assembly time. The helper accepts a tag and
/// the canonical host path from the already host-validated Runtime plan. It
/// always derives the mount target from the tag; callers cannot supply one.
pub const fn runtime_share_mount_script(backend: RuntimeGuestBackend) -> &'static str {
    match backend {
        RuntimeGuestBackend::VirtioFs => VIRTIOFS_SHARE_MOUNT,
        RuntimeGuestBackend::WslDrvFs => WSL_DRVFS_SHARE_MOUNT,
    }
}

/// Render the WSL helper with the canonical Windows appliance state directory
/// embedded so the guest independently rejects a forged/stale Runtime plan.
#[cfg(any(target_os = "windows", test))]
pub fn wsl_runtime_share_mount_script(state_dir: &str) -> String {
    WSL_DRVFS_SHARE_MOUNT.replace(
        "__STATE_DIR_WIN__",
        &shell_squote(strip_verbatim(state_dir)),
    )
}

pub const fn runtime_share_unmount_script() -> &'static str {
    SHARE_UNMOUNT
}

// AP-205 widens this behind wsl-mode cooperative.
const WSL_PRINCIPAL_RULES: &str = r#"table ip appliance_runtime_nat {
  chain principal_snat {
    type nat hook postrouting priority srcnat; policy accept;
    ip saddr 192.168.127.0/24 oifname "eth0" masquerade
  }
  chain principal_egress {
    type filter hook forward priority -9; policy accept;
    iifname "r*" ip saddr 192.168.127.0/24 ct state established,related accept
    iifname "r*" ip saddr 192.168.127.0/24 ip daddr __WSL_GATEWAY__ tcp dport __EGRESS_PORT__ accept
    iifname "r*" ip saddr 192.168.127.0/24 drop
  }
}
"#;

/// Pure nft ruleset for the WSL principal address space. Translation remains
/// broad, but the later forward hook fails closed: principals may only use an
/// established flow or reach the host egress broker at the WSL NAT gateway.
pub fn wsl_principal_rules(gateway: Ipv4Addr, egress_port: u16) -> String {
    WSL_PRINCIPAL_RULES
        .replace("__WSL_GATEWAY__", &gateway.to_string())
        .replace("__EGRESS_PORT__", &egress_port.to_string())
}

pub fn runtime_principal_snat_script(
    backend: RuntimeGuestBackend,
    wsl_gateway: Option<Ipv4Addr>,
    egress_port: u16,
) -> Result<String> {
    match backend {
        RuntimeGuestBackend::VirtioFs => Ok("#!/bin/sh\nset -eu\n".to_string()),
        RuntimeGuestBackend::WslDrvFs => {
            let gateway = wsl_gateway.ok_or_else(|| {
                anyhow::anyhow!("WSL Runtime requires its NAT gateway for strict egress")
            })?;
            let rules = wsl_principal_rules(gateway, egress_port);
            Ok(format!(
                "#!/bin/sh\nset -eu\n\
                 if ! nft list table ip appliance_runtime_nat >/dev/null 2>&1; then\n\
                   nft -f - <<'APPLIANCE_RUNTIME_NFT'\n\
                 {}APPLIANCE_RUNTIME_NFT\n\
                 elif ! nft list chain ip appliance_runtime_nat principal_egress >/dev/null 2>&1; then\n\
                   nft 'add chain ip appliance_runtime_nat principal_egress {{ type filter hook forward priority -9; policy accept; }}'\n\
                   nft add rule ip appliance_runtime_nat principal_egress iifname 'r*' ip saddr 192.168.127.0/24 ct state established,related accept\n\
                   nft add rule ip appliance_runtime_nat principal_egress iifname 'r*' ip saddr 192.168.127.0/24 ip daddr {gateway} tcp dport {egress_port} accept\n\
                   nft add rule ip appliance_runtime_nat principal_egress iifname 'r*' ip saddr 192.168.127.0/24 drop\n\
                 fi\n",
                rules
            ))
        }
    }
}

/// Reject paths that are not absolute Windows local-drive paths accepted by a
/// targeted drvfs mount. `canonicalize` runs before this check in `runtime
/// prepare`, so an accepted path is an existing directory with symlinks
/// resolved host-side. In particular, never accept an automount-derived
/// `/mnt/c/...` source or a path with a traversal component.
pub fn validate_wsl_runtime_host_path(path: &str) -> Result<()> {
    let path = path.strip_prefix(r"\\?\").unwrap_or(path);
    if path.starts_with(r"\\") || path.starts_with("//") {
        bail!("WSL Runtime payload shares do not support UNC paths");
    }
    let bytes = path.as_bytes();
    if bytes.len() < 3
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || !matches!(bytes[2], b'\\' | b'/')
        || path.contains(['\0', '\n', '\r'])
    {
        bail!("WSL Runtime payload share path must be an absolute local-drive path");
    }
    if path.split(['\\', '/']).any(|component| component == "..") {
        bail!("WSL Runtime payload share path must not contain traversal");
    }
    if is_wsl_drive_root(path) {
        bail!("WSL Runtime payload share path must not be a drive root");
    }
    Ok(())
}

pub fn is_wsl_drive_root(path: &str) -> bool {
    let path = strip_verbatim(path);
    path.len() >= 3
        && path.as_bytes()[0].is_ascii_alphabetic()
        && path.as_bytes()[1] == b':'
        && path[2..].trim_matches(|c| c == '\\' || c == '/').is_empty()
}

/// Reject a mount that overlaps the appliance state directory in either
/// direction: neither the state tree nor a parent containing it is shareable.
/// Such a share would put credentials and helper configuration back in reach
/// of guest root even though drive automounting is disabled.
pub fn validate_mount_excludes_state_dir(
    mount: &std::path::Path,
    state_dir: &std::path::Path,
) -> Result<()> {
    if mount == state_dir || state_dir.starts_with(mount) || mount.starts_with(state_dir) {
        bail!(
            "mount path must not contain the appliance state dir ({})",
            state_dir.display()
        );
    }
    Ok(())
}

/// Pure receive plan for a host-streamed artifact. Only fixed absolute guest
/// paths are accepted; the guest checks the exact byte count and sha256 before
/// atomically installing the partial file.
#[cfg(any(target_os = "windows", test))]
pub(crate) fn artifact_receive_command(
    destination: &str,
    size: u64,
    sha256: &str,
) -> Result<String> {
    if !destination.starts_with('/')
        || destination.contains(['\0', '\n', '\r'])
        || destination.split('/').any(|component| component == "..")
    {
        bail!("invalid guest artifact destination '{destination}'");
    }
    if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("invalid artifact sha256");
    }
    let destination = shell_squote(destination);
    let sha256 = sha256.to_ascii_lowercase();
    Ok(format!(
        "set -eu\n\
         DEST='{destination}'\n\
         PARTIAL=\"$DEST.partial\"\n\
         trap 'rm -f \"$PARTIAL\"' EXIT HUP INT TERM\n\
         mkdir -p \"${{DEST%/*}}\"\n\
         cat > \"$PARTIAL\"\n\
         ACTUAL_SIZE=$(wc -c < \"$PARTIAL\" | tr -d '[:space:]')\n\
         [ \"$ACTUAL_SIZE\" = '{size}' ] || {{ echo \"artifact size mismatch: expected {size}, got $ACTUAL_SIZE\" >&2; exit 1; }}\n\
         printf '%s  %s\\n' '{sha256}' \"$PARTIAL\" | sha256sum -c >/dev/null\n\
         mv -f \"$PARTIAL\" \"$DEST\"\n\
         trap - EXIT HUP INT TERM\n"
    ))
}

/// VZ shares are boot devices; drvfs payloads are acquired on demand by the
/// guest helper and therefore never restart a live pool merely to add a share.
pub fn runtime_share_requires_restart(backend: &str, pool_running: bool, changed: bool) -> bool {
    backend != "wsl" && pool_running && changed
}

/// Build the offline, signed APK install fragment for a WSL Runtime guest.
/// The host streams each index and selected package into the fixed guest
/// artifact directory before bootstrap. Files are copied into persistent
/// root-owned storage before apk verifies signatures and installs them.
#[cfg(any(target_os = "windows", test))]
pub fn wsl_runtime_apk_install(repositories: &[&str], world: &[&str]) -> Result<String> {
    if repositories.is_empty() {
        bail!("WSL Runtime requires the mirrored signed APK closure");
    }
    let mut copy = String::new();
    let mut repository_file = String::new();
    for name in repositories {
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            bail!("invalid Runtime APK repository name '{name}'");
        }
        copy.push_str(&format!(
            "APK_SOURCE=/opt/appliance/artifacts/runtime-apks/{name}\n\
             [ -f \"$APK_SOURCE/APKINDEX.tar.gz\" ] || {{ echo 'FATAL: Runtime APK mirror is incomplete' >&2; exit 1; }}\n\
             APK_STAGE=/persist/runtime/apks/{name}/$APK_ARCH.new\n\
             rm -rf \"$APK_STAGE\"\n\
             mkdir -p \"$APK_STAGE\"\n\
             cp \"$APK_SOURCE/APKINDEX.tar.gz\" \"$APK_STAGE/\"\n\
             cp \"$APK_SOURCE\"/*.apk \"$APK_STAGE/\"\n\
             rm -rf /persist/runtime/apks/{name}/$APK_ARCH\n\
             mv \"$APK_STAGE\" /persist/runtime/apks/{name}/$APK_ARCH\n"
        ));
        repository_file.push_str(&format!("/persist/runtime/apks/{name}\n"));
    }
    let world = world.join("\n");
    Ok(format!(
        "# Runtime uses only the host-mirrored signed APK closure.\n\
         APK_ARCH=$(apk --print-arch)\n\
         mkdir -p /persist/runtime/apks /etc/apk\n\
         {copy}\
         cat > /etc/apk/repositories <<'APPLIANCE_RUNTIME_REPOS'\n\
         {repository_file}APPLIANCE_RUNTIME_REPOS\n\
         cat > /etc/apk/world <<'APPLIANCE_RUNTIME_WORLD'\n\
         {world}\n\
         APPLIANCE_RUNTIME_WORLD\n\
         if ! apk add --no-progress --no-network --repositories-file /etc/apk/repositories $(cat /etc/apk/world); then\n\
           echo 'FATAL: pinned Runtime package installation failed' >&2\n\
           exit 1\n\
         fi\n"
    ))
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn shell_squote(value: &str) -> String {
    value.replace('\'', r#"'\''"#)
}

pub(crate) fn strip_verbatim(path: &str) -> &str {
    path.strip_prefix(r"\\?\").unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drvfs_helper_targets_only_the_granted_read_only_share() {
        let script = wsl_runtime_share_mount_script(r"C:\Users\Avery\.appliance\vm");
        assert!(script
            .contains("mount -t drvfs \"$HOST_PATH\" \"$SHARE\" -o ro,uid=1000,gid=1000,metadata"));
        assert!(script.contains("SHARE=/run/appliance/shares/$TAG"));
        assert!(!script.contains("SHARE=$2"));
        assert!(!script.contains("mkdir -p \"$HOST_PATH\""));
        assert!(!script.contains("wslpath"));
        assert!(!script.contains("/mnt/c"));
    }

    #[cfg(unix)]
    #[test]
    fn drvfs_helper_executes_with_host_path_edge_cases_confined() {
        use std::os::unix::fs::PermissionsExt;
        use std::process::Command;
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "appliance-runtime-drvfs-{}-{nonce}",
            std::process::id()
        ));
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();

        let write_executable = |name: &str, body: &str| {
            let path = bin.join(name);
            std::fs::write(&path, body).unwrap();
            let mut permissions = std::fs::metadata(&path).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&path, permissions).unwrap();
        };
        write_executable("mkdir", "#!/bin/sh\nexit 0\n");
        write_executable("grep", "#!/bin/sh\nexit 1\n");
        write_executable(
            "mount",
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$MOUNT_LOG\"\nexit 0\n",
        );

        let helper = root.join("runtime-share-mount");
        std::fs::write(
            &helper,
            wsl_runtime_share_mount_script(r"C:\Users\Avery\.appliance\vm"),
        )
        .unwrap();
        let mount_log = root.join("mount.log");
        let run = |host_path: &str| {
            let _ = std::fs::remove_file(&mount_log);
            Command::new("/bin/sh")
                .arg(&helper)
                .arg("ap-0123456789abcdef")
                .arg(host_path)
                .env("PATH", &bin)
                .env("MOUNT_LOG", &mount_log)
                .output()
                .unwrap()
        };
        let assert_confined = || {
            let log = std::fs::read_to_string(&mount_log).unwrap();
            let lines: Vec<_> = log.lines().collect();
            assert_eq!(lines.len(), 1);
            assert!(lines[0].contains(
                " /run/appliance/shares/ap-0123456789abcdef -o ro,uid=1000,gid=1000,metadata"
            ));
        };

        assert!(!run(r"C:\payload\..\escape").status.success());
        assert!(!run("/mnt/c/payload").status.success());
        assert!(!run(r"\\server\share").status.success());
        assert!(!run(r"D:\").status.success());
        assert!(!run(r"C:\Users\Avery\.appliance\vm").status.success());
        assert!(!run(r"C:\Users\Avery\.appliance\vm\pool").status.success());
        assert!(run(r"D:\payload").status.success());
        assert_confined();
        assert!(run(r"\\?\D:\payload").status.success());
        assert_confined();
        assert!(run(r"C:\O'Brien").status.success());
        assert_confined();

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn virtiofs_helper_keeps_the_existing_read_only_mount_contract() {
        let script = runtime_share_mount_script(RuntimeGuestBackend::VirtioFs);
        assert!(script.contains("mount -t virtiofs -o ro \"$TAG\" \"$SHARE\""));
        assert!(!script.contains("wslpath"));
    }

    #[test]
    fn wsl_host_path_validation_rejects_unc_and_non_translatable_paths() {
        assert!(validate_wsl_runtime_host_path(r"C:\Users\Avery O'Brien\payload").is_ok());
        assert!(validate_wsl_runtime_host_path(r"\\?\D:\runtime\payload").is_ok());
        for unsupported in [
            r"\\server\share\payload",
            r"\\?\UNC\server\share\payload",
            "//server/share/payload",
            r"\var\lib\payload",
            r"relative\payload",
            r"\\?\Volume{abc}\payload",
            r"C:\payload\..\state",
            r"D:\",
            "/mnt/c/payload",
        ] {
            assert!(
                validate_wsl_runtime_host_path(unsupported).is_err(),
                "unexpectedly accepted {unsupported}"
            );
        }
    }

    #[test]
    fn mount_containment_rejects_the_state_dir_and_its_parents() {
        let state = std::path::Path::new("/users/avery/.appliance");
        assert!(validate_mount_excludes_state_dir(
            std::path::Path::new("/users/avery/projects/app"),
            state,
        )
        .is_ok());
        for mount in [
            std::path::Path::new("/users/avery"),
            state,
            std::path::Path::new("/users/avery/.appliance/vm/pool"),
        ] {
            assert!(validate_mount_excludes_state_dir(mount, state).is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn artifact_receive_plan_executes_size_and_stubbed_digest_checks() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        use std::process::{Command, Stdio};
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "appliance-artifact-receive-{}-{nonce}",
            std::process::id()
        ));
        let bin = root.join("bin");
        let destination = root.join("stage/artifact");
        let digest_log = root.join("digest.log");
        std::fs::create_dir_all(&bin).unwrap();
        let sha256sum = bin.join("sha256sum");
        std::fs::write(
            &sha256sum,
            "#!/bin/sh\n[ \"$1\" = -c ] || exit 2\nIFS= read -r CHECK\nprintf '%s\\n' \"$CHECK\" > \"$DIGEST_LOG\"\nexit 0\n",
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&sha256sum).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&sha256sum, permissions).unwrap();

        let digest = "a".repeat(64);
        let command = artifact_receive_command(&destination.to_string_lossy(), 7, &digest).unwrap();
        let path = format!(
            "{}:{}",
            bin.display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let mut child = Command::new("/bin/sh")
            .args(["-c", &command])
            .env("PATH", &path)
            .env("DIGEST_LOG", &digest_log)
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(b"payload").unwrap();
        assert!(child.wait().unwrap().success());
        assert_eq!(std::fs::read(&destination).unwrap(), b"payload");
        let check = std::fs::read_to_string(&digest_log).unwrap();
        assert!(check.starts_with(&digest));
        assert!(check.ends_with("artifact.partial\n"));

        let rejected = root.join("stage/rejected");
        let command = artifact_receive_command(&rejected.to_string_lossy(), 8, &digest).unwrap();
        let mut child = Command::new("/bin/sh")
            .args(["-c", &command])
            .env("PATH", &path)
            .env("DIGEST_LOG", &digest_log)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(b"payload").unwrap();
        assert!(!child.wait().unwrap().success());
        assert!(!rejected.exists());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn artifact_receive_plan_rejects_unsafe_targets_and_digests() {
        let digest = "a".repeat(64);
        for destination in ["relative", "/opt/../etc/passwd", "/opt/bad\npath"] {
            assert!(artifact_receive_command(destination, 1, &digest).is_err());
        }
        assert!(artifact_receive_command("/opt/appliance/artifact", 1, "not-a-digest").is_err());
    }

    #[test]
    fn drvfs_share_reconciliation_never_requires_a_pool_restart() {
        assert!(!runtime_share_requires_restart("wsl", true, true));
        assert!(runtime_share_requires_restart("vz", true, true));
        assert!(!runtime_share_requires_restart("vz", false, true));
        assert!(!runtime_share_requires_restart("vz", true, false));
    }

    #[test]
    fn wsl_rules_fail_closed_after_the_broker_allows() {
        let rules = wsl_principal_rules("172.25.64.1".parse().unwrap(), 5053);
        assert!(rules.contains("type nat hook postrouting priority srcnat"));
        assert!(rules.contains("ip saddr 192.168.127.0/24 oifname \"eth0\" masquerade"));
        let established = rules
            .find("ct state established,related accept")
            .expect("established flow allow");
        let broker = rules
            .find("ip daddr 172.25.64.1 tcp dport 5053 accept")
            .expect("host egress broker allow");
        let drop = rules
            .find("iifname \"r*\" ip saddr 192.168.127.0/24 drop")
            .expect("principal default drop");
        assert!(
            established < broker && broker < drop,
            "allows must precede the drop"
        );
        assert!(rules.contains("type filter hook forward priority -9"));
        assert_eq!(
            runtime_principal_snat_script(RuntimeGuestBackend::VirtioFs, None, 5053).unwrap(),
            "#!/bin/sh\nset -eu\n"
        );
    }

    #[test]
    fn wsl_runtime_apk_fragment_is_pinned_and_guest_local() {
        let fragment =
            wsl_runtime_apk_install(&["main"], &["containerd=2.0.0-r5", "socat=1.8.1.3-r0"])
                .unwrap();
        assert!(fragment.contains("APK_SOURCE=/opt/appliance/artifacts/runtime-apks/main"));
        assert!(fragment.contains("containerd=2.0.0-r5"));
        assert!(fragment.contains("socat=1.8.1.3-r0"));
        assert!(fragment.contains("--no-network"));
        assert!(!fragment.contains("https://"));
        assert!(!fragment.contains("wslpath"));
    }
}
