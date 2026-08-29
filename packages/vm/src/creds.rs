//! Credential capture + injection for intercepted egress.
//!
//! With TLS interception on, the proxy sees decrypted request headers.
//! Per host, the operator can opt into:
//!   * capture — when a workload sends a credential header, lift it
//!     into a host-side secret store (outside the VM) so it isn't only
//!     living inside the guest, and
//!   * inject — add/replace that header on outbound requests to the
//!     host, sourcing the value from the stored secret or from an
//!     `apiKeyHelper` command (Claude-Code style) the host configures.
//!
//! Config + secrets live under the VM state dir on the host. Secret and
//! rule files are restricted to the host user, and rules fail closed when
//! their host-side ownership or permissions do not satisfy the trust check.
//! This check is effective against OTHER principals only; it does NOT close a
//! same-user guest write through WSL drvfs (tracked by the automount card).

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{bail, Context};
use appliance_credential_store::{
    encode_identifier, AclFileStore, CredentialStore, StoreKey, VmBrokerFile,
};
use serde::{Deserialize, Serialize};

use crate::egress::host_matches;
use crate::spec::VmPaths;

fn default_header() -> String {
    "authorization".to_string()
}

#[derive(Serialize, Deserialize, Clone, Debug, Eq, Hash, PartialEq)]
#[serde(untagged)]
pub enum CredentialHelper {
    /// Preferred, cross-platform form. The first element is the executable and
    /// every remaining element is passed as one literal argument.
    Argv(Vec<String>),
    /// Compatibility for rules persisted before argv helpers. Never accepted
    /// on Windows because appliance-vm intentionally has no shell dependency.
    LegacyShell(String),
}

impl CredentialHelper {
    pub fn legacy(value: impl Into<String>) -> Self {
        Self::LegacyShell(value.into())
    }

    /// Parse the single `--helper` CLI value. New callers pass a JSON array;
    /// everything else remains a legacy shell command for persisted/manual
    /// compatibility on Unix.
    pub fn from_cli_arg(raw: String) -> anyhow::Result<Self> {
        if raw.trim_start().starts_with('[') {
            let argv: Vec<String> =
                serde_json::from_str(&raw).context("parse --helper argv JSON")?;
            if argv.is_empty() || argv.iter().any(String::is_empty) {
                bail!("credential helper argv must contain a non-empty executable and arguments");
            }
            Ok(Self::Argv(argv))
        } else {
            Ok(Self::legacy(raw))
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CredentialRule {
    /// Host suffix this rule applies to (e.g. `api.openai.com`).
    pub host: String,
    /// Lift the credential header off requests into the secret store.
    #[serde(default)]
    pub capture: bool,
    /// Add/replace the credential header on outbound requests.
    #[serde(default)]
    pub inject: bool,
    /// Header to capture/inject (lowercased; default `authorization`).
    #[serde(default = "default_header")]
    pub header: String,
    /// Optional helper whose stdout is the credential to inject (overrides the
    /// stored secret). New rules use an argv array; legacy strings run through
    /// `sh -c` on Unix only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper: Option<CredentialHelper>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CredentialConfig {
    #[serde(default)]
    pub rules: Vec<CredentialRule>,
}

fn config_path(name: &str) -> PathBuf {
    credential_path(name, VmBrokerFile::Credentials)
}

#[cfg(test)]
fn credential_store_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "appliance-vm-credential-tests-{}",
        std::process::id()
    ))
}

fn credential_vm_dir(name: &str) -> PathBuf {
    #[cfg(not(test))]
    {
        VmPaths::for_name(name).dir
    }
    #[cfg(test)]
    {
        credential_store_root().join(name)
    }
}

fn credential_store(name: &str) -> AclFileStore {
    AclFileStore::for_vm_dir(credential_vm_dir(name))
}

fn credential_key(name: &str, file: VmBrokerFile) -> anyhow::Result<StoreKey> {
    StoreKey::vm_broker(encode_identifier(name), file).map_err(Into::into)
}

fn credential_path(name: &str, file: VmBrokerFile) -> PathBuf {
    credential_vm_dir(name).join(file.file_name())
}

pub fn load_config(name: &str) -> CredentialConfig {
    let path = config_path(name);
    let Some(raw) = read_verified_broker_file(&path) else {
        return CredentialConfig::default();
    };
    parse_config(&path, &raw)
}

/// Open once, verify that exact handle, then read from it. Keeping the
/// integrity check and read on one `File` closes the rename/swap window that
/// exists when a store read and a later verification open are separate.
fn read_verified_broker_file(path: &Path) -> Option<Vec<u8>> {
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            eprintln!(
                "egress creds: ignoring unreadable {}: {error}",
                path.display()
            );
            return None;
        }
    };
    if verify_config_integrity(path, &file).is_err() {
        // Deliberately omit the principal, ACL, and file contents. This log
        // can be surfaced to untrusted workloads and must remain secret-free.
        eprintln!("egress creds: refusing credential config with unsafe ownership or permissions");
        return None;
    }
    let mut raw = Vec::new();
    if let Err(error) = file.read_to_end(&mut raw) {
        eprintln!(
            "egress creds: ignoring unreadable {}: {error}",
            path.display()
        );
        return None;
    }
    Some(raw)
}

