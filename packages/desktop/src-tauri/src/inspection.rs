//! Read-only workspace inspection. No rebaseline, restore, or workspace-write command.
use cap_std::{ambient_authority, fs::Dir};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Manager};

const CONTENT_LIMIT: usize = 1024 * 1024;
const TREE_LIMIT: usize = 128 * 1024 * 1024;
const PREVIEW_LIMIT: usize = 64 * 1024;
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct File {
    bytes: Vec<u8>,
    size: u64,
    digest: String,
    mode: u32,
    binary: bool,
    issue: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    snapshot_id: String,
    directory: String,
    captured_at: String,
    files: BTreeMap<String, File>,
    initial_git_status: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    path: String,
    size: u64,
    state: String,
    generated: bool,
    issue: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    snapshot_id: String,
    directory: String,
    captured_at: Option<String>,
    refreshed_at: String,
    comparison_error: Option<String>,
    initial_git_status: Option<String>,
    entries: Vec<Entry>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    path: String,
    text: Option<String>,
    diff: Option<String>,
    notice: Option<String>,
    size: u64,
    needs_load: bool,
}
static CURRENT: OnceLock<Mutex<BTreeMap<String, Snapshot>>> = OnceLock::new();
static CAPTURE_LOCK: Mutex<()> = Mutex::new(());
fn current() -> &'static Mutex<BTreeMap<String, Snapshot>> {
    CURRENT.get_or_init(Default::default)
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn disjoint(store: &Path, root: &Path) -> Result<(), String> {
    if store.starts_with(root) || root.starts_with(store) {
        return Err(format!("Cannot mount {}: it overlaps the desktop app-data directory ({}), where change baselines are stored and which the agent must not see. Choose a narrower project folder outside app data.", root.display(), store.display()));
    }
    Ok(())
}
/// Mount protection is independent of baseline availability: never share desktop
/// app data into a VM, even when no workspace inspection has been opened yet.
pub fn validate_mount(app: &AppHandle, directory: &str) -> Result<(), String> {
    disjoint(
        &resolved_future_path(&app.path().app_data_dir().map_err(err)?)?,
        &fs::canonicalize(directory)
            .map_err(|error| format!("Cannot mount {directory}: {error}"))?,
    )
}
fn resolved_future_path(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return fs::canonicalize(path).map_err(err);
    }
    let parent = path.parent().ok_or("App data has no existing ancestor")?;
    Ok(resolved_future_path(parent)?.join(path.file_name().ok_or("App data has no name")?))
}
fn location(app: &AppHandle, directory: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = fs::canonicalize(directory).map_err(err)?;
    let data = resolved_future_path(&app.path().app_data_dir().map_err(err)?)?;
    // TRUST BOUNDARY: "The agent cannot rewrite the baseline; a human comparing
    // changes against it sees host-side truth." The VM receives only its project
    // mount, never this desktop app-data store or an IPC capability to it. Reject
    // ancestor mounts as well as direct overlap, before writing any baseline bytes.
    // On a remote host the user does not control, this guarantee weakens: that
    // host's operator can alter app data. This is not protection from hostile hosts.
    // Out-of-band host CLI remounts remain host-operator authority. Overlapping
    // mounts are rejected at mount time; inspection fails closed only while an
    // overlapping devMount is recorded. Baselines exposed during such a window
    // cannot be trusted afterwards; this is not detected. A baseline written
    // while an overlapping mount was active is trusted after it narrows — see
    // follow-up card: keychain-HMAC baseline authentication.
    // A future mount/API change MUST preserve this separation for every VM.
    disjoint(&data, &root)?;
    if let Some(home) = crate::home_dir() {
        let vm_dir = home.join(crate::SHARED_PROFILES_DIR).join("vm");
        if vm_dir.exists() {
            for entry in fs::read_dir(vm_dir).map_err(err)? {
                let spec = entry.map_err(err)?.path().join("vm.json");
                if !spec.exists() {
                    continue;
                }
                let value: serde_json::Value =
                    serde_json::from_slice(&fs::read(spec).map_err(err)?).map_err(err)?;
                if let Some(mount) = value.get("devMount").and_then(|v| v.as_str()) {
                    disjoint(&data, &fs::canonicalize(mount).map_err(err)?)?;
                }
            }
        }
    }
    fs::create_dir_all(&data).map_err(err)?;
    let data = fs::canonicalize(data).map_err(err)?;
    disjoint(&data, &root)?;
    let store = data.join("workbench-inspection-v1");
    fs::create_dir_all(&store).map_err(err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&store, fs::Permissions::from_mode(0o700)).map_err(err)?;
    }
    // Collision-free encoding of resolved directory bytes; split long components.
    // Each component is host generated, never a workspace path supplied to the store.
    let key = root
        .to_str()
        .ok_or("Directory is not UTF-8")?
        .as_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let mut path = store;
    for chunk in key.as_bytes().chunks(100) {
        path.push(std::str::from_utf8(chunk).map_err(err)?);
    }
    fs::create_dir_all(&path).map_err(err)?;
    Ok((root, path.join("baseline.json")))
}
fn walk(
    dir: &Dir,
    prefix: &str,
    files: &mut BTreeMap<String, File>,
    total: &mut usize,
    preview_budget: usize,
) -> Result<(), String> {
    if prefix.bytes().filter(|byte| *byte == b'/').count() > 128 {
        return Err(format!("Comparison unavailable: directory {prefix} exceeds depth 128. Inspect a narrower project folder; previous snapshot was not refreshed."));
    }
    for entry in dir.entries().map_err(err)? {
        if files.len() >= 50_000 {
            return Err("Comparison unavailable: scan contains more than 50,000 entries. Inspect a narrower project folder; previous snapshot was not refreshed.".into());
        }
        let entry = entry.map_err(err)?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Non-UTF-8 filename; snapshot unavailable")?;
        let path = format!("{prefix}{name}");
        let meta = dir.symlink_metadata(&name).map_err(err)?;
        if meta.is_symlink() {
            let target = dir.read_link_contents(&name).map_err(err)?;
            let bytes = target
                .to_str()
                .ok_or("Non-UTF-8 symbolic link target; comparison unavailable")?
                .as_bytes()
                .to_vec();
            *total += bytes.len();
            if *total > preview_budget {
                return Err(format!("Comparison unavailable: {} retained previews exceed the {} budget at symbolic link {path}. Inspect a narrower project folder; previous snapshot was not refreshed.", size_label(*total as u64), size_label(preview_budget as u64)));
            }
            files.insert(
                path,
                File {
                    size: bytes.len() as u64,
                    bytes,
                    digest: String::new(),
                    mode: file_mode(&meta),
                    binary: false,
                    issue: Some("Symbolic link — target is not followed".into()),
                },
            );
        } else if meta.is_dir() {
            files.insert(
                format!("{path}/"),
                File {
                    bytes: vec![],
                    size: 0,
                    digest: String::new(),
                    mode: file_mode(&meta),
                    binary: false,
                    issue: Some("Directory — read-only".into()),
                },
            );
            // cap-std resolves relative to an open directory capability: concurrent
            // symlink replacement cannot redirect host reads outside the mounted tree.
            walk(
                &dir.open_dir(&name).map_err(err)?,
                &format!("{path}/"),
                files,
                total,
                preview_budget,
            )?;
        } else if meta.is_file() {
            let file = read_file(dir, &name).unwrap_or_else(|e| File {
                bytes: vec![],
                size: meta.len(),
                digest: String::new(),
                mode: file_mode(&meta),
                binary: false,
                issue: Some(format!("Unreadable file: {e}")),
            });
            *total += file.bytes.len();
            if *total > preview_budget {
                return Err(format!("Comparison unavailable: scan needs more than {} of retained previews (already {} at {path}; this file is {}). Previous snapshot was not refreshed. Inspect a narrower project folder; no files were silently omitted.", size_label(preview_budget as u64), size_label(*total as u64), size_label(file.size)));
            }
            files.insert(path, file);
        } else {
            files.insert(
                path,
                File {
                    bytes: vec![],
                    size: 0,
                    digest: String::new(),
                    mode: file_mode(&meta),
                    binary: false,
                    issue: Some("Unreadable special file — not opened".into()),
                },
            );
        }
    }
    Ok(())
}
fn file_mode(meta: &cap_std::fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt;
        meta.mode()
    }
    #[cfg(not(unix))]
    {
        u32::from(meta.permissions().readonly())
    }
}
fn read_file(dir: &Dir, name: &str) -> Result<File, String> {
    let mut options = cap_std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    let mut input = dir.open_with(name, &options).map_err(err)?;
    if !input.metadata().map_err(err)?.is_file() {
        return Err("Not a regular file".into());
    }
    let mode = file_mode(&input.metadata().map_err(err)?);
    let mut bytes = Vec::new();
    let mut digest = Sha256::new();
    let mut size = 0;
    let mut binary = false;
    let mut buffer = [0; 65536];
    loop {
        let count = input.read(&mut buffer).map_err(err)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
        binary |= buffer[..count].contains(&0);
        size += count as u64;
        let keep = count.min(CONTENT_LIMIT - bytes.len());
        bytes.extend_from_slice(&buffer[..keep]);
        if size > 4 * 1024 * 1024 * 1024 {
            return Err(format!("Read {size} bytes, exceeding the 4 GiB per-file scan limit. Content comparison unavailable; inspect this file with host tools."));
        }
    }
    Ok(File {
        bytes,
        size,
        digest: format!("{:x}", digest.finalize()),
        mode,
        binary,
        issue: None,
    })
}
fn snapshot(root: &Path) -> Result<Snapshot, String> {
    snapshot_with_budget(root, TREE_LIMIT)
}
fn snapshot_with_budget(root: &Path, preview_budget: usize) -> Result<Snapshot, String> {
    let dir = Dir::open_ambient_dir(root, ambient_authority()).map_err(err)?;
    let mut files = BTreeMap::new();
    walk(&dir, "", &mut files, &mut 0, preview_budget)?;
    Ok(Snapshot {
        snapshot_id: uuid::Uuid::new_v4().to_string(),
        directory: root.to_str().ok_or("Directory is not UTF-8")?.into(),
        captured_at: now(),
        files,
        initial_git_status: String::new(),
    })
}
/// Called on first Workbench open/create before that operation returns. Agents-page
/// launches are independent: first capture may include prior agent output. A failed attempt is
/// permanent for this binding: refreshing must NEVER silently move the baseline.
pub fn capture(app: &AppHandle, directory: &str) -> Result<(), String> {
    let _lock = CAPTURE_LOCK.lock().map_err(err)?;
    let (root, path) = location(app, directory)?;
    capture_into(&root, &path)
}
fn capture_into(root: &Path, path: &Path) -> Result<(), String> {
    if path.with_extension("attempt").exists() || path.exists() {
        return load(path).map(|_| ());
    }
    let mut marker = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path.with_extension("attempt"))
        .map_err(err)?;
    marker
        .write_all(b"capture attempted; unavailable")
        .map_err(err)?;
    marker.sync_all().map_err(err)?;
    let result = (|| -> Result<(), String> {
        let mut baseline = snapshot(root)?;
        // Informational initial Git state only, never comparison authority. Do NOT
        // shell out to `git status`: untrusted .git config can define executable clean
        // filters. libgit2 has no registered external filter/hook callbacks here.
        baseline.initial_git_status = initial_git_status(root).unwrap_or_else(|_| "Git status unavailable (including non-Git directories); initial files are captured independently.".into());
        let bytes = serde_json::to_vec(&baseline).map_err(err)?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(err)?;
        output.write_all(&bytes).map_err(err)?;
        output.sync_all().map_err(err)
    })();
    if let Err(message) = &result {
        // Host-side failure metadata is not a replacement baseline. Preserve the
        // actionable cause for later opens even though the capture cannot retry.
        let _ = fs::write(path.with_extension("attempt"), message);
    }
    result
}
fn initial_git_status(root: &Path) -> Result<String, git2::Error> {
    let repo = git2::Repository::open(root)?;
    let mut options = git2::StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .exclude_submodules(true)
        .update_index(false);
    let statuses = repo.statuses(Some(&mut options))?;
    let mut lines = Vec::new();
    for entry in statuses.iter() {
        lines.push(format!(
            "{:?} {}",
            entry.status(),
            entry.path().unwrap_or("[non-UTF-8 path]")
        ));
    }
    Ok(lines.join("\n"))
}
fn load(path: &Path) -> Result<Snapshot, String> {
    let bytes = fs::read(path).map_err(|error| {
        match fs::read_to_string(path.with_extension("attempt")) {
            Ok(reason) => format!("Comparison unavailable: baseline capture failed ({reason})"),
            Err(_) => {
                format!("No baseline captured — change comparison will be unavailable ({error})")
            }
        }
    })?;
    serde_json::from_slice(&bytes).map_err(|_| {
        "Comparison unavailable: stored baseline is invalid; automatic recapture is disabled".into()
    })
}
fn size_label(size: u64) -> String {
    if size >= 1024 * 1024 {
        let mib = format!("{:.2}", size as f64 / (1024.0 * 1024.0));
        format!(
            "{} MiB ({size} bytes)",
            mib.trim_end_matches('0').trim_end_matches('.')
        )
    } else {
        format!("{size} bytes")
    }
}
fn generated(path: &str) -> bool {
    path == ".appliance/agents.json"
        || path.starts_with(".appliance/agent-results/")
        || path.starts_with(".appliance/.agents.")
}
#[tauri::command]
pub async fn inspection_refresh(app: AppHandle, directory: String) -> Result<Inspection, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (root, path) = location(&app, &directory)?;
        refresh_from(&root, &path, TREE_LIMIT)
    })
    .await
    .map_err(err)?
}
fn refresh_from(root: &Path, path: &Path, preview_budget: usize) -> Result<Inspection, String> {
    let baseline = load(path);
    let live = snapshot_with_budget(root, preview_budget)?;
    let mut entries = BTreeMap::new();
    if let Ok(base) = &baseline {
        for (path, old) in &base.files {
            entries.insert(
                path.clone(),
                Entry {
                    path: path.clone(),
                    size: old.size,
                    state: "deleted".into(),
                    generated: generated(path),
                    issue: old.issue.clone(),
                },
            );
        }
    }
    for (path, file) in &live.files {
        let state = match &baseline {
            Err(_) => "unavailable",
            Ok(base) => match base.files.get(path) {
                None => "added",
                Some(old)
                    if file
                        .issue
                        .as_deref()
                        .is_some_and(|issue| issue.starts_with("Unreadable"))
                        || old
                            .issue
                            .as_deref()
                            .is_some_and(|issue| issue.starts_with("Unreadable")) =>
                {
                    "unavailable"
                }
                Some(old) if old == file => "unchanged",
                Some(_) => "modified",
            },
        };
        entries.insert(
            path.clone(),
            Entry {
                path: path.clone(),
                size: file.size,
                state: state.into(),
                generated: generated(path),
                issue: file.issue.clone(),
            },
        );
    }
    let result = Inspection {
        snapshot_id: live.snapshot_id.clone(),
        directory: live.directory.clone(),
        captured_at: baseline.as_ref().ok().map(|b| b.captured_at.clone()),
        refreshed_at: live.captured_at.clone(),
        comparison_error: baseline.as_ref().err().cloned(),
        initial_git_status: baseline.ok().map(|b| b.initial_git_status),
        entries: entries.into_values().collect(),
    };
    current()
        .lock()
        .map_err(err)?
        .insert(live.directory.clone(), live);
    Ok(result)
}
#[tauri::command]
pub async fn inspection_read(
    app: AppHandle,
    directory: String,
    path: String,
    large: bool,
    snapshot_id: String,
) -> Result<Preview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (root, location) = location(&app, &directory)?;
        let key = root.to_str().ok_or("Directory is not UTF-8")?;
        let guard = current().lock().map_err(err)?;
        let live = guard.get(key).ok_or("Refresh files before reading")?;
        if live.snapshot_id != snapshot_id {
            return Err(
                "Snapshot changed in another reader; refresh inspection before reading".into(),
            );
        }
        let base = load(&location).ok();
        preview(base.as_ref(), live, path, large)
    })
    .await
    .map_err(err)?
}

