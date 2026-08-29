//! Pure `.wslconfig` parsing shared by the Windows backend and tests on
//! every host. WSL accepts an INI-shaped file; only the `[wsl2]`
//! `networkingMode` key matters to the managed-VM backend.

use std::path::PathBuf;

pub const MIRRORED_NETWORKING_REMEDIATION: &str =
    "Set `networkingMode=NAT` under `[wsl2]` in `%USERPROFILE%\\.wslconfig` \
     (or remove the setting), run `wsl --shutdown`, then retry.";

/// Whether a `.wslconfig` selects unsupported mirrored networking.
/// Section/key/value matching is case-insensitive, surrounding whitespace
/// is ignored, and the last `networkingMode` assignment wins like WSL's
/// own configuration parser.
pub fn uses_mirrored_networking(text: &str) -> bool {
    let mut in_wsl2 = false;
    let mut mode: Option<&str> = None;

    for raw in text.lines() {
        let line = raw.trim().trim_start_matches('\u{feff}');
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            in_wsl2 = line[1..line.len() - 1].trim().eq_ignore_ascii_case("wsl2");
            continue;
        }
        if !in_wsl2 {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case("networkingMode") {
            mode = Some(value.split(['#', ';']).next().unwrap_or_default().trim());
        }
    }

    mode.is_some_and(|value| value.eq_ignore_ascii_case("mirrored"))
}

/// Decode Windows tool/editor output at the byte-reading boundary. WSL's own
/// output may be BOM-less UTF-16LE; Notepad and PowerShell 5.1 use `FF FE`.
/// After checking the BOM, probe the first 64 bytes for a NUL in the high byte
/// of an ASCII UTF-16LE code unit (byte positions 2, 4, 6, ...).
// Keep `chunks_exact` until the workspace MSRV reaches Rust 1.88 (`slice::as_chunks`).
#[allow(unknown_lints, clippy::chunks_exact_to_as_chunks)]
pub(crate) fn decode_wsl(bytes: &[u8]) -> String {
    let has_bom = bytes.starts_with(&[0xff, 0xfe]);
    let has_utf16_nul = bytes
        .iter()
        .take(64)
        .skip(1)
        .step_by(2)
        .any(|&byte| byte == 0);
    if has_bom || has_utf16_nul {
        let payload = if has_bom { &bytes[2..] } else { bytes };
        let units: Vec<u16> = payload
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

pub(crate) const VIRTUALIZATION_REMEDIATION: &str =
    "Enable virtualization in your BIOS/UEFI (often called \"Intel VT-x\", \"AMD-V\", or \"SVM\"), then enable the Windows feature: open PowerShell as Administrator, run `Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform`, and reboot.";
pub(crate) const KERNEL_REMEDIATION: &str =
    "Update WSL: open PowerShell and run `wsl --update`, then retry.";
pub(crate) const NOT_INSTALLED_REMEDIATION: &str =
    "Open PowerShell as Administrator, run `wsl --install`, reboot, then re-run `appliance init`.";

const WSL_FAILURE_SIGNATURES: &[(&[&str], &str, &str)] = &[
    (
        &[
            "0x80370102",
            "0x80370114",
            "virtual machine platform",
            "hypervisor",
            "virtualization",
            "hcs",
        ],
        "virtualization-disabled",
        VIRTUALIZATION_REMEDIATION,
    ),
    (
        &["wsl --update", "kernel", "0x800701bc"],
        "kernel-outdated",
        KERNEL_REMEDIATION,
    ),
    (
        &[
            "wsl --install",
            "not installed",
            "no installed distributions",
        ],
        "not-installed",
        NOT_INSTALLED_REMEDIATION,
    ),
    (
        &["mirrored networking", "networkingmode=mirrored"],
        "mirrored-networking",
        MIRRORED_NETWORKING_REMEDIATION,
    ),
];

/// Return the stable failure key and its actionable remediation.
pub(crate) fn classify_wsl_failure(text: &str) -> Option<(&'static str, &'static str)> {
    let lower = text.to_lowercase();
    WSL_FAILURE_SIGNATURES
        .iter()
        .find(|(signatures, _, _)| signatures.iter().any(|signature| lower.contains(signature)))
        .map(|(_, key, remediation)| (*key, *remediation))
}

/// Read the current Windows user's config. Missing/unreadable config means
/// WSL's default NAT networking and is therefore supported.
pub fn current_uses_mirrored_networking() -> bool {
    let Some(home) = std::env::var_os("USERPROFILE") else {
        return false;
    };
    std::fs::read(PathBuf::from(home).join(".wslconfig"))
        .is_ok_and(|bytes| uses_mirrored_networking(&decode_wsl(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output_fixtures() -> serde_json::Value {
        serde_json::from_str(include_str!("../tests/fixtures/wsl-output/expected.json"))
            .expect("valid WSL output fixture manifest")
    }

    fn fixture_bytes(name: &str) -> Vec<u8> {
        std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/wsl-output")
                .join(name),
        )
        .expect("read WSL output fixture")
    }

    #[test]
    fn detects_mirrored_mode_from_fixture() {
        for fixture in [
            include_bytes!("../tests/fixtures/wslconfig-mirrored.ini").as_slice(),
            include_bytes!("../tests/fixtures/wslconfig-mirrored-utf16le.ini").as_slice(),
        ] {
            assert!(uses_mirrored_networking(&decode_wsl(fixture)));
        }
    }

    #[test]
    fn ignores_comments_other_sections_and_overridden_values() {
        assert!(!uses_mirrored_networking(
            "networkingMode=mirrored\n[experimental]\nnetworkingMode=mirrored\n"
        ));
        assert!(!uses_mirrored_networking(
            "[wsl2]\n# networkingMode=mirrored\nnetworkingMode=mirrored\nnetworkingMode = NAT ; final\n"
        ));
        assert!(uses_mirrored_networking(
            "\u{feff}[WSL2]\nNetworkingMode = MIRRORED # unsupported\n"
        ));
    }

    #[test]
    fn decodes_every_shared_wsl_output_fixture() {
        for fixture in output_fixtures()["fixtures"].as_array().unwrap() {
            let file = fixture["file"].as_str().unwrap();
            assert_eq!(decode_wsl(&fixture_bytes(file)), fixture["decoded"]);
        }
    }

    #[test]
    fn classifies_shared_wsl_output_fixtures_and_signatures() {
        let manifest = output_fixtures();
        for fixture in manifest["fixtures"].as_array().unwrap() {
            let decoded = decode_wsl(&fixture_bytes(fixture["file"].as_str().unwrap()));
            let (key, _) = classify_wsl_failure(&decoded).expect("classified fixture");
            assert_eq!(key, fixture["classification"]);
        }
        for rule in manifest["classifications"].as_array().unwrap() {
            let expected_key = rule["key"].as_str().unwrap();
            let expected_remediation = rule["remediation"].as_str().unwrap();
            for signature in rule["signatures"].as_array().unwrap() {
                let (key, remediation) = classify_wsl_failure(signature.as_str().unwrap())
                    .expect("classified signature");
                assert_eq!(key, expected_key);
                assert_eq!(remediation, expected_remediation);
            }
        }
    }
}
