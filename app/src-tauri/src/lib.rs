use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    collections::HashMap,
    fs,
    io::{BufReader, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    process::{ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use talos_core::language::{Language, Registry};
use tauri::{Emitter, Manager};

mod chronicle;
mod github;
mod insights;
mod terminal;
mod workspace;

static PROJECT_WATCHERS: OnceLock<Mutex<HashMap<String, notify::RecommendedWatcher>>> =
    OnceLock::new();
static ACTIVE_RUN_STDINS: OnceLock<Mutex<HashMap<String, ChildStdin>>> = OnceLock::new();
static FILE_WRITE_LOCK: Mutex<()> = Mutex::new(());
static NEXT_WINDOW_ID: AtomicU64 = AtomicU64::new(0);
// Repository roots are stable for the life of a workspace. Every Git command
// needs the toplevel (porcelain paths are repo-relative); resolving it with a
// fresh `git rev-parse` for each command spawned ~20 processes per Source
// Control refresh. Cache successful resolutions; failures are never cached so
// a folder that later becomes a repository is detected correctly.
static GIT_TOPLEVEL_CACHE: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();

fn cached_git_toplevel(root: &str) -> Option<PathBuf> {
    GIT_TOPLEVEL_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(root)
        .cloned()
}

fn active_run_stdin_map() -> &'static Mutex<HashMap<String, ChildStdin>> {
    ACTIVE_RUN_STDINS.get_or_init(|| Mutex::new(HashMap::new()))
}

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
const MAX_TEXT_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_BINARY_FILE_BYTES: u64 = 256 * 1024 * 1024;

fn metadata_revision(metadata: &fs::Metadata) -> String {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    format!("size:{}:mtime:{modified}", metadata.len())
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let metadata = fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?;
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Err(format!(
            "{path}: text files larger than {} MiB are not opened by Talos",
            MAX_TEXT_FILE_BYTES / (1024 * 1024)
        ));
    }
    fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

fn file_revision(contents: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(contents)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn is_text_file_path(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(name.as_str(), "dockerfile" | "makefile" | "cmakelists.txt") {
        return true;
    }
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(extension.as_str(),
        "bat" | "c" | "cc" | "cfg" | "clj" | "cmake" | "coffee" | "conf" | "cpp" |
        "cs" | "css" | "csv" | "cxx" | "dart" | "dockerfile" | "ex" | "exs" | "go" |
        "gradle" | "graphql" | "groovy" | "h" | "hpp" | "htm" | "html" | "ini" |
        "java" | "js" | "json" | "jsx" | "kt" | "kts" | "less" | "lua" | "md" |
        "mjs" | "php" | "pl" | "properties" | "py" | "pyi" | "rb" | "rs" | "sass" |
        "scss" | "sh" | "sql" | "swift" | "toml" | "ts" | "tsx" | "txt" | "vue" |
        "xml" | "yaml" | "yml" | "zsh"
    )
}

fn decode_utf16_text(bytes: &[u8]) -> Option<String> {
    let (offset, little_endian) = if bytes.starts_with(&[0xff, 0xfe]) {
        (2usize, true)
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        (2usize, false)
    } else {
        return None;
    };
    let payload = &bytes[offset..];
    if payload.len() % 2 != 0 {
        return None;
    }
    let units = payload
        .chunks_exact(2)
        .map(|chunk| {
            if little_endian {
                u16::from_le_bytes([chunk[0], chunk[1]])
            } else {
                u16::from_be_bytes([chunk[0], chunk[1]])
            }
        })
        .collect::<Vec<u16>>();
    let decoded = String::from_utf16(&units).ok()?;
    (!decoded.contains('\0')).then_some(decoded)
}

fn decode_text_bytes(bytes: &[u8], path: &Path) -> Option<String> {
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    if let Ok(contents) = String::from_utf8(bytes.to_vec()) {
        return (!contents.contains('\0')).then_some(contents);
    }
    if let Some(contents) = decode_utf16_text(bytes) {
        return Some(contents);
    }
    if is_text_file_path(path) && !bytes.contains(&0) {
        return Some(String::from_utf8_lossy(bytes).into_owned());
    }
    None
}

fn read_file_snapshot(path: &Path) -> Result<Option<FileSnapshot>, String> {
    match fs::metadata(path) {
        Ok(metadata) if metadata.len() > MAX_TEXT_FILE_BYTES => {
            return Ok(Some(FileSnapshot {
                contents: String::new(),
                revision: metadata_revision(&metadata),
                binary: true,
            }));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("{}: {error}", path.display())),
        Ok(_) => {}
    }
    match fs::read(path) {
        Ok(bytes) => {
            let revision = file_revision(&bytes);
            match decode_text_bytes(&bytes, path) {
                Some(contents) => Ok(Some(FileSnapshot {
                    contents,
                    revision,
                    binary: false,
                })),
                None => Ok(Some(FileSnapshot {
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
    let metadata = fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?;
    if metadata.len() > MAX_BINARY_FILE_BYTES {
        return Err(format!(
            "{path}: files larger than {} MiB are not supported",
            MAX_BINARY_FILE_BYTES / (1024 * 1024)
        ));
    }
    fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| format!("{path}: {e}"))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BinaryPreview {
    size: u64,
    bytes: Vec<u8>,
}

/// Bounded read for the read-only hex/strings preview. Only the requested page
/// crosses the IPC boundary, so a large binary never floods the webview.
#[tauri::command]
fn binary_preview(path: String, offset: u64, limit: u64) -> Result<BinaryPreview, String> {
    const MAX_PREVIEW_BYTES: u64 = 64 * 1024;
    let mut file = fs::File::open(&path).map_err(|e| format!("{path}: {e}"))?;
    let size = file.metadata().map_err(|e| format!("{path}: {e}"))?.len();
    let length = limit.min(MAX_PREVIEW_BYTES);
    let mut bytes = vec![0u8; length as usize];
    file.seek(SeekFrom::Start(offset.min(size)))
        .map_err(|e| format!("{path}: {e}"))?;
    let read = file.read(&mut bytes).map_err(|e| format!("{path}: {e}"))?;
    bytes.truncate(read);
    Ok(BinaryPreview { size, bytes })
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
    let bytes = STANDARD
        .decode(contents.as_bytes())
        .map_err(|error| format!("Invalid image data: {error}"))?;
    let mut options = fs::OpenOptions::new();
    options.write(true).truncate(overwrite).create(overwrite);
    if !overwrite {
        options.create_new(true);
    }
    options
        .open(target)
        .and_then(|mut file| std::io::Write::write_all(&mut file, &bytes))
        .map_err(|error| {
            if !overwrite && error.kind() == std::io::ErrorKind::AlreadyExists {
                "That file already exists. Choose a new name or confirm an explicit overwrite."
                    .to_string()
            } else {
                format!("{path}: {error}")
            }
        })
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
        let builder = tauri::WebviewWindowBuilder::new(
            &app,
            &label,
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("Talos Crest")
        .inner_size(1100.0, 720.0)
        .decorations(false);
        // Centering is a desktop-only Tauri builder method.
        #[cfg(not(target_os = "android"))]
        let builder = builder.center();
        let result = builder.build();
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

// ---------- recent workspaces ----------
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecentWorkspace {
    id: String,
    path: String,
    name: String,
    opened_at: u64,
}

const MAX_RECENT_WORKSPACES: usize = 12;

fn recent_workspaces_path() -> PathBuf {
    config_dir().join("workspaces").join("recent.json")
}

fn load_recent_workspaces() -> Vec<RecentWorkspace> {
    let path = recent_workspaces_path();
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(mut items) = serde_json::from_str::<Vec<RecentWorkspace>>(&text) else {
        return Vec::new();
    };
    items.retain(|item| Path::new(&item.path).is_dir());
    items.truncate(MAX_RECENT_WORKSPACES);
    items
}

fn save_recent_workspaces(items: &[RecentWorkspace]) -> Result<(), String> {
    let path = recent_workspaces_path();
    let parent = path.parent().ok_or("recent workspace path has no parent")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
    let text = serde_json::to_string_pretty(items)
        .map_err(|error| format!("could not encode recent workspaces: {error}"))?;
    fs::write(&path, text)
        .map_err(|error| format!("could not write {}: {error}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[tauri::command]
fn list_recent_workspaces() -> Vec<RecentWorkspace> {
    load_recent_workspaces()
}

#[tauri::command]
fn remember_workspace(root: String) -> Result<RecentWorkspace, String> {
    let root = canonical_project_root(&root)?;
    let path = root.to_string_lossy().into_owned();
    let item = RecentWorkspace {
        id: file_revision(path.as_bytes()),
        name: root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(path.as_str())
            .to_string(),
        opened_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0),
        path,
    };
    let mut items = load_recent_workspaces();
    items.retain(|existing| existing.id != item.id);
    items.insert(0, item.clone());
    items.truncate(MAX_RECENT_WORKSPACES);
    save_recent_workspaces(&items)?;
    Ok(item)
}

#[tauri::command]
fn clear_recent_workspaces() -> Result<(), String> {
    save_recent_workspaces(&[])
}

// ---------- config + extensions ----------
pub(crate) fn config_dir() -> PathBuf {
    if let Ok(x) = std::env::var("XDG_CONFIG_HOME") {
        if !x.is_empty() {
            return PathBuf::from(x).join("talos");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return PathBuf::from(home).join(".config/talos");
        }
    }
    #[cfg(target_os = "windows")]
    if let Ok(appdata) = std::env::var("APPDATA") {
        if !appdata.is_empty() {
            return PathBuf::from(appdata).join("talos");
        }
    }
    #[cfg(target_os = "windows")]
    if let Ok(profile) = std::env::var("USERPROFILE") {
        if !profile.is_empty() {
            return PathBuf::from(profile).join(".config/talos");
        }
    }
    PathBuf::from(".config/talos")
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
        format!(
            "could not write temporary file {}: {error}",
            temp_path.display()
        )
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
        .is_some_and(|command| {
            !command.is_null() && command.as_str().is_some_and(|s| !s.is_empty())
        });
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
        return Err(format!(
            "invalid or unexpected extension version '{version}'"
        ));
    }
    let kind = manifest
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .ok_or("extension has no kind")?;
    if !matches!(kind, "theme" | "language" | "template" | "snippets" | "icon-pack") {
        return Err(format!("unsupported extension kind '{kind}'"));
    }
    if let Some(permissions) = manifest.get("permissions") {
        let permissions = permissions
            .as_array()
            .ok_or("extension permissions must be an array")?;
        if permissions
            .iter()
            .any(|permission| permission.as_str() != Some("process.execution"))
        {
            return Err("extension requests permissions Talos does not support".into());
        }
    }
    match kind {
        "theme"
            if !manifest
                .get("theme")
                .is_some_and(serde_json::Value::is_object) =>
        {
            return Err("theme extension needs a 'theme' object".into());
        }
        "icon-pack" => {
            let pack = manifest
                .get("iconPack")
                .and_then(serde_json::Value::as_object)
                .ok_or("icon-pack extension needs an 'iconPack' object")?;
            let valid_token = |value: &str| {
                !value.is_empty()
                    && value.len() <= 64
                    && value
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            };
            if let Some(default) = pack.get("default") {
                let default = default
                    .as_str()
                    .ok_or("icon pack default must be a string")?;
                if !valid_token(default) {
                    return Err("icon pack default is not a valid icon token".into());
                }
            }
            let mappings = pack
                .get("mappings")
                .and_then(serde_json::Value::as_object)
                .ok_or("icon pack needs a 'mappings' object")?;
            if mappings.is_empty() || mappings.len() > 500 {
                return Err("icon pack needs between 1 and 500 mappings".into());
            }
            for (key, value) in mappings {
                let value = value.as_str().ok_or("icon pack mapping must be a string")?;
                if !valid_token(key) || !valid_token(value) {
                    return Err("icon pack contains an invalid mapping".into());
                }
            }
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
                return Err(
                    "language configuration contains invalid id, name, or extensions".into(),
                );
            }
            if parsed
                .run
                .as_ref()
                .is_some_and(|command| command.trim().is_empty() || command.len() > 4096)
            {
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
                            language
                                .as_str()
                                .is_none_or(|value| value.trim().is_empty() || value.len() > 64)
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
                    return Err(
                        "template contains an invalid label, filename, or oversized content".into(),
                    );
                }
            }
        }
        _ => {}
    }
    Ok((
        kind.to_string(),
        extension_permission_requirements(manifest),
    ))
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

fn language_registry(resource_dir: Option<&Path>) -> Option<Registry> {
    languages_dirs(resource_dir)
        .iter()
        .find_map(|dir| Registry::load_dir(dir).ok())
}

fn language_for_path(path: &Path, registry: Option<&Registry>) -> String {
    registry
        .and_then(|registry| registry.detect(path))
        .map(|language| language.id.clone())
        .unwrap_or_default()
}

fn modified_ms(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
}

/// Build the workspace policy used by every Explorer-facing subsystem.
/// `show_ignored` must be threaded through scanning, watching, metadata and
/// search together; otherwise ignored files appear in the tree but remain
/// invisible to refresh, change notifications and Find-in-Files.
fn workspace_policy(
    root: &Path,
    exclusions: &[String],
    show_hidden: bool,
    show_ignored: bool,
) -> Result<workspace::WorkspacePolicy, String> {
    if show_ignored {
        workspace::WorkspacePolicy::load_with_options(
            root,
            workspace::WorkspacePolicyOptions {
                exclusions: &[],
                show_hidden,
                respect_gitignore: false,
                respect_ignore: false,
                respect_talos_ignore: false,
            },
        )
    } else {
        workspace::WorkspacePolicy::load(root, exclusions, show_hidden)
    }
}

#[derive(Clone, Debug, serde::Serialize)]
struct ProjectEntry {
    path: String,
    parent: String,
    name: String,
    kind: String,
    extension: String,
    language: String,
    size: u64,
    modified_ms: Option<u64>,
    depth: usize,
    child_count: usize,
    file_count: usize,
}

#[derive(serde::Serialize)]
struct ProjectScan {
    id: String,
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

#[derive(serde::Serialize)]
struct DuplicatedEntry {
    /// Workspace-relative path of the new copy.
    path: String,
    /// Ignored, sensitive, special, or symbolic children that were not copied.
    skipped: usize,
}

fn scan_project_tree(
    root: &str,
    exclusions: &[String],
    show_hidden: bool,
    show_ignored: bool,
    registry: Option<&Registry>,
) -> Result<ProjectScan, String> {
    const MAX_ENTRIES: usize = 50_000;
    const MAX_DEPTH: usize = 64;

    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|e| format!("could not open project directory '{root}': {e}"))?;
    if !root.is_dir() {
        return Err(format!(
            "project root is not a directory: {}",
            root.display()
        ));
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
        language: String::new(),
        size: 0,
        modified_ms: modified_ms(&root_meta),
        depth: 0,
        child_count: 0,
        file_count: 0,
    }];
    let policy = workspace_policy(&root, exclusions, show_hidden, show_ignored)?;
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
            let file_type = match child.file_type() {
                Ok(file_type) => file_type,
                Err(error) => {
                    warnings.push(format!("Could not inspect {}: {error}", path.display()));
                    continue;
                }
            };
            let relative = path.strip_prefix(&root).unwrap_or(&path);
            if policy.is_ignored(relative, file_type.is_dir()) {
                continue;
            }
            if entries.len() >= MAX_ENTRIES {
                truncated = true;
                break;
            }
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
                language: language_for_path(&path, registry),
                extension,
                size: metadata.len(),
                modified_ms: modified_ms(&metadata),
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
        id: file_revision(root_path.as_bytes()),
        root: root_path,
        entries,
        warnings,
        truncated,
    })
}

#[tauri::command]
async fn scan_project(
    app: tauri::AppHandle,
    root: String,
    exclusions: Vec<String>,
    show_hidden: bool,
    show_ignored: bool,
) -> Result<ProjectScan, String> {
    let resource_dir = app.path().resource_dir().ok();
    tauri::async_runtime::spawn_blocking(move || {
        let registry = language_registry(resource_dir.as_deref());
        scan_project_tree(&root, &exclusions, show_hidden, show_ignored, registry.as_ref())
    })
    .await
    .map_err(|error| format!("project scan task failed: {error}"))?
}

#[derive(Debug, serde::Serialize)]
struct ProjectDirectory {
    root: String,
    path: String,
    entry: ProjectEntry,
    entries: Vec<ProjectEntry>,
    warnings: Vec<String>,
    truncated: bool,
}

/// List one directory level for the lazy Explorer.
///
/// This deliberately does not recurse. The root, the requested path, and every
/// child are checked against the same canonical root and workspace policy used
/// by the full scan, so lazy loading cannot widen what the Explorer may read.
fn list_project_directory_at(
    root: &str,
    path: &str,
    exclusions: &[String],
    show_hidden: bool,
    show_ignored: bool,
    registry: Option<&Registry>,
) -> Result<ProjectDirectory, String> {
    const MAX_DIRECTORY_ENTRIES: usize = 10_000;

    let root = canonical_project_root(root)?;
    let requested = {
        let candidate = PathBuf::from(path);
        if candidate.as_os_str().is_empty() {
            root.clone()
        } else if candidate.is_absolute() {
            candidate
        } else {
            root.join(candidate)
        }
    };
    let directory = requested
        .canonicalize()
        .map_err(|error| format!("could not open directory '{}': {error}", requested.display()))?;
    if !directory.starts_with(&root) {
        return Err("directory is outside the workspace".into());
    }
    if !directory.is_dir() {
        return Err(format!("workspace entry is not a directory: {}", directory.display()));
    }

    let policy = workspace_policy(&root, exclusions, show_hidden, show_ignored)?;
    let relative = directory.strip_prefix(&root).unwrap_or(Path::new(""));
    if !relative.as_os_str().is_empty() && policy.is_ignored(relative, true) {
        return Err(format!("directory is excluded by workspace policy: {}", relative.display()));
    }

    let depth = relative.components().count();
    let parent = if depth == 0 {
        String::new()
    } else {
        directory
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    let metadata = fs::symlink_metadata(&directory)
        .map_err(|error| format!("could not inspect {}: {error}", directory.display()))?;
    let mut warnings = Vec::new();
    let mut entries = Vec::new();
    let mut truncated = false;
    let children = fs::read_dir(&directory)
        .map_err(|error| format!("could not read {}: {error}", directory.display()))?;

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
        if entries.len() >= MAX_DIRECTORY_ENTRIES {
            truncated = true;
            break;
        }
        let child_path = child.path();
        let name = child.file_name().to_string_lossy().into_owned();
        let file_type = match child.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                warnings.push(format!("Could not inspect {}: {error}", child_path.display()));
                continue;
            }
        };
        let child_relative = child_path.strip_prefix(&root).unwrap_or(&child_path);
        if policy.is_ignored(child_relative, file_type.is_dir())
            || workspace::WorkspacePolicy::is_sensitive_name(&name)
        {
            continue;
        }
        let child_metadata = match fs::symlink_metadata(&child_path) {
            Ok(metadata) => metadata,
            Err(error) => {
                warnings.push(format!("Could not inspect {}: {error}", child_path.display()));
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
        let extension = if kind == "file" {
            child_path
                .extension()
                .and_then(|extension| extension.to_str())
                .unwrap_or("")
                .to_ascii_lowercase()
        } else {
            String::new()
        };
        entries.push(ProjectEntry {
            path: child_path.to_string_lossy().into_owned(),
            parent: directory.to_string_lossy().into_owned(),
            name,
            kind: kind.into(),
            extension,
            language: language_for_path(&child_path, registry),
            size: child_metadata.len(),
            modified_ms: modified_ms(&child_metadata),
            depth: depth + 1,
            child_count: 0,
            file_count: 0,
        });
    }

    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    let directory_text = directory.to_string_lossy().into_owned();
    let entry = ProjectEntry {
        path: directory_text.clone(),
        parent,
        name: directory
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Project")
            .to_string(),
        kind: "directory".into(),
        extension: String::new(),
        language: String::new(),
        size: 0,
        modified_ms: modified_ms(&metadata),
        depth,
        child_count: entries.len(),
        file_count: 0,
    };

    Ok(ProjectDirectory {
        root: root.to_string_lossy().into_owned(),
        path: directory_text,
        entry,
        entries,
        warnings,
        truncated,
    })
}

#[tauri::command]
async fn list_project_directory(
    app: tauri::AppHandle,
    root: String,
    path: String,
    exclusions: Vec<String>,
    show_hidden: bool,
    show_ignored: bool,
) -> Result<ProjectDirectory, String> {
    let resource_dir = app.path().resource_dir().ok();
    tauri::async_runtime::spawn_blocking(move || {
        let registry = language_registry(resource_dir.as_deref());
        list_project_directory_at(&root, &path, &exclusions, show_hidden, show_ignored, registry.as_ref())
    })
    .await
    .map_err(|error| format!("directory listing task failed: {error}"))?
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

fn move_project_entry_at(root: &str, from: &str, to: &str) -> Result<(), String> {
    let root = canonical_project_root(root)?;
    let source = project_entry_path(&root, from, true)?;
    let destination = project_entry_path(&root, to, false)?;
    if source == destination {
        return Ok(());
    }
    if let Some(parent) = destination.parent() {
        if !parent.is_dir() {
            return Err(format!(
                "destination folder does not exist: {}",
                parent.display()
            ));
        }
    }
    if destination.starts_with(&source) {
        return Err("a folder cannot be moved inside itself".to_string());
    }
    fs::rename(&source, &destination).map_err(|error| {
        format!(
            "could not move {} to {}: {error}",
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

const MAX_DUPLICATE_ENTRIES: usize = 10_000;
const MAX_DUPLICATE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DUPLICATE_DEPTH: usize = 64;
const MAX_DUPLICATE_NAME_ATTEMPTS: usize = 1_000;

#[derive(Default)]
struct DuplicateBudget {
    entries: usize,
    bytes: u64,
    skipped: usize,
}

fn duplicate_name_parts(name: &str) -> (String, String) {
    let extension = Path::new(name)
        .extension()
        .and_then(|extension| extension.to_str())
        .filter(|extension| !extension.is_empty());
    match extension {
        Some(extension) => {
            let suffix = format!(".{extension}");
            let stem = name.strip_suffix(&suffix).unwrap_or(name).to_string();
            (stem, suffix)
        }
        None => (name.to_string(), String::new()),
    }
}

fn duplicate_destination(
    root: &Path,
    relative: &str,
    policy: &workspace::WorkspacePolicy,
    is_dir: bool,
) -> Result<(String, PathBuf), String> {
    let source = Path::new(relative);
    let parent = source.parent().and_then(|parent| parent.to_str()).unwrap_or("");
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("duplicate source must have a UTF-8 file name")?;
    let (stem, extension) = duplicate_name_parts(name);

    for attempt in 1..=MAX_DUPLICATE_NAME_ATTEMPTS {
        let candidate_name = if attempt == 1 {
            format!("{stem} (copy){extension}")
        } else {
            format!("{stem} (copy {attempt}){extension}")
        };
        let candidate_relative = if parent.is_empty() {
            candidate_name.clone()
        } else {
            format!("{parent}/{candidate_name}")
        };
        if workspace::WorkspacePolicy::is_sensitive_name(&candidate_name)
            || policy.is_ignored(Path::new(&candidate_relative), is_dir)
        {
            continue;
        }
        match project_entry_path(root, &candidate_relative, false) {
            Ok(destination) => return Ok((candidate_relative, destination)),
            Err(error) if error.contains("already exists") => continue,
            Err(error) => return Err(error),
        }
    }
    Err(format!(
        "could not find an available duplicate name for '{name}'"
    ))
}

fn copy_file_bounded(source: &Path, destination: &Path, budget: &mut DuplicateBudget) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("could not inspect {}: {error}", source.display()))?;
    if !metadata.is_file() {
        return Err(format!("not a regular file: {}", source.display()));
    }
    if budget
        .bytes
        .checked_add(metadata.len())
        .map(|total| total > MAX_DUPLICATE_BYTES)
        .unwrap_or(true)
    {
        return Err("duplicate would exceed the 64 MiB copy budget".into());
    }
    let mut input = fs::File::open(source)
        .map_err(|error| format!("could not open {}: {error}", source.display()))?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| format!("could not create {}: {error}", destination.display()))?;
    let copied = std::io::copy(&mut input, &mut output)
        .map_err(|error| format!("could not copy {}: {error}", source.display()))?;
    budget.bytes = budget.bytes.saturating_add(copied);
    Ok(())
}

fn copy_entry_tree(
    source: &Path,
    destination: &Path,
    policy: &workspace::WorkspacePolicy,
    source_relative: &Path,
    destination_relative: &Path,
    budget: &mut DuplicateBudget,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_DUPLICATE_DEPTH {
        return Err(format!("duplicate exceeded the {MAX_DUPLICATE_DEPTH}-level depth limit"));
    }
    budget.entries += 1;
    if budget.entries > MAX_DUPLICATE_ENTRIES {
        return Err(format!(
            "duplicate exceeded the {MAX_DUPLICATE_ENTRIES}-item limit"
        ));
    }

    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("could not inspect {}: {error}", source.display()))?;
    if metadata.file_type().is_symlink() {
        budget.skipped += 1;
        return Ok(());
    }
    if metadata.is_dir() {
        fs::create_dir(destination)
            .map_err(|error| format!("could not create {}: {error}", destination.display()))?;
        let children = fs::read_dir(source)
            .map_err(|error| format!("could not list {}: {error}", source.display()))?;
        for child in children {
            let child = child
                .map_err(|error| format!("could not read an entry in {}: {error}", source.display()))?;
            let name = child.file_name();
            let name_text = name.to_string_lossy();
            let child_source_relative = source_relative.join(&name);
            let child_destination_relative = destination_relative.join(&name);
            let file_type = child.file_type()
                .map_err(|error| format!("could not inspect {}: {error}", child.path().display()))?;
            if workspace::WorkspacePolicy::is_sensitive_name(&name_text)
                || policy.is_ignored(&child_source_relative, file_type.is_dir())
                || file_type.is_symlink()
            {
                budget.skipped += 1;
                continue;
            }
            copy_entry_tree(
                &child.path(),
                &destination.join(&name),
                policy,
                &child_source_relative,
                &child_destination_relative,
                budget,
                depth + 1,
            )?;
        }
        Ok(())
    } else if metadata.is_file() {
        copy_file_bounded(source, destination, budget)
    } else {
        budget.skipped += 1;
        Ok(())
    }
}

fn remove_partial_duplicate(path: &Path, is_dir: bool) -> Result<(), String> {
    let result = if is_dir {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    match result {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "could not remove partial duplicate {}: {error}",
            path.display()
        )),
    }
}

fn duplicate_project_entry_at(
    root: &str,
    relative: &str,
    exclusions: &[String],
    show_hidden: bool,
) -> Result<DuplicatedEntry, String> {
    let root = canonical_project_root(root)?;
    let policy = workspace::WorkspacePolicy::load(&root, exclusions, show_hidden)?;
    let source = project_entry_path(&root, relative, true)?;
    let metadata = fs::symlink_metadata(&source)
        .map_err(|error| format!("could not inspect {}: {error}", source.display()))?;
    if metadata.file_type().is_symlink() {
        return Err("cannot duplicate a symbolic link".into());
    }
    let is_dir = metadata.is_dir();
    let source_name = Path::new(relative)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("duplicate source must have a UTF-8 file name")?;
    if workspace::WorkspacePolicy::is_sensitive_name(source_name)
        || policy.is_ignored(Path::new(relative), is_dir)
    {
        return Err(format!("'{relative}' is excluded by the workspace policy"));
    }

    let (destination_relative, destination) =
        duplicate_destination(&root, relative, &policy, is_dir)?;
    let mut budget = DuplicateBudget::default();
    if let Err(error) = copy_entry_tree(
        &source,
        &destination,
        &policy,
        Path::new(relative),
        Path::new(&destination_relative),
        &mut budget,
        0,
    ) {
        let cleanup = remove_partial_duplicate(&destination, is_dir);
        return Err(match cleanup {
            Ok(()) => error,
            Err(cleanup_error) => format!("{error}; {cleanup_error}"),
        });
    }
    Ok(DuplicatedEntry {
        path: destination_relative,
        skipped: budget.skipped,
    })
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
async fn move_project_entry(root: String, from: String, to: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || move_project_entry_at(&root, &from, &to))
        .await
        .map_err(|error| format!("move task failed: {error}"))?
}

#[tauri::command]
async fn delete_project_entry(root: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_project_entry_at(&root, &path))
        .await
        .map_err(|error| format!("deletion task failed: {error}"))?
}

#[tauri::command]
async fn duplicate_project_entry(
    root: String,
    path: String,
    exclusions: Vec<String>,
    show_hidden: bool,
) -> Result<DuplicatedEntry, String> {
    tauri::async_runtime::spawn_blocking(move || {
        duplicate_project_entry_at(&root, &path, &exclusions, show_hidden)
    })
    .await
    .map_err(|error| format!("duplicate task failed: {error}"))?
}

fn workspace_entry_metadata_at(
    root: &str,
    path: &str,
    exclusions: &[String],
    show_hidden: bool,
    show_ignored: bool,
    registry: Option<&Registry>,
) -> Result<Option<ProjectEntry>, String> {
    let root = canonical_project_root(root)?;
    let candidate = PathBuf::from(path);
    let candidate = if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    };
    // Inspect the link itself, not its target, so symlinks keep reporting as
    // links even when they point outside the workspace.
    let metadata = match fs::symlink_metadata(&candidate) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("could not inspect {path}: {error}")),
    };
    let parent = candidate.parent().unwrap_or(&root);
    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| format!("could not inspect {path}: {error}"))?;
    if !canonical_parent.starts_with(&root) {
        return Err(format!("workspace path escapes the project: {path}"));
    }
    let file_name = candidate
        .file_name()
        .ok_or_else(|| format!("workspace path has no file name: {path}"))?;
    let relative = canonical_parent
        .strip_prefix(&root)
        .unwrap_or(&canonical_parent)
        .join(file_name);
    let policy = workspace_policy(&root, exclusions, show_hidden, show_ignored)?;
    if policy.is_ignored(&relative, metadata.is_dir())
        || workspace::WorkspacePolicy::is_sensitive_name(&file_name.to_string_lossy())
    {
        return Ok(None);
    }
    let kind = if metadata.file_type().is_symlink() {
        "link"
    } else if metadata.file_type().is_dir() {
        "directory"
    } else {
        "file"
    };
    let extension = if kind == "file" {
        candidate
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
    } else {
        String::new()
    };
    let depth = relative.components().count();
    Ok(Some(ProjectEntry {
        path: candidate.to_string_lossy().into_owned(),
        parent: candidate
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned())
            .unwrap_or_default(),
        name: file_name.to_string_lossy().into_owned(),
        kind: kind.into(),
        extension,
        language: language_for_path(&candidate, registry),
        size: metadata.len(),
        modified_ms: modified_ms(&metadata),
        depth,
        child_count: 0,
        file_count: 0,
    }))
}

#[derive(serde::Serialize)]
struct WorkspaceTextMatch {
    path: String,
    line: usize,
    column: usize,
    text: String,
}

fn search_file_paths(
    query: &str,
    paths: &[String],
    limit: usize,
) -> Result<Vec<WorkspaceTextMatch>, String> {
    const MAX_SEARCH_FILES: usize = 4_000;
    const MAX_FILE_BYTES: u64 = 512 * 1024;
    const MAX_TOTAL_BYTES: u64 = 16 * 1024 * 1024;

    let needle = query.trim();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let lower_needle = needle.to_ascii_lowercase();
    let mut matches = Vec::new();
    let mut bytes_read = 0u64;
    let mut files_read = 0usize;

    for path_text in paths {
        if matches.len() >= limit || files_read >= MAX_SEARCH_FILES || bytes_read >= MAX_TOTAL_BYTES
        {
            break;
        }
        let path = PathBuf::from(path_text);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() && metadata.len() <= MAX_FILE_BYTES => metadata,
            _ => continue,
        };
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        if text.contains('\0') {
            continue;
        }
        bytes_read = bytes_read.saturating_add(metadata.len());
        files_read += 1;
        for (line_index, line) in text.lines().enumerate() {
            let lower = line.to_ascii_lowercase();
            let mut offset = 0usize;
            while let Some(found) = lower[offset..].find(&lower_needle) {
                let column = offset + found;
                matches.push(WorkspaceTextMatch {
                    path: path_text.clone(),
                    line: line_index + 1,
                    column: column + 1,
                    text: line.chars().take(240).collect(),
                });
                if matches.len() >= limit {
                    break;
                }
                offset = column + needle.len();
                if offset >= lower.len() {
                    break;
                }
            }
            if matches.len() >= limit {
                break;
            }
        }
    }
    Ok(matches)
}

