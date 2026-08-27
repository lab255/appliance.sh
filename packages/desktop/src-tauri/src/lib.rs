mod terminal;

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

// Keychain service is shared across all Appliance Desktop installs on
// the machine. Each cluster's API key lives at account
// `cluster:<uuid>`. The legacy single-cluster account (`api-key`) is
// migrated to the new layout on first launch and then removed.
const KEYCHAIN_SERVICE: &str = "sh.appliance.desktop";
const LEGACY_KEYCHAIN_ACCOUNT: &str = "api-key";
const CONFIG_FILE: &str = "config.json";

fn cluster_keychain_account(cluster_id: &str) -> String {
    format!("cluster:{cluster_id}")
}

#[derive(Debug, thiserror::Error)]
enum HostError {
    #[error("config I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("config serialize: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("keychain: {0}")]
    Keyring(#[from] keyring::Error),
    #[error("tauri: {0}")]
    Tauri(#[from] tauri::Error),
    #[error("cluster not found: {0}")]
    ClusterNotFound(String),
}

impl serde::Serialize for HostError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Serialize, Deserialize, Clone)]
struct ApiKey {
    id: String,
    secret: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Cluster {
    id: String,
    name: String,
    api_server_url: String,
    created_at: String,
    // Pulumi state backend URL (e.g. `s3://us-east-1-state-...`)
    // for clusters bootstrapped from this device. Persisted so the
    // Settings page can run state promotion (phase 3) on demand.
    // Absent on clusters added via the Connect page (manual entry)
    // or migrated from the legacy single-cluster shape.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    state_backend_url: Option<String>,
    // Original BootstrapInput the wizard collected, stored as an
    // opaque JSON value (the schema lives in @appliance.sh/bootstrap;
    // the Rust side just round-trips it). Reused by the Settings
    // page's "Update baseline" action so phase 1 re-runs with the
    // same dns.createZone / vpc / region choices and doesn't flip
    // declarative state on the operator. Absent for clusters added
    // before this field landed, and for clusters added via Connect.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_bootstrap_input: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    install_generation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cloud_formation_stack_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    aws_account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    aws_region: Option<String>,
    // Key id last copied into the keychain from the shared profile.
    // Only set on CLI-managed adoptions (the microVM cluster): it
    // lets the recurring sync detect a CLI re-key by comparing files,
    // without a keychain read — which macOS gates behind an access
    // prompt when the binary's signing identity changed (every dev
    // rebuild).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    synced_key_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostConfig {
    clusters: Vec<Cluster>,
    selected_cluster_id: Option<String>,
    api_key: Option<ApiKey>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum AppMode {
    User,
    Developer,
}

// Persisted config supports both the new multi-cluster shape and the
// legacy `apiServerUrl`-only shape. Legacy reads are migrated on first
// `get_config` call (see `migrate_legacy`).
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistedConfig {
    #[serde(default)]
    clusters: Vec<Cluster>,
    #[serde(default)]
    selected_cluster_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    app_mode: Option<AppMode>,
    // Legacy single-cluster field. Kept (skipped when serialising
    // the new shape) only as a migration source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_server_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddClusterInput {
    name: String,
    api_server_url: String,
    api_key: ApiKey,
    #[serde(default)]
    state_backend_url: Option<String>,
    #[serde(default)]
    last_bootstrap_input: Option<serde_json::Value>,
    #[serde(default)]
    install_generation: Option<String>,
    #[serde(default)]
    cloud_formation_stack_name: Option<String>,
    #[serde(default)]
    aws_account_id: Option<String>,
    #[serde(default)]
    aws_region: Option<String>,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, HostError> {
    let dir = app.path().app_config_dir()?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join(CONFIG_FILE))
}

// ============================================================
// Shared profile store: ~/.appliance/profiles.json
//
// CREDENTIAL MODEL (E4.4, Keychain-first — see docs/control-plane.md §5):
//   * macOS: the OS Keychain (account `cluster:<id>`) is the CANONICAL
//     store for each desktop-managed cluster's secret. profiles.json
//     carries only metadata (apiUrl, keyId, name, …) with an EMPTY
//     secret, and the CLI reads the secret back from the Keychain. The
//     secret is therefore never duplicated to cleartext on disk.
//   * non-macOS (Linux/cloud/CI): profiles.json (mode 0600) is the
//     canonical store, since the CLI cannot read libsecret/DPAPI. The
//     desktop dual-writes the secret to the file there, as before.
//
// The desktop runs in DUAL-MODE persistence:
//   1. The OS keychain holds each cluster's API key secret (account
//      `cluster:<id>`). The canonical secret store on macOS.
//   2. The legacy <app-config>/config.json holds cluster metadata
//      (name, URL, createdAt, etc.) — kept as a mirror so a downgrade
//      to the previous desktop binary remains non-destructive.
//   3. ~/.appliance/profiles.json mirrors metadata (and, on non-macOS,
//      the secret) in a format the CLI reads directly. Updated on every
//      persisted write so the CLI sees the same clusters the desktop sees.
//
// Reads prefer the legacy file when it has clusters; otherwise the
// shared file is ingested into the legacy stores so the rest of the
// code path is unchanged.
// ============================================================

const SHARED_PROFILES_DIR: &str = ".appliance";
const SHARED_PROFILES_FILE: &str = "profiles.json";
const CATALOGUE_DIR: &str = "catalogue";
const CATALOGUE_CACHE_FILE: &str = "verified-pair.json";

#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SharedProfileEntry {
    api_url: String,
    key_id: String,
    secret: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    state_backend_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_bootstrap_input: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    install_generation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cloud_formation_stack_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    aws_account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    aws_region: Option<String>,
    /// Which surface created the profile ("desktop" | "cli"). Used by
    /// the desktop's mirror step to only rewrite its own entries and
    /// leave CLI-managed profiles alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    managed: Option<String>,
    /// Human label for the profile; the map key is the slug/id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SharedProfilesFile {
    #[serde(default = "shared_profiles_version")]
    version: u32,
    #[serde(default)]
    active_profile: Option<String>,
    #[serde(default)]
    profiles: BTreeMap<String, SharedProfileEntry>,
}

fn shared_profiles_version() -> u32 {
    1
}

impl Default for SharedProfilesFile {
    fn default() -> Self {
        Self {
            version: 1,
            active_profile: None,
            profiles: BTreeMap::new(),
        }
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CatalogueCache {
    index_json: String,
    signature_json: String,
    fetched_at: String,
    highest_generation: u64,
    max_seen_wall_clock: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetCatalogueCacheInput {
    index_json: String,
    signature_json: String,
    fetched_at: String,
    generation: u64,
    verified_at: String,
}

fn catalogue_cache_path() -> Result<PathBuf, HostError> {
    home_dir()
        .map(|home| {
            home.join(SHARED_PROFILES_DIR)
                .join(CATALOGUE_DIR)
                .join(CATALOGUE_CACHE_FILE)
        })
        .ok_or_else(|| std::io::Error::other("cannot resolve the home directory").into())
}

fn catalogue_cache_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read_catalogue_cache(path: &std::path::Path) -> Result<Option<CatalogueCache>, HostError> {
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_slice(&fs::read(path)?)?))
}

fn write_catalogue_cache(path: &std::path::Path, cache: &CatalogueCache) -> Result<(), HostError> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("catalogue cache path has no parent"))?;
    fs::create_dir_all(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    }

    let temporary = path.with_extension("json.tmp");
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    std::io::Write::write_all(&mut file, &serde_json::to_vec(cache)?)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temporary, path)?;
    #[cfg(unix)]
    fs::set_permissions(path, {
        use std::os::unix::fs::PermissionsExt;
        fs::Permissions::from_mode(0o600)
    })?;
    Ok(())
}

fn next_catalogue_cache(
    current: Option<&CatalogueCache>,
    input: SetCatalogueCacheInput,
) -> Result<CatalogueCache, HostError> {
    let current_generation = current.map_or(0, |cache| cache.highest_generation);
    if input.generation < current_generation {
        return Err(std::io::Error::other(format!(
            "catalogue generation {} is below persisted floor {}",
            input.generation, current_generation
        ))
        .into());
    }
    let max_seen_wall_clock = match current {
        Some(cache)
            if chrono::DateTime::parse_from_rfc3339(&cache.max_seen_wall_clock).map_err(
                |error| std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string()),
            )? > chrono::DateTime::parse_from_rfc3339(&input.verified_at).map_err(
                |error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error.to_string()),
            )? =>
        {
            cache.max_seen_wall_clock.clone()
        }
        _ => input.verified_at,
    };
    Ok(CatalogueCache {
        index_json: input.index_json,
        signature_json: input.signature_json,
        fetched_at: input.fetched_at,
        highest_generation: current_generation.max(input.generation),
        max_seen_wall_clock,
    })
}

#[tauri::command]
fn get_catalogue_cache() -> Result<Option<CatalogueCache>, HostError> {
    let _guard = catalogue_cache_lock();
    read_catalogue_cache(&catalogue_cache_path()?)
}

#[tauri::command]
fn set_catalogue_cache(input: SetCatalogueCacheInput) -> Result<(), HostError> {
    let _guard = catalogue_cache_lock();
    let path = catalogue_cache_path()?;
    let current = read_catalogue_cache(&path)?;
    let next = next_catalogue_cache(current.as_ref(), input)?;
    write_catalogue_cache(&path, &next)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInstallBundleInput {
    source: String,
    target: String,
    #[serde(default)]
    accept_unknown_publisher: bool,
    grant_ids: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeUninstallBundleInput {
    app: String,
    target: String,
    #[serde(default)]
    keep_data: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeRunInstalledInput {
    app: String,
    target: String,
    #[serde(default)]
    accept_unknown_publisher: bool,
    #[serde(default)]
    remember_unknown_publisher: bool,
}

async fn run_appliance_capture(app: &AppHandle, args: &[String]) -> Result<String, String> {
    let sidecar = app
        .shell()
        .sidecar("appliance")
        .map_err(|error| format!("Bundled appliance CLI is unavailable: {error}"))?
        .args(args);
    let (mut receiver, _child) = sidecar
        .spawn()
        .map_err(|error| format!("failed to spawn appliance CLI: {error}"))?;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_code = None;
    while let Some(event) = receiver.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => stdout.extend(bytes),
            CommandEvent::Stderr(bytes) => stderr.extend(bytes),
            CommandEvent::Error(message) => return Err(message),
            CommandEvent::Terminated(payload) => exit_code = payload.code,
            _ => {}
        }
    }
    if exit_code != Some(0) {
        let detail = String::from_utf8_lossy(&stderr).trim().to_string();
        return Err(if detail.is_empty() {
            format!("appliance CLI exited with code {}", exit_code.unwrap_or(-1))
        } else {
            detail
        });
    }
    Ok(String::from_utf8_lossy(&stdout).to_string())
}

async fn run_appliance_json(app: &AppHandle, args: &[String]) -> Result<serde_json::Value, String> {
    let stdout = run_appliance_capture(app, args).await?;
    stdout
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .ok_or_else(|| "appliance CLI returned no JSON result".to_string())
}

#[tauri::command]
async fn runtime_installed_list(
    app: AppHandle,
    target: String,
) -> Result<serde_json::Value, String> {
    if target.trim().is_empty() {
        return Err("a workspace target is required".to_string());
    }
    let installed = run_appliance_json(
        &app,
        &[
            "runtime".into(),
            "list".into(),
            "--target".into(),
            target,
            "--json".into(),
        ],
    )
    .await?;
    let runtime = run_appliance_json(&app, &["runtime".into(), "ps".into(), "--json".into()])
        .await
        .unwrap_or_else(|_| serde_json::Value::Array(Vec::new()));
    let records = runtime.as_array().cloned().unwrap_or_default();
    let entitlements = run_appliance_json(
        &app,
        &[
            "runtime".into(),
            "entitlements".into(),
            "list".into(),
            "--json".into(),
        ],
    )
    .await
    .unwrap_or_else(|_| serde_json::Value::Array(Vec::new()));
    let grants = entitlements.as_array().cloned().unwrap_or_default();
    let views = installed
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|row| {
            let installed_app = row.get("app")?.clone();
            let app_id = installed_app.get("appId")?.as_str()?;
            let record = records.iter().find(|record| {
                record.get("appId").and_then(|value| value.as_str()) == Some(app_id)
            });
            let state = record
                .and_then(|value| value.get("state"))
                .and_then(|value| value.as_str())
                .filter(|state| matches!(*state, "running" | "starting" | "failed"))
                .unwrap_or("stopped");
            let urls = record
                .and_then(|value| value.get("hostPorts"))
                .and_then(|value| value.as_array())
                .map(|ports| {
                    ports
                        .iter()
                        .filter_map(|port| port.get("host").and_then(|value| value.as_u64()))
                        .map(|port| serde_json::Value::String(format!("http://127.0.0.1:{port}")))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let entitlement = grants
                .iter()
                .find(|grant| grant.get("appId").and_then(|value| value.as_str()) == Some(app_id))
                .map(|grant| {
                    serde_json::json!({
                        "license": grant.get("license"),
                        "grantedAt": grant.get("grantedAt"),
                    })
                });
            Some(serde_json::json!({
                "app": installed_app,
                "state": state,
                "urls": urls,
                "entitlement": entitlement,
            }))
        })
        .collect::<Vec<_>>();
    Ok(serde_json::Value::Array(views))
}

#[tauri::command]
async fn runtime_install_bundle(
    app: AppHandle,
    input: RuntimeInstallBundleInput,
) -> Result<serde_json::Value, String> {
    if input.source.trim().is_empty() || input.target.trim().is_empty() {
        return Err("a bundle source and workspace target are required".to_string());
    }
    let mut args = vec![
        "runtime".into(),
        "install".into(),
        input.source,
        "--target".into(),
        input.target,
        "--json".into(),
    ];
    if input.accept_unknown_publisher {
        args.push("--accept-unknown-publisher".into());
    }
    args.push("--desktop".into());
    if let Some(grant_ids) = input.grant_ids {
        args.push("--grant-selection".into());
        for grant_id in grant_ids {
            args.push("--grant-id".into());
            args.push(grant_id);
        }
    }
    run_appliance_json(&app, &args).await
}

#[tauri::command]
async fn runtime_entitlements_list(app: AppHandle) -> Result<serde_json::Value, String> {
    run_appliance_json(
        &app,
        &[
            "runtime".into(),
            "entitlements".into(),
            "list".into(),
            "--json".into(),
        ],
    )
    .await
}

#[tauri::command]
async fn runtime_entitlements_suggestions(
    app: AppHandle,
    days: u32,
) -> Result<serde_json::Value, String> {
    if days == 0 {
        return Err("entitlement suggestion days must be at least 1".to_string());
    }
    run_appliance_json(
        &app,
        &[
            "runtime".into(),
            "entitlements".into(),
            "--suggest-revoke".into(),
            "--days".into(),
            days.to_string(),
            "--json".into(),
        ],
    )
    .await
}

#[tauri::command]
async fn runtime_entitlements_revoke(
    app: AppHandle,
    app_id: String,
    grant_id: String,
) -> Result<(), String> {
    if app_id.trim().is_empty() || grant_id.trim().is_empty() {
        return Err("an app id and grant id are required".to_string());
    }
    run_appliance_capture(
        &app,
        &[
            "runtime".into(),
            "entitlements".into(),
            "revoke".into(),
            app_id,
            grant_id,
            "--yes".into(),
        ],
    )
    .await
    .map(|_| ())
}

#[tauri::command]
async fn runtime_uninstall_bundle(
    app: AppHandle,
    input: RuntimeUninstallBundleInput,
) -> Result<(), String> {
    let mut args = vec![
        "runtime".into(),
        "uninstall".into(),
        input.app,
        "--target".into(),
        input.target,
    ];
    if input.keep_data {
        args.push("--keep-data".into());
    }
    run_appliance_capture(&app, &args).await.map(|_| ())
}

#[tauri::command]
async fn runtime_run_installed(
    app: AppHandle,
    input: RuntimeRunInstalledInput,
) -> Result<serde_json::Value, String> {
    let mut args = vec![
        "runtime".into(),
        "run".into(),
        input.app,
        "--target".into(),
        input.target,
        "--detach".into(),
        "--json".into(),
    ];
    if input.accept_unknown_publisher {
        args.push("--accept-unknown-publisher".into());
    }
    if input.remember_unknown_publisher {
        args.push("--remember-unknown-publisher".into());
    }
    run_appliance_json(&app, &args).await
}

#[tauri::command]
async fn runtime_stop_installed(handle: AppHandle, app: String) -> Result<(), String> {
    run_appliance_capture(&handle, &["runtime".into(), "stop".into(), app])
        .await
        .map(|_| ())
}

fn shared_profiles_path() -> Option<PathBuf> {
    home_dir().map(|h| h.join(SHARED_PROFILES_DIR).join(SHARED_PROFILES_FILE))
}

fn read_shared_profiles() -> Option<SharedProfilesFile> {
    let path = shared_profiles_path()?;
    if !path.exists() {
        return None;
    }
    let raw = fs::read_to_string(&path).ok()?;
    serde_json::from_str::<SharedProfilesFile>(&raw).ok()
}

fn write_shared_profiles(file: &SharedProfilesFile) -> Result<(), HostError> {
    let Some(path) = shared_profiles_path() else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // Atomic write so a crash during serialization doesn't leave a
    // half-truncated file (which would brick both the desktop and the
    // CLI on next read).
    let tmp = path.with_extension("json.tmp");
    let raw = serde_json::to_string_pretty(file)?;
    fs::write(&tmp, raw)?;
    fs::rename(&tmp, &path)?;
    // 0600 on unix so the secrets aren't world-readable. On Windows the
    // equivalent is an ACL reset: strip inherited ACEs and grant only
    // the current user (the OpenSSH key-file posture) — mirrors
    // restrictWindowsAcl in the CLI's profile-store.ts, which manages
    // the same file. Both best-effort: a failed tightening never breaks
    // the write.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(windows)]
    {
        if let Ok(user) = std::env::var("USERNAME") {
            use std::os::windows::process::CommandExt;
            let _ = std::process::Command::new("icacls")
                .arg(&path)
                .args(["/inheritance:r", "/grant:r", &format!("{user}:F")])
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                .output();
        }
    }
    Ok(())
}

/// The secret to persist into the shared profiles.json for a
/// desktop-managed cluster. On macOS the Keychain is canonical, so the
/// file gets an EMPTY secret (the CLI reads it back from the Keychain) —
/// the secret is never written to cleartext on disk. Elsewhere the file
/// is canonical, so the secret is written through. Pure so the policy is
/// unit-testable on any host.
fn shared_secret_for_platform(secret: String, is_macos: bool) -> String {
    if is_macos {
        String::new()
    } else {
        secret
    }
}

/// Reflect the current desktop-side state into the shared file. Reads
/// each cluster's secret out of the keychain (for the key_id metadata,
/// and the secret itself on non-macOS); clusters without a keychain
/// secret get the entry left as-is from any prior write (defensive —
/// partial state is more useful than a missing entry). CLI-managed
/// entries (managed != "desktop") are preserved untouched.
fn mirror_to_shared_profiles(cfg: &PersistedConfig) -> Result<(), HostError> {
    let mut file = read_shared_profiles().unwrap_or_default();
    file.profiles
        .retain(|_, entry| entry.managed.as_deref() != Some("desktop"));
    for cluster in &cfg.clusters {
        // An entry that survived the retain above is CLI-owned (e.g.
        // the microVM engine's profile, written by `appliance vm up`).
        // The desktop adopts such clusters via sync, never the other
        // way: writing here would clobber a CLI re-key with whatever
        // stale copy the keychain holds.
        if file.profiles.contains_key(&cluster.id) {
            continue;
        }
        let secret = read_api_key(&cluster_keychain_account(&cluster.id));
        let (key_id, secret_value) = match secret {
            Some(k) => (k.id, k.secret),
            None => {
                // No key on the keychain yet — keep whatever the
                // shared file already had for this id, or write a
                // placeholder if absent so the metadata survives.
                let existing = file.profiles.get(&cluster.id).cloned();
                let prev = existing.unwrap_or_default();
                (prev.key_id, prev.secret)
            }
        };
        file.profiles.insert(
            cluster.id.clone(),
            SharedProfileEntry {
                api_url: cluster.api_server_url.clone(),
                key_id,
                secret: shared_secret_for_platform(secret_value, cfg!(target_os = "macos")),
                created_at: Some(cluster.created_at.clone()),
                state_backend_url: cluster.state_backend_url.clone(),
                last_bootstrap_input: cluster.last_bootstrap_input.clone(),
                install_generation: cluster.install_generation.clone(),
                cloud_formation_stack_name: cluster.cloud_formation_stack_name.clone(),
                aws_account_id: cluster.aws_account_id.clone(),
                aws_region: cluster.aws_region.clone(),
                managed: Some("desktop".to_string()),
                name: Some(cluster.name.clone()),
            },
        );
    }
    file.active_profile = cfg.selected_cluster_id.clone();
    write_shared_profiles(&file)
}

// ============================================================
// Non-macOS profile seed (non-destructive)
//
// E4.4 settled the canonical store split (control-plane.md §5):
//   * macOS  → the Keychain is canonical; the CLI reads it directly and
//     the secret is NEVER copied to cleartext. The seed below is a no-op
//     on macOS (see seed_profiles_from_keychain).
//   * non-macOS → profiles.json (0600) is canonical, because the CLI
//     cannot read libsecret/DPAPI. So on those platforms every secret
//     that currently lives ONLY in the keychain (desktop-managed
//     clusters created before this change, where mirror_to_shared_profiles
//     wrote metadata but an older build never copied the secret, or where
//     the shared entry's secret was cleared) must be copied into
//     profiles.json — otherwise the CLI would surface an empty secret and
//     silently break the cluster.
//
// This is the SEED step. It is:
//   * non-destructive — it only ever WRITES into profiles.json; it
//     never deletes or overwrites a keychain entry, and never clears
//     a secret;
//   * authoritative-preserving — it refuses to overwrite a non-empty
//     secret already in profiles.json;
//   * idempotent — re-running it once everything is seeded is a no-op.
// ============================================================

/// Outcome of evaluating one cluster for the keychain→profiles.json
/// seed. Pure data so the decision can be unit-tested without touching
/// the real keychain.
#[derive(Debug, PartialEq)]
enum SeedDecision {
    /// profiles.json already holds a non-empty secret for this id (it
    /// is authoritative) — leave it untouched.
    AlreadySeeded,
    /// No secret anywhere we can see (keychain miss and no shared
    /// secret) — nothing to copy; metadata, if any, stays as-is.
    NothingToSeed,
    /// The keychain held the only copy — fold it into profiles.json.
    /// Carries the entry that should be written for `cluster_id`.
    Seed {
        cluster_id: String,
        entry: SharedProfileEntry,
    },
}

/// Decide whether a single desktop cluster's keychain secret needs
/// seeding into profiles.json. Pure: all IO (keychain + file reads) is
/// resolved by the caller and passed in.
///
/// * `cluster` — the desktop's in-memory record (metadata source).
/// * `keychain_key` — what `read_api_key(cluster:<id>)` returned, or
///   `None` if the keychain has no entry / it was unreadable.
/// * `existing` — the current profiles.json entry for this id, if any.
fn decide_seed(
    cluster: &Cluster,
    keychain_key: Option<&ApiKey>,
    existing: Option<&SharedProfileEntry>,
) -> SeedDecision {
    // An existing non-empty shared secret is authoritative — never
    // clobber it from the (now derived) keychain. This is the
    // idempotency guard: once seeded, every later run lands here.
    if let Some(entry) = existing {
        if !entry.secret.is_empty() && !entry.key_id.is_empty() {
            return SeedDecision::AlreadySeeded;
        }
    }

    let Some(key) = keychain_key else {
        // Secret lives nowhere we can read it. Don't fabricate an
        // empty entry; leave whatever metadata exists alone.
        return SeedDecision::NothingToSeed;
    };
    if key.secret.is_empty() || key.id.is_empty() {
        return SeedDecision::NothingToSeed;
    }

    // Carry forward any metadata the shared entry already had (e.g. a
    // CLI-written `managed`/`name`) so the seed only fills in the
    // missing secret without rewriting unrelated fields. Default the
    // surface marker to "desktop" since that's the only producer that
    // stored a secret solely in the keychain.
    let prev = existing.cloned().unwrap_or_default();
    SeedDecision::Seed {
        cluster_id: cluster.id.clone(),
        entry: SharedProfileEntry {
            api_url: if prev.api_url.is_empty() {
                cluster.api_server_url.clone()
            } else {
                prev.api_url
            },
            key_id: key.id.clone(),
            secret: key.secret.clone(),
            created_at: prev.created_at.or_else(|| Some(cluster.created_at.clone())),
            state_backend_url: prev
                .state_backend_url
                .or_else(|| cluster.state_backend_url.clone()),
            last_bootstrap_input: prev
                .last_bootstrap_input
                .or_else(|| cluster.last_bootstrap_input.clone()),
            install_generation: prev
                .install_generation
                .or_else(|| cluster.install_generation.clone()),
            cloud_formation_stack_name: prev
                .cloud_formation_stack_name
                .or_else(|| cluster.cloud_formation_stack_name.clone()),
            aws_account_id: prev
                .aws_account_id
                .or_else(|| cluster.aws_account_id.clone()),
            aws_region: prev.aws_region.or_else(|| cluster.aws_region.clone()),
            managed: prev.managed.or_else(|| Some("desktop".to_string())),
            name: prev.name.or_else(|| Some(cluster.name.clone())),
        },
    }
}

/// Stage-1 seed: for every desktop cluster whose secret currently
/// exists ONLY in the keychain, copy it into profiles.json once. Reads
/// each cluster's secret from the keychain and applies `decide_seed`.
///
/// Returns the number of entries newly seeded (0 ⇒ nothing changed, so
/// no write is needed). The shared file is only rewritten when at least
/// one entry was seeded, keeping the steady-state path write-free.
///
/// SAFETY: this only ADDS secrets to profiles.json — it never removes
/// a keychain entry and never overwrites an existing non-empty shared
/// secret, so no secret can be lost by running it. Hold `config_lock`
/// across the call (as the sync path does) so the read-modify-write of
/// profiles.json doesn't interleave with another desktop write.
fn seed_profiles_from_keychain(cfg: &PersistedConfig) -> Result<usize, HostError> {
    // macOS keeps the Keychain canonical and the CLI reads it directly,
    // so there is nothing to seed into profiles.json — and seeding would
    // copy the secret to cleartext, the exact leak the Keychain-first
    // model avoids. The seed stays active on non-macOS, where
    // profiles.json is the canonical store (E4.4 / control-plane.md §5).
    if cfg!(target_os = "macos") {
        return Ok(0);
    }
    let mut file = read_shared_profiles().unwrap_or_default();
    let mut seeded = 0usize;
    for cluster in &cfg.clusters {
        let keychain_key = read_api_key(&cluster_keychain_account(&cluster.id));
        let existing = file.profiles.get(&cluster.id);
        match decide_seed(cluster, keychain_key.as_ref(), existing) {
            SeedDecision::Seed { cluster_id, entry } => {
                file.profiles.insert(cluster_id, entry);
                seeded += 1;
            }
            SeedDecision::AlreadySeeded | SeedDecision::NothingToSeed => {}
        }
    }
    if seeded > 0 {
        write_shared_profiles(&file)?;
    }
    Ok(seeded)
}

/// Launch-time entry point for the stage-1 seed. Reads the desktop's
/// persisted clusters and folds any keychain-only secret into
/// profiles.json. Takes `config_lock` for the read-modify-write so it
/// can't interleave with a concurrent desktop write (e.g. the microVM
/// sync that runs right after). Cross-PROCESS interleaving with the
/// CLI is still possible — see the concurrency note on `config_lock`.
fn seed_desktop_profiles(app: &AppHandle) -> Result<usize, HostError> {
    let _guard = config_lock();
    let persisted = read_persisted_config(app)?;
    seed_profiles_from_keychain(&persisted)
}

/// Convert a SharedProfilesFile into a PersistedConfig (the desktop's
/// in-memory shape) and write the secrets back into the OS keychain so
/// subsequent calls see them through the existing keychain path.
/// Also writes the legacy config.json so the next read short-circuits.
fn ingest_shared_into_legacy(
    app: &AppHandle,
    shared: SharedProfilesFile,
    app_mode: Option<AppMode>,
) -> Result<PersistedConfig, HostError> {
    let cfg = build_ingested_config(&shared, app_mode);
    for (id, entry) in &shared.profiles {
        // Only seed the Keychain when the shared entry actually carries a
        // secret. A macOS desktop-managed entry has an EMPTY secret (the
        // Keychain is canonical), so writing it here would clobber the
        // real Keychain copy with an empty value — never do that.
        if !entry.secret.is_empty() {
            let _ = write_api_key(
                &cluster_keychain_account(id),
                &ApiKey {
                    id: entry.key_id.clone(),
                    secret: entry.secret.clone(),
                },
            );
        }
    }

    // Persist to the legacy file so this code path doesn't re-ingest
    // on every read.
    let legacy_path = config_path(app)?;
    let raw = serde_json::to_string_pretty(&cfg)?;
    fs::write(legacy_path, raw)?;
    Ok(cfg)
}

/// Pure half of shared-profile adoption. Keeping mode propagation here
/// makes it testable without a Tauri app handle or OS keychain.
fn build_ingested_config(
    shared: &SharedProfilesFile,
    app_mode: Option<AppMode>,
) -> PersistedConfig {
    PersistedConfig {
        clusters: shared
            .profiles
            .iter()
            .map(|(id, entry)| Cluster {
                id: id.clone(),
                name: entry.name.clone().unwrap_or_else(|| id.clone()),
                api_server_url: entry.api_url.clone(),
                created_at: entry
                    .created_at
                    .clone()
                    .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
                state_backend_url: entry.state_backend_url.clone(),
                last_bootstrap_input: entry.last_bootstrap_input.clone(),
                install_generation: entry.install_generation.clone(),
                cloud_formation_stack_name: entry.cloud_formation_stack_name.clone(),
                aws_account_id: entry.aws_account_id.clone(),
                aws_region: entry.aws_region.clone(),
                // The keychain copy comes from this very entry.
                synced_key_id: Some(entry.key_id.clone()),
            })
            .collect(),
        selected_cluster_id: shared.active_profile.clone(),
        app_mode,
        ..Default::default()
    }
}

/// Serializes every read-modify-write of the persisted config.
/// Multiple surfaces touch config.json concurrently — frontend
/// commands (get_config's legacy migration, cluster CRUD) and
/// background work (the launch-time seed + microVM sync) — and an
/// unguarded interleaving lets a later write clobber an earlier one
/// with stale state. Take this for the full read→mutate→write span.
///
/// SCOPE: this guards in-PROCESS races only (it's a process-global
/// Mutex). It does NOT serialize against the CLI, which is a separate
/// process that performs its own read-modify-write of profiles.json
/// (e.g. `appliance keys rotate`). The CLI now takes a cross-process
/// advisory lockfile (profiles.json.lock) around its own RMW cycles;
/// the remaining piece is having THIS desktop adopt the same lockfile —
/// see docs/credentials.md. Until it does, a desktop↔CLI interleave is
/// still last-writer-wins (both sides do atomic temp-file renames, so
/// neither can read a half-written file; the residual risk is purely a
/// lost write on interleaved full read→write cycles).
fn config_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read_persisted_config(app: &AppHandle) -> Result<PersistedConfig, HostError> {
    let path = config_path(app)?;
    let legacy = if path.exists() {
        let raw = fs::read_to_string(&path)?;
        serde_json::from_str::<PersistedConfig>(&raw).unwrap_or_default()
    } else {
        PersistedConfig::default()
    };

    // Legacy file already has clusters — use it as the source of truth.
    // The shared file is updated as a mirror on every subsequent write.
    if !legacy.clusters.is_empty() {
        return Ok(legacy);
    }

    // Legacy file is empty/missing. Pull from the shared store if the
    // CLI (or a previous version of this desktop) populated it.
    if let Some(shared) = read_shared_profiles() {
        if !shared.profiles.is_empty() {
            return ingest_shared_into_legacy(app, shared, legacy.app_mode);
        }
    }
    Ok(legacy)
}

fn write_persisted_config(app: &AppHandle, cfg: &PersistedConfig) -> Result<(), HostError> {
    let path = config_path(app)?;
    let raw = serde_json::to_string_pretty(cfg)?;
    fs::write(path, raw)?;
    // Best-effort mirror — if writing the shared file fails (e.g.
    // unwritable home dir), the desktop's own state is still
    // consistent; the CLI just won't see the latest set.
    if let Err(e) = mirror_to_shared_profiles(cfg) {
        eprintln!("warn: shared-profile mirror failed: {e}");
    }
    Ok(())
}

fn keychain_entry(account: &str) -> Result<keyring::Entry, HostError> {
    Ok(keyring::Entry::new(KEYCHAIN_SERVICE, account)?)
}

fn read_api_key(account: &str) -> Option<ApiKey> {
    keychain_entry(account)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .and_then(|raw| serde_json::from_str::<ApiKey>(&raw).ok())
}

fn write_api_key(account: &str, key: &ApiKey) -> Result<(), HostError> {
    let entry = keychain_entry(account)?;
    let payload = serde_json::to_string(key)?;
    entry.set_password(&payload)?;
    Ok(())
}

fn delete_api_key(account: &str) {
    if let Ok(entry) = keychain_entry(account) {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(_) => {
                // Best-effort: a stuck keychain entry shouldn't block the rest of the operation.
            }
        }
    }
}

// On read, fold any legacy single-cluster state into the new shape.
// Idempotent: once migrated, the legacy fields are gone and this is a
// no-op. Returns true if the persisted file was rewritten so the
// caller can persist + clean up the old keychain slot.
fn migrate_legacy(app: &AppHandle, cfg: &mut PersistedConfig) -> Result<bool, HostError> {
    let mut migrated = migrate_legacy_top_level_url(cfg)?;
    migrated |= migrate_legacy_local_runtime_urls(cfg);
    if migrated {
        write_persisted_config(app, cfg)?;
    }
    Ok(migrated)
}

/// Original field-shape migration: top-level `api_server_url` →
/// `clusters[]` entry. Runs once per upgrade from the pre-clusters
/// era.
fn migrate_legacy_top_level_url(cfg: &mut PersistedConfig) -> Result<bool, HostError> {
    if !cfg.clusters.is_empty() {
        // Already migrated. Drop the legacy field if it lingered.
        return Ok(cfg.api_server_url.take().is_some());
    }
    let Some(legacy_url) = cfg.api_server_url.take() else {
        return Ok(false);
    };
    let Some(legacy_key) = read_api_key(LEGACY_KEYCHAIN_ACCOUNT) else {
        // URL but no key — drop the orphan URL silently.
        return Ok(true);
    };

    let id = uuid::Uuid::new_v4().to_string();
    let cluster = Cluster {
        id: id.clone(),
        name: derive_name_from_url(&legacy_url),
        api_server_url: legacy_url,
        created_at: chrono::Utc::now().to_rfc3339(),
        state_backend_url: None,
        last_bootstrap_input: None,
        install_generation: None,
        cloud_formation_stack_name: None,
        aws_account_id: None,
        aws_region: None,
        synced_key_id: None,
    };

    write_api_key(&cluster_keychain_account(&id), &legacy_key)?;
    delete_api_key(LEGACY_KEYCHAIN_ACCOUNT);
    cfg.clusters.push(cluster);
    cfg.selected_cluster_id = Some(id);
    Ok(true)
}

/// Phase-4 URL-shape migration. Pre-Phase-4 desktops registered the
/// Local Runtime cluster with `http://localhost:<api_port>` because
/// api-server ran as a host-side child process. Phase 4 moves
/// api-server in-cluster and re-derives the URL as
/// `http://api.appliance.localhost:<host_port>`. Without this fixup a
/// post-upgrade lookup of the legacy `local-runtime` cluster against
/// the new URL would come up empty and risk a duplicate registration.
/// Rewriting in place keeps the cluster id (so the keychain entry
/// survives) and lets the freshly in-cluster api-server pick up the
/// existing API key the moment it's reachable.
fn migrate_legacy_local_runtime_urls(cfg: &mut PersistedConfig) -> bool {
    let new_url = format!(
        "http://{}:{}",
        IN_CLUSTER_API_SERVER_HOSTNAME, DEFAULT_LOCAL_HOST_PORT
    );
    let mut migrated = false;
    for cluster in &mut cfg.clusters {
        if cluster.id != LOCAL_RUNTIME_CLUSTER_ID {
            continue;
        }
        if is_pre_phase4_local_runtime_url(&cluster.api_server_url) {
            cluster.api_server_url = new_url.clone();
            migrated = true;
        }
    }
    migrated
}

fn is_pre_phase4_local_runtime_url(url: &str) -> bool {
    // Pre-Phase-4 default port was DEFAULT_LOCAL_API_PORT (3030) but
    // users could override via LocalRuntimeInput.api_port to anything;
    // matching the host (localhost / 127.0.0.1) is the discriminator
    // that catches the legacy shape without false-positiving on the
    // new `api.appliance.localhost` form.
    let stripped = url.strip_prefix("http://").unwrap_or(url);
    stripped.starts_with("localhost:") || stripped.starts_with("127.0.0.1:")
}

fn derive_name_from_url(url: &str) -> String {
    // Strip scheme + path so the cluster shows a recognisable hostname.
    let without_scheme = url.split("://").nth(1).unwrap_or(url);
    let host = without_scheme.split('/').next().unwrap_or(without_scheme);
    host.strip_prefix("api.").unwrap_or(host).to_string()
}

#[tauri::command]
fn get_config(app: AppHandle) -> Result<HostConfig, HostError> {
    let _guard = config_lock();
    let mut persisted = read_persisted_config(&app)?;
    migrate_legacy(&app, &mut persisted)?;

    let api_key = persisted
        .selected_cluster_id
        .as_deref()
        .and_then(|id| read_api_key(&cluster_keychain_account(id)));

    Ok(HostConfig {
        clusters: persisted.clusters,
        selected_cluster_id: persisted.selected_cluster_id,
        api_key,
    })
}

#[tauri::command]
fn get_app_mode(app: AppHandle) -> Result<Option<AppMode>, HostError> {
    let _guard = config_lock();
    let mut persisted = read_persisted_config(&app)?;
    migrate_legacy(&app, &mut persisted)?;
    Ok(effective_app_mode(&persisted))
}

/// Upgrades must preserve the historical developer shell. Only a machine
/// with neither an explicit choice nor an existing cluster is truly fresh.
fn effective_app_mode(persisted: &PersistedConfig) -> Option<AppMode> {
    persisted
        .app_mode
        .or_else(|| (!persisted.clusters.is_empty()).then_some(AppMode::Developer))
}

#[tauri::command]
fn set_app_mode(app: AppHandle, mode: AppMode) -> Result<(), HostError> {
    let _guard = config_lock();
    let mut persisted = read_persisted_config(&app)?;
    migrate_legacy(&app, &mut persisted)?;
    persisted.app_mode = Some(mode);
    write_persisted_config(&app, &persisted)
}

#[tauri::command]
fn add_cluster(app: AppHandle, input: AddClusterInput) -> Result<Cluster, HostError> {
    let _guard = config_lock();
    let mut persisted = read_persisted_config(&app)?;
    migrate_legacy(&app, &mut persisted)?;

    let cluster = Cluster {
        id: uuid::Uuid::new_v4().to_string(),
        name: input.name,
        api_server_url: input.api_server_url,
        created_at: chrono::Utc::now().to_rfc3339(),
        synced_key_id: None,
        state_backend_url: input.state_backend_url,
        last_bootstrap_input: input.last_bootstrap_input,
        install_generation: input.install_generation,
        cloud_formation_stack_name: input.cloud_formation_stack_name,
        aws_account_id: input.aws_account_id,
        aws_region: input.aws_region,
    };

    write_api_key(&cluster_keychain_account(&cluster.id), &input.api_key)?;
    persisted.clusters.push(cluster.clone());
    persisted.selected_cluster_id = Some(cluster.id.clone());
    write_persisted_config(&app, &persisted)?;
    Ok(cluster)
}

#[tauri::command]
fn select_cluster(app: AppHandle, cluster_id: Option<String>) -> Result<(), HostError> {
    let _guard = config_lock();
    let mut persisted = read_persisted_config(&app)?;
    migrate_legacy(&app, &mut persisted)?;

    if let Some(ref id) = cluster_id {
        if !persisted.clusters.iter().any(|c| &c.id == id) {
            return Err(HostError::ClusterNotFound(id.clone()));
        }
    }
    persisted.selected_cluster_id = cluster_id;
    write_persisted_config(&app, &persisted)
}

/// Set (or clear, with `None`) the cached `stateBackendUrl` on a
/// cluster. Settings calls this after promotion (clear, since the
/// local state has been archived) and after demotion (set to the
/// URL we demoted from, so a future re-promotion can default the
/// input field). Idempotent.
#[tauri::command]
fn set_cluster_state_backend(
    app: AppHandle,
    cluster_id: String,
    url: Option<String>,
) -> Result<(), HostError> {
    let _guard = config_lock();
    let mut persisted = read_persisted_config(&app)?;
    migrate_legacy(&app, &mut persisted)?;

    let cluster = persisted
        .clusters
        .iter_mut()
        .find(|c| c.id == cluster_id)
        .ok_or_else(|| HostError::ClusterNotFound(cluster_id.clone()))?;
    cluster.state_backend_url = url;
    write_persisted_config(&app, &persisted)
}

#[tauri::command]
fn remove_cluster(app: AppHandle, cluster_id: String) -> Result<(), HostError> {
    let _guard = config_lock();
    let mut persisted = read_persisted_config(&app)?;
    migrate_legacy(&app, &mut persisted)?;

    let before = persisted.clusters.len();
    persisted.clusters.retain(|c| c.id != cluster_id);
    if persisted.clusters.len() == before {
        return Err(HostError::ClusterNotFound(cluster_id));
    }

    delete_api_key(&cluster_keychain_account(&cluster_id));

    // If we removed the selected cluster, fall back to the first
    // remaining one (or null when the list is now empty).
    if persisted.selected_cluster_id.as_deref() == Some(cluster_id.as_str()) {
        persisted.selected_cluster_id = persisted.clusters.first().map(|c| c.id.clone());
    }
    write_persisted_config(&app, &persisted)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AwsProfile {
    name: String,
    /// True when the profile is configured for SSO (sso_session = ...
    /// or legacy sso_start_url). Surfaced to the wizard so the UI can
    /// hint at `aws sso login` failures distinctly from access-key
    /// profiles.
    is_sso: bool,
    /// Source file the profile was discovered in — purely informational.
    source: AwsProfileSource,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum AwsProfileSource {
    Config,
    Credentials,
}

/// Enumerate AWS profiles from `~/.aws/config` and `~/.aws/credentials`.
/// Returns an empty list if neither file exists. Parses INI lazily —
/// any malformed section is skipped silently rather than aborting the
/// whole listing, so the wizard always has *something* to show.
#[tauri::command]
fn list_aws_profiles() -> Result<Vec<AwsProfile>, HostError> {
    let home = match std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        Some(h) => PathBuf::from(h),
        None => return Ok(Vec::new()),
    };
    let aws_dir = home.join(".aws");
    let mut out: Vec<AwsProfile> = Vec::new();

    let config_path = aws_dir.join("config");
    if config_path.exists() {
        if let Ok(text) = fs::read_to_string(&config_path) {
            for (name, body) in parse_ini_sections(&text) {
                // Strip the `profile ` prefix that ~/.aws/config uses
                // for everything except `[default]`. Skip sso-session
                // sections — they're not profiles, just shared config.
                let profile_name = if name == "default" {
                    Some("default".to_string())
                } else {
                    name.strip_prefix("profile ")
                        .map(|rest| rest.trim().to_string())
                };
                if let Some(profile_name) = profile_name {
                    let is_sso = body.contains("sso_session") || body.contains("sso_start_url");
                    out.push(AwsProfile {
                        name: profile_name,
                        is_sso,
                        source: AwsProfileSource::Config,
                    });
                }
            }
        }
    }

    let creds_path = aws_dir.join("credentials");
    if creds_path.exists() {
        if let Ok(text) = fs::read_to_string(&creds_path) {
            for (name, _body) in parse_ini_sections(&text) {
                if out.iter().any(|p| p.name == name) {
                    continue;
                }
                out.push(AwsProfile {
                    name,
                    is_sso: false,
                    source: AwsProfileSource::Credentials,
                });
            }
        }
    }

    Ok(out)
}

/// Tiny INI section parser — yields (section_name, section_body) for
/// each `[section]` block. Good enough for `~/.aws/*`; doesn't try to
/// be a general-purpose INI reader.
fn parse_ini_sections(text: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut current_name: Option<String> = None;
    let mut current_body = String::new();
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            if let Some(name) = current_name.take() {
                out.push((name, std::mem::take(&mut current_body)));
            }
            current_name = Some(line[1..line.len() - 1].trim().to_string());
            continue;
        }
        if current_name.is_some() {
            current_body.push_str(raw_line);
            current_body.push('\n');
        }
    }
    if let Some(name) = current_name {
        out.push((name, current_body));
    }
    out
}

