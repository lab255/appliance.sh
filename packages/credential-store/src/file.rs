use crate::{CredentialStore, Presence, StoreError, StoreKey};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW, SDDL_REVISION_1,
    SE_FILE_OBJECT,
};
#[cfg(windows)]
use windows_sys::Win32::Security::{
    GetSecurityDescriptorDacl, GetTokenInformation, IsValidSid, TokenUser,
    DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
    PSECURITY_DESCRIPTOR, PSID, TOKEN_QUERY, TOKEN_USER,
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

#[cfg(windows)]
struct LocalSecurityDescriptor(PSECURITY_DESCRIPTOR);

#[cfg(windows)]
impl Drop for LocalSecurityDescriptor {
    fn drop(&mut self) {
        unsafe {
            let _ = windows_sys::Win32::Foundation::LocalFree(self.0);
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
    let words = (needed as usize).div_ceil(std::mem::size_of::<usize>());
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
    vm_dir: Option<PathBuf>,
}

impl AclFileStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            vm_dir: None,
        }
    }

    pub fn for_vm_dir(dir: impl Into<PathBuf>) -> Self {
        let dir = dir.into();
        let root = dir.parent().unwrap_or(&dir).to_path_buf();
        Self {
            root,
            vm_dir: Some(dir),
        }
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
            StoreKey::VmBroker { name, file } => Ok(self
                .vm_dir
                .clone()
                .unwrap_or_else(|| self.root.join(name.as_str()))
                .join(file.file_name())),
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
pub fn restrict_to_current_user(path: &Path) -> Result<(), StoreError> {
    use std::os::unix::fs::PermissionsExt;

    let mode = if path.is_dir() { 0o700 } else { 0o600 };
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(map_io_error)
}

/// Apply a protected DACL containing exactly the current user, SYSTEM, and
/// Administrators, and make the current user the object's owner.
#[cfg(windows)]
pub fn restrict_to_current_user(path: &Path) -> Result<(), StoreError> {
    use std::os::windows::ffi::OsStrExt;

    let current_user = current_user_sid()?;
    let inheritance = if path.is_dir() { "OICI" } else { "" };
    // These are the same three principals accepted by the VM credential
    // integrity verifier. SYSTEM and Administrators retain access because
    // either can take ownership regardless of an object's DACL.
    let sddl = format!(
        "D:P(A;{inheritance};FA;;;{})(A;{inheritance};FA;;;SY)(A;{inheritance};FA;;;BA)",
        sid_to_string(current_user.sid)?
    );
    let wide_sddl: Vec<u16> = std::ffi::OsStr::new(&sddl)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide_sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(path_error(
            "build protected DACL for",
            path,
            std::io::Error::last_os_error(),
        ));
    }
    let _descriptor = LocalSecurityDescriptor(descriptor);
    let mut dacl_present = 0;
    let mut dacl_defaulted = 0;
    let mut dacl = std::ptr::null_mut();
    if unsafe {
        GetSecurityDescriptorDacl(
            descriptor,
            &mut dacl_present,
            &mut dacl,
            &mut dacl_defaulted,
        )
    } == 0
        || dacl_present == 0
        || dacl.is_null()
    {
        return Err(path_error(
            "read protected DACL for",
            path,
            std::io::Error::last_os_error(),
        ));
    }

    let wide_path: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let status = unsafe {
        SetNamedSecurityInfoW(
            wide_path.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION
                | DACL_SECURITY_INFORMATION
                | PROTECTED_DACL_SECURITY_INFORMATION,
            current_user.sid,
            std::ptr::null_mut(),
            dacl,
            std::ptr::null_mut(),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(path_error(
            "restrict",
            path,
            std::io::Error::from_raw_os_error(status as i32),
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn sid_to_string(sid: PSID) -> Result<String, StoreError> {
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;

    let mut raw = std::ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut raw) } == 0 {
        return Err(map_io_error(std::io::Error::last_os_error()));
    }
    let result = {
        let mut len = 0;
        while unsafe { *raw.add(len) } != 0 {
            len += 1;
        }
        String::from_utf16(unsafe { std::slice::from_raw_parts(raw, len) }).map_err(|error| {
            StoreError::Internal(format!("current user SID is not valid UTF-16: {error}"))
        })
    };
    unsafe {
        let _ = windows_sys::Win32::Foundation::LocalFree(raw.cast());
    }
    result
}

#[cfg(windows)]
fn path_error(action: &str, path: &Path, error: std::io::Error) -> StoreError {
    let message = format!("{action} {}: {error}", path.display());
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        StoreError::Denied(message)
    } else {
        StoreError::Internal(message)
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
    fn assert_windows_acl(path: &Path) {
        use std::os::windows::io::AsRawHandle;
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::Foundation::{LocalFree, ERROR_SUCCESS, HANDLE};
        use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
        use windows_sys::Win32::Security::{
            EqualSid, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
        };

        let output = std::process::Command::new("icacls")
            .arg(path)
            .creation_flags(0x0800_0000)
            .output()
            .unwrap();
        assert!(output.status.success());
        let listing = String::from_utf8_lossy(&output.stdout);
        let path_text = path.to_string_lossy();
        let actual: std::collections::BTreeSet<_> = listing
            .lines()
            .filter_map(|line| line.rsplit_once(":(").map(|(principal, _)| principal))
            .map(|principal| {
                principal
                    .trim_start()
                    .strip_prefix(path_text.as_ref())
                    .unwrap_or(principal.trim_start())
                    .trim()
                    .to_ascii_lowercase()
            })
            .collect();
        let current_principal = String::from_utf8_lossy(
            &std::process::Command::new("whoami")
                .creation_flags(0x0800_0000)
                .output()
                .unwrap()
                .stdout,
        )
        .trim()
        .to_ascii_lowercase();
        let expected = std::collections::BTreeSet::from([
            current_principal,
            "nt authority\\system".to_owned(),
            "builtin\\administrators".to_owned(),
        ]);
        assert_eq!(actual, expected, "unexpected ACL listing:\n{listing}");

        let file = OpenOptions::new().read(true).open(path).unwrap();
        let mut owner: PSID = std::ptr::null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let status = unsafe {
            GetSecurityInfo(
                file.as_raw_handle() as HANDLE,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION,
                &mut owner,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        assert_eq!(status, ERROR_SUCCESS, "GetSecurityInfo failed: {status}");
        assert!(
            !descriptor.is_null(),
            "GetSecurityInfo returned no descriptor"
        );
        let current_user = current_user_sid().unwrap();
        assert!(
            !owner.is_null() && unsafe { EqualSid(owner, current_user.sid) } != 0,
            "credential file owner is not the current user SID"
        );
        unsafe {
            let _ = LocalFree(descriptor.cast());
        }
    }

    #[cfg(windows)]
    #[test]
    fn resets_windows_acl_to_current_user() {
        let root = test_root("acl");
        let store = AclFileStore::new(&root);
        let key = StoreKey::vm_broker("primary", VmBrokerFile::Secrets).unwrap();
        store.put(&key, b"secret").unwrap();
        let path = root.join("primary").join(VmBrokerFile::Secrets.file_name());

        assert_windows_acl(&path);
        fs::remove_dir_all(root).unwrap();
    }
}