#[cfg(test)]
fn load_config_path(path: &Path) -> CredentialConfig {
    read_verified_broker_file(path)
        .map(|raw| parse_config(path, &raw))
        .unwrap_or_default()
}

fn parse_config(path: &Path, raw: &[u8]) -> CredentialConfig {
    match serde_json::from_slice(raw) {
        Ok(config) => config,
        Err(error) => {
            eprintln!(
                "egress creds: ignoring unreadable {}: {error}",
                path.display()
            );
            CredentialConfig::default()
        }
    }
}

pub fn save_config(name: &str, cfg: &CredentialConfig) -> anyhow::Result<()> {
    let path = config_path(name);
    let store = credential_store(name);
    let key = credential_key(name, VmBrokerFile::Credentials)?;
    store.put(&key, serde_json::to_string_pretty(cfg)?.as_bytes())?;
    let integrity = std::fs::File::open(&path)
        .map_err(Into::into)
        .and_then(|file| verify_config_integrity(&path, &file));
    if let Err(error) = integrity {
        let _ = store.delete(&key);
        return Err(error);
    }
    Ok(())
}

#[cfg(unix)]
pub(crate) fn verify_config_integrity(path: &Path, file: &std::fs::File) -> anyhow::Result<()> {
    use std::os::unix::fs::MetadataExt;

    let uid = unsafe { libc::geteuid() };
    let file_metadata = file.metadata()?;
    let path_metadata = std::fs::symlink_metadata(path)?;
    let parent = path
        .parent()
        .context("credential config has no parent directory")?;
    let parent_metadata = std::fs::symlink_metadata(parent)?;
    if path_metadata.file_type().is_symlink()
        || parent_metadata.file_type().is_symlink()
        || !file_metadata.is_file()
        || !parent_metadata.is_dir()
        || file_metadata.uid() != uid
        || parent_metadata.uid() != uid
        || file_metadata.mode() & 0o022 != 0
        || parent_metadata.mode() & 0o022 != 0
    {
        bail!("unsafe credential config ownership or permissions");
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn verify_config_integrity(path: &Path, file: &std::fs::File) -> anyhow::Result<()> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;

    let parent = path
        .parent()
        .context("credential config has no parent directory")?;
    let parent_file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(parent)
        .with_context(|| format!("open credential config parent {}", parent.display()))?;
    windows_config_integrity::verify(&parent_file)?;
    windows_config_integrity::verify(file)
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn verify_config_integrity(_path: &Path, _file: &std::fs::File) -> anyhow::Result<()> {
    bail!("credential config integrity checks are unsupported on this platform")
}

#[cfg(windows)]
mod windows_config_integrity {
    use super::*;
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::{
        LocalFree, ERROR_SUCCESS, GENERIC_ALL, GENERIC_WRITE, HANDLE,
    };
    use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{
        CreateWellKnownSid, EqualSid, GetAce, GetLengthSid, IsValidAcl, IsValidSid,
        WinBuiltinAdministratorsSid, WinLocalSystemSid, ACE_INHERITED_OBJECT_TYPE_PRESENT,
        ACE_OBJECT_TYPE_PRESENT, ACL, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
        PSECURITY_DESCRIPTOR, PSID, SECURITY_MAX_SID_SIZE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_APPEND_DATA, FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA, FILE_WRITE_EA, WRITE_DAC,
        WRITE_OWNER,
    };
    use windows_sys::Win32::System::SystemServices::{
        ACCESS_ALLOWED_ACE_TYPE, ACCESS_ALLOWED_CALLBACK_ACE_TYPE,
        ACCESS_ALLOWED_CALLBACK_OBJECT_ACE_TYPE, ACCESS_ALLOWED_COMPOUND_ACE_TYPE,
        ACCESS_ALLOWED_OBJECT_ACE_TYPE,
    };

    struct LocalSecurityDescriptor(PSECURITY_DESCRIPTOR);
    impl Drop for LocalSecurityDescriptor {
        fn drop(&mut self) {
            unsafe {
                let _ = LocalFree(self.0);
            }
        }
    }

    fn last_os_error(context: &'static str) -> anyhow::Error {
        anyhow::anyhow!("{context}: {}", std::io::Error::last_os_error())
    }

    fn well_known_sid(kind: i32) -> anyhow::Result<Vec<u8>> {
        let mut buffer = vec![0u8; SECURITY_MAX_SID_SIZE as usize];
        let mut size = buffer.len() as u32;
        if unsafe { CreateWellKnownSid(kind, null_mut(), buffer.as_mut_ptr().cast(), &mut size) }
            == 0
        {
            return Err(last_os_error("create well-known SID"));
        }
        Ok(buffer)
    }

    unsafe fn allowed_ace_sid(
        ace: *const u8,
        ace_size: usize,
        ace_type: u32,
    ) -> anyhow::Result<PSID> {
        let mut offset = 8usize; // ACE_HEADER + ACCESS_MASK
        if ace_type == ACCESS_ALLOWED_OBJECT_ACE_TYPE
            || ace_type == ACCESS_ALLOWED_CALLBACK_OBJECT_ACE_TYPE
        {
            if ace_size < 12 {
                bail!("truncated object ACE");
            }
            let flags = ace.add(8).cast::<u32>().read_unaligned();
            offset = 12;
            if flags & ACE_OBJECT_TYPE_PRESENT != 0 {
                offset += 16;
            }
            if flags & ACE_INHERITED_OBJECT_TYPE_PRESENT != 0 {
                offset += 16;
            }
        }
        if offset >= ace_size {
            bail!("truncated allowed ACE SID");
        }
        let sid = ace.add(offset) as PSID;
        if IsValidSid(sid) == 0 {
            bail!("allowed ACE has an invalid SID");
        }
        if offset + GetLengthSid(sid) as usize > ace_size {
            bail!("allowed ACE SID extends past the ACE");
        }
        Ok(sid)
    }

    /// Inspect the binary security descriptor directly. This deliberately
    /// avoids `icacls` output parsing, whose account names and prose are
    /// localized and therefore unsuitable for a fail-closed trust check.
    pub(super) fn verify(file: &std::fs::File) -> anyhow::Result<()> {
        let mut owner: PSID = null_mut();
        let mut dacl: *mut ACL = null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        let status = unsafe {
            GetSecurityInfo(
                file.as_raw_handle() as HANDLE,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(anyhow::anyhow!(
                "read credential config ACL: {}",
                std::io::Error::from_raw_os_error(status as i32)
            ));
        }
        let _descriptor = LocalSecurityDescriptor(descriptor);
        if owner.is_null() || dacl.is_null() || unsafe { IsValidAcl(dacl) } == 0 {
            bail!("credential config owner or DACL is missing");
        }

        let current_sid = crate::fs_acl::current_user_sid()?;
        if unsafe { EqualSid(owner, current_sid.as_psid()) } == 0 {
            bail!("credential config is not owned by the current user");
        }
        let system = well_known_sid(WinLocalSystemSid)?;
        let administrators = well_known_sid(WinBuiltinAdministratorsSid)?;
        let system_sid = system.as_ptr() as PSID;
        let administrators_sid = administrators.as_ptr() as PSID;
        let write_mask = GENERIC_ALL
            | GENERIC_WRITE
            | FILE_WRITE_DATA
            | FILE_APPEND_DATA
            | FILE_WRITE_EA
            | FILE_WRITE_ATTRIBUTES
            | DELETE
            | WRITE_DAC
            | WRITE_OWNER;

        let ace_count = unsafe { (*dacl).AceCount as u32 };
        for index in 0..ace_count {
            let mut raw_ace: *mut c_void = null_mut();
            if unsafe { GetAce(dacl, index, &mut raw_ace) } == 0 {
                return Err(last_os_error("read credential config ACE"));
            }
            let ace = raw_ace.cast::<u8>();
            let header = unsafe { &*ace.cast::<windows_sys::Win32::Security::ACE_HEADER>() };
            let ace_type = header.AceType as u32;
            let allowed = matches!(
                ace_type,
                ACCESS_ALLOWED_ACE_TYPE
                    | ACCESS_ALLOWED_OBJECT_ACE_TYPE
                    | ACCESS_ALLOWED_CALLBACK_ACE_TYPE
                    | ACCESS_ALLOWED_CALLBACK_OBJECT_ACE_TYPE
                    | ACCESS_ALLOWED_COMPOUND_ACE_TYPE
            );
            if !allowed {
                continue;
            }
            if header.AceSize < 8 {
                bail!("credential config has a truncated allowed ACE");
            }
            let mask = unsafe { ace.add(4).cast::<u32>().read_unaligned() };
            if mask & write_mask == 0 {
                continue;
            }
            // Compound ACEs are obsolete and encode multiple principals;
            // fail closed rather than attempting an incomplete SID parse.
            if ace_type == ACCESS_ALLOWED_COMPOUND_ACE_TYPE {
                bail!("credential config has an unsupported write-granting ACE");
            }
            let sid = unsafe { allowed_ace_sid(ace, header.AceSize as usize, ace_type)? };
            let trusted = unsafe {
                EqualSid(sid, owner) != 0
                    || EqualSid(sid, system_sid) != 0
                    || EqualSid(sid, administrators_sid) != 0
            };
            if !trusted {
                bail!("credential config is writable by an untrusted principal");
            }
        }
        Ok(())
    }
}

/// Add or update (by host) a rule.
pub fn upsert_rule(name: &str, rule: CredentialRule) -> anyhow::Result<()> {
    let mut cfg = load_config(name);
    match cfg.rules.iter_mut().find(|r| r.host == rule.host) {
        Some(existing) => *existing = rule,
        None => cfg.rules.push(rule),
    }
    save_config(name, &cfg)
}

pub fn remove_rule(name: &str, host: &str) -> anyhow::Result<bool> {
    let mut cfg = load_config(name);
    let before = cfg.rules.len();
    cfg.rules.retain(|r| r.host != host);
    let removed = cfg.rules.len() != before;
    save_config(name, &cfg)?;
    Ok(removed)
}

fn first_matching<'a>(
    cfg: &'a CredentialConfig,
    host: &str,
    want: impl Fn(&CredentialRule) -> bool,
) -> Option<&'a CredentialRule> {
    cfg.rules
        .iter()
        .find(|r| want(r) && host_matches(host, &r.host))
}

// --- secret store (host-side, 0600) ---------------------------------

type SecretMap = std::collections::BTreeMap<String, String>;

fn secret_key(host: &str, header: &str) -> String {
    format!(
        "{}\t{}",
        host.to_ascii_lowercase(),
        header.to_ascii_lowercase()
    )
}

fn load_secrets(name: &str) -> SecretMap {
    read_verified_broker_file(&credential_path(name, VmBrokerFile::Secrets))
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default()
}

fn save_secrets(name: &str, map: &SecretMap) -> anyhow::Result<()> {
    let key = credential_key(name, VmBrokerFile::Secrets)?;
    credential_store(name)
        .put(&key, serde_json::to_string_pretty(map)?.as_bytes())
        .map_err(Into::into)
}

pub fn store_secret(name: &str, host: &str, header: &str, value: &str) -> anyhow::Result<()> {
    let mut map = load_secrets(name);
    map.insert(secret_key(host, header), value.to_string());
    save_secrets(name, &map)
}

fn get_secret(name: &str, host: &str, header: &str) -> Option<String> {
    load_secrets(name).get(&secret_key(host, header)).cloned()
}

pub fn forget_secrets(name: &str) {
    if let Ok(key) = credential_key(name, VmBrokerFile::Secrets) {
        let _ = credential_store(name).delete(&key);
    }
}

/// Mask a secret for display: keep a short tail, redact the rest.
fn mask(value: &str) -> String {
    let v = value.trim();
    if v.len() <= 4 {
        return "••••".to_string();
    }
    format!("••••{}", &v[v.len() - 4..])
}

/// A listing of stored secrets (masked) for the desktop/CLI.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSecret {
    pub host: String,
    pub header: String,
    pub masked: String,
}

