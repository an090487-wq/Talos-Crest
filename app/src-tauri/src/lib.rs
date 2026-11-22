use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use tauri::{Emitter, Manager};
use talos_core::language::{Language, Registry};

mod chronicle;
mod insights;
mod terminal;

static PROJECT_WATCHERS: OnceLock<Mutex<HashMap<String, notify::RecommendedWatcher>>> =
    OnceLock::new();
static FILE_WRITE_LOCK: Mutex<()> = Mutex::new(());
static NEXT_WINDOW_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
struct PendingWindowContexts(Mutex<HashMap<String, WindowContext>>);

#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowContext {
    initial_path: Option<String>,
    workspace_path: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileSnapshot {
    contents: String,
    revision: String,
    binary: bool,
}

#[derive(serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum CheckedWriteOutcome {
    Saved { revision: String },
    Conflict { snapshot: Option<FileSnapshot> },
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileSavedEvent {
    path: String,
    revision: String,
    owner: String,
}

// ---------- files ----------
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

fn file_revision(contents: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(contents)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn read_file_snapshot(path: &Path) -> Result<Option<FileSnapshot>, String> {
    match fs::read(path) {
        Ok(bytes) => {
            let revision = file_revision(&bytes);
            match String::from_utf8(bytes) {
                Ok(contents) if !contents.contains('\0') => Ok(Some(FileSnapshot {
                    contents,
                    revision,
                    binary: false,
                })),
                _ => Ok(Some(FileSnapshot {
                    contents: String::new(),
                    revision,
                    binary: true,
                })),
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}

fn write_file_if_unchanged(
    path: &Path,
    contents: &str,
    expected_revision: Option<&str>,
) -> Result<CheckedWriteOutcome, String> {
    let _guard = FILE_WRITE_LOCK
        .lock()
        .map_err(|error| format!("file write lock failed: {error}"))?;
    let snapshot = read_file_snapshot(path)?;
    if snapshot.as_ref().map(|value| value.revision.as_str()) != expected_revision {
        return Ok(CheckedWriteOutcome::Conflict { snapshot });
    }

    fs::write(path, contents.as_bytes()).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(CheckedWriteOutcome::Saved {
        revision: file_revision(contents.as_bytes()),
    })
}

#[tauri::command]
fn read_file_snapshot_command(path: String) -> Result<Option<FileSnapshot>, String> {
    read_file_snapshot(Path::new(&path))
}

#[tauri::command]
fn write_file_checked(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    path: String,
    contents: String,
    expected_revision: Option<String>,
) -> Result<CheckedWriteOutcome, String> {
    match write_file_if_unchanged(Path::new(&path), &contents, expected_revision.as_deref())? {
        CheckedWriteOutcome::Saved { revision } => {
            if let Err(error) = app.emit(
                "talos://file-saved",
                FileSavedEvent {
                    path,
                    revision: revision.clone(),
                    owner: window.label().to_string(),
                },
            ) {
                eprintln!("file saved, but other windows were not notified: {error}");
            }
            Ok(CheckedWriteOutcome::Saved { revision })
        }
        conflict => Ok(conflict),
    }
}

/// Raw bytes (used by the PDF reader).
#[tauri::command]
fn read_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| format!("{path}: {e}"))
}

/// Binary export for Talos Canvas. Base64 keeps the IPC payload JSON-safe and
/// the explicit overwrite flag prevents an edited export from silently
/// replacing its original image.
#[tauri::command]
fn write_file_bytes(path: String, contents: String, overwrite: bool) -> Result<(), String> {
    let target = Path::new(&path);
    if !overwrite && target.exists() {
        return Err("That file already exists. Choose a new name or confirm an explicit overwrite.".to_string());
    }
    let bytes = STANDARD
        .decode(contents.as_bytes())
        .map_err(|error| format!("Invalid image data: {error}"))?;
    fs::write(target, bytes).map_err(|error| format!("{path}: {error}"))
}

/// File passed on the command line:  talos main.py
#[tauri::command]
fn startup_file() -> Option<String> {
    std::env::args().skip(1).find(|arg| !arg.starts_with('-'))
}

#[tauri::command]
fn create_window(
    app: tauri::AppHandle,
    contexts: tauri::State<'_, PendingWindowContexts>,
    initial_path: Option<String>,
    workspace_path: Option<String>,
) -> Result<String, String> {
    for _ in 0..100 {
        let sequence = NEXT_WINDOW_ID.fetch_add(1, Ordering::Relaxed);
        let label = format!("talos-{}-{sequence}", std::process::id());
        if app.get_webview_window(&label).is_some() {
            continue;
        }

        contexts
            .0
            .lock()
            .map_err(|error| format!("window context lock failed: {error}"))?
            .insert(
                label.clone(),
                WindowContext {
                    initial_path: initial_path.clone(),
                    workspace_path: workspace_path.clone(),
                },
            );
        let result = tauri::WebviewWindowBuilder::new(
            &app,
            &label,
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("Talos Crest")
        .inner_size(1100.0, 720.0)
        .center()
        .build();
        if let Err(error) = result {
            contexts
                .0
                .lock()
                .map_err(|lock_error| format!("window context lock failed: {lock_error}"))?
                .remove(&label);
            return Err(format!("could not create Talos window: {error}"));
        }
        return Ok(label);
    }
    Err("could not allocate a unique Talos window identifier".into())
}

#[tauri::command]
fn take_window_context(
    window: tauri::WebviewWindow,
    contexts: tauri::State<'_, PendingWindowContexts>,
) -> Result<WindowContext, String> {
    Ok(contexts
        .0
        .lock()
        .map_err(|error| format!("window context lock failed: {error}"))?
        .remove(window.label())
        .unwrap_or_default())
}

#[tauri::command]
fn is_android() -> bool {
    cfg!(target_os = "android")
}

// ---------- config + extensions ----------
fn config_dir() -> PathBuf {
    if let Ok(x) = std::env::var("XDG_CONFIG_HOME") {
        if !x.is_empty() {
            return PathBuf::from(x).join("talos");
        }
    }
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".config/talos")
}

fn ext_dir() -> PathBuf {
    config_dir().join("extensions")
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('.')
        && id.chars().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.' || c == '_'
        })
}

#[derive(Debug, PartialEq, Eq)]
struct SemVersion {
    major: u64,
    minor: u64,
    patch: u64,
    prerelease: Vec<String>,
}

fn parse_semver(version: &str) -> Option<SemVersion> {
    let (version, build) = match version.split_once('+') {
        Some((version, build)) if !build.is_empty() && !build.contains('+') => {
            (version, Some(build))
        }
        Some(_) => return None,
        None => (version, None),
    };
    if build.is_some_and(|build| {
        build.split('.').any(|part| {
            part.is_empty()
                || !part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    }) {
        return None;
    }

    let (core, prerelease) = match version.split_once('-') {
        Some((core, prerelease)) if !prerelease.is_empty() => (core, Some(prerelease)),
        Some(_) => return None,
        None => (version, None),
    };
    let numeric = |part: &str| {
        !part.is_empty()
            && (part == "0" || !part.starts_with('0'))
            && part.bytes().all(|byte| byte.is_ascii_digit())
    };
    let core: Vec<_> = core.split('.').collect();
    if core.len() != 3 || !core.iter().all(|part| numeric(part)) {
        return None;
    }
    let prerelease: Vec<String> = match prerelease {
        Some(parts) => {
            let parts: Vec<_> = parts.split('.').collect();
            if parts.iter().any(|part| {
                part.is_empty()
                    || !part
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                    || (part.bytes().all(|byte| byte.is_ascii_digit())
                        && part.len() > 1
                        && part.starts_with('0'))
            }) {
                return None;
            }
            parts.into_iter().map(str::to_string).collect()
        }
        None => Vec::new(),
    };
    Some(SemVersion {
        major: core[0].parse().ok()?,
        minor: core[1].parse().ok()?,
        patch: core[2].parse().ok()?,
        prerelease,
    })
}

fn valid_semver(version: &str) -> bool {
    parse_semver(version).is_some()
}

fn extension_state_path() -> PathBuf {
    config_dir().join("extension-state.json")
}

fn read_extension_state() -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let path = extension_state_path();
    if !path.exists() {
        return Ok(serde_json::Map::new());
    }
    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("could not read extension state {}: {error}", path.display()))?;
    serde_json::from_str(&contents)
        .map_err(|error| format!("invalid extension state {}: {error}", path.display()))
}

fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);
    let temp_path = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&temp_path, contents).map_err(|error| {
        format!("could not write temporary file {}: {error}", temp_path.display())
    })?;
    if let Err(error) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(format!("could not install {}: {error}", path.display()));
    }
    Ok(())
}

fn read_optional_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("could not read {}: {error}", path.display())),
    }
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("could not remove {}: {error}", path.display())),
    }
}