/// Validate paths coming from the frontend's current workspace snapshot.
/// They are checked against the canonical root and the live ignore policy so a
/// stale or hostile list can never widen what the search reads.
fn snapshot_file_paths(
    root: &str,
    paths: &[String],
    exclusions: &[String],
    show_hidden: bool,
    show_ignored: bool,
) -> Result<Vec<String>, String> {
    let root = canonical_project_root(root)?;
    let policy = workspace_policy(&root, exclusions, show_hidden, show_ignored)?;
    let mut result = Vec::with_capacity(paths.len());
    for path in paths {
        let candidate = PathBuf::from(path);
        let candidate = if candidate.is_absolute() {
            candidate
        } else {
            root.join(candidate)
        };
        let Ok(canonical) = candidate.canonicalize() else {
            continue;
        };
        if !canonical.starts_with(&root) {
            continue;
        }
        let relative = canonical.strip_prefix(&root).unwrap_or(&canonical);
        let name = canonical.file_name().and_then(|name| name.to_str()).unwrap_or("");
        if policy.is_ignored(relative, false)
            || workspace::WorkspacePolicy::is_sensitive_name(name)
        {
            continue;
        }
        result.push(canonical.to_string_lossy().into_owned());
    }
    Ok(result)
}

fn search_workspace_text_at(
    root: &str,
    query: &str,
    exclusions: &[String],
    show_hidden: bool,
    show_ignored: bool,
    limit: usize,
    paths: Option<&[String]>,
) -> Result<Vec<WorkspaceTextMatch>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let candidates: Vec<String> = match paths {
        Some(paths) => snapshot_file_paths(root, paths, exclusions, show_hidden, show_ignored)?,
        None => scan_project_tree(root, exclusions, show_hidden, show_ignored, None)?
            .entries
            .into_iter()
            .filter(|entry| entry.kind == "file")
            .map(|entry| entry.path)
            .collect(),
    };
    search_file_paths(query, &candidates, limit)
}