pub fn list_secrets(name: &str) -> Vec<StoredSecret> {
    load_secrets(name)
        .iter()
        .filter_map(|(k, v)| {
            let (host, header) = k.split_once('\t')?;
            Some(StoredSecret {
                host: host.to_string(),
                header: header.to_string(),
                masked: mask(v),
            })
        })
        .collect()
}

// --- capture + inject (used by the MITM path) -----------------------

/// Pull a header value out of a raw HTTP head (case-insensitive name).
fn header_value(head: &str, name: &str) -> Option<String> {
    head.lines()
        .skip(1)
        .take_while(|l| !l.is_empty())
        .filter_map(|line| line.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case(name))
        .map(|(_, v)| v.trim().to_string())
}

/// If a capture rule matches, lift the credential header off the
/// request into the secret store. Best-effort; returns the header name
/// captured (for logging) when it stored something. Takes an
/// already-loaded config so the interceptor reads it once per request.
pub fn capture_from_head(
    cfg: &CredentialConfig,
    name: &str,
    host: &str,
    head: &str,
) -> Option<String> {
    let rule = first_matching(cfg, host, |r| r.capture)?;
    let value = header_value(head, &rule.header)?;
    if value.is_empty() {
        return None;
    }
    let _ = store_secret(name, host, &rule.header, &value);
    Some(rule.header.clone())
}

