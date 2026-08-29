use crate::{CredentialStore, Presence, StoreError, StoreKey};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
#[cfg(windows)]
use windows_sys::Win32::Security::{
    GetTokenInformation, IsValidSid, TokenUser, PSID, TOKEN_QUERY, TOKEN_USER,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[cfg(windows)]
struct OwnedHandle(HANDLE);

#[cfg(windows)]
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// The aligned token buffer owns the memory referenced by `sid`.
#[cfg(windows)]
struct CurrentUserSid {
    _buffer: Vec<usize>,
    sid: PSID,
}

#[cfg(windows)]
impl CurrentUserSid {
    fn to_string(&self) -> Result<String, StoreError> {
        let mut raw = std::ptr::null_mut();
        if unsafe { ConvertSidToStringSidW(self.sid, &mut raw) } == 0 {
            return Err(map_io_error(std::io::Error::last_os_error()));
        }
        let result = (|| {
            let mut len = 0;
            while unsafe { *raw.add(len) } != 0 {
                len += 1;
            }
            String::from_utf16(unsafe { std::slice::from_raw_parts(raw, len) }).map_err(|error| {
                StoreError::Internal(format!("current user SID is not valid UTF-16: {error}"))
            })
        })();
        unsafe {
            let _ = LocalFree(raw.cast());
        }
        result
    }
}

#[cfg(windows)]
fn current_user_sid() -> Result<CurrentUserSid, StoreError> {
    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(map_io_error(std::io::Error::last_os_error()));
    }
    let token = OwnedHandle(token);
    let mut needed = 0;
    unsafe {
        GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut needed);
    }
    if needed == 0 {
        return Err(map_io_error(std::io::Error::last_os_error()));
    }
    // usize storage gives TOKEN_USER its required pointer alignment.
    let words = (needed as usize + std::mem::size_of::<usize>() - 1) / std::mem::size_of::<usize>();
    let mut buffer = vec![0_usize; words];
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    } == 0
    {
        return Err(map_io_error(std::io::Error::last_os_error()));
    }
    let sid = unsafe { (*(buffer.as_ptr().cast::<TOKEN_USER>())).User.Sid };
    if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
        return Err(StoreError::Internal(
            "current process token has an invalid user SID".to_owned(),
        ));
    }
    Ok(CurrentUserSid {
        _buffer: buffer,
        sid,
    })
}

#[derive(Debug, Clone)]
pub struct AclFileStore {
    root: PathBuf,
}

impl AclFileStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn path(&self, key: &StoreKey) -> Result<PathBuf, StoreError> {
        match key {
            StoreKey::Cluster(profile) => Ok(self
                .root
                .join("cluster")
                .join(format!("{}-cred", profile.as_str()))),
            StoreKey::Agent(provider) => Ok(self
                .root
                .join("agent")
                .join(format!("{}-cred", provider.as_str()))),
            StoreKey::EntitlementKey => Ok(self.root.join("device-entitlement-key.json")),
            StoreKey::EntitlementAnchor => Ok(self.root.join("device-entitlement-anchor.json")),
            StoreKey::VmBroker { name, file } => {
                Ok(self.root.join(name.as_str()).join(file.file_name()))
            }
        }
    }

    fn prepare_parent(&self, path: &Path) -> Result<(), StoreError> {
        let parent = path
            .parent()
            .ok_or_else(|| StoreError::Internal("credential path has no parent".to_owned()))?;
        fs::create_dir_all(parent).map_err(map_io_error)?;
        restrict_to_current_user(&self.root)?;
        restrict_to_current_user(parent)?;
        Ok(())
    }
}

impl CredentialStore for AclFileStore {
    fn get(&self, key: &StoreKey) -> Result<Option<Vec<u8>>, StoreError> {
        let path = self.path(key)?;
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err(StoreError::Malformed(format!(
                    "{} is not a regular file",
                    path.display()
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(map_io_error(error)),
        }
        fs::read(path).map(Some).map_err(map_io_error)
    }

    fn put(&self, key: &StoreKey, value: &[u8]) -> Result<(), StoreError> {
        let path = self.path(key)?;
        self.prepare_parent(&path)?;
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temp = path.with_extension(format!("tmp.{}.{}", std::process::id(), sequence));

        let result = (|| {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut output = options.open(&temp).map_err(map_io_error)?;
            output.write_all(value).map_err(map_io_error)?;
            output.sync_all().map_err(map_io_error)?;
            restrict_to_current_user(&temp)?;
            atomic_replace(&temp, &path)?;
            restrict_to_current_user(&path)
        })();

        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result
    }

    fn delete(&self, key: &StoreKey) -> Result<(), StoreError> {
        let path = self.path(key)?;
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(map_io_error(error)),
        }
    }

    fn probe(&self, key: &StoreKey) -> Result<Presence, StoreError> {
        let path = self.path(key)?;
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => Err(
                StoreError::Malformed("credential path is not a regular file".to_owned()),
            ),
            Ok(_) => Ok(Presence::Present),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Presence::Missing),
            Err(error) => Err(map_io_error(error)),
        }
    }
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> Result<(), StoreError> {
    fs::rename(source, destination).map_err(map_io_error)
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> Result<(), StoreError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(map_io_error(std::io::Error::last_os_error()))
    } else {
        Ok(())
    }
}

