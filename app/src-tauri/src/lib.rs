use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use talos_core::language::{Language, Registry};

// ---------- files ----------
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
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

/// File passed on the command line:  talos main.py
#[tauri::command]
fn startup_file() -> Option<String> {
    std::env::args().nth(1).filter(|a| !a.starts_with('-'))
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
fn default_registry() -> String {
    format!(
        "{}/projects/talos/registry/index.json",
        std::env::var("HOME").unwrap_or_default()
    )
}

#[tauri::command]
fn ext_list() -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(ext_dir()) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            if let Ok(t) = fs::read_to_string(&p) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
                    out.push(v);
                }
            }
        }
    }
    out
}

/// Installs an extension file. The SHA-256 must match, or nothing is written.
#[tauri::command]
fn ext_install(text: String, sha256: String) -> Result<serde_json::Value, String> {
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
    let id = v
        .get("id")
        .and_then(|x| x.as_str())
        .ok_or("extension has no id")?
        .to_string();
    if !valid_id(&id) {
        return Err(format!("invalid extension id '{id}'"));
    }
    let kind = v.get("kind").and_then(|x| x.as_str()).unwrap_or("");
    if !matches!(kind, "theme" | "language" | "template") {
        return Err(format!("unsupported extension kind '{kind}'"));
    }
    let dir = ext_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join(format!("{id}.json")), &text).map_err(|e| e.to_string())?;
    if kind == "language" {
        let cfg = v
            .get("language")
            .ok_or("language extension needs a 'language' section")?;
        let ldir = dir.join("languages");
        fs::create_dir_all(&ldir).map_err(|e| e.to_string())?;
        let pretty = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
        fs::write(ldir.join(format!("{id}.json")), pretty).map_err(|e| e.to_string())?;
    }
    Ok(v)
}

#[tauri::command]
fn ext_remove(id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("invalid extension id".into());
    }
    let dir = ext_dir();
    let _ = fs::remove_file(dir.join(format!("{id}.json")));
    let _ = fs::remove_file(dir.join("languages").join(format!("{id}.json")));
    Ok(())
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

fn languages_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(d) = std::env::var("TALOS_LANG_DIR") {
        dirs.push(PathBuf::from(d));
    }
    let home = std::env::var("HOME").unwrap_or_default();
    dirs.push(PathBuf::from(home).join("projects/talos/languages"));
    dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../languages"));
    dirs
}

/// Runs a file using the command template from languages/<lang>.json
/// (built-in folder first, then language extensions).
#[tauri::command]
async fn run_file(path: String) -> Result<RunResult, String> {
    let p = Path::new(&path);
    let mut dirs = languages_dirs();
    dirs.push(ext_dir().join("languages"));
    let mut found = None;
    for d in dirs.iter() {
        if let Ok(reg) = Registry::load_dir(d) {
            if let Some(l) = reg.detect(p) {
                found = Some(l.clone());
                break;
            }
        }
    }
    let lang = found.ok_or_else(|| {
        format!("no language configured for {path} (add one in languages/ or install a language extension)")
    })?;
    run_language(&lang, p)
}

#[tauri::command]
fn run_source(
    source: String,
    language_id: Option<String>,
    file_name: Option<String>,
) -> Result<RunResult, String> {
    let mut dirs = languages_dirs();
    dirs.push(ext_dir().join("languages"));
    let mut found = None;
    for d in dirs.iter() {
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
    fn runs_unsaved_python_source() {
        let available = Command::new("python3").arg("--version").output();
        if !matches!(available, Ok(output) if output.status.success()) {
            return;
        }

        let result = run_source(
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
        let error = match run_source("print('hello')".into(), None, None) {
            Err(error) => error,
            Ok(_) => panic!("no language should require user guidance"),
        };

        assert!(error.contains("Choose a run language"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_file,
            read_file_bytes,
            write_file,
            startup_file,
            is_android,
            settings_read,
            settings_write,
            default_registry,
            ext_list,
            ext_install,
            ext_remove,
            run_file,
            run_source
        ])
        .run(tauri::generate_context!())
        .expect("error while running Talos");
}