/// Does any credential rule (capture or inject) match this host? MITM is
/// scoped to such hosts (`egress.rs`) so the proxy only decrypts the
/// traffic it must broker — every other allowed HTTPS host stays a blind
/// tunnel, preserving keep-alive + streaming. (The interceptor forces
/// one request per CONNECT, which would otherwise break SSE/npm.)
pub fn has_cred_rule(name: &str, host: &str) -> bool {
    let cfg = load_config(name);
    cfg.rules.iter().any(|r| host_matches(host, &r.host))
}

/// The outcome of resolving an inject credential for a host, computed from
/// a SINGLE config load so the proxy's fail-closed decision is atomic —
/// no TOCTOU between "is there an inject rule?" and "can it be resolved?"
/// (the config could change, or be read inconsistently, between two
/// separate loads).
pub enum Injection {
    /// An inject rule matched and resolved to `(header, value)`.
    Resolved(String, String),
    /// An inject rule matched but its credential could not be resolved
    /// (helper failed / key not configured / Keychain locked). The caller
    /// MUST fail closed: never forward the in-guest placeholder upstream.
    RuleButUnresolved,
    /// No inject rule matches this host.
    NoRule,
}

/// Resolve the credential to inject for a host from an already-loaded
/// config: the helper's stdout (preferred) or the stored secret. A single
/// pass classifies the three fail-closed-relevant states (see `Injection`)
/// so the caller never has to re-read the config to disambiguate them.
pub fn resolve_injection(cfg: &CredentialConfig, name: &str, host: &str) -> Injection {
    let Some(rule) = first_matching(cfg, host, |r| r.inject) else {
        return Injection::NoRule;
    };
    let value = match &rule.helper {
        Some(helper) => match run_helper(helper) {
            Ok(v) => Some(v),
            Err(e) => {
                eprintln!("egress mitm: credential helper failed: {e:#}");
                None
            }
        },
        None => get_secret(name, host, &rule.header),
    };
    match value {
        Some(v) if !v.trim().is_empty() => {
            Injection::Resolved(rule.header.clone(), v.trim().to_string())
        }
        _ => Injection::RuleButUnresolved,
    }
}