// Resolve the path to the compiled bootstrap sidecar. Dev-only: uses
// CARGO_MANIFEST_DIR to find the sibling `sidecar/dist/main.mjs`.
// Production packaging (bundling the sidecar into the installer as a
// Tauri resource or externalBin) is tracked in RFC 0017 alongside the
// downloadable bootstrapper stack.
fn sidecar_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("sidecar")
        .join("dist")
        .join("main.mjs")
}

/// Spawn the sidecar with the given JSON input, stream NDJSON events
/// back to the frontend via the Tauri Channel, and return whatever
/// the sidecar emits as its final `result` line.
///
/// Each sidecar invocation reads one JSON object from stdin and
/// terminates after emitting `{type: "result", ...}` or
/// `{type: "error", ...}` on stdout. The sidecar internally
/// dispatches on the input's `kind` field — see `sidecar/src/main.ts`.
async fn invoke_sidecar(
    input: serde_json::Value,
    on_event: Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let script = sidecar_path();
    if !script.exists() {
        return Err(format!(
            "sidecar not built. Run `pnpm --filter @appliance.sh/desktop run sidecar:build` first. (expected at {})",
            script.display()
        ));
    }

    let mut child = quiet_command("node")
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            // The Node sidecar drives the AWS bootstrap path (Pulumi
            // automation), which still needs a system Node. Day-to-day
            // local-runtime use no longer touches this code path —
            // the helper-install flow uses the Bun-compiled CLI
            // directly. So this error is only surfaced when an
            // operator runs the bootstrap wizard without Node.
            if e.kind() == std::io::ErrorKind::NotFound {
                "Node.js is not installed or not on PATH. The AWS bootstrap flow requires Node — \
install it from https://nodejs.org/ (or `brew install node`) and retry. The Local Runtime page \
doesn't need Node and should work without this dependency."
                    .to_string()
            } else {
                format!("failed to spawn node sidecar: {}", e)
            }
        })?;

    // Write the input JSON to stdin and close it so the sidecar's
    // `for await (const chunk of process.stdin)` loop terminates.
    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "sidecar stdin unavailable".to_string())?;
        let payload = serde_json::to_vec(&input).map_err(|e| e.to_string())?;
        stdin
            .write_all(&payload)
            .await
            .map_err(|e| format!("failed to write sidecar stdin: {}", e))?;
    }

    // Tee stderr into `log`-level events so Pulumi's warnings surface
    // in the UI instead of disappearing. Runs on a detached task so
    // it doesn't block the stdout reader.
    if let Some(stderr) = child.stderr.take() {
        let stderr_channel = on_event.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = stderr_channel.send(serde_json::json!({
                    "type": "log",
                    "level": "info",
                    "message": line,
                }));
            }
        });
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "sidecar stdout unavailable".to_string())?;
    let mut lines = BufReader::new(stdout).lines();

    let mut final_result: Option<serde_json::Value> = None;
    let mut error: Option<String> = None;

    while let Ok(Some(line)) = lines.next_line().await {
        let event: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => {
                // Not JSON — surface as a log event. Sidecar should
                // always emit NDJSON, but anything else (e.g. a node
                // crash trace) still reaches the user.
                let _ = on_event.send(serde_json::json!({
                    "type": "log",
                    "level": "warn",
                    "message": line,
                }));
                continue;
            }
        };

        match event.get("type").and_then(|v| v.as_str()) {
            Some("result") => final_result = event.get("result").cloned(),
            Some("error") => {
                error = event
                    .get("error")
                    .and_then(|v| v.as_str())
                    .map(String::from)
                    .or(Some("sidecar reported unspecified error".to_string()));
            }
            _ => {
                let _ = on_event.send(event);
            }
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("sidecar wait failed: {}", e))?;

    if let Some(e) = error {
        return Err(e);
    }
    if !status.success() {
        return Err(format!("sidecar exited with {}", status));
    }
    final_result.ok_or_else(|| "sidecar exited without producing a result".to_string())
}

/// Drive a helper-install by spawning the bundled, statically-linked
/// `appliance` CLI binary with `local install --json`.
///
/// The binary is registered as a Tauri externalBin (see tauri.conf
/// `bundle.externalBin`) and resolved here via tauri-plugin-shell's
/// `sidecar` API. The same binary is also published as a GitHub
/// Release asset by `.github/workflows/release-cli-binaries.yml`
/// for standalone CLI users; the desktop ships its own copy so the
/// first-start flow doesn't depend on a network download.
///
/// The CLI emits NDJSON: one JSON object per stdout line, with a
/// final `{type: "result", result: {outcomes: [...]}}`. Progress
/// lines flow through `on_event` so the UI can render live status.
/// Because the CLI is a Bun-compiled binary with no runtime
/// dependencies, this works on a fresh user's machine without Node
/// or any other runtime — the original bootstrap deadlock is gone.
#[tauri::command]
async fn local_helper_install(
    app: AppHandle,
    input: serde_json::Value,
    on_event: Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let payload = match input {
        serde_json::Value::Object(map) => map,
        serde_json::Value::Null => serde_json::Map::new(),
        other => {
            return Err(format!(
                "local_helper_install expected an object input, got: {}",
                other
            ))
        }
    };

    let force = payload
        .get("force")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let tools: Vec<String> = match payload.get("tools") {
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect(),
        Some(serde_json::Value::Null) | None => Vec::new(),
        Some(other) => {
            return Err(format!(
                "`tools` must be an array of strings, got: {}",
                other
            ))
        }
    };

    let mut args: Vec<String> = vec!["local".into(), "install".into()];
    for t in &tools {
        args.push(t.clone());
    }
    if force {
        args.push("--force".into());
    }
    args.push("--json".into());

    let sidecar = app
        .shell()
        .sidecar("appliance")
        .map_err(|e| {
            format!(
                "Bundled appliance CLI is unavailable: {e}. Rebuild with `pnpm --filter @appliance.sh/desktop build` so the CLI binary lands in src-tauri/binaries/."
            )
        })?
        .args(&args);

    let (mut rx, _child) = sidecar
        .spawn()
        .map_err(|e| format!("failed to spawn appliance CLI: {e}"))?;

    let mut final_outcomes: Option<serde_json::Value> = None;
    let mut error: Option<String> = None;
    let mut exit_code: Option<i32> = None;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                handle_cli_line(&bytes, &on_event, &mut final_outcomes, &mut error);
            }
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim().to_string();
                if !line.is_empty() {
                    let _ = on_event.send(serde_json::json!({
                        "type": "log",
                        "level": "info",
                        "message": line,
                    }));
                }
            }
            CommandEvent::Error(msg) => {
                error = Some(msg);
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
            }
            _ => {}
        }
    }

    if let Some(msg) = error {
        return Err(msg);
    }
    let outcomes = final_outcomes.unwrap_or_else(|| {
        if exit_code.map(|c| c != 0).unwrap_or(true) {
            serde_json::json!([{
                "tool": "cli",
                "status": "failed",
                "message": format!(
                    "appliance CLI exited with code {}",
                    exit_code.map_or_else(|| "?".to_string(), |c| c.to_string()),
                ),
            }])
        } else {
            serde_json::json!([])
        }
    });

    Ok(serde_json::json!({ "outcomes": outcomes }))
}

/// Parse one line of CLI stdout. Most lines are NDJSON; anything that
/// fails to parse is forwarded as a log event so we don't drop output
/// (e.g. if chalk color codes ever leak through despite --json).
fn handle_cli_line(
    bytes: &[u8],
    on_event: &Channel<serde_json::Value>,
    final_outcomes: &mut Option<serde_json::Value>,
    error: &mut Option<String>,
) {
    let line = String::from_utf8_lossy(bytes);
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    let parsed: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => {
            let _ = on_event.send(serde_json::json!({
                "type": "log",
                "level": "info",
                "message": trimmed,
            }));
            return;
        }
    };
    let kind = parsed.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "result" => {
            *final_outcomes = parsed
                .get("result")
                .and_then(|r| r.get("outcomes"))
                .cloned();
        }
        "error" => {
            *error = parsed
                .get("error")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
        }
        _ => {
            let _ = on_event.send(parsed);
        }
    }
}

/// Drive a full bootstrap (phases 1–3) via the sidecar. The frontend
/// passes `{bootstrapInput, options?}`; this command tags the payload
/// with `kind: "bootstrap"` so the sidecar dispatches to runBootstrap.
#[tauri::command]
async fn run_bootstrap(
    input: serde_json::Value,
    on_event: Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut payload = match input {
        serde_json::Value::Object(map) => map,
        other => {
            return Err(format!(
                "run_bootstrap expected an object input, got: {}",
                other
            ))
        }
    };
    payload.insert(
        "kind".to_string(),
        serde_json::Value::String("bootstrap".to_string()),
    );
    invoke_sidecar(serde_json::Value::Object(payload), on_event).await
}

/// Run phase 3 (state promotion) standalone via the sidecar. Used by
/// the Settings page to detach a cluster's state from this device
/// after the fact.
#[tauri::command]
async fn promote_state(
    input: serde_json::Value,
    on_event: Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut payload = match input {
        serde_json::Value::Object(map) => map,
        other => {
            return Err(format!(
                "promote_state expected an object input, got: {}",
                other
            ))
        }
    };
    payload.insert(
        "kind".to_string(),
        serde_json::Value::String("promote-state".to_string()),
    );
    invoke_sidecar(serde_json::Value::Object(payload), on_event).await
}

/// Inverse of `promote_state`: pull installer Pulumi state out of S3
/// back into the local file backend on this device. Used by Settings
/// to reattach a cluster's installer state for offline / debugging
/// work.
#[tauri::command]
async fn demote_state(
    input: serde_json::Value,
    on_event: Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut payload = match input {
        serde_json::Value::Object(map) => map,
        other => {
            return Err(format!(
                "demote_state expected an object input, got: {}",
                other
            ))
        }
    };
    payload.insert(
        "kind".to_string(),
        serde_json::Value::String("demote-state".to_string()),
    );
    invoke_sidecar(serde_json::Value::Object(payload), on_event).await
}

/// Self-update the api-server + api-worker on the cluster to a new
/// image version. The sidecar runs the mirror-to-ECR step (needs
/// docker, which Lambda doesn't have) then drives the deploys via
/// the cluster's existing deployment API.
#[tauri::command]
async fn update_api_server(
    input: serde_json::Value,
    on_event: Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut payload = match input {
        serde_json::Value::Object(map) => map,
        other => {
            return Err(format!(
                "update_api_server expected an object input, got: {}",
                other
            ))
        }
    };
    payload.insert(
        "kind".to_string(),
        serde_json::Value::String("update-api-server".to_string()),
    );
    invoke_sidecar(serde_json::Value::Object(payload), on_event).await
}

/// Re-run phase 1 against the cluster's installer stack to update the
/// infra baseline (state bucket, ECR, CloudFront, edge router, system
/// roles, etc.) to whatever ships with this version of @appliance.sh/infra.
#[tauri::command]
async fn update_baseline(
    input: serde_json::Value,
    on_event: Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut payload = match input {
        serde_json::Value::Object(map) => map,
        other => {
            return Err(format!(
                "update_baseline expected an object input, got: {}",
                other
            ))
        }
    };
    payload.insert(
        "kind".to_string(),
        serde_json::Value::String("update-baseline".to_string()),
    );
    invoke_sidecar(serde_json::Value::Object(payload), on_event).await
}