#[tauri::command]
async fn search_workspace_text(
    root: String,
    query: String,
    exclusions: Vec<String>,
    show_hidden: bool,
    show_ignored: bool,
    limit: Option<usize>,
    paths: Option<Vec<String>>,
) -> Result<Vec<WorkspaceTextMatch>, String> {
    let limit = limit.unwrap_or(200).clamp(1, 500);
    tauri::async_runtime::spawn_blocking(move || {
        search_workspace_text_at(
            &root,
            &query,
            &exclusions,
            show_hidden,
            show_ignored,
            limit,
            paths.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("workspace text search task failed: {error}"))?
}

#[tauri::command]
async fn workspace_entry_metadata(
    app: tauri::AppHandle,
    root: String,
    path: String,
    exclusions: Vec<String>,
    show_hidden: bool,
    show_ignored: bool,
) -> Result<Option<ProjectEntry>, String> {
    let resource_dir = app.path().resource_dir().ok();
    tauri::async_runtime::spawn_blocking(move || {
        let registry = language_registry(resource_dir.as_deref());
        workspace_entry_metadata_at(
            &root,
            &path,
            &exclusions,
            show_hidden,
            show_ignored,
            registry.as_ref(),
        )
    })
    .await
    .map_err(|error| format!("workspace metadata task failed: {error}"))?
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
        if metadata.len() > MAX_FILE_BYTES
            || bytes_read.saturating_add(metadata.len()) > MAX_TOTAL_BYTES
        {
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
const MAX_PENDING_CHANGES: usize = 10_000;
const RESCAN_KIND: &str = "__talos_rescan__";

#[derive(Clone, serde::Serialize)]
struct WorkspaceChange {
    path: String,
    kind: String,
}

#[derive(Clone, serde::Serialize)]
struct WorkspaceChangeEvent {
    root: String,
    changes: Vec<WorkspaceChange>,
}

fn record_workspace_change(
    pending: &mut HashMap<String, String>,
    path: impl AsRef<str> + Into<String>,
    kind: &str,
) -> bool {
    // notify delivers events in order; keep the last state for each path.
    if pending.len() >= MAX_PENDING_CHANGES && !pending.contains_key(path.as_ref()) {
        // Bounded queue: collapse a burst into one rescan request instead of
        // growing without limit or silently dropping changes.
        pending.clear();
        pending.insert(String::new(), RESCAN_KIND.to_string());
        return true;
    }
    pending.insert(path.into(), kind.to_string());
    true
}

fn schedule_workspace_changes(
    window: tauri::WebviewWindow,
    root: String,
    pending: Arc<Mutex<HashMap<String, String>>>,
    scheduled: Arc<AtomicBool>,
) {
    if scheduled
        .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(WATCH_EMIT_INTERVAL_MS));
        let changes = {
            let mut guard = pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let changes: Vec<WorkspaceChange> = guard
                .iter()
                .map(|(path, kind)| WorkspaceChange {
                    path: path.clone(),
                    kind: kind.clone(),
                })
                .collect();
            guard.clear();
            // Release the scheduling flag under the same lock as the drain so
            // an event arriving between them cannot be stranded in `pending`.
            scheduled.store(false, Ordering::Relaxed);
            changes
        };
        if changes.is_empty() {
            return;
        }
        if let Err(error) = window.emit(
            "architecture://changed",
            WorkspaceChangeEvent { root, changes },
        ) {
            eprintln!("could not deliver workspace changes: {error}");
        }
    });
}

fn watch_path_ignored(path: &Path, root: &Path, policy: &workspace::WorkspacePolicy) -> bool {
    if path == root {
        return false;
    }
    let relative = match path.strip_prefix(root) {
        Ok(relative) => relative,
        Err(_) => return true,
    };
    policy.is_ignored(relative, path.is_dir())
}

fn collect_watch_dirs(root: &Path, policy: &workspace::WorkspacePolicy) -> Vec<PathBuf> {
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
                if !watch_path_ignored(&path, root, policy) {
                    dirs.push(path);
                }
            }
        }
        index += 1;
    }
    dirs
}

