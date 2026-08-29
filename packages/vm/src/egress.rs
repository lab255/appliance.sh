//! Outbound-traffic control for a microVM.
//!
//! Borrowing Docker's sandbox model: all of the guest's egress is
//! routed through a forward proxy that Appliance runs and the desktop
//! controls. The proxy enforces an allow/deny policy by destination
//! host, so a workload can be confined to a known set of endpoints —
//! the desktop edits the policy file, the proxy picks it up live.
//!
//! This module is the policy + proxy core. It handles HTTP `CONNECT`
//! (the HTTPS path: decide by the tunnel host, then splice or refuse)
//! and plain-HTTP forwarding (decide by the Host header). It does not
//! yet decrypt TLS — host-level control needs only the CONNECT target
//! and SNI, which travel in the clear. TLS interception (a generated
//! CA + per-host leaf certs, for payload inspection) layers on top in
//! a later pass; the CA scaffolding lives alongside this.
//!
//! Routing the guest's traffic into the proxy (HTTP(S)_PROXY in the
//! workloads, or a transparent redirect) is a separate wiring step —
//! the proxy is independently runnable and testable on the host
//! (`curl -x http://127.0.0.1:<port> https://example.com`).

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use crate::mitm;
use crate::spec::{NetLink, VmPaths, WslMode};

/// What the proxy does with a connection no explicit rule covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Allow,
    Deny,
}

fn default_action() -> Action {
    // Allow by default: the policy is opt-in confinement, not a
    // breaking change to existing workloads. A user (or the desktop)
    // tightens it by switching the default to "deny" + an allowlist.
    Action::Allow
}

/// Desktop-controlled outbound policy. Persisted as JSON next to the
/// VM's other state; reloaded per connection so edits apply live.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EgressPolicy {
    #[serde(default = "default_action")]
    pub default: Action,
    /// Host suffixes to allow (e.g. `github.com` matches `github.com`
    /// and `api.github.com`).
    #[serde(default)]
    pub allow: Vec<String>,
    /// Host suffixes to deny. Deny wins over allow.
    #[serde(default)]
    pub deny: Vec<String>,
    /// Intercept TLS on allowed HTTPS connections — terminate with a
    /// minted leaf (guest trusts the VM CA), inspect/log the decrypted
    /// request, re-originate upstream. Off by default: blind tunnel.
    #[serde(default)]
    pub mitm: bool,
}

/// Whether policy is a hard host boundary or a bypassable guest proxy.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EgressBoundary {
    Enforced,
    Cooperative,
}

/// Effective enforcement capability, kept separate from the flattened policy
/// fields and stable `boundary` scalar.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EgressEnforcement {
    pub backend: String,
    pub bypassable: bool,
    pub scope: Vec<String>,
}

impl EgressBoundary {
    pub fn for_link(netstack: bool) -> Self {
        if netstack {
            Self::Enforced
        } else {
            Self::Cooperative
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Enforced => "enforced (netstack)",
            Self::Cooperative => "cooperative (in-guest proxy)",
        }
    }
}

/// Machine-readable effective policy returned by `egress policy`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EgressPolicyOutput {
    #[serde(flatten)]
    pub policy: EgressPolicy,
    pub boundary: EgressBoundary,
    pub enforcement: EgressEnforcement,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wsl_mode: Option<WslMode>,
}

impl EgressPolicyOutput {
    pub fn for_backend(policy: EgressPolicy, netstack: bool, backend: &str, wsl_mode: WslMode) -> Self {
        let enforced = netstack && backend != "wsl";
        Self {
            policy,
            boundary: EgressBoundary::for_link(enforced),
            enforcement: EgressEnforcement {
                backend: backend.to_string(),
                bypassable: !enforced,
                scope: if enforced {
                    vec!["tcp".into(), "udp".into(), "dns".into()]
                } else {
                    vec!["http".into(), "https".into()]
                },
            },
            wsl_mode: (backend == "wsl").then_some(wsl_mode),
        }
    }
}

/// Host-enforced policy for one runnable app/service leaf. The runtime
/// controller writes this resolved record to
/// `~/.appliance/runtime/<app>/effective.json`; it is deliberately free of
/// manifest/requested state so the engine can consume only granted policy.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimePolicy {
    pub version: u32,
    pub app: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
    pub vm: String,
    pub principal: String,
    pub source: Ipv4Addr,
    pub policy: EgressPolicy,
    /// Granted destination ports for each normalized allow suffix. Every
    /// runtime allow entry must have a non-empty port set.
    pub allow_ports: BTreeMap<String, Vec<u16>>,
}

impl RuntimePolicy {
    pub fn allowed_ports_for(&self, host: &str) -> Vec<u16> {
        let mut ports = self
            .allow_ports
            .iter()
            .filter(|(suffix, _)| host_matches(host, suffix))
            .flat_map(|(_, ports)| ports.iter().copied())
            .collect::<Vec<_>>();
        ports.sort_unstable();
        ports.dedup();
        ports
    }

