use crate::spec::{VmPaths, VmSpec};
use anyhow::{Context, Result};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

fn parse_spec_for_backend(raw: &str, backend: &str) -> serde_json::Result<(VmSpec, bool)> {
    let mut spec: VmSpec = serde_json::from_str(raw)?;
    let normalised = spec.normalise_net_link_for_backend(backend);
    Ok((spec, normalised))
}

/// Root for all VM state: VM definitions, disks, cached guest images.
/// Sits under the same `~/.appliance` umbrella as credentials and the
/// helper-managed binaries so `rm -rf ~/.appliance` remains the one
/// true uninstall.
pub fn vm_root() -> PathBuf {
    // HOME first (every Unix shell, and Git Bash on Windows), then
    // USERPROFILE — PowerShell and the desktop don't set HOME on
    // Windows, and falling through to "." would scatter VM state into
    // whatever directory the process happened to start in.
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let root = home.join(".appliance").join("vm");
    migrate_legacy_root(&home.join(".appliance").join("vmm"), &root);
    root
}

/// Canonicalize as much of `path` as currently exists, then append any
/// missing tail. State paths are needed before their directories are created
/// during validation and bootstrap rendering, especially on fresh hosts.
pub fn canonicalize_with_missing_tail(path: &Path) -> PathBuf {
    let mut existing = path;
    let mut tail = Vec::new();
    loop {
        if let Ok(mut canonical) = std::fs::canonicalize(existing) {
            for component in tail.iter().rev() {
                canonical.push(component);
            }
            return canonical;
        }
        let Some(name) = existing.file_name() else {
            return path.to_path_buf();
        };
        tail.push(name.to_os_string());
        let Some(parent) = existing.parent() else {
            return path.to_path_buf();
        };
        existing = parent;
    }
}

/// One-time move of pre-rename state (`~/.appliance/vmm`, binary then
/// called appliance-vmm) into the current root, so existing VMs keep
/// working across the rename. No-op once the new root exists.
fn migrate_legacy_root(legacy: &std::path::Path, root: &std::path::Path) {
    if root.exists() || !legacy.exists() {
        return;
    }
    if fs::rename(legacy, root).is_err() {
        return;
    }
    // Pidfiles were named vmm.pid; carry them over so a VM that was
    // running through the rename is still seen (and stoppable).
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let old_pid = entry.path().join("vmm.pid");
            if old_pid.exists() {
                let _ = fs::rename(&old_pid, entry.path().join("vm.pid"));
            }
        }
    }
}

pub fn save_spec(spec: &VmSpec) -> Result<()> {
    let mut spec = spec.clone();
    spec.normalise_net_link_for_backend(crate::backend::platform_backend_name());
    let paths = VmPaths::for_name(&spec.name);
    fs::create_dir_all(&paths.dir).with_context(|| format!("create {}", paths.dir.display()))?;
    crate::fs_acl::restrict_to_current_user(&paths.dir)?;
    let json = serde_json::to_string_pretty(&spec)?;
    fs::write(paths.spec(), json).with_context(|| format!("write {}", paths.spec().display()))?;
    crate::fs_acl::restrict_to_current_user(&paths.spec())?;
    Ok(())
}

pub fn load_spec(name: &str) -> Result<Option<VmSpec>> {
    let paths = VmPaths::for_name(name);
    let path = paths.spec();
    load_spec_path(&path, crate::backend::platform_backend_name())
}

pub(crate) fn load_spec_path(path: &Path, backend: &str) -> Result<Option<VmSpec>> {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("open {}", path.display())),
    };
    crate::creds::verify_config_integrity(path, &file)
        .with_context(|| format!("verify {}", path.display()))?;
    let mut raw = String::new();
    file.read_to_string(&mut raw)
        .with_context(|| format!("read {}", path.display()))?;
    let (spec, _) = parse_spec_for_backend(&raw, backend)
        .with_context(|| format!("parse {}", path.display()))?;
    Ok(Some(spec))
}

pub fn delete_vm_dir(name: &str) -> Result<()> {
    let paths = VmPaths::for_name(name);
    if paths.dir.exists() {
        fs::remove_dir_all(&paths.dir)
            .with_context(|| format!("remove {}", paths.dir.display()))?;
    }
    Ok(())
}