#[tauri::command]
fn watch_project(
    window: tauri::WebviewWindow,
    root: String,
    exclusions: Vec<String>,
    show_hidden: bool,
    show_ignored: bool,
    directories: Option<Vec<String>>,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let _ = (window, root, exclusions, show_hidden, show_ignored, directories);
        return Ok(());
    }

    #[cfg(not(target_os = "android"))]
    {
        use notify::Watcher;
        let root = PathBuf::from(&root)
            .canonicalize()
            .map_err(|e| format!("could not watch project '{root}': {e}"))?;
        if !root.is_dir() {
            return Err(format!(
                "project root is not a directory: {}",
                root.display()
            ));
        }
        let policy = Arc::new(workspace_policy(
            &root,
            &exclusions,
            show_hidden,
            show_ignored,
        )?);
        let project_root = root.to_string_lossy().into_owned();
        let window_label = window.label().to_string();
        let pending_changes: Arc<Mutex<HashMap<String, String>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let emit_scheduled = Arc::new(AtomicBool::new(false));
        let watch_root = root.clone();
        let event_policy = policy.clone();
        let watcher_window = window.clone();
        let changes_for_event = pending_changes.clone();
        let scheduled_for_event = emit_scheduled.clone();
        let root_for_event = project_root.clone();
        let watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| match event {
                Ok(event) if matches!(event.kind, notify::EventKind::Access(_)) => {}
                Ok(event) => {
                    let kind = match &event.kind {
                        notify::EventKind::Create(_) => "create",
                        notify::EventKind::Remove(_) => "delete",
                        notify::EventKind::Modify(_) => "modify",
                        _ => "modify",
                    };
                    let mut changed = false;
                    {
                        let mut guard = changes_for_event
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        for path in event.paths {
                            if watch_path_ignored(&path, &watch_root, &event_policy) {
                                continue;
                            }
                            changed |=
                                record_workspace_change(&mut guard, path.to_string_lossy(), kind);
                        }
                    }
                    if changed {
                        schedule_workspace_changes(
                            watcher_window.clone(),
                            root_for_event.clone(),
                            changes_for_event.clone(),
                            scheduled_for_event.clone(),
                        );
                    }
                }
                Err(error) => {
                    if let Err(emit_error) =
                        watcher_window.emit("architecture://watch-error", error.to_string())
                    {
                        eprintln!(
                            "project watcher failed ({error}); event delivery failed: {emit_error}"
                        );
                    }
                }
            })
            .map_err(|e| format!("could not start project watcher: {e}"))?;
        let mut watcher = watcher;
        let dirs = match directories {
            Some(paths) if !paths.is_empty() => {
                // Reuse the directories from the current workspace snapshot.
                // Validate them like any other caller input, and keep the root
                // even when the supplied list is unusable.
                let mut validated = vec![root.clone()];
                for path in paths {
                    let candidate = PathBuf::from(path);
                    let Ok(canonical) = candidate.canonicalize() else {
                        continue;
                    };
                    if !canonical.is_dir()
                        || !canonical.starts_with(&root)
                        || watch_path_ignored(&canonical, &root, &policy)
                        || validated.contains(&canonical)
                    {
                        continue;
                    }
                    if validated.len() >= WATCHED_DIR_LIMIT {
                        break;
                    }
                    validated.push(canonical);
                }
                validated
            }
            _ => collect_watch_dirs(&root, &policy),
        };
        let mut watched = 0;
        let mut failed = 0usize;
        for dir in dirs {
            if watcher
                .watch(&dir, notify::RecursiveMode::NonRecursive)
                .is_ok()
            {
                watched += 1;
            } else {
                failed += 1;
            }
        }
        if watched == 0 {
            return Err(format!(
                "could not watch {}: no accessible directories",
                root.display()
            ));
        }
        if failed > 0 {
            let message = format!(
                "Watching {failed} directories failed; changes there may be missed. Use Refresh."
            );
            let _ = window.emit("architecture://watch-error", message);
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

// ---------- integrated version control ----------
// All Git work goes through the git CLI so Talos stays offline-first and does
// not ship another VCS implementation. Network commands only run when the user
// explicitly presses Fetch, Pull, or Push.

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GitFileStatus {
    path: String,
    status: String,
    staged: bool,
    conflict: bool,
    original_path: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GitRepoInfo {
    root: String,
    branch: String,
    upstream: Option<String>,
    remote: Option<String>,
    ahead: u32,
    behind: u32,
    detached: bool,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GitBranch {
    name: String,
    current: bool,
    upstream: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GitRemote {
    name: String,
    url: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GitCommit {
    hash: String,
    short_hash: String,
    subject: String,
    author: String,
    date: String,
}

const MAX_GIT_PATHS: usize = 500;
const MAX_GIT_PATH_BYTES: usize = 4096;
const MAX_GIT_PREVIEW_BYTES: usize = 256 * 1024;

fn validate_git_root(root: &str) -> Result<PathBuf, String> {
    if root.trim().is_empty() || root.len() > MAX_GIT_PATH_BYTES {
        return Err("Invalid workspace folder for Git".into());
    }
    let path = PathBuf::from(root);
    if !path.is_dir() {
        return Err("The workspace folder no longer exists".into());
    }
    Ok(path)
}

fn validate_git_paths(paths: Vec<String>) -> Result<Vec<String>, String> {
    if paths.len() > MAX_GIT_PATHS {
        return Err(format!("Too many files selected (maximum {MAX_GIT_PATHS})"));
    }
    for path in &paths {
        if path.is_empty()
            || path.len() > MAX_GIT_PATH_BYTES
            || path.contains('\0')
            || path.contains('\n')
        {
            return Err("Invalid file path for Git".into());
        }
    }
    Ok(paths)
}

fn validate_git_ref(name: &str, label: &str) -> Result<String, String> {
    if name.is_empty()
        || name.len() > 200
        || name.starts_with('-')
        || name.contains('\0')
        || name.contains('\n')
        || name.contains("..")
    {
        return Err(format!("Invalid Git {label}"));
    }
    Ok(name.to_string())
}

fn relative_git_path(path: &str) -> Result<PathBuf, String> {
    if path.is_empty() || path.len() > MAX_GIT_PATH_BYTES || path.contains('\0') {
        return Err("Invalid repository-relative path".into());
    }
    let relative = Path::new(path);
    if relative.is_absolute() {
        return Err("Only repository-relative paths are supported".into());
    }
    for component in relative.components() {
        if !matches!(component, Component::Normal(_) | Component::CurDir) {
            return Err("Only repository-relative paths are supported".into());
        }
    }
    Ok(relative.to_path_buf())
}

fn contained_git_file_in(base_dir: &Path, path: &str) -> Result<PathBuf, String> {
    let base = fs::canonicalize(base_dir)
        .map_err(|error| format!("could not resolve repository folder: {error}"))?;
    let joined = base.join(relative_git_path(path)?);
    match fs::canonicalize(&joined) {
        Ok(canonical) if canonical.starts_with(&base) => Ok(canonical),
        Ok(_) => Err("Path escapes the repository folder".into()),
        Err(_) if joined.starts_with(&base) => Ok(joined),
        Err(_) => Err("Path escapes the repository folder".into()),
    }
}

fn git_toplevel(root: &str) -> Result<PathBuf, String> {
    let cache_key = root.to_string();
    if let Some(cached) = cached_git_toplevel(&cache_key) {
        return Ok(cached);
    }
    let root_path = validate_git_root(root)?;
    let output = Command::new("git")
        .arg("-C")
        .arg(&root_path)
        .arg("rev-parse")
        .arg("--show-toplevel")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .map_err(|error| format!("could not run git: {error}"))?;
    if !output.status.success() {
        return Err("No Git repository found at this workspace".into());
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        return Err("Git returned an empty repository path".into());
    }
    let toplevel = PathBuf::from(text);
    GIT_TOPLEVEL_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(cache_key, toplevel.clone());
    Ok(toplevel)
}

// Every path-oriented command runs from the repository root. Git's porcelain
// status reports repository-relative paths, so using a nested workspace root
// here would make stage/unstage/diff resolve those paths from the wrong folder.
fn git_command(root: &str) -> Result<Command, String> {
    let toplevel = git_toplevel(root)?;
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(toplevel)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0");
    Ok(cmd)
}

fn git_failure(action: &str, output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if stderr.is_empty() { stdout } else { stderr };
    format!("{action} failed: {detail}")
}

fn run_git(mut cmd: Command, action: &str) -> Result<String, String> {
    let output = cmd.output().map_err(|error| format!("could not run git: {error}"))?;
    if !output.status.success() {
        return Err(git_failure(action, &output));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn run_git_combined(mut cmd: Command, action: &str) -> Result<String, String> {
    let output = cmd.output().map_err(|error| format!("could not run git: {error}"))?;
    if !output.status.success() {
        return Err(git_failure(action, &output));
    }
    let mut result = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        if !result.is_empty() {
            result.push('\n');
        }
        result.push_str(&stderr);
    }
    Ok(result)
}

fn git_status_label(code: char) -> &'static str {
    match code {
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'T' => "type changed",
        '?' => "untracked",
        '!' => "ignored",
        'M' => "modified",
        _ => "modified",
    }
}

fn parse_git_status(bytes: &[u8]) -> Vec<GitFileStatus> {
    let mut result = Vec::new();
    let mut records = bytes.split(|byte| *byte == 0).peekable();
    while let Some(record) = records.next() {
        if record.len() < 3 {
            continue;
        }
        let staged_code = record[0] as char;
        let worktree_code = record[1] as char;
        if staged_code == '!' && worktree_code == '!' {
            continue;
        }
        let path = String::from_utf8_lossy(&record[3..]).into_owned();
        if path.is_empty() {
            continue;
        }
        // Rename/copy records carry one source path per renamed side. A
        // rename/rename conflict carries two; consuming both keeps the record
        // stream aligned so the next real change is not swallowed.
        let source_count = usize::from(matches!(staged_code, 'R' | 'C'))
            + usize::from(matches!(worktree_code, 'R' | 'C'));
        let mut original_path = None;
        for _ in 0..source_count {
            if let Some(source) = records.next() {
                let source = String::from_utf8_lossy(source).into_owned();
                if !source.is_empty() && original_path.is_none() {
                    original_path = Some(source);
                }
            }
        }
        let conflict = staged_code == 'U'
            || worktree_code == 'U'
            || matches!(
                (staged_code, worktree_code),
                ('A', 'A') | ('D', 'D') | ('R', 'R') | ('R', 'C') | ('C', 'R') | ('C', 'C')
            );
        if conflict {
            result.push(GitFileStatus {
                path,
                status: "conflict".into(),
                staged: false,
                conflict: true,
                original_path,
            });
            continue;
        }
        if staged_code != ' ' && staged_code != '?' {
            result.push(GitFileStatus {
                path: path.clone(),
                status: git_status_label(staged_code).into(),
                staged: true,
                conflict: false,
                original_path: original_path.clone(),
            });
        }
        if worktree_code != ' ' {
            result.push(GitFileStatus {
                path,
                status: git_status_label(worktree_code).into(),
                staged: false,
                conflict: false,
                original_path,
            });
        }
    }
    result
}

fn parse_git_log(text: &str) -> Vec<GitCommit> {
    text.split('\x1e')
        .filter_map(|record| {
            let record = record.trim_matches('\n').trim();
            if record.is_empty() {
                return None;
            }
            let mut fields = record.split('\x1f');
            let hash = fields.next().unwrap_or_default().to_string();
            if hash.is_empty() {
                return None;
            }
            Some(GitCommit {
                short_hash: fields.next().unwrap_or_default().to_string(),
                subject: fields.next().unwrap_or("(no subject)").to_string(),
                author: fields.next().unwrap_or("unknown").to_string(),
                date: fields.next().unwrap_or_default().to_string(),
                hash,
            })
        })
        .collect()
}

#[tauri::command]
async fn git_status(root: String) -> Result<Vec<GitFileStatus>, String> {
    let mut cmd = git_command(&root)?;
    cmd.arg("status").arg("--porcelain=v1").arg("-z").arg("-uall");
    let output = cmd.output().map_err(|error| format!("could not run git: {error}"))?;
    if !output.status.success() {
        return Err(git_failure("git status", &output));
    }
    Ok(parse_git_status(&output.stdout))
}

#[tauri::command]
async fn git_repo_info(root: String) -> Result<Option<GitRepoInfo>, String> {
    let root_path = validate_git_root(&root)?;
    let mut probe = Command::new("git");
    probe
        .arg("-C")
        .arg(&root_path)
        .arg("rev-parse")
        .arg("--is-inside-work-tree")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0");
    match probe.output() {
        Ok(output) if output.status.success() => {}
        Ok(_) => return Ok(None),
        Err(error) => return Err(format!("could not run git: {error}")),
    }

    let toplevel = git_toplevel(&root)?;

    let mut branch_cmd = git_command(&root)?;
    branch_cmd.arg("symbolic-ref").arg("--short").arg("HEAD");
    let (branch, detached) = match branch_cmd.output() {
        Ok(output) if output.status.success() => {
            (String::from_utf8_lossy(&output.stdout).trim().to_string(), false)
        }
        _ => {
            let mut hash_cmd = git_command(&root)?;
            hash_cmd.arg("rev-parse").arg("--short").arg("HEAD");
            let hash = run_git(hash_cmd, "git rev-parse")?.trim().to_string();
            (format!("detached@{hash}"), true)
        }
    };

    let mut upstream_cmd = git_command(&root)?;
    upstream_cmd
        .arg("rev-parse")
        .arg("--abbrev-ref")
        .arg("--symbolic-full-name")
        .arg("@{u}");
    let upstream = upstream_cmd
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty());

    let mut remote = None;
    if !detached {
        let mut remote_cmd = git_command(&root)?;
        remote_cmd
            .arg("config")
            .arg("--get")
            .arg(format!("branch.{branch}.remote"));
        remote = remote_cmd
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .filter(|value| !value.is_empty());
    }
    if remote.is_none() {
        let mut remotes_cmd = git_command(&root)?;
        remotes_cmd.arg("remote");
        remote = run_git(remotes_cmd, "git remote")
            .ok()
            .and_then(|text| text.lines().next().map(str::to_string))
            .filter(|value| !value.is_empty());
    }

    let (mut ahead, mut behind) = (0u32, 0u32);
    if upstream.is_some() {
        let mut count_cmd = git_command(&root)?;
        count_cmd.arg("rev-list").arg("--left-right").arg("--count").arg("HEAD...@{u}");
        if let Ok(counts) = run_git(count_cmd, "git rev-list") {
            let mut values = counts.split_whitespace();
            ahead = values.next().and_then(|value| value.parse().ok()).unwrap_or(0);
            behind = values.next().and_then(|value| value.parse().ok()).unwrap_or(0);
        }
    }

    Ok(Some(GitRepoInfo {
        root: toplevel.to_string_lossy().into_owned(),
        branch,
        upstream,
        remote,
        ahead,
        behind,
        detached,
    }))
}

#[tauri::command]
async fn git_branches(root: String) -> Result<Vec<GitBranch>, String> {
    let mut cmd = git_command(&root)?;
    cmd.arg("for-each-ref")
        .arg("--format=%(refname:short)%09%(HEAD)%09%(upstream:short)")
        .arg("refs/heads");
    let text = run_git(cmd, "git branch")?;
    Ok(text
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(3, '\t');
            let name = fields.next()?.to_string();
            if name.is_empty() {
                return None;
            }
            let current = fields.next() == Some("*");
            let upstream = fields
                .next()
                .map(str::to_string)
                .filter(|value| !value.is_empty());
            Some(GitBranch {
                name,
                current,
                upstream,
            })
        })
        .collect())
}

#[tauri::command]
async fn git_checkout(root: String, branch: String) -> Result<String, String> {
    let branch = validate_git_ref(&branch, "branch")?;
    let mut cmd = git_command(&root)?;
    cmd.arg("switch").arg("--").arg(branch);
    run_git_combined(cmd, "git switch")
}

fn parse_git_remotes(text: &str) -> Vec<GitRemote> {
    let mut result: Vec<GitRemote> = Vec::new();
    for line in text.lines() {
        let Some((name, target)) = line.split_once('\t') else {
            continue;
        };
        let name = name.trim();
        let Some(url) = target.trim().strip_suffix(" (fetch)") else {
            continue;
        };
        if name.is_empty() || url.is_empty() || result.iter().any(|remote| remote.name == name) {
            continue;
        }
        result.push(GitRemote {
            name: name.to_string(),
            url: url.to_string(),
        });
        if result.len() >= 50 {
            break;
        }
    }
    result
}

#[tauri::command]
async fn git_remotes(root: String) -> Result<Vec<GitRemote>, String> {
    // Git prints both fetch and push URLs for every remote. One command gives
    // the full list; the old loop spawned another `git config` per remote.
    let mut cmd = git_command(&root)?;
    cmd.arg("remote").arg("-v");
    Ok(parse_git_remotes(&run_git(cmd, "git remote -v")?))
}

async fn git_sync_command(
    root: &str,
    remote: Option<String>,
    branch: Option<String>,
    verb: &str,
) -> Result<String, String> {
    let mut cmd = git_command(root)?;
    cmd.arg(verb).arg("--no-edit");
    if let Some(remote) = remote {
        cmd.arg("--").arg(validate_git_ref(&remote, "remote")?);
        if let Some(branch) = branch {
            cmd.arg(validate_git_ref(&branch, "branch")?);
        }
    }
    run_git_combined(cmd, &format!("git {verb}"))
}

#[tauri::command]
async fn git_fetch(root: String, remote: Option<String>) -> Result<String, String> {
    let mut cmd = git_command(&root)?;
    cmd.arg("fetch").arg("--prune");
    if let Some(remote) = remote {
        cmd.arg("--").arg(validate_git_ref(&remote, "remote")?);
    }
    run_git_combined(cmd, "git fetch")
}

#[tauri::command]
async fn git_pull(root: String, remote: Option<String>, branch: Option<String>) -> Result<String, String> {
    git_sync_command(&root, remote, branch, "pull").await
}

#[tauri::command]
async fn git_push(root: String, remote: Option<String>, branch: Option<String>) -> Result<String, String> {
    let mut cmd = git_command(&root)?;
    cmd.arg("push");
    if let Some(remote) = remote {
        cmd.arg("--").arg(validate_git_ref(&remote, "remote")?);
        if let Some(branch) = branch {
            cmd.arg(validate_git_ref(&branch, "branch")?);
        }
    }
    run_git_combined(cmd, "git push")
}

#[tauri::command]
async fn git_log(root: String, limit: Option<usize>) -> Result<Vec<GitCommit>, String> {
    let limit = limit.unwrap_or(12).clamp(1, 100);
    let mut cmd = git_command(&root)?;
    cmd.arg("log")
        .arg("-n")
        .arg(limit.to_string())
        .arg("--date=short")
        .arg("--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ad%x1e");
    Ok(parse_git_log(&run_git(cmd, "git log")?))
}

#[tauri::command]
async fn git_commit_diff(root: String, hash: String) -> Result<String, String> {
    if hash.is_empty()
        || hash.len() > 64
        || !hash.chars().all(|value| value.is_ascii_hexdigit())
    {
        return Err("Invalid commit hash".into());
    }
    let mut cmd = git_command(&root)?;
    cmd.arg("show")
        .arg("--no-ext-diff")
        .arg("--format=fuller")
        .arg("--no-color")
        .arg(hash);
    run_git(cmd, "git show")
}

#[tauri::command]
async fn git_stage(root: String, paths: Vec<String>) -> Result<(), String> {
    let paths = validate_git_paths(paths)?;
    if paths.is_empty() {
        return Ok(());
    }
    let mut cmd = git_command(&root)?;
    cmd.arg("add").arg("--").args(paths);
    run_git(cmd, "git add")?;
    Ok(())
}

#[tauri::command]
async fn git_unstage(root: String, paths: Vec<String>) -> Result<(), String> {
    let paths = validate_git_paths(paths)?;
    if paths.is_empty() {
        return Ok(());
    }
    let mut restore = git_command(&root)?;
    restore.arg("restore").arg("--staged").arg("--").args(&paths);
    if restore.output().is_ok_and(|output| output.status.success()) {
        return Ok(());
    }
    // A newly added file in a repository with no commits cannot be restored
    // from HEAD. Removing it from the index keeps the working file untouched.
    let mut cached = git_command(&root)?;
    cached.arg("rm").arg("--cached").arg("--").args(paths);
    run_git(cached, "git restore --staged")?;
    Ok(())
}

#[tauri::command]
async fn git_discard(root: String, paths: Vec<String>) -> Result<(), String> {
    let paths = validate_git_paths(paths)?;
    if paths.is_empty() {
        return Ok(());
    }
    // `git restore --` alone fails for untracked files and leaves staged
    // additions in the index. Reset both index and worktree, then clean any
    // file that is still untracked (including a newly staged addition).
    let mut restore = git_command(&root)?;
    restore
        .arg("restore")
        .arg("--staged")
        .arg("--worktree")
        .arg("--")
        .args(&paths);
    let restored = restore.output().is_ok_and(|output| output.status.success());
    if !restored {
        let mut cached = git_command(&root)?;
        cached.arg("rm").arg("--cached").arg("--").args(&paths);
        // Missing HEAD entries and untracked files are expected here; the
        // clean pass below is what removes them from the worktree.
        let _ = cached.output();
    }
    let mut clean = git_command(&root)?;
    clean.arg("clean").arg("-f").arg("--").args(&paths);
    run_git(clean, "git clean")?;
    Ok(())
}

fn gitignore_pattern(path: &str) -> String {
    let mut pattern = String::from("/");
    for character in path.chars() {
        match character {
            '\\' | '#' | '!' | '[' | ']' | '*' | '?' | ' ' => {
                pattern.push('\\');
                pattern.push(character);
            }
            _ => pattern.push(character),
        }
    }
    pattern
}

#[tauri::command]
async fn git_ignore(root: String, paths: Vec<String>) -> Result<usize, String> {
    let paths = validate_git_paths(paths)?;
    if paths.is_empty() {
        return Ok(0);
    }
    let mut normalized = Vec::new();
    for path in paths {
        let relative = relative_git_path(&path)?;
        let entry = relative.to_string_lossy().trim().to_string();
        if !entry.is_empty() && !normalized.contains(&entry) {
            normalized.push(entry);
        }
    }
    let toplevel = git_toplevel(&root)?;
    let file_path = contained_git_file_in(&toplevel, ".gitignore")?;
    let _guard = FILE_WRITE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut existing = fs::read_to_string(&file_path).unwrap_or_default();
    let mut added = 0usize;
    for entry in normalized {
        let pattern = gitignore_pattern(&entry);
        if existing.lines().any(|line| line.trim() == entry || line.trim() == pattern) {
            continue;
        }
        if !existing.is_empty() && !existing.ends_with('\n') {
            existing.push('\n');
        }
        existing.push_str(&pattern);
        existing.push('\n');
        added += 1;
    }
    if added > 0 {
        fs::write(&file_path, existing)
            .map_err(|error| format!("could not update .gitignore: {error}"))?;
    }
    Ok(added)
}

#[tauri::command]
async fn git_init(root: String) -> Result<String, String> {
    let root = validate_git_root(&root)?;
    let output = Command::new("git")
        .arg("init")
        .arg(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| format!("could not run git: {error}"))?;
    if !output.status.success() {
        return Err(git_failure("git init", &output));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
async fn git_diff(root: String, path: String, staged: Option<bool>) -> Result<String, String> {
    let path = validate_git_paths(vec![path])?
        .pop()
        .ok_or("Invalid file path for Git")?;
    let mut cmd = git_command(&root)?;
    cmd.arg("diff").arg("--no-ext-diff").arg("--no-color");
    if staged.unwrap_or(false) {
        cmd.arg("--cached");
    }
    cmd.arg("--").arg(path);
    run_git(cmd, "git diff")
}

#[tauri::command]
async fn git_file_preview(root: String, path: String) -> Result<String, String> {
    let toplevel = git_toplevel(&root)?;
    let file = contained_git_file_in(&toplevel, &path)?;
    let bytes = fs::read(&file).map_err(|error| format!("could not read file: {error}"))?;
    if bytes.contains(&0) {
        return Ok(format!("Binary file: {path}\nOpen it in the file viewer for a hex preview."));
    }
    let take = bytes.len().min(MAX_GIT_PREVIEW_BYTES);
    let text = String::from_utf8_lossy(&bytes[..take]);
    let lines = text.lines().collect::<Vec<_>>();
    let body = lines
        .iter()
        .map(|line| format!("+{line}"))
        .collect::<Vec<_>>()
        .join("\n");
    let truncated = if bytes.len() > take {
        "\n… preview truncated …"
    } else {
        ""
    };
    Ok(format!(
        "--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{} @@\n{body}{truncated}",
        lines.len()
    ))
}

#[tauri::command]
async fn git_commit(root: String, message: String) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("Commit message cannot be empty".into());
    }
    let mut cmd = git_command(&root)?;
    cmd.arg("commit").arg("-m").arg(message);
    run_git_combined(cmd, "git commit")
}

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
            let entry =
                entry.map_err(|error| format!("could not read extension entry: {error}"))?;
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
                .unwrap_or(
                    required.is_empty()
                        || required
                            .iter()
                            .all(|permission| granted.contains(permission)),
                );
            let rollback_manifest = dir.join("rollback").join(&id).join("manifest.json");
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
            let rollback_available =
                rollback_version.is_some() && rollback_version != current_version.as_deref();
            let object = manifest.as_object_mut().ok_or_else(|| {
                format!("extension {} manifest must be an object", path.display())
            })?;
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
    expected_kind: Option<String>,
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
    if expected_kind
        .as_deref()
        .is_some_and(|expected| expected != kind)
    {
        return Err(format!(
            "manifest kind '{kind}' does not match registry kind '{}'",
            expected_kind.unwrap_or_default()
        ));
    }
    if approved_permissions
        .iter()
        .any(|permission| permission != "process.execution")
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
        let dependency_text = fs::read_to_string(&dependency_path).map_err(|_| {
            format!("required extension dependency '{dependency}' is not installed")
        })?;
        let dependency_manifest: serde_json::Value = serde_json::from_str(&dependency_text)
            .map_err(|error| format!("invalid dependency '{dependency}': {error}"))?;
        if dependency_manifest
            .get("version")
            .and_then(serde_json::Value::as_str)
            .is_none_or(|version| !valid_semver(version))
        {
            return Err(format!(
                "dependency '{dependency}' has an invalid installed version"
            ));
        }
    }

    let dir = ext_dir();
    let manifest_path = dir.join(format!("{expected_id}.json"));
    let language_path = dir.join("languages").join(format!("{expected_id}.json"));
    let previous_manifest = read_optional_bytes(&manifest_path)?;
    let previous_language = read_optional_bytes(&language_path)?;
    let mut state = read_extension_state()?;
    if let Some(previous_bytes) = &previous_manifest {
        let previous_value: serde_json::Value =
            serde_json::from_slice(previous_bytes).map_err(|error| {
                format!("installed extension is invalid and must be removed first: {error}")
            })?;
        if let Some(publisher) = previous_value
            .get("publisher")
            .or_else(|| previous_value.get("author"))
        {
            let next_publisher = v.get("publisher").or_else(|| v.get("author"));
            if next_publisher != Some(publisher) {
                return Err("publisher identity changed for this extension id".into());
            }
        }
        let installed_version = previous_value
            .get("version")
            .and_then(serde_json::Value::as_str)
            .ok_or("installed extension has no version")?;
        if !valid_semver(installed_version)
            || compare_semver(&expected_version, installed_version) <= 0
        {
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
            v.get("language")
                .ok_or("language extension needs a 'language' section")?,
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
            return Err(format!(
                "{error}; restoring previous language config failed: {rollback_error}"
            ));
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
            return Err(format!(
                "{error}; restoring previous extension files failed: {rollback_error}"
            ));
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
        None => match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("could not remove {}: {error}", path.display())),
        },
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
    let mut state = read_extension_state()?;
    let previous_permissions = state
        .get(&id)
        .and_then(|status| status.get("permissions"))
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    // Disabling must never discard an approval the user already granted.
    let effective_permissions = if enabled { permissions } else { previous_permissions };
    if effective_permissions
        .iter()
        .any(|permission| permission != "process.execution")
        || (enabled
            && required
                .iter()
                .any(|permission| !effective_permissions.contains(permission)))
    {
        return Err("required extension permissions were not explicitly approved".into());
    }
    state.insert(
        id,
        serde_json::json!({ "enabled": enabled, "permissions": effective_permissions }),
    );
    let contents = serde_json::to_string_pretty(&state).map_err(|error| error.to_string())?;
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

    fs::create_dir_all(
        current_manifest_path
            .parent()
            .ok_or("invalid extension path")?,
    )
    .map_err(|error| error.to_string())?;
    if kind == "language" {
        fs::create_dir_all(
            current_language_path
                .parent()
                .ok_or("invalid language path")?,
        )
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
            return Err(format!(
                "{error}; restoring current language config failed: {rollback_error}"
            ));
        }
        return Err(error);
    }
    let state_text =
        serde_json::to_string_pretty(&next_state).map_err(|error| error.to_string())?;
    if let Err(error) = write_atomic(&extension_state_path(), &state_text) {
        let manifest_rollback = restore_file(&current_manifest_path, current_manifest.as_deref());
        let language_rollback = restore_file(&current_language_path, current_language.as_deref());
        if let Err(rollback_error) = manifest_rollback.and(language_rollback) {
            return Err(format!(
                "{error}; restoring current extension failed: {rollback_error}"
            ));
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
            return Err(format!(
                "could not read extension language config '{id}': {error}"
            ));
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
                return Err(format!(
                    "{error}; extension removal rollback failed: {rollback_error}"
                ));
            }
            return Err(format!(
                "could not remove language config for '{id}': {error}"
            ));
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
                    return Err(format!("invalid python module name '{}'", requirement.name));
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

#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum RunEvent {
    Start { id: String, language: String },
    Output { id: String, stream: String, text: String },
    End { id: String, code: i32 },
    Error { id: String, message: String },
}