fn extension_permission_requirements(manifest: &serde_json::Value) -> Vec<String> {
    let mut permissions: Vec<String> = manifest
        .get("permissions")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::to_string)
        .collect();
    let can_run = manifest
        .get("language")
        .and_then(|language| language.get("run"))
        .is_some_and(|command| !command.is_null() && command.as_str().is_some_and(|s| !s.is_empty()));
    if can_run {
        permissions.push("process.execution".into());
    }
    permissions.sort();
    permissions.dedup();
    permissions
}

fn validate_extension_manifest(
    manifest: &serde_json::Value,
    expected_id: &str,
    expected_version: &str,
) -> Result<(String, Vec<String>), String> {
    let id = manifest
        .get("id")
        .and_then(serde_json::Value::as_str)
        .ok_or("extension has no id")?;
    if !valid_id(id) || id != expected_id {
        return Err(format!("invalid or unexpected extension id '{id}'"));
    }
    let name = manifest
        .get("name")
        .and_then(serde_json::Value::as_str)
        .ok_or("extension has no name")?;
    if name.trim().is_empty() || name.len() > 160 {
        return Err("extension name is empty or too long".into());
    }
    let version = manifest
        .get("version")
        .and_then(serde_json::Value::as_str)
        .ok_or("extension has no semantic version")?;
    if !valid_semver(version) || version != expected_version {
        return Err(format!("invalid or unexpected extension version '{version}'"));
    }
    let kind = manifest
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .ok_or("extension has no kind")?;
    if !matches!(kind, "theme" | "language" | "template" | "snippets") {
        return Err(format!("unsupported extension kind '{kind}'"));
    }
    if let Some(permissions) = manifest.get("permissions") {
        let permissions = permissions
            .as_array()
            .ok_or("extension permissions must be an array")?;
        if permissions.iter().any(|permission| {
            permission.as_str() != Some("process.execution")
        }) {
            return Err("extension requests permissions Talos does not support".into());
        }
    }
    match kind {
        "theme" if !manifest.get("theme").is_some_and(serde_json::Value::is_object) => {
            return Err("theme extension needs a 'theme' object".into());
        }
        "language" => {
            let language = manifest
                .get("language")
                .ok_or("language extension needs a 'language' section")?;
            let parsed: Language = serde_json::from_value(language.clone())
                .map_err(|error| format!("invalid language configuration: {error}"))?;
            if !valid_id(&parsed.id)
                || parsed.name.trim().is_empty()
                || parsed.extensions.is_empty()
                || parsed.extensions.iter().any(|extension| {
                    !extension.starts_with('.')
                        || extension.len() < 2
                        || !extension[1..]
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                })
            {
                return Err("language configuration contains invalid id, name, or extensions".into());
            }
            if parsed.run.as_ref().is_some_and(|command| command.trim().is_empty() || command.len() > 4096) {
                return Err("language run command is empty or too long".into());
            }
        }
        "snippets" => {
            let snippets = manifest
                .get("snippets")
                .and_then(serde_json::Value::as_array)
                .ok_or("snippets extension needs a 'snippets' array")?;
            if snippets.is_empty() || snippets.len() > 200 {
                return Err("snippet packs need between 1 and 200 snippets".into());
            }
            for snippet in snippets {
                let prefix = snippet
                    .get("prefix")
                    .and_then(serde_json::Value::as_str)
                    .ok_or("snippet has no prefix")?;
                let body = snippet
                    .get("body")
                    .and_then(serde_json::Value::as_str)
                    .ok_or("snippet has no body")?;
                if prefix.trim().is_empty()
                    || prefix.len() > 64
                    || body.trim().is_empty()
                    || body.len() > 32768
                {
                    return Err("snippet has an invalid prefix or oversized body".into());
                }
                for key in ["label", "description"] {
                    if let Some(value) = snippet.get(key).and_then(serde_json::Value::as_str) {
                        if value.len() > 160 {
                            return Err(format!("snippet {key} is too long"));
                        }
                    }
                }
                if let Some(languages) = snippet.get("languages") {
                    let languages = languages
                        .as_array()
                        .ok_or("snippet languages must be an array")?;
                    if languages.len() > 32
                        || languages.iter().any(|language| {
                            language.as_str().is_none_or(|value| {
                                value.trim().is_empty() || value.len() > 64
                            })
                        })
                    {
                        return Err("snippet contains an invalid language list".into());
                    }
                }
            }
        }
        "template" => {
            let templates = manifest
                .get("templates")
                .and_then(serde_json::Value::as_array)
                .ok_or("template extension needs a 'templates' array")?;
            if templates.is_empty() || templates.len() > 100 {
                return Err("template entries need label, filename, and content".into());
            }
            for template in templates {
                let label = template
                    .get("label")
                    .and_then(serde_json::Value::as_str)
                    .ok_or("template entry has no label")?;
                let filename = template
                    .get("filename")
                    .and_then(serde_json::Value::as_str)
                    .ok_or("template entry has no filename")?;
                let content = template
                    .get("content")
                    .and_then(serde_json::Value::as_str)
                    .ok_or("template entry has no content")?;
                if label.trim().is_empty()
                    || label.len() > 160
                    || filename.is_empty()
                    || filename.len() > 255
                    || filename == "."
                    || filename == ".."
                    || filename.contains(['/', '\\'])
                    || filename.chars().any(char::is_control)
                    || content.len() > 1_048_576
                {
                    return Err("template contains an invalid label, filename, or oversized content".into());
                }
            }
        }
        _ => {}
    }
    Ok((kind.to_string(), extension_permission_requirements(manifest)))
}

#[tauri::command]
fn settings_read() -> Option<String> {
    fs::read_to_string(config_dir().join("settings.json")).ok()
}

#[tauri::command]
fn settings_write(contents: String) -> Result<(), String> {
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("settings.json"), contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn default_registry(app: tauri::AppHandle) -> Result<String, String> {
    let resources = app
        .path()
        .resource_dir()
        .map_err(|e| format!("could not locate app resources: {e}"))?;

    #[cfg(target_os = "android")]
    {
        return Ok(resources
            .join("registry/index.json")
            .to_string_lossy()
            .into_owned());
    }

    #[cfg(not(target_os = "android"))]
    let bundled = resources.join("registry/index.json");
    #[cfg(not(target_os = "android"))]
    if bundled.is_file() {
        return Ok(bundled.to_string_lossy().into_owned());
    }

    #[cfg(not(target_os = "android"))]
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../registry/index.json")
        .canonicalize()
        .map_err(|e| format!("could not locate bundled or development registry: {e}"))?;
    #[cfg(not(target_os = "android"))]
    Ok(development.to_string_lossy().into_owned())
}

#[derive(serde::Serialize)]
struct ProjectEntry {
    path: String,
    parent: String,
    name: String,
    kind: String,
    extension: String,
    size: u64,
    modified_ms: Option<u64>,
    depth: usize,
    child_count: usize,
    file_count: usize,
}

#[derive(serde::Serialize)]
struct ProjectScan {
    root: String,
    entries: Vec<ProjectEntry>,
    warnings: Vec<String>,
    truncated: bool,
}

#[derive(serde::Serialize)]
struct ProjectSource {
    path: String,
    extension: String,
    content: String,
}

#[derive(serde::Serialize)]
struct ProjectSources {
    sources: Vec<ProjectSource>,
    warnings: Vec<String>,
}

fn scan_project_tree(root: &str, exclusions: &[String]) -> Result<ProjectScan, String> {
    const MAX_ENTRIES: usize = 50_000;
    const MAX_DEPTH: usize = 64;

    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|e| format!("could not open project directory '{root}': {e}"))?;
    if !root.is_dir() {
        return Err(format!("project root is not a directory: {}", root.display()));
    }

    let root_path = root.to_string_lossy().into_owned();
    let root_meta = fs::symlink_metadata(&root).map_err(|e| e.to_string())?;
    let mut entries = vec![ProjectEntry {
        path: root_path.clone(),
        parent: String::new(),
        name: root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Project")
            .to_string(),
        kind: "directory".into(),
        extension: String::new(),
        size: 0,
        modified_ms: root_meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64),
        depth: 0,
        child_count: 0,
        file_count: 0,
    }];
    let excluded: std::collections::HashSet<&str> =
        exclusions.iter().map(String::as_str).collect();
    let mut stack = vec![(root.clone(), 0usize)];
    let mut warnings = Vec::new();
    let mut child_counts: HashMap<String, usize> = HashMap::new();
    let mut file_counts: HashMap<String, usize> = HashMap::new();
    let mut truncated = false;

    while let Some((directory, depth)) = stack.pop() {
        if depth >= MAX_DEPTH {
            warnings.push(format!(
                "Maximum directory depth ({MAX_DEPTH}) reached at {}",
                directory.display()
            ));
            continue;
        }

        let children = match fs::read_dir(&directory) {
            Ok(children) => children,
            Err(error) => {
                warnings.push(format!("Could not read {}: {error}", directory.display()));
                continue;
            }
        };
        let mut directories = Vec::new();
        for child in children {
            let child = match child {
                Ok(child) => child,
                Err(error) => {
                    warnings.push(format!(
                        "Could not read an entry in {}: {error}",
                        directory.display()
                    ));
                    continue;
                }
            };
            let path = child.path();
            let name = child.file_name().to_string_lossy().into_owned();
            if excluded.contains(name.as_str()) {
                continue;
            }
            if entries.len() >= MAX_ENTRIES {
                truncated = true;
                break;
            }
            let file_type = match child.file_type() {
                Ok(file_type) => file_type,
                Err(error) => {
                    warnings.push(format!("Could not inspect {}: {error}", path.display()));
                    continue;
                }
            };
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) => {
                    warnings.push(format!("Could not inspect {}: {error}", path.display()));
                    continue;
                }
            };
            let kind = if file_type.is_symlink() {
                "link"
            } else if file_type.is_dir() {
                "directory"
            } else {
                "file"
            };
            let path_text = path.to_string_lossy().into_owned();
            let parent_text = directory.to_string_lossy().into_owned();
            let extension = if kind == "file" {
                path.extension()
                    .and_then(|extension| extension.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase()
            } else {
                String::new()
            };
            entries.push(ProjectEntry {
                path: path_text.clone(),
                parent: parent_text.clone(),
                name,
                kind: kind.into(),
                extension,
                size: metadata.len(),
                modified_ms: metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64),
                depth: depth + 1,
                child_count: 0,
                file_count: 0,
            });
            *child_counts.entry(parent_text.clone()).or_default() += 1;
            if kind == "file" {
                let mut ancestor = Some(directory.as_path());
                while let Some(path) = ancestor {
                    *file_counts
                        .entry(path.to_string_lossy().into_owned())
                        .or_default() += 1;
                    if path == root {
                        break;
                    }
                    ancestor = path.parent();
                }
            } else if kind == "directory" {
                directories.push(path);
            }
        }
        stack.extend(directories.into_iter().map(|path| (path, depth + 1)));
        if truncated {
            break;
        }
    }

    for entry in &mut entries {
        entry.child_count = child_counts.get(&entry.path).copied().unwrap_or_default();
        entry.file_count = file_counts.get(&entry.path).copied().unwrap_or_default();
    }
    entries.sort_by(|a, b| {
        a.parent
            .cmp(&b.parent)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(ProjectScan {
        root: root_path,
        entries,
        warnings,
        truncated,
    })
}

#[tauri::command]
async fn scan_project(root: String, exclusions: Vec<String>) -> Result<ProjectScan, String> {
    tauri::async_runtime::spawn_blocking(move || scan_project_tree(&root, &exclusions))
        .await
        .map_err(|error| format!("project scan task failed: {error}"))?
}

fn canonical_project_root(root: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|error| format!("could not open project directory '{root}': {error}"))?;
    if !root.is_dir() {
        return Err(format!(
            "project root is not a directory: {}",
            root.display()
        ));
    }
    Ok(root)
}

