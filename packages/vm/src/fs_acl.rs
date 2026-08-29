use anyhow::{Context, Result};
use std::path::Path;

#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
#[cfg(windows)]
use windows_sys::Win32::Security::{
    GetTokenInformation, IsValidSid, PSID, TOKEN_QUERY, TOKEN_USER, TokenUser,
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
    use anyhow::{anyhow, bail};
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
        .map_err(|error| anyhow!("run icacls for {}: {error}", path.display()))?;
    if !output.status.success() {
        bail!(
            "restrict {} to {principal}: {}",
            path.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
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
        restrict_to_current_user(&file).unwrap();

        let output = std::process::Command::new("icacls")
            .arg(&file)
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
        .to_string();
        assert_eq!(acl_lines.len(), 1, "unexpected ACL listing:\n{listing}");
        assert!(
            acl_lines[0]
                .to_ascii_lowercase()
                .contains(&principal.to_ascii_lowercase()),
            "current principal missing from ACL listing:\n{listing}"
        );
        std::fs::remove_file(file).unwrap();
    }
}