/// Short TTL for the resolved-helper cache. The brokered key rotates
/// rarely; a few-second cache is invisible to correctness and removes a
/// per-request process spawn of the host helper (`appliance agent print-key`)
/// on streaming/keep-alive traffic where one CONNECT carries
/// many intercepted requests.
///
/// Staleness vs rotation (accepted): after the host key is rotated, a
/// previously-resolved value lingers for at most `HELPER_TTL` before the
/// next fork picks up the new key. The old key simply 401s upstream in
/// that window — no security exposure (the key never leaves the host) —
/// so the 15s window is an accepted trade for not forking per request.
const HELPER_TTL: Duration = Duration::from_secs(15);

/// `helper definition -> (resolved_at, value)`. Process-global so it spans
/// the per-connection threads the proxy spawns. Never logged.
fn helper_cache() -> &'static Mutex<HashMap<CredentialHelper, (Instant, String)>> {
    static CACHE: OnceLock<Mutex<HashMap<CredentialHelper, (Instant, String)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resolve a helper program to an absolute executable. Emitters pin their
/// running appliance executable. Unix also accepts a bare PATH name for the
/// generic credential-rule API; Windows requires an absolute program path.
fn resolve_helper_program(program: &str) -> anyhow::Result<PathBuf> {
    let path = Path::new(program);
    if path.is_absolute() {
        return validate_helper_program(path);
    }

    #[cfg(windows)]
    {
        bail!("credential helper executable must be an absolute path on Windows");
    }

    #[cfg(not(windows))]
    {
        if path.components().count() != 1 {
            bail!("credential helper executable must be absolute or resolvable on PATH");
        }

        let path_var = std::env::var_os("PATH").unwrap_or_default();
        for dir in std::env::split_paths(&path_var) {
            for candidate in helper_program_candidates(&dir, program) {
                if let Ok(valid) = validate_helper_program(&candidate) {
                    return Ok(valid);
                }
            }
        }
        bail!("credential helper executable '{program}' was not found on PATH")
    }
}

#[cfg(not(windows))]
fn helper_program_candidates(dir: &Path, program: &str) -> Vec<PathBuf> {
    vec![dir.join(program)]
}

fn validate_helper_program(path: &Path) -> anyhow::Result<PathBuf> {
    if !path.is_absolute() {
        bail!("credential helper executable must resolve to an absolute path");
    }
    let metadata = std::fs::metadata(path).with_context(|| {
        format!(
            "credential helper executable does not exist: {}",
            path.display()
        )
    })?;
    if !metadata.is_file() {
        bail!(
            "credential helper executable is not a file: {}",
            path.display()
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            bail!(
                "credential helper file is not executable: {}",
                path.display()
            );
        }
    }
    #[cfg(windows)]
    {
        let extension = path
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or_default();
        if !extension.eq_ignore_ascii_case("exe") && !extension.eq_ignore_ascii_case("com") {
            bail!("credential helper executable must be an .exe or .com file on Windows");
        }
    }
    Ok(path.to_path_buf())
}

#[cfg(windows)]
fn hide_helper_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_helper_window(_command: &mut Command) {}

/// Run an apiKeyHelper; stdout (trimmed) is the credential. The result is
/// cached for `HELPER_TTL` keyed on the complete helper definition. The value
/// is a secret — it is never logged here or by callers.
fn run_helper(helper: &CredentialHelper) -> anyhow::Result<String> {
    {
        let cache = helper_cache().lock().unwrap_or_else(|p| p.into_inner());
        if let Some((at, value)) = cache.get(helper) {
            if at.elapsed() < HELPER_TTL {
                return Ok(value.clone());
            }
        }
    }

    let mut command = match helper {
        CredentialHelper::Argv(argv) => {
            let (program, args) = argv
                .split_first()
                .filter(|(program, _)| !program.is_empty())
                .ok_or_else(|| {
                    anyhow::anyhow!("credential helper argv must start with an executable")
                })?;
            let mut command = Command::new(resolve_helper_program(program)?);
            command.args(args);
            command.stdin(std::process::Stdio::null());
            hide_helper_window(&mut command);
            command
        }
        CredentialHelper::LegacyShell(cmd) => {
            #[cfg(windows)]
            {
                let _ = cmd;
                bail!("legacy shell helper is not supported on Windows; re-run `appliance agent login`");
            }
            #[cfg(not(windows))]
            {
                let mut command = Command::new("sh");
                command.args(["-c", cmd]);
                command.stdin(std::process::Stdio::null());
                command
            }
        }
    };
    let out = command.output().context("run credential helper")?;
    if !out.status.success() {
        bail!("credential helper exited with status {}", out.status);
    }
    let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if value.is_empty() {
        bail!("credential helper returned an empty value");
    }
    if value.contains(['\r', '\n']) {
        bail!("credential helper output must be a single line");
    }
    let mut cache = helper_cache().lock().unwrap_or_else(|p| p.into_inner());
    cache.insert(helper.clone(), (Instant::now(), value.clone()));
    Ok(value)
}

