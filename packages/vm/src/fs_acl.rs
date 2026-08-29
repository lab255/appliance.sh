use anyhow::{Context, Result};
use std::path::Path;

/// Restrict a file or directory to the account running appliance-vm.
///
/// Callers decide the failure policy: secret-file writes propagate this error,
/// while directory creation logs a warning and continues.
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

    let username = std::env::var("USERNAME").context("USERNAME is unavailable")?;
    let principal = std::env::var("USERDOMAIN")
        .ok()
        .filter(|domain| !domain.is_empty() && domain != ".")
        .map(|domain| format!(r"{domain}\{username}"))
        .unwrap_or(username);
    let output = std::process::Command::new("icacls")
        .arg(path)
        .args(["/inheritance:r", "/grant:r", &format!("{principal}:F")])
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
        let username = std::env::var("USERNAME").unwrap();
        let principal = std::env::var("USERDOMAIN")
            .ok()
            .filter(|domain| !domain.is_empty() && domain != ".")
            .map(|domain| format!(r"{domain}\{username}"))
            .unwrap_or(username);
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
