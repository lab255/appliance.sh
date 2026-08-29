//! Backend-specific adapters used by the otherwise shared Runtime guest.
//!
//! Keep these generators platform-neutral: WSL itself only compiles on
//! Windows, while quoting, target confinement, and nft policy are pure logic
//! that every development host can test.

use anyhow::{bail, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeGuestBackend {
    VirtioFs,
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
case "$TAG" in ap-[0-9a-f]*) ;; *) echo "invalid runtime share tag" >&2; exit 2;; esac
TAG_HEX=${TAG#ap-}
case "$TAG_HEX" in ''|*[!0-9a-f]*) echo "invalid runtime share tag" >&2; exit 2;; esac
[ "${#TAG_HEX}" -le 32 ] || { echo "invalid runtime share tag" >&2; exit 2; }
case "$HOST_PATH" in ''|\\\\*|//* ) echo "unsupported WSL runtime share path" >&2; exit 2;; esac
SOURCE=$(wslpath -u "$HOST_PATH") || { echo "runtime share path is not translatable by wslpath" >&2; exit 2; }
[ -n "$SOURCE" ] && [ -d "$SOURCE" ] || { echo "translated runtime share is not a directory" >&2; exit 2; }
SHARE=/run/appliance/shares/$TAG
mkdir -p "$SHARE"
if ! grep -qs " $SHARE " /proc/mounts; then
  mount --bind "$SOURCE" "$SHARE"
  if ! mount -o remount,bind,ro "$SHARE"; then
    umount "$SHARE" 2>/dev/null || true
    exit 1
  fi
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

pub const fn runtime_share_unmount_script() -> &'static str {
    SHARE_UNMOUNT
}

const WSL_PRINCIPAL_SNAT_RULES: &str = r#"table ip appliance_runtime_nat {
  chain principal_snat {
    type nat hook postrouting priority srcnat; policy accept;
    ip saddr 192.168.127.0/24 oifname "eth0" masquerade
  }
}
"#;

/// Pure nft ruleset for the WSL principal address space. Every packet leaving
/// a Runtime principal via eth0 is translated; this is deliberately not
/// limited to HTTP proxy traffic.
pub const fn wsl_principal_snat_rules() -> &'static str {
    WSL_PRINCIPAL_SNAT_RULES
}

pub fn runtime_principal_snat_script(backend: RuntimeGuestBackend) -> String {
    match backend {
        RuntimeGuestBackend::VirtioFs => "#!/bin/sh\nset -eu\n".to_string(),
        RuntimeGuestBackend::WslDrvFs => format!(
            "#!/bin/sh\nset -eu\n\
             if ! nft list table ip appliance_runtime_nat >/dev/null 2>&1; then\n\
               nft -f - <<'APPLIANCE_RUNTIME_NFT'\n\
             {}APPLIANCE_RUNTIME_NFT\n\
             fi\n",
            wsl_principal_snat_rules()
        ),
    }
}

/// Reject Windows paths for which WSL's drvfs adapter has no safe v1
/// translation. `canonicalize` runs before this check in `runtime prepare`, so
/// an accepted path is an existing local-drive directory.
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
        bail!("WSL Runtime payload share path is not translatable by wslpath");
    }
    Ok(())
}

/// Build the offline, signed APK install fragment for a WSL Runtime guest.
/// Each input is `(repository name, Windows directory containing APKINDEX and
/// the selected closure)`. Files are copied off drvfs into root-owned guest
/// storage before apk verifies and installs them.
#[cfg(any(target_os = "windows", test))]
pub fn wsl_runtime_apk_install(repositories: &[(&str, &str)], world: &[&str]) -> Result<String> {
    if repositories.is_empty() {
        bail!("WSL Runtime requires the mirrored signed APK closure");
    }
    let mut copy = String::new();
    let mut repository_file = String::new();
    for (name, host) in repositories {
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            bail!("invalid Runtime APK repository name '{name}'");
        }
        let host = shell_squote(strip_verbatim(host));
        copy.push_str(&format!(
            "APK_SOURCE=$(wslpath -u '{host}') || {{ echo 'FATAL: Runtime APK mirror is not translatable by wslpath' >&2; exit 1; }}\n\
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
fn shell_squote(value: &str) -> String {
    value.replace('\'', r#"'\''"#)
}

#[cfg(any(target_os = "windows", test))]
fn strip_verbatim(path: &str) -> &str {
    path.strip_prefix(r"\\?\").unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drvfs_helper_quotes_paths_remounts_read_only_and_confines_the_target() {
        let script = runtime_share_mount_script(RuntimeGuestBackend::WslDrvFs);
        assert!(script.contains("SOURCE=$(wslpath -u \"$HOST_PATH\")"));
        assert!(script.contains("mount --bind \"$SOURCE\" \"$SHARE\""));
        assert!(script.contains("mount -o remount,bind,ro \"$SHARE\""));
        assert!(script.contains("SHARE=/run/appliance/shares/$TAG"));
        assert!(!script.contains("SHARE=$2"));
        assert!(!script.contains("mkdir -p \"$HOST_PATH\""));
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
        ] {
            assert!(
                validate_wsl_runtime_host_path(unsupported).is_err(),
                "unexpectedly accepted {unsupported}"
            );
        }
    }

    #[test]
    fn snat_rules_cover_every_principal_egress_packet() {
        let rules = wsl_principal_snat_rules();
        assert!(rules.contains("type nat hook postrouting priority srcnat"));
        assert!(rules.contains("ip saddr 192.168.127.0/24 oifname \"eth0\" masquerade"));
        assert!(!rules.contains("tcp dport"));
        assert!(!rules.contains("proxy"));
        assert_eq!(
            runtime_principal_snat_script(RuntimeGuestBackend::VirtioFs),
            "#!/bin/sh\nset -eu\n"
        );
    }

    #[test]
    fn wsl_runtime_apk_fragment_is_pinned_local_and_shell_quoted() {
        let fragment = wsl_runtime_apk_install(
            &[("main", r"\\?\C:\Users\Avery O'Brien\runtime-apks\main")],
            &["containerd=2.0.0-r5", "socat=1.8.1.3-r0"],
        )
        .unwrap();
        assert!(fragment.contains(r#"wslpath -u 'C:\Users\Avery O'\''Brien\runtime-apks\main'"#));
        assert!(fragment.contains("containerd=2.0.0-r5"));
        assert!(fragment.contains("socat=1.8.1.3-r0"));
        assert!(fragment.contains("--no-network"));
        assert!(!fragment.contains("https://"));
    }
}