fn preview(
    base: Option<&Snapshot>,
    live: &Snapshot,
    path: String,
    large: bool,
) -> Result<Preview, String> {
    let old = base.as_ref().and_then(|b| b.files.get(&path));
    let new = live.files.get(&path);
    let file = new.or(old).ok_or("File unavailable in this snapshot")?;
    let mode_notice = old
        .zip(new)
        .filter(|(old, new)| old.mode != new.mode)
        .map(|(old, new)| format!("File mode changed: {:o} → {:o}", old.mode, new.mode));
    let size = file.size.max(old.map_or(0, |f| f.size));
    let mut preview = Preview {
        path,
        text: None,
        diff: None,
        notice: None,
        size,
        needs_load: false,
    };
    if let Some(issue) = &file.issue {
        preview.notice = Some(issue.clone());
        if issue.starts_with("Symbolic link") {
            let before = old
                .map(|f| String::from_utf8_lossy(&f.bytes).into_owned())
                .unwrap_or_default();
            let after = new
                .map(|f| String::from_utf8_lossy(&f.bytes).into_owned())
                .unwrap_or_default();
            preview.text = Some(after.clone());
            if base.is_some() {
                preview.diff = Some(
                    similar::TextDiff::from_lines(&before, &after)
                        .unified_diff()
                        .header(
                            &format!("baseline/{}", preview.path),
                            &format!("workspace/{}", preview.path),
                        )
                        .to_string(),
                );
            }
        }
        return Ok(preview);
    }
    if size > PREVIEW_LIMIT as u64 && !large {
        preview.notice = Some(format!("Large file: {} total; 0 bytes shown. Load up to 1 MiB deliberately; the rest will be labelled as omitted.", size_label(size)));
        preview.needs_load = true;
        return Ok(preview);
    }
    let text = |f: Option<&File>| -> Option<String> {
        match f {
            None => Some(String::new()),
            Some(f) if !f.binary && !f.bytes.contains(&0) => match std::str::from_utf8(&f.bytes) {
                Ok(text) => Some(text.to_string()),
                Err(error) if f.size > f.bytes.len() as u64 && error.error_len().is_none() => {
                    Some(String::from_utf8_lossy(&f.bytes[..error.valid_up_to()]).into_owned())
                }
                Err(_) => None,
            },
            _ => None,
        }
    };
    if old
        .and_then(|file| file.issue.as_deref())
        .is_some_and(|issue| issue.starts_with("Unreadable"))
    {
        preview.notice = Some("Comparison unavailable: baseline file was unreadable".into());
        preview.text = text(new);
        return Ok(preview);
    }
    let before = text(old);
    let after = text(new);
    if before.is_none() || after.is_none() {
        preview.notice = Some(format!(
            "Binary file: {} → {} bytes",
            old.map_or(0, |f| f.size),
            new.map_or(0, |f| f.size)
        ));
        return Ok(preview);
    }
    let before = before.unwrap();
    let after = after.unwrap();
    let limit = CONTENT_LIMIT;
    let truncate = |s: &str| {
        let mut end = s.len().min(limit);
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s[..end].to_string()
    };
    preview.text = Some(truncate(&after));
    if base.is_some() {
        // Bounded diff inputs avoid quadratic work on arbitrarily large agent output.
        preview.diff = Some(
            similar::TextDiff::configure()
                .timeout(std::time::Duration::from_millis(500))
                .diff_lines(&truncate(&before), &truncate(&after))
                .unified_diff()
                .context_radius(3)
                .header(
                    &format!("baseline/{}", preview.path),
                    &format!("workspace/{}", preview.path),
                )
                .to_string(),
        );
    }
    preview.notice = if size > limit as u64 {
        Some(format!("Truncated diff inputs: baseline {} of {} shown; current {} of {} shown. Changes beyond these prefixes are detected by full-file hash but omitted from this diff.", size_label(old.map_or(0, |f| f.bytes.len() as u64)), size_label(old.map_or(0, |f| f.size)), size_label(new.map_or(0, |f| f.bytes.len() as u64)), size_label(new.map_or(0, |f| f.size))))
    } else if new.is_none() {
        Some("Deleted file — baseline diff retained".into())
    } else {
        mode_notice
    };
    Ok(preview)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(root.join("workspace")).unwrap();
        fs::create_dir_all(root.join("host-store")).unwrap();
        root
    }
    #[test]
    fn dirty_git_state_is_initial_context_not_a_since_baseline_change() {
        let root = fixture();
        let tree = root.join("workspace");
        let baseline = root.join("host-store/baseline.json");
        let repo = git2::Repository::init(&tree).unwrap();
        fs::write(tree.join("app.txt"), "committed content").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("app.txt")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let git_tree = repo.find_tree(tree_id).unwrap();
        let signature = git2::Signature::now("Inspection test", "inspection@example.com").unwrap();
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            "initial",
            &git_tree,
            &[],
        )
        .unwrap();
        fs::write(tree.join("app.txt"), "dirty at open").unwrap();
        capture_into(&tree, &baseline).unwrap();
        let initial = refresh_from(&tree, &baseline, TREE_LIMIT).unwrap();
        assert!(initial.initial_git_status.unwrap().contains("app.txt"));
        assert_eq!(
            initial
                .entries
                .iter()
                .find(|entry| entry.path == "app.txt")
                .unwrap()
                .state,
            "unchanged"
        );
        fs::write(tree.join("app.txt"), "later agent edit").unwrap();
        let later = refresh_from(&tree, &baseline, TREE_LIMIT).unwrap();
        assert_eq!(
            later
                .entries
                .iter()
                .find(|entry| entry.path == "app.txt")
                .unwrap()
                .state,
            "modified"
        );
        assert_eq!(
            load(&baseline).unwrap().files["app.txt"].bytes,
            b"dirty at open"
        );
        current().lock().unwrap().remove(tree.to_str().unwrap());
        drop(git_tree);
        drop(index);
        drop(repo);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn composed_over_budget_and_oversized_file_never_returns_empty_comparison() {
        let root = fixture();
        let tree = root.join("workspace");
        let baseline = root.join("host-store/baseline.json");
        capture_into(&tree, &baseline).unwrap();
        let previous = refresh_from(&tree, &baseline, CONTENT_LIMIT).unwrap();
        fs::write(tree.join("oversized-a"), vec![b'a'; CONTENT_LIMIT + 64]).unwrap();
        fs::write(tree.join("oversized-b"), vec![b'b'; CONTENT_LIMIT + 64]).unwrap();
        let error = refresh_from(&tree, &baseline, CONTENT_LIMIT)
            .err()
            .expect("must not return an empty successful comparison");
        assert!(error.contains("Comparison unavailable") && error.contains("1048640 bytes"));
        assert!(error.contains("Previous snapshot was not refreshed"));
        assert_eq!(
            current().lock().unwrap()[tree.to_str().unwrap()].snapshot_id,
            previous.snapshot_id
        );
        assert!(load(&baseline).unwrap().files.is_empty());
        current().lock().unwrap().remove(tree.to_str().unwrap());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn previews_distinguish_text_deleted_binary_large_and_missing_baseline() {
        let root = fixture();
        let tree = root.join("workspace");
        fs::write(tree.join("text"), "old\n").unwrap();
        fs::write(tree.join("deleted"), "gone\n").unwrap();
        fs::write(tree.join("binary"), [0, 1, 2]).unwrap();
        let base = snapshot(&tree).unwrap();
        fs::write(tree.join("text"), "new\n").unwrap();
        fs::remove_file(tree.join("deleted")).unwrap();
        fs::write(tree.join("large"), vec![b'a'; CONTENT_LIMIT + 64]).unwrap();
        let live = snapshot(&tree).unwrap();
        let diff = preview(Some(&base), &live, "text".into(), false)
            .unwrap()
            .diff
            .unwrap();
        assert!(diff.contains("-old") && diff.contains("+new"));
        let deleted = preview(Some(&base), &live, "deleted".into(), false).unwrap();
        assert!(deleted.notice.unwrap().contains("Deleted"));
        assert!(deleted.diff.unwrap().contains("-gone"));
        let binary = preview(Some(&base), &live, "binary".into(), false).unwrap();
        assert!(binary.notice.unwrap().contains("Binary"));
        assert!(binary.text.is_none() && binary.diff.is_none());
        assert!(
            preview(Some(&base), &live, "large".into(), false)
                .unwrap()
                .needs_load
        );
        assert!(preview(Some(&base), &live, "large".into(), true)
            .unwrap()
            .notice
            .unwrap()
            .contains("Truncated"));
        let unavailable = preview(None, &live, "text".into(), false).unwrap();
        assert!(unavailable.diff.is_none());
        assert_eq!(unavailable.text.unwrap(), "new\n");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn initial_git_status_does_not_execute_repository_filters() {
        let root = fixture();
        let tree = root.join("workspace");
        let repo = git2::Repository::init(&tree).unwrap();
        let sentinel = root.join("filter-executed");
        repo.config()
            .unwrap()
            .set_str(
                "filter.evil.clean",
                &format!("touch {}", sentinel.display()),
            )
            .unwrap();
        repo.config()
            .unwrap()
            .set_str("core.fsmonitor", &format!("touch {}", sentinel.display()))
            .unwrap();
        fs::write(tree.join(".gitattributes"), "*.txt filter=evil").unwrap();
        fs::write(tree.join("dirty.txt"), "before").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(".gitattributes")).unwrap();
        index.add_path(Path::new("dirty.txt")).unwrap();
        index.write().unwrap();
        // Same length forces Git to evaluate content filters rather than conclude
        // "modified" from size alone. An explicit mtime change defeats stat reuse.
        fs::write(tree.join("dirty.txt"), "after!").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(tree.join("dirty.txt"))
            .unwrap()
            .set_times(
                fs::FileTimes::new()
                    .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(3)),
            )
            .unwrap();
        let status = initial_git_status(&tree);
        assert!(
            !sentinel.exists(),
            "Repository-configured command executed on the host"
        );
        assert!(status.unwrap().contains("dirty.txt"));
        drop(index);
        drop(repo);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn capture_is_write_once_and_corruption_never_recaptures() {
        let root = fixture();
        let tree = root.join("workspace");
        let path = root.join("host-store/baseline.json");
        fs::write(tree.join("dirty.txt"), "initial dirty state").unwrap();
        capture_into(&tree, &path).unwrap();
        fs::write(tree.join("dirty.txt"), "agent rewrite").unwrap();
        capture_into(&tree, &path).unwrap();
        assert_eq!(
            load(&path).unwrap().files["dirty.txt"].bytes,
            b"initial dirty state"
        );
        fs::write(&path, "corrupt").unwrap();
        assert!(capture_into(&tree, &path).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "corrupt");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_attempt_never_promotes_later_agent_files_to_baseline() {
        let root = fixture();
        let path = root.join("host-store/baseline.json");
        assert!(capture_into(&root.join("missing"), &path).is_err());
        assert!(capture_into(&root.join("workspace"), &path).is_err());
        assert!(!path.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn blank_non_git_workspace_is_a_real_empty_snapshot() {
        let root = fixture();
        let path = root.join("host-store/baseline.json");
        capture_into(&root.join("workspace"), &path).unwrap();
        let base = load(&path).unwrap();
        assert!(base.files.is_empty());
        assert!(base.initial_git_status.contains("non-Git"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn large_file_tail_changes_are_detected_beyond_truncated_preview() {
        let root = fixture();
        let tree = root.join("workspace");
        let mut content = vec![b'a'; CONTENT_LIMIT + 64];
        fs::write(tree.join("large.txt"), &content).unwrap();
        let before = snapshot(&tree).unwrap();
        content[CONTENT_LIMIT + 10] = b'b';
        fs::write(tree.join("large.txt"), &content).unwrap();
        let after = snapshot(&tree).unwrap();
        assert_eq!(
            before.files["large.txt"].bytes,
            after.files["large.txt"].bytes
        );
        assert_ne!(
            before.files["large.txt"].digest,
            after.files["large.txt"].digest
        );
        assert_eq!(before.files["large.txt"].size, content.len() as u64);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_ancestor_and_descendant_mounts() {
        assert!(disjoint(Path::new("/home/u/appdata"), Path::new("/home/u")).is_err());
        assert!(disjoint(
            Path::new("/home/u/appdata"),
            Path::new("/home/u/appdata/project")
        )
        .is_err());
        assert!(disjoint(Path::new("/home/u/appdata"), Path::new("/home/u/project")).is_ok());
    }
    #[test]
    fn agent_metadata_is_only_a_filter() {
        assert!(generated(".appliance/agent-results/agent-1.json"));
        assert!(generated(".appliance/agents.json"));
        assert!(!generated(".appliance/link.json"));
        assert!(!generated("src/app.ts"));
    }
    #[cfg(unix)]
    #[test]
    fn baseline_bytes_survive_agent_edits_and_external_symlink_is_not_read() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join(".appliance")).unwrap();
        fs::write(root.join("a.txt"), "dirty initial text").unwrap();
        fs::write(root.join(".git/HEAD"), "initial").unwrap();
        std::os::unix::fs::symlink("/etc/passwd", root.join("outside")).unwrap();
        let base = snapshot(&root).unwrap();
        fs::write(root.join("a.txt"), "agent text").unwrap();
        fs::write(root.join(".git/HEAD"), "forged").unwrap();
        fs::write(root.join(".appliance/agents.json"), "forged").unwrap();
        let live = snapshot(&root).unwrap();
        assert_eq!(base.files["a.txt"].bytes, b"dirty initial text");
        assert_ne!(base.files[".git/HEAD"].bytes, live.files[".git/HEAD"].bytes);
        assert!(base.files["outside"].issue.is_some());
        assert_eq!(base.files["outside"].bytes, b"/etc/passwd");
        fs::remove_dir_all(root).unwrap();
    }
}
