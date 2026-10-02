//! Same exclusive-create lockfile protocol as CLI profiles-lock.ts.
use crate::SHARED_PROFILES_DIR;
use std::{
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

pub struct ProfilesLock {
    path: PathBuf,
    file: Option<File>,
}

impl ProfilesLock {
    pub fn acquire(home: &Path) -> io::Result<Self> {
        Self::acquire_until(home, Duration::from_secs(20))
    }

    fn acquire_until(home: &Path, timeout: Duration) -> io::Result<Self> {
        let directory = home.join(SHARED_PROFILES_DIR);
        fs::create_dir_all(&directory)?;
        let path = directory.join("profiles.json.lock");
        let deadline = Instant::now() + timeout;
        loop {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match options.open(&path) {
                Ok(file) => {
                    return Ok(Self {
                        path,
                        file: Some(file),
                    })
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    if Instant::now() >= deadline {
                        return Err(io::Error::new(io::ErrorKind::WouldBlock,
                            "Profile credentials are busy; retry. If no Appliance process is running, remove ~/.appliance/profiles.json.lock."));
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(error) => return Err(error),
            }
        }
    }
}

impl Drop for ProfilesLock {
    fn drop(&mut self) {
        // Windows needs the handle closed before unlinking.
        drop(self.file.take());
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gc_respects_cli_lock_and_rereads_after_acquisition() {
        let home = std::env::temp_dir().join(format!("gc-lock-{}", std::process::id()));
        let directory = home.join(SHARED_PROFILES_DIR);
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("profiles.json.lock");
        // Model a CLI writer holding its wx lock while replacing the profile.
        let cli = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        assert!(ProfilesLock::acquire_until(&home, Duration::ZERO).is_err());
        assert!(path.exists()); // No stealing or stale-lock deletion.
        fs::write(directory.join("profiles.json"), "new CLI profile").unwrap();
        drop(cli);
        fs::remove_file(&path).unwrap();
        {
            let _guard = ProfilesLock::acquire(&home).unwrap();
            assert_eq!(
                fs::read_to_string(directory.join("profiles.json")).unwrap(),
                "new CLI profile"
            );
            assert!(ProfilesLock::acquire_until(&home, Duration::ZERO).is_err());
        }
        assert!(!path.exists());
        fs::remove_dir_all(home).unwrap();
    }
}
