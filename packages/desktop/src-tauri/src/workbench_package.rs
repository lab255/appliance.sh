//! Workbench Package: explicit desktop action; no registry watchers or MCP registration.
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{ipc::Channel, AppHandle, Manager};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

static PACKAGING: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

struct PackageGuard(PathBuf);
impl Drop for PackageGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = PACKAGING.lock() {
            active.retain(|path| path != &self.0);
        }
    }
}

/// Only a host-owned local key is detected. Never consult workspace metadata,
/// agent results, CI variables, catalogue identity, or frontend-supplied key paths.
fn local_signing_key(config: &Path, workspace: &Path) -> Result<Option<PathBuf>, String> {
    let candidate = config.join("workbench").join("developer-ed25519.pem");
    let metadata = match std::fs::symlink_metadata(&candidate) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot inspect local developer signing key: {error}")),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("The local developer signing key must be a regular file, not a symlink.".into());
    }
    let key = candidate.canonicalize().map_err(|e| e.to_string())?;
    if key.starts_with(workspace) {
        return Err("The local developer signing key must be outside the workspace.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let owner = std::fs::metadata(config).map_err(|e| e.to_string())?.uid();
        if metadata.uid() != owner || metadata.mode() & 0o077 != 0 {
            return Err("The local developer signing key must be developer-owned with mode 0600.".into());
        }
    }
    Ok(Some(key))
}

#[tauri::command]
pub async fn workbench_package(
    app: AppHandle,
    directory: String,
    on_event: Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let workspace = PathBuf::from(directory).canonicalize().map_err(|e| e.to_string())?;
    if !workspace.is_dir() {
        return Err("Package requires a readable workspace directory.".into());
    }
    {
        let mut active = PACKAGING.lock().map_err(|e| e.to_string())?;
        if active.contains(&workspace) {
            return Err("This workspace is already packaging.".into());
        }
        active.push(workspace.clone());
    }
    let _guard = PackageGuard(workspace.clone());
    let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let key = local_signing_key(&config, &workspace)?;
    let output_dir = app.path().app_data_dir().map_err(|e| e.to_string())?
        .join("workbench-packages").join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&output_dir).map_err(|e| e.to_string())?;
    let output = output_dir.join("review.appliance.zip");
    let mut args = vec!["builder".to_string(), "package".into(), "--directory".into(),
        workspace.to_string_lossy().into_owned(), "--out".into(), output.to_string_lossy().into_owned(), "--json".into()];
    if let Some(key) = &key {
        args.extend(["--sign".into(), key.to_string_lossy().into_owned()]);
    }
    let command = app.shell().sidecar("appliance").map_err(|e| e.to_string())?
        .args(args).current_dir(&workspace).env("NO_COLOR", "1");
    let (mut events, _child) = command.spawn().map_err(|e| format!("Cannot start bundled packaging CLI: {e}"))?;
    let mut result = None;
    let mut error = None;
    let mut exit_code = None;
    while let Some(event) = events.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                match serde_json::from_str::<serde_json::Value>(line.trim()) {
                    Ok(value) if value["type"] == "result" => result = value.get("result").cloned(),
                    Ok(value) if value["type"] == "error" => error = value["error"].as_str().map(str::to_owned),
                    Ok(value) if value["type"] == "stage" || value["type"] == "log" => { let _ = on_event.send(value); }
                    _ => { let _ = on_event.send(serde_json::json!({"type":"log", "message":line.trim()})); }
                }
            }
            CommandEvent::Stderr(bytes) => {
                let _ = on_event.send(serde_json::json!({"type":"log", "message":String::from_utf8_lossy(&bytes).trim()}));
            }
            CommandEvent::Error(message) => error = Some(message),
            CommandEvent::Terminated(payload) => exit_code = payload.code,
            _ => {}
        }
    }
    if error.is_some() || exit_code != Some(0) {
        let _ = std::fs::remove_dir_all(&output_dir);
        return Err(error.unwrap_or_else(|| format!("Packaging CLI exited with code {exit_code:?}. See operation logs.")));
    }
    let result = result.ok_or("Packaging CLI returned no artifact result.")?;
    if result["outputPath"].as_str() != output.to_str() || !output.is_file() {
        return Err("Packaging CLI did not produce the requested hand-off file.".into());
    }
    let expected = if key.is_some() { "signed" } else { "unsigned" };
    if result["signatureStatus"] != expected {
        return Err("Packaging result does not match the configured developer signing policy.".into());
    }
    Ok(result)
}
