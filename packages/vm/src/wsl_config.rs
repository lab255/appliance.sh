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
pub(crate) fn decode_wsl(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.iter().take(64).any(|&b| b == 0) {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
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
}