fn project_entry_path(root: &Path, relative: &str, must_exist: bool) -> Result<PathBuf, String> {
    let relative_path = Path::new(relative);
    if relative.is_empty()
        || relative.contains('\\')
        || relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || relative
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("project paths must be non-empty relative paths without traversal".into());
    }

    let candidate = root.join(relative);
    let parent = candidate
        .parent()
        .ok_or("project path has no parent directory")?
        .canonicalize()
        .map_err(|error| format!("could not access parent directory for '{relative}': {error}"))?;
    if !parent.starts_with(root) {
        return Err(format!("project path escapes the workspace: '{relative}'"));
    }

    match fs::symlink_metadata(&candidate) {
        Ok(_) if must_exist => {}
        Ok(_) => return Err(format!("project path already exists: '{relative}'")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !must_exist => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!("project path does not exist: '{relative}'"));
        }
        Err(error) => return Err(format!("could not inspect '{relative}': {error}")),
    }
    Ok(candidate)
}

fn create_project_file_at(root: &str, relative: &str) -> Result<(), String> {
    let root = canonical_project_root(root)?;
    let path = project_entry_path(&root, relative, false)?;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map(|_| ())
        .map_err(|error| format!("could not create {}: {error}", path.display()))
}

fn create_project_folder_at(root: &str, relative: &str) -> Result<(), String> {
    let root = canonical_project_root(root)?;
    let path = project_entry_path(&root, relative, false)?;
    fs::create_dir(&path).map_err(|error| format!("could not create {}: {error}", path.display()))
}

fn rename_project_entry_at(root: &str, from: &str, to: &str) -> Result<(), String> {
    let root = canonical_project_root(root)?;
    let source = project_entry_path(&root, from, true)?;
    let destination = project_entry_path(&root, to, false)?;
    fs::rename(&source, &destination).map_err(|error| {
        format!(
            "could not rename {} to {}: {error}",
            source.display(),
            destination.display()
        )
    })
}

fn delete_project_entry_at(root: &str, relative: &str) -> Result<(), String> {
    let root = canonical_project_root(root)?;
    let path = project_entry_path(&root, relative, true)?;
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("could not inspect {}: {error}", path.display()))?;
    if metadata.file_type().is_dir() {
        fs::remove_dir_all(&path)
    } else {
        fs::remove_file(&path)
    }
    .map_err(|error| format!("could not delete {}: {error}", path.display()))
}

#[tauri::command]
async fn create_project_file(root: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || create_project_file_at(&root, &path))
        .await
        .map_err(|error| format!("file creation task failed: {error}"))?
}

#[tauri::command]
async fn create_project_folder(root: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || create_project_folder_at(&root, &path))
        .await
        .map_err(|error| format!("folder creation task failed: {error}"))?
}

#[tauri::command]
async fn rename_project_entry(root: String, from: String, to: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || rename_project_entry_at(&root, &from, &to))
        .await
        .map_err(|error| format!("rename task failed: {error}"))?
}

#[tauri::command]
async fn delete_project_entry(root: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_project_entry_at(&root, &path))
        .await
        .map_err(|error| format!("deletion task failed: {error}"))?
}

fn read_project_sources(root: &str, paths: &[String]) -> Result<ProjectSources, String> {
    const MAX_FILES: usize = 8_000;
    const MAX_FILE_BYTES: u64 = 256 * 1024;
    const MAX_TOTAL_BYTES: u64 = 16 * 1024 * 1024;
    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|e| format!("could not open project directory '{root}': {e}"))?;
    let supported = ["py", "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"];
    let mut sources = Vec::new();
    let mut warnings = Vec::new();
    let mut bytes_read = 0u64;

    for path in paths {
        if sources.len() >= MAX_FILES || bytes_read >= MAX_TOTAL_BYTES {
            warnings.push(format!(
                "Analysis limited to {MAX_FILES} files and {} MiB of source",
                MAX_TOTAL_BYTES / (1024 * 1024)
            ));
            break;
        }
        let candidate = PathBuf::from(path);
        let canonical = match candidate.canonicalize() {
            Ok(canonical) if canonical.starts_with(&root) => canonical,
            Ok(_) => {
                warnings.push(format!("Skipped file outside the project: {path}"));
                continue;
            }
            Err(error) => {
                warnings.push(format!("Could not open {path}: {error}"));
                continue;
            }
        };
        let metadata = match fs::symlink_metadata(&candidate) {
            Ok(metadata) if metadata.is_file() => metadata,
            Ok(_) => continue,
            Err(error) => {
                warnings.push(format!("Could not inspect {path}: {error}"));
                continue;
            }
        };
        let extension = canonical
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !supported.contains(&extension.as_str()) {
            continue;
        }
        if metadata.len() > MAX_FILE_BYTES || bytes_read.saturating_add(metadata.len()) > MAX_TOTAL_BYTES {
            warnings.push(format!("Skipped oversized source file: {path}"));
            continue;
        }
        let text = match fs::read_to_string(&canonical) {
            Ok(text) => text,
            Err(error) => {
                warnings.push(format!("Could not read {path}: {error}"));
                continue;
            }
        };
        bytes_read += text.len() as u64;
        sources.push(ProjectSource {
            path: canonical.to_string_lossy().into_owned(),
            extension,
            content: text,
        });
    }

    Ok(ProjectSources { sources, warnings })
}

#[tauri::command]
async fn load_project_sources(root: String, paths: Vec<String>) -> Result<ProjectSources, String> {
    tauri::async_runtime::spawn_blocking(move || read_project_sources(&root, &paths))
        .await
        .map_err(|error| format!("source analysis task failed: {error}"))?
}

#[tauri::command]
async fn measure_project_components(
    root: String,
    paths: Vec<String>,
) -> Result<insights::ComponentMeasurement, String> {
    tauri::async_runtime::spawn_blocking(move || insights::measure_components(&root, &paths))
        .await
        .map_err(|error| format!("component measurement task failed: {error}"))?
}