fn split_run_arguments(input: &str) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaping = false;
    let mut has_token = false;

    for ch in input.chars() {
        if escaping {
            current.push(ch);
            has_token = true;
            escaping = false;
            continue;
        }
        match quote {
            Some('\'') => {
                if ch == '\'' {
                    quote = None;
                } else {
                    current.push(ch);
                }
                has_token = true;
            }
            Some('"') => {
                if ch == '\\' {
                    escaping = true;
                } else if ch == '"' {
                    quote = None;
                } else {
                    current.push(ch);
                }
                has_token = true;
            }
            _ => {
                if ch == '\\' {
                    escaping = true;
                    has_token = true;
                } else if ch == '\'' || ch == '"' {
                    quote = Some(ch);
                    has_token = true;
                } else if ch.is_whitespace() {
                    if has_token {
                        result.push(std::mem::take(&mut current));
                        has_token = false;
                    }
                } else {
                    current.push(ch);
                    has_token = true;
                }
            }
        }
    }

    if escaping {
        current.push('\\');
        has_token = true;
    }
    if quote.is_some() {
        return Err("run arguments contain an unclosed quote".into());
    }
    if has_token {
        result.push(current);
    }
    Ok(result)
}

#[cfg(windows)]
fn quote_run_argument(token: &str) -> String {
    format!("\"{}\"", token.replace('%', "%%").replace('"', "\"\""))
}