/// All defined VMs (one per `~/.appliance/vm/<name>/vm.json`). Used to
/// list VMs and to allocate non-colliding ports for a new one.
/// Skips the shared `images` dir and any unparseable specs.
pub fn list_specs() -> Vec<VmSpec> {
    let mut specs = Vec::new();
    let Ok(entries) = fs::read_dir(vm_root()) else {
        return specs;
    };
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let spec_path = entry.path().join("vm.json");
        if let Ok(raw) = fs::read_to_string(&spec_path) {
            if let Ok((spec, _)) =
                parse_spec_for_backend(&raw, crate::backend::platform_backend_name())
            {
                specs.push(spec);
            }
        }
    }
    specs.sort_by(|a, b| a.name.cmp(&b.name));
    specs
}

/// Create the sparse raw data disk if it doesn't exist yet. Sparse so a
/// 10 GiB disk costs nothing until the guest writes to it.
///
/// No-op on Windows: the WSL2 backend's distro owns its own persistent
/// VHDX, so a raw data disk would be 10 GiB of NTFS allocation nothing
/// ever reads.
pub fn ensure_disk(spec: &VmSpec) -> Result<PathBuf> {
    let paths = VmPaths::for_name(&spec.name);
    let disk = paths.disk();
    if cfg!(windows) {
        return Ok(disk);
    }
    if !disk.exists() {
        fs::create_dir_all(&paths.dir)?;
        let file = fs::File::create(&disk).with_context(|| format!("create {}", disk.display()))?;
        file.set_len(spec.disk_gib * 1024 * 1024 * 1024)
            .context("size data disk")?;
    }
    Ok(disk)
}

/// Read a pidfile and check whether that process is still alive.
pub fn read_live_pid(name: &str) -> Option<i32> {
    let paths = VmPaths::for_name(name);
    let raw = fs::read_to_string(paths.pidfile()).ok()?;
    let pid: i32 = raw.trim().parse().ok()?;
    if pid_alive(pid) {
        Some(pid)
    } else {
        None
    }
}

/// Probe liveness without touching the process.
#[cfg(unix)]
fn pid_alive(pid: i32) -> bool {
    // kill(pid, 0) probes liveness without sending a signal.
    unsafe { libc::kill(pid, 0) == 0 }
}

/// Windows stand-in for `kill(pid, 0)`: open the process for status
/// query and check it hasn't exited. A pid we can't open at all is
/// treated as dead — the host process is ours, so an access-denied
/// answer means the pid was recycled by something privileged.
#[cfg(windows)]
fn pid_alive(pid: i32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if pid <= 0 {
        return false;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32);
        if handle.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok != 0 && code == STILL_ACTIVE as u32
    }
}

pub fn write_pidfile(name: &str) -> Result<()> {
    let paths = VmPaths::for_name(name);
    fs::create_dir_all(&paths.dir)?;
    fs::write(paths.pidfile(), std::process::id().to_string())?;
    Ok(())
}

pub fn clear_pidfile(name: &str) {
    let paths = VmPaths::for_name(name);
    let _ = fs::remove_file(paths.pidfile());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::NetLink;

    #[test]
    fn canonicalize_preserves_a_missing_state_tail() {
        let existing = std::env::temp_dir().join(format!(
            "appliance-canonicalize-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&existing).unwrap();
        let missing = existing.join(".appliance").join("vm");

        let resolved = canonicalize_with_missing_tail(&missing);

        assert_eq!(
            resolved,
            std::fs::canonicalize(&existing)
                .unwrap()
                .join(".appliance")
                .join("vm")
        );
        std::fs::remove_dir_all(existing).unwrap();
    }

    #[test]
    fn loading_a_persisted_wsl_netstack_spec_normalises_to_nat() {
        let mut persisted = VmSpec::defaults("legacy-wsl");
        persisted.net_link = NetLink::Netstack;
        let raw = serde_json::to_string(&persisted).unwrap();

        let (loaded, normalised) = parse_spec_for_backend(&raw, "wsl").unwrap();
        assert!(normalised);
        assert_eq!(loaded.net_link, NetLink::Nat);
    }

    #[cfg(unix)]
    #[test]
    fn spec_load_verifies_the_open_handle_before_reading() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!(
            "appliance-spec-integrity-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("vm.json");
        std::fs::write(
            &path,
            serde_json::to_vec(&VmSpec::defaults("safe")).unwrap(),
        )
        .unwrap();
        crate::fs_acl::restrict_to_current_user(&dir).unwrap();
        crate::fs_acl::restrict_to_current_user(&path).unwrap();
        assert_eq!(load_spec_path(&path, "vz").unwrap().unwrap().name, "safe");

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666)).unwrap();
        assert!(load_spec_path(&path, "vz").is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