#[tauri::command]
async fn load_project_manifests(
    root: String,
    paths: Vec<String>,
) -> Result<insights::ManifestSet, String> {
    tauri::async_runtime::spawn_blocking(move || insights::load_manifests(&root, &paths))
        .await
        .map_err(|error| format!("manifest analysis task failed: {error}"))?
}

const WATCHED_DIR_LIMIT: usize = 2000;
const WATCH_EMIT_INTERVAL_MS: u64 = 750;

fn is_ignored_watch_path(path: &Path, root: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return path != root;
    };
    relative.components().any(|component| {
        let Component::Normal(name) = component else {
            return false;
        };
        let name = name.to_string_lossy();
        if name.starts_with('.') && name != ".github" {
            return true;
        }
        matches!(
            name.as_ref(),
            "node_modules"
                | "target"
                | "dist"
                | "build"
                | "out"
                | "coverage"
                | "__pycache__"
                | "vendor"
                | "venv"
                | "snap"
                | "Downloads"
                | "Pictures"
                | "Videos"
                | "Music"
        )
    })
}

fn collect_watch_dirs(root: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![root.to_path_buf()];
    let mut index = 0;
    while index < dirs.len() && dirs.len() < WATCHED_DIR_LIMIT {
        let dir = dirs[index].clone();
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if dirs.len() >= WATCHED_DIR_LIMIT {
                    break;
                }
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                if !kind.is_dir() || kind.is_symlink() {
                    continue;
                }
                let path = entry.path();
                if !is_ignored_watch_path(&path, root) {
                    dirs.push(path);
                }
            }
        }
        index += 1;
    }
    dirs
}

#[tauri::command]
fn watch_project(window: tauri::WebviewWindow, root: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let _ = window;
        let _ = root;
        return Ok(());
    }

    #[cfg(not(target_os = "android"))]
    {
        use notify::Watcher;
        let root = PathBuf::from(&root)
            .canonicalize()
            .map_err(|e| format!("could not watch project '{root}': {e}"))?;
        if !root.is_dir() {
            return Err(format!("project root is not a directory: {}", root.display()));
        }
        let project_root = root.to_string_lossy().into_owned();
        let window_label = window.label().to_string();
        let emit_last_emit = Arc::new(AtomicU64::new(0));
        let watch_root = root.clone();
        let watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| match event {
                Ok(event) if matches!(event.kind, notify::EventKind::Access(_)) => {}
                Ok(event) => {
                    if event
                        .paths
                        .iter()
                        .any(|path| is_ignored_watch_path(path, &watch_root))
                    {
                        return;
                    }
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|duration| duration.as_millis() as u64)
                        .unwrap_or(0);
                    let mut previous = emit_last_emit.load(Ordering::Relaxed);
                    loop {
                        if now.saturating_sub(previous) < WATCH_EMIT_INTERVAL_MS {
                            return;
                        }
                        match emit_last_emit.compare_exchange_weak(
                            previous,
                            now,
                            Ordering::Relaxed,
                            Ordering::Relaxed,
                        ) {
                            Ok(_) => break,
                            Err(current) => previous = current,
                        }
                    }
                    if let Err(error) = window.emit("architecture://changed", &project_root) {
                        eprintln!("could not notify Architecture Explorer: {error}");
                    }
                }
                Err(error) => {
                    if let Err(emit_error) =
                        window.emit("architecture://watch-error", error.to_string())
                    {
                        eprintln!(
                            "project watcher failed ({error}); event delivery failed: {emit_error}"
                        );
                    }
                }
            })
            .map_err(|e| format!("could not start project watcher: {e}"))?;
        let mut watcher = watcher;
        let dirs = collect_watch_dirs(&root);
        let mut watched = 0;
        for dir in dirs {
            if watcher
                .watch(&dir, notify::RecursiveMode::NonRecursive)
                .is_ok()
            {
                watched += 1;
            }
        }
        if watched == 0 {
            return Err(format!(
                "could not watch {}: no accessible directories",
                root.display()
            ));
        }
        PROJECT_WATCHERS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(|e| format!("project watcher lock failed: {e}"))?
            .insert(window_label, watcher);
    }
    Ok(())
}

#[tauri::command]
fn stop_project_watch(window: tauri::WebviewWindow) -> Result<(), String> {
    // Recover from a poisoned lock so cleanup can never block window closing.
    let mut watchers = PROJECT_WATCHERS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    watchers.remove(window.label());
    Ok(())
}

/// Absolute last resort for window closing. The renderer calls this from a
/// watchdog only if destroying the webview fails or times out, so no close
/// request can leave the application running forever.
#[tauri::command]
fn force_quit() {
    std::process::exit(0);
}