#[cfg(not(windows))]
fn quote_run_argument(token: &str) -> String {
    format!("'{}'", token.replace('\'', "'\\''"))
}

fn append_run_arguments(command: &str, args: &str) -> Result<String, String> {
    if args.trim().is_empty() {
        return Ok(command.to_string());
    }
    if args.len() > 4096 {
        return Err("run arguments are too long".into());
    }
    if args.contains('\0') {
        return Err("run arguments contain an invalid character".into());
    }
    let mut result = command.to_string();
    for token in split_run_arguments(args)? {
        result.push(' ');
        result.push_str(&quote_run_argument(&token));
    }
    Ok(result)
}

fn run_process_command(lang: &Language, path: &Path, args: &str) -> Result<Command, String> {
    let base = lang
        .run_command(path)
        .ok_or_else(|| format!("{} has no run command configured", lang.name))?;
    let cmd = append_run_arguments(&base, args)?;
    let mut command;
    #[cfg(windows)]
    {
        command = Command::new("cmd");
        command.arg("/C").arg(&cmd);
    }
    #[cfg(not(windows))]
    {
        command = Command::new("sh");
        command.arg("-c").arg(&cmd);
    }
    // AppImage runtimes export these for their own bundled libraries. When a
    // user runs source code, a child shell must see the normal system Python
    // environment instead of the temporary AppImage mount.
    #[cfg(unix)]
    {
        for key in ["PYTHONHOME", "PYTHONPATH", "LD_LIBRARY_PATH", "APPDIR", "APPIMAGE"] {
            if std::env::var(key).is_ok_and(|value| value.contains(".mount_")) {
                command.env_remove(key);
            }
        }
    }
    Ok(command)
}

fn run_language(lang: &Language, path: &Path) -> Result<RunResult, String> {
    let mut command = run_process_command(lang, path, "")?;
    let out = command
        .output()
        .map_err(|e| format!("failed to start run command: {e}"))?;
    Ok(RunResult {
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        code: out.status.code().unwrap_or(-1),
        language: lang.name.clone(),
    })
}

fn valid_run_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn pump_run_stream<R: Read + Send + 'static>(
    app: &tauri::AppHandle,
    id: String,
    stream: &str,
    mut reader: R,
) {
    let mut buffer = [0u8; 4096];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                let text = String::from_utf8_lossy(&buffer[..count]).into_owned();
                let _ = app.emit(
                    "talos://run-event",
                    RunEvent::Output {
                        id: id.clone(),
                        stream: stream.to_string(),
                        text,
                    },
                );
            }
            Err(error) => {
                let _ = app.emit(
                    "talos://run-event",
                    RunEvent::Error {
                        id: id.clone(),
                        message: format!("run {stream} failed: {error}"),
                    },
                );
                break;
            }
        }
    }
}

/// Start a run with a writable stdin so `input()` and similar prompts work.
fn spawn_interactive_run(
    app: &tauri::AppHandle,
    run_id: String,
    lang: &Language,
    path: &Path,
    cleanup_dir: Option<PathBuf>,
    args: &str,
) -> Result<(), String> {
    let mut command = run_process_command(lang, path, args)?;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to start run command: {e}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "could not open run input".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "could not capture run output".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "could not capture run errors".to_string())?;

    active_run_stdin_map()
        .lock()
        .map_err(|e| format!("run input state lock failed: {e}"))?
        .insert(run_id.clone(), stdin);

    let _ = app.emit(
        "talos://run-event",
        RunEvent::Start {
            id: run_id.clone(),
            language: lang.name.clone(),
        },
    );

    let out_app = app.clone();
    let out_id = run_id.clone();
    std::thread::spawn(move || pump_run_stream(&out_app, out_id, "stdout", stdout));
    let err_app = app.clone();
    let err_id = run_id.clone();
    std::thread::spawn(move || pump_run_stream(&err_app, err_id, "stderr", BufReader::new(stderr)));

    let wait_app = app.clone();
    let wait_id = run_id;
    std::thread::spawn(move || {
        let code = child
            .wait()
            .map(|status| status.code().unwrap_or(-1))
            .unwrap_or(-1);
        if let Ok(mut runs) = active_run_stdin_map().lock() {
            runs.remove(&wait_id);
        }
        if let Some(dir) = cleanup_dir {
            let _ = fs::remove_dir_all(&dir);
        }
        let _ = wait_app.emit("talos://run-event", RunEvent::End { id: wait_id, code });
    });
    Ok(())
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
        let entry =
            entry.map_err(|error| format!("could not read extension language entry: {error}"))?;
        let path = entry.path();
        if !entry
            .file_type()
            .map_err(|error| format!("could not inspect {}: {error}", path.display()))?
            .is_file()
            || path.extension().and_then(|extension| extension.to_str()) != Some("json")
        {
            continue;
        }
        let id = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or_default();
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
                permissions
                    .iter()
                    .any(|permission| permission.as_str() == Some("process.execution"))
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

fn resolve_language_for_path(resource_dir: Option<&Path>, path: &Path) -> Result<Language, String> {
    let mut found = None;
    for d in languages_dirs(resource_dir).iter() {
        if let Ok(reg) = Registry::load_dir(d) {
            if let Some(l) = reg.detect(path) {
                found = Some(l.clone());
                break;
            }
        }
    }
    if found.is_none() {
        found = enabled_extension_languages()?.into_iter().find(|language| {
            language.extensions.iter().any(|extension| {
                path.extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|actual| extension.eq_ignore_ascii_case(&format!(".{actual}")))
            })
        });
    }
    found.ok_or_else(|| {
        format!(
            "no language configured for {} (add one in languages/ or install a language extension)",
            path.display()
        )
    })
}

fn resolve_language_for_source(
    resource_dir: Option<&Path>,
    language_id: Option<&str>,
    file_name: Option<&str>,
) -> Result<Language, String> {
    let mut found = None;
    for d in languages_dirs(resource_dir).iter() {
        if let Ok(reg) = Registry::load_dir(d) {
            let lang = match language_id {
                Some(id) => reg.by_id(id),
                None => file_name.and_then(|name| reg.detect(Path::new(name))),
            };
            if let Some(lang) = lang {
                found = Some(lang.clone());
                break;
            }
        }
    }
    if found.is_none() {
        found = enabled_extension_languages()?.into_iter().find(|language| {
            match language_id {
                Some(id) => language.id == id,
                None => file_name
                    .and_then(|name| Path::new(name).extension())
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|actual| {
                        language
                            .extensions
                            .iter()
                            .any(|extension| extension.eq_ignore_ascii_case(&format!(".{actual}")))
                    }),
            }
        });
    }
    found.ok_or_else(|| match language_id {
        Some(id) => format!("No run configuration found for language '{id}'."),
        None => "Choose a run language or save the file with a recognized extension.".to_string(),
    })
}

fn write_temporary_source(lang: &Language, source: String) -> Result<(PathBuf, PathBuf), String> {
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
    Ok((dir, path))
}

async fn run_file_impl(resource_dir: Option<&Path>, path: String) -> Result<RunResult, String> {
    let p = Path::new(&path);
    let lang = resolve_language_for_path(resource_dir, p)?;
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
    run_source_impl(resources.as_deref(), &source, language_id.as_deref(), file_name.as_deref())
}

fn run_source_impl(
    resource_dir: Option<&Path>,
    source: &str,
    language_id: Option<&str>,
    file_name: Option<&str>,
) -> Result<RunResult, String> {
    let lang = resolve_language_for_source(resource_dir, language_id, file_name)?;
    let (dir, path) = write_temporary_source(&lang, source.to_string())?;
    let result = run_language(&lang, &path);
    fs::remove_dir_all(&dir).map_err(|e| format!("could not remove temporary run files: {e}"))?;
    result
}

