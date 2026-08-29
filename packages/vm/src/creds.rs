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
//! Config + secrets live under the VM state dir on the host — the
//! guest can't read them. Secrets are written 0600.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{bail, Context};
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
    /// Parse the single `--helper` CLI value. New callers pass a JSON array;
    /// everything else remains a legacy shell command for persisted/manual
    /// compatibility on Unix.
    pub fn from_cli_arg(raw: String) -> anyhow::Result<Self> {
        if raw.trim_start().starts_with('[') {
            let argv: Vec<String> = serde_json::from_str(&raw).context("parse --helper argv JSON")?;
            if argv.is_empty() || argv.iter().any(String::is_empty) {
                bail!("credential helper argv must contain a non-empty executable and arguments");
            }
            Ok(Self::Argv(argv))
        } else {
            Ok(Self::LegacyShell(raw))
        }
    }
}

impl From<&str> for CredentialHelper {
    fn from(value: &str) -> Self {
        Self::LegacyShell(value.to_string())
    }
}

impl From<String> for CredentialHelper {
    fn from(value: String) -> Self {
        Self::LegacyShell(value)
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
    VmPaths::for_name(name).dir.join("egress-credentials.json")
}

fn secrets_path(name: &str) -> PathBuf {
    VmPaths::for_name(name).dir.join("egress-secrets.json")
}

pub fn load_config(name: &str) -> CredentialConfig {
    std::fs::read_to_string(config_path(name))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save_config(name: &str, cfg: &CredentialConfig) -> anyhow::Result<()> {
    let path = config_path(name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(cfg)?)?;
    Ok(())
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

fn first_matching<'a>(cfg: &'a CredentialConfig, host: &str, want: impl Fn(&CredentialRule) -> bool) -> Option<&'a CredentialRule> {
    cfg.rules.iter().find(|r| want(r) && host_matches(host, &r.host))
}

// --- secret store (host-side, 0600) ---------------------------------

type SecretMap = std::collections::BTreeMap<String, String>;

fn secret_key(host: &str, header: &str) -> String {
    format!("{}\t{}", host.to_ascii_lowercase(), header.to_ascii_lowercase())
}

fn load_secrets(name: &str) -> SecretMap {
    std::fs::read_to_string(secrets_path(name))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_secrets(name: &str, map: &SecretMap) -> anyhow::Result<()> {
    let path = secrets_path(name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(map)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
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
    let _ = std::fs::remove_file(secrets_path(name));
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
pub fn capture_from_head(cfg: &CredentialConfig, name: &str, host: &str, head: &str) -> Option<String> {
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
        Some(helper) => run_helper(helper).ok(),
        None => get_secret(name, host, &rule.header),
    };
    match value {
        Some(v) if !v.trim().is_empty() => Injection::Resolved(rule.header.clone(), v.trim().to_string()),
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
/// running appliance executable; accepting a bare PATH name keeps the generic
/// credential-rule API useful without ever handing a command line to a shell.
fn resolve_helper_program(program: &str) -> anyhow::Result<PathBuf> {
    let path = Path::new(program);
    if path.is_absolute() {
        return validate_helper_program(path);
    }
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

#[cfg(not(windows))]
fn helper_program_candidates(dir: &Path, program: &str) -> Vec<PathBuf> {
    vec![dir.join(program)]
}

#[cfg(windows)]
fn helper_program_candidates(dir: &Path, program: &str) -> Vec<PathBuf> {
    let path = Path::new(program);
    if path.extension().is_some() {
        vec![dir.join(path)]
    } else {
        vec![dir.join(format!("{program}.exe")), dir.join(format!("{program}.com"))]
    }
}

fn validate_helper_program(path: &Path) -> anyhow::Result<PathBuf> {
    if !path.is_absolute() {
        bail!("credential helper executable must resolve to an absolute path");
    }
    let metadata = std::fs::metadata(path)
        .with_context(|| format!("credential helper executable does not exist: {}", path.display()))?;
    if !metadata.is_file() {
        bail!("credential helper executable is not a file: {}", path.display());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            bail!("credential helper file is not executable: {}", path.display());
        }
    }
    #[cfg(windows)]
    {
        let extension = path.extension().and_then(|x| x.to_str()).unwrap_or_default();
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
                .ok_or_else(|| anyhow::anyhow!("credential helper argv must start with an executable"))?;
            let mut command = Command::new(resolve_helper_program(program)?);
            command.args(args);
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
        let is_target = line.split_once(':').map(|(k, _)| k.trim().eq_ignore_ascii_case(header)).unwrap_or(false);
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
mod tests {
    use super::*;

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
        assert_eq!(header_value(head, "authorization").as_deref(), Some("Bearer abc"));
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
        let Injection::Resolved(header, value) = resolve_injection(&cfg, name, "api.example.com") else {
            panic!("expected a resolved injection");
        };
        assert_eq!(header, "authorization");
        assert_eq!(value, "Bearer secret-xyz");
        // A host with no matching rule resolves to NoRule.
        assert!(matches!(resolve_injection(&cfg, name, "other.test"), Injection::NoRule));
        // Masking keeps only a short tail.
        let listed = list_secrets(name);
        assert_eq!(listed.len(), 1);
        assert!(listed[0].masked.ends_with("-xyz") || listed[0].masked == "••••");
        forget_secrets(name);
        let _ = remove_rule(name, "api.example.com");
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
                helper: Some("printf 'Bearer from-helper'".into()),
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
        let dir = std::env::temp_dir().join(format!("appliance-cred-helper-{}-{unique}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("helper.rs");
        std::fs::write(
            &source,
            r###"fn main() { print!("{}", r#"{"kind":"api-key","value":"from-argv"}"#); }"###,
        )
        .unwrap();
        let executable = dir.join(if cfg!(windows) { "helper.exe" } else { "helper" });
        let rustc = resolve_helper_program("rustc").expect("rustc is on PATH during cargo test");
        let status = Command::new(rustc)
            .args([source.as_os_str(), std::ffi::OsStr::new("-o"), executable.as_os_str()])
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
        let envelope: serde_json::Value = serde_json::from_str(&value).expect("helper envelope JSON");
        assert_eq!(envelope, serde_json::json!({ "kind": "api-key", "value": "from-argv" }));
        let _ = std::fs::remove_dir_all(dir);
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
        assert_eq!(serde_json::from_str::<CredentialHelper>(&encoded).unwrap(), argv);
        assert_eq!(
            serde_json::from_str::<CredentialHelper>(r#""printf legacy""#).unwrap(),
            CredentialHelper::LegacyShell("printf legacy".into())
        );
    }

    #[cfg(unix)]
    #[test]
    fn legacy_shell_helper_still_works_on_unix() {
        let helper = CredentialHelper::LegacyShell("printf legacy-helper".into());
        assert_eq!(run_helper(&helper).unwrap(), "legacy-helper");
    }

    #[cfg(windows)]
    #[test]
    fn legacy_shell_helper_is_rejected_on_windows_with_migration_error() {
        let helper = CredentialHelper::LegacyShell("echo legacy-helper".into());
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
                helper: Some("exit 7".into()),
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
        assert!(matches!(resolve_injection(&cfg, name, "example.com"), Injection::NoRule));
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
                helper: Some("printf real-key".into()),
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