#[tauri::command]
fn ext_list() -> Result<Vec<serde_json::Value>, String> {
    let mut out = Vec::new();
    let dir = ext_dir();
    let state = read_extension_state()?;
    if dir.exists() {
        let entries = fs::read_dir(&dir)
            .map_err(|error| format!("could not read extensions {}: {error}", dir.display()))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("could not read extension entry: {error}"))?;
            let path = entry.path();
            if !entry
                .file_type()
                .map_err(|error| format!("could not inspect {}: {error}", path.display()))?
                .is_file()
            {
                continue;
            }
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let text = fs::read_to_string(&path)
                .map_err(|error| format!("could not read {}: {error}", path.display()))?;
            let mut manifest: serde_json::Value = serde_json::from_str(&text)
                .map_err(|error| format!("invalid extension {}: {error}", path.display()))?;
            let id = manifest
                .get("id")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| format!("extension {} has no id", path.display()))?
                .to_string();
            if !valid_id(&id) {
                return Err(format!("extension {} has an invalid id", path.display()));
            }
            let required = extension_permission_requirements(&manifest);
            let status = state.get(&id).and_then(serde_json::Value::as_object);
            let granted: Vec<String> = status
                .and_then(|value| value.get("permissions"))
                .and_then(serde_json::Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(serde_json::Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let enabled = status
                .and_then(|value| value.get("enabled"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(required.is_empty() || required.iter().all(|permission| granted.contains(permission)));
            let rollback_manifest = dir
                .join("rollback")
                .join(&id)
                .join("manifest.json");
            let rollback_text = read_optional_bytes(&rollback_manifest)?;
            let rollback_value = rollback_text
                .as_deref()
                .map(serde_json::from_slice::<serde_json::Value>)
                .transpose()
                .map_err(|error| format!("invalid rollback manifest for {id}: {error}"))?;
            let rollback_version = rollback_value
                .as_ref()
                .and_then(|value| value.get("version"))
                .and_then(serde_json::Value::as_str);
            let current_version = manifest
                .get("version")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            let rollback_available = rollback_version.is_some()
                && rollback_version != current_version.as_deref();
            let object = manifest
                .as_object_mut()
                .ok_or_else(|| format!("extension {} manifest must be an object", path.display()))?;
            object.insert("enabled".into(), serde_json::Value::Bool(enabled));
            object.insert(
                "grantedPermissions".into(),
                serde_json::to_value(granted).map_err(|error| error.to_string())?,
            );
            object.insert(
                "rollbackAvailable".into(),
                serde_json::Value::Bool(rollback_available),
            );
            if let Some(version) = rollback_version.filter(|_| rollback_available) {
                object.insert(
                    "rollbackVersion".into(),
                    serde_json::Value::String(version.to_string()),
                );
            }
            out.push(manifest);
        }
    }
    out.sort_by(|left, right| {
        left.get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .cmp(
                right
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default(),
            )
    });
    Ok(out)
}

/// Installs an extension file. The SHA-256 must match, or nothing is written.
#[tauri::command]
fn ext_install(
    text: String,
    sha256: String,
    expected_id: String,
    expected_version: String,
    approved_permissions: Vec<String>,
    dependencies: Vec<String>,
) -> Result<serde_json::Value, String> {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if digest != sha256.trim().to_lowercase() {
        return Err(format!(
            "checksum mismatch (expected {sha256}, got {digest}); nothing was installed"
        ));
    }
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("invalid extension file: {e}"))?;
    let (kind, required_permissions) =
        validate_extension_manifest(&v, &expected_id, &expected_version)?;
    if approved_permissions.iter().any(|permission| permission != "process.execution")
        || required_permissions
            .iter()
            .any(|permission| !approved_permissions.contains(permission))
    {
        return Err("required extension permissions were not explicitly approved".into());
    }
    for dependency in &dependencies {
        if !valid_id(dependency) || dependency == &expected_id {
            return Err(format!("invalid extension dependency '{dependency}'"));
        }
        let dependency_path = ext_dir().join(format!("{dependency}.json"));
        let dependency_text = fs::read_to_string(&dependency_path)
            .map_err(|_| format!("required extension dependency '{dependency}' is not installed"))?;
        let dependency_manifest: serde_json::Value = serde_json::from_str(&dependency_text)
            .map_err(|error| format!("invalid dependency '{dependency}': {error}"))?;
        if dependency_manifest
            .get("version")
            .and_then(serde_json::Value::as_str)
            .is_none_or(|version| !valid_semver(version))
        {
            return Err(format!("dependency '{dependency}' has an invalid installed version"));
        }
    }

    let dir = ext_dir();
    let manifest_path = dir.join(format!("{expected_id}.json"));
    let language_path = dir.join("languages").join(format!("{expected_id}.json"));
    let previous_manifest = read_optional_bytes(&manifest_path)?;
    let previous_language = read_optional_bytes(&language_path)?;
    let mut state = read_extension_state()?;
    if let Some(previous_bytes) = &previous_manifest {
        let previous_value: serde_json::Value = serde_json::from_slice(previous_bytes)
            .map_err(|error| format!("installed extension is invalid and must be removed first: {error}"))?;
        if let Some(publisher) = previous_value.get("publisher").or_else(|| previous_value.get("author")) {
            let next_publisher = v.get("publisher").or_else(|| v.get("author"));
            if next_publisher != Some(publisher) {
                return Err("publisher identity changed for this extension id".into());
            }
        }
        let installed_version = previous_value
            .get("version")
            .and_then(serde_json::Value::as_str)
            .ok_or("installed extension has no version")?;
        if !valid_semver(installed_version) || compare_semver(&expected_version, installed_version) <= 0 {
            return Err("installed extension version is already current or newer".into());
        }
        let rollback_dir = dir.join("rollback").join(&expected_id);
        fs::create_dir_all(&rollback_dir).map_err(|error| {
            format!("could not prepare update rollback for {expected_id}: {error}")
        })?;
        let previous_text = std::str::from_utf8(previous_bytes)
            .map_err(|error| format!("installed extension manifest is not UTF-8: {error}"))?;
        write_atomic(&rollback_dir.join("manifest.json"), previous_text)?;
        match previous_language.as_deref() {
            Some(contents) => {
                let language_text = std::str::from_utf8(contents)
                    .map_err(|error| format!("installed language config is not UTF-8: {error}"))?;
                write_atomic(&rollback_dir.join("language.json"), language_text)?;
            }
            None => {
                remove_if_exists(&rollback_dir.join("language.json"))?;
            }
        }
        let previous_status = state.get(&expected_id).cloned();
        match previous_status {
            Some(status) => {
                write_atomic(
                    &rollback_dir.join("state.json"),
                    &serde_json::to_string_pretty(&status).map_err(|error| error.to_string())?,
                )?;
            }
            None => {
                remove_if_exists(&rollback_dir.join("state.json"))?;
            }
        }
    }

    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut created_language_dir = false;
    if kind == "language" {
        let language_dir = dir.join("languages");
        if !language_dir.exists() {
            fs::create_dir_all(&language_dir).map_err(|e| e.to_string())?;
            created_language_dir = true;
        }
        let pretty = serde_json::to_string_pretty(
            v.get("language").ok_or("language extension needs a 'language' section")?,
        )
        .map_err(|e| e.to_string())?;
        if let Err(error) = write_atomic(&language_path, &pretty) {
            if created_language_dir {
                if let Err(cleanup_error) = fs::remove_dir(&language_dir) {
                    if cleanup_error.kind() != std::io::ErrorKind::NotFound {
                        return Err(format!("{error}; cleanup failed: {cleanup_error}"));
                    }
                }
            }
            return Err(error);
        }
    }
    if let Err(error) = write_atomic(&manifest_path, &text) {
        let rollback = restore_file(&language_path, previous_language.as_deref());
        if created_language_dir {
            if let Err(cleanup_error) = fs::remove_dir(dir.join("languages")) {
                if cleanup_error.kind() != std::io::ErrorKind::NotFound {
                    return Err(format!("{error}; cleanup failed: {cleanup_error}"));
                }
            }
        }
        if let Err(rollback_error) = rollback {
            return Err(format!("{error}; restoring previous language config failed: {rollback_error}"));
        }
        return Err(error);
    }

    state.insert(
        expected_id,
        serde_json::json!({
            "enabled": true,
            "permissions": approved_permissions,
            "checksum": digest
        }),
    );
    if let Err(error) = write_atomic(
        &extension_state_path(),
        &serde_json::to_string_pretty(&state).map_err(|error| error.to_string())?,
    ) {
        let manifest_rollback = restore_file(&manifest_path, previous_manifest.as_deref());
        let language_rollback = restore_file(&language_path, previous_language.as_deref());
        if let Err(rollback_error) = manifest_rollback.and(language_rollback) {
            return Err(format!("{error}; restoring previous extension files failed: {rollback_error}"));
        }
        return Err(error);
    }
    Ok(v)
}

fn restore_file(path: &Path, contents: Option<&[u8]>) -> Result<(), String> {
    match contents {
        Some(contents) => {
            let restored = std::str::from_utf8(contents)
                .map_err(|error| format!("backup for {} is not UTF-8: {error}", path.display()))?;
            write_atomic(path, restored)
        }
        None => {
            match fs::remove_file(path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(format!("could not remove {}: {error}", path.display())),
            }
        }
    }
}

fn compare_semver(left: &str, right: &str) -> i8 {
    let Some(left) = parse_semver(left) else {
        return -1;
    };
    let Some(right) = parse_semver(right) else {
        return 1;
    };
    for ordering in [
        left.major.cmp(&right.major),
        left.minor.cmp(&right.minor),
        left.patch.cmp(&right.patch),
    ] {
        match ordering {
            std::cmp::Ordering::Less => return -1,
            std::cmp::Ordering::Greater => return 1,
            std::cmp::Ordering::Equal => {}
        }
    }
    if left.prerelease.is_empty() || right.prerelease.is_empty() {
        return match (left.prerelease.is_empty(), right.prerelease.is_empty()) {
            (true, false) => 1,
            (false, true) => -1,
            _ => 0,
        };
    }
    for (left_part, right_part) in left.prerelease.iter().zip(&right.prerelease) {
        let left_number = left_part.parse::<u64>();
        let right_number = right_part.parse::<u64>();
        let ordering = match (left_number, right_number) {
            (Ok(left_number), Ok(right_number)) => left_number.cmp(&right_number),
            (Ok(_), Err(_)) => std::cmp::Ordering::Less,
            (Err(_), Ok(_)) => std::cmp::Ordering::Greater,
            (Err(_), Err(_)) => left_part.cmp(right_part),
        };
        match ordering {
            std::cmp::Ordering::Less => return -1,
            std::cmp::Ordering::Greater => return 1,
            std::cmp::Ordering::Equal => {}
        }
    }
    match left.prerelease.len().cmp(&right.prerelease.len()) {
        std::cmp::Ordering::Less => return -1,
        std::cmp::Ordering::Greater => return 1,
        std::cmp::Ordering::Equal => {}
    }
    0
}

#[tauri::command]
fn ext_set_enabled(id: String, enabled: bool, permissions: Vec<String>) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("invalid extension id".into());
    }
    let manifest_path = ext_dir().join(format!("{id}.json"));
    let text = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("could not read installed extension {id}: {error}"))?;
    let manifest: serde_json::Value =
        serde_json::from_str(&text).map_err(|error| format!("invalid extension {id}: {error}"))?;
    let required = extension_permission_requirements(&manifest);
    if permissions.iter().any(|permission| permission != "process.execution")
        || (enabled
            && required
                .iter()
                .any(|permission| !permissions.contains(permission)))
    {
        return Err("required extension permissions were not explicitly approved".into());
    }
    let mut state = read_extension_state()?;
    state.insert(
        id,
        serde_json::json!({ "enabled": enabled, "permissions": permissions }),
    );
    let contents =
        serde_json::to_string_pretty(&state).map_err(|error| error.to_string())?;
    fs::create_dir_all(config_dir()).map_err(|error| error.to_string())?;
    write_atomic(&extension_state_path(), &contents)
}

