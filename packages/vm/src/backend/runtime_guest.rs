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
case "$TAG" in ap-[0-9a-f]*) ;; *) echo "invalid runtime share tag" >&2; exit 2;; esac
TAG_HEX=${TAG#ap-}
case "$TAG_HEX" in ''|*[!0-9a-f]*) echo "invalid runtime share tag" >&2; exit 2;; esac
[ "${#TAG_HEX}" -le 32 ] || { echo "invalid runtime share tag" >&2; exit 2; }
HOST_PATH=${HOST_PATH#\\\\?\\}
case "$HOST_PATH" in ''|\\\\*|//* ) echo "unsupported WSL runtime share path" >&2; exit 2;; esac
case "$HOST_PATH" in [A-Za-z]:[\\/]* ) ;; *) echo "unsupported WSL runtime share path" >&2; exit 2;; esac
case "$HOST_PATH" in *'\'..'\'*|*'\'..'/'*|*/..'\'*|*/../*|*'\'..|*/..) echo "unsupported WSL runtime share path" >&2; exit 2;; esac
SOURCE=$(wslpath -u "$HOST_PATH") || { echo "runtime share path is not translatable by wslpath" >&2; exit 2; }
[ -n "$SOURCE" ] && [ -d "$SOURCE" ] || { echo "translated runtime share is not a directory" >&2; exit 2; }
[ ! -L "$SOURCE" ] || { echo "translated runtime share must not be a symlink" >&2; exit 2; }
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
  chain host_relay_input {
    type filter hook input priority -9; policy accept;
    iifname "eth0" ip saddr __WSL_GATEWAY__ tcp dport 22000-25839 accept
    iifname "eth0" tcp dport 22000-25839 drop
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
                 else\n\
                   if ! nft list chain ip appliance_runtime_nat principal_egress >/dev/null 2>&1; then\n\
                     nft 'add chain ip appliance_runtime_nat principal_egress {{ type filter hook forward priority -9; policy accept; }}'\n\
                     nft add rule ip appliance_runtime_nat principal_egress iifname 'r*' ip saddr 192.168.127.0/24 ct state established,related accept\n\
                     nft add rule ip appliance_runtime_nat principal_egress iifname 'r*' ip saddr 192.168.127.0/24 ip daddr {gateway} tcp dport {egress_port} accept\n\
                     nft add rule ip appliance_runtime_nat principal_egress iifname 'r*' ip saddr 192.168.127.0/24 drop\n\
                   fi\n\
                   if ! nft list chain ip appliance_runtime_nat host_relay_input >/dev/null 2>&1; then\n\
                     nft 'add chain ip appliance_runtime_nat host_relay_input {{ type filter hook input priority -9; policy accept; }}'\n\
                     nft add rule ip appliance_runtime_nat host_relay_input iifname eth0 ip saddr {gateway} tcp dport 22000-25839 accept\n\
                     nft add rule ip appliance_runtime_nat host_relay_input iifname eth0 tcp dport 22000-25839 drop\n\
                   fi\n\
                 fi\n",
                rules
            ))
        }
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

/// VZ shares are boot devices; drvfs payloads are acquired on demand by the
/// guest helper and therefore never restart a live pool merely to add a share.
pub fn runtime_share_requires_restart(backend: &str, pool_running: bool, changed: bool) -> bool {
    backend != "wsl" && pool_running && changed
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
    fn drvfs_helper_quotes_paths_remounts_read_only_and_confines_the_target() {
        let script = runtime_share_mount_script(RuntimeGuestBackend::WslDrvFs);
        assert!(script.contains("SOURCE=$(wslpath -u \"$HOST_PATH\")"));
        assert!(script.contains("mount --bind \"$SOURCE\" \"$SHARE\""));
        assert!(script.contains("mount -o remount,bind,ro \"$SHARE\""));
        assert!(script.contains("SHARE=/run/appliance/shares/$TAG"));
        assert!(!script.contains("SHARE=$2"));
        assert!(!script.contains("mkdir -p \"$HOST_PATH\""));
    }

    #[cfg(unix)]
    #[test]
    fn drvfs_helper_executes_with_host_path_edge_cases_confined() {
        use std::os::unix::fs::{symlink, PermissionsExt};
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
        let safe_source = root.join("source");
        let linked_source = root.join("source-link");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&safe_source).unwrap();
        symlink(&safe_source, &linked_source).unwrap();

        let write_executable = |name: &str, body: &str| {
            let path = bin.join(name);
            std::fs::write(&path, body).unwrap();
            let mut permissions = std::fs::metadata(&path).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&path, permissions).unwrap();
        };
        write_executable(
            "wslpath",
            r#"#!/bin/sh
case "$2" in
  'C:\safe'|'D:\payload'|'C:\O'\''Brien') printf '%s\n' "$SAFE_SOURCE" ;;
  'C:\linked') printf '%s\n' "$LINKED_SOURCE" ;;
  *) printf '%s\n' "$SAFE_SOURCE" ;;
esac
"#,
        );
        write_executable("mkdir", "#!/bin/sh\nexit 0\n");
        write_executable("grep", "#!/bin/sh\nexit 1\n");
        write_executable(
            "mount",
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$MOUNT_LOG\"\nexit 0\n",
        );

        let helper = root.join("runtime-share-mount");
        std::fs::write(
            &helper,
            runtime_share_mount_script(RuntimeGuestBackend::WslDrvFs),
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
                .env("SAFE_SOURCE", &safe_source)
                .env("LINKED_SOURCE", &linked_source)
                .env("MOUNT_LOG", &mount_log)
                .output()
                .unwrap()
        };
        let assert_confined = || {
            let log = std::fs::read_to_string(&mount_log).unwrap();
            assert!(!log.is_empty());
            assert!(log
                .lines()
                .all(|line| line.ends_with("/run/appliance/shares/ap-0123456789abcdef")));
        };

        assert!(!run(r"C:\payload\..\escape").status.success());
        assert!(!run(r"C:\linked").status.success());
        assert!(!run(r"\\server\share").status.success());
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
        ] {
            assert!(
                validate_wsl_runtime_host_path(unsupported).is_err(),
                "unexpectedly accepted {unsupported}"
            );
        }
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
        let host = rules
            .find("iifname \"eth0\" ip saddr 172.25.64.1 tcp dport 22000-25839 accept")
            .expect("WSL host relay allow");
        let sibling = rules
            .find("iifname \"eth0\" tcp dport 22000-25839 drop")
            .expect("sibling-distro relay drop");
        assert!(host < sibling, "the WSL host allow must precede the relay drop");
        assert_eq!(
            runtime_principal_snat_script(RuntimeGuestBackend::VirtioFs, None, 5053).unwrap(),
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