/// Rewrite an HTTP head to set `header: value`, replacing any existing
/// occurrence (case-insensitive) and preserving the rest verbatim.
pub fn set_header(head: &str, header: &str, value: &str) -> String {
    let mut out = String::with_capacity(head.len() + header.len() + value.len() + 4);
    let mut lines = head.split("\r\n");
    if let Some(request_line) = lines.next() {
        out.push_str(request_line);
        out.push_str("\r\n");
    }
    for line in lines {
        if line.is_empty() {
            break;
        }
        let is_target = line
            .split_once(':')
            .map(|(k, _)| k.trim().eq_ignore_ascii_case(header))
            .unwrap_or(false);
        if is_target {
            continue; // drop; we re-add canonically below
        }
        out.push_str(line);
        out.push_str("\r\n");
    }
    out.push_str(header);
    out.push_str(": ");
    out.push_str(value);
    out.push_str("\r\n\r\n");
    out
}

#[cfg(test)]
pub(crate) fn resolving_test_helper() -> CredentialHelper {
    #[cfg(windows)]
    {
        let cmd = PathBuf::from(
            std::env::var_os("SystemRoot")
                .unwrap_or_else(|| std::ffi::OsString::from(r"C:\Windows")),
        )
        .join("System32")
        .join("cmd.exe");
        CredentialHelper::Argv(vec![
            cmd.to_string_lossy().into_owned(),
            "/D".into(),
            "/C".into(),
            "echo".into(),
            "real-key".into(),
        ])
    }
    #[cfg(not(windows))]
    {
        CredentialHelper::legacy("printf real-key")
    }
}

