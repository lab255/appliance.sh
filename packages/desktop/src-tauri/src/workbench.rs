//! Project-local Workbench preferences and host-side opened-directory references.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;
static IO: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum WorkbenchError {
    UnreadableFile { path: String, reason: String },
    Operation { message: String },
}
impl From<String> for WorkbenchError {
    fn from(message: String) -> Self {
        Self::Operation { message }
    }
}
impl From<&str> for WorkbenchError {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}
fn unreadable(path: &Path, reason: impl ToString) -> WorkbenchError {
    WorkbenchError::UnreadableFile {
        path: path.to_string_lossy().into_owned(),
        reason: reason.to_string(),
    }
}
fn read_file<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, WorkbenchError> {
    let bytes = fs::read(path).map_err(|e| unreadable(path, e))?;
    serde_json::from_slice(&bytes).map_err(|e| unreadable(path, e))
}
fn directories(path: &Path) -> Result<Vec<String>, WorkbenchError> {
    if path.exists() {
        read_file(path)
    } else {
        Ok(vec![])
    }
}
fn forget_directory(path: &Path, directory: &str) -> Result<(), WorkbenchError> {
    let mut entries = directories(path)?;
    entries.retain(|entry| entry != directory);
    atomic(path, &entries)?;
    Ok(())
}
/// Removes only an opened-directory reference, never project files.
pub fn forget(app: &tauri::AppHandle, directory: &str) -> Result<(), WorkbenchError> {
    let _lock = IO.lock().map_err(|e| e.to_string())?;
    forget_directory(&index(app)?, directory)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    selected_target: Option<Target>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mutating_session_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Target {
    kind: String,
    r#ref: String,
}
fn validate(binding: &Binding) -> Result<(), String> {
    if binding.version != 1 {
        return Err("Unsupported Workbench format version".into());
    }
    if let Some(t) = &binding.selected_target {
        if !["local", "cloud"].contains(&t.kind.as_str()) || t.r#ref.is_empty() {
            return Err("Invalid deployment target".into());
        }
    }
    Ok(())
}
pub fn resolve(directory: &str) -> Result<PathBuf, String> {
    let start = fs::canonicalize(directory).map_err(|e| e.to_string())?;
    if !start.is_dir() {
        return Err("Choose a directory".into());
    }
    let mut current = start.clone();
    loop {
        if ["link.json", "workbench.json"]
            .iter()
            .any(|f| current.join(".appliance").join(f).exists())
        {
            return Ok(current);
        }
        if !current.pop() {
            return Ok(start);
        }
    }
}
fn json(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}
fn atomic(path: &Path, value: &impl Serialize) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("Missing parent directory")?)
        .map_err(|e| e.to_string())?;
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(&temporary, path).map_err(|e| e.to_string())
}
fn index(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("workbench-directories.json"))
}
fn remember(app: &tauri::AppHandle, directory: &str) -> Result<bool, WorkbenchError> {
    let path = index(app)?;
    let mut directories = directories(&path)?;
    if !directories.iter().any(|d| d == directory) {
        directories.push(directory.to_owned());
        atomic(&path, &directories)?;
        return Ok(true);
    }
    Ok(false)
}
pub fn read(directory: &str) -> Result<serde_json::Value, WorkbenchError> {
    let root = resolve(directory)?;
    let file = root.join(".appliance/workbench.json");
    let binding: Binding = if file.exists() {
        read_file(&file)?
    } else {
        Binding {
            version: 1,
            label: None,
            selected_target: None,
            mutating_session_id: None,
        }
    };
    validate(&binding).map_err(|e| unreadable(&file, e))?;
    let link = json(&root.join(".appliance/link.json")).unwrap_or_default();
    let machine = link
        .pointer("/sandbox/vm")
        .and_then(|v| v.as_str())
        .unwrap_or("appliance");
    let registry = json(&root.join(".appliance/agents.json")).unwrap_or_default();
    let sessions = registry
        .get("agents")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mount = super::vm_dev_mount(machine).map(|m| {
        fs::canonicalize(&m)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(m)
    });
    let affected = mount
        .as_ref()
        .and_then(|m| json(&Path::new(m).join(".appliance/agents.json")))
        .and_then(|v| v.get("agents").and_then(|a| a.as_array()).cloned())
        .unwrap_or_default();
    Ok(
        serde_json::json!({ "directory": root.to_string_lossy(), "binding": binding, "machine": machine, "mount": mount, "sessions": sessions, "affectedSessions": affected }),
    )
}
// W3 integration seam: replace body with inspection::capture(app, directory).
// Capture owns durable attempt/failure state; never retry silently on read.
fn capture_workbench_baseline(_app: &tauri::AppHandle, _directory: &str) -> Result<(), String> {
    Err("No baseline captured — change comparison will be unavailable".into())
}
pub fn open(app: &tauri::AppHandle, directory: &str) -> Result<serde_json::Value, WorkbenchError> {
    let _lock = IO.lock().map_err(|e| e.to_string())?;
    let mut workspace = read(directory)?;
    let resolved = workspace["directory"]
        .as_str()
        .ok_or("Missing directory")?
        .to_owned();
    if remember(app, &resolved)? {
        if let Err(error) = capture_workbench_baseline(app, &resolved) {
            workspace["baselineWarning"] = error.into();
        }
    }
    Ok(workspace)
}
pub fn list(app: &tauri::AppHandle) -> Result<Vec<serde_json::Value>, WorkbenchError> {
    let path = index(app)?;
    let directories = directories(&path)?;
    Ok(directories.iter().map(|d| read(d).unwrap_or_else(|e| serde_json::json!({"directory":d,"binding":{"version":1},"sessions":[],"error":e}))).collect())
}
fn create_directory(parent: &str, name: &str) -> Result<PathBuf, String> {
    if name.trim().is_empty()
        || name != name.trim()
        || [".", ".."].contains(&name)
        || name.contains(['/', '\\', '\0', ':'])
    {
        return Err("Enter a single folder name".into());
    }
    if !Path::new(parent).is_absolute() {
        return Err("Choose an absolute parent directory".into());
    }
    let parent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
    let mut ancestor = Some(parent.as_path());
    while let Some(folder) = ancestor {
        if ["link.json", "workbench.json"]
            .iter()
            .any(|f| folder.join(".appliance").join(f).exists())
        {
            return Err("Choose a parent outside an existing project so the new workspace has its own directory identity".into());
        }
        ancestor = folder.parent();
    }
    let directory = parent.join(name);
    fs::create_dir(&directory).map_err(|e| format!("Could not create folder: {e}"))?;
    Ok(directory)
}
pub fn create(
    app: &tauri::AppHandle,
    parent: &str,
    name: &str,
) -> Result<serde_json::Value, WorkbenchError> {
    let directory = create_directory(parent, name)?;
    // Blank creation writes no project metadata and never launches/remounts a VM.
    // Parent project roots are rejected to preserve link walk-up identity.
    let _lock = IO.lock().map_err(|e| e.to_string())?;
    let directory = directory.to_string_lossy().to_string();
    if let Err(error) = remember(app, &directory) {
        // Remove only our still-empty new folder; never recurse over user files.
        let _ = fs::remove_dir(&directory);
        return Err(error);
    }
    let mut workspace = read(&directory)?;
    if let Err(error) = capture_workbench_baseline(app, &directory) {
        workspace["baselineWarning"] = error.into();
    }
    Ok(workspace)
}
pub fn update(directory: &str, binding: Binding) -> Result<serde_json::Value, WorkbenchError> {
    let _lock = IO.lock().map_err(|e| e.to_string())?;
    validate(&binding)?;
    let root = resolve(directory)?;
    // Refuse to overwrite a malformed or future-version binding.
    read(directory)?;
    atomic(&root.join(".appliance/workbench.json"), &binding)?;
    read(directory)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn corrupt_files_report_path_and_forgetting_preserves_project() {
        let root =
            std::env::temp_dir().join(format!("workbench-errors-test-{}", std::process::id()));
        fs::create_dir_all(root.join(".appliance")).unwrap();
        let file = root.join(".appliance/workbench.json");
        fs::write(&file, "{").unwrap();
        let canonical = fs::canonicalize(&root)
            .unwrap()
            .join(".appliance/workbench.json");
        let error = serde_json::to_value(read(root.to_str().unwrap()).unwrap_err()).unwrap();
        assert_eq!(error["kind"], "unreadable-file");
        assert_eq!(error["path"], canonical.to_string_lossy().as_ref());
        assert!(error["reason"].as_str().unwrap().contains("EOF"));
        let index = root.join("workbench-directories.json");
        fs::write(&index, "{").unwrap();
        let error = serde_json::to_value(directories(&index).unwrap_err()).unwrap();
        assert_eq!(error["path"], index.to_string_lossy().as_ref());
        assert!(forget_directory(&index, "missing").is_err());
        assert_eq!(fs::read_to_string(&index).unwrap(), "{");
        atomic(&index, &vec!["missing", "keep"]).unwrap();
        forget_directory(&index, "missing").unwrap();
        assert_eq!(directories(&index).unwrap(), vec!["keep"]);
        assert_eq!(fs::read_to_string(file).unwrap(), "{");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn blank_creation_is_exclusive_and_directory_only() {
        let root =
            std::env::temp_dir().join(format!("workbench-create-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let directory = create_directory(root.to_str().unwrap(), "new").unwrap();
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 0);
        fs::write(directory.join("keep.txt"), "keep").unwrap();
        assert!(create_directory(root.to_str().unwrap(), "new").is_err());
        assert!(create_directory(root.to_str().unwrap(), "../escape").is_err());
        assert!(create_directory("relative", "new").is_err());
        assert_eq!(
            fs::read_to_string(directory.join("keep.txt")).unwrap(),
            "keep"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn canonical_root_and_binding_validation() {
        let root = std::env::temp_dir().join(format!("workbench-test-{}", std::process::id()));
        fs::create_dir_all(root.join(".appliance")).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join(".appliance/link.json"), "{}").unwrap();
        assert_eq!(
            resolve(root.join("src").to_str().unwrap()).unwrap(),
            fs::canonicalize(&root).unwrap()
        );
        assert!(serde_json::from_str::<Binding>(r#"{"version":1,"apiKey":"secret"}"#).is_err());
        assert!(validate(&serde_json::from_str::<Binding>(r#"{"version":2}"#).unwrap()).is_err());
        let binding = serde_json::from_str::<Binding>(
            r#"{"version":1,"selectedTarget":{"kind":"cloud","ref":"one"}}"#,
        )
        .unwrap();
        update(root.to_str().unwrap(), binding).unwrap();
        assert_eq!(
            fs::read_to_string(root.join(".appliance/link.json")).unwrap(),
            "{}"
        );
        assert_eq!(
            read(root.join("src").to_str().unwrap()).unwrap()["binding"]["selectedTarget"]["ref"],
            "one"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