/// Resolve the latest semver-shaped tag on a ghcr.io image. The
/// sidecar talks Docker Registry v2 directly (anonymous pull token).
/// No event stream — this is a single-shot lookup, but we route it
/// through the sidecar for consistency with the rest of the
/// bootstrap-pkg surface.
#[tauri::command]
async fn latest_api_server_version(
    input: serde_json::Value,
    on_event: Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut payload = match input {
        serde_json::Value::Object(map) => map,
        serde_json::Value::Null => serde_json::Map::new(),
        other => {
            return Err(format!(
                "latest_api_server_version expected an object or null input, got: {}",
                other
            ))
        }
    };
    payload.insert(
        "kind".to_string(),
        serde_json::Value::String("latest-version".to_string()),
    );
    invoke_sidecar(serde_json::Value::Object(payload), on_event).await
}

/// Destroy the installer stack this device bootstrapped (the inverse of
/// `run_bootstrap`). The sidecar runs `pulumi destroy` against the
/// installer state in `~/.appliance` and archives the local state. This
/// only tears down the base AWS infrastructure — user-deployed
/// appliances live in a separate Pulumi project and must be destroyed
/// first. The frontend forgets the local cluster registration once this
/// resolves.
#[tauri::command]
async fn teardown_cluster(
    input: serde_json::Value,
    on_event: Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut payload = match input {
        serde_json::Value::Object(map) => map,
        serde_json::Value::Null => serde_json::Map::new(),
        other => {
            return Err(format!(
                "teardown_cluster expected an object or null input, got: {}",
                other
            ))
        }
    };
    payload.insert(
        "kind".to_string(),
        serde_json::Value::String("teardown".to_string()),
    );
    invoke_sidecar(serde_json::Value::Object(payload), on_event).await
}

// Default cluster name + namespace the desktop's runtime-config
// resolution falls back to. `appliance-local` doubles as the
// "unset cluster name" sentinel kube_target_args maps to the
// canonical microVM. Must match DEFAULT_LOCAL_CLUSTER_NAME in
// `packages/infra/src/lib/local/LocalContainerDeploymentService.ts`.
const DEFAULT_LOCAL_CLUSTER_NAME: &str = "appliance-local";
const DEFAULT_LOCAL_NAMESPACE: &str = "appliance";
const DEFAULT_LOCAL_HOST_PORT: u16 = 8081;
// Stable cluster id == profile name used by the CLI's `--profile`
// flag and the shared profiles.json key. Survives as the id the
// pre-Phase-4 URL migration rewrites in place.
const LOCAL_RUNTIME_CLUSTER_ID: &str = "local-runtime";
const MICROVM_CLUSTER_NAME: &str = "Dev Machine";
// Pre-rename cluster label; sync_microvm_cluster migrates persisted
// entries carrying it (bare or "(name)"-qualified) to the current one.
const LEGACY_MICROVM_CLUSTER_NAME: &str = "MicroVM Runtime";
// Mirrors MICROVM_PROFILE in packages/cli/src/appliance-vm.ts — the
// CLI's `vm up` writes this profile; the desktop adopts it as a
// cluster with the same stable id.
const MICROVM_CLUSTER_ID: &str = "microvm";

// Tools the local-runtime path shells out to. Centralised so preflight
// + spawn error mapping stay in sync — if one of these is renamed or a
// new one is added (e.g. `crane`), everything downstream picks it up.
//
// `auto_installable` mirrors the `Provider.autoInstallable` flag in
// `@appliance.sh/helper`. The UI uses it to decide whether to render
// an Install button vs. fall back to copy-paste guidance. Stays in
// lockstep with the helper's provider definitions.
struct PrereqTool {
    name: &'static str,
    purpose: &'static str,
    // Argv to print a version banner. Tool-specific: kubectl predates
    // `--version` and only accepts `version --client`.
    version_args: &'static [&'static str],
    auto_installable: bool,
}

const LOCAL_PREREQS: &[PrereqTool] = &[
    PrereqTool {
        name: "docker",
        purpose: "Container runtime for the deprecated host-Docker local runtime. App deploys no longer need it — images build server-side.",
        version_args: &["--version"],
        // Container runtimes are an OS-level install (kernel
        // features, privileged daemon, GUI on macOS); we can't ship
        // one, so guidance-only.
        auto_installable: false,
    },
    PrereqTool {
        name: "kubectl",
        purpose: "Used to read Deployments / Services / pod logs from the microVM.",
        version_args: &["version", "--client"],
        auto_installable: true,
    },
];