fn map_io_error(error: std::io::Error) -> StoreError {
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        StoreError::Denied(error.to_string())
    } else {
        StoreError::Internal(error.to_string())
    }
}

#[cfg(unix)]
fn restrict_to_current_user(path: &Path) -> Result<(), StoreError> {
    use std::os::unix::fs::PermissionsExt;

    let mode = if path.is_dir() { 0o700 } else { 0o600 };
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(map_io_error)
}

/// Minimal duplication of `packages/vm/src/fs_acl.rs` from
/// `fix/ap-195-windows-secret-acls`. Card 2 can replace this copy when the VM
/// starts consuming this crate; keeping it here avoids reversing the neutral
/// crate's dependency direction.
#[cfg(windows)]
fn restrict_to_current_user(path: &Path) -> Result<(), StoreError> {
    use std::os::windows::process::CommandExt;

    let principal = format!("*{}", current_user_sid()?.to_string()?);
    let permission = if path.is_dir() { "(OI)(CI)F" } else { "F" };
    let output = std::process::Command::new("icacls")
        .arg(path)
        .args([
            "/inheritance:r",
            "/grant:r",
            &format!("{principal}:{permission}"),
        ])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
        .map_err(map_io_error)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(StoreError::Denied(format!(
            "could not restrict {} to {principal}: {}",
            path.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::VmBrokerFile;

    fn test_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "appliance-credential-store-{name}-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn round_trip_probe_and_delete() {
        let root = test_root("roundtrip");
        let store = AclFileStore::new(&root);
        let key = StoreKey::vm_broker("primary", VmBrokerFile::Secrets).unwrap();
        let value = b"\x00raw\r\nsecret\xff";

        assert_eq!(store.probe(&key).unwrap(), Presence::Missing);
        assert_eq!(store.get(&key).unwrap(), None);
        store.put(&key, value).unwrap();
        assert_eq!(store.probe(&key).unwrap(), Presence::Present);
        assert_eq!(store.get(&key).unwrap().as_deref(), Some(value.as_slice()));
        store.put(&key, b"replacement").unwrap();
        assert_eq!(
            store.get(&key).unwrap().as_deref(),
            Some(b"replacement".as_slice())
        );
        store.delete(&key).unwrap();
        assert_eq!(store.probe(&key).unwrap(), Presence::Missing);
        store.delete(&key).unwrap();

        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn uses_owner_only_directory_and_file_modes() {
        use std::os::unix::fs::PermissionsExt;

        let root = test_root("modes");
        let store = AclFileStore::new(&root);
        let key = StoreKey::vm_broker("primary", VmBrokerFile::Credentials).unwrap();
        store.put(&key, b"secret").unwrap();

        let directory = root.join("primary");
        let file = directory.join(VmBrokerFile::Credentials.file_name());
        assert_eq!(
            fs::metadata(directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    #[test]
    fn linux_file_backend_supports_cluster_and_agent_credentials() {
        use std::os::unix::fs::PermissionsExt;

        let root = test_root("linux-desktop");
        let store = AclFileStore::new(&root);
        let cluster = StoreKey::cluster("dev%20profile").unwrap();
        let agent = StoreKey::agent("anthropic").unwrap();

        store.put(&cluster, b"cluster secret").unwrap();
        store.put(&agent, b"agent secret").unwrap();
        assert_eq!(
            store.get(&cluster).unwrap().as_deref(),
            Some(b"cluster secret".as_slice())
        );
        assert_eq!(
            store.get(&agent).unwrap().as_deref(),
            Some(b"agent secret".as_slice())
        );
        for file in [
            root.join("cluster/dev%20profile-cred"),
            root.join("agent/anthropic-cred"),
        ] {
            assert_eq!(
                fs::metadata(file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn resets_windows_acl_to_current_user() {
        use std::os::windows::process::CommandExt;

        let root = test_root("acl");
        let store = AclFileStore::new(&root);
        let key = StoreKey::vm_broker("primary", VmBrokerFile::Secrets).unwrap();
        store.put(&key, b"secret").unwrap();
        let path = root.join("primary").join(VmBrokerFile::Secrets.file_name());

        let output = std::process::Command::new("icacls")
            .arg(&path)
            .creation_flags(0x0800_0000)
            .output()
            .unwrap();
        assert!(output.status.success());
        let listing = String::from_utf8_lossy(&output.stdout);
        let acl_lines: Vec<_> = listing.lines().filter(|line| line.contains(":(")).collect();
        let principal = String::from_utf8_lossy(
            &std::process::Command::new("whoami")
                .creation_flags(0x0800_0000)
                .output()
                .unwrap()
                .stdout,
        )
        .trim()
        .to_owned();
        assert_eq!(acl_lines.len(), 1, "unexpected ACL listing:\n{listing}");
        assert!(
            acl_lines[0]
                .to_ascii_lowercase()
                .contains(&principal.to_ascii_lowercase()),
            "current principal missing from ACL listing:\n{listing}"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