#[tauri::command]
fn ext_rollback(id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("invalid extension id".into());
    }
    let dir = ext_dir();
    let rollback_dir = dir.join("rollback").join(&id);
    let backup_manifest_path = rollback_dir.join("manifest.json");
    let backup_manifest = read_optional_bytes(&backup_manifest_path)?
        .ok_or_else(|| format!("no previous version is available for '{id}'"))?;
    let manifest: serde_json::Value = serde_json::from_slice(&backup_manifest)
        .map_err(|error| format!("invalid rollback manifest for '{id}': {error}"))?;
    let version = manifest
        .get("version")
        .and_then(serde_json::Value::as_str)
        .ok_or("rollback manifest has no version")?;
    let (kind, _) = validate_extension_manifest(&manifest, &id, version)?;
    let backup_language = read_optional_bytes(&rollback_dir.join("language.json"))?;
    if kind == "language" && backup_language.is_none() {
        return Err("rollback language configuration is missing".into());
    }
    let backup_state = read_optional_bytes(&rollback_dir.join("state.json"))?;
    let current_manifest_path = dir.join(format!("{id}.json"));
    let current_language_path = dir.join("languages").join(format!("{id}.json"));
    let current_manifest = read_optional_bytes(&current_manifest_path)?;
    let current_language = read_optional_bytes(&current_language_path)?;
    let old_state = read_extension_state()?;
    let mut next_state = old_state.clone();
    match backup_state.as_deref() {
        Some(contents) => {
            let status = serde_json::from_slice(contents)
                .map_err(|error| format!("invalid rollback state for '{id}': {error}"))?;
            next_state.insert(id.clone(), status);
        }
        None => {
            next_state.remove(&id);
        }
    }

    fs::create_dir_all(current_manifest_path.parent().ok_or("invalid extension path")?)
        .map_err(|error| error.to_string())?;
    if kind == "language" {
        fs::create_dir_all(current_language_path.parent().ok_or("invalid language path")?)
            .map_err(|error| error.to_string())?;
        let contents = std::str::from_utf8(backup_language.as_deref().unwrap_or_default())
            .map_err(|error| format!("rollback language config is not UTF-8: {error}"))?;
        write_atomic(&current_language_path, contents)?;
    } else {
        remove_if_exists(&current_language_path)?;
    }
    let manifest_text = std::str::from_utf8(&backup_manifest)
        .map_err(|error| format!("rollback manifest is not UTF-8: {error}"))?;
    if let Err(error) = write_atomic(&current_manifest_path, manifest_text) {
        let language_rollback = restore_file(&current_language_path, current_language.as_deref());
        if let Err(rollback_error) = language_rollback {
            return Err(format!("{error}; restoring current language config failed: {rollback_error}"));
        }
        return Err(error);
    }
    let state_text = serde_json::to_string_pretty(&next_state)
        .map_err(|error| error.to_string())?;
    if let Err(error) = write_atomic(&extension_state_path(), &state_text) {
        let manifest_rollback = restore_file(&current_manifest_path, current_manifest.as_deref());
        let language_rollback = restore_file(&current_language_path, current_language.as_deref());
        if let Err(rollback_error) = manifest_rollback.and(language_rollback) {
            return Err(format!("{error}; restoring current extension failed: {rollback_error}"));
        }
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
fn ext_remove(id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("invalid extension id".into());
    }
    let dir = ext_dir();
    let manifest = dir.join(format!("{id}.json"));
    let language = dir.join("languages").join(format!("{id}.json"));
    let old_manifest = fs::read(&manifest)
        .map_err(|error| format!("could not read installed extension '{id}': {error}"))?;
    let old_language = match fs::read(&language) {
        Ok(contents) => Some(contents),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(format!("could not read extension language config '{id}': {error}"));
        }
    };
    let mut state = read_extension_state()?;
    let old_state = state.clone();
    state.remove(&id);
    fs::create_dir_all(config_dir()).map_err(|error| error.to_string())?;
    write_atomic(
        &extension_state_path(),
        &serde_json::to_string_pretty(&state).map_err(|error| error.to_string())?,
    )?;
    if let Err(error) = fs::remove_file(&manifest) {
        restore_state_after_remove(&old_state, &error)?;
        return Err(format!("could not remove extension '{id}': {error}"));
    }
    if old_language.is_some() {
        if let Err(error) = fs::remove_file(&language) {
            let manifest_rollback = restore_file(&manifest, Some(&old_manifest));
            let language_rollback = restore_file(&language, old_language.as_deref());
            restore_state_after_remove(&old_state, &error)?;
            if let Err(rollback_error) = manifest_rollback.and(language_rollback) {
                return Err(format!("{error}; extension removal rollback failed: {rollback_error}"));
            }
            return Err(format!("could not remove language config for '{id}': {error}"));
        }
    }
    // Rollback data is only metadata for a previous version; a failed cleanup
    // must not turn a successful removal into an error.
    if let Err(error) = fs::remove_dir_all(dir.join("rollback").join(&id)) {
        if error.kind() != std::io::ErrorKind::NotFound {
            eprintln!("could not clean up rollback metadata for '{id}': {error}");
        }
    }
    Ok(())
}

fn restore_state_after_remove(
    state: &serde_json::Map<String, serde_json::Value>,
    cause: &std::io::Error,
) -> Result<(), String> {
    let contents = serde_json::to_string_pretty(state).map_err(|error| error.to_string())?;
    write_atomic(&extension_state_path(), &contents)
        .map_err(|error| format!("{cause}; restoring extension state failed: {error}"))
}

// ---------- dependency checks ----------
#[derive(Debug, serde::Deserialize, serde::Serialize)]
struct DependencyRequirement {
    name: String,
    kind: String,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
struct DependencyStatus {
    name: String,
    available: bool,
    detail: String,
}

/// Validates either ^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,63}$ (tools and services)
/// or ^[A-Za-z_][A-Za-z0-9_]{0,63}$ (Python module names) without a regex dependency.
fn valid_dependency_name(name: &str, python_module: bool) -> bool {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    let first_valid = if python_module {
        bytes[0].is_ascii_alphabetic() || bytes[0] == b'_'
    } else {
        bytes[0].is_ascii_alphanumeric() || bytes[0] == b'_'
    };
    first_valid
        && bytes[1..].iter().all(|byte| {
            byte.is_ascii_alphanumeric()
                || *byte == b'_'
                || (!python_module && matches!(*byte, b'.' | b'+' | b'-'))
        })
}

fn valid_tool_dependency_name(name: &str) -> bool {
    valid_dependency_name(name, false)
}

fn valid_python_module_name(name: &str) -> bool {
    valid_dependency_name(name, true)
}

/// Looks up a validated name in PATH without a shell, without executing the
/// candidate, and without changing PATH.
fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
}

const PYTHON_MODULE_PROBE: &str =
    "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec(sys.argv[1]) else 1)";

fn check_python_module(name: &str) -> DependencyStatus {
    let Some(python) = find_on_path("python3") else {
        return DependencyStatus {
            name: name.to_string(),
            available: false,
            detail: "python3 not found in PATH".into(),
        };
    };
    let (available, detail) = match Command::new(python)
        .arg("-c")
        .arg(PYTHON_MODULE_PROBE)
        .arg(name)
        .output()
    {
        Ok(output) if output.status.success() => (true, "Python module found"),
        Ok(_) => (false, "Python module not installed"),
        Err(error) => {
            return DependencyStatus {
                name: name.to_string(),
                available: false,
                detail: format!("Python module check failed: {error}"),
            };
        }
    };
    DependencyStatus {
        name: name.to_string(),
        available,
        detail: detail.into(),
    }
}

/// Offline, side-effect-free dependency detection for extension setup screens.
/// All requirements are validated before any detection runs, so invalid input
/// can never reach a subprocess.
#[tauri::command]
fn ext_check_dependencies(
    requirements: Vec<DependencyRequirement>,
) -> Result<Vec<DependencyStatus>, String> {
    for requirement in &requirements {
        match requirement.kind.as_str() {
            "executable" | "system-tool" | "service" => {
                if !valid_tool_dependency_name(&requirement.name) {
                    return Err(format!(
                        "invalid dependency name '{}' for kind '{}'",
                        requirement.name, requirement.kind
                    ));
                }
            }
            "python-module" => {
                if !valid_python_module_name(&requirement.name) {
                    return Err(format!(
                        "invalid python module name '{}'",
                        requirement.name
                    ));
                }
            }
            kind => return Err(format!("unsupported dependency kind '{kind}'")),
        }
    }

    Ok(requirements
        .into_iter()
        .map(|requirement| {
            let name = requirement.name.clone();
            if requirement.kind == "python-module" {
                return check_python_module(&name);
            }
            let (available, detail) = match find_on_path(&name) {
                Some(_) => (true, "Found in PATH"),
                None => (false, "Not found in PATH"),
            };
            DependencyStatus {
                name,
                available,
                detail: detail.into(),
            }
        })
        .collect())
}

// ---------- running code ----------
#[derive(serde::Serialize)]
struct RunResult {
    stdout: String,
    stderr: String,
    code: i32,
    language: String,
}

fn run_language(lang: &Language, path: &Path) -> Result<RunResult, String> {
    let cmd = lang
        .run_command(path)
        .ok_or_else(|| format!("{} has no run command configured", lang.name))?;
    let out = Command::new("sh")
        .arg("-c")
        .arg(&cmd)
        .output()
        .map_err(|e| format!("failed to start '{cmd}': {e}"))?;
    Ok(RunResult {
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        code: out.status.code().unwrap_or(-1),
        language: lang.name.clone(),
    })
}

