//! Shared workspace policy for the Universal Project Workspace.
//!
//! The Explorer scan, the filesystem watcher and the analysis paths all use
//! the same rules, so a file hidden or ignored in one view cannot still be
//! indexed or analysed in another. This module is intentionally dependency
//! free beyond the already bundled `ignore` crate.

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use std::path::{Component, Path};

const SENSITIVE_PATTERNS: &[&str] = &[
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "id_rsa",
    "id_ed25519",
    "credentials.json",
    "service-account*.json",
];

/// One consistent set of rules for every workspace-aware subsystem.
pub(crate) struct WorkspacePolicy {
    matchers: Vec<Gitignore>,
    show_hidden: bool,
}

impl WorkspacePolicy {
    /// Build the policy for a canonical workspace root.
    ///
    /// `exclusions` are the legacy Explorer comma-separated names, kept as a
    /// compatibility layer. They are converted into gitignore-style patterns
    /// so they behave identically at every depth.
    pub(crate) fn load(
        root: &Path,
        exclusions: &[String],
        show_hidden: bool,
    ) -> Result<Self, String> {
        let mut matchers = Vec::new();
        for name in [".gitignore", ".ignore", ".talosignore"] {
            let path = root.join(name);
            if !path.is_file() {
                continue;
            }
            let mut builder = GitignoreBuilder::new(root);
            if let Some(error) = builder.add(&path) {
                return Err(format!("could not read {}: {error}", path.display()));
            }
            matchers.push(
                builder
                    .build()
                    .map_err(|error| format!("could not compile {}: {error}", path.display()))?,
            );
        }

        let mut user_builder = GitignoreBuilder::new(root);
        for pattern in exclusions
            .iter()
            .map(String::as_str)
            .chain(SENSITIVE_PATTERNS.iter().copied())
        {
            if pattern.trim().is_empty() {
                continue;
            }
            user_builder
                .add_line(None, pattern)
                .map_err(|error| format!("invalid workspace exclusion {pattern:?}: {error}"))?;
        }
        matchers.push(
            user_builder
                .build()
                .map_err(|error| format!("could not compile workspace exclusions: {error}"))?,
        );

        Ok(Self {
            matchers,
            show_hidden,
        })
    }

    /// True when a path must not be scanned, watched, indexed or analysed.
    pub(crate) fn is_ignored(&self, relative: &Path, is_dir: bool) -> bool {
        if !self.show_hidden && has_hidden_component(relative) {
            return true;
        }
        let components: Vec<_> = relative.components().collect();
        for (index, _) in components.iter().enumerate() {
            let prefix: std::path::PathBuf = components[..=index].iter().collect();
            let prefix_is_dir = index + 1 < components.len() || is_dir;
            if self
                .matchers
                .iter()
                .any(|matcher| matcher.matched(&prefix, prefix_is_dir).is_ignore())
            {
                return true;
            }
        }
        false
    }

    /// True when a single filename is sensitive and must never be indexed.
    pub(crate) fn is_sensitive_name(name: &str) -> bool {
        let lower = name.to_ascii_lowercase();
        SENSITIVE_PATTERNS.iter().any(|pattern| {
            if let Some(suffix) = pattern.strip_prefix('*') {
                lower.ends_with(suffix)
            } else if let Some((prefix, suffix)) = pattern.split_once('*') {
                lower.starts_with(prefix) && lower.ends_with(suffix)
            } else {
                lower == *pattern
            }
        })
    }
}

fn has_hidden_component(relative: &Path) -> bool {
    relative.components().any(|component| match component {
        Component::Normal(name) => {
            let name = name.to_string_lossy();
            name.starts_with('.') && name != ".github"
        }
        _ => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn hidden_components_are_ignored_until_enabled() {
        let policy = WorkspacePolicy::load(Path::new("/project"), &[], false).unwrap();
        assert!(policy.is_ignored(Path::new(".env"), false));
        assert!(policy.is_ignored(Path::new("src/.cache/data.py"), false));
        assert!(!policy.is_ignored(Path::new(".github/workflows/ci.yml"), false));
        let shown = WorkspacePolicy::load(Path::new("/project"), &[], true).unwrap();
        assert!(!shown.is_ignored(Path::new("src/.cache/data.py"), false));
    }

    #[test]
    fn legacy_exclusions_work_at_any_depth() {
        let policy = WorkspacePolicy::load(
            Path::new("/project"),
            &["node_modules".to_string(), "generated".to_string()],
            true,
        )
        .unwrap();
        assert!(policy.is_ignored(Path::new("node_modules/a.js"), true));
        assert!(policy.is_ignored(Path::new("src/generated/out.ts"), false));
    }

    #[test]
    fn sensitive_files_are_always_ignored() {
        let policy = WorkspacePolicy::load(Path::new("/project"), &[], true).unwrap();
        assert!(policy.is_ignored(Path::new("keys/service-account-prod.json"), false));
        assert!(policy.is_ignored(Path::new("private.key"), false));
        assert!(WorkspacePolicy::is_sensitive_name("id_rsa"));
    }
}
