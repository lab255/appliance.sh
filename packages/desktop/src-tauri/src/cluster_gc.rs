//! VM existence comes from the engine registry, never a network probe or PID.
use std::{fs, io, path::Path};

pub fn is_gone(home: &Path, id: &str) -> io::Result<bool> {
    let name = if id == "microvm" {
        "appliance"
    } else if let Some(name) = id.strip_prefix("microvm-") {
        name
    } else {
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
            home.join(".appliance")
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
        assert!(is_gone(&home, "microvm").unwrap());
        assert!(is_gone(&home, "microvm-test").unwrap());
        assert!(!is_gone(&home, "cloud").unwrap());
    }

    #[test]
    fn gc_keeps_stopped_and_legacy_vms() {
        let home = std::env::temp_dir().join(format!("gc-present-{}", std::process::id()));
        for root in ["vm", "vmm"] {
            let dir = home.join(".appliance").join(root).join("test");
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("vm.json"), "{}").unwrap();
            assert!(!is_gone(&home, "microvm-test").unwrap());
            fs::remove_dir_all(home.join(".appliance").join(root)).unwrap();
        }
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn gc_unknown_registry_is_error_not_deletion() {
        assert!(is_gone(Path::new("/unused"), "microvm-../other").is_err());
    }
}