fn temporary_run_dir() -> Result<PathBuf, String> {
    static NEXT_RUN_ID: AtomicU64 = AtomicU64::new(0);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("system clock error: {e}"))?
        .as_nanos();

    for _ in 0..10 {
        let id = NEXT_RUN_ID.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("talos-run-{}-{timestamp}-{id}", std::process::id()));
        match fs::create_dir(&dir) {
            Ok(()) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if let Err(e) = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)) {
                        let _ = fs::remove_dir_all(&dir);
                        return Err(format!("could not secure temporary run directory: {e}"));
                    }
                }
                return Ok(dir);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("could not create temporary run directory: {e}")),
        }
    }

    Err("could not create a unique temporary run directory".into())
}

fn languages_dirs(resource_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(directory) = std::env::var("TALOS_LANG_DIR") {
        if !directory.trim().is_empty() {
            dirs.push(PathBuf::from(directory));
        }
    }
    if let Some(resource_dir) = resource_dir {
        dirs.push(resource_dir.join("languages"));
    }
    // Development checkouts only. Release builds use the bundled resource dir.
    #[cfg(debug_assertions)]
    dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../languages"));
    dirs
}

fn enabled_extension_languages() -> Result<Vec<Language>, String> {
    let directory = ext_dir().join("languages");
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let state = read_extension_state()?;
    let entries = fs::read_dir(&directory)
        .map_err(|error| format!("could not read extension languages: {error}"))?;
    let mut languages = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("could not read extension language entry: {error}"))?;
        let path = entry.path();
        if !entry
            .file_type()
            .map_err(|error| format!("could not inspect {}: {error}", path.display()))?
            .is_file()
            || path.extension().and_then(|extension| extension.to_str()) != Some("json")
        {
            continue;
        }
        let id = path.file_stem().and_then(|stem| stem.to_str()).unwrap_or_default();
        if !valid_id(id) {
            continue;
        }
        let Some(status) = state.get(id).and_then(serde_json::Value::as_object) else {
            continue;
        };
        let enabled = status.get("enabled").and_then(serde_json::Value::as_bool) == Some(true);
        let approved = status
            .get("permissions")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|permissions| {
                permissions.iter().any(|permission| {
                    permission.as_str() == Some("process.execution")
                })
            });
        if !enabled || !approved {
            continue;
        }
        let contents = fs::read_to_string(&path)
            .map_err(|error| format!("could not read {}: {error}", path.display()))?;
        let language: Language = serde_json::from_str(&contents)
            .map_err(|error| format!("invalid extension language {}: {error}", path.display()))?;
        languages.push(language);
    }
    languages.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(languages)
}

/// Runs a file using the command template from the bundled languages folder,
/// then explicitly enabled language extensions.
#[tauri::command]
async fn run_file(app: tauri::AppHandle, path: String) -> Result<RunResult, String> {
    let resources = app.path().resource_dir().ok();
    run_file_impl(resources.as_deref(), path).await
}

async fn run_file_impl(resource_dir: Option<&Path>, path: String) -> Result<RunResult, String> {
    let p = Path::new(&path);
    let mut found = None;
    for d in languages_dirs(resource_dir).iter() {
        if let Ok(reg) = Registry::load_dir(d) {
            if let Some(l) = reg.detect(p) {
                found = Some(l.clone());
                break;
            }
        }
    }
    if found.is_none() {
        found = enabled_extension_languages()?
            .into_iter()
            .find(|language| {
                language.extensions.iter().any(|extension| {
                    p.extension().and_then(|value| value.to_str()).is_some_and(|actual| {
                        extension.eq_ignore_ascii_case(&format!(".{actual}"))
                    })
                })
            });
    }
    let lang = found.ok_or_else(|| {
        format!("no language configured for {path} (add one in languages/ or install a language extension)")
    })?;
    run_language(&lang, p)
}

#[tauri::command]
fn run_source(
    app: tauri::AppHandle,
    source: String,
    language_id: Option<String>,
    file_name: Option<String>,
) -> Result<RunResult, String> {
    let resources = app.path().resource_dir().ok();
    run_source_impl(resources.as_deref(), source, language_id, file_name)
}