    pub fn allows_host_port(&self, host: &str, port: u16) -> bool {
        self.policy.allows(host) && self.allowed_ports_for(host).contains(&port)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimePolicyFile {
    version: u32,
    app: String,
    principals: Vec<RuntimePolicy>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RuntimeFileStamp {
    modified: Option<SystemTime>,
    len: u64,
    #[cfg(unix)]
    inode: u64,
}

#[derive(Debug, Clone)]
struct CachedRuntimeFile {
    stamp: RuntimeFileStamp,
    policies: Option<Vec<RuntimePolicy>>,
}

#[derive(Debug, Default)]
struct RuntimePolicyCache {
    root: PathBuf,
    files: BTreeMap<PathBuf, CachedRuntimeFile>,
}

static RUNTIME_POLICY_CACHE: OnceLock<Mutex<RuntimePolicyCache>> = OnceLock::new();

#[cfg(test)]
pub(crate) static RUNTIME_ENV_TEST_LOCK: Mutex<()> = Mutex::new(());

/// The selected policy context. Only the VM's historical `.2` lease may use
/// `Legacy`; all other addresses are runtime principals and fail closed when
/// their effective policy is absent or invalid.
#[derive(Debug, Clone)]
pub enum PolicyContext {
    Legacy(EgressPolicy),
    Runtime(RuntimePolicy),
    Unknown { source: Ipv4Addr },
}

impl PolicyContext {
    pub fn policy(&self) -> EgressPolicy {
        match self {
            Self::Legacy(policy) => policy.clone(),
            Self::Runtime(runtime) => runtime.policy.clone(),
            Self::Unknown { .. } => EgressPolicy {
                default: Action::Deny,
                allow: Vec::new(),
                deny: Vec::new(),
                mitm: false,
            },
        }
    }

    pub fn principal(&self) -> String {
        match self {
            Self::Legacy(_) => "vm".to_string(),
            Self::Runtime(runtime) => runtime.principal.clone(),
            Self::Unknown { source, .. } => format!("unknown:{source}"),
        }
    }

    pub fn is_runtime(&self) -> bool {
        !matches!(self, Self::Legacy(_))
    }
}

impl Default for EgressPolicy {
    fn default() -> Self {
        Self {
            default: default_action(),
            allow: Vec::new(),
            deny: Vec::new(),
            mitm: false,
        }
    }
}

pub fn host_matches(host: &str, suffix: &str) -> bool {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    let suffix = suffix
        .trim()
        .trim_start_matches('.')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if suffix.is_empty() {
        return false;
    }
    host == suffix || host.ends_with(&format!(".{suffix}"))
}

impl EgressPolicy {
    /// Is this policy doing anything? A permissive default with no
    /// rules and no interception is inert — workloads need not be
    /// routed through the proxy at all.
    pub fn is_active(&self) -> bool {
        self.default == Action::Deny || !self.allow.is_empty() || !self.deny.is_empty() || self.mitm
    }

    /// Allow this destination host? Deny rules win, then allow rules,
    /// then the default. `host` may carry a `:port` — it's stripped.
    pub fn allows(&self, host_port: &str) -> bool {
        let host = host_port.rsplit_once(':').map_or(host_port, |(h, _)| h);
        // An IPv6 literal arrives bracketed (`[::1]`); the rsplit above
        // also trims a trailing `:port`, leaving the brackets — fine
        // for suffix matching, which only cares about names.
        if self.deny.iter().any(|s| host_matches(host, s)) {
            return false;
        }
        if self.allow.iter().any(|s| host_matches(host, s)) {
            return true;
        }
        self.default == Action::Allow
    }
}

fn policy_path(name: &str) -> PathBuf {
    VmPaths::for_name(name).dir.join("egress-policy.json")
}

/// The baked sane default allowlist for `net_link = Netstack` VMs
/// (docs/egress-firewall.md; docs/multi-agent-adapters.md §5): the package
/// mirrors, registries, git hosts, and the model APIs a fresh agent/dev VM
/// needs, suffix-matched by [`host_matches`]. `githubusercontent.com` is the
/// suffix form of the doc's `*.githubusercontent.com` wildcard;
/// `githubcopilot.com` covers `api.githubcopilot.com` + `*.githubcopilot.com`.
pub const NETSTACK_ALLOWLIST: &[&str] = &[
    // api / model
    "api.anthropic.com",
    "api.openai.com", // codex (OpenAI Codex CLI) — docs/multi-agent-adapters.md §5
    "githubcopilot.com", // copilot model leg: api.githubcopilot.com + *.githubcopilot.com — §5
    // alpine packages
    "dl-cdn.alpinelinux.org",
    // language package registries
    "registry.npmjs.org",
    "pypi.org",
    "files.pythonhosted.org",
    "crates.io",
    "static.crates.io",
    // git  (these ALSO cover Copilot's github hosts: github.com covers
    // api.github.com — the PAT-broker leg — and githubusercontent.com covers
    // copilot-proxy. + origin-tracker.githubusercontent.com)
    "github.com",
    "codeload.github.com",
    "githubusercontent.com",
    // container registries
    "registry-1.docker.io",
    "auth.docker.io",
    "production.cloudflare.docker.com",
    "ghcr.io",
];

/// The **effective** egress policy for a Netstack VM: a hard default-DENY
/// boundary plus the baked allowlist, merged over the operator's persisted
/// allow/deny rules (deny always wins, via [`EgressPolicy::allows`]).
///
/// This is opt-in and Netstack-only: the global [`EgressPolicy::default`]
/// stays `Allow` so the legacy NAT proxy and its callers are untouched
/// (the global default-flip is F4). For the host-mediated boundary the
/// default is **Deny** regardless of the persisted file's serde-default
/// `Allow`, so an operator can never accidentally leave the boundary wide
/// open — they tighten with `deny` rules and widen with `allow` rules.
pub fn netstack_policy(name: &str) -> EgressPolicy {
    let mut p = load_policy(name);
    p.default = Action::Deny;
    for h in NETSTACK_ALLOWLIST {
        if !p.allow.iter().any(|a| a.eq_ignore_ascii_case(h)) {
            p.allow.push((*h).to_string());
        }
    }
    p
}

fn appliance_home() -> PathBuf {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".appliance")
}

pub fn runtime_root() -> PathBuf {
    std::env::var_os("APPLIANCE_RUNTIME_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| appliance_home().join("runtime"))
}

fn valid_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

fn validate_runtime_identity(policy: &RuntimePolicy) -> Result<()> {
    if policy.version != 1 {
        bail!("unsupported runtime policy version {}", policy.version);
    }
    if !valid_component(&policy.app) || !valid_component(&policy.vm) {
        bail!("runtime app and VM names must be safe path components");
    }
    if policy.source.octets()[3] < 10
        || policy.source == Ipv4Addr::new(192, 168, 127, 255)
        || policy.source.octets()[..3] != crate::netstack::GUEST_IP.octets()[..3]
    {
        bail!("runtime principal source must be in 192.168.127.10-254");
    }
    let expected = match &policy.service {
        Some(service) if valid_component(service) => format!("{}/{service}", policy.app),
        Some(_) => bail!("runtime service must be a safe path component"),
        None => policy.app.clone(),
    };
    if policy.principal != expected {
        bail!(
            "principal '{}' does not match app/service identity '{expected}'",
            policy.principal
        );
    }
    Ok(())
}

/// Normalize and validate a runtime hostname suffix. Runtime policy never
/// accepts the legacy raw-IP/CIDR hatch, URLs, ports, or single public-suffix
/// labels. `*.` is accepted only as spelling for ordinary suffix matching.
pub fn normalize_runtime_host(raw: &str) -> Result<String> {
    let raw = raw.trim().trim_end_matches('.');
    let raw = raw.strip_prefix("*.").unwrap_or(raw);
    if raw.is_empty()
        || raw.contains(['/', '\\', '@', ':'])
        || raw.contains("..")
        || raw.parse::<IpAddr>().is_ok()
        || raw
            .split_once('/')
            .is_some_and(|(ip, bits)| ip.parse::<IpAddr>().is_ok() && bits.parse::<u8>().is_ok())
    {
        bail!("runtime egress entry must be a DNS hostname suffix, got '{raw}'");
    }
    let host = idna::domain_to_ascii(raw)
        .map_err(|_| anyhow::anyhow!("invalid internationalized hostname '{raw}'"))?
        .to_ascii_lowercase();
    const PUBLIC_SUFFIXES: &[&str] = &[
        "com", "net", "org", "edu", "gov", "mil", "io", "dev", "app", "co.uk", "org.uk",
        "com.au", "co.jp",
    ];
    if host.len() > 253
        || !host.contains('.')
        || PUBLIC_SUFFIXES.contains(&host.as_str())
        || host.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
    {
        bail!("invalid or public-suffix-only runtime egress host '{raw}'");
    }
    Ok(host)
}

fn validate_runtime_policy(mut runtime: RuntimePolicy) -> Result<RuntimePolicy> {
    validate_runtime_identity(&runtime)?;
    runtime.policy.default = Action::Deny;
    runtime.policy.allow = runtime
        .policy
        .allow
        .iter()
        .map(|host| normalize_runtime_host(host))
        .collect::<Result<Vec<_>>>()?;
    runtime.policy.deny = runtime
        .policy
        .deny
        .iter()
        .map(|host| normalize_runtime_host(host))
        .collect::<Result<Vec<_>>>()?;
    runtime.policy.allow.sort();
    runtime.policy.allow.dedup();
    runtime.policy.deny.sort();
    runtime.policy.deny.dedup();
    let mut normalized_ports = BTreeMap::new();
    for (host, mut ports) in runtime.allow_ports {
        let host = normalize_runtime_host(&host)?;
        ports.sort_unstable();
        ports.dedup();
        if ports.is_empty() || ports.contains(&0) {
            bail!("runtime allow port sets must contain non-zero TCP ports");
        }
        if normalized_ports.insert(host.clone(), ports).is_some() {
            bail!("duplicate normalized runtime allow host '{host}'");
        }
    }
    if runtime.policy.allow.iter().any(|host| !normalized_ports.contains_key(host))
        || normalized_ports.keys().any(|host| !runtime.policy.allow.contains(host))
    {
        bail!("runtime policy allow and allowPorts must name the same normalized hosts");
    }
    runtime.allow_ports = normalized_ports;
    Ok(runtime)
}

pub fn parse_runtime_policy(raw: &str) -> Result<RuntimePolicy> {
    let value: serde_json::Value =
        serde_json::from_str(raw).context("parse runtime effective policy")?;
    if value
        .pointer("/policy/mitm")
        .and_then(serde_json::Value::as_bool)
        .is_none()
    {
        bail!("runtime effective policy must resolve the inspection default as policy.mitm");
    }
    validate_runtime_policy(serde_json::from_str(raw).context("parse runtime effective policy")?)
}

fn runtime_policy_path(app: &str) -> Result<PathBuf> {
    if !valid_component(app) {
        bail!("runtime app must be a safe path component");
    }
    Ok(runtime_root().join(app).join("effective.json"))
}

pub fn save_runtime_policy(runtime: &RuntimePolicy) -> Result<()> {
    let runtime = validate_runtime_policy(runtime.clone())?;
    let path = runtime_policy_path(&runtime.app)?;
    let parent = path.parent().context("runtime policy parent")?;
    std::fs::create_dir_all(parent)?;
    let existing = if path.exists() {
        load_runtime_file(&path)
            .with_context(|| format!("refuse to replace invalid {}", path.display()))?
    } else {
        Vec::new()
    };
    let mut principals = existing
        .into_iter()
        .filter(|existing| existing.principal != runtime.principal)
        .collect::<Vec<_>>();
    principals.push(runtime.clone());
    principals.sort_by(|a, b| a.principal.cmp(&b.principal));
    let stored = RuntimePolicyFile {
        version: 1,
        app: runtime.app.clone(),
        principals,
    };
    let tmp = parent.join(".effective.json.tmp");
    let bytes = serde_json::to_vec_pretty(&stored)?;
    write_private(&tmp, &bytes)?;
    std::fs::rename(&tmp, &path).with_context(|| format!("replace {}", path.display()))?;
    invalidate_runtime_policy_cache(&path);
    Ok(())
}

pub fn remove_runtime_policy(vm: &str, principal: &str) -> Result<bool> {
    let path = runtime_policy_path(principal)?;
    if !path.exists() {
        return Ok(false);
    }
    let mut principals = load_runtime_file(&path)
        .with_context(|| format!("refuse to edit invalid {}", path.display()))?;
    let before = principals.len();
    principals.retain(|runtime| runtime.vm != vm || runtime.principal != principal);
    if principals.len() == before {
        return Ok(false);
    }
    if principals.is_empty() {
        std::fs::remove_file(&path).with_context(|| format!("remove {}", path.display()))?;
    } else {
        let parent = path.parent().context("runtime policy parent")?;
        let stored = RuntimePolicyFile {
            version: 1,
            app: principal.to_string(),
            principals,
        };
        let tmp = parent.join(".effective.json.tmp");
        write_private(&tmp, &serde_json::to_vec_pretty(&stored)?)?;
        std::fs::rename(&tmp, &path).with_context(|| format!("replace {}", path.display()))?;
    }
    invalidate_runtime_policy_cache(&path);
    Ok(true)
}

fn load_runtime_file(path: &Path) -> Result<Vec<RuntimePolicy>> {
    let raw = std::fs::read_to_string(path)?;
    if let Ok(single) = parse_runtime_policy(&raw) {
        return Ok(vec![single]);
    }
    let stored: RuntimePolicyFile =
        serde_json::from_str(&raw).context("parse runtime effective policy file")?;
    if stored.version != 1 || !valid_component(&stored.app) {
        bail!("invalid runtime effective policy file identity");
    }
    stored
        .principals
        .into_iter()
        .map(|runtime| {
            if runtime.app != stored.app {
                bail!("runtime policy app does not match effective policy directory");
            }
            validate_runtime_policy(runtime)
        })
        .collect()
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    if let Err(error) = crate::fs_acl::restrict_to_current_user(path) {
        let _ = std::fs::remove_file(path);
        return Err(error);
    }
    Ok(())
}

#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    std::fs::write(path, bytes)?;
    if let Err(error) = crate::fs_acl::restrict_to_current_user(path) {
        let _ = std::fs::remove_file(path);
        return Err(error);
    }
    Ok(())
}

fn runtime_file_stamp(path: &Path) -> Option<RuntimeFileStamp> {
    let metadata = std::fs::metadata(path).ok()?;
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    Some(RuntimeFileStamp {
        modified: metadata.modified().ok(),
        len: metadata.len(),
        #[cfg(unix)]
        inode: metadata.ino(),
    })
}

fn runtime_cache() -> &'static Mutex<RuntimePolicyCache> {
    RUNTIME_POLICY_CACHE.get_or_init(|| Mutex::new(RuntimePolicyCache::default()))
}

fn invalidate_runtime_policy_cache(path: &Path) {
    let mut cache = runtime_cache()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    cache.files.remove(path);
}

#[cfg(test)]
pub(crate) fn clear_runtime_policy_cache() {
    let mut cache = runtime_cache()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    *cache = RuntimePolicyCache::default();
}

#[cfg(test)]
pub(crate) fn with_runtime_test_root<T>(label: &str, test: impl FnOnce(&Path) -> T) -> T {
    struct Restore {
        old: Option<std::ffi::OsString>,
        root: PathBuf,
    }
    impl Drop for Restore {
        fn drop(&mut self) {
            if let Some(old) = self.old.take() {
                std::env::set_var("APPLIANCE_RUNTIME_ROOT", old);
            } else {
                std::env::remove_var("APPLIANCE_RUNTIME_ROOT");
            }
            clear_runtime_policy_cache();
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    let _lock = RUNTIME_ENV_TEST_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let root = std::env::temp_dir().join(format!(
        "appliance-runtime-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let restore = Restore {
        old: std::env::var_os("APPLIANCE_RUNTIME_ROOT"),
        root: root.clone(),
    };
    std::env::set_var("APPLIANCE_RUNTIME_ROOT", &root);
    clear_runtime_policy_cache();
    let result = test(&root);
    drop(restore);
    result
}

fn all_runtime_policies() -> Vec<RuntimePolicy> {
    let root = runtime_root();
    let mut cache = runtime_cache()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    if cache.root != root {
        cache.root = root.clone();
        cache.files.clear();
    }
    let Ok(entries) = std::fs::read_dir(&root) else {
        cache.files.clear();
        return Vec::new();
    };
    let mut seen = BTreeSet::new();
    let mut policies = Vec::new();
    for entry in entries.flatten() {
        let app = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path().join("effective.json");
        let Some(stamp) = runtime_file_stamp(&path) else {
            continue;
        };
        seen.insert(path.clone());
        let cached = cache
            .files
            .get(&path)
            .filter(|cached| cached.stamp == stamp);
        let loaded = if let Some(cached) = cached {
            cached.policies.clone()
        } else {
            let loaded = load_runtime_file(&path)
                .ok()
                .filter(|items| items.iter().all(|runtime| runtime.app == app));
            cache.files.insert(
                path,
                CachedRuntimeFile {
                    stamp,
                    policies: loaded.clone(),
                },
            );
            loaded
        };
        if let Some(mut loaded) = loaded {
            policies.append(&mut loaded);
        }
    }
    cache.files.retain(|path, _| seen.contains(path));
    policies
}

/// Best-effort removal of every Runtime principal owned by a deleted VM.
/// Results stay per-principal so VM deletion can report store failures without
/// resurrecting or failing an otherwise-complete backend deletion.
pub fn prune_runtime_policies_for_vm(vm: &str) -> Vec<(String, Result<bool>)> {
    let mut principals = all_runtime_policies()
        .into_iter()
        .filter(|runtime| runtime.vm == vm)
        .map(|runtime| runtime.principal)
        .collect::<Vec<_>>();
    principals.sort();
    principals.dedup();
    principals
        .into_iter()
        .map(|principal| {
            let result = remove_runtime_policy(vm, &principal);
            (principal, result)
        })
        .collect()
}

pub fn runtime_policy_for_principal(vm: &str, principal: &str) -> Option<RuntimePolicy> {
    let mut matches = all_runtime_policies()
        .into_iter()
        .filter(|runtime| runtime.vm == vm && runtime.principal == principal);
    let found = matches.next()?;
    matches.next().is_none().then_some(found)
}

pub fn policy_for(vm: &str, source: Ipv4Addr) -> PolicyContext {
    // Residual compatibility: pooled guest-root .2 retains the legacy baked
    // dev allowlist and credential broker.
    // TODO(runtime-spec): a future runtime:true VmSpec flag must switch .2
    // to a default-deny runtime context instead.
    if source == crate::netstack::GUEST_IP {
        return PolicyContext::Legacy(netstack_policy(vm));
    }
    let mut matches = all_runtime_policies()
        .into_iter()
        .filter(|runtime| runtime.vm == vm && runtime.source == source);
    let Some(found) = matches.next() else {
        return PolicyContext::Unknown { source };
    };
    if matches.next().is_some() {
        PolicyContext::Unknown { source }
    } else {
        PolicyContext::Runtime(found)
    }
}

pub fn should_inspect_runtime(policy: &EgressPolicy, allowed: bool) -> bool {
    policy.mitm && allowed
}

/// Does this VM enforce the host-side netstack boundary? True when the
/// VM's resolved link is `Netstack` (persisted, or forced by the global
/// `APPLIANCE_NETSTACK=1` override). This is the gate the effective-policy
/// display keys off: a Netstack VM enforces default-Deny + the baked
/// allowlist regardless of the persisted file's serde-default `Allow`,
/// whereas a NAT VM enforces exactly its (cooperative) persisted policy.
/// Mirrors the `spec.net_link()` gate the backend uses to wire the link
/// (`backend/vz/mod.rs`), so what we show is what is enforced.
pub fn is_netstack(name: &str) -> bool {
    match crate::store::load_spec(name).ok().flatten() {
        Some(spec) => spec.net_link() == NetLink::Netstack,
        // No persisted spec yet: only the global override can force it on.
        None => std::env::var("APPLIANCE_NETSTACK")
            .map(|v| v == "1")
            .unwrap_or(false),
    }
}

/// Persisted WSL posture, or the global default captured by a fresh spec when
/// this VM has not been created yet. Missing/corrupt state always fails safe.
pub fn wsl_mode(name: &str) -> WslMode {
    crate::store::load_spec(name)
        .ok()
        .flatten()
        .map(|spec| spec.wsl_mode)
        .unwrap_or_else(|| crate::spec::VmSpec::defaults(name).wsl_mode)
}

fn is_wsl_runtime(name: &str, backend: &str) -> bool {
    backend == "wsl"
        && crate::store::load_spec(name)
            .ok()
            .flatten()
            .is_some_and(|spec| spec.runtime)
}

/// AP-205 step 3a: WSL's legacy proxy remains VM-wide. Its effective allowlist
/// is the union of installed Runtime policies; operator deny rules still win.
/// Port-aware, authenticated per-app selection replaces this in 3b.
fn wsl_runtime_proxy_policy(name: &str, mode: WslMode) -> EgressPolicy {
    let persisted = load_policy(name);
    union_wsl_runtime_policy(
        &persisted,
        &all_runtime_policies()
            .into_iter()
            .filter(|runtime| runtime.vm == name)
            .collect::<Vec<_>>(),
        mode,
    )
}

fn union_wsl_runtime_policy(
    persisted: &EgressPolicy,
    runtimes: &[RuntimePolicy],
    mode: WslMode,
) -> EgressPolicy {
    if mode == WslMode::Strict {
        return EgressPolicy {
            default: Action::Deny,
            allow: Vec::new(),
            deny: persisted.deny.clone(),
            mitm: false,
        };
    }
    let mut allow = runtimes
        .iter()
        .flat_map(|runtime| runtime.policy.allow.iter().cloned())
        .collect::<Vec<_>>();
    allow.sort();
    allow.dedup();
    EgressPolicy {
        default: Action::Deny,
        allow,
        deny: persisted.deny.clone(),
        mitm: persisted.mitm,
    }
}

fn effective_policy_for_backend(name: &str, backend: &str) -> EgressPolicy {
    if is_netstack(name) && backend != "wsl" {
        netstack_policy(name)
    } else if is_wsl_runtime(name, backend) {
        wsl_runtime_proxy_policy(name, wsl_mode(name))
    } else {
        load_policy(name)
    }
}

/// The policy actually enforced at the boundary for this VM — the single
/// source of truth for display, so `egress policy`/`list` never lie about
/// what's enforced (Quinn's F2 observability nit). A Netstack VM's
/// enforced policy is the hard default-Deny + baked allowlist boundary
/// ([`netstack_policy`]); a NAT VM's is exactly its persisted cooperative
/// policy ([`load_policy`], default-Allow). Keeping NAT on `load_policy`
/// is what leaves NAT-VM behaviour unchanged.
pub fn effective_policy(name: &str) -> EgressPolicy {
    effective_policy_for_backend(name, crate::backend::platform_backend_name())
}

fn proxy_policy_for_backend(name: &str, backend: &str) -> EgressPolicy {
    if is_wsl_runtime(name, backend) {
        effective_policy_for_backend(name, backend)
    } else {
        load_policy(name)
    }
}

fn proxy_policy(name: &str) -> EgressPolicy {
    proxy_policy_for_backend(name, crate::backend::platform_backend_name())
}

pub fn effective_policy_output(name: &str) -> EgressPolicyOutput {
    let backend = crate::backend::platform_backend_name();
    let netstack = is_netstack(name);
    EgressPolicyOutput::for_backend(effective_policy_for_backend(name, backend), netstack, backend, wsl_mode(name))
}

/// Render the **effective** egress policy as a human-readable report.
///
/// For a Netstack VM this reconciles the persisted file (which keeps the
/// serde-default `Allow` so the legacy callers are untouched) with what
/// the netstack forces in memory: a hard default-**Deny** plus the baked
/// [`NETSTACK_ALLOWLIST`]. It distinguishes the three categories an
/// operator needs to reason about reachability — **baked-allow**
/// (always-on for Netstack VMs), **operator-allow** (rules you added),
/// and **operator-deny** (which win over either) — annotating any
/// allow entry a deny rule overrides. For a NAT VM it shows the persisted
/// cooperative policy as-is. Pure (takes the persisted policy + the link
/// kind) so the rendering is unit-tested without a VM.
#[cfg(test)]
fn render_effective_policy(name: &str, persisted: &EgressPolicy, netstack: bool) -> String {
    render_effective_policy_for_backend(
        name,
        persisted,
        netstack,
        crate::backend::platform_backend_name(),
        wsl_mode(name),
    )
}

pub fn render_effective_policy_for_backend(
    name: &str,
    persisted: &EgressPolicy,
    netstack: bool,
    backend: &str,
    wsl_mode: WslMode,
) -> String {
    let denied = |h: &str| persisted.deny.iter().any(|d| host_matches(h, d));
    let mut out = String::new();
    let enforced = netstack && backend != "wsl";

    if backend == "wsl" {
        out.push_str(match wsl_mode {
            WslMode::Cooperative => {
                "WSL NAT — cooperative proxy, bypassable; direct TCP/UDP is not blocked\n"
            }
            WslMode::Strict => "WSL NAT — strict: apps with egress grants are refused\n",
        });
        let default = match persisted.default {
            Action::Allow => "ALLOW",
            Action::Deny => "DENY",
        };
        out.push_str(&format!(
            "egress policy for '{name}'  (boundary: {})\n",
            EgressBoundary::Cooperative.label()
        ));
        out.push_str(&format!("  default: {default}\n"));
    } else if enforced {
        let boundary = EgressBoundary::for_link(true);
        out.push_str(&format!(
            "EFFECTIVE egress policy for '{name}'  (boundary: {})\n",
            boundary.label()
        ));
        out.push_str(
            "  default: DENY  (host-enforced; the persisted file keeps the serde-default allow, the netstack forces deny)\n",
        );
    } else {
        let boundary = EgressBoundary::for_link(false);
        let default = match persisted.default {
            Action::Allow => "ALLOW",
            Action::Deny => "DENY",
        };
        out.push_str(&format!(
            "egress policy for '{name}'  (boundary: {})\n",
            boundary.label()
        ));
        out.push_str(&format!("  default: {default}\n"));
    }

    // Deny rules first — they win over every allow (baked or operator).
    out.push_str("\n  operator deny rules (deny wins over any allow):\n");
    if persisted.deny.is_empty() {
        out.push_str("    (none)\n");
    } else {
        for h in &persisted.deny {
            out.push_str(&format!("    ✗ {h}\n"));
        }
    }

    if enforced {
        out.push_str("\n  baked allowlist (always-on for Netstack VMs):\n");
        for h in NETSTACK_ALLOWLIST {
            if denied(h) {
                out.push_str(&format!(
                    "    ✗ {h}  (overridden by an operator deny rule)\n"
                ));
            } else {
                out.push_str(&format!("    ✓ {h}\n"));
            }
        }
    }

    // Operator allow rules: the hosts the operator added beyond the baked
    // set (a Netstack VM merges the baked list into `allow`, so filter it
    // out here to keep the two categories distinct).
    let is_baked = |h: &str| NETSTACK_ALLOWLIST.iter().any(|b| b.eq_ignore_ascii_case(h));
    let operator_allow: Vec<&String> = persisted
        .allow
        .iter()
        .filter(|h| !(enforced && is_baked(h)))
        .collect();
    out.push_str("\n  operator allow rules:\n");
    if operator_allow.is_empty() {
        out.push_str("    (none)\n");
    } else {
        for h in operator_allow {
            if denied(h) {
                out.push_str(&format!(
                    "    ✗ {h}  (overridden by an operator deny rule)\n"
                ));
            } else {
                out.push_str(&format!("    ✓ {h}\n"));
            }
        }
    }

    out.push_str(&format!(
        "\n  TLS interception (mitm): {}\n",
        if persisted.mitm { "on" } else { "off" }
    ));
    out
}

/// Load the VM's policy, or a permissive default when none is set.
pub fn load_policy(name: &str) -> EgressPolicy {
    let path = policy_path(name);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Persist the VM's policy (creating the state dir if needed).
pub fn save_policy(name: &str, policy: &EgressPolicy) -> Result<()> {
    let path = policy_path(name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(policy)?;
    std::fs::write(&path, json).with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

/// Run the forward proxy until killed. Reloads the policy per
/// connection so the desktop's edits take effect without a restart.
pub fn run_proxy(name: &str, addr: SocketAddr, log: bool) -> Result<()> {
    let (listener, ctx) = build(name, addr, log)?;
    let policy = proxy_policy(name);
    println!(
        "egress proxy for VM '{name}' listening on {}",
        listener.local_addr().unwrap_or(addr)
    );
    println!(
        "policy: default={:?}, {} allow, {} deny rules, mitm={}",
        policy.default,
        policy.allow.len(),
        policy.deny.len(),
        policy.mitm
    );
    accept_loop(listener, ctx); // blocks until the listener dies
    Ok(())
}

/// Start the proxy on a background thread (used by `vm run`, so the
/// proxy lives exactly as long as the VM host process). Returns once
/// it's bound; the accept loop runs detached.
pub fn spawn(name: &str, addr: SocketAddr, log: bool) -> Result<()> {
    let (listener, ctx) = build(name, addr, log)?;
    std::thread::spawn(move || accept_loop(listener, ctx));
    Ok(())
}

/// Bind the listener and assemble the per-connection context (policy
/// name + TLS material). The CA is generated on first use so an
/// intercepted connection doesn't pay for it; it's harmless (unused)
/// when MITM is off.
fn build(name: &str, addr: SocketAddr, log: bool) -> Result<(TcpListener, Arc<ProxyCtx>)> {
    let listener = TcpListener::bind(addr).with_context(|| format!("bind {addr}"))?;
    let ca = Arc::new(mitm::ensure_ca(name)?);
    let ctx = Arc::new(ProxyCtx {
        name: name.to_string(),
        log,
        server_cfg: mitm::server_config(ca)?,
        client_cfg: mitm::client_config()?,
    });
    Ok((listener, ctx))
}

fn accept_loop(listener: TcpListener, ctx: Arc<ProxyCtx>) {
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let ctx = ctx.clone();
        std::thread::spawn(move || {
            if let Err(e) = handle_conn(stream, &ctx) {
                if ctx.log {
                    eprintln!("egress: connection error: {e:#}");
                }
            }
        });
    }
}

struct ProxyCtx {
    name: String,
    log: bool,
    server_cfg: Arc<rustls::ServerConfig>,
    client_cfg: Arc<rustls::ClientConfig>,
}

/// Read an HTTP request head (up to and including the blank line).
/// Byte-at-a-time so we don't over-read into a CONNECT tunnel's body.
fn read_head(stream: &mut TcpStream) -> Result<String> {
    let mut buf = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    loop {
        let n = stream.read(&mut byte)?;
        if n == 0 {
            break;
        }
        buf.push(byte[0]);
        if buf.ends_with(b"\r\n\r\n") {
            break;
        }
        if buf.len() > 64 * 1024 {
            anyhow::bail!("request head too large");
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn handle_conn(mut client: TcpStream, ctx: &ProxyCtx) -> Result<()> {
    let log = ctx.log;
    // Guard against being an open proxy: only the guest (the VM's
    // subnet) and the local host may use it. This matters because the
    // proxy is meant to be bound where the guest can reach it
    // (0.0.0.0 / the gateway), which would otherwise expose an
    // allow-by-default forward proxy to the whole LAN.
    //
    // We also keep the peer around: brokered injection is re-attributed
    // against the EXACT lease at intercept time (see should_intercept),
    // not the coarse pre-lease /24 admission gate below — so a sibling on
    // the shared vz /24 can never have this VM's credential injected.
    let peer_ip = match client.peer_addr() {
        Ok(peer) => {
            if !peer_allowed(peer.ip(), &ctx.name) {
                if log {
                    eprintln!("egress: refusing non-guest peer {}", peer.ip());
                }
                return Ok(());
            }
            Some(peer.ip())
        }
        // No peer address (rare): admit (legacy behaviour) but never
        // broker-inject — an unattributable peer can't be the exact lease.
        Err(_) => None,
    };
    let head = read_head(&mut client)?;
    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or_default().to_string();
    let policy = proxy_policy(&ctx.name);

    if method.eq_ignore_ascii_case("CONNECT") {
        // target is `host:port`.
        let allowed = policy.allows(&target);
        let (host, port) = split_host_port(&target);
        // Scope TLS interception to hosts that actually carry a credential
        // rule, and only when the connecting peer is THIS VM's exact leased
        // guest IP (re-attributed here — see should_intercept).
        let intercept =
            peer_ip.is_some_and(|ip| should_intercept(&ctx.name, ip, allowed, policy.mitm, &host));
        if log {
            let action = if !allowed {
                "deny"
            } else if intercept {
                "allow+mitm"
            } else {
                "allow"
            };
            eprintln!("egress: CONNECT {target} -> {action}");
        }
        if !allowed {
            crate::traffic::record(&ctx.name, &host, port, "CONNECT", None, "deny");
            return refuse(&mut client, &target);
        }
        if intercept {
            // The client expects the tunnel up before its TLS hello.
            // intercept() records the decrypted request line itself.
            client.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")?;
            // No pre-validated addr on the legacy front door: `intercept`
            // resolves `host:port` itself, but now rejects any forbidden
            // (private/internal/host-LAN) result before dialing — a legit
            // public CONNECT host resolves public, so it still works.
            let target = mitm::MitmTarget {
                host: &host,
                port,
                upstream: None,
            };
            return mitm::intercept(
                &ctx.name,
                client,
                target,
                ctx.server_cfg.clone(),
                ctx.client_cfg.clone(),
                log,
            );
        }
        crate::traffic::record(&ctx.name, &host, port, "CONNECT", None, "allow");
        let upstream = TcpStream::connect(&target).with_context(|| format!("connect {target}"))?;
        client.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")?;
        splice(client, upstream)
    } else {
        // Plain HTTP: decide by the Host header (or the absolute-URI
        // authority in the request line).
        let host = header_value(&head, "host")
            .or_else(|| authority_of(&target))
            .unwrap_or_default();
        let allowed = !host.is_empty() && policy.allows(&host);
        if log {
            eprintln!(
                "egress: {method} {host} -> {}",
                if allowed { "allow" } else { "deny" }
            );
        }
        let req_path = target_path(&target);
        crate::traffic::record(
            &ctx.name,
            &host,
            80,
            &method,
            Some(&req_path),
            if allowed { "allow" } else { "deny" },
        );
        if !allowed {
            return refuse(&mut client, &host);
        }
        let port = 80;
        let dest = format!("{host}:{port}");
        let mut upstream = TcpStream::connect(&dest).with_context(|| format!("connect {dest}"))?;
        // Replay the head verbatim, then splice the rest both ways.
        upstream.write_all(head.as_bytes())?;
        splice(client, upstream)
    }
}

fn refuse(client: &mut TcpStream, host: &str) -> Result<()> {
    let body = format!("egress blocked by policy: {host}\n");
    let resp = format!(
        "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    client.write_all(resp.as_bytes())?;
    Ok(())
}

/// Pump bytes both directions until either side closes.
fn splice(client: TcpStream, upstream: TcpStream) -> Result<()> {
    let mut c_read = client.try_clone()?;
    let mut u_write = upstream.try_clone()?;
    let up = std::thread::spawn(move || {
        let _ = std::io::copy(&mut c_read, &mut u_write);
        let _ = u_write.shutdown(std::net::Shutdown::Write);
    });
    let mut u_read = upstream;
    let mut c_write = client;
    let _ = std::io::copy(&mut u_read, &mut c_write);
    let _ = c_write.shutdown(std::net::Shutdown::Write);
    let _ = up.join();
    Ok(())
}

fn header_value(head: &str, name: &str) -> Option<String> {
    head.lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case(name))
        .map(|(_, v)| v.trim().to_string())
}

/// Pull the authority out of an absolute request URI
/// (`http://host:port/path` → `host:port` → `host`).
fn authority_of(target: &str) -> Option<String> {
    let rest = target
        .strip_prefix("http://")
        .or_else(|| target.strip_prefix("https://"))?;
    let authority = rest.split('/').next().unwrap_or(rest);
    let host = authority.rsplit_once(':').map_or(authority, |(h, _)| h);
    (!host.is_empty()).then(|| host.to_string())
}

/// The path of a proxy request target: origin-form (`/path`) is
/// returned as-is; absolute-form (`http://host/path`) is reduced to
/// its path. Defaults to `/`.
fn target_path(target: &str) -> String {
    if let Some(rest) = target
        .strip_prefix("http://")
        .or_else(|| target.strip_prefix("https://"))
    {
        match rest.find('/') {
            Some(i) => rest[i..].to_string(),
            None => "/".to_string(),
        }
    } else if target.starts_with('/') {
        target.to_string()
    } else {
        "/".to_string()
    }
}

/// May this peer use the proxy *at all*? Loopback (local testing) always;
/// the guest otherwise. This is the coarse open-proxy admission gate, NOT
/// the brokered-injection gate: once this VM's leased guest IP is known we
/// pin to the EXACT address, but until then (very early boot) we fall back
/// to the backend-recorded subnet (WSL /20, vz /24) — tight enough to keep the wider LAN out of a
/// gateway/0.0.0.0-bound open proxy, while still admitting the guest before
/// its lease file lands so early-boot egress isn't refused.
///
/// The /24 fallback is deliberately coarse, so it must NEVER be what
/// authorises credential injection: a sibling VM sharing the vz /24 could
/// pass it during the victim's boot window. Brokered injection is gated
/// separately on the EXACT lease, re-attributed at intercept time
/// ([`peer_is_lease`]/[`should_intercept`]), so passing this gate only ever
/// buys a blind tunnel under the default policy — never another VM's key.
fn peer_allowed(peer: std::net::IpAddr, name: &str) -> bool {
    if peer.is_loopback() {
        return true;
    }
    let std::net::IpAddr::V4(peer) = peer else {
        return false; // vz NAT is IPv4-only
    };
    match guest_ip_v4(name) {
        // Steady state: only this VM's own guest IP.
        Some(ip) => peer == ip,
        // Pre-lease window only: the backend's last recorded NAT range.
        None => {
            let (anchor, prefix_len) = guest_admission_prefix(name);
            crate::network_lease::same_prefix(anchor, peer, prefix_len)
        }
    }
}

/// Should this allowed CONNECT be TLS-intercepted (decrypted, so the
/// proxy can broker the credential)?
///
/// Three gates beyond `allowed && mitm`:
///   * the host must carry a credential rule — decrypting *every* allowed
///     HTTPS host forces one request per CONNECT (the interceptor sends
///     `Connection: close`), breaking keep-alive + streaming (Anthropic's
///     SSE, the npm registry). Confining MITM to brokered hosts keeps
///     every other allowed host a blind, streaming-preserving tunnel.
///   * `peer` must be THIS VM's EXACT leased guest IP (or loopback — the
///     trusted local operator). The injection re-attributes the peer HERE,
///     at intercept time, rather than trusting the coarse pre-lease /24
///     admission gate ([`peer_allowed`]). That closes a TOCTOU on the NAT
///     path: during a victim's ~120s boot window `discover_guest_ip` is
///     still blocking, so the victim's guest-IP lease file isn't written
///     and `peer_allowed` falls back to the /24 — a co-resident sibling
///     sharing the vz /24 could pass that gate, stall its CONNECT (it
///     controls `read_head`'s pace) until the victim's lease lands, then
///     have THIS VM's brokered Anthropic credential injected into the
///     sibling's own request (billing/usage theft; the key never escapes).
///     Pinning injection to `peer == lease` refuses the sibling even inside
///     that window: until the lease is known there is no exact IP to match
///     (the brokered host stays a blind tunnel), and once known only the
///     lease holder is injected. The netstack path has no such window — its
///     per-VM link is L2-isolated, so every flow is intrinsically this VM's
///     own guest (the guard passes that deterministic guest IP).
pub(crate) fn should_intercept(
    name: &str,
    peer: std::net::IpAddr,
    allowed: bool,
    mitm: bool,
    host: &str,
) -> bool {
    allowed && mitm && peer_is_lease(peer, name) && crate::creds::has_cred_rule(name, host)
}

/// Is `peer` THIS VM's exact leased guest IP (or trusted loopback)? Unlike
/// [`peer_allowed`]'s coarse pre-lease /24 fallback, this never admits a
/// sibling: until the lease is known there is no exact address to match, so
/// it fails closed; once known, only the leased guest IP matches. This is
/// what the brokered-credential injection gate keys off, so the coarse /24
/// admission window can't be abused to borrow another VM's credential.
fn peer_is_lease(peer: std::net::IpAddr, name: &str) -> bool {
    if peer.is_loopback() {
        return true; // the host/operator testing locally
    }
    matches!((peer, guest_ip_v4(name)), (std::net::IpAddr::V4(p), Some(g)) if p == g)
}

/// This VM's leased guest IPv4, when known (written by the engine at
/// boot). `None` until the lease is discovered.
fn guest_ip_v4(name: &str) -> Option<std::net::Ipv4Addr> {
    std::fs::read_to_string(VmPaths::for_name(name).guest_ip())
        .ok()
        .and_then(|raw| raw.trim().parse::<std::net::Ipv4Addr>().ok())
}

/// Backend-recorded admission range retained across boots. WSL records
/// its gateway and dynamic prefix (normally /20); vz needs no files and
/// falls back to its stable 192.168.64.0/24 NAT.
fn guest_admission_prefix(name: &str) -> (std::net::Ipv4Addr, u8) {
    let paths = VmPaths::for_name(name);
    let gateway = std::fs::read_to_string(paths.gateway_ip())
        .ok()
        .and_then(|raw| raw.trim().parse().ok());
    let prefix_len = std::fs::read_to_string(paths.guest_prefix_len())
        .ok()
        .and_then(|raw| parse_guest_prefix_len(&raw));
    match (gateway, prefix_len) {
        (Some(gateway), Some(prefix_len)) => (gateway, prefix_len),
        _ => (std::net::Ipv4Addr::new(192, 168, 64, 1), 24),
    }
}

fn parse_guest_prefix_len(raw: &str) -> Option<u8> {
    raw.trim()
        .parse::<u8>()
        .ok()
        .filter(|prefix| (8..=32).contains(prefix))
}

/// The proxy URL a guest workload should point `HTTPS_PROXY` at,
/// derived from the VM's subnet gateway and the egress port.
///
/// A backend-recorded `gateway-ip` (the guest's real default gateway)
/// wins: the WSL NAT hands out a /20 whose gateway is NOT the `.1` of
/// the guest's /24, so deriving it from the guest IP points at nothing
/// there. Without the file (vz), fall back to the `.1` of the guest's
/// /24 — where the host sits on the vz NAT — and to the vz default
/// subnet when the guest IP isn't known yet.
pub fn guest_proxy_url(name: &str, port: u16) -> String {
    let paths = VmPaths::for_name(name);
    if let Some(gw) = std::fs::read_to_string(paths.gateway_ip())
        .ok()
        .and_then(|raw| raw.trim().parse::<std::net::Ipv4Addr>().ok())
    {
        return format!("http://{gw}:{port}");
    }
    let gw = std::fs::read_to_string(paths.guest_ip())
        .ok()
        .and_then(|raw| raw.trim().parse::<std::net::Ipv4Addr>().ok())
        .map(|ip| {
            let o = ip.octets();
            std::net::Ipv4Addr::new(o[0], o[1], o[2], 1)
        })
        .unwrap_or(std::net::Ipv4Addr::new(192, 168, 64, 1));
    format!("http://{gw}:{port}")
}

/// Split a CONNECT `host:port` target, defaulting to 443.
fn split_host_port(target: &str) -> (String, u16) {
    match target.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().unwrap_or(443)),
        None => (target.to_string(), 443),
    }
}

/// Default proxy port — clear of the k3d (5050) and microVM (5052)
/// registry ports and the ingress/api forwards. The default VM keeps
/// this; additional VMs get an allocated port (see VmSpec::allocate_ports).
pub const DEFAULT_EGRESS_PORT: u16 = 5053;

/// The egress port this VM actually binds, read from its persisted
/// spec so concurrent VMs don't collide. Falls back to the default
/// when the spec is missing (e.g. a not-yet-created VM).
pub fn vm_egress_port(name: &str) -> u16 {
    crate::store::load_spec(name)
        .ok()
        .flatten()
        .map(|spec| spec.egress_port)
        .unwrap_or(DEFAULT_EGRESS_PORT)
}

/// Kubernetes namespace the api-server + workloads live in (mirrors
/// DEFAULT_LOCAL_NAMESPACE in @appliance.sh/infra).
const CLUSTER_NAMESPACE: &str = "appliance";

/// NO_PROXY value for confined workloads: bypass the proxy for
/// cluster-internal destinations (kube API, services, the k3s pod/
/// service CIDRs) so only real outbound traffic is policed.
fn default_no_proxy() -> &'static str {
    "localhost,127.0.0.1,::1,.svc,.svc.cluster.local,.cluster.local,10.42.0.0/16,10.43.0.0/16,kubernetes.default"
}

pub fn runtime_no_proxy() -> &'static str {
    // Runtime principals share loopback only with their compound siblings;
    // every external host must remain on the cooperative proxy path.
    "localhost,127.0.0.1,::1"
}

fn which_kubectl() -> Option<PathBuf> {
    // HOME on Unix; USERPROFILE for PowerShell/desktop launches on
    // Windows, which don't set HOME (same fallback as store::vm_root).
    if let Some(home) = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
    {
        let managed = home.join(".appliance").join("bin").join("kubectl");
        if managed.is_file() {
            return Some(managed);
        }
    }
    // Fall back to PATH resolution by name.
    Some(PathBuf::from("kubectl"))
}

/// Render the `appliance-egress` ConfigMap the in-VM api-server reads
/// to inject proxy + CA into workloads. `ca` (PEM) is embedded only
/// when interception is on.
fn render_configmap(proxy_url: &str, no_proxy: &str, mitm: bool, ca: Option<&str>) -> String {
    let mut out = format!(
        "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: appliance-egress\n  namespace: {CLUSTER_NAMESPACE}\n  labels:\n    app.kubernetes.io/managed-by: appliance.sh\ndata:\n  proxyUrl: {proxy_url:?}\n  noProxy: {no_proxy:?}\n  mitm: {:?}\n",
        if mitm { "true" } else { "false" }
    );
    if let Some(pem) = ca {
        out.push_str("  ca.crt: |\n");
        for line in pem.lines() {
            out.push_str("    ");
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

/// Publish the current egress policy into the cluster as the
/// `appliance-egress` ConfigMap. Best-effort: needs the VM up
/// (kubeconfig present) and kubectl available; silently no-ops
/// otherwise so policy edits never fail on a down cluster.
pub fn publish_configmap(name: &str) -> Result<()> {
    let kubeconfig = VmPaths::for_name(name).kubeconfig();
    if !kubeconfig.exists() {
        return Ok(());
    }
    let Some(kubectl) = which_kubectl() else {
        return Ok(());
    };
    let kc = kubeconfig.to_string_lossy();
    let policy = load_policy(name);

    // Inert policy → no confinement: remove any prior ConfigMap so the
    // api-server stops routing workloads through the proxy.
    if !policy.is_active() {
        let _ = Command::new(&kubectl)
            .args([
                "--kubeconfig",
                &kc,
                "-n",
                CLUSTER_NAMESPACE,
                "delete",
                "configmap",
                "appliance-egress",
                "--ignore-not-found",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        return Ok(());
    }

    let proxy_url = guest_proxy_url(name, vm_egress_port(name));
    let ca = if policy.mitm {
        std::fs::read_to_string(mitm::ca_cert_path(name)).ok()
    } else {
        None
    };
    let manifest = render_configmap(&proxy_url, default_no_proxy(), policy.mitm, ca.as_deref());

    let mut child = match Command::new(&kubectl)
        .args(["--kubeconfig", &kc, "apply", "-f", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return Ok(()), // kubectl missing → skip
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(manifest.as_bytes());
    }
    let _ = child.wait();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(default: Action, allow: &[&str], deny: &[&str]) -> EgressPolicy {
        EgressPolicy {
            default,
            allow: allow.iter().map(|s| s.to_string()).collect(),
            deny: deny.iter().map(|s| s.to_string()).collect(),
            mitm: false,
        }
    }

    #[test]
    fn default_allow_passes_everything() {
        let p = policy(Action::Allow, &[], &[]);
        assert!(p.allows("example.com:443"));
        assert!(p.allows("anything.test:80"));
    }

    #[test]
    fn default_deny_blocks_unless_allowlisted() {
        let p = policy(Action::Deny, &["github.com"], &[]);
        assert!(p.allows("github.com:443"));
        assert!(p.allows("api.github.com:443"));
        assert!(!p.allows("evil.test:443"));
    }

    #[test]
    fn deny_wins_over_allow() {
        let p = policy(Action::Allow, &["github.com"], &["gist.github.com"]);
        assert!(p.allows("github.com:443"));
        assert!(!p.allows("gist.github.com:443"));
    }

    #[test]
    fn suffix_does_not_match_substring() {
        let p = policy(Action::Deny, &["github.com"], &[]);
        // notgithub.com must NOT be treated as a subdomain of github.com
        assert!(!p.allows("notgithub.com:443"));
    }

    #[test]
    fn host_without_port_is_handled() {
        let p = policy(Action::Deny, &["example.com"], &[]);
        assert!(p.allows("example.com"));
    }

    #[test]
    fn peer_guard_allows_loopback_and_guest_subnet() {
        // No guest-ip file for this fake name → default vz subnet.
        let name = "egress-peer-test-unused";
        assert!(peer_allowed("127.0.0.1".parse().unwrap(), name));
        assert!(peer_allowed("::1".parse().unwrap(), name));
        assert!(peer_allowed("192.168.64.7".parse().unwrap(), name));
    }

    #[test]
    fn peer_guard_refuses_lan_and_ipv6() {
        let name = "egress-peer-test-unused";
        // A typical home-LAN address must not be able to use the proxy.
        assert!(!peer_allowed("192.168.1.50".parse().unwrap(), name));
        assert!(!peer_allowed("10.0.0.5".parse().unwrap(), name));
        // Non-loopback IPv6 isn't on the vz NAT.
        assert!(!peer_allowed("fd00::1".parse().unwrap(), name));
    }

    #[test]
    fn peer_guard_uses_recorded_wsl_prefix_before_exact_lease() {
        let name = "egress-peer-test-wsl-prefix";
        let paths = VmPaths::for_name(name);
        let _ = std::fs::remove_dir_all(&paths.dir);
        std::fs::create_dir_all(&paths.dir).unwrap();
        std::fs::write(paths.gateway_ip(), "172.25.64.1\n").unwrap();
        std::fs::write(paths.guest_prefix_len(), "20\n").unwrap();

        assert!(peer_allowed("172.25.66.42".parse().unwrap(), name));
        assert!(peer_allowed("172.25.79.254".parse().unwrap(), name));
        assert!(!peer_allowed("172.25.80.1".parse().unwrap(), name));

        let _ = std::fs::remove_dir_all(&paths.dir);
    }

    #[test]
    fn peer_guard_rejects_corrupt_overbroad_prefixes() {
        for prefix in ["0", "2", "7", "33"] {
            assert_eq!(parse_guest_prefix_len(prefix), None);
        }
        assert_eq!(parse_guest_prefix_len("8\n"), Some(8));
        assert_eq!(parse_guest_prefix_len("32"), Some(32));
    }

    #[test]
    fn peer_guard_pins_exact_guest_ip_when_known() {
        // With the lease known, only this VM's exact guest IP is allowed:
        // a sibling VM sharing the /24 (which the old subnet gate let
        // through) must be refused so it can't borrow the brokered key.
        let name = "egress-peer-test-exact";
        let dir = VmPaths::for_name(name).dir;
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(VmPaths::for_name(name).guest_ip(), "192.168.64.7\n").unwrap();
        assert!(peer_allowed("192.168.64.7".parse().unwrap(), name)); // this VM
        assert!(peer_allowed("127.0.0.1".parse().unwrap(), name)); // loopback always
        assert!(!peer_allowed("192.168.64.8".parse().unwrap(), name)); // sibling VM
        assert!(!peer_allowed("192.168.64.1".parse().unwrap(), name)); // the gateway/host
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn proxy_url_prefers_the_recorded_gateway() {
        // WSL's NAT is a /20 — the real gateway (recorded by the backend
        // at boot) must win over the vz-style ".1 of the guest's /24"
        // derivation, which points at nothing there.
        let name = "egress-gateway-test";
        let dir = VmPaths::for_name(name).dir;
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(VmPaths::for_name(name).guest_ip(), "172.25.66.42\n").unwrap();
        // No recorded gateway → the /24 fallback.
        assert_eq!(guest_proxy_url(name, 5053), "http://172.25.66.1:5053");
        // Recorded gateway → used verbatim.
        std::fs::write(VmPaths::for_name(name).gateway_ip(), "172.25.64.1\n").unwrap();
        assert_eq!(guest_proxy_url(name, 5053), "http://172.25.64.1:5053");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn brokered_injection_requires_exact_lease_peer() {
        // The pre-lease TOCTOU fix (A2a): brokered injection is gated on the
        // peer being THIS VM's exact leased guest IP, re-attributed at
        // intercept time — never the coarse pre-lease /24 admission gate. So
        // a co-resident sibling sharing the vz /24 (which `peer_allowed`'s
        // pre-lease fallback would admit) is refused injection even if it
        // stalls its CONNECT until the victim's lease lands mid-window.
        let name = "egress-intercept-exact-lease";
        let dir = VmPaths::for_name(name).dir;
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        crate::creds::upsert_rule(
            name,
            crate::creds::CredentialRule {
                host: "api.anthropic.com".into(),
                capture: false,
                inject: true,
                header: "x-api-key".into(),
                helper: Some(crate::creds::resolving_test_helper()),
            },
        )
        .unwrap();

        let this_vm: std::net::IpAddr = "192.168.64.7".parse().unwrap();
        let sibling: std::net::IpAddr = "192.168.64.8".parse().unwrap();
        let loopback: std::net::IpAddr = "127.0.0.1".parse().unwrap();

        // Pre-lease (no guest-ip file): there is no exact IP to match, so
        // even the eventual lease holder gets a blind tunnel, not injection.
        assert!(!should_intercept(
            name,
            this_vm,
            true,
            true,
            "api.anthropic.com"
        ));
        // And the sibling that passed the coarse /24 admission gate is refused.
        assert!(!should_intercept(
            name,
            sibling,
            true,
            true,
            "api.anthropic.com"
        ));

        // The victim's lease lands mid-window: injection resumes — but ONLY
        // for this VM's exact IP. The sibling that stalled its CONNECT across
        // the lease write is STILL refused; re-attributing at intercept time
        // is what closes the TOCTOU.
        std::fs::write(VmPaths::for_name(name).guest_ip(), "192.168.64.7\n").unwrap();
        assert!(should_intercept(
            name,
            this_vm,
            true,
            true,
            "api.anthropic.com"
        ));
        assert!(!should_intercept(
            name,
            sibling,
            true,
            true,
            "api.anthropic.com"
        ));
        // Loopback (the trusted local operator) is always injectable.
        assert!(should_intercept(
            name,
            loopback,
            true,
            true,
            "api.anthropic.com"
        ));

        // The other gates still hold: brokered host only, allowed + mitm.
        assert!(!should_intercept(name, this_vm, true, true, "example.com"));
        assert!(!should_intercept(
            name,
            this_vm,
            false,
            true,
            "api.anthropic.com"
        ));
        assert!(!should_intercept(
            name,
            this_vm,
            true,
            false,
            "api.anthropic.com"
        ));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn authority_of_extracts_host() {
        assert_eq!(
            authority_of("http://example.com/path").as_deref(),
            Some("example.com")
        );
        assert_eq!(
            authority_of("http://example.com:8080/p").as_deref(),
            Some("example.com")
        );
        assert_eq!(
            authority_of("https://api.test").as_deref(),
            Some("api.test")
        );
        assert_eq!(authority_of("/just/a/path"), None);
    }

    #[test]
    fn configmap_embeds_policy_and_quotes_values() {
        let cm = render_configmap(
            "http://192.168.64.1:5053",
            "localhost,.svc",
            true,
            Some("PEMDATA"),
        );
        assert!(cm.contains("kind: ConfigMap"));
        assert!(cm.contains("name: appliance-egress"));
        assert!(cm.contains("namespace: appliance"));
        assert!(cm.contains("proxyUrl: \"http://192.168.64.1:5053\""));
        assert!(cm.contains("noProxy: \"localhost,.svc\""));
        assert!(cm.contains("mitm: \"true\""));
        // CA embedded as an indented block scalar.
        assert!(cm.contains("ca.crt: |\n    PEMDATA"));
    }

    #[test]
    fn configmap_omits_ca_when_mitm_off() {
        let cm = render_configmap("http://x:5053", "localhost", false, None);
        assert!(cm.contains("mitm: \"false\""));
        assert!(!cm.contains("ca.crt"));
    }

    #[test]
    fn split_host_port_defaults_to_443() {
        assert_eq!(
            split_host_port("example.com:8443"),
            ("example.com".to_string(), 8443)
        );
        assert_eq!(
            split_host_port("example.com"),
            ("example.com".to_string(), 443)
        );
        // Garbage port falls back to 443 rather than panicking.
        assert_eq!(
            split_host_port("example.com:notaport"),
            ("example.com".to_string(), 443)
        );
    }

    #[test]
    fn netstack_policy_forces_deny_and_bakes_allowlist() {
        // The persisted file keeps the serde-default Allow + an operator
        // rule; the effective Netstack policy forces Deny and merges the
        // baked allowlist over the operator's allow (deny still wins).
        let name = "egress-netstack-policy-test";
        let dir = VmPaths::for_name(name).dir;
        let _ = std::fs::create_dir_all(&dir);
        save_policy(
            name,
            &EgressPolicy {
                default: Action::Allow,
                allow: vec!["internal.corp".into()],
                deny: vec!["gist.github.com".into()],
                mitm: false,
            },
        )
        .unwrap();

        let eff = netstack_policy(name);
        // Default flipped to Deny regardless of the persisted Allow.
        assert_eq!(eff.default, Action::Deny);
        // Baked hosts are reachable; the operator's own allow survives.
        assert!(eff.allows("api.anthropic.com:443"));
        assert!(eff.allows("github.com:443"));
        assert!(eff.allows("internal.corp:443"));
        // Multi-agent bakes: Codex's api.openai.com and Copilot's model leg
        // (suffix-matched: api.githubcopilot.com) are reachable. Copilot's
        // PAT-broker leg api.github.com is covered by the github.com suffix.
        assert!(eff.allows("api.openai.com:443"));
        assert!(eff.allows("api.githubcopilot.com:443"));
        assert!(eff.allows("api.github.com:443"));
        // Deny still wins, and everything off-list is refused.
        assert!(!eff.allows("gist.github.com:443"));
        assert!(!eff.allows("evil.test:443"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn render_effective_distinguishes_baked_operator_and_deny_for_netstack() {
        let persisted = EgressPolicy {
            default: Action::Allow, // persisted serde-default — overridden on display
            allow: vec!["internal.corp".into(), "github.com".into()],
            deny: vec!["gist.github.com".into()],
            mitm: false,
        };
        let out = render_effective_policy("agent", &persisted, true);

        // The EFFECTIVE boundary is shown as Deny, not the persisted Allow.
        assert!(out.contains("boundary: enforced (netstack)"));
        assert!(out.contains("default: DENY"));
        assert!(!out.contains("default: ALLOW"));

        // Baked-allow is its own section and lists the baked hosts.
        assert!(out.contains("baked allowlist (always-on for Netstack VMs):"));
        assert!(out.contains("✓ api.anthropic.com"));
        assert!(out.contains("✓ github.com")); // baked, shown under baked

        // Operator-allow is distinct from baked: `internal.corp` is the
        // operator's own rule; `github.com` is filtered out as baked.
        assert!(out.contains("operator allow rules:"));
        assert!(out.contains("✓ internal.corp"));

        // Operator-deny wins and is called out.
        assert!(out.contains("operator deny rules (deny wins over any allow):"));
        assert!(out.contains("✗ gist.github.com"));
    }

    #[test]
    fn render_effective_keeps_nat_persisted_default() {
        // A NAT VM shows its persisted (cooperative) policy as-is — default
        // Allow, no baked allowlist, behaviour unchanged.
        let persisted = EgressPolicy {
            default: Action::Allow,
            allow: vec!["example.com".into()],
            deny: vec![],
            mitm: true,
        };
        let out = render_effective_policy("dev", &persisted, false);
        assert!(out.contains("boundary: cooperative (in-guest proxy)"));
        assert!(out.contains("default: ALLOW"));
        assert!(!out.contains("baked allowlist"));
        assert!(out.contains("✓ example.com"));
        assert!(out.contains("TLS interception (mitm): on"));
    }

    #[test]
    fn policy_output_labels_both_boundary_kinds() {
        let policy = EgressPolicy::default();
        let enforced = EgressPolicyOutput::for_backend(policy.clone(), true, "vz", WslMode::Strict);
        let cooperative =
            EgressPolicyOutput::for_backend(policy, false, "wsl", WslMode::Cooperative);

        assert_eq!(enforced.boundary, EgressBoundary::Enforced);
        assert_eq!(enforced.boundary.label(), "enforced (netstack)");
        assert_eq!(cooperative.boundary, EgressBoundary::Cooperative);
        assert_eq!(cooperative.boundary.label(), "cooperative (in-guest proxy)");
        let enforced_json = serde_json::to_value(enforced).unwrap();
        let cooperative_json = serde_json::to_value(cooperative).unwrap();
        assert_eq!(enforced_json["boundary"], "enforced");
        assert_eq!(enforced_json["enforcement"]["backend"], "vz");
        assert_eq!(enforced_json["enforcement"]["bypassable"], false);
        assert_eq!(cooperative_json["boundary"], "cooperative");
        assert_eq!(cooperative_json["enforcement"]["backend"], "wsl");
        assert_eq!(cooperative_json["enforcement"]["bypassable"], true);
        assert_eq!(cooperative_json["enforcement"]["scope"], serde_json::json!(["http", "https"]));
        assert_eq!(cooperative_json["wslMode"], "cooperative");
    }

    #[test]
    fn wsl_rendering_uses_truthful_mode_headers_and_never_host_enforced() {
        let policy = EgressPolicy { default: Action::Deny, allow: vec![], deny: vec![], mitm: false };
        let strict = render_effective_policy_for_backend("runtime", &policy, true, "wsl", WslMode::Strict);
        assert!(strict.starts_with("WSL NAT — strict: apps with egress grants are refused\n"));
        assert!(!strict.contains("host-enforced"));
        let cooperative =
            render_effective_policy_for_backend("runtime", &policy, true, "wsl", WslMode::Cooperative);
        assert!(cooperative.starts_with(
            "WSL NAT — cooperative proxy, bypassable; direct TCP/UDP is not blocked\n"
        ));
        assert!(!cooperative.contains("host-enforced"));
    }

    #[test]
    fn render_effective_marks_baked_host_overridden_by_deny() {
        // The recommended hardening (doc §8.1 #6): deny `github.com` on a
        // Netstack VM. The baked entry must render as overridden, not as a
        // live allow, so the operator sees the boundary really blocks it.
        let persisted = EgressPolicy {
            default: Action::Allow,
            allow: vec![],
            deny: vec!["github.com".into()],
            mitm: false,
        };
        let out = render_effective_policy("agent", &persisted, true);
        assert!(out.contains("✗ github.com  (overridden by an operator deny rule)"));
    }

    fn runtime_json(allow: &[&str], mitm: bool) -> String {
        let allow_ports = allow
            .iter()
            .map(|host| ((*host).to_string(), vec![443u16]))
            .collect::<BTreeMap<_, _>>();
        serde_json::json!({
            "version": 1,
            "app": "journal",
            "vm": "appliance-runtime",
            "principal": "journal",
            "source": "192.168.127.10",
            "policy": { "default": "allow", "allow": allow, "deny": [], "mitm": mitm },
            "allowPorts": allow_ports
        })
        .to_string()
    }

    fn runtime_policy(app: &str, source: Ipv4Addr, port: u16) -> RuntimePolicy {
        RuntimePolicy {
            version: 1,
            app: app.to_string(),
            service: None,
            vm: "appliance-runtime".to_string(),
            principal: app.to_string(),
            source,
            policy: EgressPolicy {
                default: Action::Deny,
                allow: vec!["example.com".to_string()],
                deny: Vec::new(),
                mitm: true,
            },
            allow_ports: BTreeMap::from([("example.com".to_string(), vec![port])]),
        }
    }

    #[test]
    fn wsl_cooperative_policy_unions_runtime_hosts_while_strict_denies_all() {
        let persisted = EgressPolicy {
            default: Action::Allow,
            allow: vec!["legacy.example".into()],
            deny: vec!["blocked.example.com".into()],
            mitm: true,
        };
        let mut journal = runtime_policy("journal", "192.168.127.10".parse().unwrap(), 443);
        journal.policy.allow = vec!["api.example.com".into()];
        let mut notes = runtime_policy("notes", "192.168.127.11".parse().unwrap(), 443);
        notes.policy.allow = vec!["sync.example.com".into(), "api.example.com".into()];
        let cooperative =
            union_wsl_runtime_policy(&persisted, &[journal, notes], WslMode::Cooperative);
        assert_eq!(cooperative.default, Action::Deny);
        assert_eq!(cooperative.allow, vec!["api.example.com", "sync.example.com"]);
        assert_eq!(cooperative.deny, vec!["blocked.example.com"]);
        assert!(cooperative.mitm);

        let strict = union_wsl_runtime_policy(&persisted, &[], WslMode::Strict);
        assert_eq!(strict.default, Action::Deny);
        assert!(strict.allow.is_empty());
        assert!(!strict.mitm);
    }

    #[test]
    fn pruning_a_vm_removes_all_of_its_runtime_principals_only() {
        with_runtime_test_root("delete-prune", |_root| {
            let mut journal = runtime_policy("journal", Ipv4Addr::new(192, 168, 127, 10), 443);
            let mut notes = runtime_policy("notes", Ipv4Addr::new(192, 168, 127, 11), 443);
            let mut other = runtime_policy("other", Ipv4Addr::new(192, 168, 127, 12), 443);
            journal.vm = "deleted-runtime".into();
            notes.vm = "deleted-runtime".into();
            other.vm = "surviving-runtime".into();
            save_runtime_policy(&journal).unwrap();
            save_runtime_policy(&notes).unwrap();
            save_runtime_policy(&other).unwrap();

            let removed = prune_runtime_policies_for_vm("deleted-runtime");
            assert_eq!(removed.len(), 2);
            assert!(removed.into_iter().all(|(_, result)| result.unwrap()));
            assert!(runtime_policy_for_principal("deleted-runtime", "journal").is_none());
            assert!(runtime_policy_for_principal("deleted-runtime", "notes").is_none());
            assert_eq!(runtime_policy_for_principal("surviving-runtime", "other"), Some(other));
        });
    }

    #[test]
    fn proxy_keeps_vz_on_persisted_policy_without_the_netstack_baked_allowlist() {
        let name = format!("egress-vz-proxy-selection-{}", std::process::id());
        let mut spec = crate::spec::VmSpec::defaults(&name);
        spec.runtime = true;
        spec.net_link = NetLink::Netstack;
        crate::store::save_spec(&spec).unwrap();
        let persisted = EgressPolicy {
            default: Action::Deny,
            allow: vec!["operator.example".into()],
            deny: vec![],
            mitm: false,
        };
        save_policy(&name, &persisted).unwrap();

        let selected = proxy_policy_for_backend(&name, "vz");
        assert_eq!(selected, persisted);
        assert!(!selected.allows("api.openai.com:443"));

        crate::store::delete_vm_dir(&name).unwrap();
    }

    #[test]
    fn runtime_policy_is_default_deny_and_hostname_only() {
        let runtime = parse_runtime_policy(&runtime_json(&["*.Example.COM."], true)).unwrap();
        assert_eq!(runtime.policy.default, Action::Deny);
        assert_eq!(runtime.policy.allow, vec!["example.com"]);
        assert!(runtime.policy.allows("api.example.com"));
        assert!(runtime.allows_host_port("api.example.com", 443));
        assert!(!runtime.allows_host_port("api.example.com", 8443));
        assert!(!runtime.policy.allows("not-example.test"));

        for invalid in [
            "1.2.3.4",
            "10.0.0.0/8",
            "https://example.com",
            "com",
            "user@example.com",
        ] {
            assert!(
                parse_runtime_policy(&runtime_json(&[invalid], true)).is_err(),
                "accepted {invalid}"
            );
        }
    }

    #[test]
    fn absent_runtime_principal_fails_closed_without_baked_allowlist() {
        let context = PolicyContext::Unknown {
            source: "192.168.127.99".parse().unwrap(),
        };
        let policy = context.policy();
        assert_eq!(policy.default, Action::Deny);
        assert!(!policy.allows("api.openai.com"));
        assert!(!policy.mitm);
    }

    #[test]
    fn runtime_policy_dispatch_round_trip_duplicates_and_port_gate() {
        with_runtime_test_root("dispatch", |_root| {
            let source = Ipv4Addr::new(192, 168, 127, 10);
            let runtime = runtime_policy("journal", source, 443);
            save_runtime_policy(&runtime).unwrap();

            let loaded = runtime_policy_for_principal("appliance-runtime", "journal").unwrap();
            assert_eq!(loaded, runtime, "saved policy must round-trip");
            assert!(matches!(
                policy_for("appliance-runtime", crate::netstack::GUEST_IP),
                PolicyContext::Legacy(policy) if policy.allows("api.openai.com")
            ));
            assert!(matches!(
                policy_for("appliance-runtime", source),
                PolicyContext::Runtime(found) if found == runtime
            ));
            assert!(matches!(
                policy_for("appliance-runtime", Ipv4Addr::new(192, 168, 127, 11)),
                PolicyContext::Unknown { .. }
            ));

            // The host is allowlisted but only for 443. The executor must
            // reject the port-80 flow before DNS/dial and attribute the log.
            let request = b"GET / HTTP/1.1\r\nHost: example.com\r\n\r\n";
            let (probe, ext) = crate::netstack::testkit::bridge(request, true);
            crate::netstack::guard::serve_outbound(
                "appliance-runtime",
                source,
                "93.184.216.34:80".parse().unwrap(),
                ext,
                &crate::netstack::guard::Resolved::new(),
            );
            assert!(!probe.aborted(), "plain HTTP denial returns a 403");
            assert!(probe.ext_finished());
            assert!(probe.ext_bytes().starts_with(b"HTTP/1.1 403 Forbidden"));
            let events = crate::traffic::tail_runtime("journal", 10);
            let denied = events.last().expect("runtime deny log");
            assert_eq!(denied.decision, "deny");
            assert_eq!(denied.principal.as_deref(), Some("journal"));
            assert_eq!(denied.host, "example.com");
            assert_eq!(denied.port, 80);
            assert_eq!(denied.reason.as_deref(), Some("policy"));

            // An external controller may atomically replace the effective
            // file. The mtime/inode cache must observe the new grant without
            // reparsing unchanged files on every flow.
            let mut replacement = runtime.clone();
            replacement.policy.mitm = false;
            let policy_path = runtime_policy_path("journal").unwrap();
            let replacement_path = policy_path.with_extension("replacement");
            write_private(
                &replacement_path,
                serde_json::to_vec_pretty(&replacement).unwrap().as_slice(),
            )
            .unwrap();
            std::fs::rename(replacement_path, &policy_path).unwrap();
            assert!(matches!(
                policy_for("appliance-runtime", source),
                PolicyContext::Runtime(found) if !found.policy.mitm
            ));

            // A duplicate (vm, source) is ambiguous and therefore unknown.
            save_runtime_policy(&runtime_policy("journal-copy", source, 443)).unwrap();
            assert!(matches!(
                policy_for("appliance-runtime", source),
                PolicyContext::Unknown { .. }
            ));
        });
    }

    #[test]
    fn save_runtime_policy_refuses_corrupt_existing_file() {
        with_runtime_test_root("corrupt-save", |root| {
            let runtime = runtime_policy("journal", Ipv4Addr::new(192, 168, 127, 10), 443);
            let path = root.join("journal/effective.json");
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, b"{ stale and corrupt").unwrap();

            let error = save_runtime_policy(&runtime).unwrap_err();
            assert!(error.to_string().contains("refuse to replace invalid"));
            assert_eq!(std::fs::read(&path).unwrap(), b"{ stale and corrupt");
        });
    }

    #[test]
    fn runtime_inspection_decision_matrix_is_policy_and_allowed_only() {
        for (mitm, allowed, expected) in [
            (false, false, false),
            (false, true, false),
            (true, false, false),
            (true, true, true),
        ] {
            let policy = EgressPolicy {
                default: Action::Deny,
                allow: vec![],
                deny: vec![],
                mitm,
            };
            assert_eq!(should_inspect_runtime(&policy, allowed), expected);
        }
    }
}
