//! Language registry: loads one JSON config per language.

use serde::Deserialize;
use std::{fs, io, path::Path};

#[derive(Debug, Clone, Deserialize)]
pub struct LspConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Language {
    pub id: String,
    pub name: String,
    pub extensions: Vec<String>,
    #[serde(default)]
    pub lsp: Option<LspConfig>,
    #[serde(default)]
    pub run: Option<String>,
    #[serde(default)]
    pub build: Option<String>,
    /// Folders owned by this language (used later for disk-size reporting).
    #[serde(default)]
    pub paths: Vec<String>,
}

impl Language {
    /// Builds the shell command to run `file`, replacing `{file}` with a quoted path.
    pub fn run_command(&self, file: &Path) -> Option<String> {
        let template = self.run.as_ref()?;
        let quoted = format!("'{}'", file.to_string_lossy().replace('\'', "'\\''"));
        Some(template.replace("{file}", &quoted))
    }
}

#[derive(Debug, Default)]
pub struct Registry {
    languages: Vec<Language>,
}

impl Registry {
    /// Loads every `*.json` file in `dir` as a language config.
    pub fn load_dir(dir: &Path) -> io::Result<Self> {
        let mut languages = Vec::new();
        for entry in fs::read_dir(dir)? {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let text = fs::read_to_string(&path)?;
            let lang: Language = serde_json::from_str(&text).map_err(|e| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("{}: {}", path.display(), e),
                )
            })?;
            languages.push(lang);
        }
        languages.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(Self { languages })
    }

    pub fn all(&self) -> &[Language] {
        &self.languages
    }

    pub fn by_id(&self, id: &str) -> Option<&Language> {
        self.languages.iter().find(|l| l.id == id)
    }

    /// Finds a language from a file's extension.
    pub fn detect(&self, file: &Path) -> Option<&Language> {
        let ext = file.extension()?.to_str()?;
        let dotted = format!(".{ext}");
        self.languages
            .iter()
            .find(|l| l.extensions.iter().any(|e| e.eq_ignore_ascii_case(&dotted)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn sample() -> Registry {
        let lang = Language {
            id: "python".into(),
            name: "Python".into(),
            extensions: vec![".py".into()],
            lsp: None,
            run: Some("python3 {file}".into()),
            build: None,
            paths: vec![],
        };
        Registry { languages: vec![lang] }
    }

    #[test]
    fn detects_by_extension() {
        let r = sample();
        assert_eq!(r.detect(&PathBuf::from("a/b/main.PY")).unwrap().id, "python");
        assert!(r.detect(&PathBuf::from("notes.txt")).is_none());
    }

    #[test]
    fn quotes_file_in_run_command() {
        let r = sample();
        let cmd = r
            .by_id("python")
            .unwrap()
            .run_command(&PathBuf::from("my file.py"))
            .unwrap();
        assert_eq!(cmd, "python3 'my file.py'");
    }
}