#[cfg(test)]
fn failing_test_helper() -> CredentialHelper {
    #[cfg(windows)]
    {
        let cmd = PathBuf::from(
            std::env::var_os("SystemRoot")
                .unwrap_or_else(|| std::ffi::OsString::from(r"C:\Windows")),
        )
        .join("System32")
        .join("cmd.exe");
        CredentialHelper::Argv(vec![
            cmd.to_string_lossy().into_owned(),
            "/D".into(),
            "/C".into(),
            "exit".into(),
            "7".into(),
        ])
    }
    #[cfg(not(windows))]
    {
        CredentialHelper::legacy("exit 7")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn integrity_test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "appliance-credential-integrity-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn integrity_test_config() -> CredentialConfig {
        CredentialConfig {
            rules: vec![CredentialRule {
                host: "safe.example".into(),
                capture: false,
                inject: true,
                header: "authorization".into(),
                helper: None,
            }],
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_config_integrity_accepts_private_and_refuses_world_writable_file() {
        use std::os::unix::fs::PermissionsExt;

        let dir = integrity_test_path("unix");
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("egress-credentials.json");
        std::fs::write(&file, serde_json::to_vec(&integrity_test_config()).unwrap()).unwrap();
        crate::fs_acl::restrict_to_current_user(&dir).unwrap();
        crate::fs_acl::restrict_to_current_user(&file).unwrap();
        assert_eq!(load_config_path(&file).rules.len(), 1);

        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o666)).unwrap();
        assert!(load_config_path(&file).rules.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn unix_config_integrity_refuses_world_writable_parent() {
        use std::os::unix::fs::PermissionsExt;

        let dir = integrity_test_path("unix-bad-parent");
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("egress-credentials.json");
        std::fs::write(&file, serde_json::to_vec(&integrity_test_config()).unwrap()).unwrap();
        crate::fs_acl::restrict_to_current_user(&file).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).unwrap();

        assert!(load_config_path(&file).rules.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn verified_reader_refuses_unsafe_secret_file_before_parsing() {
        use std::os::unix::fs::PermissionsExt;

        let dir = integrity_test_path("unix-secret");
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("egress-secrets.json");
        std::fs::write(&file, br#"{"api.test\tauthorization":"Bearer secret"}"#).unwrap();
        crate::fs_acl::restrict_to_current_user(&dir).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o666)).unwrap();

        assert!(read_verified_broker_file(&file).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_config_integrity_accepts_private_and_refuses_untrusted_write_ace() {
        use std::os::windows::process::CommandExt;

        let dir = integrity_test_path("windows");
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("egress-credentials.json");
        std::fs::write(&file, serde_json::to_vec(&integrity_test_config()).unwrap()).unwrap();
        crate::fs_acl::restrict_to_current_user(&dir).unwrap();
        crate::fs_acl::restrict_to_current_user(&file).unwrap();
        assert_eq!(load_config_path(&file).rules.len(), 1);

        let status = Command::new("icacls")
            .arg(&file)
            .args(["/grant", "*S-1-1-0:(W)"])
            .creation_flags(0x0800_0000)
            .status()
            .unwrap();
        assert!(status.success());
        assert!(load_config_path(&file).rules.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn set_header_replaces_existing() {
        let head = "GET / HTTP/1.1\r\nHost: x\r\nAuthorization: old\r\nAccept: */*\r\n\r\n";
        let out = set_header(head, "authorization", "Bearer new");
        assert_eq!(out.matches("uthorization").count(), 1);
        assert!(out.contains("authorization: Bearer new\r\n"));
        assert!(!out.contains("old"));
        assert!(out.contains("Host: x\r\n"));
        assert!(out.ends_with("\r\n\r\n"));
    }

    #[test]
    fn set_header_adds_when_absent() {
        let head = "GET / HTTP/1.1\r\nHost: x\r\n\r\n";
        let out = set_header(head, "x-api-key", "k123");
        assert!(out.contains("x-api-key: k123\r\n"));
    }

    #[test]
    fn header_value_is_case_insensitive() {
        let head = "POST / HTTP/1.1\r\nHost: x\r\nAuthorization:  Bearer abc \r\n\r\n";
        assert_eq!(
            header_value(head, "authorization").as_deref(),
            Some("Bearer abc")
        );
        assert_eq!(header_value(head, "missing"), None);
    }

    #[test]
    fn capture_and_inject_round_trip() {
        let name = "creds-test-rt";
        forget_secrets(name);
        let _ = std::fs::create_dir_all(VmPaths::for_name(name).dir);
        upsert_rule(
            name,
            CredentialRule {
                host: "api.example.com".into(),
                capture: true,
                inject: true,
                header: "authorization".into(),
                helper: None,
            },
        )
        .unwrap();
        let head = "POST /v1 HTTP/1.1\r\nHost: api.example.com\r\nAuthorization: Bearer secret-xyz\r\n\r\n";
        let cfg = load_config(name);
        assert_eq!(
            capture_from_head(&cfg, name, "api.example.com", head).as_deref(),
            Some("authorization")
        );
        let cfg = load_config(name);
        let Injection::Resolved(header, value) = resolve_injection(&cfg, name, "api.example.com")
        else {
            panic!("expected a resolved injection");
        };
        assert_eq!(header, "authorization");
        assert_eq!(value, "Bearer secret-xyz");
        // A host with no matching rule resolves to NoRule.
        assert!(matches!(
            resolve_injection(&cfg, name, "other.test"),
            Injection::NoRule
        ));
        // Masking keeps only a short tail.
        let listed = list_secrets(name);
        assert_eq!(listed.len(), 1);
        assert!(listed[0].masked.ends_with("-xyz") || listed[0].masked == "••••");
        forget_secrets(name);
        let _ = remove_rule(name, "api.example.com");
    }

    #[test]
    fn broker_files_keep_the_legacy_vm_directory_name() {
        let name = "creds test+legacy";
        let raw_dir = credential_store_root().join(name);
        let encoded_dir = credential_store_root().join(encode_identifier(name));
        let _ = std::fs::remove_dir_all(&raw_dir);
        let cfg = integrity_test_config();

        save_config(name, &cfg).unwrap();
        assert!(raw_dir
            .join(VmBrokerFile::Credentials.file_name())
            .is_file());
        assert!(!encoded_dir.exists());
        assert_eq!(load_config(name).rules.len(), 1);

        std::fs::remove_dir_all(raw_dir).unwrap();
    }

    #[test]
    fn broker_files_keep_a_leading_dot_legacy_vm_directory_name() {
        let name = ".hidden cluster";
        let raw_dir = credential_store_root().join(name);
        let encoded_dir = credential_store_root().join(encode_identifier(name));
        assert_ne!(raw_dir, encoded_dir);
        let _ = std::fs::remove_dir_all(&raw_dir);
        let _ = std::fs::remove_dir_all(&encoded_dir);
        let cfg = integrity_test_config();

        save_config(name, &cfg).unwrap();
        assert!(raw_dir
            .join(VmBrokerFile::Credentials.file_name())
            .is_file());
        assert!(!encoded_dir.exists());
        assert_eq!(load_config(name).rules.len(), 1);

        std::fs::remove_dir_all(raw_dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn helper_overrides_stored_secret() {
        let name = "creds-test-helper";
        forget_secrets(name);
        let _ = std::fs::create_dir_all(VmPaths::for_name(name).dir);
        upsert_rule(
            name,
            CredentialRule {
                host: "h.test".into(),
                capture: false,
                inject: true,
                header: "authorization".into(),
                helper: Some(CredentialHelper::legacy("printf 'Bearer from-helper'")),
            },
        )
        .unwrap();
        let cfg = load_config(name);
        let Injection::Resolved(_, value) = resolve_injection(&cfg, name, "h.test") else {
            panic!("expected a resolved injection");
        };
        assert_eq!(value, "Bearer from-helper");
        let _ = remove_rule(name, "h.test");
    }

    fn build_test_helper() -> (PathBuf, PathBuf) {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "appliance-cred-helper-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("helper.rs");
        std::fs::write(
            &source,
            r###"fn main() {
                if std::env::args().any(|arg| arg == "--multiline") {
                    print!("first\nsecond");
                } else {
                    print!("{}", r#"{"kind":"api-key","value":"from-argv"}"#);
                }
            }"###,
        )
        .unwrap();
        let executable = dir.join(if cfg!(windows) {
            "helper.exe"
        } else {
            "helper"
        });
        #[cfg(not(windows))]
        let rustc = resolve_helper_program("rustc").expect("rustc is on PATH during cargo test");
        #[cfg(windows)]
        let rustc = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .flat_map(|dir| [dir.join("rustc.exe"), dir.join("rustc.com")])
            .find(|candidate| candidate.is_file())
            .expect("rustc is on PATH during cargo test");
        let status = Command::new(rustc)
            .args([
                source.as_os_str(),
                std::ffi::OsStr::new("-o"),
                executable.as_os_str(),
            ])
            .status()
            .expect("compile argv credential helper");
        assert!(status.success());
        (dir, executable)
    }

    #[test]
    fn argv_helper_resolves_kind_value_envelope() {
        let (dir, executable) = build_test_helper();
        let helper = CredentialHelper::Argv(vec![executable.to_string_lossy().into_owned()]);
        let value = run_helper(&helper).expect("run argv credential helper");
        let envelope: serde_json::Value =
            serde_json::from_str(&value).expect("helper envelope JSON");
        assert_eq!(
            envelope,
            serde_json::json!({ "kind": "api-key", "value": "from-argv" })
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn helper_rejects_multiline_output() {
        let (dir, executable) = build_test_helper();
        let helper = CredentialHelper::Argv(vec![
            executable.to_string_lossy().into_owned(),
            "--multiline".into(),
        ]);
        assert_eq!(
            run_helper(&helper).unwrap_err().to_string(),
            "credential helper output must be a single line"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn windows_helper_program_must_be_absolute() {
        assert_eq!(
            resolve_helper_program("rustc").unwrap_err().to_string(),
            "credential helper executable must be an absolute path on Windows"
        );
    }

    #[test]
    fn helper_json_round_trips_argv_and_legacy_forms() {
        let argv = CredentialHelper::Argv(vec![
            if cfg!(windows) {
                r"C:\Program Files\Appliance\appliance.exe".into()
            } else {
                "/Applications/Appliance.app/Contents/MacOS/appliance".into()
            },
            "agent".into(),
            "print-key".into(),
            "--type".into(),
            "claude-code".into(),
        ]);
        let encoded = serde_json::to_string(&argv).unwrap();
        assert!(encoded.starts_with('['));
        assert_eq!(
            serde_json::from_str::<CredentialHelper>(&encoded).unwrap(),
            argv
        );
        assert_eq!(
            serde_json::from_str::<CredentialHelper>(r#""printf legacy""#).unwrap(),
            CredentialHelper::legacy("printf legacy")
        );
    }

    #[cfg(unix)]
    #[test]
    fn legacy_shell_helper_still_works_on_unix() {
        let helper = CredentialHelper::legacy("printf legacy-helper");
        assert_eq!(run_helper(&helper).unwrap(), "legacy-helper");
    }

    #[cfg(windows)]
    #[test]
    fn legacy_shell_helper_is_rejected_on_windows_with_migration_error() {
        let helper = CredentialHelper::legacy("echo legacy-helper");
        assert_eq!(
            run_helper(&helper).unwrap_err().to_string(),
            "legacy shell helper is not supported on Windows; re-run `appliance agent login`"
        );
    }

    #[test]
    fn inject_rule_present_but_helper_fails_yields_no_value() {
        // Fail-closed input: an inject rule whose helper exits non-zero
        // (or empty) must resolve to NO value — the proxy then refuses
        // rather than forward the in-guest placeholder upstream.
        let name = "creds-test-failclosed";
        forget_secrets(name);
        let _ = std::fs::create_dir_all(VmPaths::for_name(name).dir);
        upsert_rule(
            name,
            CredentialRule {
                host: "api.anthropic.com".into(),
                capture: false,
                inject: true,
                header: "x-api-key".into(),
                helper: Some(failing_test_helper()),
            },
        )
        .unwrap();
        // A single config load classifies the fail-closed state: the host
        // HAS an inject rule but its credential can't be resolved, so the
        // caller refuses rather than forwarding the placeholder.
        let cfg = load_config(name);
        assert!(matches!(
            resolve_injection(&cfg, name, "api.anthropic.com"),
            Injection::RuleButUnresolved
        ));
        // ...and it also has *a* cred rule (so MITM is scoped to it)...
        assert!(has_cred_rule(name, "api.anthropic.com"));
        // A host with no rule is neither intercepted nor inject-gated.
        assert!(matches!(
            resolve_injection(&cfg, name, "example.com"),
            Injection::NoRule
        ));
        assert!(!has_cred_rule(name, "example.com"));
        let _ = remove_rule(name, "api.anthropic.com");
    }

    #[test]
    fn capture_false_never_stores_the_placeholder() {
        // The Anthropic rule is capture:false, so an in-guest placeholder
        // x-api-key must never be lifted into egress-secrets.json.
        let name = "creds-test-no-capture";
        forget_secrets(name);
        let _ = std::fs::create_dir_all(VmPaths::for_name(name).dir);
        upsert_rule(
            name,
            CredentialRule {
                host: "api.anthropic.com".into(),
                capture: false,
                inject: true,
                header: "x-api-key".into(),
                helper: Some(resolving_test_helper()),
            },
        )
        .unwrap();
        let head =
            "POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nX-Api-Key: sk-ant-appliance-proxy\r\n\r\n";
        let cfg = load_config(name);
        assert!(capture_from_head(&cfg, name, "api.anthropic.com", head).is_none());
        assert!(list_secrets(name).is_empty());
        let _ = remove_rule(name, "api.anthropic.com");
    }
}
