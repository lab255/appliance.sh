//! VM existence comes from the engine registry, never a network probe or PID.
use std::{fs, io, path::Path};

use crate::{MICROVM_NAME, SHARED_PROFILES_DIR};
use std::collections::{BTreeMap, HashSet};

fn vm_name<'a>(id: &'a str, api_url: &str) -> Option<&'a str> {
    if id == "local" {
        let url = tauri::Url::parse(api_url).ok()?;
        let host = url.host_str()?;
        let loopback = host == "localhost"
            || host.ends_with(".localhost")
            || host == "[::1]"
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback());
        return (loopback && matches!(url.scheme(), "http" | "https")).then_some(MICROVM_NAME);
    }
    if id == "microvm" {
        Some(MICROVM_NAME)
    } else {
        id.strip_prefix("microvm-")
    }
}

/// Default bring-up dual-writes local + microvm. Include absent aliases so
/// orphaned keychain entries are deleted too, while preserving a remote local.
pub fn add_default_aliases(profiles: &mut BTreeMap<String, String>) {
    let url = profiles
        .iter()
        .find(|(id, url)| vm_name(id, url) == Some(MICROVM_NAME))
        .map(|(_, url)| url.clone());
    if let Some(url) = url {
        profiles
            .entry("local".into())
            .or_insert_with(|| url.clone());
        profiles.entry("microvm".into()).or_insert(url);
    }
}

#[derive(Default)]
pub struct GcDecisions {
    pub gone: HashSet<String>,
    pub unavailable: HashSet<String>,
}

pub fn classify_profiles(home: &Path, profiles: &BTreeMap<String, String>) -> GcDecisions {
    let mut decisions = GcDecisions::default();
    for (id, url) in profiles {
        match is_gone(home, id, url) {
            Ok(true) => {
                decisions.gone.insert(id.clone());
            }
            Ok(false) => {}
            Err(error) => {
                eprintln!("warn: cannot check VM for cluster {id}: {error}; keeping record without credentials");
                decisions.unavailable.insert(id.clone());
            }
        }
    }
    decisions
}

pub fn is_gone(home: &Path, id: &str, api_url: &str) -> io::Result<bool> {
    let Some(name) = vm_name(id, api_url) else {
        return Ok(false);
    };
    if name.is_empty() || name.contains(['/', '\\']) || name == "." || name == ".." {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid VM name",
        ));
    }
    // The engine migrates vmm -> vm on first use. Preserve either registry.
    for root in ["vm", "vmm"] {
        match fs::metadata(
            home.join(SHARED_PROFILES_DIR)
                .join(root)
                .join(name)
                .join("vm.json"),
        ) {
            Ok(_) => return Ok(false),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e), // Unknown existence: withhold credentials, don't delete.
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gc_missing_vm_but_not_remote_cluster() {
        let home = std::env::temp_dir().join(format!("gc-absent-{}", std::process::id()));
        assert!(is_gone(&home, "microvm", "http://api.appliance.localhost:8081").unwrap());
        assert!(is_gone(&home, "microvm-test", "http://api.appliance.localhost:8081").unwrap());
        assert!(!is_gone(&home, "cloud", "http://api.appliance.localhost:8081").unwrap());
    }

    #[test]
    fn gc_default_alias_is_loopback_only() {
        let home = std::env::temp_dir().join(format!("gc-local-{}", std::process::id()));
        for url in [
            "http://api.appliance.localhost:8081",
            "http://127.0.0.2",
            "http://[::1]",
        ] {
            assert!(is_gone(&home, "local", url).unwrap());
        }
        for url in [
            "https://example.com",
            "https://localhost.example.com",
            "invalid",
        ] {
            assert!(!is_gone(&home, "local", url).unwrap());
        }
        let mut profiles = BTreeMap::from([("microvm".into(), "http://localhost:8081".into())]);
        add_default_aliases(&mut profiles);
        assert!(profiles.contains_key("local"));
        profiles.insert("local".into(), "https://example.com".into());
        add_default_aliases(&mut profiles);
        assert_eq!(profiles["local"], "https://example.com");
    }

    #[test]
    fn gc_registry_error_does_not_hide_remote_clusters() {
        let home = std::env::temp_dir().join(format!("gc-partial-{}", std::process::id()));
        let profiles = BTreeMap::from([
            ("microvm-invalid/name".into(), "http://localhost".into()),
            ("microvm-gone".into(), "http://localhost".into()),
            ("local".into(), "https://remote.example".into()),
        ]);
        let decisions = classify_profiles(&home, &profiles);
        assert_eq!(decisions.gone, HashSet::from(["microvm-gone".into()]));
        assert_eq!(
            decisions.unavailable,
            HashSet::from(["microvm-invalid/name".into()])
        );
    }

    #[test]
    fn gc_keeps_stopped_and_legacy_vms() {
        let home = std::env::temp_dir().join(format!("gc-present-{}", std::process::id()));
        for root in ["vm", "vmm"] {
            let dir = home.join(SHARED_PROFILES_DIR).join(root).join("test");
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("vm.json"), "{}").unwrap();
            assert!(
                !is_gone(&home, "microvm-test", "http://api.appliance.localhost:8081").unwrap()
            );
            fs::remove_dir_all(home.join(SHARED_PROFILES_DIR).join(root)).unwrap();
        }
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn gc_unknown_registry_is_error_not_deletion() {
        assert!(is_gone(
            Path::new("/unused"),
            "microvm-../other",
            "http://api.appliance.localhost:8081"
        )
        .is_err());
        let home = std::env::temp_dir().join(format!("gc-error-{}", std::process::id()));
        fs::create_dir_all(home.join(SHARED_PROFILES_DIR)).unwrap();
        fs::write(home.join(SHARED_PROFILES_DIR).join("vm"), "not a directory").unwrap();
        assert!(is_gone(&home, "microvm-test", "http://api.appliance.localhost:8081").is_err());
        fs::remove_dir_all(home).unwrap();
    }
}