fn run_source_impl(
    resource_dir: Option<&Path>,
    source: String,
    language_id: Option<String>,
    file_name: Option<String>,
) -> Result<RunResult, String> {
    let mut found = None;
    for d in languages_dirs(resource_dir).iter() {
        if let Ok(reg) = Registry::load_dir(d) {
            let lang = match language_id.as_deref() {
                Some(id) => reg.by_id(id),
                None => file_name
                    .as_deref()
                    .and_then(|name| reg.detect(Path::new(name))),
            };
            if let Some(lang) = lang {
                found = Some(lang.clone());
                break;
            }
        }
    }
    if found.is_none() {
        found = enabled_extension_languages()?.into_iter().find(|language| {
            match language_id.as_deref() {
                Some(id) => language.id == id,
                None => file_name
                    .as_deref()
                    .and_then(|name| Path::new(name).extension())
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|actual| {
                        language.extensions.iter().any(|extension| {
                            extension.eq_ignore_ascii_case(&format!(".{actual}"))
                        })
                    }),
            }
        });
    }
    let lang = found.ok_or_else(|| {
        language_id.map_or_else(
            || "Choose a run language or save the file with a recognized extension.".to_string(),
            |id| format!("No run configuration found for language '{id}'."),
        )
    })?;
    let extension = lang
        .extensions
        .first()
        .filter(|extension| {
            extension.len() > 1
                && extension.starts_with('.')
                && extension[1..]
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
        })
        .ok_or_else(|| format!("{} has no valid file extension for running.", lang.name))?;
    let dir = temporary_run_dir()?;
    let path = dir.join(format!("main{extension}"));
    if let Err(e) = fs::write(&path, source) {
        let _ = fs::remove_dir_all(&dir);
        return Err(format!("could not write temporary source file: {e}"));
    }
    let result = run_language(&lang, &path);
    fs::remove_dir_all(&dir).map_err(|e| format!("could not remove temporary run files: {e}"))?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checked_file_writes_detect_stale_revisions() {
        let parent = std::env::temp_dir().join(format!(
            "talos-file-conflict-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&parent).unwrap();
        let path = parent.join("document.txt");
        fs::write(&path, "original").unwrap();
        let original = read_file_snapshot(&path).unwrap().unwrap();

        fs::write(&path, "changed by another window").unwrap();
        let conflict = write_file_if_unchanged(&path, "my edits", Some(&original.revision)).unwrap();
        match conflict {
            CheckedWriteOutcome::Conflict { snapshot } => {
                assert_eq!(
                    snapshot.unwrap().contents,
                    "changed by another window"
                );
            }
            CheckedWriteOutcome::Saved { .. } => panic!("a stale revision must not be written"),
        }

        let latest = read_file_snapshot(&path).unwrap().unwrap();
        let saved =
            write_file_if_unchanged(&path, "explicitly accepted edits", Some(&latest.revision))
                .unwrap();
        assert!(matches!(saved, CheckedWriteOutcome::Saved { .. }));
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "explicitly accepted edits"
        );
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn file_snapshots_classify_python_bytecode_as_binary() {
        let parent = std::env::temp_dir().join(format!(
            "talos-binary-file-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&parent).unwrap();
        let path = parent.join("cli.cpython-312.pyc");
        fs::write(&path, [0x42, 0x0d, 0x0d, 0x0a, 0xff, 0x00, 0x01]).unwrap();

        let snapshot = read_file_snapshot(&path).unwrap().unwrap();
        assert!(snapshot.binary);
        assert!(snapshot.contents.is_empty());
        assert!(!snapshot.revision.is_empty());

        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn extension_manifest_validation_checks_identity_version_and_kind_data() {
        let theme = serde_json::json!({
            "id": "test-theme",
            "name": "Test Theme",
            "kind": "theme",
            "version": "1.2.3",
            "theme": {}
        });
        assert_eq!(
            validate_extension_manifest(&theme, "test-theme", "1.2.3")
                .unwrap()
                .0,
            "theme"
        );
        assert!(validate_extension_manifest(&theme, "../outside", "1.2.3").is_err());
        assert!(validate_extension_manifest(&theme, "test-theme", "1.2").is_err());
        assert!(validate_extension_manifest(&theme, "other-theme", "1.2.3").is_err());

        let malformed = serde_json::json!({
            "id": "bad",
            "name": "Bad",
            "kind": "template",
            "version": "1.0.0",
            "templates": [{"label": "Path", "filename": "../outside", "content": "x"}]
        });
        assert!(validate_extension_manifest(&malformed, "bad", "1.0.0").is_err());
    }

    #[test]
    fn language_commands_require_explicit_supported_permissions() {
        let language = serde_json::json!({
            "id": "lang-test",
            "name": "Test Language",
            "kind": "language",
            "version": "1.0.0",
            "language": {
                "id": "test",
                "name": "Test",
                "extensions": [".test"],
                "run": "test-runner {file}"
            }
        });
        assert_eq!(
            extension_permission_requirements(&language),
            vec!["process.execution"]
        );
        assert!(
            validate_extension_manifest(&language, "lang-test", "1.0.0").is_ok()
        );
        let unsupported = serde_json::json!({
            "id": "lang-test",
            "name": "Test Language",
            "kind": "language",
            "version": "1.0.0",
            "permissions": ["filesystem.read"],
            "language": {
                "id": "test",
                "name": "Test",
                "extensions": [".test"],
                "run": "test-runner {file}"
            }
        });
        assert!(validate_extension_manifest(&unsupported, "lang-test", "1.0.0").is_err());
    }

    #[test]
    fn semantic_versions_validate_and_compare_prereleases() {
        assert!(valid_semver("1.2.3"));
        assert!(valid_semver("1.2.3-rc.2+build.5"));
        assert!(!valid_semver("01.2.3"));
        assert!(!valid_semver("1.2.3-01"));
        assert!(!valid_semver("1.2"));
        assert!(compare_semver("1.0.0", "1.0.0-rc.1") > 0);
        assert!(compare_semver("1.0.0-rc.2", "1.0.0-rc.1") > 0);
        assert!(compare_semver("1.0.0-rc.1", "1.0.0") < 0);
    }

    #[test]
    fn dependency_name_patterns_accept_valid_names_and_reject_invalid_ones() {
        let long_tool = "a".repeat(64);
        let too_long_tool = "a".repeat(65);
        for name in [
            "sh", "python3", "1tool", "_tool", "tool+1", "tool-2.3", &long_tool,
        ] {
            assert!(
                valid_tool_dependency_name(name),
                "expected '{name}' to be valid"
            );
        }
        for name in [
            "",
            ".hidden",
            "-dash",
            "has space",
            "path/to/tool",
            "tool;rm",
            "tool\nname",
            "é",
            &too_long_tool,
        ] {
            assert!(!valid_tool_dependency_name(name), "expected '{name}' to be rejected");
        }

        let long_module = "a".repeat(64);
        let too_long_module = "a".repeat(65);
        for name in ["os", "_private", "module_2", &long_module] {
            assert!(valid_python_module_name(name), "expected '{name}' to be valid");
        }
        for name in [
            "",
            "2module",
            "dot.module",
            "dash-module",
            "plus+module",
            "has space",
            "module;import os",
            "é",
            &too_long_module,
        ] {
            assert!(!valid_python_module_name(name), "expected '{name}' to be rejected");
        }
    }

    #[test]
    fn ext_check_dependencies_rejects_invalid_input_before_any_detection() {
        // The first requirement would run python3 if detection happened first.
        let error = ext_check_dependencies(vec![
            DependencyRequirement {
                name: "sys".into(),
                kind: "python-module".into(),
            },
            DependencyRequirement {
                name: "sh".into(),
                kind: "shell-script".into(),
            },
        ])
        .expect_err("an unsupported kind must be rejected");
        assert!(error.contains("unsupported dependency kind"), "{error}");

        let error = ext_check_dependencies(vec![
            DependencyRequirement {
                name: "sh".into(),
                kind: "executable".into(),
            },
            DependencyRequirement {
                name: "os;touch /tmp/talos-dependency-probe".into(),
                kind: "python-module".into(),
            },
        ])
        .expect_err("an invalid module name must be rejected");
        assert!(error.contains("invalid python module name"), "{error}");

        let error = ext_check_dependencies(vec![DependencyRequirement {
            name: "../sh".into(),
            kind: "executable".into(),
        }])
        .expect_err("path-like tool names must be rejected");
        assert!(error.contains("invalid dependency name"), "{error}");
    }

    #[test]
    fn ext_check_dependencies_reports_known_shell_when_available() {
        // Sandboxed or minimal environments may not expose `sh` on PATH.
        if find_on_path("sh").is_none() {
            return;
        }
        let statuses = ext_check_dependencies(vec![DependencyRequirement {
            name: "sh".into(),
            kind: "executable".into(),
        }])
        .expect("a validated executable name should be checkable");
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].name, "sh");
        assert!(statuses[0].available);
        assert_eq!(statuses[0].detail, "Found in PATH");
    }

    #[test]
    fn project_scan_excludes_defaults_and_counts_files_without_following_links() {
        let root = std::env::temp_dir().join(format!(
            "talos-project-scan-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("src/main.ts"), "export {};").unwrap();
        fs::write(root.join("src/nested/helper.py"), "pass").unwrap();
        fs::write(root.join("node_modules/ignored.js"), "").unwrap();

        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("src"), root.join("src-link")).unwrap();

        let exclusions = [".git", "node_modules", "__pycache__", "dist", "build", ".venv", "vendor"]
            .map(str::to_string);
        let scan = scan_project_tree(root.to_str().unwrap(), &exclusions).unwrap();
        assert_eq!(scan.entries[0].path, root.to_string_lossy());
        assert!(scan.entries.iter().all(|entry| !entry.path.contains("node_modules")));
        assert_eq!(scan.entries[0].file_count, 2);
        assert!(scan.entries.iter().any(|entry| entry.name == "src-link" && entry.kind == "link"));
        assert!(!scan.entries.iter().any(|entry| entry.path.ends_with("src-link/main.ts")));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_operations_create_rename_and_delete_only_inside_workspace() {
        let parent = std::env::temp_dir().join(format!(
            "talos-project-operations-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root = parent.join("workspace");
        fs::create_dir_all(&root).unwrap();
        let root_text = root.to_string_lossy().into_owned();

        create_project_folder_at(&root_text, "src").unwrap();
        create_project_file_at(&root_text, "src/main.rs").unwrap();
        assert!(create_project_file_at(&root_text, "src/main.rs").is_err());
        rename_project_entry_at(&root_text, "src/main.rs", "src/lib.rs").unwrap();
        assert!(root.join("src/lib.rs").is_file());
        fs::write(root.join("src/existing.rs"), "preserve").unwrap();
        assert!(rename_project_entry_at(&root_text, "src/lib.rs", "src/existing.rs").is_err());
        assert_eq!(
            fs::read_to_string(root.join("src/existing.rs")).unwrap(),
            "preserve"
        );
        assert!(create_project_file_at(&root_text, "/outside.txt").is_err());
        assert!(delete_project_entry_at(&root_text, "../outside").is_err());
        assert!(delete_project_entry_at(&root_text, "").is_err());
        delete_project_entry_at(&root_text, "src/lib.rs").unwrap();
        delete_project_entry_at(&root_text, "src").unwrap();
        assert!(!root.join("src").exists());

        fs::remove_dir_all(parent).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn project_operations_reject_symlinked_parent_directories() {
        let parent = std::env::temp_dir().join(format!(
            "talos-project-symlink-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root = parent.join("workspace");
        let outside = parent.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("linked")).unwrap();

        assert!(create_project_file_at(root.to_str().unwrap(), "linked/escape.txt").is_err());
        assert!(!outside.join("escape.txt").exists());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn runs_unsaved_python_source() {
        let available = Command::new("python3").arg("--version").output();
        if !matches!(available, Ok(output) if output.status.success()) {
            return;
        }

        let languages = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../languages");
        let result = run_source_impl(
            Some(&languages),
            "print('Talos run test')".into(),
            Some("python".into()),
            None,
        )
        .expect("the unsaved Python source should run");

        assert_eq!(result.stdout.trim(), "Talos run test");
        assert_eq!(result.code, 0);
    }

    #[test]
    fn unsaved_source_without_a_language_returns_guidance() {
        let error = match run_source_impl(None, "print('hello')".into(), None, None) {
            Err(error) => error,
            Ok(_) => panic!("no language should require user guidance"),
        };

        assert!(error.contains("Choose a run language"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(PendingWindowContexts::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_runner::init());
    builder
        .invoke_handler(tauri::generate_handler![
            read_file,
            read_file_snapshot_command,
            write_file_checked,
            read_file_bytes,
            write_file,
            write_file_bytes,
            startup_file,
            create_window,
            take_window_context,
            is_android,
            scan_project,
            create_project_file,
            create_project_folder,
            rename_project_entry,
            delete_project_entry,
            load_project_sources,
            measure_project_components,
            load_project_manifests,
            watch_project,
            stop_project_watch,
            force_quit,
            settings_read,
            settings_write,
            chronicle::chronicle_status,
            chronicle::chronicle_settings,
            chronicle::chronicle_set_settings,
            chronicle::chronicle_index_start,
            chronicle::chronicle_index_cancel,
            chronicle::chronicle_search,
            chronicle::chronicle_timeline,
            chronicle::chronicle_decisions,
            chronicle::chronicle_record_decision,
            chronicle::chronicle_observe,
            chronicle::chronicle_set_decision_status,
            default_registry,
            ext_list,
            ext_install,
            ext_set_enabled,
            ext_rollback,
            ext_remove,
            ext_check_dependencies,
            run_file,
            run_source,
            terminal::platform::terminal_open,
            terminal::platform::terminal_write,
            terminal::platform::terminal_resize,
            terminal::platform::terminal_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running Talos");
}
