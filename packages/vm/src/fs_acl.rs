use anyhow::{Context, Result};
use std::path::Path;

#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, ERROR_SUCCESS, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
    SetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
};
#[cfg(windows)]
use windows_sys::Win32::Security::{
    GetSecurityDescriptorDacl, GetTokenInformation, IsValidSid, TokenUser,
    DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
    PSECURITY_DESCRIPTOR, PSID, TOKEN_QUERY, TOKEN_USER,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

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
            let _ = LocalFree(self.0);
        }
    }
}

/// The current process token's user SID. The aligned token buffer owns the
/// memory referenced by `sid` and must live for as long as the pointer is used.
#[cfg(windows)]
pub(crate) struct CurrentUserSid {
    _buffer: Vec<usize>,
    sid: PSID,
}

#[cfg(windows)]
impl CurrentUserSid {
    pub(crate) fn as_psid(&self) -> PSID {
        self.sid
    }

    fn to_string(&self) -> Result<String> {
        let mut raw = std::ptr::null_mut();
        if unsafe { ConvertSidToStringSidW(self.sid, &mut raw) } == 0 {
            return Err(std::io::Error::last_os_error()).context("convert current user SID to text");
        }
        let result = (|| {
            let mut len = 0;
            while unsafe { *raw.add(len) } != 0 {
                len += 1;
            }
            String::from_utf16(unsafe { std::slice::from_raw_parts(raw, len) })
                .context("current user SID is not valid UTF-16")
        })();
        unsafe {
            let _ = LocalFree(raw.cast());
        }
        result
    }
}

#[cfg(windows)]
pub(crate) fn current_user_sid() -> Result<CurrentUserSid> {
    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(std::io::Error::last_os_error()).context("open current process token");
    }
    let token = OwnedHandle(token);
    let mut needed = 0;
    unsafe {
        GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut needed);
    }
    if needed == 0 {
        return Err(std::io::Error::last_os_error())
            .context("size current process token user");
    }
    // usize storage gives TOKEN_USER its required pointer alignment.
    let words = (needed as usize + std::mem::size_of::<usize>() - 1)
        / std::mem::size_of::<usize>();
    let mut buffer = vec![0usize; words];
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
        return Err(std::io::Error::last_os_error()).context("read current process token user");
    }
    let sid = unsafe { (*(buffer.as_ptr().cast::<TOKEN_USER>())).User.Sid };
    if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
        anyhow::bail!("current process token has an invalid user SID");
    }
    Ok(CurrentUserSid {
        _buffer: buffer,
        sid,
    })
}

/// Restrict a file or directory to the account running appliance-vm.
///
/// Security-sensitive callers propagate failures for both files and their
/// containing directories.
#[cfg(unix)]
pub fn restrict_to_current_user(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let mode = if path.is_dir() { 0o700 } else { 0o600 };
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .with_context(|| format!("restrict {} to the current user", path.display()))
}

#[cfg(windows)]
pub fn restrict_to_current_user(path: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;

    let current_user = current_user_sid()?;
    let current_user_text = current_user.to_string()?;
    let inheritance = if path.is_dir() { "OICI" } else { "" };
    // Protected DACL with exactly the three principals accepted by the
    // credential-integrity verifier. SYSTEM and Administrators are retained
    // because either can take ownership regardless of a file's DACL.
    let sddl = format!(
        "D:P(A;{inheritance};FA;;;{current_user_text})(A;{inheritance};FA;;;SY)(A;{inheritance};FA;;;BA)"
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
        return Err(std::io::Error::last_os_error())
            .with_context(|| format!("build protected DACL for {}", path.display()));
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
        return Err(std::io::Error::last_os_error())
            .with_context(|| format!("read protected DACL for {}", path.display()));
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
            current_user.as_psid(),
            std::ptr::null_mut(),
            dacl,
            std::ptr::null_mut(),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(std::io::Error::from_raw_os_error(status as i32))
            .with_context(|| format!("restrict {} to trusted Windows principals", path.display()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "appliance-vm-fs-acl-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[cfg(unix)]
    #[test]
    fn restricts_files_to_0600_and_directories_to_0700() {
        use std::os::unix::fs::PermissionsExt;

        let dir = test_path("unix");
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("secret");
        std::fs::write(&file, b"secret").unwrap();

        restrict_to_current_user(&dir).unwrap();
        restrict_to_current_user(&file).unwrap();

        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn restricts_windows_acl_to_the_current_user() {
        use std::os::windows::process::CommandExt;

        let file = test_path("windows");
        std::fs::write(&file, b"secret").unwrap();
        let status = std::process::Command::new("icacls")
            .arg(&file)
            .args(["/grant", "*S-1-1-0:(W)"])
            .creation_flags(0x0800_0000)
            .status()
            .unwrap();
        assert!(status.success(), "failed to add the untrusted test ACE");
        restrict_to_current_user(&file).unwrap();

        let output = std::process::Command::new("icacls")
            .arg(&file)
            .creation_flags(0x0800_0000)
            .output()
            .unwrap();
        assert!(output.status.success());
        let listing = String::from_utf8_lossy(&output.stdout);
        let principal = String::from_utf8_lossy(
            &std::process::Command::new("whoami")
                .creation_flags(0x0800_0000)
                .output()
                .unwrap()
                .stdout,
        )
        .trim()
        .to_string();
        let path_text = file.to_string_lossy();
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
        let expected = std::collections::BTreeSet::from([
            principal.to_ascii_lowercase(),
            "nt authority\\system".to_string(),
            "builtin\\administrators".to_string(),
        ]);
        assert_eq!(actual, expected, "unexpected ACL listing:\n{listing}");
        std::fs::remove_file(file).unwrap();
    }
}