/// Per-OS install command for a prerequisite. Surfaced to the UI so
/// the user can copy-paste a working install line for their platform
/// instead of hunting through docs after seeing a spawn error.
fn install_hint(tool: &str) -> &'static str {
    if cfg!(target_os = "macos") {
        match tool {
            "docker" => "Install any container runtime (Docker Desktop, OrbStack, Colima, Rancher Desktop). https://www.docker.com/products/docker-desktop/ — https://orbstack.dev — https://github.com/abiosoft/colima",
            "kubectl" => "brew install kubectl",
            _ => "",
        }
    } else if cfg!(target_os = "linux") {
        match tool {
            "docker" => "Install any container runtime (Docker Engine, Podman, Rancher Desktop). Docker Engine: curl -fsSL https://get.docker.com | sh",
            "kubectl" => "curl -LO https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl && sudo install -m 0755 kubectl /usr/local/bin/kubectl",
            _ => "",
        }
    } else if cfg!(target_os = "windows") {
        match tool {
            "docker" => "Install any container runtime (Docker Desktop, Rancher Desktop, Podman Desktop). https://www.docker.com/products/docker-desktop/",
            "kubectl" => "winget install Kubernetes.kubectl",
            _ => "",
        }
    } else {
        ""
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PreflightCheck {
    /// Tool name as invoked on the command line (`docker`, `kubectl`, …).
    tool: String,
    /// True when the tool resolved on PATH and `<tool> --version` exited 0.
    installed: bool,
    /// First non-empty line of stdout from `<tool> --version`. Useful for
    /// confirming compatibility (e.g. older tool versions miss flags).
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    /// One-line human description of what this tool is used for.
    purpose: String,
    /// Platform-appropriate install command. Empty on unsupported OSes.
    install_hint: String,
    /// True when `appliance local install <tool>` can ship a working
    /// binary without manual steps. Drives whether the UI shows an
    /// Install button vs. only the copy-paste hint.
    auto_installable: bool,
    /// stderr captured when the version check itself failed (e.g. docker
    /// daemon not running for `docker version`). Lets the UI distinguish
    /// "not installed" from "installed but broken".
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// For docker only: whether a daemon is actually *reachable*, not
    /// just whether the CLI is installed. `None` for tools where daemon
    /// state is meaningless (kubectl), so the UI only special-cases
    /// docker. A `Some(false)` here is "installed but not running".
    #[serde(skip_serializing_if = "Option::is_none")]
    daemon_running: Option<bool>,
    /// For docker only, meaningful when `daemon_running` is `Some(false)`:
    /// whether appliance can start the runtime itself (colima is the
    /// active runtime). Drives a "Start runtime" button vs. manual-start
    /// guidance in the doctor view.
    #[serde(skip_serializing_if = "Option::is_none")]
    daemon_startable: Option<bool>,
}

/// Probe each required CLI tool with `--version`. Designed to never
/// fail the call itself — every tool returns a structured record the UI
/// can render even when nothing is installed, so users can copy the
/// install commands without first hitting a cryptic spawn error.
#[tauri::command]
async fn local_preflight() -> Vec<PreflightCheck> {
    let mut out = Vec::with_capacity(LOCAL_PREREQS.len() + 1);
    // Windows: WSL2 is THE gating prerequisite — the Dev Machine is a
    // WSL2 distro. Without this row, a machine with WSL missing or
    // virtualization disabled shows an all-green checkup and then dies
    // minutes later at first boot with a generic error.
    #[cfg(windows)]
    out.push(wsl_preflight_check().await);
    for tool in LOCAL_PREREQS {
        let mut check = probe_tool(tool).await;
        // Docker is special: `--version` only proves the CLI exists, not
        // that a daemon is reachable. Probe the daemon too so the doctor
        // view can show "installed but not running" (and offer to start
        // it) instead of a misleading green check followed by a failed
        // Start. kubectl has no daemon, so leave its fields None.
        if tool.name == "docker" && check.installed {
            let reachable = docker_daemon_reachable().await;
            check.daemon_running = Some(reachable);
            if !reachable {
                let startable = colima_is_active_runtime().await;
                check.daemon_startable = Some(startable);
                check.error = Some(if startable {
                    "Docker is installed but its colima VM isn't running.".to_string()
                } else {
                    docker_unreachable_hint()
                });
            }
        }
        out.push(check);
    }
    out
}

/// Decode wsl.exe output: its own diagnostics are UTF-16LE (guest
/// output is UTF-8) — interior NULs in the head are the UTF-16 tell.
/// Copy of `decode_wsl` in packages/vm/src/backend/wsl.rs (this crate
/// drives appliance-vm as a sidecar binary, not a Cargo dependency, so
/// the 10 lines can't be shared). Note the TS analogue
/// (`decodeWindowsToolOutput` in the CLI's preflight) uses a stricter
/// even-offset-NUL sniff; this any-NUL form is adequate for wsl.exe
/// diagnostics, which are pure ASCII UTF-16LE.
#[cfg(windows)]
fn decode_wsl_text(bytes: &[u8]) -> String {
    if bytes.iter().take(64).any(|&b| b == 0) {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// Probe WSL2 readiness for the doctor view. Reports "installed but
/// broken" with wsl.exe's own first diagnostic line (virtualization
/// disabled, kernel outdated, …) rather than a bare boolean.
#[cfg(windows)]
async fn wsl_preflight_check() -> PreflightCheck {
    let probe = quiet_command("wsl.exe").arg("--status").output().await;
    let (installed, version, error) = match probe {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (
            false,
            None,
            Some("WSL is not installed (wsl.exe not found).".to_string()),
        ),
        Err(e) => (false, None, Some(format!("could not run wsl.exe: {e}"))),
        Ok(out) if out.status.success() => (true, Some("WSL2 ready".to_string()), None),
        Ok(out) => {
            let text = decode_wsl_text(&[&out.stdout[..], &out.stderr[..]].concat());
            let first = text
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty())
                .unwrap_or("WSL is not ready")
                .to_string();
            (false, None, Some(first))
        }
    };
    PreflightCheck {
        tool: "wsl".to_string(),
        installed,
        version,
        purpose: "Windows Subsystem for Linux 2 — runs the Dev Machine (the managed VM).".to_string(),
        install_hint:
            "Open PowerShell as Administrator, run `wsl --install`, then reboot. If it still fails, enable virtualization in your BIOS/UEFI and run `wsl --update`."
                .to_string(),
        auto_installable: false,
        error,
        daemon_running: None,
        daemon_startable: None,
    }
}

async fn probe_tool(tool: &PrereqTool) -> PreflightCheck {
    let probe = quiet_command(tool.name)
        .args(tool.version_args)
        .output()
        .await;
    match probe {
        Ok(output) if output.status.success() => {
            let line = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            PreflightCheck {
                tool: tool.name.to_string(),
                installed: true,
                version: line,
                purpose: tool.purpose.to_string(),
                install_hint: install_hint(tool.name).to_string(),
                auto_installable: tool.auto_installable,
                error: None,
                daemon_running: None,
                daemon_startable: None,
            }
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let (hint, error) = resolve_missing_hint(
                tool.name,
                if stderr.is_empty() {
                    None
                } else {
                    Some(stderr)
                },
            )
            .await;
            PreflightCheck {
                tool: tool.name.to_string(),
                installed: false,
                version: None,
                purpose: tool.purpose.to_string(),
                install_hint: hint,
                auto_installable: tool.auto_installable,
                error,
                daemon_running: None,
                daemon_startable: None,
            }
        }
        Err(err) => {
            let raw = if err.kind() == std::io::ErrorKind::NotFound {
                "not on PATH".to_string()
            } else {
                err.to_string()
            };
            let (hint, error) = resolve_missing_hint(tool.name, Some(raw)).await;
            PreflightCheck {
                tool: tool.name.to_string(),
                installed: false,
                version: None,
                purpose: tool.purpose.to_string(),
                install_hint: hint,
                auto_installable: tool.auto_installable,
                error,
                daemon_running: None,
                daemon_startable: None,
            }
        }
    }
}

/// Customise the install hint for a missing tool when an adjacent
/// runtime is already on PATH. Appliance shells out to the `docker`
/// CLI specifically, so a Colima- or Podman-only setup looks like
/// "I have a runtime" to the user but trips us up. Detect those and
/// turn the generic "install a runtime" hint into one targeted line:
///
///   * Colima present → `brew install docker` (Colima is the daemon;
///     the user just needs the matching CLI client).
///   * Podman present → suggest podman-mac-helper / aliasing (Podman
///     ships its own CLI; bridging it to `docker` gives Appliance what
///     it needs).
///
/// Returns `(install_hint, error_message)`.
async fn resolve_missing_hint(tool: &str, raw_error: Option<String>) -> (String, Option<String>) {
    if tool != "docker" {
        return (install_hint(tool).to_string(), raw_error);
    }
    if which_succeeds("colima").await {
        let hint =
            "brew install docker  # Colima is already on PATH; this adds the matching `docker` CLI client.".to_string();
        let note = "Colima is installed but Appliance needs the `docker` CLI (it shells out to `docker build` / `docker save`). Install the client alongside the runtime."
            .to_string();
        return (hint, merge_note(raw_error, note));
    }
    if which_succeeds("podman").await {
        let hint = if cfg!(target_os = "macos") {
            "brew install podman-mac-helper && sudo podman-mac-helper install  # exposes Podman as a `docker`-compatible socket+CLI".to_string()
        } else {
            "Install the `podman-docker` package, or alias `docker` to `podman`".to_string()
        };
        let note = "Podman is installed but Appliance shells out to the `docker` CLI. Bridge them via podman-docker / an alias and retry."
            .to_string();
        return (hint, merge_note(raw_error, note));
    }
    (install_hint(tool).to_string(), raw_error)
}

async fn which_succeeds(cmd: &str) -> bool {
    quiet_command(cmd)
        .arg("--version")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn merge_note(raw: Option<String>, note: String) -> Option<String> {
    match raw {
        Some(prev) if !prev.is_empty() => Some(format!("{note} ({prev})")),
        _ => Some(note),
    }
}

/// Wrap a spawn error in an actionable, installer-aware message when the
/// underlying OS error is "command not found". Other errors pass through
/// unchanged so debugging info isn't lost.
fn map_spawn_error(tool: &str, err: std::io::Error) -> String {
    if err.kind() == std::io::ErrorKind::NotFound {
        let hint = install_hint(tool);
        if hint.is_empty() {
            format!("`{tool}` is not installed or not on PATH.")
        } else {
            format!(
                "`{tool}` is not installed or not on PATH. Install it with:\n  {hint}\nThen retry."
            )
        }
    } else {
        format!("failed to spawn {tool}: {err}")
    }
}

/// Build a `tokio::process::Command` that never flashes a console
/// window on Windows. The desktop is a GUI (windowless) process, so
/// spawning a console child (`appliance-vm.exe`, `kubectl`, `node`)
/// allocates a fresh console that blinks on screen by default — and the
/// VM status poll runs every few seconds. Every raw spawn in this crate
/// must go through here (tauri's shell-plugin sidecars already hide
/// their consoles themselves).
fn quiet_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd
}

async fn run_status_command(args: &[&str]) -> Result<(bool, String, String), String> {
    let output = quiet_command(args[0])
        .args(&args[1..])
        .output()
        .await
        .map_err(|e| map_spawn_error(args[0], e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Ok((output.status.success(), stdout, stderr))
}

// A cold colima VM boot (disk allocation, base image pull, network
// setup) can take well over a minute on first start; bound it
// generously so a genuinely wedged `colima start` still can't hang the
// caller forever, while leaving plenty of headroom for a normal boot.
const COLIMA_START_TIMEOUT_SECS: u64 = 240;

/// Probe whether a Docker daemon is actually *reachable* — distinct
/// from "the `docker` CLI is on PATH". The preflight's `docker
/// --version` only proves the client binary exists; it exits 0 even
/// when no daemon is running. `docker version --format
/// {{.Server.Version}}` forces a round-trip to the daemon, so a
/// non-zero exit here means "installed but not running" — the exact
/// state a stopped colima VM leaves the machine in.
async fn docker_daemon_reachable() -> bool {
    matches!(
        run_status_command(&["docker", "version", "--format", "{{.Server.Version}}"]).await,
        Ok((true, _, _))
    )
}

/// Docker contexts created by GUI runtimes. When any of these exist
/// alongside colima, the machine has a competing runtime that may own
/// the default socket — auto-starting colima could race or confuse
/// it, so we stay hands-off and surface guidance instead.
const GUI_RUNTIME_CONTEXTS: [&str; 3] = ["desktop-linux", "orbstack", "rancher-desktop"];

/// Whether the user has a colima VM instance (running or stopped).
/// `colima list -j` emits one JSON object per line, one per instance;
/// empty when the user never created a VM (`colima start` would then
/// build a fresh one — a bigger action than restarting the VM they
/// already had, so we don't auto-start in that case).
async fn colima_instance_exists() -> bool {
    match run_status_command(&["colima", "list", "-j"]).await {
        Ok((true, out, _)) => out.lines().filter(|l| !l.trim().is_empty()).any(|l| {
            serde_json::from_str::<serde_json::Value>(l)
                .ok()
                .and_then(|v| {
                    v.get("name")
                        .and_then(|n| n.as_str())
                        .map(|s| !s.is_empty())
                })
                .unwrap_or(false)
        }),
        _ => false,
    }
}

/// True when colima is the runtime providing Docker on this machine —
/// the guard for auto-start: we only bring colima up when the user's
/// docker is actually backed by it, never when they're on Docker
/// Desktop / OrbStack with a stray colima install sitting alongside.
///
/// Detection, in order of confidence:
///   1. `DOCKER_HOST` points at a colima socket.
///   2. The active docker context is `colima`.
///   3. The active context is `default` (a clean `colima stop` resets
///      the context, so a stopped colima looks exactly like "no
///      runtime" here), a colima VM instance exists, and no GUI
///      runtime context is present to claim the default socket
///      instead.
async fn colima_is_active_runtime() -> bool {
    if !which_succeeds("colima").await {
        return false;
    }
    if std::env::var("DOCKER_HOST")
        .map(|h| h.contains(".colima"))
        .unwrap_or(false)
    {
        return true;
    }
    let current = match run_status_command(&["docker", "context", "show"]).await {
        Ok((true, ctx, _)) => ctx.trim().to_string(),
        _ => return false,
    };
    if current == "colima" {
        return true;
    }
    if current != "default" {
        return false;
    }
    let names: Vec<String> =
        match run_status_command(&["docker", "context", "ls", "--format", "{{.Name}}"]).await {
            Ok((true, out, _)) => out
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect(),
            _ => return false,
        };
    if names
        .iter()
        .any(|n| GUI_RUNTIME_CONTEXTS.contains(&n.as_str()))
    {
        return false;
    }
    colima_instance_exists().await
}

/// Platform-appropriate nudge for "Docker is installed but the daemon
/// isn't reachable" in the cases appliance can't safely auto-start
/// (Docker Desktop is a GUI app, system dockerd needs root). colima is
/// handled before we ever reach this, so we don't suggest it as the
/// primary fix here.
fn docker_unreachable_hint() -> String {
    if cfg!(target_os = "macos") {
        "Docker isn't running. Start your container runtime — Docker Desktop, OrbStack, or `colima start` — and retry.".to_string()
    } else if cfg!(target_os = "linux") {
        "Docker isn't running. Start it with `sudo systemctl start docker` and retry.".to_string()
    } else {
        "Docker isn't running. Start Docker Desktop and retry.".to_string()
    }
}

/// Like `run_status_command` but bounded by `timeout`. Reserved for the
/// few operations that can legitimately run for a minute-plus (booting
/// a colima VM) where a wedged invocation must not hang the caller
/// indefinitely.
async fn run_command_with_timeout(
    args: &[&str],
    timeout: Duration,
) -> Result<(bool, String, String), String> {
    match tokio::time::timeout(timeout, run_status_command(args)).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "`{}` timed out after {}s.",
            args.join(" "),
            timeout.as_secs()
        )),
    }
}

/// Bring the container runtime up if appliance can do so safely.
///
/// The `docker` provider is intentionally detect-only — we don't
/// install or boot arbitrary runtimes (Docker Desktop is a GUI app,
/// system dockerd needs root; both "fork system trust decisions").
/// Colima is the one exception worth automating: it's a userland CLI
/// the user installed themselves, and `colima start` is an ordinary
/// unprivileged, idempotent command — exactly what they'd type by
/// hand. So when Docker is unreachable *and* the CLI is wired to
/// colima, we start it for them; every other "daemon down" case
/// returns an actionable message instead of letting a cryptic
/// container-runtime timeout surface downstream.
async fn ensure_docker_running() -> Result<(), String> {
    if docker_daemon_reachable().await {
        return Ok(());
    }
    if !colima_is_active_runtime().await {
        return Err(docker_unreachable_hint());
    }
    // colima start is idempotent: a no-op if already running, boots the
    // VM otherwise.
    match run_command_with_timeout(
        &["colima", "start"],
        Duration::from_secs(COLIMA_START_TIMEOUT_SECS),
    )
    .await
    {
        Ok((true, _, _)) => {}
        Ok((false, _, stderr)) => {
            return Err(format!(
                "Docker isn't running and `colima start` failed: {}",
                stderr.trim()
            ));
        }
        Err(e) => return Err(e),
    }
    // The host-side docker socket can lag a beat behind colima
    // reporting ready while the forward is wired up, so poll briefly
    // rather than assuming reachability the instant `colima start`
    // returns.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        if docker_daemon_reachable().await {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(
                "colima started but the Docker daemon is still unreachable. Check `colima status` and `docker info`."
                    .to_string(),
            );
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// Start the container runtime (colima) on behalf of the user when
/// appliance can do so safely. Thin command wrapper over
/// `ensure_docker_running` so the doctor view's "Start runtime" button
/// and the implicit cluster-start path share one code path; the error
/// string carries actionable guidance for runtimes we can't auto-start.
#[tauri::command]
async fn start_container_runtime() -> Result<(), String> {
    ensure_docker_running().await
}

// ============================================================
// Local runtime support surface
//
// What remains after bare k3d's removal: the shared runtime-config
// resolution that the in-cluster api-server bootstrap and the
// engine-routed workload/log reads build on. The local runtime itself
// is the microVM (driven through the `vm`/microVM commands), an
// `appliance-base-kubernetes` cluster that registers like any other.
// ============================================================

/// Runtime input shared by the in-cluster bootstrap + the engine-routed
/// workload/log reads. All fields are optional and fall back to
/// baked-in defaults.
#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
struct LocalRuntimeInput {
    cluster_name: Option<String>,
    namespace: Option<String>,
    host_port: Option<u16>,
    data_dir: Option<String>,
    /// Which local engine kubectl-level reads (workloads, pod logs)
    /// address — "microvm" routes through the microVM's fetched
    /// kubeconfig. The sole local engine now that bare k3d is gone.
    engine: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ResolvedRuntimeConfig {
    cluster_name: String,
    namespace: String,
    host_port: u16,
    data_dir: String,
    api_server_url: String,
}

fn resolve_runtime_config(
    app: &AppHandle,
    input: &LocalRuntimeInput,
) -> Result<ResolvedRuntimeConfig, String> {
    let cluster_name = input
        .cluster_name
        .clone()
        .unwrap_or_else(|| DEFAULT_LOCAL_CLUSTER_NAME.to_string());
    let namespace = input
        .namespace
        .clone()
        .unwrap_or_else(|| DEFAULT_LOCAL_NAMESPACE.to_string());
    let host_port = input.host_port.unwrap_or(DEFAULT_LOCAL_HOST_PORT);
    let data_dir = match &input.data_dir {
        Some(p) => PathBuf::from(p),
        None => default_local_runtime_dir(app)?,
    };
    // api-server lives in-cluster behind the Ingress, reached at
    // `host_port`. URL omits the port when it's 80.
    let api_server_url = if host_port == 80 {
        format!("http://{}", IN_CLUSTER_API_SERVER_HOSTNAME)
    } else {
        format!("http://{}:{}", IN_CLUSTER_API_SERVER_HOSTNAME, host_port)
    };
    Ok(ResolvedRuntimeConfig {
        cluster_name,
        namespace,
        host_port,
        data_dir: data_dir.to_string_lossy().to_string(),
        api_server_url,
    })
}

/// Default data dir for the local runtime. Shared with the CLI:
/// `~/.appliance/local-runtime/` (same convention `appliance` already
/// uses for its credentials store + the demo script). Falling back to
/// the Tauri-managed `app_data_dir()` when $HOME is unset keeps Linux
/// CI / sandbox builds working — the only case where the env var
/// might not be set.
///
/// Migration: if the legacy `<app-config>/local-runtime/` directory
/// exists but the new one doesn't, surface a one-line warning to
/// stderr so the operator can move the data over manually. Auto-
/// migration of a multi-GB Pulumi/api-server state dir is too risky
/// to do silently.
fn default_local_runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let preferred = home_dir().map(|h| h.join(SHARED_PROFILES_DIR).join("local-runtime"));
    let legacy = app
        .path()
        .app_data_dir()
        .map(|d| d.join("local-runtime"))
        .ok();

    if let Some(preferred) = preferred {
        if let Some(legacy) = legacy.as_ref() {
            if legacy.exists() && !preferred.exists() {
                eprintln!(
                    "warn: legacy local-runtime data at {} — move it to {} to share state with the CLI",
                    legacy.display(),
                    preferred.display()
                );
            }
        }
        return Ok(preferred);
    }

    legacy.ok_or_else(|| {
        "could not resolve a local-runtime data dir (no $HOME, no app data dir)".to_string()
    })
}

/// Generate a short opaque token used as BOOTSTRAP_TOKEN for the
/// in-cluster api-server. Valid only for the lifetime of this
/// bootstrap call — once we mint an api key, the token is forgotten.
fn random_bootstrap_token() -> String {
    uuid::Uuid::new_v4().to_string().replace('-', "")
}

// ============================================================
// In-cluster api-server bootstrap
//
// Generates and applies the manifests that run api-server *inside*
// the cluster — Deployment + Service + Ingress, plus a
// ServiceAccount/Role bound to the appliance namespace so the
// in-cluster api-server can drive deploys against itself via
// loadFromCluster(). The same image works against any kubernetes
// cluster; here it's pulled from the cluster-attached registry.
//
// This is the model for `appliance-base-kubernetes`: a Tauri command
// the frontend invokes against a reachable cluster (the microVM passes
// its fetched kubeconfig), independent of any host-side runtime
// lifecycle.
// ============================================================

const IN_CLUSTER_API_SERVER_NAMESPACE: &str = "appliance-system";
const IN_CLUSTER_API_SERVER_NAME: &str = "api-server";
const IN_CLUSTER_API_SERVER_HOSTNAME: &str = "api.appliance.localhost";
const IN_CLUSTER_API_SERVER_PORT: u16 = 3000;
// Default api-server image. Cluster pulls this directly from ghcr
// on first deploy; subsequent pod restarts reuse the cached image
// thanks to `imagePullPolicy: IfNotPresent`. Override via the
// `image` field on `BootstrapInClusterInput` for local dev iteration
// (build → push to <registry_url>/appliance-api-server:<tag>, pass
// that ref through). The tag tracks the SDK release stream — bump
// in lockstep with packages/sdk's published version.
const IN_CLUSTER_API_SERVER_DEFAULT_IMAGE: &str = "ghcr.io/appliance-sh/api-server:latest";

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct BootstrapInClusterInput {
    /// Override the runtime input that resolves cluster name, data
    /// dir, namespace, host port, etc. Defaults to the baked-in
    /// runtime-config defaults.
    runtime: Option<LocalRuntimeInput>,
    /// Override the api-server image reference. Defaults to
    /// `ghcr.io/appliance-sh/api-server:latest` (cluster pulls from
    /// ghcr on first deploy, caches thereafter). For local dev
    /// iteration build the image and push to
    /// `<registry_url>/appliance-api-server:<tag>`, then pass that
    /// ref through here so the cluster pulls from the local
    /// registry mirror instead.
    image: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BootstrapInClusterResult {
    /// Hostname the in-cluster api-server is reachable at. Always
    /// goes through the cluster's Ingress so the URL is identical
    /// across local + remote deploys of the same image.
    api_server_url: String,
    /// API key minted via the bootstrap token. Caller persists this
    /// alongside the cluster registration so the SDK can sign
    /// subsequent requests.
    api_key: ApiKey,
}

/// Build the JSON `APPLIANCE_BASE_CONFIG` env value for the in-cluster
/// api-server. Uses the new `appliance-base-kubernetes` variant — the
/// in-cluster api-server authenticates via its mounted ServiceAccount
/// (loadFromCluster()), so we don't ship server/token here.
fn build_in_cluster_base_config(cfg: &ResolvedRuntimeConfig) -> String {
    // namespace must track cfg.namespace (which honors user
    // input.namespace override). Hardcoding to DEFAULT_LOCAL_NAMESPACE
    // would silently diverge from the namespace the api-server's
    // workloads endpoint queries against. hostnameSuffix +
    // ingressClassName are currently not user-overridable so the
    // defaults match LocalContainerDeploymentService's defaults; lift
    // them onto ResolvedRuntimeConfig if/when an override surface
    // appears. The registry is configured by the engine's own bring-up
    // (the microVM's in-VM registry), not from here.
    let kubernetes = serde_json::json!({
        "dataDir": "/data",
        "namespace": cfg.namespace,
        "hostnameSuffix": "appliance.localhost",
        "ingressClassName": "traefik",
        // The ingress publishes :80 on this host port — deploy-result
        // URLs must carry it to be clickable from the host
        // (KubernetesDeploymentService composes
        // `http://<stack>.<suffix>[:<hostPort>]` from it).
        "hostPort": cfg.host_port,
    });
    serde_json::json!({
        "type": "appliance-base-kubernetes",
        "name": "local-runtime",
        "kubernetes": kubernetes,
    })
    .to_string()
}

/// Minimal-escape transform for values interpolated into YAML
/// double-quoted scalars. Covers the three characters that can
/// break a double-quoted scalar: `\` (escape lead-in), `\n` (closes
/// the scalar mid-string), `"` (terminates the scalar). Quoting at
/// the call sites is unconditional, so we don't need to handle the
/// plain-scalar reserved characters here.
fn yaml_double_quoted(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('\n', "\\n")
        .replace('"', "\\\"")
}

/// Compose the multi-document YAML manifest deployed via kubectl apply.
/// Resource breakdown:
///   * Namespace `appliance-system` — keeps system components separate
///     from user appliances (which land in `appliance`).
///   * ServiceAccount + ClusterRole + ClusterRoleBinding — grants the
///     in-cluster api-server CRUD on the resources it manages
///     (deployments, services, ingresses, pods, namespaces, secrets).
///   * Secret — carries APPLIANCE_BASE_CONFIG + BOOTSTRAP_TOKEN so the
///     deployment env doesn't expose them in `kubectl describe`.
///   * PersistentVolume + PersistentVolumeClaim — hostPath-backed PV
///     mounted into the api-server pod as /data, mirroring the
///     filesystem object store path the cloud path stores in S3.
///   * Deployment + Service + Ingress — the api-server itself, fronted
///     by the cluster's Traefik at `api.appliance.localhost`.
fn render_in_cluster_api_server_manifest(
    cfg: &ResolvedRuntimeConfig,
    image: &str,
    bootstrap_token: &str,
) -> String {
    let base_config = build_in_cluster_base_config(cfg);
    let escaped_base_config = yaml_double_quoted(&base_config);
    // Windows resolves data_dir through Tauri's app_data_dir() into
    // a backslash-laden path (`C:\Users\..`). YAML 1.2 only accepts
    // a fixed set of escapes inside double-quoted scalars (`\n`, `\t`,
    // `\\`, `\"`, `\uNNNN`, `\UNNNNNNNN`, …); a bare `\U` followed
    // by anything other than 8 hex digits parses as an invalid
    // escape and kubectl rejects the whole apply. Same escape pass
    // as base_config keeps both safe for Windows + arbitrary
    // user-supplied overrides.
    let host_data_dir = yaml_double_quoted(&cfg.data_dir);
    format!(
        r#"apiVersion: v1
kind: Namespace
metadata:
  name: {ns}
  labels:
    app.kubernetes.io/managed-by: appliance.sh
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {name}
  namespace: {ns}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: appliance-api-server
rules:
- apiGroups: [""]
  resources: ["namespaces", "services", "pods", "secrets", "configmaps", "persistentvolumeclaims", "events"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["apps"]
  resources: ["deployments", "replicasets"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["networking.k8s.io"]
  resources: ["ingresses"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["pods/log"]
  verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: appliance-api-server
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: appliance-api-server
subjects:
- kind: ServiceAccount
  name: {name}
  namespace: {ns}
---
apiVersion: v1
kind: Secret
metadata:
  name: {name}-config
  namespace: {ns}
type: Opaque
stringData:
  APPLIANCE_BASE_CONFIG: "{base_config}"
  BOOTSTRAP_TOKEN: "{token}"
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: appliance-data
  labels:
    app.kubernetes.io/managed-by: appliance.sh
spec:
  capacity:
    storage: 10Gi
  accessModes: [ReadWriteOnce]
  hostPath:
    path: "{data_dir}"
  persistentVolumeReclaimPolicy: Retain
  storageClassName: ""
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: appliance-data
  namespace: {ns}
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 10Gi
  volumeName: appliance-data
  storageClassName: ""
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {name}
  namespace: {ns}
  labels:
    app.kubernetes.io/name: {name}
    app.kubernetes.io/managed-by: appliance.sh
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: {name}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: {name}
        app.kubernetes.io/managed-by: appliance.sh
    spec:
      serviceAccountName: {name}
      containers:
      - name: api-server
        image: "{image}"
        imagePullPolicy: IfNotPresent
        ports:
        - containerPort: {port}
          name: http
        envFrom:
        - secretRef:
            name: {name}-config
        env:
        - name: APPLIANCE_MODE
          value: "server"
        - name: PORT
          value: "{port}"
        - name: HOST
          value: "0.0.0.0"
        readinessProbe:
          httpGet:
            path: /bootstrap/status
            port: {port}
          initialDelaySeconds: 2
          periodSeconds: 2
        volumeMounts:
        - name: data
          mountPath: /data
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: appliance-data
---
apiVersion: v1
kind: Service
metadata:
  name: {name}
  namespace: {ns}
  labels:
    app.kubernetes.io/managed-by: appliance.sh
spec:
  selector:
    app.kubernetes.io/name: {name}
  ports:
  - port: 80
    targetPort: {port}
    protocol: TCP
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {name}
  namespace: {ns}
  labels:
    app.kubernetes.io/managed-by: appliance.sh
spec:
  ingressClassName: traefik
  rules:
  - host: {hostname}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: {name}
            port:
              number: 80
"#,
        ns = IN_CLUSTER_API_SERVER_NAMESPACE,
        name = IN_CLUSTER_API_SERVER_NAME,
        hostname = IN_CLUSTER_API_SERVER_HOSTNAME,
        port = IN_CLUSTER_API_SERVER_PORT,
        image = image,
        data_dir = host_data_dir,
        base_config = escaped_base_config,
        token = bootstrap_token,
    )
}

/// Read the existing BOOTSTRAP_TOKEN out of the api-server Secret in
/// the appliance-system namespace. Returns None when the Secret
/// doesn't exist yet (first bootstrap), when kubectl fails (cluster
/// down), or when the field is absent. Used so re-bootstrap reuses
/// the token the already-running pod's env was seeded with — see
/// bug_004 reasoning in bootstrap_in_cluster_api_server.
async fn read_existing_bootstrap_token() -> Option<String> {
    let (ok, stdout, _stderr) = run_status_command(&[
        "kubectl",
        "-n",
        IN_CLUSTER_API_SERVER_NAMESPACE,
        "get",
        "secret",
        &format!("{}-config", IN_CLUSTER_API_SERVER_NAME),
        "-o",
        "jsonpath={.data.BOOTSTRAP_TOKEN}",
    ])
    .await
    .ok()?;
    if !ok {
        return None;
    }
    let encoded = stdout.trim();
    if encoded.is_empty() {
        return None;
    }
    // Secret values are base64-encoded on read. Decode and validate
    // it's a non-empty UTF-8 string before reusing.
    use base64::Engine;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let token = String::from_utf8(decoded).ok()?;
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

/// Pipe a manifest string into `kubectl apply -f -` so we don't have
/// to materialize a temp file on disk. Surfaces stderr verbatim — the
/// kubectl error messages are usually self-explanatory and the caller
/// just bubbles them up to the UI.
async fn kubectl_apply_manifest(manifest: &str) -> Result<(), String> {
    let mut child = quiet_command("kubectl")
        .args(["apply", "-f", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn kubectl: {e}"))?;
    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "kubectl stdin unavailable".to_string())?;
        stdin
            .write_all(manifest.as_bytes())
            .await
            .map_err(|e| format!("write kubectl stdin: {e}"))?;
    }
    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("kubectl wait: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("kubectl apply failed: {}", stderr));
    }
    Ok(())
}

/// Poll an arbitrary URL until /bootstrap/status returns 2xx, or the
/// timeout elapses. Used to detect when the in-cluster api-server is
/// past its readiness probe and reachable via the cluster's Ingress.
async fn wait_for_api_server_url(url: &str, max_wait: Duration) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + max_wait;
    let target = format!("{}/bootstrap/status", url.trim_end_matches('/'));
    loop {
        let (ok, _stdout, _stderr) =
            run_status_command(&["curl", "-fsS", "-o", "/dev/null", &target]).await?;
        if ok {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "in-cluster api-server did not become reachable at {url} within {}s",
                max_wait.as_secs()
            ));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// Mint an api key against an api-server's bootstrap route. Mirrors
/// the host-side `mint_api_key` but takes the full URL instead of a
/// loopback port — same `/bootstrap/create-key` route, same payload.
/// `key_name` is the human label stored with the key.
async fn mint_api_key_url(
    api_server_url: &str,
    token: &str,
    key_name: &str,
) -> Result<ApiKey, String> {
    let url = format!(
        "{}/bootstrap/create-key",
        api_server_url.trim_end_matches('/')
    );
    let body = serde_json::json!({ "name": key_name }).to_string();
    let (ok, stdout, stderr) = run_status_command(&[
        "curl",
        "-fsS",
        "-X",
        "POST",
        &url,
        "-H",
        &format!("X-Bootstrap-Token: {}", token),
        "-H",
        "content-type: application/json",
        "-d",
        &body,
    ])
    .await?;
    if !ok {
        return Err(format!("mint api key failed: {}", stderr));
    }
    serde_json::from_str::<ApiKey>(&stdout).map_err(|e| format!("parse api key: {e}"))
}

/// Apply the in-cluster api-server manifests to the running
/// cluster, wait for the deployment to become reachable, and mint
/// the first API key. The api-server image must already be present
/// in the cluster-attached registry (pushed by `appliance vm up`'s
/// provisioning, or pre-pulled from a remote registry). Idempotent:
/// applying twice reconciles the manifest in place and mints a
/// fresh key.
#[tauri::command]
async fn bootstrap_in_cluster_api_server(
    app: AppHandle,
    input: BootstrapInClusterInput,
) -> Result<BootstrapInClusterResult, String> {
    let runtime_input = input.runtime.unwrap_or_default();
    let cfg = resolve_runtime_config(&app, &runtime_input)?;
    let image = input
        .image
        .unwrap_or_else(|| IN_CLUSTER_API_SERVER_DEFAULT_IMAGE.to_string());
    // Reuse the existing Secret's BOOTSTRAP_TOKEN when one is
    // present — the running api-server pod's env was populated via
    // envFrom at container start, which is a one-shot snapshot;
    // updating the Secret does NOT re-inject env vars or restart
    // the pod, so minting a fresh token here would mean the pod's
    // env (old token) and the curl we POST below (new token) never
    // match — 401 forever, until manual pod restart. Reading the
    // existing token sidesteps this and keeps re-bootstrap clean
    // when the pod is already up.
    let bootstrap_token = read_existing_bootstrap_token()
        .await
        .unwrap_or_else(random_bootstrap_token);
    let manifest = render_in_cluster_api_server_manifest(&cfg, &image, &bootstrap_token);
    kubectl_apply_manifest(&manifest).await?;

    // The Ingress goes through the cluster's serverlb host port. URL
    // shape mirrors what user appliances get (`<name>.appliance.localhost`)
    // so the desktop's cluster registry can treat the in-cluster
    // api-server as just-another-reachable-URL.
    let api_server_url = if cfg.host_port == 80 {
        format!("http://{}", IN_CLUSTER_API_SERVER_HOSTNAME)
    } else {
        format!(
            "http://{}:{}",
            IN_CLUSTER_API_SERVER_HOSTNAME, cfg.host_port
        )
    };
    wait_for_api_server_url(&api_server_url, Duration::from_secs(60)).await?;
    let api_key = mint_api_key_url(&api_server_url, &bootstrap_token, "Local Runtime").await?;
    Ok(BootstrapInClusterResult {
        api_server_url,
        api_key,
    })
}

// --- microVM engine ---------------------------------------------------
//
// The microVM runtime (packages/vm — appliance-vm) is driven through
// two channels: lifecycle reads/stops go straight to the appliance-vm
// binary; the full `up` orchestration (in-VM registry wait, api-server
// image push, bootstrap, profile registration) lives in the bundled
// appliance CLI (`appliance vm up`) and is streamed here, so desktop
// and CLI share one implementation of the control-plane logic.
//
// The engine binary itself is desktop-managed: packaged builds carry
// it as a bundle resource (scripts/copy-vm.mjs), dev builds reach for
// the repo's cargo output, and `microvm_install` places it in
// ~/.appliance/bin — the shared managed location the CLI resolves too.

/// Platform file name of the microVM engine binary (cargo emits
/// `appliance-vm.exe` on Windows, `appliance-vm` elsewhere). Every
/// path that stores, stages, or resolves the engine must use this —
/// a bare `appliance-vm` never matches on Windows.
const VM_BIN_NAME: &str = if cfg!(windows) {
    "appliance-vm.exe"
} else {
    "appliance-vm"
};

/// Locate the appliance-vm binary: the helper-managed bin dir first
/// (the CLI's `appliance vm` resolves the same path), then PATH.
fn vm_binary() -> Option<PathBuf> {
    if let Some(home) = home_dir() {
        let managed = home.join(SHARED_PROFILES_DIR).join("bin").join(VM_BIN_NAME);
        if managed.exists() {
            return Some(managed);
        }
    }
    which_path(VM_BIN_NAME)
}

/// Where an installable appliance-vm binary can come from: the
/// bundled resource (packaged builds; placed by scripts/copy-vm.mjs),
/// or — in dev builds — the repo checkout's cargo output.
fn vm_install_source(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(resource) = app.path().resolve(
        &format!("vm-bin/{VM_BIN_NAME}"),
        tauri::path::BaseDirectory::Resource,
    ) {
        if resource.is_file() {
            return Some(resource);
        }
    }
    #[cfg(debug_assertions)]
    {
        let vm_target = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../vm/target");
        for profile in ["release", "debug"] {
            let candidate = vm_target.join(profile).join(VM_BIN_NAME);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Repo-built guest api-server staged as a bundle resource by
/// scripts/stage-apiserver.mjs (dev/debug pipelines only; the release
/// pipeline clears the dir). When present, the CLI spawns that stage
/// guest artifacts (`vm up` / `agent start`) export it as
/// APPLIANCE_API_SERVER_BINARY so the bundled CLI stages this build
/// instead of its version-pinned release download — a desktop built
/// from unreleased main can be schema-skewed against the released
/// guest binary.
fn bundled_api_server_binary(app: &AppHandle) -> Option<PathBuf> {
    let (arch, other_arch) = if cfg!(target_arch = "aarch64") {
        ("arm64", "x64")
    } else {
        ("x64", "arm64")
    };
    let name = format!("appliance-api-server-linux-{arch}");
    let other_name = format!("appliance-api-server-linux-{other_arch}");

    let mut staging_dirs: Vec<PathBuf> = Vec::new();
    if let Ok(resource_dir) = app
        .path()
        .resolve("apiserver-bin", tauri::path::BaseDirectory::Resource)
    {
        staging_dirs.push(resource_dir);
    }
    // Dev runs can outrace the resource copy tauri-build does at
    // compile time — fall back to the checkout's staging dir.
    #[cfg(debug_assertions)]
    staging_dirs.push(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("apiserver-bin"));

    for dir in &staging_dirs {
        let staged = dir.join(&name);
        if staged.is_file() {
            return Some(staged);
        }
    }
    // A wrong-arch staging (e.g. a Rosetta x64 Node staged `-x64` into
    // an arm64 app) is genuinely unusable: the guest VM runs the host's
    // arch, so a linux-x64 binary cannot boot in an arm64 VM. Never
    // export it — warn loudly instead so the developer knows staging
    // misfired rather than letting the release download silently
    // resurrect the schema skew this staging exists to prevent.
    for dir in &staging_dirs {
        let other = dir.join(&other_name);
        if other.is_file() {
            eprintln!(
                "[appliance] apiserver-bin arch mismatch: staging produced {} but this {arch} build \
                 needs {} — ignoring it (the CLI falls back to its release download). \
                 Re-run stage-apiserver.mjs with a {arch}-native toolchain.",
                other.display(),
                dir.join(&name).display()
            );
            return None;
        }
    }
    None
}

/// The entitlement Virtualization.framework gates VM creation on —
/// compiled in from packages/vm/vz.entitlements (one source of truth).
#[cfg(target_os = "macos")]
const VZ_ENTITLEMENTS: &str = include_str!("../../../vm/vz.entitlements");

/// Re-sign an installed appliance-vm with the virtualization
/// entitlement (ad-hoc). Copying the binary out of the app bundle
/// leaves it outside the bundle's signature, and an unentitled binary
/// can't create VMs.
#[cfg(target_os = "macos")]
async fn sign_with_vz_entitlement(binary: &std::path::Path) -> Result<(), String> {
    let entitlements_path = std::env::temp_dir().join("appliance-vz.entitlements");
    fs::write(&entitlements_path, VZ_ENTITLEMENTS)
        .map_err(|e| format!("write {}: {e}", entitlements_path.display()))?;
    let entitlements = entitlements_path.to_string_lossy().to_string();
    let binary = binary.to_string_lossy().to_string();
    let (ok, _stdout, stderr) = run_status_command(&[
        "codesign",
        "--force",
        "--sign",
        "-",
        "--entitlements",
        &entitlements,
        &binary,
    ])
    .await?;
    if !ok {
        return Err(format!("codesign {binary} failed: {}", stderr.trim()));
    }
    Ok(())
}

/// Install the appliance-vm engine into ~/.appliance/bin, where both
/// the desktop and the CLI resolve it. Returns the installed path.
#[tauri::command]
async fn microvm_install(app: AppHandle) -> Result<String, String> {
    let source = vm_install_source(&app)
        .ok_or("no installable appliance-vm binary ships with this build")?;
    let home = home_dir().ok_or("cannot resolve the home directory")?;
    let bin_dir = home.join(SHARED_PROFILES_DIR).join("bin");
    fs::create_dir_all(&bin_dir).map_err(|e| format!("create {}: {e}", bin_dir.display()))?;
    let dest = bin_dir.join(VM_BIN_NAME);
    // Unlink first: overwriting in place would truncate the inode a
    // still-running VM host process executes from.
    let _ = fs::remove_file(&dest);
    fs::copy(&source, &dest).map_err(|e| format!("copy to {}: {e}", dest.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dest, fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("chmod {}: {e}", dest.display()))?;
    }
    #[cfg(target_os = "macos")]
    sign_with_vz_entitlement(&dest).await?;
    Ok(dest.to_string_lossy().to_string())
}

/// Ensure the managed engine binary in ~/.appliance/bin matches the one
/// this build bundles, (re)installing when it's **missing or stale**.
/// The engine reports a fixed `--version`, so a version string can't
/// tell builds apart; we compare bytes against the bundled source
/// instead — `microvm_install` copies that source and re-signs it with
/// the same ad-hoc entitlement it already carries, so an up-to-date
/// install is byte-identical. A no-op when the build ships no
/// installable source (we then use whatever is already on PATH/managed).
///
/// This is what keeps `appliance vm dev up` (spawned via the bundled CLI,
/// which resolves the managed binary) from running a stale engine that
/// predates flags like `--dev`.
async fn ensure_vm_installed(
    app: &AppHandle,
    on_event: &Channel<serde_json::Value>,
) -> Result<(), String> {
    let Some(source) = vm_install_source(app) else {
        return Ok(());
    };
    let dest = home_dir().map(|h| h.join(SHARED_PROFILES_DIR).join("bin").join(VM_BIN_NAME));
    let up_to_date = dest.as_ref().is_some_and(|dest| {
        dest.is_file()
            // Cheap length gate before reading both binaries in full.
            && fs::metadata(&source).map(|m| m.len()).ok() == fs::metadata(dest).map(|m| m.len()).ok()
            && fs::read(&source).ok() == fs::read(dest).ok()
    });
    if up_to_date {
        return Ok(());
    }
    let _ = on_event.send(serde_json::json!({
        "type": "log",
        "level": "info",
        "message": "installing the microVM engine (appliance-vm) into ~/.appliance/bin",
    }));
    microvm_install(app.clone()).await?;
    Ok(())
}

/// Adopt the CLI-managed microVM profile (~/.appliance/profiles.json,
/// written by `appliance vm up`) as a desktop cluster, so the deploy
/// wizard and cluster switcher target the engine like any other
/// cluster. The CLI stays the source of truth for these credentials:
/// the keychain copy is refreshed from the shared entry (catching CLI
/// re-keys), and mirror_to_shared_profiles never writes over
/// CLI-managed entries. Idempotent — no-ops once everything matches.
fn sync_microvm_cluster(app: &AppHandle, name: &str) -> Result<(), HostError> {
    let _guard = config_lock();
    let cluster_id = microvm_cluster_id(name);
    let cluster_label = microvm_cluster_label(name);
    let Some(shared) = read_shared_profiles() else {
        return Ok(());
    };
    let Some(entry) = shared.profiles.get(&cluster_id) else {
        return Ok(());
    };
    if entry.api_url.is_empty() || entry.key_id.is_empty() || entry.secret.is_empty() {
        return Ok(());
    }

    let mut persisted = read_persisted_config(app)?;
    migrate_legacy(app, &mut persisted)?;

    // Freshness is judged by comparing the shared entry against the
    // cluster record (synced_key_id), never by reading the keychain:
    // this runs on every status poll, and a keychain read can block on
    // a macOS access prompt. The keychain is written only when the
    // CLI actually re-keyed.
    let api_key = ApiKey {
        id: entry.key_id.clone(),
        secret: entry.secret.clone(),
    };
    let changed = match persisted.clusters.iter_mut().find(|c| c.id == cluster_id) {
        Some(cluster) => {
            let mut changed = false;
            if cluster.api_server_url != entry.api_url {
                cluster.api_server_url = entry.api_url.clone();
                changed = true;
            }
            // A bare ingest from profiles.json labels the cluster with
            // its slug; upgrade it to the human name. Entries persisted
            // before the "Dev Machine" rename migrate the same way.
            if cluster.name == cluster_id || cluster.name.starts_with(LEGACY_MICROVM_CLUSTER_NAME) {
                cluster.name = cluster_label.clone();
                changed = true;
            }
            if cluster.synced_key_id.as_deref() != Some(entry.key_id.as_str()) {
                write_api_key(&cluster_keychain_account(&cluster_id), &api_key)?;
                cluster.synced_key_id = Some(entry.key_id.clone());
                changed = true;
            }
            changed
        }
        None => {
            write_api_key(&cluster_keychain_account(&cluster_id), &api_key)?;
            persisted.clusters.push(Cluster {
                id: cluster_id.clone(),
                name: cluster_label,
                api_server_url: entry.api_url.clone(),
                created_at: entry
                    .created_at
                    .clone()
                    .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
                state_backend_url: None,
                last_bootstrap_input: None,
                install_generation: entry.install_generation.clone(),
                cloud_formation_stack_name: entry.cloud_formation_stack_name.clone(),
                aws_account_id: entry.aws_account_id.clone(),
                aws_region: entry.aws_region.clone(),
                synced_key_id: Some(entry.key_id.clone()),
            });
            // First-cluster convenience: select it when nothing else
            // is, never override a user's choice.
            if persisted.selected_cluster_id.is_none() {
                persisted.selected_cluster_id = Some(cluster_id.clone());
            }
            true
        }
    };
    if changed {
        write_persisted_config(app, &persisted)?;
    }
    Ok(())
}

/// Drop the microVM cluster registration (config + keychain + shared
/// profile) — its credentials live in the VM's data disk, so deleting
/// the VM invalidates them. Best-effort.
fn unregister_microvm_cluster(app: &AppHandle, name: &str) -> Result<(), HostError> {
    let _guard = config_lock();
    let cluster_id = microvm_cluster_id(name);
    let mut persisted = read_persisted_config(app)?;
    migrate_legacy(app, &mut persisted)?;
    let before = persisted.clusters.len();
    persisted.clusters.retain(|c| c.id != cluster_id);
    delete_api_key(&cluster_keychain_account(&cluster_id));
    if let Some(mut shared) = read_shared_profiles() {
        if shared.profiles.remove(&cluster_id).is_some() {
            if shared.active_profile.as_deref() == Some(cluster_id.as_str()) {
                shared.active_profile = None;
            }
            let _ = write_shared_profiles(&shared);
        }
    }
    if persisted.clusters.len() == before {
        return Ok(());
    }
    if persisted.selected_cluster_id.as_deref() == Some(cluster_id.as_str()) {
        persisted.selected_cluster_id = persisted.clusters.first().map(|c| c.id.clone());
    }
    write_persisted_config(app, &persisted)
}

fn which_path(cmd: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(cmd);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MicroVmStatus {
    /// appliance-vm binary present on this machine.
    available: bool,
    /// Not installed, but this build carries a binary it can install
    /// (surface an Install action instead of a dead-end message).
    installable: bool,
    exists: bool,
    running: bool,
    /// The VM spec includes the lazily provisioned deployment layer
    /// (k3s, registry, BuildKit, and api-server). This is independent of
    /// readiness: a stopped cluster VM remains provisioned.
    cluster_provisioned: bool,
    /// kubeconfig fetched and the host process alive — the cluster
    /// answers. Gated on `running` so a stopped VM (whose kubeconfig
    /// file lingers on disk) doesn't read as ready.
    kubeconfig_ready: bool,
    /// Current bring-up stage while starting: media | booting | network |
    /// cluster (+ cluster-node/cluster-images/cluster-api/ingress
    /// sub-phases) | ready | failed. `None` when not running. Lets the UI
    /// show "starting (k3s)" / "failed" instead of a blunt "running".
    #[serde(skip_serializing_if = "Option::is_none")]
    phase: Option<String>,
    /// Free-text context for `phase` (what the engine is waiting on) —
    /// rendered as the live detail under the in-flight bring-up rung.
    #[serde(skip_serializing_if = "Option::is_none")]
    phase_detail: Option<String>,
    /// Whether this VM is provisioned as a development environment
    /// (`appliance vm dev up`). Drives the dev-shell affordance.
    dev: bool,
    /// Host folder shared into `/persist/workspace` (`devMount` in the
    /// VM's `vm.json`), when one is mounted. The agent launcher gates on
    /// this: launching writes to + scopes the run to this folder, and
    /// without it the CLI would restart the VM to remount.
    #[serde(skip_serializing_if = "Option::is_none")]
    dev_mount: Option<String>,
    api_server_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

const MICROVM_NAME: &str = "appliance";
const MICROVM_HOST_PORT: u16 = 8081;

/// Resolve a VM name from an optional command argument. Defaults to the
/// canonical "appliance" VM so existing single-VM callers keep working.
fn vm_name(name: Option<String>) -> String {
    name.map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| MICROVM_NAME.to_string())
}

/// The desktop cluster id (and CLI profile name) a VM owns. Mirrors
/// profileForVm in packages/cli/src/appliance-vm.ts: the default VM
/// keeps the plain "microvm" id; each other VM gets "microvm-<name>".
fn microvm_cluster_id(name: &str) -> String {
    if name == MICROVM_NAME {
        MICROVM_CLUSTER_ID.to_string()
    } else {
        format!("{MICROVM_CLUSTER_ID}-{name}")
    }
}

/// Human-facing cluster label for a VM.
fn microvm_cluster_label(name: &str) -> String {
    if name == MICROVM_NAME {
        MICROVM_CLUSTER_NAME.to_string()
    } else {
        format!("{MICROVM_CLUSTER_NAME} ({name})")
    }
}

/// New engines report the persisted `VmSpec.cluster` bit directly. For
/// older engines, require both artifacts written by cluster bring-up: the
/// CLI profile and the fetched kubeconfig. A stale profile alone must not
/// turn a core-only VM into a deploy target.
fn microvm_cluster_provisioned(status: &serde_json::Value, name: &str) -> bool {
    if let Some(cluster) = status.get("cluster").and_then(|v| v.as_bool()) {
        return cluster;
    }
    let has_profile = read_shared_profiles()
        .is_some_and(|profiles| profiles.profiles.contains_key(&microvm_cluster_id(name)));
    let has_kubeconfig = home_dir()
        .map(|home| {
            home.join(SHARED_PROFILES_DIR)
                .join("vm")
                .join(name)
                .join("kubeconfig.yaml")
                .is_file()
        })
        .unwrap_or(false);
    has_profile && has_kubeconfig
}

/// One VM as reported by `appliance-vm list` — its allocated ports and
/// running state, plus the desktop cluster id it registers under.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MicroVmSummary {
    name: String,
    running: bool,
    /// Whether this VM's persisted spec includes the deployment layer.
    cluster_provisioned: bool,
    /// Cluster answers (kubeconfig fetched) while running — lets the
    /// switcher show "starting" vs "ready" per VM. `false` for older
    /// engine binaries that don't report it.
    cluster_ready: bool,
    /// Current bring-up stage while starting. `None` when not running or
    /// when the engine predates phase reporting.
    #[serde(skip_serializing_if = "Option::is_none")]
    phase: Option<String>,
    host_port: u16,
    api_port: u16,
    registry_port: u16,
    egress_port: u16,
    cluster_id: String,
}

#[tauri::command]
async fn microvm_list() -> Result<Vec<MicroVmSummary>, String> {
    let Some(bin) = vm_binary() else {
        return Ok(Vec::new());
    };
    let bin = bin.to_string_lossy().to_string();
    let (ok, stdout, stderr) = run_status_command(&[&bin, "list"]).await?;
    if !ok {
        return Err(format!("appliance-vm list failed: {}", stderr.trim()));
    }
    let parsed: Vec<serde_json::Value> = serde_json::from_str(stdout.trim()).unwrap_or_default();
    Ok(parsed
        .into_iter()
        .map(|v| {
            let name = v
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            let cluster_id = microvm_cluster_id(&name);
            MicroVmSummary {
                running: v.get("running").and_then(|r| r.as_bool()).unwrap_or(false),
                cluster_provisioned: microvm_cluster_provisioned(&v, &name),
                cluster_ready: v
                    .get("clusterReady")
                    .and_then(|r| r.as_bool())
                    .unwrap_or(false),
                phase: v
                    .get("phase")
                    .and_then(|p| p.as_str())
                    .map(|s| s.to_string()),
                host_port: v.get("hostPort").and_then(|p| p.as_u64()).unwrap_or(0) as u16,
                api_port: v.get("apiPort").and_then(|p| p.as_u64()).unwrap_or(0) as u16,
                registry_port: v.get("registryPort").and_then(|p| p.as_u64()).unwrap_or(0) as u16,
                egress_port: v.get("egressPort").and_then(|p| p.as_u64()).unwrap_or(0) as u16,
                cluster_id,
                name,
            }
        })
        .collect())
}

#[tauri::command]
async fn microvm_status(app: AppHandle, name: Option<String>) -> MicroVmStatus {
    let name = vm_name(name);
    // Fallback URL before we know the VM's allocated port (binary
    // missing, or status failed). The default VM keeps 8081; a named VM
    // we can't probe yet gets its host:port filled in from status below.
    let api_server_url = format!(
        "http://{}:{}",
        IN_CLUSTER_API_SERVER_HOSTNAME, MICROVM_HOST_PORT
    );
    let Some(bin) = vm_binary() else {
        let installable = vm_install_source(&app).is_some();
        return MicroVmStatus {
            available: false,
            installable,
            exists: false,
            running: false,
            cluster_provisioned: false,
            kubeconfig_ready: false,
            phase: None,
            phase_detail: None,
            dev: false,
            dev_mount: None,
            api_server_url,
            message: Some(if installable {
                "The microVM engine isn't installed yet.".into()
            } else {
                "appliance-vm is not installed (expected in ~/.appliance/bin or on PATH) \
                 and this build has no bundled copy. In a repo checkout: \
                 `cargo build --release && ./scripts/sign-dev.sh --release` in packages/vm."
                    .into()
            }),
        };
    };
    let bin = bin.to_string_lossy().to_string();
    let (ok, stdout, stderr) = match run_status_command(&[&bin, "status", &name]).await {
        Ok(t) => t,
        Err(e) => {
            return MicroVmStatus {
                available: false,
                installable: false,
                exists: false,
                running: false,
                cluster_provisioned: false,
                kubeconfig_ready: false,
                phase: None,
                phase_detail: None,
                dev: false,
                dev_mount: None,
                api_server_url,
                message: Some(e),
            }
        }
    };
    if !ok {
        return MicroVmStatus {
            available: true,
            installable: false,
            exists: false,
            running: false,
            cluster_provisioned: false,
            kubeconfig_ready: false,
            phase: None,
            phase_detail: None,
            dev: false,
            dev_mount: None,
            api_server_url,
            message: Some(stderr.trim().to_string()),
        };
    }
    let parsed: serde_json::Value = serde_json::from_str(&stdout).unwrap_or_default();
    // Prefer the VM's actual forwarded ingress port (status now reports
    // it) so a named VM resolves to its own api-server URL.
    let api_server_url = match parsed.get("hostPort").and_then(|v| v.as_u64()) {
        Some(port) => format!("http://{}:{}", IN_CLUSTER_API_SERVER_HOSTNAME, port),
        None => api_server_url,
    };
    let running = parsed
        .get("running")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let cluster_provisioned = microvm_cluster_provisioned(&parsed, &name);
    // The engine now reports `clusterReady` (kubeconfig fetched *and* the
    // host process alive) directly — prefer it. Fall back to the on-disk
    // kubeconfig check for older engine binaries that predate the field,
    // gating on `running` so a stopped VM's lingering kubeconfig doesn't
    // read as ready.
    let kubeconfig_ready = match parsed.get("clusterReady").and_then(|v| v.as_bool()) {
        Some(ready) => ready,
        None => {
            running
                && home_dir()
                    .map(|h| {
                        h.join(SHARED_PROFILES_DIR)
                            .join("vm")
                            .join(&name)
                            .join("kubeconfig.yaml")
                            .exists()
                    })
                    .unwrap_or(false)
        }
    };
    let phase = parsed
        .get("phase")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let phase_detail = parsed
        .get("phaseDetail")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    if running && kubeconfig_ready {
        // Keep the desktop's cluster registration in step with the
        // CLI-owned profile while the engine is up — this also catches
        // an `appliance vm up` run outside the desktop, and re-keys.
        if let Err(e) = sync_microvm_cluster(&app, &name) {
            eprintln!("warn: microvm cluster sync failed: {e}");
        }
    }
    MicroVmStatus {
        available: true,
        installable: false,
        exists: parsed
            .get("exists")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        running,
        cluster_provisioned,
        kubeconfig_ready,
        phase,
        phase_detail,
        dev: parsed.get("dev").and_then(|v| v.as_bool()).unwrap_or(false),
        dev_mount: vm_dev_mount(&name),
        api_server_url,
        message: parsed
            .get("message")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    }
}

// ============================================================
// MicroVM credential self-heal
//
// A microVM's api-server keeps its key store on the VM's data disk, so
// recreating the VM silently invalidates every credential a client
// holds — the desktop would 401 forever with no recovery path (the
// CLI's `vm up` re-mints, but only when it runs). This command is the
// desktop's counterpart: when the frontend sees an auth-shaped error
// from a microVM cluster, it asks the host to verify-and-re-mint using
// the VM's on-disk bootstrap token (~/.appliance/vm/<name>/bootstrap-token
// — its presence proves this host owns the VM). The fresh key is
// written to profiles.json (the CLI-shared store) and propagated to
// the keychain + cluster registry via the existing sync path.
// ============================================================

/// Minimum spacing between mint attempts per VM. One heal per window;
/// if the freshly minted key still fails, the banner fallback shows
/// instead of minting in a loop.
const HEAL_COOLDOWN: Duration = Duration::from_secs(60);
/// If the key WE minted is the one being rejected, the failure isn't
/// credential-shaped (clock skew, digest mismatch, server bug) —
/// refuse to mint again for this long so heal can't mask a real bug
/// behind an ever-growing key store.
const HEAL_REMINT_GUARD: Duration = Duration::from_secs(600);

/// CLI-canonical profile the default VM owns. Mirrors LOCAL_PROFILE /
/// profileForVm in packages/cli/src/utils/microvm-up.ts.
const LOCAL_CLI_PROFILE: &str = "local";

#[derive(Default, Clone)]
struct HealRecord {
    /// A mint is currently running for this VM.
    in_flight: bool,
    /// When the last mint attempt finished (success or failure).
    last_attempt: Option<std::time::Instant>,
    /// Key id of the last successful mint.
    last_minted_key: Option<String>,
    /// When a clock sync was last attempted for a `clock_skew` cause.
    /// A second clock_skew inside HEAL_REMINT_GUARD means the sync
    /// didn't fix it — banner instead of syncing in a loop (the guest
    /// engine's `sync-clock` verifies by read-back, but a persistent
    /// skew source would otherwise flap heal→retry→401 forever).
    last_clock_sync: Option<std::time::Instant>,
}

fn heal_state() -> &'static std::sync::Mutex<BTreeMap<String, HealRecord>> {
    static STATE: std::sync::OnceLock<std::sync::Mutex<BTreeMap<String, HealRecord>>> =
        std::sync::OnceLock::new();
    STATE.get_or_init(|| std::sync::Mutex::new(BTreeMap::new()))
}

#[derive(Debug, PartialEq)]
enum HealDecision {
    /// Mint a fresh key via the bootstrap token.
    Proceed,
    /// The shared profile already carries a different key than the one
    /// that failed (the CLI re-keyed) — sync it instead of minting.
    AlreadyRekeyed,
    /// The server said `clock_skew`: push the host clock into the guest
    /// (`appliance-vm sync-clock`) instead of minting — a fresh key
    /// would be rejected exactly the same way.
    SyncClock,
    /// Do nothing; the caller falls back to the auth-expired banner.
    Skip(&'static str),
}

/// Decide whether a heal request should mint. Pure: all clock/store
/// reads are resolved by the caller and passed in. `cause` is the
/// server's machine-readable 401 classification (AuthFailureCause) when
/// it sent one; cause-less (older) servers keep the local heuristics.
fn decide_heal(
    record: &HealRecord,
    now: std::time::Instant,
    failed_key_id: Option<&str>,
    stored_key_id: Option<&str>,
    cause: Option<&str>,
) -> HealDecision {
    if record.in_flight {
        return HealDecision::Skip("heal already in flight");
    }
    match cause {
        Some("clock_skew") => {
            // One sync per guard window: if a clock push already ran and
            // clock_skew is back, syncing again can't help (the skew is
            // persistent or the sync path is broken) — banner instead of
            // an infinite heal→invalidate→401 flap.
            if record
                .last_clock_sync
                .is_some_and(|at| now.duration_since(at) < HEAL_REMINT_GUARD)
            {
                return HealDecision::Skip("clock already synced recently — skew persists");
            }
            return HealDecision::SyncClock;
        }
        // Not credential-shaped: the request itself is what the server
        // rejects (body digest, signature structure). Minting can't fix
        // it and would only grow the key store — banner instead.
        Some("digest_mismatch") | Some("malformed_signature") => {
            return HealDecision::Skip("server says the failure is not credential-shaped");
        }
        // unknown_key / signature_mismatch are credential-shaped —
        // today's mint path below. Unrecognized future causes fall
        // through to the cause-less heuristics too.
        _ => {}
    }
    // Someone (CLI `vm up`, another window) already replaced the key
    // the caller failed with — adopt it rather than minting yet
    // another. Checked before the cooldown so a stale caller converges
    // on the fresh key immediately.
    if let (Some(failed), Some(stored)) = (failed_key_id, stored_key_id) {
        if failed != stored {
            return HealDecision::AlreadyRekeyed;
        }
    }
    // The blunt remint guard exists to infer exactly what a cause now
    // states outright ("would a fresh key help?") — a cause-carrying
    // credential-shaped 401 supersedes it; cause-less servers keep it.
    let credential_shaped = matches!(cause, Some("unknown_key") | Some("signature_mismatch"));
    if !credential_shaped {
        if let (Some(failed), Some(minted)) = (failed_key_id, record.last_minted_key.as_deref()) {
            if failed == minted
                && record
                    .last_attempt
                    .is_some_and(|at| now.duration_since(at) < HEAL_REMINT_GUARD)
            {
                return HealDecision::Skip(
                    "freshly minted key still rejected — not credential-shaped",
                );
            }
        }
    }
    if record
        .last_attempt
        .is_some_and(|at| now.duration_since(at) < HEAL_COOLDOWN)
    {
        return HealDecision::Skip("cooldown");
    }
    HealDecision::Proceed
}

/// Resolve the VM's api-server URL: the engine's reported ingress port
/// is authoritative (ports can be reallocated across recreates), the
/// registered cluster record is the fallback, the default-VM port the
/// last resort.
async fn microvm_api_url(app: &AppHandle, name: &str, cluster_id: &str) -> String {
    if let Some(bin) = vm_binary() {
        let bin = bin.to_string_lossy().to_string();
        if let Ok((true, stdout, _stderr)) = run_status_command(&[&bin, "status", name]).await {
            let parsed: serde_json::Value = serde_json::from_str(&stdout).unwrap_or_default();
            if let Some(port) = parsed.get("hostPort").and_then(|v| v.as_u64()) {
                return format!("http://{}:{}", IN_CLUSTER_API_SERVER_HOSTNAME, port);
            }
        }
    }
    read_persisted_config(app)
        .ok()
        .and_then(|cfg| {
            cfg.clusters
                .into_iter()
                .find(|c| c.id == cluster_id)
                .map(|c| c.api_server_url)
        })
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| {
            format!(
                "http://{}:{}",
                IN_CLUSTER_API_SERVER_HOSTNAME, MICROVM_HOST_PORT
            )
        })
}

/// Write a freshly minted VM credential into profiles.json. The
/// default VM dual-writes the CLI-canonical `local` profile and the
/// legacy `microvm` id the desktop's cluster registry reads — mirrors
/// persistVmCredentials in packages/cli/src/utils/microvm-up.ts.
/// Non-secret metadata on an existing entry is carried forward.
fn persist_vm_profile_entry(
    name: &str,
    cluster_id: &str,
    api_url: &str,
    key: &ApiKey,
) -> Result<(), HostError> {
    let _guard = config_lock();
    let mut file = read_shared_profiles().unwrap_or_default();
    let ids: Vec<&str> = if name == MICROVM_NAME {
        vec![LOCAL_CLI_PROFILE, MICROVM_CLUSTER_ID]
    } else {
        vec![cluster_id]
    };
    for id in ids {
        let prev = file.profiles.get(id).cloned().unwrap_or_default();
        file.profiles.insert(
            id.to_string(),
            SharedProfileEntry {
                api_url: api_url.to_string(),
                key_id: key.id.clone(),
                secret: key.secret.clone(),
                created_at: Some(chrono::Utc::now().to_rfc3339()),
                state_backend_url: prev.state_backend_url,
                last_bootstrap_input: prev.last_bootstrap_input,
                install_generation: prev.install_generation,
                cloud_formation_stack_name: prev.cloud_formation_stack_name,
                aws_account_id: prev.aws_account_id,
                aws_region: prev.aws_region,
                managed: prev.managed.or_else(|| Some("desktop".to_string())),
                name: prev.name,
            },
        );
    }
    write_shared_profiles(&file)
}

/// Mint + persist + propagate. Returns the new key id.
async fn heal_mint(
    app: &AppHandle,
    name: &str,
    cluster_id: &str,
    token: &str,
) -> Result<String, String> {
    let api_url = microvm_api_url(app, name, cluster_id).await;
    let key = mint_api_key_url(&api_url, token, &microvm_cluster_label(name)).await?;
    persist_vm_profile_entry(name, cluster_id, &api_url, &key)
        .map_err(|e| format!("persist healed credentials: {e}"))?;
    sync_microvm_cluster(app, name).map_err(|e| format!("sync healed cluster: {e}"))?;
    Ok(key.id)
}

/// Recover from a rejected microVM credential: re-mint via the VM's
/// on-disk bootstrap token and persist everywhere the old key lived.
/// Returns `true` when fresh credentials are in place (retry now),
/// `false` when there is nothing to heal with or an attempt was made
/// too recently (show the normal auth-expired UI).
#[tauri::command]
async fn microvm_heal_credentials(
    app: AppHandle,
    name: Option<String>,
    failed_key_id: Option<String>,
    cause: Option<String>,
) -> Result<bool, String> {
    let name = vm_name(name);
    let cluster_id = microvm_cluster_id(&name);

    // The bootstrap token is the heal credential; no token, no heal.
    let token = home_dir()
        .map(|h| {
            h.join(SHARED_PROFILES_DIR)
                .join("vm")
                .join(&name)
                .join("bootstrap-token")
        })
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    let Some(token) = token else {
        return Ok(false);
    };

    let stored_key_id = read_shared_profiles()
        .and_then(|f| f.profiles.get(&cluster_id).map(|e| e.key_id.clone()))
        .filter(|k| !k.is_empty());

    let decision = {
        let mut st = heal_state().lock().unwrap();
        let record = st.entry(name.clone()).or_default();
        let decision = decide_heal(
            record,
            std::time::Instant::now(),
            failed_key_id.as_deref(),
            stored_key_id.as_deref(),
            cause.as_deref(),
        );
        if decision == HealDecision::Proceed {
            record.in_flight = true;
        }
        if decision == HealDecision::SyncClock {
            // Recorded at attempt time (success or failure): decide_heal
            // banners a recurring clock_skew inside the guard window
            // either way, so a broken sync can't flap the banner.
            record.last_clock_sync = Some(std::time::Instant::now());
        }
        decision
    };
    match decision {
        HealDecision::Skip(reason) => {
            eprintln!("microvm heal skipped for '{name}': {reason}");
            return Ok(false);
        }
        HealDecision::AlreadyRekeyed => {
            sync_microvm_cluster(&app, &name).map_err(|e| e.to_string())?;
            return Ok(true);
        }
        HealDecision::SyncClock => {
            // One-shot host→guest clock push via the engine binary
            // (which verifies by read-back and exits non-zero when the
            // set didn't take); the resident 30s sync thread keeps it
            // corrected after. Not recorded as a mint attempt — a later
            // credential-shaped heal isn't cooldown-blocked by a clock
            // fix — but it IS recorded as `last_clock_sync` above, so a
            // clock_skew recurring inside the guard window banners
            // instead of looping.
            let Some(bin) = vm_binary() else {
                eprintln!("microvm heal: clock_skew reported but no engine binary to sync with");
                return Ok(false);
            };
            let bin = bin.to_string_lossy().to_string();
            return match run_status_command(&[&bin, "sync-clock", &name]).await {
                Ok((true, _, _)) => {
                    eprintln!(
                        "microvm heal: pushed host clock into VM '{name}' (cause=clock_skew)"
                    );
                    Ok(true)
                }
                Ok((false, _, stderr)) => {
                    eprintln!(
                        "microvm heal: clock sync failed for '{name}': {}",
                        stderr.trim()
                    );
                    Ok(false)
                }
                Err(e) => {
                    eprintln!("microvm heal: clock sync failed for '{name}': {e}");
                    Ok(false)
                }
            };
        }
        HealDecision::Proceed => {}
    }

    let result = heal_mint(&app, &name, &cluster_id, &token).await;

    {
        let mut st = heal_state().lock().unwrap();
        let record = st.entry(name.clone()).or_default();
        record.in_flight = false;
        record.last_attempt = Some(std::time::Instant::now());
        if let Ok(key_id) = &result {
            record.last_minted_key = Some(key_id.clone());
        }
    }
    match result {
        Ok(key_id) => {
            eprintln!("microvm heal minted fresh credentials for '{name}' ({key_id})");
            Ok(true)
        }
        Err(e) => Err(e),
    }
}

/// Run `appliance vm up` through the bundled CLI, streaming output
/// lines to the frontend. This intentionally stops at the fast core
/// sandbox; the deployment layer and profile are provisioned lazily.
#[tauri::command]
async fn microvm_up(
    app: AppHandle,
    name: Option<String>,
    on_event: Channel<serde_json::Value>,
) -> Result<(), String> {
    let name = vm_name(name);
    run_microvm_up(app, name, false, false, None, on_event).await
}

/// Boot a microVM as a development environment (`appliance vm dev up`):
/// the same core-first bring-up as `microvm_up`, plus the dev toolchain
/// and persistent `/persist/workspace` you shell into.
#[tauri::command]
async fn microvm_dev_up(
    app: AppHandle,
    name: Option<String>,
    mount: Option<String>,
    on_event: Channel<serde_json::Value>,
) -> Result<(), String> {
    let name = vm_name(name);
    run_microvm_up(app, name, true, false, mount, on_event).await
}

/// Lazily add the deployment layer to an existing core sandbox. The CLI's
/// one-way promotion preserves the persisted dev flag while stopping and
/// fully bringing the VM back up with k3s, BuildKit, registry, and API server.
#[tauri::command]
async fn microvm_cluster_up(
    app: AppHandle,
    name: Option<String>,
    on_event: Channel<serde_json::Value>,
) -> Result<(), String> {
    let name = vm_name(name);
    run_microvm_up(app, name, false, true, None, on_event).await
}

/// Shared bring-up for core, dev, and lazy cluster promotion. `dev` selects
/// the `vm dev up` subcommand (provisioned dev environment) over the
/// plain `vm up`; `cluster` adds `--cluster` to that plain command;
/// `mount` (dev only) shares a host folder into the workspace. Everything
/// else — engine self-heal, log streaming, and best-effort/no-op profile
/// adoption for core boots — is identical.
async fn run_microvm_up(
    app: AppHandle,
    name: String,
    dev: bool,
    cluster: bool,
    mount: Option<String>,
    on_event: Channel<serde_json::Value>,
) -> Result<(), String> {
    // Self-heal: refresh the managed engine binary the bundled CLI below
    // resolves (~/.appliance/bin) when it's missing OR stale, so a freshly
    // bundled engine always wins over a leftover older install.
    ensure_vm_installed(&app, &on_event).await?;
    // `vm dev up` and `vm up` share the same bring-up; the dev variant
    // additionally provisions the toolchain + workspace, and may share a
    // host folder into it.
    let mount = mount.filter(|m| !m.trim().is_empty());
    let mut argv: Vec<&str> = if dev {
        vec!["vm", "dev", "up", "--name", &name]
    } else {
        vec!["vm", "up", "--name", &name]
    };
    if cluster {
        argv.push("--cluster");
    }
    if let Some(m) = mount.as_deref() {
        argv.extend(["--mount", m]);
    }
    let mut sidecar = app
        .shell()
        .sidecar("appliance")
        .map_err(|e| format!("Bundled appliance CLI is unavailable: {e}"))?
        .args(argv);
    // Prefer the bundle's repo-built guest api-server over the CLI's
    // version-pinned release download (dev/debug builds only — release
    // bundles carry no staged binary).
    if let Some(bin) = bundled_api_server_binary(&app) {
        sidecar = sidecar.env(
            "APPLIANCE_API_SERVER_BINARY",
            bin.to_string_lossy().to_string(),
        );
    }
    let (mut rx, _child) = sidecar
        .spawn()
        .map_err(|e| format!("failed to spawn appliance CLI: {e}"))?;

    let mut exit_code: Option<i32> = None;
    let mut tail: Vec<String> = Vec::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim_end().to_string();
                if line.is_empty() {
                    continue;
                }
                tail.push(line.clone());
                if tail.len() > 12 {
                    tail.remove(0);
                }
                let _ = on_event.send(serde_json::json!({
                    "type": "log",
                    "level": "info",
                    "message": line,
                }));
            }
            CommandEvent::Error(msg) => return Err(msg),
            CommandEvent::Terminated(payload) => exit_code = payload.code,
            _ => {}
        }
    }
    match exit_code {
        Some(0) => {
            // Cluster promotion writes/verifies the microVM profile and
            // this adopts it immediately. Core boots intentionally write
            // no profile, so sync_microvm_cluster quietly returns Ok(()).
            sync_microvm_cluster(&app, &name)
                .map_err(|e| format!("register microVM cluster: {e}"))?;
            Ok(())
        }
        code => Err(format!(
            "appliance vm up exited with {:?}\n{}",
            code,
            tail.join("\n")
        )),
    }
}

#[tauri::command]
async fn microvm_stop(name: Option<String>) -> Result<(), String> {
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let (ok, _stdout, stderr) = run_status_command(&[&bin, "stop", &name]).await?;
    if !ok {
        return Err(format!("appliance-vm stop failed: {}", stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
async fn microvm_delete(app: AppHandle, name: Option<String>) -> Result<(), String> {
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    // Stop first (delete refuses while running), tolerating "not running".
    let _ = run_status_command(&[&bin, "stop", &name]).await;
    // Give the host process a moment to exit before delete checks the pidfile.
    for _ in 0..20 {
        let (ok, stdout, _) = run_status_command(&[&bin, "status", &name]).await?;
        if ok {
            let parsed: serde_json::Value = serde_json::from_str(&stdout).unwrap_or_default();
            if !parsed
                .get("running")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let (ok, _stdout, stderr) = run_status_command(&[&bin, "delete", &name]).await?;
    if !ok {
        return Err(format!("appliance-vm delete failed: {}", stderr.trim()));
    }
    // The credentials lived in the VM's data disk — drop the now-dead
    // cluster registration (best-effort; the VM itself is gone).
    if let Err(e) = unregister_microvm_cluster(&app, &name) {
        eprintln!("warn: microvm cluster unregister failed: {e}");
    }
    Ok(())
}

// --- egress (outbound-traffic control) ------------------------------
//
// The desktop drives the same `appliance-vm egress` surface the CLI
// uses, so the policy file stays single-sourced. Reads go through
// `egress policy` (JSON); mutations through the typed subcommands —
// the binary owns CA generation when MITM is switched on.

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct EgressPolicy {
    #[serde(default)]
    default: String,
    #[serde(default)]
    allow: Vec<String>,
    #[serde(default)]
    deny: Vec<String>,
    #[serde(default)]
    mitm: bool,
    /// CA cert path, populated for the UI when interception is on and
    /// the cert exists — the user injects this into clients to trust
    /// the interceptor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ca_path: Option<String>,
    /// True when this VM's host netstack is the ENFORCED egress boundary
    /// (`net_link=Netstack`): default-DENY plus the baked allowlist, and
    /// `microvm_egress_get` returns the *effective* merged policy. False
    /// for the cooperative NAT proxy (`net_link=Nat`, default-Allow).
    /// Host-populated from the VM's persisted spec (the engine's JSON does
    /// not carry it), like `ca_path` above — never round-tripped back.
    #[serde(default)]
    enforced: bool,
    /// `"netstack"` | `"nat"` — the VM's resolved network link, so the
    /// desktop can label the boundary without re-deriving it from the
    /// effective default.
    #[serde(default)]
    net_link: String,
}

/// Resolve a VM's effective network link by reading the engine's
/// persisted spec (`~/.appliance/vm/<name>/vm.json`, `netLink` field) and
/// applying the same `APPLIANCE_NETSTACK=1` force-on override the engine's
/// `VmSpec::net_link()` uses (packages/vm/src/spec.rs). Returns true when
/// the host netstack is the enforced egress boundary (`net_link=Netstack`),
/// false for the cooperative NAT proxy. A missing / unreadable spec ⇒ Nat
/// unless the override is set, mirroring the engine. Read-only: this never
/// writes the spec.
fn microvm_netstack_enforced(name: &str) -> bool {
    if std::env::var("APPLIANCE_NETSTACK")
        .map(|v| v == "1")
        .unwrap_or(false)
    {
        return true;
    }
    let Some(path) = home_dir().map(|h| {
        h.join(SHARED_PROFILES_DIR)
            .join("vm")
            .join(name)
            .join("vm.json")
    }) else {
        return false;
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|spec| {
            spec.get("netLink")
                .and_then(|v| v.as_str())
                .map(|s| s.to_ascii_lowercase())
        })
        .map(|link| link == "netstack")
        .unwrap_or(false)
}

fn microvm_ca_path(name: &str) -> Option<PathBuf> {
    let p = home_dir()?
        .join(SHARED_PROFILES_DIR)
        .join("vm")
        .join(name)
        .join("egress-ca.pem");
    p.is_file().then_some(p)
}

#[tauri::command]
async fn microvm_egress_get(name: Option<String>) -> Result<EgressPolicy, String> {
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let (ok, stdout, stderr) = run_status_command(&[&bin, "egress", "policy", &name]).await?;
    if !ok {
        return Err(format!("read egress policy failed: {}", stderr.trim()));
    }
    // The engine prints the EFFECTIVE policy for a Netstack VM (default-Deny
    // + the baked allowlist merged over the operator's rules) — see
    // `egress::effective_policy`. We display that as-is, and tag it with the
    // VM's resolved link so the UI can label the boundary as enforced vs
    // cooperative. Read-only: nothing here is ever written back.
    let mut policy: EgressPolicy = serde_json::from_str(&stdout).map_err(|e| e.to_string())?;
    policy.ca_path = microvm_ca_path(&name).map(|p| p.to_string_lossy().into_owned());
    policy.enforced = microvm_netstack_enforced(&name);
    policy.net_link = if policy.enforced {
        "netstack".into()
    } else {
        "nat".into()
    };
    Ok(policy)
}

#[tauri::command]
async fn microvm_egress_default(name: Option<String>, action: String) -> Result<(), String> {
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let (ok, _o, stderr) =
        run_status_command(&[&bin, "egress", "default", &action, "--name", &name]).await?;
    if !ok {
        return Err(format!("set default failed: {}", stderr.trim()));
    }
    Ok(())
}

/// Incrementally allow/deny a single host on the VM's PERSISTED policy.
///
/// CRITICAL (Quinn's F3 review): this drives the engine's typed
/// `egress allow|deny <host>` subcommand, which does `load_policy` → add
/// the one rule → `save_policy` against the persisted `egress-policy.json`.
/// It is the host-side counterpart of the "allow this blocked host"
/// affordance. It must NEVER be implemented as a `get-effective → modify →
/// set` round-trip: `microvm_egress_get` returns the *effective merged*
/// policy (default=Deny + the baked allowlist for a Netstack VM), so
/// writing that whole object back would persist `default=Deny` + the baked
/// hosts into the file and mis-enforce if the VM were later switched to
/// NAT. Adding exactly one rule keeps the persisted file minimal and
/// link-agnostic. (`microvm_egress_default`/`_mitm`/`_reset` are likewise
/// thin typed subcommands — none of the desktop edit paths round-trip the
/// effective JSON.)
#[tauri::command]
async fn microvm_egress_rule(
    name: Option<String>,
    action: String,
    host: String,
) -> Result<(), String> {
    // action: "allow" | "deny"
    if action != "allow" && action != "deny" {
        return Err(format!("rule action must be allow|deny, got '{action}'"));
    }
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let (ok, _o, stderr) =
        run_status_command(&[&bin, "egress", &action, &host, "--name", &name]).await?;
    if !ok {
        return Err(format!("add {action} rule failed: {}", stderr.trim()));
    }
    Ok(())
}

/// Incrementally remove ONE operator allow/deny rule for an exact host —
/// the per-rule counterpart of `microvm_egress_reset` (which nukes every
/// rule). Drives the engine's typed `egress remove <host>` (load → drop
/// the host from both lists → save). Like `microvm_egress_rule` it must
/// stay incremental: never a `get-effective → modify → set` round-trip,
/// which would bake `default=Deny` + the baked allowlist into the file.
#[tauri::command]
async fn microvm_egress_remove(name: Option<String>, host: String) -> Result<(), String> {
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let (ok, _o, stderr) =
        run_status_command(&[&bin, "egress", "remove", &host, "--name", &name]).await?;
    if !ok {
        return Err(format!("remove rule failed: {}", stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
async fn microvm_egress_mitm(name: Option<String>, enabled: bool) -> Result<(), String> {
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let state = if enabled { "on" } else { "off" };
    let (ok, _o, stderr) =
        run_status_command(&[&bin, "egress", "mitm", state, "--name", &name]).await?;
    if !ok {
        return Err(format!("set mitm failed: {}", stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
async fn microvm_egress_reset(name: Option<String>) -> Result<(), String> {
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let (ok, _o, stderr) = run_status_command(&[&bin, "egress", "reset", &name]).await?;
    if !ok {
        return Err(format!("reset egress failed: {}", stderr.trim()));
    }
    Ok(())
}

/// One recorded egress request — mirrors TrafficEvent in
/// packages/vm/src/traffic.rs.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EgressEvent {
    ts: u64,
    host: String,
    port: u16,
    method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    decision: String,
}

#[tauri::command]
async fn microvm_egress_log(
    name: Option<String>,
    tail: Option<u32>,
) -> Result<Vec<EgressEvent>, String> {
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let tail = tail.unwrap_or(200).to_string();
    let (ok, stdout, stderr) =
        run_status_command(&[&bin, "egress", "log", &name, "--tail", &tail]).await?;
    if !ok {
        return Err(format!("read egress log failed: {}", stderr.trim()));
    }
    serde_json::from_str(stdout.trim()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn microvm_egress_clear_log(name: Option<String>) -> Result<(), String> {
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let (ok, _o, stderr) = run_status_command(&[&bin, "egress", "log", &name, "--clear"]).await?;
    if !ok {
        return Err(format!("clear egress log failed: {}", stderr.trim()));
    }
    Ok(())
}

// --- credential capture/injection (apiKeyHelper) --------------------
//
// Per-host rules + a host-side secret store, driven through the same
// `appliance-vm creds` surface the CLI uses.

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CredentialRule {
    host: String,
    #[serde(default)]
    capture: bool,
    #[serde(default)]
    inject: bool,
    #[serde(default)]
    header: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    helper: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StoredSecret {
    host: String,
    header: String,
    masked: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct CredentialsState {
    #[serde(default)]
    rules: Vec<CredentialRule>,
    #[serde(default)]
    secrets: Vec<StoredSecret>,
}

#[tauri::command]
async fn microvm_creds_list(name: Option<String>) -> Result<CredentialsState, String> {
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let (ok, stdout, stderr) = run_status_command(&[&bin, "creds", "list", &name]).await?;
    if !ok {
        return Err(format!("read creds failed: {}", stderr.trim()));
    }
    serde_json::from_str(stdout.trim()).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredsAddInput {
    host: String,
    capture: bool,
    inject: bool,
    #[serde(default)]
    header: Option<String>,
    #[serde(default)]
    helper: Option<String>,
}

#[tauri::command]
async fn microvm_creds_add(name: Option<String>, input: CredsAddInput) -> Result<(), String> {
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let mut args: Vec<String> = vec![
        bin.clone(),
        "creds".into(),
        "add".into(),
        input.host.clone(),
        "--name".into(),
        name,
    ];
    if input.capture {
        args.push("--capture".into());
    }
    if input.inject {
        args.push("--inject".into());
    }
    if let Some(h) = input.header.filter(|h| !h.trim().is_empty()) {
        args.push("--header".into());
        args.push(h);
    }
    if let Some(c) = input.helper.filter(|c| !c.trim().is_empty()) {
        args.push("--helper".into());
        args.push(c);
    }
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let (ok, _o, stderr) = run_status_command(&argv).await?;
    if !ok {
        return Err(format!("add credential rule failed: {}", stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
async fn microvm_creds_remove(name: Option<String>, host: String) -> Result<(), String> {
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let (ok, _o, stderr) =
        run_status_command(&[&bin, "creds", "rm", &host, "--name", &name]).await?;
    if !ok {
        return Err(format!("remove credential rule failed: {}", stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
async fn microvm_creds_set(
    name: Option<String>,
    host: String,
    value: String,
    header: Option<String>,
) -> Result<(), String> {
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let mut args: Vec<String> = vec![
        bin.clone(),
        "creds".into(),
        "set".into(),
        host,
        value,
        "--name".into(),
        name,
    ];
    if let Some(h) = header.filter(|h| !h.trim().is_empty()) {
        args.push("--header".into());
        args.push(h);
    }
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let (ok, _o, stderr) = run_status_command(&argv).await?;
    if !ok {
        return Err(format!("store secret failed: {}", stderr.trim()));
    }
    Ok(())
}

#[tauri::command]
async fn microvm_creds_forget(name: Option<String>) -> Result<(), String> {
    let name = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let (ok, _o, stderr) = run_status_command(&[&bin, "creds", "forget", &name]).await?;
    if !ok {
        return Err(format!("forget secrets failed: {}", stderr.trim()));
    }
    Ok(())
}

// --- kubectl target selection (terminals/PTY) -----------------------
//
// Workloads + pod logs used to shell out to `kubectl` here; the console
// now reads them through the in-VM api-server (control-plane.md §4), so
// only the interactive PTY paths below still resolve a kube target.

/// kubectl target-selection args for the microVM engine: the
/// kubeconfig appliance-vm fetched out of the guest. The microVM is
/// the only local engine, so a missing/other engine is an error rather
/// than a fallback to a host context.
fn kube_target_args(engine: Option<&str>, cluster_name: &str) -> Result<Vec<String>, String> {
    if engine != Some("microvm") {
        return Err("a local engine is required — pass engine=\"microvm\"".into());
    }
    // `cluster_name` carries the VM name (the frontend passes it). The
    // default sentinel means "unset" — fall back to the canonical VM.
    let vm = if cluster_name.is_empty() || cluster_name == DEFAULT_LOCAL_CLUSTER_NAME {
        MICROVM_NAME
    } else {
        cluster_name
    };
    let home = home_dir().ok_or("cannot resolve the home directory")?;
    let kubeconfig = home
        .join(SHARED_PROFILES_DIR)
        .join("vm")
        .join(vm)
        .join("kubeconfig.yaml");
    if !kubeconfig.is_file() {
        return Err("the microVM kubeconfig is not available — is the engine up?".into());
    }
    Ok(vec![
        "--kubeconfig".to_string(),
        kubeconfig.to_string_lossy().into_owned(),
    ])
}

// --- interactive terminals (PTY) ------------------------------------
//
// xterm.js in the desktop drives a real PTY (see terminal.rs) so
// `kubectl exec -it` into a workload behaves like a native shell.
// microVM target selection (the VM's fetched kubeconfig) is resolved
// here, next to the other kube wiring; terminal.rs only moves bytes.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOpenInput {
    /// kubectl target — a pod name, or any exec-able ref like
    /// `deploy/my-app`.
    target: String,
    #[serde(default)]
    namespace: Option<String>,
    #[serde(default)]
    cluster_name: Option<String>,
    /// "microvm" routes through the microVM's kubeconfig.
    #[serde(default)]
    engine: Option<String>,
    /// Shell target. Absent → `kubectl exec` into the pod named by
    /// `target` (the default). "dev" → a shell in the microVM's dev
    /// workspace; "host" → a raw root shell on the microVM host. Both
    /// ride `kubectl debug node/` + chroot (microVM engine only).
    #[serde(default)]
    mode: Option<String>,
    /// Command to run; defaults to an interactive `/bin/sh`.
    #[serde(default)]
    command: Option<Vec<String>>,
    #[serde(default)]
    container: Option<String>,
    cols: u16,
    rows: u16,
    /// Reattachable guest tmux session id (E3.4). When present, the vsock
    /// host/dev argv gains `--session <id>` so the PTY attaches to (or
    /// creates) the named guest tmux session `appliance-<id>` — surviving a
    /// client disconnect / desktop restart. Ignored on the kubectl-exec and
    /// kubectl-debug fallback paths (no tmux behind them).
    #[serde(default)]
    session_id: Option<String>,
}

/// Interactive login for the dev workspace — mirrors DEV_SHELL_LOGIN in
/// the CLI: a stable HOME on the persistent disk, cd into the
/// workspace, and bash once the toolchain has installed it (sh until
/// then).
const DEV_SHELL_LOGIN: &str =
    "export HOME=/persist/workspace; cd /persist/workspace 2>/dev/null || true; \
     if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi";

/// Build the argv for a shell into the microVM host itself, riding
/// `kubectl debug node/<node>` + chroot (the same mechanism as
/// `appliance vm shell`). `dev` lands in the persistent workspace with
/// the provisioned toolchain; otherwise a raw root shell at /. Resolves
/// the VM's single node name first (async kubectl), so this lives
/// outside the sync `terminal_exec_argv`.
async fn microvm_host_shell_argv(
    input: &TerminalOpenInput,
    dev: bool,
) -> Result<Vec<String>, String> {
    // Prefer the fast vsock shell when the relay socket is up: it needs
    // no k3s and leaves no debugger pod behind. Falls through to
    // kubectl-debug for older VMs or before the guest agent is ready.
    let cluster = input.cluster_name.as_deref().unwrap_or("");
    let vm = if cluster.is_empty() || cluster == DEFAULT_LOCAL_CLUSTER_NAME {
        MICROVM_NAME
    } else {
        cluster
    };
    if let (Some(bin), Some(home)) = (vm_binary(), home_dir()) {
        let sock = home
            .join(SHARED_PROFILES_DIR)
            .join("vm")
            .join(vm)
            .join("shell.sock");
        // The relay socket is a unix-only artifact (vsock backend). On
        // Windows the WSL backend's `appliance-vm shell` drives wsl.exe
        // directly — no socket ever exists, so gate on the engine binary
        // alone there (it reports "is it running?" itself when the VM is
        // down, which beats falling through to a kubectl the host may
        // not have).
        if cfg!(windows) || sock.exists() {
            let mut argv = vec![
                bin.to_string_lossy().into_owned(),
                "shell".to_string(),
                vm.to_string(),
            ];
            // Reattachable: attach to (or create) the named guest tmux
            // session so this shell survives a disconnect / desktop restart.
            // Only the vsock path is reattachable — the kubectl-debug
            // fallback below has no tmux behind it.
            if let Some(id) = input.session_id.as_deref().filter(|s| !s.is_empty()) {
                argv.push("--session".to_string());
                argv.push(id.to_string());
            }
            return Ok(argv);
        }
    }

    let target = kube_target_args(
        input.engine.as_deref(),
        input.cluster_name.as_deref().unwrap_or(""),
    )?;
    // target is ["--kubeconfig", <path>]; reuse the path for the node lookup.
    let mut node_args: Vec<&str> = vec!["kubectl"];
    node_args.extend(target.iter().map(String::as_str));
    node_args.extend(["get", "nodes", "-o", "jsonpath={.items[0].metadata.name}"]);
    let (ok, stdout, stderr) = run_status_command(&node_args).await?;
    let node = stdout.trim();
    if !ok || node.is_empty() {
        return Err(format!(
            "could not resolve the VM node — is the engine up?{}",
            if stderr.trim().is_empty() {
                String::new()
            } else {
                format!(" ({})", stderr.trim())
            }
        ));
    }
    let entry = if dev {
        DEV_SHELL_LOGIN
    } else {
        "exec /bin/sh -l"
    };
    let mut argv = vec!["kubectl".to_string()];
    argv.extend(target);
    argv.extend(
        [
            "debug",
            &format!("node/{node}"),
            "-it",
            "--image=busybox:1.36",
            "--profile=sysadmin",
            "--",
            "chroot",
            "/host",
            "/bin/sh",
            "-c",
            entry,
        ]
        .into_iter()
        .map(String::from),
    );
    Ok(argv)
}

/// Build the `kubectl exec -it` argv for an interactive terminal.
fn terminal_exec_argv(app: &AppHandle, input: &TerminalOpenInput) -> Result<Vec<String>, String> {
    let runtime_input = LocalRuntimeInput {
        cluster_name: input.cluster_name.clone(),
        namespace: input.namespace.clone(),
        ..Default::default()
    };
    let cfg = resolve_runtime_config(app, &runtime_input)?;
    let mut argv = vec!["kubectl".to_string()];
    argv.extend(kube_target_args(
        input.engine.as_deref(),
        &cfg.cluster_name,
    )?);
    argv.push("-n".to_string());
    argv.push(cfg.namespace.clone());
    argv.push("exec".to_string());
    argv.push("-it".to_string());
    if let Some(c) = input.container.as_deref() {
        argv.push("-c".to_string());
        argv.push(c.to_string());
    }
    argv.push(input.target.clone());
    argv.push("--".to_string());
    match input.command.as_deref() {
        Some(cmd) if !cmd.is_empty() => argv.extend(cmd.iter().cloned()),
        _ => argv.push("/bin/sh".to_string()),
    }
    Ok(argv)
}

#[tauri::command]
async fn terminal_open(
    app: AppHandle,
    input: TerminalOpenInput,
    on_event: Channel<terminal::TermEvent>,
) -> Result<String, String> {
    // "dev"/"host" open a shell into the microVM host (kubectl debug +
    // chroot); anything else is a `kubectl exec` into the pod.
    let argv = match input.mode.as_deref() {
        Some("dev") => microvm_host_shell_argv(&input, true).await?,
        Some("host") => microvm_host_shell_argv(&input, false).await?,
        _ => terminal_exec_argv(&app, &input)?,
    };
    let id = uuid::Uuid::new_v4().to_string();
    terminal::open(id.clone(), argv, input.cols, input.rows, on_event)?;
    Ok(id)
}

#[tauri::command]
async fn terminal_write(id: String, data: String) -> Result<(), String> {
    terminal::write(&id, &data)
}

#[tauri::command]
async fn terminal_resize(id: String, cols: u16, rows: u16) -> Result<(), String> {
    terminal::resize(&id, cols, rows)
}

#[tauri::command]
async fn terminal_close(id: String) -> Result<(), String> {
    terminal::close(&id)
}

/// One reattachable guest tmux session, surfaced to the store so it can
/// rehydrate a dock tab on launch (E3.4). Parses the CLI's `sessions list`
/// JSON (snake_case `last_activity`, via the alias) and re-emits camelCase
/// for the frontend.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalSessionInfo {
    id: String,
    #[serde(
        default,
        alias = "last_activity",
        skip_serializing_if = "Option::is_none"
    )]
    last_activity: Option<i64>,
}

/// List a VM's live reattachable shell sessions (the non-root `appliance`
/// tmux socket, where the desktop's host/dev shells land). Shells out to
/// `appliance-vm sessions list <vm>` and parses its JSON. On launch the
/// store calls this to reconnect each still-running shell.
#[tauri::command]
async fn terminal_sessions(name: Option<String>) -> Result<Vec<TerminalSessionInfo>, String> {
    let vm = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let (ok, stdout, stderr) = run_status_command(&[&bin, "sessions", "list", &vm]).await?;
    if !ok {
        return Err(format!(
            "appliance-vm sessions list failed: {}",
            stderr.trim()
        ));
    }
    serde_json::from_str(&stdout).map_err(|e| format!("could not parse session list: {e}"))
}

/// Destroy a guest tmux session by id — the explicit tab-close path.
/// Closing the PTY only detaches; this runs `appliance-vm sessions kill`
/// to actually tear the in-guest session (and its processes) down. `name`
/// names the VM (the CLI takes it as `--name`).
#[tauri::command]
async fn terminal_kill_session(name: Option<String>, id: String) -> Result<(), String> {
    let vm = vm_name(name);
    let bin = vm_binary().ok_or("appliance-vm is not installed")?;
    let bin = bin.to_string_lossy().to_string();
    let (ok, _stdout, stderr) =
        run_status_command(&[&bin, "sessions", "kill", &id, "--name", &vm]).await?;
    if !ok {
        return Err(format!(
            "appliance-vm sessions kill failed: {}",
            stderr.trim()
        ));
    }
    Ok(())
}

/// Sweep the `node-debugger-*` pods that `kubectl debug node/` leaves
/// behind, so repeated dev/host shells don't accumulate Completed pods.
/// The frontend calls this when a dev-shell terminal closes. Best-
/// effort and cosmetic — mirrors cleanupNodeDebuggerPods in the CLI.
#[tauri::command]
async fn microvm_dev_cleanup(name: Option<String>) -> Result<(), String> {
    let name = vm_name(name);
    let home = home_dir().ok_or("cannot resolve the home directory")?;
    let kubeconfig = home
        .join(SHARED_PROFILES_DIR)
        .join("vm")
        .join(&name)
        .join("kubeconfig.yaml");
    if !kubeconfig.is_file() {
        return Ok(()); // VM gone — nothing to sweep.
    }
    let kc = kubeconfig.to_string_lossy().to_string();
    let (ok, stdout, _) = run_status_command(&[
        "kubectl",
        "--kubeconfig",
        &kc,
        "get",
        "pods",
        "-o",
        "jsonpath={.items[*].metadata.name}",
    ])
    .await?;
    if !ok {
        return Ok(());
    }
    let debuggers: Vec<&str> = stdout
        .split_whitespace()
        .filter(|n| n.starts_with("node-debugger-"))
        .collect();
    if debuggers.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec![
        "kubectl",
        "--kubeconfig",
        &kc,
        "delete",
        "pod",
        "--wait=false",
    ];
    args.extend(debuggers);
    let _ = run_status_command(&args).await;
    Ok(())
}

// ============================================================
// Coding agents (Phase 5, A5) — launch + observe.
//
// A "Launch agent" affordance shells the bundled `appliance` CLI's
// `agent start … --no-attach` (A3) to spawn a Claude Code agent in a
// detached `agent-<id>` tmux session inside the VM, broker-wired so the
// Anthropic key is injected host-side and never enters the VM
// (docs/agent-sandbox.md §3). The desktop then attaches that session as
// an agent-typed terminal tab (the E3 reattachable-session machinery) to
// observe/steer it. `agent list` surfaces the per-project registry so the
// rehydrated tab can be labelled + status-dotted.
// ============================================================

/// The host workspace a VM has mounted at `/persist/workspace`
/// (`devMount` in its `vm.json`), when it is a dev VM. An agent launch +
/// its `.appliance/agents.json` registry are scoped to this dir, so
/// `appliance agent start` reuses the running VM as-is instead of
/// restarting it to remount a different workspace (ensureSandboxVm).
fn vm_dev_mount(name: &str) -> Option<String> {
    let spec = home_dir()?
        .join(SHARED_PROFILES_DIR)
        .join("vm")
        .join(name)
        .join("vm.json");
    let raw = std::fs::read_to_string(spec).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    parsed
        .get("devMount")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn default_agent_type() -> String {
    "claude-code".to_string()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentStartInput {
    /// VM to launch in; null → the canonical `appliance` VM.
    #[serde(default)]
    name: Option<String>,
    /// Adapter key — `claude-code` / `copilot` / `codex`. Passed straight to
    /// `agent start --type`; the CLI resolves + validates it.
    #[serde(rename = "type", default = "default_agent_type")]
    agent_type: String,
    /// Optional task prompt (interactive label / autonomous prompt).
    #[serde(default)]
    task: Option<String>,
    /// The pre-minted `agent-<uuid>` session id the observe tab attaches
    /// to. Pre-minting lets the desktop open the tab against a known id
    /// the moment the launch returns (the tmux session already exists).
    session_id: String,
}

/// Launch a coding agent in the VM by shelling the bundled `appliance`
/// CLI: `agent start --vm <vm> --type <t> --session <id> --no-attach
/// [--task <t>] [--dir <devMount>]`. `--no-attach` records the agent +
/// spawns its detached `agent-<id>` tmux session WITHOUT the CLI's
/// interactive attach — the desktop attaches it itself as an agent tab.
/// Surfaces the CLI's stderr (e.g. "No Anthropic key configured") on
/// failure so the launcher can show it.
#[tauri::command]
async fn microvm_agent_start(app: AppHandle, input: AgentStartInput) -> Result<(), String> {
    let vm = vm_name(input.name);
    let session_id = input.session_id.trim().to_string();
    if session_id.is_empty() {
        return Err("a session id is required to launch an agent".to_string());
    }
    // Require a shared host workspace: the agent runs in /persist/workspace
    // and writes its `.appliance/agents.json` registry there. Pinning
    // `--dir` to the VM's existing mount also stops the CLI's
    // ensureSandboxVm from restarting the running VM to remount.
    let Some(dir) = vm_dev_mount(&vm) else {
        return Err(format!(
            "VM '{vm}' has no shared workspace folder — start it as a dev environment with a shared \
             folder before launching an agent."
        ));
    };
    let mut args: Vec<String> = vec![
        "agent".into(),
        "start".into(),
        "--vm".into(),
        vm.clone(),
        "--type".into(),
        input.agent_type,
        "--session".into(),
        session_id,
        "--no-attach".into(),
        "--dir".into(),
        dir,
    ];
    if let Some(task) = input
        .task
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        args.push("--task".into());
        args.push(task.to_string());
    }
    let mut sidecar = app
        .shell()
        .sidecar("appliance")
        .map_err(|e| format!("Bundled appliance CLI is unavailable: {e}"))?
        .args(args);
    // `agent start` can boot the VM itself (ensureSandboxVm) and stage
    // guest artifacts — same repo-built preference as run_microvm_up.
    if let Some(bin) = bundled_api_server_binary(&app) {
        sidecar = sidecar.env(
            "APPLIANCE_API_SERVER_BINARY",
            bin.to_string_lossy().to_string(),
        );
    }
    let (mut rx, _child) = sidecar
        .spawn()
        .map_err(|e| format!("failed to spawn appliance CLI: {e}"))?;
    let mut stderr_buf = String::new();
    let mut exit_code: Option<i32> = None;
    let mut spawn_error: Option<String> = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stderr(bytes) => {
                stderr_buf.push_str(&String::from_utf8_lossy(&bytes));
            }
            CommandEvent::Error(msg) => {
                spawn_error = Some(msg);
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
            }
            _ => {}
        }
    }
    if let Some(msg) = spawn_error {
        return Err(format!("appliance agent start error: {msg}"));
    }
    if exit_code != Some(0) {
        let tail = stderr_buf.trim();
        return Err(if tail.is_empty() {
            format!("appliance agent start exited with code {exit_code:?}")
        } else {
            tail.to_string()
        });
    }
    Ok(())
}

/// One agent as reported by `appliance agent list --json` — the registry
/// record plus a reconciled `live` flag. Re-emitted to the frontend so a
/// rehydrated agent tab can show its type/task/status.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentInfo {
    id: String,
    #[serde(rename = "type")]
    agent_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    task: Option<String>,
    status: String,
    session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    live: Option<bool>,
}

/// List the agents recorded for a VM's mounted project
/// (`.appliance/agents.json`), reconciled against live tmux sessions.
/// Shells `appliance agent list --json` with the CWD set to the VM's
/// mounted workspace (where the registry lives). Best-effort: an absent
/// registry / non-dev VM / parse hiccup yields an empty list rather than
/// an error, so rehydrate degrades to labelling agent tabs by their
/// `agent-` id alone.
#[tauri::command]
async fn microvm_agent_list(
    app: AppHandle,
    name: Option<String>,
) -> Result<Vec<AgentInfo>, String> {
    let vm = vm_name(name);
    let Some(dir) = vm_dev_mount(&vm) else {
        return Ok(Vec::new()); // no mounted project → no per-project registry
    };
    let sidecar = app
        .shell()
        .sidecar("appliance")
        .map_err(|e| format!("Bundled appliance CLI is unavailable: {e}"))?
        .current_dir(dir)
        .args([
            "agent".to_string(),
            "list".to_string(),
            "--json".to_string(),
        ]);
    let (mut rx, _child) = sidecar
        .spawn()
        .map_err(|e| format!("failed to spawn appliance CLI: {e}"))?;
    let mut stdout_buf = String::new();
    let mut exit_code: Option<i32> = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => stdout_buf.push_str(&String::from_utf8_lossy(&bytes)),
            CommandEvent::Terminated(payload) => exit_code = payload.code,
            _ => {}
        }
    }
    if exit_code != Some(0) {
        return Ok(Vec::new()); // tolerate a missing/empty registry
    }
    // `agent list --json` prints a (pretty) JSON array and nothing else;
    // parse from the first '[' and swallow any parse hiccup so a malformed
    // registry never breaks tab rehydrate.
    match stdout_buf.find('[') {
        Some(i) => Ok(serde_json::from_str(stdout_buf[i..].trim_end()).unwrap_or_default()),
        None => Ok(Vec::new()),
    }
}

/// Tear down a guest tmux session by id DIRECTLY, bypassing the agent
/// registry: `appliance-vm sessions kill <id> --name <vm>`. The agent's
/// session id IS the tmux session key (`agent-<uuid>`), so this reaches the
/// same session `appliance agent stop` would — without depending on the
/// `.appliance/agents.json` registry being readable / the row resolving.
/// Best-effort: killing an already-dead session is a harmless no-op.
async fn kill_guest_session(vm: &str, id: &str) {
    let Some(bin) = vm_binary() else { return };
    let bin = bin.to_string_lossy().to_string();
    let _ = run_status_command(&[&bin, "sessions", "kill", id, "--name", vm]).await;
}

/// Stop an agent by shelling `appliance agent stop <id>` with the CWD set
/// to the VM's mounted workspace (where the `.appliance/agents.json`
/// registry lives). The CLI kills the agent's tmux session and flips its
/// registry row to `exited`, so closing an agent tab leaves no stale
/// `running` record. Called as the agent-tab close path; best-effort, so
/// a non-dev VM / already-dead session yields Ok rather than surfacing an
/// error on tab close.
///
/// The guest tmux teardown MUST NOT depend on registry resolution (Quinn):
/// `appliance agent stop` only kills the session when it can read the
/// project registry AND `findAgent` locates the row — if the VM has no
/// shared workspace (no registry) or the row can't be resolved, the CLI
/// exits without killing and the session would leak. So we fall back to a
/// direct `sessions kill` whenever there's no mount, or the CLI stop exits
/// non-zero (which covers both "row not found, never killed" and "session
/// already gone" — the direct kill is idempotent either way).
#[tauri::command]
async fn microvm_agent_stop(
    app: AppHandle,
    name: Option<String>,
    id: String,
) -> Result<(), String> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("an agent id is required to stop an agent".to_string());
    }
    let vm = vm_name(name);
    let Some(dir) = vm_dev_mount(&vm) else {
        // No mounted project → the CLI can't resolve the registry row, so it
        // would never kill the session. Tear it down directly so it can't leak.
        kill_guest_session(&vm, &id).await;
        return Ok(());
    };
    let sidecar = app
        .shell()
        .sidecar("appliance")
        .map_err(|e| format!("Bundled appliance CLI is unavailable: {e}"))?
        .current_dir(dir)
        .args(["agent".to_string(), "stop".to_string(), id.clone()]);
    let (mut rx, _child) = sidecar
        .spawn()
        .map_err(|e| format!("failed to spawn appliance CLI: {e}"))?;
    // Drain to completion (so the kill + registry write finish). Capture the
    // exit code: `agent stop` exits non-zero both when the tmux session was
    // already gone (registry still flipped to `exited` — fine) AND when it
    // couldn't find the registry row at all (NO kill happened — leak). We
    // can't tell those apart from the code, so on ANY non-zero exit run the
    // direct kill as a belt-and-suspenders teardown.
    let mut exit_code: Option<i32> = None;
    while let Some(event) = rx.recv().await {
        if let CommandEvent::Terminated(payload) = event {
            exit_code = payload.code;
        }
    }
    if exit_code != Some(0) {
        kill_guest_session(&vm, &id).await;
    }
    Ok(())
}

// ============================================================
// Agent credential login (Phase 5, L3 / multi-agent G3 —
// docs/agent-login.md §4, docs/multi-agent-adapters.md §4).
//
// Lets a DESKTOP-only user authenticate a coding agent — claude-code (API key
// OR subscription OAuth "Sign in with Claude"), copilot (fine-grained GitHub
// PAT), codex (OpenAI API key) — without a terminal. Each agent's credential is
// stored host-side ONLY, in its OWN PER-PROVIDER store (so three agents never
// collide), and is NEVER sent to the VM: the egress broker injects it host-side
// on the outbound request (the VM holds at most an inert placeholder). This
// mirrors the CLI's host store (`packages/cli/src/utils/agent.ts`
// writeAgentKey(provider, value, kind) / parseStoredCred / readAgentKey): the
// SAME Keychain item (`sh.appliance.agent`, account = the agent's provider) /
// `<provider>-cred` 0600 file and the SAME kind-tagged JSON envelope
// `{"kind":"…","value":"…"}`, so the broker's `print-key --type <agent>` (run
// at inject time) reads it back unchanged.
//
// IMPORTANT: the envelope format + per-provider store keys MUST stay in sync
// with utils/agent.ts — a drift fails the broker CLOSED.
// ============================================================

// Only the macOS `security`-backed store paths reference the service
// name; off-macOS the per-provider 0600 cred files carry the envelope.
#[cfg(target_os = "macos")]
const AGENT_KEYCHAIN_SERVICE: &str = "sh.appliance.agent";

/// Map an agent `--type` to its per-provider host cred-store key, mirroring the
/// CLI registry (utils/agent.ts adapters): claude-code→anthropic,
/// copilot→github-copilot, codex→openai. The provider is the Keychain account
/// on macOS and the `<provider>-cred` 0600 filename off-macOS. None for an
/// unknown type (the caller errors actionably).
fn provider_for_agent_type(agent_type: &str) -> Option<&'static str> {
    match agent_type {
        "claude-code" => Some("anthropic"),
        "copilot" => Some("github-copilot"),
        "codex" => Some("openai"),
        _ => None,
    }
}

/// Which credential kinds a provider's agent accepts — mirrors the CLI
/// adapters' `authModes`: anthropic = api-key|oauth, github-copilot = pat,
/// openai = api-key. The stored kind selects the broker auth mode per agent.
fn provider_accepts_kind(provider: &str, kind: &str) -> bool {
    match provider {
        "anthropic" => kind == "api-key" || kind == "oauth",
        "github-copilot" => kind == "pat",
        "openai" => kind == "api-key",
        _ => false,
    }
}

/// The off-macOS host store path (`~/.appliance/agent/<provider>-cred`).
/// Mirrors `agentKeyFile(provider)` in the CLI.
#[cfg(not(target_os = "macos"))]
fn agent_key_file(provider: &str) -> Option<PathBuf> {
    Some(
        home_dir()?
            .join(".appliance")
            .join("agent")
            .join(format!("{provider}-cred")),
    )
}

/// The legacy pre-multi-agent Anthropic 0600 file (`anthropic-key`), read as a
/// fallback so a non-macOS user who logged in before the per-provider rename
/// keeps working until they next sign in. Mirrors `legacyAnthropicKeyFile()`.
#[cfg(not(target_os = "macos"))]
fn legacy_anthropic_key_file() -> Option<PathBuf> {
    Some(
        home_dir()?
            .join(".appliance")
            .join("agent")
            .join("anthropic-key"),
    )
}

/// Whether a host credential is stored, and (best-effort) its kind. Never
/// carries the secret value. Serialized to the frontend's `AgentAuthStatus`.
#[derive(Serialize)]
struct AgentAuthStatus {
    configured: bool,
    /// `api-key` | `oauth` | `pat` when known; null on macOS (we do NOT read
    /// the secret just to render a label — that would trigger a Keychain access
    /// prompt) or when nothing is stored.
    kind: Option<String>,
}

/// Write the kind-tagged credential envelope to the host Keychain (macOS),
/// under `provider`'s account. `security add-generic-password -U` upserts. The
/// secret is briefly on `security`'s argv — the SAME documented tradeoff as the
/// CLI's writeAgentKey (there's no stdin form); it is passed via execvp (no
/// shell), so it cannot be word-split or interpreted. NEVER logged.
#[cfg(target_os = "macos")]
fn store_agent_cred_envelope(provider: &str, envelope: &str) -> Result<(), String> {
    let out = std::process::Command::new("/usr/bin/security")
        .args([
            "add-generic-password",
            "-U",
            "-s",
            AGENT_KEYCHAIN_SERVICE,
            "-a",
            provider,
            "-w",
            envelope,
        ])
        .output()
        .map_err(|e| format!("could not run `security`: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "failed to store the credential in the Keychain: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// Write the kind-tagged credential envelope to a 0600 file off-macOS, under
/// `<provider>-cred`. Mirrors the CLI's writeAgentKey fallback. NEVER logged.
#[cfg(not(target_os = "macos"))]
fn store_agent_cred_envelope(provider: &str, envelope: &str) -> Result<(), String> {
    let file = agent_key_file(provider).ok_or("cannot resolve the home directory")?;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create the agent store dir: {e}"))?;
    }
    std::fs::write(&file, envelope).map_err(|e| format!("could not write the agent store: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("could not chmod the agent store: {e}"))?;
    }
    Ok(())
}

/// Store an agent credential host-side under `agent_type`'s provider store,
/// tagged by `kind` (L3 + multi-agent). Builds the SAME `{"kind","value"}`
/// envelope the CLI's writeAgentKey writes, so the broker's `print-key` reads it
/// back. The credential is written ONLY to the host store — NEVER sent to the
/// VM. NEVER logs the value.
#[tauri::command]
async fn microvm_agent_login(
    agent_type: String,
    kind: String,
    value: String,
) -> Result<(), String> {
    let agent_type = agent_type.trim();
    let Some(provider) = provider_for_agent_type(agent_type) else {
        return Err(format!("unknown agent type '{agent_type}'"));
    };
    let kind = kind.trim();
    if !provider_accepts_kind(provider, kind) {
        return Err(format!(
            "credential kind '{kind}' is not valid for agent '{agent_type}'"
        ));
    }
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("refusing to store an empty {provider} credential"));
    }
    // Copilot PAT hard guard (defense-in-depth, mirrors the CLI's
    // validateCopilotPat — docs/multi-agent-adapters.md §4/§7): a host-keyed PAT
    // is injected on ALL guest→api.github.com traffic, so it MUST be a
    // fine-grained `github_pat_` token (scoped to Copilot Requests), never a
    // classic `ghp_` token that carries the user's full account scope.
    if kind == "pat" {
        if value.starts_with("ghp_") {
            return Err(
                "classic ghp_ PAT rejected — use a fine-grained github_pat_ token scoped to Copilot Requests only."
                    .to_string(),
            );
        }
        if !value.starts_with("github_pat_") {
            return Err(
                "expected a fine-grained GitHub PAT starting with github_pat_.".to_string(),
            );
        }
    }
    // serde_json escapes the value safely; parseStoredCred reads the envelope
    // order-independently, so this matches the CLI's JSON.stringify shape.
    let envelope = serde_json::json!({ "kind": kind, "value": value }).to_string();
    store_agent_cred_envelope(provider, &envelope)
}

/// Parse ONLY the kind out of a stored envelope (off-macOS), mirroring
/// parseStoredCred: a legacy bare string is `api-key`; an
/// unparseable/truncated/empty-value envelope is `None` (→ not configured).
/// NEVER returns the secret value.
#[cfg(not(target_os = "macos"))]
fn parse_cred_kind(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if s.starts_with('{') {
        let v: serde_json::Value = serde_json::from_str(s).ok()?;
        let kind = v.get("kind").and_then(|k| k.as_str())?;
        let value_ok = v
            .get("value")
            .and_then(|x| x.as_str())
            .is_some_and(|x| !x.trim().is_empty());
        if (kind == "api-key" || kind == "oauth" || kind == "pat") && value_ok {
            return Some(kind.to_string());
        }
        return None;
    }
    Some("api-key".to_string()) // legacy bare string → api-key
}

/// macOS: does `provider`'s Keychain item EXIST? Attribute lookup (no `-w`),
/// which does NOT decrypt the secret and so does NOT trigger an access prompt.
/// We deliberately don't read the secret just to label it, so `kind` is null.
#[cfg(target_os = "macos")]
fn read_agent_cred_status(provider: &str) -> AgentAuthStatus {
    let configured = std::process::Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            AGENT_KEYCHAIN_SERVICE,
            "-a",
            provider,
        ])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    AgentAuthStatus {
        configured,
        kind: None,
    }
}

/// Off-macOS: the 0600 file is plain-readable, so report the parsed kind.
/// Reads `<provider>-cred`, falling back to the legacy `anthropic-key` for the
/// anthropic provider (mirrors readAgentKey's legacy fallback).
#[cfg(not(target_os = "macos"))]
fn read_agent_cred_status(provider: &str) -> AgentAuthStatus {
    let raw = agent_key_file(provider)
        .and_then(|f| std::fs::read_to_string(f).ok())
        .or_else(|| {
            if provider == "anthropic" {
                legacy_anthropic_key_file().and_then(|f| std::fs::read_to_string(f).ok())
            } else {
                None
            }
        });
    let kind = raw.and_then(|raw| parse_cred_kind(&raw));
    AgentAuthStatus {
        configured: kind.is_some(),
        kind,
    }
}

/// Report whether `agent_type`'s host credential is stored (+ best-effort
/// kind), for the desktop's per-agent "signed in" indicator. Never exposes the
/// secret.
#[tauri::command]
async fn microvm_agent_login_status(agent_type: String) -> Result<AgentAuthStatus, String> {
    let agent_type = agent_type.trim();
    let Some(provider) = provider_for_agent_type(agent_type) else {
        return Err(format!("unknown agent type '{agent_type}'"));
    };
    Ok(read_agent_cred_status(provider))
}

/// Forget `provider`'s stored host credential (macOS Keychain item / 0600
/// file). Off-macOS also drops the legacy `anthropic-key` for anthropic.
#[cfg(target_os = "macos")]
fn forget_agent_cred(provider: &str) {
    let _ = std::process::Command::new("/usr/bin/security")
        .args([
            "delete-generic-password",
            "-s",
            AGENT_KEYCHAIN_SERVICE,
            "-a",
            provider,
        ])
        .output();
}

#[cfg(not(target_os = "macos"))]
fn forget_agent_cred(provider: &str) {
    if let Some(f) = agent_key_file(provider) {
        let _ = std::fs::remove_file(f);
    }
    if provider == "anthropic" {
        if let Some(f) = legacy_anthropic_key_file() {
            let _ = std::fs::remove_file(f);
        }
    }
}

/// Forget `agent_type`'s stored host credential (the desktop "sign out").
#[tauri::command]
async fn microvm_agent_logout(agent_type: String) -> Result<(), String> {
    let agent_type = agent_type.trim();
    let Some(provider) = provider_for_agent_type(agent_type) else {
        return Err(format!("unknown agent type '{agent_type}'"));
    };
    forget_agent_cred(provider);
    Ok(())
}

/// Is `claude` present + runnable on this HOST? "Sign in with Claude" runs
/// `claude setup-token` host-side (mirrors the CLI's hostHasClaude). The
/// launch PATH is pre-augmented with the user's bin dirs at startup
/// (ensure_user_paths_on_path), so a Homebrew / `~/.local/bin` `claude`
/// resolves the same as in the user's shell.
#[tauri::command]
async fn microvm_agent_has_host_claude() -> bool {
    matches!(
        run_status_command(&["claude", "--version"]).await,
        Ok((true, _, _))
    )
}

/// Best-effort: open Terminal.app running `claude setup-token` (macOS) so the
/// user can complete the browser sign-in and copy the one-year token to paste
/// back into the desktop. We do NOT capture the token here — `setup-token` is
/// a full-screen TUI that reveals it on-screen only (docs/agent-login.md §7).
#[cfg(target_os = "macos")]
async fn open_setup_token_terminal() -> Result<bool, String> {
    let (ok, _out, err) = run_status_command(&[
        "/usr/bin/osascript",
        "-e",
        "tell application \"Terminal\" to do script \"claude setup-token\"",
        "-e",
        "tell application \"Terminal\" to activate",
    ])
    .await?;
    if !ok {
        return Err(format!(
            "could not open Terminal to run `claude setup-token`: {}",
            err.trim()
        ));
    }
    Ok(true)
}

/// No reliable cross-platform "open a visible terminal running X" — the UI
/// falls back to showing the manual `claude setup-token` command.
#[cfg(not(target_os = "macos"))]
async fn open_setup_token_terminal() -> Result<bool, String> {
    Ok(false)
}

/// Launch `claude setup-token` in a visible host terminal (best-effort).
/// Resolves `false` where no auto-launch exists (the UI shows the manual
/// command). The token is captured via the desktop paste field, not here.
#[tauri::command]
async fn microvm_agent_run_setup_token() -> Result<bool, String> {
    open_setup_token_terminal().await
}

// ============================================================
// Build + deploy from a local source folder.
//
// Driven by the desktop's deploy wizard: pick a folder containing an
// appliance.json manifest, optionally override env/runtime params,
// then build the image with docker + push to the local cluster's
// registry. The actual api-server build + deploy calls run from the
// frontend using the existing SDK (it already holds the cluster's
// signed credentials, so we don't reimplement that in Rust).
// ============================================================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplianceManifestInfo {
    /// Manifest type / format. Mirrors the JSON manifest's `manifest`
    /// field; informational only.
    #[serde(skip_serializing_if = "Option::is_none")]
    manifest: Option<String>,
    name: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    appliance_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    platform: Option<String>,
    /// Default env values from the manifest, surfaced so the wizard
    /// can prefill the env-var editor.
    #[serde(skip_serializing_if = "Option::is_none")]
    env: Option<serde_json::Value>,
    /// Path to the resolved manifest file (`<dir>/appliance.json`).
    manifest_path: String,
}

/// Probe a folder for an appliance manifest and return its parsed
/// contents. `appliance.json` is read directly. Programmatic .ts/.js
/// manifests are evaluated by spawning the bundled CLI sidecar with
/// `appliance manifest read --json`, which runs the manifest in its
/// QuickJS sandbox (see packages/cli/src/sandbox) and prints the
/// resolved object as a single JSON line on stdout. The CLI binary
/// is the same one shipped to end users, so the desktop and CLI
/// always see the manifest through the same sandbox.
#[tauri::command]
async fn read_appliance_manifest(
    app: AppHandle,
    path: String,
) -> Result<ApplianceManifestInfo, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("not a directory: {}", dir.display()));
    }

    let json_path = dir.join("appliance.json");
    if json_path.exists() {
        let raw = fs::read_to_string(&json_path).map_err(|e| format!("read manifest: {e}"))?;
        let value: serde_json::Value =
            serde_json::from_str(&raw).map_err(|e| format!("parse manifest: {e}"))?;
        return manifest_info_from_value(&value, &json_path);
    }

    // Probe for a programmatic manifest. First hit wins, matching the
    // CLI's resolution order so both surfaces pick the same file.
    let code_manifest = [
        "appliance.ts",
        "appliance.mts",
        "appliance.cts",
        "appliance.js",
        "appliance.mjs",
        "appliance.cjs",
    ]
    .iter()
    .map(|n| dir.join(n))
    .find(|p| p.exists());

    let Some(code_path) = code_manifest else {
        return Err(format!(
            "No appliance manifest found in {} (looked for appliance.json plus .ts/.mts/.cts/.js/.mjs/.cjs)",
            dir.display()
        ));
    };

    let value = evaluate_manifest_via_sidecar(&app, &code_path).await?;
    manifest_info_from_value(&value, &code_path)
}

/// Shape one manifest field-set into the wizard-facing struct. Shared
/// between the JSON fast path and the sandbox-evaluated path.
fn manifest_info_from_value(
    value: &serde_json::Value,
    file_path: &std::path::Path,
) -> Result<ApplianceManifestInfo, String> {
    let name = value
        .get("name")
        .and_then(|n| n.as_str())
        .ok_or_else(|| "manifest is missing 'name'".to_string())?
        .to_string();
    Ok(ApplianceManifestInfo {
        manifest: value
            .get("manifest")
            .and_then(|m| m.as_str())
            .map(String::from),
        name,
        appliance_type: value.get("type").and_then(|t| t.as_str()).map(String::from),
        port: value
            .get("port")
            .and_then(|p| p.as_u64())
            .and_then(|p| u16::try_from(p).ok()),
        platform: value
            .get("platform")
            .and_then(|p| p.as_str())
            .map(String::from),
        env: value.get("env").cloned(),
        manifest_path: file_path.to_string_lossy().to_string(),
    })
}

/// Spawn the bundled `appliance` CLI sidecar with the `manifest read`
/// subcommand. The CLI emits exactly one JSON line on stdout:
///
/// ```text
/// {ok: true, path, manifest}                       (success)
/// {ok: false, kind: 'runtime' | 'validation', error, path?}  (failure)
/// ```
///
/// We surface the failure as a plain string so the wizard can display
/// it next to the folder picker without any further unwrapping.
async fn evaluate_manifest_via_sidecar(
    app: &AppHandle,
    manifest_path: &std::path::Path,
) -> Result<serde_json::Value, String> {
    let sidecar = app
        .shell()
        .sidecar("appliance")
        .map_err(|e| format!(
            "Bundled appliance CLI is unavailable: {e}. Rebuild with `pnpm --filter @appliance.sh/desktop build` so the CLI binary lands in src-tauri/binaries/."
        ))?
        .args([
            "manifest".to_string(),
            "read".to_string(),
            manifest_path.to_string_lossy().to_string(),
        ]);

    let (mut rx, _child) = sidecar
        .spawn()
        .map_err(|e| format!("failed to spawn appliance CLI: {e}"))?;

    let mut stdout_buf = String::new();
    let mut stderr_buf = String::new();
    let mut exit_code: Option<i32> = None;
    let mut spawn_error: Option<String> = None;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                stdout_buf.push_str(&String::from_utf8_lossy(&bytes));
            }
            CommandEvent::Stderr(bytes) => {
                stderr_buf.push_str(&String::from_utf8_lossy(&bytes));
            }
            CommandEvent::Error(msg) => {
                spawn_error = Some(msg);
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
            }
            _ => {}
        }
    }

    if let Some(msg) = spawn_error {
        return Err(format!("appliance CLI error: {msg}"));
    }

    // The CLI prints exactly one JSON object. Take the last non-empty
    // line so any incidental warnings on stdout don't break parsing.
    let last_json_line = stdout_buf
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .ok_or_else(|| {
            let stderr_tail = stderr_buf.trim();
            if stderr_tail.is_empty() {
                format!(
                    "appliance CLI produced no output (exit code {:?})",
                    exit_code
                )
            } else {
                format!("appliance CLI produced no output (stderr: {stderr_tail})")
            }
        })?;

    let parsed: serde_json::Value = serde_json::from_str(last_json_line)
        .map_err(|e| format!("appliance CLI output was not JSON: {e}: {last_json_line}"))?;

    let ok = parsed.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if !ok {
        let err = parsed
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown error in manifest sandbox")
            .to_string();
        return Err(err);
    }

    parsed
        .get("manifest")
        .cloned()
        .ok_or_else(|| "appliance CLI did not return a manifest object".to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageAndUploadInput {
    /// Absolute path of the app folder (manifest + source — the same
    /// folder the wizard's folder picker returned).
    path: String,
    /// One-time upload URL minted by the api-server's `POST
    /// /api/v1/builds` (presigned S3 on cloud bases, token self-URL on
    /// Kubernetes bases). Authorization travels in the URL, so this
    /// command needs no api-server credentials of its own.
    upload_url: String,
    /// Skip Lambda zip-runtime prep for framework apps. The wizard
    /// passes true when the target base builds container images from
    /// source (mirrors the `lambdaPrep` decision in the CLI's
    /// deploy-core).
    #[serde(default)]
    no_lambda_prep: bool,
}

/// Package the picked app folder as a source zip and upload it to the
/// api-server, by driving the bundled `appliance` CLI sidecar
/// (`appliance build --json --upload-url …`). The CLI owns packaging
/// (resolved manifest + project tree, .dockerignore honored), so the
/// wizard ships byte-identical artifacts to a terminal `appliance
/// deploy`; the upload itself is a raw PUT because the URL carries a
/// one-time token / S3 presignature. NDJSON progress is forwarded to
/// the frontend channel; the final `result` line resolves the call.
///
/// APPLIANCE_TRUST_MANIFEST=1: programmatic (.ts/.js) manifests
/// normally require an interactive trust prompt. In the wizard the
/// user explicitly picked this folder in a native dialog and clicked
/// Deploy after reviewing the evaluated manifest — that is the trust
/// gesture, and the sidecar has no TTY to re-ask on.
#[tauri::command]
async fn package_and_upload_build(
    app: AppHandle,
    input: PackageAndUploadInput,
    on_event: Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let dir = PathBuf::from(&input.path);
    if !dir.is_dir() {
        return Err(format!("not a directory: {}", dir.display()));
    }

    let mut args: Vec<String> = vec![
        "build".into(),
        "--json".into(),
        "--upload-url".into(),
        input.upload_url.clone(),
    ];
    if input.no_lambda_prep {
        args.push("--no-lambda-prep".into());
    }

    let sidecar = app
        .shell()
        .sidecar("appliance")
        .map_err(|e| {
            format!(
                "Bundled appliance CLI is unavailable: {e}. Rebuild with `pnpm --filter @appliance.sh/desktop build` so the CLI binary lands in src-tauri/binaries/."
            )
        })?
        .args(&args)
        .current_dir(dir)
        .env("APPLIANCE_TRUST_MANIFEST", "1");

    let (mut rx, _child) = sidecar
        .spawn()
        .map_err(|e| format!("failed to spawn appliance CLI: {e}"))?;

    let mut final_result: Option<serde_json::Value> = None;
    let mut error: Option<String> = None;
    let mut exit_code: Option<i32> = None;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<serde_json::Value>(trimmed) {
                    Ok(parsed) => match parsed.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                        "result" => final_result = parsed.get("result").cloned(),
                        "error" => {
                            error = parsed
                                .get("error")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                        }
                        _ => {
                            let _ = on_event.send(parsed);
                        }
                    },
                    // A user `scripts.build` runs with inherited stdio,
                    // so its output isn't NDJSON — forward it as a log
                    // line instead of dropping it.
                    Err(_) => {
                        let _ = on_event.send(serde_json::json!({
                            "type": "log",
                            "stream": "stdout",
                            "message": trimmed,
                        }));
                    }
                }
            }
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes).trim().to_string();
                if !line.is_empty() {
                    let _ = on_event.send(serde_json::json!({
                        "type": "log",
                        "stream": "stderr",
                        "message": line,
                    }));
                }
            }
            CommandEvent::Error(msg) => error = Some(msg),
            CommandEvent::Terminated(payload) => exit_code = payload.code,
            _ => {}
        }
    }

    if let Some(msg) = error {
        return Err(msg);
    }
    match final_result {
        Some(result) => Ok(result),
        None => Err(format!(
            "appliance build exited with code {} before reporting a result",
            exit_code.map_or_else(|| "?".to_string(), |c| c.to_string())
        )),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeployToCloudInput {
    /// Project folder — the CLI's working directory. It holds the manifest
    /// the CLI builds `appliance.zip` from, and is where that zip is written.
    path: String,
    /// CLI profile to authenticate with == the selected cluster's id. The
    /// desktop already mirrors every cluster into ~/.appliance/profiles.json
    /// keyed by id (secret Keychain-first on macOS), so `--profile <id>`
    /// resolves the same cloud + creds the app selected — no interactive login.
    profile: String,
    /// Target project name (first positional arg to `appliance deploy`).
    project: String,
    /// Target environment name (second positional arg).
    environment: String,
}

/// Drive a BYO **AWS / bundle** cloud deploy by shelling the bundled
/// `appliance` CLI — the SAME `app.shell().sidecar("appliance")` path
/// `local_helper_install` / `microvm_agent_start` use. An AWS base deploys
/// an uploaded manifest zip (not a container image), which the desktop can't
/// build itself; `appliance deploy` auto-builds `appliance.zip` from the
/// manifest and uploads it via the SDK's base-URL-agnostic presigned PUT, so
/// we delegate to it rather than re-authoring the build/upload host-side.
///
/// Runs headless: `deploy <project> <env> --profile <clusterId> --yes` with
/// the CWD set to the project folder, so there are no prompts and no prior
/// `appliance setup` needed. Auth is the mirrored profile — nothing sensitive
/// is passed on argv. The CLI's stdout/stderr stream back line-by-line as
/// `{type:"log", stream, message}` LocalLogEvents so the wizard renders a
/// live log pane; a non-zero exit resolves to Err with the stderr tail.
#[tauri::command]
async fn deploy_to_cloud(
    app: AppHandle,
    input: DeployToCloudInput,
    on_event: Channel<serde_json::Value>,
) -> Result<(), String> {
    let path = input.path.trim();
    let profile = input.profile.trim();
    let project = input.project.trim();
    let environment = input.environment.trim();
    if path.is_empty() {
        return Err("a project folder is required to deploy".to_string());
    }
    if profile.is_empty() {
        return Err("no cluster profile to deploy with — select a cloud cluster first".to_string());
    }
    if project.is_empty() || environment.is_empty() {
        return Err("both a project and an environment name are required to deploy".to_string());
    }

    let args: Vec<String> = vec![
        "deploy".into(),
        project.to_string(),
        environment.to_string(),
        "--profile".into(),
        profile.to_string(),
        "--yes".into(),
    ];

    // Echo the command (minus nothing sensitive — the profile is just an id)
    // so the log pane reads like a terminal.
    let _ = on_event.send(serde_json::json!({
        "type": "log",
        "stream": "meta",
        "message": format!("$ appliance deploy {project} {environment} --profile {profile} --yes"),
    }));

    let sidecar = app
        .shell()
        .sidecar("appliance")
        .map_err(|e| {
            format!(
                "Bundled appliance CLI is unavailable: {e}. Rebuild with `pnpm --filter @appliance.sh/desktop build` so the CLI binary lands in src-tauri/binaries/."
            )
        })?
        .current_dir(path)
        .args(&args);

    let (mut rx, _child) = sidecar
        .spawn()
        .map_err(|e| format!("failed to spawn appliance CLI: {e}"))?;

    // Keep a bounded tail of stderr so a non-zero exit surfaces an
    // actionable message rather than a bare code.
    let mut stderr_tail = String::new();
    let mut exit_code: Option<i32> = None;
    let mut spawn_error: Option<String> = None;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => forward_cli_output(&bytes, "stdout", &on_event),
            CommandEvent::Stderr(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                stderr_tail.push_str(&text);
                if stderr_tail.len() > 4096 {
                    let cut = stderr_tail.len() - 4096;
                    stderr_tail.drain(..cut);
                }
                forward_cli_output(&bytes, "stderr", &on_event);
            }
            CommandEvent::Error(msg) => spawn_error = Some(msg),
            CommandEvent::Terminated(payload) => exit_code = payload.code,
            _ => {}
        }
    }

    if let Some(msg) = spawn_error {
        return Err(format!("appliance deploy error: {msg}"));
    }
    if exit_code != Some(0) {
        let tail = stderr_tail.trim();
        return Err(if tail.is_empty() {
            format!("appliance deploy exited with code {exit_code:?}")
        } else {
            tail.to_string()
        });
    }
    Ok(())
}

/// Split a chunk of CLI output into lines and forward each non-empty one as a
/// `{type:"log", stream, message}` LocalLogEvent. The CLI's human-readable
/// output isn't NDJSON, and sidecar reads don't align to line boundaries, so
/// we split on '\n' (dropping a trailing CR) rather than parsing.
fn forward_cli_output(bytes: &[u8], stream: &str, on_event: &Channel<serde_json::Value>) {
    let text = String::from_utf8_lossy(bytes);
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.trim().is_empty() {
            continue;
        }
        let _ = on_event.send(serde_json::json!({
            "type": "log",
            "stream": stream,
            "message": line,
        }));
    }
}

/// Resolve the helper-managed bin dir (`~/.appliance/bin` on POSIX,
/// `%LOCALAPPDATA%\Appliance\bin` on Windows) so we can prepend it to
/// PATH before spawning child processes. Mirrors `helperBinDir()` in
/// `@appliance.sh/helper` — both sides must agree on the location for
/// `appliance local install` (Node) to land binaries the desktop's
/// `Command::new("kubectl")` calls then pick up.
fn helper_bin_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            return Some(PathBuf::from(local).join("Appliance").join("bin"));
        }
    }
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".appliance").join("bin"))
}

/// Prepend the helper bin dir to this process's PATH so every
/// downstream `Command::new(...)` sees `~/.appliance/bin/kubectl` etc.
/// without each call site having to manage env vars. Idempotent.
fn ensure_helper_bin_on_path() {
    let Some(dir) = helper_bin_dir() else {
        return;
    };
    prepend_to_path(&[dir]);
}

/// macOS GUI apps (anything launched from Finder, the Dock, or
/// Spotlight) inherit a stripped-down PATH like
/// `/usr/bin:/bin:/usr/sbin:/sbin`. Tools the user installed via
/// Homebrew (`/opt/homebrew/bin` on Apple Silicon, `/usr/local/bin`
/// on Intel) or pip/cargo's `~/.local/bin` are nowhere to be found,
/// so `Command::new("docker")` returns ENOENT even when `which docker`
/// works fine in Terminal. The user's shell rc files (.zshrc /
/// .bashrc) are NOT sourced for GUI launches.
///
/// We pre-populate PATH with the canonical user-bin dirs so
/// downstream spawns of docker / kubectl / git / etc. resolve
/// the same binaries the user runs from their shell. Existence
/// filtering avoids littering PATH with non-existent entries.
fn ensure_user_paths_on_path() {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if cfg!(target_os = "macos") {
        candidates.extend([
            // Homebrew on Apple Silicon.
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/opt/homebrew/sbin"),
            // Homebrew on Intel + common manual installs.
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/local/sbin"),
            // MacPorts.
            PathBuf::from("/opt/local/bin"),
            PathBuf::from("/opt/local/sbin"),
        ]);
    } else if cfg!(target_os = "linux") {
        candidates.extend([
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/local/sbin"),
            PathBuf::from("/snap/bin"),
            PathBuf::from("/var/lib/flatpak/exports/bin"),
        ]);
    }

    if !cfg!(target_os = "windows") {
        if let Ok(home) = std::env::var("HOME") {
            let home = PathBuf::from(home);
            candidates.push(home.join(".local").join("bin"));
            // cargo, mise, asdf shims; cheap to include since
            // prepend_to_path filters missing entries.
            candidates.push(home.join(".cargo").join("bin"));
            candidates.push(home.join(".local").join("share").join("mise").join("shims"));
            candidates.push(home.join(".asdf").join("shims"));
        }
    }

    let existing: Vec<PathBuf> = candidates.into_iter().filter(|p| p.is_dir()).collect();
    prepend_to_path(&existing);
}

/// Prepend any dirs not already on PATH, preserving order. Skips
/// empty / unresolvable paths and dirs that are already present so
/// repeat calls are no-ops.
fn prepend_to_path(dirs: &[PathBuf]) {
    if dirs.is_empty() {
        return;
    }
    let sep = if cfg!(target_os = "windows") {
        ';'
    } else {
        ':'
    };
    let current = std::env::var("PATH").unwrap_or_default();
    let existing: std::collections::HashSet<&str> = current.split(sep).collect();

    let mut prefix = String::new();
    for dir in dirs {
        let Some(dir_str) = dir.to_str() else {
            continue;
        };
        if existing.contains(dir_str) || prefix.split(sep).any(|p| p == dir_str) {
            continue;
        }
        if !prefix.is_empty() {
            prefix.push(sep);
        }
        prefix.push_str(dir_str);
    }
    if prefix.is_empty() {
        return;
    }
    let next = if current.is_empty() {
        prefix
    } else {
        format!("{prefix}{sep}{current}")
    };
    // Safety: set_var is unsafe in newer Rust because env mutation
    // races other threads. We call it once at startup before any
    // tokio runtime is up.
    unsafe { std::env::set_var("PATH", next) };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Order matters: user paths first so Homebrew etc. resolve before
    // any helper-installed fallback. The helper dir is then prepended
    // on top — its binaries win when both system + helper have a
    // copy, which keeps versioning predictable.
    ensure_user_paths_on_path();
    ensure_helper_bin_on_path();
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init());

    // Self-update is a desktop-only capability: the updater plugin pulls
    // a signed bundle from the feed in tauri.conf.json and swaps the app
    // in place, and `process::relaunch` restarts into the new version.
    // Mobile targets have no equivalent (app-store managed), so gate
    // both plugins behind `#[cfg(desktop)]` to keep the mobile build
    // compiling.
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    builder
        .setup(|app| {
            // Adopt CLI-registered microVM clusters at launch —
            // `appliance vm up` may have run (for any VM) while the
            // desktop was closed, and the cluster switcher should
            // reflect each one without a visit to the Runtimes page.
            // Off the main thread: keychain + file IO, and launch
            // shouldn't block.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Stage-1 single-source-of-truth seed: fold any
                // keychain-only secret into profiles.json before
                // anything else reads it, so the shared store is the
                // complete, authoritative copy. Non-destructive and
                // idempotent — see seed_profiles_from_keychain.
                if let Err(e) = seed_desktop_profiles(&handle) {
                    eprintln!("warn: credential seed at launch failed: {e}");
                }
                let names = match microvm_list().await {
                    Ok(vms) => vms.into_iter().map(|v| v.name).collect::<Vec<_>>(),
                    Err(_) => vec![MICROVM_NAME.to_string()],
                };
                for name in names {
                    if let Err(e) = sync_microvm_cluster(&handle, &name) {
                        eprintln!("warn: microvm cluster sync at launch failed for '{name}': {e}");
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            get_app_mode,
            set_app_mode,
            get_catalogue_cache,
            set_catalogue_cache,
            runtime_installed_list,
            runtime_install_bundle,
            runtime_entitlements_list,
            runtime_entitlements_suggestions,
            runtime_entitlements_revoke,
            runtime_uninstall_bundle,
            runtime_run_installed,
            runtime_stop_installed,
            add_cluster,
            select_cluster,
            remove_cluster,
            set_cluster_state_backend,
            list_aws_profiles,
            run_bootstrap,
            promote_state,
            demote_state,
            update_api_server,
            update_baseline,
            latest_api_server_version,
            teardown_cluster,
            local_helper_install,
            local_preflight,
            start_container_runtime,
            read_appliance_manifest,
            package_and_upload_build,
            deploy_to_cloud,
            bootstrap_in_cluster_api_server,
            microvm_list,
            microvm_status,
            microvm_heal_credentials,
            microvm_install,
            microvm_up,
            microvm_dev_up,
            microvm_cluster_up,
            microvm_dev_cleanup,
            microvm_agent_start,
            microvm_agent_list,
            microvm_agent_stop,
            microvm_agent_login,
            microvm_agent_login_status,
            microvm_agent_logout,
            microvm_agent_has_host_claude,
            microvm_agent_run_setup_token,
            microvm_stop,
            microvm_delete,
            microvm_egress_get,
            microvm_egress_default,
            microvm_egress_rule,
            microvm_egress_remove,
            microvm_egress_mitm,
            microvm_egress_reset,
            microvm_egress_log,
            microvm_egress_clear_log,
            microvm_creds_list,
            microvm_creds_add,
            microvm_creds_remove,
            microvm_creds_set,
            microvm_creds_forget,
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_close,
            terminal_sessions,
            terminal_kill_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalogue_cache_input(generation: u64, verified_at: &str) -> SetCatalogueCacheInput {
        SetCatalogueCacheInput {
            index_json: format!("index-{generation}"),
            signature_json: format!("signature-{generation}"),
            fetched_at: verified_at.to_string(),
            generation,
            verified_at: verified_at.to_string(),
        }
    }

    #[test]
    fn catalogue_cache_floors_are_write_monotonic() {
        let first = next_catalogue_cache(None, catalogue_cache_input(7, "2026-08-27T00:02:00Z"))
            .expect("first cache write");
        let later_generation_with_earlier_clock = next_catalogue_cache(
            Some(&first),
            catalogue_cache_input(8, "2026-08-27T00:01:00Z"),
        )
        .expect("later cache write");
        assert_eq!(later_generation_with_earlier_clock.highest_generation, 8);
        assert_eq!(
            later_generation_with_earlier_clock.max_seen_wall_clock,
            "2026-08-27T00:02:00Z"
        );
        assert!(next_catalogue_cache(
            Some(&later_generation_with_earlier_clock),
            catalogue_cache_input(7, "2026-08-27T00:03:00Z")
        )
        .is_err());
    }

    #[test]
    fn app_mode_round_trips_through_persisted_config() {
        let config = PersistedConfig {
            app_mode: Some(AppMode::User),
            ..Default::default()
        };
        let json = serde_json::to_string(&config).expect("serialize persisted config");
        assert!(json.contains("\"appMode\":\"user\""));
        let decoded: PersistedConfig =
            serde_json::from_str(&json).expect("deserialize persisted config");
        assert_eq!(decoded.app_mode, Some(AppMode::User));
    }

    #[test]
    fn existing_config_defaults_to_developer_but_fresh_install_prompts() {
        let configured = PersistedConfig {
            clusters: vec![test_cluster("existing")],
            ..Default::default()
        };
        assert_eq!(effective_app_mode(&configured), Some(AppMode::Developer));
        assert_eq!(effective_app_mode(&PersistedConfig::default()), None);
    }

    #[test]
    fn ingesting_shared_profiles_preserves_app_mode() {
        let mut shared = SharedProfilesFile {
            active_profile: Some("existing".to_string()),
            ..Default::default()
        };
        shared.profiles.insert(
            "existing".to_string(),
            SharedProfileEntry {
                api_url: "https://api.example.com".to_string(),
                key_id: "key-1".to_string(),
                ..Default::default()
            },
        );

        let ingested = build_ingested_config(&shared, Some(AppMode::User));
        assert_eq!(ingested.app_mode, Some(AppMode::User));
        assert_eq!(ingested.selected_cluster_id.as_deref(), Some("existing"));
        assert_eq!(ingested.clusters.len(), 1);
    }

    // ---- stage-1 credential seed (decide_seed) -------------------

    fn test_cluster(id: &str) -> Cluster {
        Cluster {
            id: id.to_string(),
            name: "Prod".to_string(),
            api_server_url: "https://api.example.com".to_string(),
            created_at: "2024-01-01T00:00:00Z".to_string(),
            state_backend_url: None,
            last_bootstrap_input: None,
            install_generation: None,
            cloud_formation_stack_name: None,
            aws_account_id: None,
            aws_region: None,
            synced_key_id: None,
        }
    }

    fn key(id: &str, secret: &str) -> ApiKey {
        ApiKey {
            id: id.to_string(),
            secret: secret.to_string(),
        }
    }

    #[test]
    fn seeds_keychain_only_secret_into_profiles() {
        // The core case: secret lives only in the keychain, no shared
        // entry yet. It must be folded into profiles.json with the
        // cluster's metadata and a "desktop" surface marker.
        let cluster = test_cluster("prod");
        let k = key("key-1", "s3cr3t");
        match decide_seed(&cluster, Some(&k), None) {
            SeedDecision::Seed { cluster_id, entry } => {
                assert_eq!(cluster_id, "prod");
                assert_eq!(entry.key_id, "key-1");
                assert_eq!(entry.secret, "s3cr3t");
                assert_eq!(entry.api_url, "https://api.example.com");
                assert_eq!(entry.managed.as_deref(), Some("desktop"));
                assert_eq!(entry.name.as_deref(), Some("Prod"));
                assert_eq!(entry.created_at.as_deref(), Some("2024-01-01T00:00:00Z"));
            }
            other => panic!("expected Seed, got {other:?}"),
        }
    }

    #[test]
    fn does_not_overwrite_existing_authoritative_secret() {
        // profiles.json already holds a non-empty secret — it is the
        // source of truth and must NOT be clobbered by the keychain
        // (which may be a stale derived copy after a CLI re-key).
        let cluster = test_cluster("prod");
        let keychain = key("old-key", "stale");
        let existing = SharedProfileEntry {
            api_url: "https://api.example.com".to_string(),
            key_id: "new-key".to_string(),
            secret: "fresh".to_string(),
            managed: Some("cli".to_string()),
            ..Default::default()
        };
        assert_eq!(
            decide_seed(&cluster, Some(&keychain), Some(&existing)),
            SeedDecision::AlreadySeeded
        );
    }

    #[test]
    fn is_idempotent_on_already_seeded_entry() {
        // Re-running after a successful seed (keychain and shared agree)
        // is a no-op — guards against repeated writes on every launch.
        let cluster = test_cluster("prod");
        let k = key("key-1", "s3cr3t");
        let existing = SharedProfileEntry {
            api_url: "https://api.example.com".to_string(),
            key_id: "key-1".to_string(),
            secret: "s3cr3t".to_string(),
            managed: Some("desktop".to_string()),
            ..Default::default()
        };
        assert_eq!(
            decide_seed(&cluster, Some(&k), Some(&existing)),
            SeedDecision::AlreadySeeded
        );
    }

    #[test]
    fn seeds_when_shared_entry_has_empty_secret() {
        // mirror_to_shared_profiles' placeholder path could write an
        // entry with metadata but an empty secret. That is NOT
        // authoritative, so a keychain secret should still seed it —
        // and preserve the placeholder's metadata.
        let cluster = test_cluster("prod");
        let k = key("key-1", "s3cr3t");
        let existing = SharedProfileEntry {
            api_url: "https://api.example.com".to_string(),
            key_id: String::new(),
            secret: String::new(),
            name: Some("Renamed Prod".to_string()),
            managed: Some("desktop".to_string()),
            ..Default::default()
        };
        match decide_seed(&cluster, Some(&k), Some(&existing)) {
            SeedDecision::Seed { entry, .. } => {
                assert_eq!(entry.secret, "s3cr3t");
                assert_eq!(entry.key_id, "key-1");
                // Existing metadata wins over the cluster's copy.
                assert_eq!(entry.name.as_deref(), Some("Renamed Prod"));
            }
            other => panic!("expected Seed, got {other:?}"),
        }
    }

    #[test]
    fn nothing_to_seed_without_keychain_secret() {
        // No keychain entry and no shared secret: don't fabricate an
        // empty profile. Leave the (meta-only or absent) state alone.
        let cluster = test_cluster("prod");
        assert_eq!(
            decide_seed(&cluster, None, None),
            SeedDecision::NothingToSeed
        );
    }

    // ---- Keychain-first secret placement (E4.4) ------------------

    #[test]
    fn macos_keeps_the_secret_out_of_the_shared_file() {
        // macOS: the Keychain is canonical, so the mirror writes an
        // empty secret into profiles.json (the CLI reads it back from
        // the Keychain). Never duplicate the secret to cleartext.
        assert_eq!(shared_secret_for_platform("s3cr3t".to_string(), true), "");
    }

    #[test]
    fn non_macos_writes_the_secret_through_to_the_file() {
        // Linux/cloud/CI: profiles.json (0600) is the canonical store
        // because the CLI cannot read libsecret/DPAPI.
        assert_eq!(
            shared_secret_for_platform("s3cr3t".to_string(), false),
            "s3cr3t"
        );
    }

    #[test]
    fn nothing_to_seed_on_blank_keychain_secret() {
        // A malformed/blank keychain payload must not produce an empty
        // authoritative secret — that's worse than leaving it unset.
        let cluster = test_cluster("prod");
        let blank = key("", "");
        assert_eq!(
            decide_seed(&cluster, Some(&blank), None),
            SeedDecision::NothingToSeed
        );
        let no_id = key("", "secret");
        assert_eq!(
            decide_seed(&cluster, Some(&no_id), None),
            SeedDecision::NothingToSeed
        );
    }

    // ---- microVM credential self-heal (decide_heal) --------------

    use std::time::Instant;

    #[test]
    fn heal_proceeds_on_first_failure() {
        // The core case: a dead key (matches the stored one), no prior
        // attempt — mint.
        let record = HealRecord::default();
        assert_eq!(
            decide_heal(
                &record,
                Instant::now(),
                Some("key-dead"),
                Some("key-dead"),
                None
            ),
            HealDecision::Proceed
        );
    }

    #[test]
    fn heal_proceeds_without_a_stored_key() {
        // Empty/absent profile entry (the VM-recreate case) — nothing
        // to compare, mint.
        let record = HealRecord::default();
        assert_eq!(
            decide_heal(&record, Instant::now(), Some("key-dead"), None, None),
            HealDecision::Proceed
        );
    }

    #[test]
    fn heal_adopts_an_existing_rekey_instead_of_minting() {
        // The CLI already re-minted (stored ≠ failed): sync, don't
        // mint — even while the cooldown from our own last mint is
        // still running.
        let record = HealRecord {
            in_flight: false,
            last_attempt: Some(Instant::now()),
            last_minted_key: Some("key-new".into()),
            last_clock_sync: None,
        };
        assert_eq!(
            decide_heal(
                &record,
                Instant::now(),
                Some("key-old"),
                Some("key-new"),
                None
            ),
            HealDecision::AlreadyRekeyed
        );
    }

    #[test]
    fn heal_skips_while_in_flight() {
        let record = HealRecord {
            in_flight: true,
            ..Default::default()
        };
        assert_eq!(
            decide_heal(&record, Instant::now(), Some("k"), Some("k"), None),
            HealDecision::Skip("heal already in flight")
        );
    }

    #[test]
    fn heal_skips_during_cooldown() {
        let record = HealRecord {
            in_flight: false,
            last_attempt: Some(Instant::now()),
            last_minted_key: None,
            last_clock_sync: None,
        };
        assert_eq!(
            decide_heal(&record, Instant::now(), Some("k"), Some("k"), None),
            HealDecision::Skip("cooldown")
        );
    }

    #[test]
    fn heal_refuses_when_its_own_minted_key_is_rejected() {
        // We minted key-new and the server rejected key-new: the 401
        // isn't credential-shaped (clock skew, digest, server bug) —
        // don't feed the key store.
        let now = Instant::now();
        let record = HealRecord {
            in_flight: false,
            // Past the 60s cooldown but inside the 10min re-mint guard.
            last_attempt: Some(now - Duration::from_secs(120)),
            last_minted_key: Some("key-new".into()),
            last_clock_sync: None,
        };
        assert_eq!(
            decide_heal(&record, now, Some("key-new"), Some("key-new"), None),
            HealDecision::Skip("freshly minted key still rejected — not credential-shaped")
        );
    }

    #[test]
    fn heal_proceeds_again_after_cooldown() {
        // A later, different dead key after the windows expire (e.g.
        // the VM was recreated twice) heals again.
        let now = Instant::now();
        let record = HealRecord {
            in_flight: false,
            last_attempt: Some(now - HEAL_REMINT_GUARD),
            last_minted_key: Some("key-a".into()),
            last_clock_sync: None,
        };
        assert_eq!(
            decide_heal(&record, now, Some("key-a"), Some("key-a"), None),
            HealDecision::Proceed
        );
    }

    // ---- cause-carrying servers (V3 distinguishable 401s) ---------

    #[test]
    fn heal_syncs_clock_on_clock_skew() {
        // The server said the timestamp is out of window: push the host
        // clock instead of minting a key that would fail the same way.
        let record = HealRecord::default();
        assert_eq!(
            decide_heal(
                &record,
                Instant::now(),
                Some("k"),
                Some("k"),
                Some("clock_skew")
            ),
            HealDecision::SyncClock
        );
    }

    #[test]
    fn clock_skew_banners_when_it_recurs_within_the_guard() {
        // First clock_skew → sync. A second one while the guard window
        // is still open means the sync didn't fix it (persistent skew or
        // a broken sync path) — banner, never an infinite sync loop.
        let now = Instant::now();
        let first = HealRecord::default();
        assert_eq!(
            decide_heal(&first, now, Some("k"), Some("k"), Some("clock_skew")),
            HealDecision::SyncClock
        );
        let synced = HealRecord {
            last_clock_sync: Some(now - Duration::from_secs(30)),
            ..Default::default()
        };
        assert_eq!(
            decide_heal(&synced, now, Some("k"), Some("k"), Some("clock_skew")),
            HealDecision::Skip("clock already synced recently — skew persists")
        );
    }

    #[test]
    fn clock_skew_syncs_again_after_the_guard_expires() {
        // A genuinely new skew episode (guest paused/slept again long
        // after the last fix) heals again once the window has passed.
        let now = Instant::now();
        let record = HealRecord {
            last_clock_sync: Some(now - HEAL_REMINT_GUARD),
            ..Default::default()
        };
        assert_eq!(
            decide_heal(&record, now, Some("k"), Some("k"), Some("clock_skew")),
            HealDecision::SyncClock
        );
    }

    #[test]
    fn a_prior_clock_sync_does_not_block_credential_heals() {
        // The clock guard is cause-scoped: a mint for a dead key must
        // proceed even seconds after a clock fix (and vice versa — the
        // SyncClock path never sets the mint cooldown).
        let now = Instant::now();
        let record = HealRecord {
            last_clock_sync: Some(now - Duration::from_secs(5)),
            ..Default::default()
        };
        assert_eq!(
            decide_heal(
                &record,
                now,
                Some("key-dead"),
                Some("key-dead"),
                Some("unknown_key")
            ),
            HealDecision::Proceed
        );
    }

    #[test]
    fn heal_refuses_non_credential_causes() {
        let record = HealRecord::default();
        for cause in ["digest_mismatch", "malformed_signature"] {
            assert_eq!(
                decide_heal(&record, Instant::now(), Some("k"), Some("k"), Some(cause)),
                HealDecision::Skip("server says the failure is not credential-shaped")
            );
        }
    }

    #[test]
    fn heal_mints_on_credential_shaped_causes() {
        let record = HealRecord::default();
        for cause in ["unknown_key", "signature_mismatch"] {
            assert_eq!(
                decide_heal(&record, Instant::now(), Some("k"), Some("k"), Some(cause)),
                HealDecision::Proceed
            );
        }
    }

    #[test]
    fn credential_shaped_cause_supersedes_the_remint_guard() {
        // A cause-carrying server rejected OUR freshly minted key as
        // unknown (e.g. the VM was recreated again right away): the
        // explicit cause replaces the blunt "same key ⇒ not
        // credential-shaped" heuristic, so we mint (cooldown permitting).
        let now = Instant::now();
        let record = HealRecord {
            in_flight: false,
            // Past the 60s cooldown but inside the 10min re-mint guard.
            last_attempt: Some(now - Duration::from_secs(120)),
            last_minted_key: Some("key-new".into()),
            last_clock_sync: None,
        };
        assert_eq!(
            decide_heal(
                &record,
                now,
                Some("key-new"),
                Some("key-new"),
                Some("unknown_key")
            ),
            HealDecision::Proceed
        );
        // …while a cause-less 401 on the same state keeps the guard.
        assert_eq!(
            decide_heal(&record, now, Some("key-new"), Some("key-new"), None),
            HealDecision::Skip("freshly minted key still rejected — not credential-shaped")
        );
    }

    #[test]
    fn unrecognized_causes_fall_back_to_cause_less_heuristics() {
        // Future cause values must not break old desktops: treat them
        // exactly like a cause-less server (guard + cooldown apply).
        let now = Instant::now();
        let record = HealRecord {
            in_flight: false,
            last_attempt: Some(now - Duration::from_secs(120)),
            last_minted_key: Some("key-new".into()),
            last_clock_sync: None,
        };
        assert_eq!(
            decide_heal(
                &record,
                now,
                Some("key-new"),
                Some("key-new"),
                Some("some_future_cause")
            ),
            HealDecision::Skip("freshly minted key still rejected — not credential-shaped")
        );
    }

    #[test]
    fn clock_skew_still_defers_to_an_in_flight_heal() {
        let record = HealRecord {
            in_flight: true,
            ..Default::default()
        };
        assert_eq!(
            decide_heal(
                &record,
                Instant::now(),
                Some("k"),
                Some("k"),
                Some("clock_skew")
            ),
            HealDecision::Skip("heal already in flight")
        );
    }
}