/// Run a saved file with a live stdin channel for interactive prompts.
#[tauri::command]
fn run_file_interactive(
    app: tauri::AppHandle,
    id: String,
    path: String,
    args: Option<String>,
) -> Result<(), String> {
    if !valid_run_id(&id) {
        return Err("invalid run identifier".into());
    }
    let resources = app.path().resource_dir().ok();
    let p = Path::new(&path);
    let lang = resolve_language_for_path(resources.as_deref(), p)?;
    spawn_interactive_run(&app, id, &lang, p, None, args.as_deref().unwrap_or(""))
}

/// Run unsaved editor contents with a live stdin channel.
#[tauri::command]
fn run_source_interactive(
    app: tauri::AppHandle,
    id: String,
    source: String,
    language_id: Option<String>,
    file_name: Option<String>,
    args: Option<String>,
) -> Result<(), String> {
    if !valid_run_id(&id) {
        return Err("invalid run identifier".into());
    }
    let resources = app.path().resource_dir().ok();
    let lang = resolve_language_for_source(
        resources.as_deref(),
        language_id.as_deref(),
        file_name.as_deref(),
    )?;
    let (dir, path) = write_temporary_source(&lang, source)?;
    if let Err(error) = spawn_interactive_run(
        &app,
        id,
        &lang,
        &path,
        Some(dir.clone()),
        args.as_deref().unwrap_or(""),
    ) {
        let _ = fs::remove_dir_all(&dir);
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
fn run_write_stdin(id: String, text: String) -> Result<(), String> {
    if text.len() > 64 * 1024 {
        return Err("run input is too large".into());
    }
    let mut runs = active_run_stdin_map()
        .lock()
        .map_err(|e| format!("run input state lock failed: {e}"))?;
    let stdin = runs
        .get_mut(&id)
        .ok_or_else(|| "this run is no longer accepting input".to_string())?;
    stdin
        .write_all(text.as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("could not send run input: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

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
        let conflict =
            write_file_if_unchanged(&path, "my edits", Some(&original.revision)).unwrap();
        match conflict {
            CheckedWriteOutcome::Conflict { snapshot } => {
                assert_eq!(snapshot.unwrap().contents, "changed by another window");
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
    fn file_snapshots_open_java_and_kotlin_source() {
        let parent = std::env::temp_dir().join(format!(
            "talos-source-file-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&parent).unwrap();
        let java = parent.join("Main.java");
        let kotlin = parent.join("Main.kt");
        fs::write(&java, "class Main {}\n").unwrap();
        fs::write(&kotlin, "fun main() {}\n").unwrap();

        for path in [&java, &kotlin] {
            let snapshot = read_file_snapshot(path).unwrap().unwrap();
            assert!(!snapshot.binary);
            assert!(!snapshot.contents.is_empty());
        }

        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn file_snapshots_decode_utf16_source_files() {
        let parent = std::env::temp_dir().join(format!(
            "talos-utf16-file-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&parent).unwrap();
        let path = parent.join("Utf16.java");
        let text = "class Main {}\n";
        let mut bytes = vec![0xff, 0xfe];
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        fs::write(&path, bytes).unwrap();

        let snapshot = read_file_snapshot(&path).unwrap().unwrap();
        assert!(!snapshot.binary);
        assert_eq!(snapshot.contents, text);

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

        let icon_pack = serde_json::json!({
            "id": "icon-pack-material",
            "name": "Material Icons",
            "kind": "icon-pack",
            "version": "1.0.0",
            "iconPack": {
                "default": "file",
                "mappings": { "py": "python", "js": "javascript" }
            }
        });
        assert_eq!(
            validate_extension_manifest(&icon_pack, "icon-pack-material", "1.0.0")
                .unwrap()
                .0,
            "icon-pack"
        );

        let missing_pack = serde_json::json!({
            "id": "bad-pack",
            "name": "Bad Pack",
            "kind": "icon-pack",
            "version": "1.0.0"
        });
        assert!(validate_extension_manifest(&missing_pack, "bad-pack", "1.0.0").is_err());

        let bad_mapping = serde_json::json!({
            "id": "bad-pack",
            "name": "Bad Pack",
            "kind": "icon-pack",
            "version": "1.0.0",
            "iconPack": {
                "default": "file",
                "mappings": { "py": "<script>" }
            }
        });
        assert!(validate_extension_manifest(&bad_mapping, "bad-pack", "1.0.0").is_err());

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
        assert!(validate_extension_manifest(&language, "lang-test", "1.0.0").is_ok());
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
            assert!(
                !valid_tool_dependency_name(name),
                "expected '{name}' to be rejected"
            );
        }

        let long_module = "a".repeat(64);
        let too_long_module = "a".repeat(65);
        for name in ["os", "_private", "module_2", &long_module] {
            assert!(
                valid_python_module_name(name),
                "expected '{name}' to be valid"
            );
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
            assert!(
                !valid_python_module_name(name),
                "expected '{name}' to be rejected"
            );
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

        let exclusions = [
            ".git",
            "node_modules",
            "__pycache__",
            "dist",
            "build",
            ".venv",
            "vendor",
        ]
        .map(str::to_string);
        let scan = scan_project_tree(root.to_str().unwrap(), &exclusions, true, false, None).unwrap();
        assert_eq!(scan.entries[0].path, root.to_string_lossy());
        assert!(scan
            .entries
            .iter()
            .all(|entry| !entry.path.contains("node_modules")));
        assert_eq!(scan.entries[0].file_count, 2);
        assert!(scan
            .entries
            .iter()
            .any(|entry| entry.name == "src-link" && entry.kind == "link"));
        assert!(!scan
            .entries
            .iter()
            .any(|entry| entry.path.ends_with("src-link/main.ts")));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lazy_directory_listing_respects_policy_and_workspace_boundary() {
        let parent = std::env::temp_dir().join(format!(
            "talos-lazy-directory-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root = parent.join("workspace");
        let outside = parent.join("outside");
        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(root.join("src/main.ts"), "export {};").unwrap();
        fs::write(root.join("src/nested/helper.py"), "pass").unwrap();
        fs::write(root.join("node_modules/ignored.js"), "").unwrap();
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.join("outside-link")).unwrap();

        let exclusions = ["node_modules".to_string()];
        let root_text = root.to_string_lossy().into_owned();
        let listing =
            list_project_directory_at(&root_text, "", &exclusions, false, false, None).unwrap();
        assert_eq!(listing.path, root_text);
        assert_eq!(listing.entry.depth, 0);
        assert_eq!(listing.entry.child_count, listing.entries.len());
        assert!(listing.entries.iter().any(|entry| entry.name == "src"));
        assert!(!listing
            .entries
            .iter()
            .any(|entry| entry.name == "node_modules"));
        assert!(listing
            .entries
            .iter()
            .all(|entry| entry.depth == 1 && entry.parent == root_text));
        #[cfg(unix)]
        assert!(listing
            .entries
            .iter()
            .any(|entry| entry.name == "outside-link" && entry.kind == "link"));

        let src_text = root.join("src").to_string_lossy().into_owned();
        let src = list_project_directory_at(&root_text, &src_text, &exclusions, false, false, None).unwrap();
        assert_eq!(src.entry.depth, 1);
        assert!(src
            .entries
            .iter()
            .any(|entry| entry.name == "nested" && entry.depth == 2));
        assert!(src
            .entries
            .iter()
            .any(|entry| entry.name == "main.ts" && entry.extension == "ts"));

        let ignored = list_project_directory_at(
            &root_text,
            &root.join("node_modules").to_string_lossy(),
            &exclusions,
            false,
            false,
            None,
        )
        .expect_err("an excluded directory must not be listable");
        assert!(ignored.contains("excluded"), "{ignored}");

        let file = list_project_directory_at(
            &root_text,
            &root.join("src/main.ts").to_string_lossy(),
            &exclusions,
            false,
            false,
            None,
        )
        .expect_err("a file is not a directory");
        assert!(file.contains("not a directory"), "{file}");

        let escaped = list_project_directory_at(
            &root_text,
            &outside.to_string_lossy(),
            &exclusions,
            false,
            false,
            None,
        )
        .expect_err("a directory outside the root must be rejected");
        assert!(escaped.contains("outside the workspace"), "{escaped}");

        fs::remove_dir_all(&parent).unwrap();
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

    #[test]
    fn duplicate_project_entry_creates_unique_copies_and_skips_ignored_children() {
        let root = temp_workspace("duplicate-entry");
        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::write(root.join(".gitignore"), "generated.txt\n").unwrap();
        fs::write(root.join("src/main.py"), "print(1)\n").unwrap();
        fs::write(root.join("src/nested/data.txt"), "data").unwrap();
        fs::write(root.join("src/generated.txt"), "skip").unwrap();
        fs::write(root.join("src/.hidden.txt"), "skip").unwrap();
        let root_text = root.to_string_lossy().into_owned();

        let first = duplicate_project_entry_at(&root_text, "src/main.py", &[], false).unwrap();
        assert_eq!(first.path, "src/main (copy).py");
        assert_eq!(first.skipped, 0);
        assert_eq!(
            fs::read_to_string(root.join("src/main (copy).py")).unwrap(),
            "print(1)\n"
        );

        let second = duplicate_project_entry_at(&root_text, "src/main.py", &[], false).unwrap();
        assert_eq!(second.path, "src/main (copy 2).py");

        let folder = duplicate_project_entry_at(&root_text, "src", &[], false).unwrap();
        assert_eq!(folder.path, "src (copy)");
        assert_eq!(folder.skipped, 2);
        assert!(root.join("src (copy)/nested/data.txt").is_file());
        assert!(!root.join("src (copy)/generated.txt").exists());
        assert!(!root.join("src (copy)/.hidden.txt").exists());

        let second_folder = duplicate_project_entry_at(&root_text, "src", &[], false).unwrap();
        assert_eq!(second_folder.path, "src (copy 2)");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn duplicate_project_entry_rejects_escapes_and_sensitive_sources() {
        let parent = temp_workspace("duplicate-invalid");
        let root = parent.join("workspace");
        let outside = parent.join("outside.txt");
        fs::create_dir_all(&root).unwrap();
        fs::write(&outside, "outside").unwrap();
        fs::write(root.join("private.key"), "secret").unwrap();
        let root_text = root.to_string_lossy().into_owned();

        assert!(duplicate_project_entry_at(&root_text, "../outside.txt", &[], false).is_err());
        assert!(duplicate_project_entry_at(&root_text, "private.key", &[], false).is_err());
        assert!(duplicate_project_entry_at(&root_text, "missing.txt", &[], false).is_err());
        assert!(!root.join("private (copy).key").exists());

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, root.join("linked.txt")).unwrap();
            assert!(duplicate_project_entry_at(&root_text, "linked.txt", &[], false).is_err());
        }
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

    #[test]
    fn workspace_change_coalescing_keeps_the_last_event_for_a_path() {
        let mut pending = HashMap::new();
        record_workspace_change(&mut pending, "/work/a.txt", "create");
        record_workspace_change(&mut pending, "/work/a.txt", "delete");
        assert_eq!(
            pending.get("/work/a.txt").map(String::as_str),
            Some("delete")
        );
        record_workspace_change(&mut pending, "/work/a.txt", "create");
        assert_eq!(
            pending.get("/work/a.txt").map(String::as_str),
            Some("create")
        );
    }

    #[test]
    fn workspace_change_queue_is_bounded_and_requests_rescan_on_overflow() {
        let mut pending = HashMap::new();
        for index in 0..MAX_PENDING_CHANGES {
            record_workspace_change(&mut pending, format!("/work/{index}.txt"), "create");
        }
        assert_eq!(pending.len(), MAX_PENDING_CHANGES);
        record_workspace_change(&mut pending, "/work/overflow.txt", "create");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending.get("").map(String::as_str), Some(RESCAN_KIND));
    }

    fn temp_workspace(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "talos-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn universal_scan_respects_ignore_rules_hidden_policy_and_language_detection() {
        let root = temp_workspace("universal-scan");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join(".gitignore"), "ignored.txt\n").unwrap();
        fs::write(root.join("src/main.py"), "print('hello')\n").unwrap();
        fs::write(root.join("ignored.txt"), "secret").unwrap();
        fs::write(root.join(".hidden/notes.py"), "pass").unwrap();
        fs::write(root.join("node_modules/pkg.js"), "").unwrap();

        let languages = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../languages");
        let registry = Registry::load_dir(&languages).unwrap();
        let hidden = scan_project_tree(
            root.to_str().unwrap(),
            &["node_modules".to_string()],
            false,
            false,
            Some(&registry),
        )
        .unwrap();
        let paths: Vec<String> = hidden
            .entries
            .iter()
            .map(|entry| entry.path.clone())
            .collect();
        assert!(paths.iter().any(|path| path.ends_with("src/main.py")));
        assert!(!paths.iter().any(|path| path.ends_with("ignored.txt")));
        assert!(!paths.iter().any(|path| path.contains(".hidden")));
        assert!(!paths.iter().any(|path| path.contains("node_modules")));
        let main = hidden
            .entries
            .iter()
            .find(|entry| entry.name == "main.py")
            .unwrap();
        assert_eq!(main.extension, "py");
        assert_eq!(main.language, "python");

        let shown = scan_project_tree(root.to_str().unwrap(), &[], true, false, None).unwrap();
        assert!(shown.entries.iter().any(|entry| entry.name == "notes.py"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn move_project_entry_validates_destination() {
        let parent = temp_workspace("move-workspace");
        let root = parent.join("workspace");
        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::write(root.join("src/main.py"), "pass").unwrap();
        let root_text = root.to_string_lossy().into_owned();

        move_project_entry_at(&root_text, "src/main.py", "src/nested/main.py").unwrap();
        assert!(root.join("src/nested/main.py").is_file());
        assert!(move_project_entry_at(&root_text, "src/nested", "src/nested/inside").is_err());
        assert!(move_project_entry_at(&root_text, "src/nested/main.py", "../outside.py").is_err());
        assert!(move_project_entry_at(&root_text, "src/missing.py", "src/new.py").is_err());
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn workspace_text_search_indexes_unopened_files_and_skips_ignored_files() {
        let root = temp_workspace("text-search");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join(".gitignore"), "generated.txt\n").unwrap();
        fs::write(
            root.join("src/api.py"),
            "def handler():\n    return 'NEEDLE_TOKEN'\n",
        )
        .unwrap();
        fs::write(root.join("generated.txt"), "NEEDLE_TOKEN\n").unwrap();

        let matches = search_workspace_text_at(
            root.to_str().unwrap(),
            "needle_token",
            &[],
            false,
            false,
            20,
            None,
        )
        .unwrap();
        assert_eq!(matches.len(), 1);
        assert!(matches[0].path.ends_with("src/api.py"));
        assert_eq!(matches[0].line, 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn snapshot_search_reuses_paths_but_revalidates_policy_and_boundary() {
        let parent = temp_workspace("snapshot-search");
        let root = parent.join("workspace");
        let outside = parent.join("outside.txt");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join(".gitignore"), "generated.txt\n").unwrap();
        fs::write(root.join("src/api.py"), "TOKEN_VALUE = 1\n").unwrap();
        fs::write(root.join("generated.txt"), "TOKEN_VALUE = 2\n").unwrap();
        fs::write(root.join("private.key"), "TOKEN_VALUE = 3\n").unwrap();
        fs::write(&outside, "TOKEN_VALUE = 4\n").unwrap();

        let root_text = root.to_string_lossy().into_owned();
        let supplied = vec![
            root.join("src/api.py").to_string_lossy().into_owned(),
            root.join("generated.txt").to_string_lossy().into_owned(),
            root.join("private.key").to_string_lossy().into_owned(),
            outside.to_string_lossy().into_owned(),
            "../outside.txt".to_string(),
        ];
        let matches = search_workspace_text_at(
            &root_text,
            "token_value",
            &[],
            false,
            false,
            20,
            Some(&supplied),
        )
        .unwrap();

        assert_eq!(matches.len(), 1);
        assert!(matches[0].path.ends_with("src/api.py"));
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn snapshot_search_returns_the_same_results_without_a_second_walk() {
        let root = temp_workspace("snapshot-benchmark");
        for directory in 0..40 {
            let path = root.join(format!("module-{directory:02}"));
            fs::create_dir_all(&path).unwrap();
            for file in 0..50 {
                let token = if directory == 20 && file == 25 { "NEEDLE_TOKEN" } else { "other" };
                fs::write(path.join(format!("source-{file:03}.txt")), token).unwrap();
            }
        }
        let root_text = root.to_string_lossy().into_owned();
        let paths: Vec<String> = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .flat_map(|entry| fs::read_dir(entry.path()).unwrap().flatten())
            .map(|entry| entry.path().to_string_lossy().into_owned())
            .collect();

        let started = Instant::now();
        let walked =
            search_workspace_text_at(&root_text, "needle_token", &[], false, false, 20, None)
                .unwrap();
        let walked_ms = started.elapsed().as_millis();

        let started = Instant::now();
        let reused = search_workspace_text_at(
            &root_text,
            "needle_token",
            &[],
            false,
            false,
            20,
            Some(&paths),
        )
        .unwrap();
        let reused_ms = started.elapsed().as_millis();

        assert_eq!(walked.len(), 1);
        assert_eq!(walked[0].path, reused[0].path);
        eprintln!(
            "snapshot_search_benchmark: {} files, walk {} ms, reused snapshot {} ms",
            paths.len(),
            walked_ms,
            reused_ms
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn large_workspace_scan_stays_bounded() {
        let root = temp_workspace("large-scan");
        for directory in 0..50 {
            let path = root.join(format!("module-{directory:02}"));
            fs::create_dir_all(&path).unwrap();
            for file in 0..60 {
                fs::write(path.join(format!("source-{file:03}.py")), "VALUE = 1\n").unwrap();
            }
        }

        let started = Instant::now();
        let scan = scan_project_tree(root.to_str().unwrap(), &[], true, false, None).unwrap();
        let elapsed = started.elapsed();
        eprintln!(
            "large_workspace_scan_stays_bounded: {} entries in {} ms",
            scan.entries.len(),
            elapsed.as_millis()
        );
        assert_eq!(scan.entries.len(), 3_051);
        assert!(!scan.truncated);
        assert!(elapsed < Duration::from_secs(15));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn git_porcelain_status_keeps_staged_and_unstaged_sides() {
        let bytes = b"AM both.txt\0R  new.txt\0old.txt\0?? fresh.txt\0UU merge.txt\0!! ignored.log\0";
        let entries = parse_git_status(bytes);
        assert_eq!(entries.len(), 5);

        let staged = entries.iter().find(|entry| entry.path == "both.txt" && entry.staged).unwrap();
        assert_eq!(staged.status, "added");
        let unstaged = entries.iter().find(|entry| entry.path == "both.txt" && !entry.staged).unwrap();
        assert_eq!(unstaged.status, "modified");

        let renamed = entries.iter().find(|entry| entry.path == "new.txt").unwrap();
        assert_eq!(renamed.status, "renamed");
        assert_eq!(renamed.original_path.as_deref(), Some("old.txt"));

        let untracked = entries.iter().find(|entry| entry.path == "fresh.txt").unwrap();
        assert_eq!(untracked.status, "untracked");
        let conflict = entries.iter().find(|entry| entry.path == "merge.txt").unwrap();
        assert!(conflict.conflict);
        assert!(!entries.iter().any(|entry| entry.path == "ignored.log"));
    }

    #[test]
    fn git_porcelain_status_marks_rename_and_add_conflicts() {
        // RR carries two source paths; both must be consumed so the following
        // real change is not parsed as a bogus status entry.
        let bytes = b"RR renamed.txt\0base.txt\0theirs.txt\0DD gone.txt\0?? fresh.txt\0";
        let entries = parse_git_status(bytes);
        assert_eq!(entries.len(), 3);
        assert!(entries.iter().any(|entry| entry.path == "renamed.txt" && entry.conflict));
        assert_eq!(
            entries.iter().find(|entry| entry.path == "renamed.txt").unwrap().original_path.as_deref(),
            Some("base.txt")
        );
        assert!(entries.iter().any(|entry| entry.path == "gone.txt" && entry.conflict));
        assert!(entries.iter().any(|entry| entry.path == "fresh.txt" && !entry.conflict));
    }

    #[test]
    fn gitignore_pattern_escapes_special_characters() {
        assert_eq!(gitignore_pattern("src/a b.txt"), "/src/a\\ b.txt");
        assert_eq!(gitignore_pattern("!weird[1]*.log"), "/\\!weird\\[1\\]\\*.log");
        assert_eq!(gitignore_pattern("normal/path.txt"), "/normal/path.txt");
    }

    #[test]
    fn git_log_parser_reads_commit_fields() {
        let text = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\x1faaaaaaa\x1fFix Git pane\x1fArman\x1f2026-11-25\x1e";
        let commits = parse_git_log(text);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].hash, "a".repeat(40));
        assert_eq!(commits[0].short_hash, "aaaaaaa");
        assert_eq!(commits[0].subject, "Fix Git pane");
        assert_eq!(commits[0].author, "Arman");
        assert_eq!(commits[0].date, "2026-11-25");
    }

    #[test]
    fn git_remote_verbose_parser_keeps_one_fetch_url_per_remote() {
        let text = concat!(
            "origin\thttps://example.com/talos.git (fetch)\n",
            "origin\thttps://example.com/talos.git (push)\n",
            "fork\tgit@github.com:user/talos.git (fetch)\n",
            "fork\tgit@github.com:user/talos.git (push)\n",
            "malformed-line\n",
        );
        let remotes = parse_git_remotes(text);
        assert_eq!(remotes.len(), 2);
        assert_eq!(remotes[0].name, "origin");
        assert_eq!(remotes[0].url, "https://example.com/talos.git");
        assert_eq!(remotes[1].name, "fork");
        assert_eq!(remotes[1].url, "git@github.com:user/talos.git");
    }

    #[test]
    fn git_paths_and_refs_reject_escapes() {
        assert!(relative_git_path("../outside").is_err());
        assert!(relative_git_path("/etc/passwd").is_err());
        assert!(relative_git_path("src/main.ts").is_ok());
        assert!(validate_git_ref("--upload-pack=x", "remote").is_err());
        assert!(validate_git_ref("origin", "remote").is_ok());
    }

    #[test]
    fn git_toplevel_resolves_a_nested_workspace() {
        let root = std::env::temp_dir().join(format!(
            "talos-git-root-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let nested = root.join("packages").join("app");
        fs::create_dir_all(&nested).unwrap();
        let init = Command::new("git")
            .arg("init")
            .arg("-q")
            .arg(&root)
            .output()
            .expect("git must be available for Git integration tests");
        assert!(init.status.success());
        assert_eq!(
            git_toplevel(nested.to_str().unwrap()).unwrap(),
            fs::canonicalize(&root).unwrap()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn run_arguments_are_bounded_tokenized_and_quoted() {
        assert_eq!(
            split_run_arguments("build --flag=\"two words\" 'last one'").unwrap(),
            vec!["build", "--flag=two words", "last one"]
        );
        assert!(split_run_arguments("'unterminated").is_err());
        assert_eq!(
            append_run_arguments("python3 'file.py'", "").unwrap(),
            "python3 'file.py'"
        );
        assert_eq!(
            append_run_arguments("python3 'file.py'", "build install").unwrap(),
            format!(
                "python3 'file.py' {} {}",
                quote_run_argument("build"),
                quote_run_argument("install")
            )
        );
        assert!(append_run_arguments("python3 'file.py'", &"x".repeat(4097)).is_err());
        assert!(append_run_arguments("python3 'file.py'", "bad\0args").is_err());
    }

    #[test]
    fn git_toplevel_reuses_cached_resolution() {
        let root = std::env::temp_dir().join(format!(
            "talos-git-cache-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let init = Command::new("git")
            .arg("init")
            .arg("-q")
            .arg(&root)
            .output()
            .expect("git must be available for Git integration tests");
        assert!(init.status.success());

        let root_text = root.to_string_lossy().into_owned();
        let first = git_toplevel(&root_text).unwrap();
        // The second lookup must be served from the cache: the repository
        // metadata is gone, but the resolved root remains valid for commands.
        fs::remove_dir_all(root.join(".git")).unwrap();
        let second = git_toplevel(&root_text).unwrap();
        assert_eq!(first, second);
        assert_eq!(second, fs::canonicalize(&root).unwrap());

        fs::remove_dir_all(root).unwrap();
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
            binary_preview,
            write_file,
            write_file_bytes,
            startup_file,
            create_window,
            take_window_context,
            is_android,
            scan_project,
            list_project_directory,
            workspace_entry_metadata,
            search_workspace_text,
            list_recent_workspaces,
            remember_workspace,
            clear_recent_workspaces,
            create_project_file,
            create_project_folder,
            rename_project_entry,
            move_project_entry,
            delete_project_entry,
            duplicate_project_entry,
            load_project_sources,
            measure_project_components,
            load_project_manifests,
            watch_project,
            stop_project_watch,
            git_status,
            git_repo_info,
            git_branches,
            git_checkout,
            git_remotes,
            git_fetch,
            git_pull,
            git_push,
            git_log,
            git_commit_diff,
            git_stage,
            git_unstage,
            git_discard,
            git_ignore,
            git_init,
            git_commit,
            git_diff,
            git_file_preview,
            force_quit,
            github::github_token_status,
            github::github_set_token,
            github::github_clear_token,
            github::github_api,
            settings_read,
            settings_write,
            chronicle::chronicle_status,
            chronicle::chronicle_settings,
            chronicle::chronicle_set_settings,
            chronicle::chronicle_index_start,
            chronicle::chronicle_index_cancel,
            chronicle::chronicle_index_on_workspace_change,
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
            run_file_interactive,
            run_source_interactive,
            run_write_stdin,
            terminal::platform::terminal_open,
            terminal::platform::terminal_write,
            terminal::platform::terminal_resize,
            terminal::platform::terminal_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running Talos");
}
