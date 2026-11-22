//! Local-first persistent project memory for Talos Crest.
//!
//! The backend provides storage, bounded incremental indexing, evidence-backed
//! search, timeline, observations, and recorded decisions. All potentially
//! expensive work is bounded and runs off the editor UI thread.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use ignore::gitignore::GitignoreBuilder;
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

const SCHEMA_VERSION: i64 = 2;

const MIGRATIONS: &[(i64, &str, &str)] = &[
    (1, "initial_schema", INITIAL_SCHEMA),
    (2, "index_generation_and_search_paths", SECOND_SCHEMA),
];

const INITIAL_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    root TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    project_id TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_path TEXT,
    line_start INTEGER,
    line_end INTEGER,
    commit_hash TEXT,
    excerpt TEXT,
    excerpt_hash TEXT,
    redacted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS evidence_project_source
    ON evidence(project_id, source_kind, source_path);

CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    path TEXT,
    line INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(project_id, kind, name, path),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS entities_project_kind
    ON entities(project_id, kind);

CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    subject_id TEXT,
    predicate TEXT NOT NULL,
    value TEXT,
    confidence REAL NOT NULL DEFAULT 1.0,
    status TEXT NOT NULL CHECK(status IN ('verified', 'inferred', 'proposed')),
    source_kind TEXT NOT NULL,
    source_path TEXT,
    evidence_id INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(subject_id) REFERENCES entities(id) ON DELETE SET NULL,
    FOREIGN KEY(evidence_id) REFERENCES evidence(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS observations_project_kind
    ON observations(project_id, kind, created_at);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    details TEXT,
    source_kind TEXT NOT NULL,
    source_path TEXT,
    evidence_id INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(evidence_id) REFERENCES evidence(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS events_project_created
    ON events(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    from_entity TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    to_entity TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 1.0,
    status TEXT NOT NULL CHECK(status IN ('verified', 'inferred', 'proposed')),
    evidence_id INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(project_id, from_entity, relation_type, to_entity),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(from_entity) REFERENCES entities(id) ON DELETE CASCADE,
    FOREIGN KEY(to_entity) REFERENCES entities(id) ON DELETE CASCADE,
    FOREIGN KEY(evidence_id) REFERENCES evidence(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS relations_project_type
    ON relations(project_id, relation_type);

CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    context TEXT,
    decision TEXT NOT NULL,
    consequences TEXT,
    status TEXT NOT NULL CHECK(status IN ('proposed', 'accepted', 'superseded', 'rejected')),
    supersedes_id INTEGER,
    evidence_id INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY(supersedes_id) REFERENCES decisions(id) ON DELETE SET NULL,
    FOREIGN KEY(evidence_id) REFERENCES evidence(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS decisions_project_status
    ON decisions(project_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS index_state (
    project_id TEXT NOT NULL,
    path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    modified_ms INTEGER,
    language TEXT,
    last_indexed_ms INTEGER NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY(project_id, path),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS index_state_project_status
    ON index_state(project_id, status);

CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    details TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS snapshots_project_created
    ON snapshots(project_id, created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS search_docs USING fts5(
    project_id UNINDEXED,
    kind UNINDEXED,
    entity_id UNINDEXED,
    title,
    body,
    evidence_id UNINDEXED,
    created_at UNINDEXED
);
"#;

const SECOND_SCHEMA: &str = r#"
ALTER TABLE index_state ADD COLUMN last_seen_generation INTEGER NOT NULL DEFAULT 0;

DROP TABLE IF EXISTS search_docs;
CREATE VIRTUAL TABLE search_docs USING fts5(
    project_id UNINDEXED,
    kind UNINDEXED,
    entity_id UNINDEXED,
    source_path UNINDEXED,
    title,
    body,
    evidence_id UNINDEXED,
    created_at UNINDEXED
);
"#;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleSettings {
    pub enabled: bool,
    pub index_on_workspace_change: bool,
    pub respect_gitignore: bool,
    pub respect_ignore: bool,
    pub respect_talos_ignore: bool,
    pub index_hidden_files: bool,
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
    pub max_files: u64,
    pub max_evidence_chars: u64,
    pub store_unsaved_content: bool,
    pub exclude_patterns: Vec<String>,
}

impl Default for ChronicleSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            index_on_workspace_change: true,
            respect_gitignore: true,
            respect_ignore: true,
            respect_talos_ignore: true,
            index_hidden_files: false,
            max_file_bytes: 256 * 1024,
            max_total_bytes: 16 * 1024 * 1024,
            max_files: 8_000,
            max_evidence_chars: 512,
            store_unsaved_content: false,
            exclude_patterns: default_exclude_patterns(),
        }
    }
}

impl ChronicleSettings {
    pub fn validate(&self) -> Result<(), String> {
        if self.max_file_bytes == 0 || self.max_file_bytes > 64 * 1024 * 1024 {
            return Err("maxFileBytes must be between 1 and 67108864".to_string());
        }
        if self.max_total_bytes == 0 || self.max_total_bytes > 2 * 1024 * 1024 * 1024 {
            return Err("maxTotalBytes must be between 1 and 2147483648".to_string());
        }
        if self.max_files == 0 || self.max_files > 1_000_000 {
            return Err("maxFiles must be between 1 and 1000000".to_string());
        }
        if self.max_evidence_chars == 0 || self.max_evidence_chars > 8_192 {
            return Err("maxEvidenceChars must be between 1 and 8192".to_string());
        }
        if self.exclude_patterns.len() > 256 {
            return Err("excludePatterns cannot contain more than 256 entries".to_string());
        }
        for pattern in &self.exclude_patterns {
            if pattern.is_empty() {
                return Err("excludePatterns cannot contain empty entries".to_string());
            }
            if pattern.len() > 512 {
                return Err("excludePatterns entries cannot exceed 512 characters".to_string());
            }
            if pattern.contains('\0') {
                return Err("excludePatterns cannot contain NUL characters".to_string());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleStatus {
    pub project_id: String,
    pub project_root: String,
    pub display_name: String,
    pub database_path: String,
    pub schema_version: i64,
    pub initialized: bool,
    pub indexed_files: i64,
    pub indexed_bytes: i64,
    pub last_indexed_at: Option<i64>,
    pub observations: i64,
    pub events: i64,
    pub relations: i64,
    pub decisions: i64,
    pub settings: ChronicleSettings,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleProgress {
    pub project_id: String,
    pub job_id: u64,
    pub phase: String,
    pub scanned: u64,
    pub indexed: u64,
    pub unchanged: u64,
    pub skipped: u64,
    pub bytes: u64,
    pub message: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleIndexJob {
    pub project_id: String,
    pub job_id: u64,
    pub accepted: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleErrorEvent {
    pub project_id: String,
    pub job_id: u64,
    pub message: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleEvidence {
    pub id: i64,
    pub source_kind: String,
    pub source_path: Option<String>,
    pub line_start: Option<i64>,
    pub line_end: Option<i64>,
    pub excerpt: String,
    pub redacted: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleSearchResult {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub snippet: String,
    pub score: f64,
    pub source_path: Option<String>,
    pub created_at: i64,
    pub evidence: Option<ChronicleEvidence>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleEvent {
    pub id: i64,
    pub kind: String,
    pub summary: String,
    pub details: Option<String>,
    pub source_kind: String,
    pub source_path: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleDecision {
    pub id: i64,
    pub title: String,
    pub context: Option<String>,
    pub decision: String,
    pub consequences: Option<String>,
    pub status: String,
    pub supersedes_id: Option<i64>,
    pub evidence_id: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub evidence: Option<ChronicleEvidence>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleObservation {
    pub id: i64,
    pub kind: String,
    pub predicate: String,
    pub value: String,
    pub confidence: f64,
    pub status: String,
    pub source_kind: String,
    pub source_path: Option<String>,
    pub evidence_id: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub evidence: Option<ChronicleEvidence>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleDecisionInput {
    pub title: String,
    #[serde(default)]
    pub context: Option<String>,
    pub decision: String,
    #[serde(default)]
    pub consequences: Option<String>,
    #[serde(default = "default_decision_status")]
    pub status: String,
    #[serde(default)]
    pub supersedes_id: Option<i64>,
    #[serde(default)]
    pub evidence: Option<String>,
    #[serde(default)]
    pub source_path: Option<String>,
    #[serde(default)]
    pub line: Option<i64>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleObservationInput {
    #[serde(default = "default_observation_kind")]
    pub kind: String,
    pub predicate: String,
    pub value: String,
    #[serde(default = "default_confidence")]
    pub confidence: f64,
    #[serde(default = "default_observation_status")]
    pub status: String,
    #[serde(default = "default_user_source")]
    pub source_kind: String,
    #[serde(default)]
    pub source_path: Option<String>,
    #[serde(default)]
    pub line: Option<i64>,
    #[serde(default)]
    pub evidence: Option<String>,
}

fn default_decision_status() -> String {
    "accepted".to_string()
}

fn default_observation_kind() -> String {
    "user_fact".to_string()
}

fn default_confidence() -> f64 {
    1.0
}

fn default_observation_status() -> String {
    "verified".to_string()
}

fn default_user_source() -> String {
    "user".to_string()
}

impl ChronicleDecisionInput {
    fn validate(&self) -> Result<(), String> {
        require_text("title", &self.title, 200)?;
        require_text("decision", &self.decision, 20_000)?;
        validate_optional_text("context", self.context.as_deref(), 20_000)?;
        validate_optional_text("consequences", self.consequences.as_deref(), 20_000)?;
        validate_optional_text("evidence", self.evidence.as_deref(), 20_000)?;
        validate_optional_text("sourcePath", self.source_path.as_deref(), 1_024)?;
        validate_decision_status(&self.status)?;
        if let Some(id) = self.supersedes_id {
            if id <= 0 {
                return Err("supersedesId must be positive".to_string());
            }
        }
        validate_line(self.line)?;
        Ok(())
    }
}

impl ChronicleObservationInput {
    fn validate(&self) -> Result<(), String> {
        require_text("kind", &self.kind, 100)?;
        require_text("predicate", &self.predicate, 200)?;
        require_text("value", &self.value, 20_000)?;
        require_text("sourceKind", &self.source_kind, 100)?;
        validate_optional_text("evidence", self.evidence.as_deref(), 20_000)?;
        validate_optional_text("sourcePath", self.source_path.as_deref(), 1_024)?;
        validate_observation_status(&self.status)?;
        validate_line(self.line)?;
        if !self.confidence.is_finite() || !(0.0..=1.0).contains(&self.confidence) {
            return Err("confidence must be a finite number between 0 and 1".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy)]
struct IndexGeneration {
    generation: u64,
    active: bool,
}

static INDEX_GENERATIONS: OnceLock<Mutex<HashMap<String, IndexGeneration>>> = OnceLock::new();
static NEXT_INDEX_JOB: AtomicU64 = AtomicU64::new(1);
const MAX_INDEX_DIRS: u64 = 10_000;
const INDEX_BATCH_SIZE: usize = 32;

pub struct ChronicleStore {
    conn: Connection,
    project_id: String,
    project_root: String,
    display_name: String,
    database_path: PathBuf,
}

impl ChronicleStore {
    pub fn open_for_root(root: &Path) -> Result<Self, String> {
        Self::open_in(&chronicle_dir()?, root)
    }

    pub fn open_in(data_dir: &Path, root: &Path) -> Result<Self, String> {
        let (project_id, project_root, display_name) = project_identity(root)?;
        fs::create_dir_all(data_dir)
            .map_err(|e| format!("could not create Chronicle data directory: {e}"))?;

        let database_path = data_dir.join(format!("{project_id}.sqlite"));
        let mut conn = Connection::open(&database_path)
            .map_err(|e| format!("could not open Chronicle database: {e}"))?;

        configure_connection(&conn)?;
        migrate(&mut conn)?;

        let store = Self {
            conn,
            project_id,
            project_root,
            display_name,
            database_path,
        };
        store.ensure_project_row()?;
        store.ensure_default_settings()?;
        Ok(store)
    }

    pub fn status(&self) -> Result<ChronicleStatus, String> {
        let schema_version: i64 = self
            .conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM migrations",
                [],
                |row| row.get(0),
            )
            .map_err(|e| format!("could not read Chronicle schema version: {e}"))?;

        let (indexed_files, indexed_bytes): (i64, i64) = self
            .conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(size_bytes), 0)
                 FROM index_state
                 WHERE project_id = ?1",
                params![self.project_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|e| format!("could not read Chronicle index statistics: {e}"))?;

        let last_indexed_at: Option<i64> = self
            .conn
            .query_row(
                "SELECT MAX(last_indexed_ms) FROM index_state WHERE project_id = ?1",
                params![self.project_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("could not read Chronicle index time: {e}"))?
            .flatten();

        Ok(ChronicleStatus {
            project_id: self.project_id.clone(),
            project_root: self.project_root.clone(),
            display_name: self.display_name.clone(),
            database_path: self.database_path.to_string_lossy().into_owned(),
            schema_version,
            initialized: schema_version == SCHEMA_VERSION,
            indexed_files,
            indexed_bytes,
            last_indexed_at,
            observations: self.table_count("observations")?,
            events: self.table_count("events")?,
            relations: self.table_count("relations")?,
            decisions: self.table_count("decisions")?,
            settings: self.settings()?,
        })
    }

    pub fn settings(&self) -> Result<ChronicleSettings, String> {
        let value: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM settings WHERE project_id = ?1",
                params![self.project_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("could not read Chronicle settings: {e}"))?;

        let value = value.ok_or_else(|| "Chronicle settings are missing".to_string())?;
        serde_json::from_str(&value).map_err(|e| format!("Chronicle settings are corrupt: {e}"))
    }

    pub fn set_settings(&self, settings: ChronicleSettings) -> Result<ChronicleSettings, String> {
        settings.validate()?;
        let value = serde_json::to_string(&settings)
            .map_err(|e| format!("could not encode Chronicle settings: {e}"))?;
        self.conn
            .execute(
                "INSERT INTO settings(project_id, value, updated_at)
                 VALUES(?1, ?2, ?3)
                 ON CONFLICT(project_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![self.project_id, value, now_ms()],
            )
            .map_err(|e| format!("could not save Chronicle settings: {e}"))?;
        Ok(settings)
    }

    fn table_count(&self, table: &str) -> Result<i64, String> {
        let sql = match table {
            "observations" => "SELECT COUNT(*) FROM observations WHERE project_id = ?1",
            "events" => "SELECT COUNT(*) FROM events WHERE project_id = ?1",
            "relations" => "SELECT COUNT(*) FROM relations WHERE project_id = ?1",
            "decisions" => "SELECT COUNT(*) FROM decisions WHERE project_id = ?1",
            _ => return Err(format!("unknown Chronicle count table: {table}")),
        };
        self.conn
            .query_row(sql, params![self.project_id], |row| row.get(0))
            .map_err(|e| format!("could not count Chronicle {table}: {e}"))
    }

    fn ensure_project_row(&self) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO projects(id, root, display_name, created_at, updated_at)
                 VALUES(?1, ?2, ?3, ?4, ?4)
                 ON CONFLICT(id) DO UPDATE SET
                     root = excluded.root,
                     display_name = excluded.display_name,
                     updated_at = excluded.updated_at",
                params![
                    self.project_id,
                    self.project_root,
                    self.display_name,
                    now_ms()
                ],
            )
            .map_err(|e| format!("could not register Chronicle project: {e}"))?;
        Ok(())
    }

    fn ensure_default_settings(&self) -> Result<(), String> {
        let existing: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM settings WHERE project_id = ?1",
                params![self.project_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("could not inspect Chronicle settings: {e}"))?;

        if existing.is_some() {
            return Ok(());
        }

        self.set_settings(ChronicleSettings::default())?;
        Ok(())
    }

    pub fn search(
        &self,
        query: &str,
        limit: Option<i64>,
    ) -> Result<Vec<ChronicleSearchResult>, String> {
        let limit = bounded_limit(limit, 50, 200)?;
        let match_query = fts_query(query);

        let sql = if match_query.is_some() {
            "SELECT rowid AS id, kind, title, source_path, created_at,
                    evidence_id,
                    bm25(search_docs) AS score,
                    snippet(search_docs, 5, '', '', '…', 28) AS snippet
             FROM search_docs
             WHERE project_id = ?1 AND search_docs MATCH ?2
             ORDER BY score ASC
             LIMIT ?3"
        } else {
            "SELECT rowid AS id, kind, title, source_path, created_at,
                    evidence_id,
                    0.0 AS score,
                    substr(body, 1, 500) AS snippet
             FROM search_docs
             WHERE project_id = ?1
             ORDER BY created_at DESC
             LIMIT ?2"
        };

        let map_row = |row: &Row<'_>| raw_search_row(row);
        let mut statement = self
            .conn
            .prepare(sql)
            .map_err(|e| format!("could not prepare Chronicle search: {e}"))?;
        let rows = if let Some(match_query) = match_query.as_deref() {
            statement
                .query_map(params![self.project_id, match_query, limit], map_row)
                .map_err(|e| format!("could not search Chronicle memory: {e}"))?
                .collect::<Vec<_>>()
        } else {
            statement
                .query_map(params![self.project_id, limit], map_row)
                .map_err(|e| format!("could not list Chronicle memory: {e}"))?
                .collect::<Vec<_>>()
        };

        let mut results = Vec::new();
        for row in rows {
            let raw = row.map_err(|e| format!("could not read Chronicle search row: {e}"))?;
            let evidence = match raw.evidence_id {
                Some(id) => evidence_by_id(&self.conn, &self.project_id, id)?,
                None => match raw.source_path.as_deref() {
                    Some(path) => primary_evidence(&self.conn, &self.project_id, path)?,
                    None => None,
                },
            };
            results.push(ChronicleSearchResult {
                id: format!("{}:{}", raw.kind, raw.id),
                kind: raw.kind,
                title: raw.title,
                snippet: clean_snippet(&raw.snippet),
                score: raw.score,
                source_path: raw.source_path,
                created_at: raw.created_at,
                evidence,
            });
        }
        Ok(results)
    }

    pub fn timeline(&self, limit: Option<i64>) -> Result<Vec<ChronicleEvent>, String> {
        let limit = bounded_limit(limit, 100, 500)?;
        let mut statement = self
            .conn
            .prepare(
                "SELECT id, kind, summary, details, source_kind, source_path, created_at
                 FROM events
                 WHERE project_id = ?1
                 ORDER BY created_at DESC, id DESC
                 LIMIT ?2",
            )
            .map_err(|e| format!("could not prepare Chronicle timeline: {e}"))?;
        let rows = statement
            .query_map(params![self.project_id, limit], |row| {
                Ok(ChronicleEvent {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    summary: row.get(2)?,
                    details: row.get(3)?,
                    source_kind: row.get(4)?,
                    source_path: row.get(5)?,
                    created_at: row.get(6)?,
                })
            })
            .map_err(|e| format!("could not read Chronicle timeline: {e}"))?;

        let mut events = Vec::new();
        for row in rows {
            events.push(row.map_err(|e| format!("could not read Chronicle event: {e}"))?);
        }
        Ok(events)
    }

    pub fn decisions(&self, limit: Option<i64>) -> Result<Vec<ChronicleDecision>, String> {
        let limit = bounded_limit(limit, 100, 500)?;
        let mut statement = self
            .conn
            .prepare(
                "SELECT id, title, context, decision, consequences, status,
                        supersedes_id, evidence_id, created_at, updated_at
                 FROM decisions
                 WHERE project_id = ?1
                 ORDER BY updated_at DESC, id DESC
                 LIMIT ?2",
            )
            .map_err(|e| format!("could not prepare Chronicle decision list: {e}"))?;
        let rows = statement
            .query_map(params![self.project_id, limit], |row| {
                decision_from_row(row)
            })
            .map_err(|e| format!("could not read Chronicle decisions: {e}"))?;

        let mut decisions = Vec::new();
        for row in rows {
            let mut decision =
                row.map_err(|e| format!("could not read Chronicle decision: {e}"))?;
            decision.evidence = match decision.evidence_id {
                Some(id) => evidence_by_id(&self.conn, &self.project_id, id)?,
                None => None,
            };
            decisions.push(decision);
        }
        Ok(decisions)
    }

    pub fn record_decision(
        &mut self,
        input: ChronicleDecisionInput,
    ) -> Result<ChronicleDecision, String> {
        input.validate()?;
        let max_evidence_chars = self.settings()?.max_evidence_chars as usize;
        let time = now_ms();
        let tx = self
            .conn
            .transaction()
            .map_err(|e| format!("could not start decision transaction: {e}"))?;

        if let Some(supersedes_id) = input.supersedes_id {
            let exists: Option<i64> = tx
                .query_row(
                    "SELECT id FROM decisions WHERE project_id = ?1 AND id = ?2",
                    params![self.project_id, supersedes_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| format!("could not validate superseded decision: {e}"))?;
            if exists.is_none() {
                return Err(format!(
                    "decision {supersedes_id} does not exist in this project"
                ));
            }
        }

        let evidence_id = store_user_evidence(
            &tx,
            &self.project_id,
            "user",
            input.source_path.as_deref(),
            input.line,
            input.evidence.as_deref(),
            max_evidence_chars,
        )?;

        tx.execute(
            "INSERT INTO decisions(
                 project_id, title, context, decision, consequences, status,
                 supersedes_id, evidence_id, created_at, updated_at
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
            params![
                self.project_id,
                bounded(&input.title, 200),
                input.context.as_deref().map(|value| bounded(value, 20_000)),
                bounded(&input.decision, 20_000),
                input
                    .consequences
                    .as_deref()
                    .map(|value| bounded(value, 20_000)),
                input.status,
                input.supersedes_id,
                evidence_id,
                time
            ],
        )
        .map_err(|e| format!("could not record Chronicle decision: {e}"))?;
        let decision_id = tx.last_insert_rowid();

        tx.execute(
            "INSERT INTO events(
                 project_id, kind, summary, details, source_kind, source_path,
                 evidence_id, created_at
             ) VALUES(?1, 'decision_recorded', ?2, ?3, 'user', ?4, ?5, ?6)",
            params![
                self.project_id,
                format!("Recorded decision: {}", bounded(&input.title, 160)),
                format!(
                    "{{\"decisionId\":{decision_id},\"status\":{:?}}}",
                    input.status.as_str()
                ),
                input
                    .source_path
                    .as_deref()
                    .map(|value| bounded(value, 1_024)),
                evidence_id,
                time
            ],
        )
        .map_err(|e| format!("could not record decision timeline event: {e}"))?;

        let body = [
            input.context.as_deref(),
            Some(input.decision.as_str()),
            input.consequences.as_deref(),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("\n");
        tx.execute(
            "INSERT INTO search_docs(
                 project_id, kind, entity_id, source_path, title, body, evidence_id, created_at
             ) VALUES(?1, 'decision', ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                self.project_id,
                format!("decision:{decision_id}"),
                input
                    .source_path
                    .as_deref()
                    .map(|value| bounded(value, 1_024)),
                bounded(&input.title, 500),
                bounded(&body, 20_000),
                evidence_id,
                time
            ],
        )
        .map_err(|e| format!("could not index Chronicle decision for search: {e}"))?;

        tx.commit()
            .map_err(|e| format!("could not commit Chronicle decision: {e}"))?;
        self.decision_by_id(decision_id)
    }

    pub fn observe(
        &mut self,
        input: ChronicleObservationInput,
    ) -> Result<ChronicleObservation, String> {
        input.validate()?;
        let max_evidence_chars = self.settings()?.max_evidence_chars as usize;
        let time = now_ms();
        let tx = self
            .conn
            .transaction()
            .map_err(|e| format!("could not start observation transaction: {e}"))?;

        let evidence_id = store_user_evidence(
            &tx,
            &self.project_id,
            &input.source_kind,
            input.source_path.as_deref(),
            input.line,
            input.evidence.as_deref(),
            max_evidence_chars,
        )?;

        tx.execute(
            "INSERT INTO observations(
                 project_id, kind, predicate, value, confidence, status,
                 source_kind, source_path, evidence_id, created_at, updated_at
             ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
            params![
                self.project_id,
                bounded(&input.kind, 100),
                bounded(&input.predicate, 200),
                bounded(&input.value, 20_000),
                input.confidence,
                input.status,
                bounded(&input.source_kind, 100),
                input
                    .source_path
                    .as_deref()
                    .map(|value| bounded(value, 1_024)),
                evidence_id,
                time
            ],
        )
        .map_err(|e| format!("could not record Chronicle observation: {e}"))?;
        let observation_id = tx.last_insert_rowid();

        tx.execute(
            "INSERT INTO events(
                 project_id, kind, summary, details, source_kind, source_path,
                 evidence_id, created_at
             ) VALUES(?1, 'observation_recorded', ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                self.project_id,
                format!(
                    "Recorded {}: {}",
                    bounded(&input.predicate, 100),
                    bounded(&input.value, 160)
                ),
                format!("{{\"observationId\":{observation_id}}}"),
                bounded(&input.source_kind, 100),
                input
                    .source_path
                    .as_deref()
                    .map(|value| bounded(value, 1_024)),
                evidence_id,
                time
            ],
        )
        .map_err(|e| format!("could not record observation timeline event: {e}"))?;

        tx.execute(
            "INSERT INTO search_docs(
                 project_id, kind, entity_id, source_path, title, body, evidence_id, created_at
             ) VALUES(?1, 'observation', ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                self.project_id,
                format!("observation:{observation_id}"),
                input
                    .source_path
                    .as_deref()
                    .map(|value| bounded(value, 1_024)),
                bounded(&input.predicate, 500),
                bounded(&input.value, 20_000),
                evidence_id,
                time
            ],
        )
        .map_err(|e| format!("could not index Chronicle observation for search: {e}"))?;

        tx.commit()
            .map_err(|e| format!("could not commit Chronicle observation: {e}"))?;
        self.observation_by_id(observation_id)
    }

    pub fn set_decision_status(
        &mut self,
        id: i64,
        status: String,
        supersedes_id: Option<i64>,
    ) -> Result<ChronicleDecision, String> {
        validate_decision_status(&status)?;
        if id <= 0 {
            return Err("decision id must be positive".to_string());
        }
        if let Some(value) = supersedes_id {
            if value <= 0 {
                return Err("supersedesId must be positive".to_string());
            }
        }

        let time = now_ms();
        let tx = self
            .conn
            .transaction()
            .map_err(|e| format!("could not start decision status transaction: {e}"))?;
        let updated = tx
            .execute(
                "UPDATE decisions
                 SET status = ?3, supersedes_id = ?4, updated_at = ?5
                 WHERE project_id = ?1 AND id = ?2",
                params![self.project_id, id, status, supersedes_id, time],
            )
            .map_err(|e| format!("could not update Chronicle decision status: {e}"))?;
        if updated == 0 {
            return Err(format!("decision {id} does not exist in this project"));
        }

        let title: String = tx
            .query_row(
                "SELECT title FROM decisions WHERE project_id = ?1 AND id = ?2",
                params![self.project_id, id],
                |row| row.get(0),
            )
            .map_err(|e| format!("could not read updated Chronicle decision: {e}"))?;
        tx.execute(
            "DELETE FROM search_docs WHERE project_id = ?1 AND entity_id = ?2",
            params![self.project_id, format!("decision:{id}")],
        )
        .map_err(|e| format!("could not replace decision search row: {e}"))?;
        tx.execute(
            "INSERT INTO search_docs(
                 project_id, kind, entity_id, source_path, title, body, evidence_id, created_at
             ) SELECT project_id, 'decision', ?2, NULL, title,
                      COALESCE(context, '') || '\n' || decision || '\n' || COALESCE(consequences, '') || '\n' || status,
                      evidence_id, ?3
               FROM decisions
               WHERE project_id = ?1 AND id = ?4",
            params![self.project_id, format!("decision:{id}"), time, id],
        )
        .map_err(|e| format!("could not reindex updated decision: {e}"))?;
        tx.execute(
            "INSERT INTO events(project_id, kind, summary, details, source_kind, created_at)
             VALUES(?1, 'decision_status_changed', ?2, ?3, 'user', ?4)",
            params![
                self.project_id,
                format!("Decision status changed: {}", bounded(&title, 160)),
                format!("{{\"decisionId\":{id},\"status\":{:?}}}", status.as_str()),
                time
            ],
        )
        .map_err(|e| format!("could not record decision status event: {e}"))?;
        tx.commit()
            .map_err(|e| format!("could not commit decision status change: {e}"))?;
        self.decision_by_id(id)
    }

    fn decision_by_id(&self, id: i64) -> Result<ChronicleDecision, String> {
        let mut decision = self
            .conn
            .query_row(
                "SELECT id, title, context, decision, consequences, status,
                        supersedes_id, evidence_id, created_at, updated_at
                 FROM decisions
                 WHERE project_id = ?1 AND id = ?2",
                params![self.project_id, id],
                |row| decision_from_row(row),
            )
            .map_err(|e| format!("could not read Chronicle decision {id}: {e}"))?;
        decision.evidence = match decision.evidence_id {
            Some(evidence_id) => evidence_by_id(&self.conn, &self.project_id, evidence_id)?,
            None => None,
        };
        Ok(decision)
    }

    fn observation_by_id(&self, id: i64) -> Result<ChronicleObservation, String> {
        let mut observation = self
            .conn
            .query_row(
                "SELECT id, kind, predicate, value, confidence, status,
                        source_kind, source_path, evidence_id, created_at, updated_at
                 FROM observations
                 WHERE project_id = ?1 AND id = ?2",
                params![self.project_id, id],
                |row| observation_from_row(row),
            )
            .map_err(|e| format!("could not read Chronicle observation {id}: {e}"))?;
        observation.evidence = match observation.evidence_id {
            Some(evidence_id) => evidence_by_id(&self.conn, &self.project_id, evidence_id)?,
            None => None,
        };
        Ok(observation)
    }
}

#[tauri::command]
pub(crate) fn chronicle_status(root: String) -> Result<ChronicleStatus, String> {
    let store = ChronicleStore::open_for_root(Path::new(&root))?;
    store.status()
}

#[tauri::command]
pub(crate) fn chronicle_settings(root: String) -> Result<ChronicleSettings, String> {
    let store = ChronicleStore::open_for_root(Path::new(&root))?;
    store.settings()
}

#[tauri::command]
pub(crate) fn chronicle_set_settings(
    root: String,
    settings: ChronicleSettings,
) -> Result<ChronicleSettings, String> {
    let store = ChronicleStore::open_for_root(Path::new(&root))?;
    store.set_settings(settings)
}

#[tauri::command]
pub(crate) fn chronicle_index_start(
    root: String,
    app: AppHandle,
) -> Result<ChronicleIndexJob, String> {
    let root_path = PathBuf::from(&root);
    let (project_id, _, _) = project_identity(&root_path)?;
    let job_id = NEXT_INDEX_JOB.fetch_add(1, Ordering::Relaxed);
    let generation = begin_index_job(&project_id);

    let accepted = ChronicleIndexJob {
        project_id: project_id.clone(),
        job_id,
        accepted: true,
    };

    let app_for_job = app.clone();
    let root_for_job = root_path.clone();
    let project_for_job = project_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_index_job(
            app_for_job,
            root_for_job,
            project_for_job,
            job_id,
            generation,
        );
    });

    emit_progress(
        &app,
        &ChronicleProgress {
            project_id,
            job_id,
            phase: "queued".to_string(),
            scanned: 0,
            indexed: 0,
            unchanged: 0,
            skipped: 0,
            bytes: 0,
            message: None,
        },
    );

    Ok(accepted)
}

#[tauri::command]
pub(crate) fn chronicle_index_cancel(root: String) -> Result<bool, String> {
    let (project_id, _, _) = project_identity(Path::new(&root))?;
    Ok(cancel_index_job(&project_id))
}

#[tauri::command]
pub(crate) fn chronicle_search(
    root: String,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<ChronicleSearchResult>, String> {
    let store = ChronicleStore::open_for_root(Path::new(&root))?;
    store.search(&query, limit)
}

#[tauri::command]
pub(crate) fn chronicle_timeline(
    root: String,
    limit: Option<i64>,
) -> Result<Vec<ChronicleEvent>, String> {
    let store = ChronicleStore::open_for_root(Path::new(&root))?;
    store.timeline(limit)
}

#[tauri::command]
pub(crate) fn chronicle_decisions(
    root: String,
    limit: Option<i64>,
) -> Result<Vec<ChronicleDecision>, String> {
    let store = ChronicleStore::open_for_root(Path::new(&root))?;
    store.decisions(limit)
}

#[tauri::command]
pub(crate) fn chronicle_record_decision(
    root: String,
    input: ChronicleDecisionInput,
) -> Result<ChronicleDecision, String> {
    let mut store = ChronicleStore::open_for_root(Path::new(&root))?;
    store.record_decision(input)
}

#[tauri::command]
pub(crate) fn chronicle_observe(
    root: String,
    input: ChronicleObservationInput,
) -> Result<ChronicleObservation, String> {
    let mut store = ChronicleStore::open_for_root(Path::new(&root))?;
    store.observe(input)
}

#[tauri::command]
pub(crate) fn chronicle_set_decision_status(
    root: String,
    id: i64,
    status: String,
    supersedes_id: Option<i64>,
) -> Result<ChronicleDecision, String> {
    let mut store = ChronicleStore::open_for_root(Path::new(&root))?;
    store.set_decision_status(id, status, supersedes_id)
}

pub fn chronicle_dir() -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var("XDG_DATA_HOME") {
        if !value.is_empty() {
            return Ok(PathBuf::from(value).join("talos").join("chronicle"));
        }
    }

    let home = std::env::var("HOME")
        .map_err(|_| "could not determine HOME for Chronicle storage".to_string())?;
    if home.is_empty() {
        return Err("HOME is empty; could not determine Chronicle storage".to_string());
    }
    Ok(PathBuf::from(home)
        .join(".local")
        .join("share")
        .join("talos")
        .join("chronicle"))
}

pub fn project_identity(root: &Path) -> Result<(String, String, String), String> {
    let canonical = fs::canonicalize(root)
        .map_err(|e| format!("could not resolve project root {}: {e}", root.display()))?;
    if !canonical.is_dir() {
        return Err(format!(
            "project root is not a directory: {}",
            canonical.display()
        ));
    }

    let root_string = canonical.to_string_lossy().into_owned();
    let digest = Sha256::digest(root_string.as_bytes());
    let project_id: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    let display_name = canonical
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| root_string.clone());

    Ok((project_id, root_string, display_name))
}

fn configure_connection(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "PRAGMA busy_timeout = 5000;
         PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;",
    )
    .map_err(|e| format!("could not configure Chronicle database: {e}"))
}

fn migrate(conn: &mut Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS migrations (
             version INTEGER PRIMARY KEY,
             name TEXT NOT NULL,
             applied_at INTEGER NOT NULL
         );",
    )
    .map_err(|e| format!("could not initialize Chronicle migrations table: {e}"))?;

    let current: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM migrations",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("could not read Chronicle migration version: {e}"))?;

    let tx = conn
        .transaction()
        .map_err(|e| format!("could not start Chronicle migration: {e}"))?;

    for (version, name, sql) in MIGRATIONS {
        if *version <= current {
            continue;
        }
        tx.execute_batch(sql)
            .map_err(|e| format!("could not apply Chronicle migration {version} ({name}): {e}"))?;
        tx.execute(
            "INSERT INTO migrations(version, name, applied_at) VALUES(?1, ?2, ?3)",
            params![version, name, now_ms()],
        )
        .map_err(|e| format!("could not record Chronicle migration {version}: {e}"))?;
    }

    tx.commit()
        .map_err(|e| format!("could not commit Chronicle migrations: {e}"))
}

fn default_exclude_patterns() -> Vec<String> {
    [
        ".git/**",
        "target/**",
        "node_modules/**",
        "dist/**",
        "build/**",
        "coverage/**",
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
        "*.sqlite",
        "*.db",
    ]
    .iter()
    .map(|value| (*value).to_string())
    .collect()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

struct RawSearchRow {
    id: i64,
    kind: String,
    title: String,
    source_path: Option<String>,
    created_at: i64,
    evidence_id: Option<i64>,
    score: f64,
    snippet: String,
}

fn bounded_limit(limit: Option<i64>, default: i64, max: i64) -> Result<i64, String> {
    match limit {
        None => Ok(default),
        Some(value) if value <= 0 => Err("limit must be a positive number".to_string()),
        Some(value) => Ok(value.min(max)),
    }
}

fn fts_query(query: &str) -> Option<String> {
    let tokens = query
        .split_whitespace()
        .filter_map(|word| {
            let token: String = word
                .chars()
                .filter(|character| character.is_ascii_alphanumeric() || *character == '_')
                .collect();
            let token = bounded(&token, 40);
            if token.is_empty() {
                None
            } else {
                Some(token)
            }
        })
        .take(16)
        .map(|token| format!("{token}*"))
        .collect::<Vec<_>>();

    if tokens.is_empty() {
        None
    } else {
        Some(tokens.join(" "))
    }
}

fn raw_search_row(row: &Row<'_>) -> rusqlite::Result<RawSearchRow> {
    Ok(RawSearchRow {
        id: row.get(0)?,
        kind: row.get(1)?,
        title: row.get(2)?,
        source_path: row.get(3)?,
        created_at: row.get(4)?,
        evidence_id: row.get(5)?,
        score: row.get(6)?,
        snippet: row.get(7)?,
    })
}

fn clean_snippet(value: &str) -> String {
    let normalized = value
        .chars()
        .map(|character| {
            if character.is_control() && character != '\n' {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    bounded(
        &normalized.split_whitespace().collect::<Vec<_>>().join(" "),
        500,
    )
}

fn evidence_from_row(row: &Row<'_>) -> rusqlite::Result<ChronicleEvidence> {
    Ok(ChronicleEvidence {
        id: row.get(0)?,
        source_kind: row.get(1)?,
        source_path: row.get(2)?,
        line_start: row.get(3)?,
        line_end: row.get(4)?,
        excerpt: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
        redacted: row.get::<_, i64>(6)? != 0,
        created_at: row.get(7)?,
    })
}

fn evidence_by_id(
    conn: &Connection,
    project_id: &str,
    id: i64,
) -> Result<Option<ChronicleEvidence>, String> {
    conn.query_row(
        "SELECT id, source_kind, source_path, line_start, line_end,
                excerpt, redacted, created_at
         FROM evidence
         WHERE project_id = ?1 AND id = ?2",
        params![project_id, id],
        |row| evidence_from_row(row),
    )
    .optional()
    .map_err(|e| format!("could not read Chronicle evidence: {e}"))
}

fn primary_evidence(
    conn: &Connection,
    project_id: &str,
    source_path: &str,
) -> Result<Option<ChronicleEvidence>, String> {
    conn.query_row(
        "SELECT id, source_kind, source_path, line_start, line_end,
                excerpt, redacted, created_at
         FROM evidence
         WHERE project_id = ?1 AND source_path = ?2
         ORDER BY (excerpt IS NULL OR excerpt = '') ASC,
                  redacted ASC,
                  (line_start IS NOT NULL) DESC,
                  id DESC
         LIMIT 1",
        params![project_id, source_path],
        |row| evidence_from_row(row),
    )
    .optional()
    .map_err(|e| format!("could not read Chronicle source evidence: {e}"))
}

fn decision_from_row(row: &Row<'_>) -> rusqlite::Result<ChronicleDecision> {
    Ok(ChronicleDecision {
        id: row.get(0)?,
        title: row.get(1)?,
        context: row.get(2)?,
        decision: row.get(3)?,
        consequences: row.get(4)?,
        status: row.get(5)?,
        supersedes_id: row.get(6)?,
        evidence_id: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        evidence: None,
    })
}

fn observation_from_row(row: &Row<'_>) -> rusqlite::Result<ChronicleObservation> {
    Ok(ChronicleObservation {
        id: row.get(0)?,
        kind: row.get(1)?,
        predicate: row.get(2)?,
        value: row.get(3)?,
        confidence: row.get(4)?,
        status: row.get(5)?,
        source_kind: row.get(6)?,
        source_path: row.get(7)?,
        evidence_id: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        evidence: None,
    })
}

fn validate_decision_status(status: &str) -> Result<(), String> {
    if matches!(status, "proposed" | "accepted" | "superseded" | "rejected") {
        Ok(())
    } else {
        Err("decision status must be proposed, accepted, superseded, or rejected".to_string())
    }
}

fn validate_observation_status(status: &str) -> Result<(), String> {
    if matches!(status, "verified" | "inferred" | "proposed") {
        Ok(())
    } else {
        Err("observation status must be verified, inferred, or proposed".to_string())
    }
}

fn require_text(name: &str, value: &str, max: usize) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{name} cannot be empty"));
    }
    if value.contains('\0') {
        return Err(format!("{name} cannot contain NUL characters"));
    }
    if value.chars().count() > max {
        return Err(format!("{name} cannot exceed {max} characters"));
    }
    Ok(())
}

fn validate_optional_text(name: &str, value: Option<&str>, max: usize) -> Result<(), String> {
    if let Some(value) = value {
        if value.contains('\0') {
            return Err(format!("{name} cannot contain NUL characters"));
        }
        if value.chars().count() > max {
            return Err(format!("{name} cannot exceed {max} characters"));
        }
    }
    Ok(())
}

fn validate_line(line: Option<i64>) -> Result<(), String> {
    if let Some(line) = line {
        if line <= 0 {
            return Err("line must be a positive number".to_string());
        }
    }
    Ok(())
}

fn store_user_evidence(
    tx: &Transaction,
    project_id: &str,
    source_kind: &str,
    source_path: Option<&str>,
    line: Option<i64>,
    evidence: Option<&str>,
    max_chars: usize,
) -> Result<Option<i64>, String> {
    let Some(evidence) = evidence.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let (excerpt, redacted) = redact_excerpt(evidence, max_chars);
    let digest = hex_digest(excerpt.as_bytes());

    tx.execute(
        "INSERT INTO evidence(
             project_id, source_kind, source_path, line_start, line_end,
             excerpt, excerpt_hash, redacted, created_at
         ) VALUES(?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8)",
        params![
            project_id,
            bounded(source_kind, 100),
            source_path.map(|value| bounded(value, 1_024)),
            line,
            excerpt,
            digest,
            i64::from(redacted),
            now_ms()
        ],
    )
    .map_err(|e| format!("could not store user evidence: {e}"))?;
    Ok(Some(tx.last_insert_rowid()))
}

fn index_generations() -> &'static Mutex<HashMap<String, IndexGeneration>> {
    INDEX_GENERATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn begin_index_job(project_id: &str) -> u64 {
    let mut jobs = index_generations()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let generation = jobs
        .get(project_id)
        .map(|job| job.generation.saturating_add(1))
        .unwrap_or(1);
    jobs.insert(
        project_id.to_string(),
        IndexGeneration {
            generation,
            active: true,
        },
    );
    generation
}

fn cancel_index_job(project_id: &str) -> bool {
    let mut jobs = index_generations()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(job) = jobs.get_mut(project_id) else {
        return false;
    };
    if !job.active {
        return false;
    }
    job.generation = job.generation.saturating_add(1);
    job.active = false;
    true
}

fn finish_index_job(project_id: &str, generation: u64) {
    let mut jobs = index_generations()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(job) = jobs.get_mut(project_id) {
        if job.generation == generation {
            job.active = false;
        }
    }
}

fn is_index_current(project_id: &str, generation: u64) -> bool {
    let jobs = index_generations()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    jobs.get(project_id)
        .map(|job| job.active && job.generation == generation)
        .unwrap_or(false)
}

fn run_index_job(app: AppHandle, root: PathBuf, project_id: String, job_id: u64, generation: u64) {
    let app_for_progress = app.clone();
    let progress = |value: &ChronicleProgress| emit_progress(&app_for_progress, value);
    let is_current = || is_index_current(&project_id, generation);

    match index_project(
        &root,
        &project_id,
        job_id,
        generation,
        Some(&progress),
        &is_current,
    ) {
        Ok(status) => {
            if is_current() {
                finish_index_job(&project_id, generation);
                if let Err(error) = app.emit("chronicle://updated", status) {
                    eprintln!("could not emit Chronicle update event: {error}");
                }
            }
        }
        Err(error) if error == "cancelled" => {
            finish_index_job(&project_id, generation);
            emit_progress(
                &app,
                &ChronicleProgress {
                    project_id,
                    job_id,
                    phase: "cancelled".to_string(),
                    scanned: 0,
                    indexed: 0,
                    unchanged: 0,
                    skipped: 0,
                    bytes: 0,
                    message: None,
                },
            );
        }
        Err(error) => {
            finish_index_job(&project_id, generation);
            let event = ChronicleErrorEvent {
                project_id,
                job_id,
                message: error.clone(),
            };
            if let Err(emit_error) = app.emit("chronicle://error", &event) {
                eprintln!("could not emit Chronicle error event: {emit_error}");
            }
            emit_progress(
                &app,
                &ChronicleProgress {
                    project_id: event.project_id,
                    job_id: event.job_id,
                    phase: "error".to_string(),
                    scanned: 0,
                    indexed: 0,
                    unchanged: 0,
                    skipped: 0,
                    bytes: 0,
                    message: Some(error),
                },
            );
        }
    }
}

fn emit_progress(app: &AppHandle, progress: &ChronicleProgress) {
    if let Err(error) = app.emit("chronicle://progress", progress) {
        eprintln!("could not emit Chronicle progress event: {error}");
    }
}

#[derive(Default)]
struct IndexCounters {
    scanned: u64,
    indexed: u64,
    unchanged: u64,
    skipped: u64,
    bytes: u64,
}

struct FileCandidate {
    path: PathBuf,
    rel_path: String,
}

struct ExtractedFact {
    predicate: &'static str,
    value: String,
    status: &'static str,
    line: usize,
    excerpt: String,
    redacted: bool,
}

struct IgnoreMatcher {
    matchers: Vec<ignore::gitignore::Gitignore>,
}

impl IgnoreMatcher {
    fn new(root: &Path, settings: &ChronicleSettings) -> Result<Self, String> {
        let mut matchers = Vec::new();
        let rules = [
            (".gitignore", settings.respect_gitignore),
            (".ignore", settings.respect_ignore),
            (".talosignore", settings.respect_talos_ignore),
        ];

        for (name, enabled) in rules {
            if !enabled {
                continue;
            }
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
                    .map_err(|e| format!("could not compile {}: {e}", path.display()))?,
            );
        }

        let mut user_builder = GitignoreBuilder::new(root);
        for pattern in &settings.exclude_patterns {
            user_builder
                .add_line(None, pattern)
                .map_err(|e| format!("invalid Chronicle exclude pattern {pattern:?}: {e}"))?;
        }
        matchers.push(
            user_builder
                .build()
                .map_err(|e| format!("could not compile Chronicle exclude patterns: {e}"))?,
        );

        Ok(Self { matchers })
    }

    fn is_ignored(&self, relative: &Path, is_dir: bool) -> bool {
        self.matchers
            .iter()
            .any(|matcher| matcher.matched(relative, is_dir).is_ignore())
    }
}

fn index_project(
    root: &Path,
    project_id: &str,
    job_id: u64,
    generation: u64,
    progress: Option<&dyn Fn(&ChronicleProgress)>,
    is_current: &dyn Fn() -> bool,
) -> Result<ChronicleStatus, String> {
    index_project_in(
        &chronicle_dir()?,
        root,
        project_id,
        job_id,
        generation,
        progress,
        is_current,
    )
}

fn index_project_in(
    data_dir: &Path,
    root: &Path,
    project_id: &str,
    job_id: u64,
    generation: u64,
    progress: Option<&dyn Fn(&ChronicleProgress)>,
    is_current: &dyn Fn() -> bool,
) -> Result<ChronicleStatus, String> {
    let mut store = ChronicleStore::open_in(data_dir, root)?;
    let settings = store.settings()?;
    let matcher = IgnoreMatcher::new(root, &settings)?;

    let report = |counters: &IndexCounters, phase: &str, message: Option<String>| {
        if let Some(callback) = progress {
            callback(&ChronicleProgress {
                project_id: project_id.to_string(),
                job_id,
                phase: phase.to_string(),
                scanned: counters.scanned,
                indexed: counters.indexed,
                unchanged: counters.unchanged,
                skipped: counters.skipped,
                bytes: counters.bytes,
                message,
            });
        }
    };

    report(
        &IndexCounters::default(),
        "scanning",
        Some("collecting project files".to_string()),
    );

    let files = collect_files(root, &matcher, &settings, is_current)?;
    let mut counters = IndexCounters::default();

    {
        let tx = store
            .conn
            .transaction()
            .map_err(|e| format!("could not start Chronicle index transaction: {e}"))?;
        tx.execute(
            "UPDATE index_state SET last_seen_generation = 0 WHERE project_id = ?1",
            params![project_id],
        )
        .map_err(|e| format!("could not reset Chronicle index generation: {e}"))?;
        tx.commit()
            .map_err(|e| format!("could not commit Chronicle index reset: {e}"))?;
    }

    let mut tx = store
        .conn
        .transaction()
        .map_err(|e| format!("could not start Chronicle index transaction: {e}"))?;
    let mut batch = 0usize;

    for file in &files {
        if !is_current() {
            tx.commit()
                .map_err(|e| format!("could not commit partial Chronicle index: {e}"))?;
            return Err("cancelled".to_string());
        }

        counters.scanned += 1;
        let metadata = fs::symlink_metadata(&file.path)
            .map_err(|e| format!("could not read metadata for {}: {e}", file.rel_path))?;
        let size = metadata.len();

        if size > settings.max_file_bytes {
            counters.skipped += 1;
            upsert_index_state(
                &tx,
                project_id,
                generation,
                &file.rel_path,
                "",
                size,
                None,
                language_for_path(Path::new(&file.rel_path)),
                "skipped_too_large",
            )?;
            batch += 1;
        } else if size > settings.max_total_bytes.saturating_sub(counters.bytes) {
            counters.skipped += 1;
            upsert_index_state(
                &tx,
                project_id,
                generation,
                &file.rel_path,
                "",
                size,
                None,
                language_for_path(Path::new(&file.rel_path)),
                "skipped_total_limit",
            )?;
            batch += 1;
        } else {
            let bytes = fs::read(&file.path)
                .map_err(|e| format!("could not read {}: {e}", file.rel_path))?;
            let hash = hex_digest(&bytes);
            let known_hash: Option<String> = tx
                .query_row(
                    "SELECT content_hash FROM index_state WHERE project_id = ?1 AND path = ?2",
                    params![project_id, file.rel_path],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| format!("could not inspect index state for {}: {e}", file.rel_path))?;

            if known_hash.as_deref() == Some(hash.as_str()) {
                tx.execute(
                    "UPDATE index_state SET last_seen_generation = ?3, status = 'unchanged'
                     WHERE project_id = ?1 AND path = ?2",
                    params![
                        project_id,
                        file.rel_path,
                        generation.min(i64::MAX as u64) as i64
                    ],
                )
                .map_err(|e| format!("could not mark unchanged file {}: {e}", file.rel_path))?;
                counters.unchanged += 1;
            } else {
                match String::from_utf8(bytes) {
                    Ok(text) => {
                        let facts = extract_facts(
                            &text,
                            &file.rel_path,
                            size,
                            settings.max_evidence_chars as usize,
                        );
                        persist_file(
                            &tx,
                            project_id,
                            generation,
                            &file.rel_path,
                            &hash,
                            size,
                            modified_ms(&metadata),
                            &facts,
                        )?;
                        counters.indexed += 1;
                    }
                    Err(_) => {
                        upsert_index_state(
                            &tx,
                            project_id,
                            generation,
                            &file.rel_path,
                            &hash,
                            size,
                            modified_ms(&metadata),
                            language_for_path(Path::new(&file.rel_path)),
                            "skipped_binary",
                        )?;
                        counters.skipped += 1;
                    }
                }
            }
            counters.bytes = counters.bytes.saturating_add(size);
            batch += 1;
        }

        if batch >= INDEX_BATCH_SIZE {
            tx.commit()
                .map_err(|e| format!("could not commit Chronicle index batch: {e}"))?;
            report(&counters, "indexing", None);
            tx = store
                .conn
                .transaction()
                .map_err(|e| format!("could not start Chronicle index transaction: {e}"))?;
            batch = 0;
        }
    }

    tx.execute(
        "DELETE FROM index_state WHERE project_id = ?1 AND last_seen_generation = 0",
        params![project_id],
    )
    .map_err(|e| format!("could not prune stale Chronicle index rows: {e}"))?;
    tx.execute(
        "DELETE FROM search_docs
         WHERE project_id = ?1
           AND source_path NOT IN (
               SELECT path FROM index_state WHERE project_id = ?1
           )",
        params![project_id],
    )
    .map_err(|e| format!("could not prune stale Chronicle search rows: {e}"))?;
    tx.commit()
        .map_err(|e| format!("could not commit Chronicle index: {e}"))?;

    store
        .conn
        .execute(
            "INSERT INTO events(project_id, kind, summary, details, source_kind, created_at)
             VALUES(?1, 'index_completed', ?2, ?3, 'chronicle', ?4)",
            params![
                project_id,
                format!(
                    "Indexed {} files, {} unchanged, {} skipped",
                    counters.indexed, counters.unchanged, counters.skipped
                ),
                format!(
                    "{{\"scanned\":{},\"indexed\":{},\"unchanged\":{},\"skipped\":{},\"bytes\":{}}}",
                    counters.scanned, counters.indexed, counters.unchanged, counters.skipped,
                    counters.bytes
                ),
                now_ms()
            ],
        )
        .map_err(|e| format!("could not record Chronicle index event: {e}"))?;

    report(&counters, "done", None);
    store.status()
}

fn collect_files(
    root: &Path,
    matcher: &IgnoreMatcher,
    settings: &ChronicleSettings,
    is_current: &dyn Fn() -> bool,
) -> Result<Vec<FileCandidate>, String> {
    let mut stack = vec![root.to_path_buf()];
    let mut files = Vec::new();
    let mut directories = 0u64;

    while let Some(directory) = stack.pop() {
        if !is_current() {
            return Err("cancelled".to_string());
        }
        directories += 1;
        if directories > MAX_INDEX_DIRS {
            return Err(format!(
                "Chronicle index exceeded {MAX_INDEX_DIRS} directories"
            ));
        }

        let mut entries = fs::read_dir(&directory)
            .map_err(|e| format!("could not read directory {}: {e}", directory.display()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("could not read directory entry: {e}"))?;
        entries.sort_by_key(|entry| entry.file_name());

        for entry in entries {
            if !is_current() {
                return Err("cancelled".to_string());
            }

            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .map_err(|e| format!("could not resolve relative path {}: {e}", path.display()))?
                .to_path_buf();
            let metadata = entry
                .metadata()
                .map_err(|e| format!("could not inspect {}: {e}", path.display()))?;
            if metadata.file_type().is_symlink() {
                continue;
            }

            let is_dir = metadata.is_dir();
            if is_always_excluded(&relative)
                || matcher.is_ignored(&relative, is_dir)
                || (!settings.index_hidden_files && has_hidden_component(&relative))
            {
                continue;
            }

            if is_dir {
                stack.push(path);
            } else if metadata.is_file() {
                files.push(FileCandidate {
                    path,
                    rel_path: relative.to_string_lossy().into_owned(),
                });
                if files.len() >= settings.max_files as usize {
                    return Ok(files);
                }
            }
        }
    }

    Ok(files)
}

fn is_always_excluded(relative: &Path) -> bool {
    for component in relative.components() {
        if component.as_os_str() == ".git" {
            return true;
        }
    }

    let Some(name) = relative.file_name().map(|value| value.to_string_lossy()) else {
        return false;
    };
    let lower = name.to_lowercase();
    if lower == ".env" || lower.starts_with(".env.") {
        return true;
    }
    if lower.ends_with(".pem")
        || lower.ends_with(".key")
        || lower.ends_with(".p12")
        || lower.ends_with(".pfx")
    {
        return true;
    }
    matches!(
        lower.as_str(),
        "id_rsa"
            | "id_ed25519"
            | "credentials.json"
            | "service-account.json"
            | "service-account-key.json"
    )
}

fn has_hidden_component(relative: &Path) -> bool {
    relative
        .components()
        .any(|component| component.as_os_str().to_string_lossy().starts_with('.'))
}

fn persist_file(
    tx: &Connection,
    project_id: &str,
    generation: u64,
    relative: &str,
    hash: &str,
    size: u64,
    modified: Option<i64>,
    facts: &[ExtractedFact],
) -> Result<(), String> {
    tx.execute(
        "DELETE FROM observations
         WHERE project_id = ?1 AND source_kind = 'scan' AND source_path = ?2",
        params![project_id, relative],
    )
    .map_err(|e| format!("could not replace Chronicle observations for {relative}: {e}"))?;
    tx.execute(
        "DELETE FROM evidence
         WHERE project_id = ?1 AND source_kind = 'scan' AND source_path = ?2",
        params![project_id, relative],
    )
    .map_err(|e| format!("could not replace Chronicle evidence for {relative}: {e}"))?;
    tx.execute(
        "DELETE FROM search_docs WHERE project_id = ?1 AND source_path = ?2",
        params![project_id, relative],
    )
    .map_err(|e| format!("could not replace Chronicle search rows for {relative}: {e}"))?;

    let time = now_ms();
    for fact in facts {
        let excerpt_hash = hex_digest(fact.excerpt.as_bytes());
        tx.execute(
            "INSERT INTO evidence(
                 project_id, source_kind, source_path, line_start, line_end,
                 excerpt, excerpt_hash, redacted, created_at
             ) VALUES(?1, 'scan', ?2, ?3, ?3, ?4, ?5, ?6, ?7)",
            params![
                project_id,
                relative,
                fact.line as i64,
                fact.excerpt,
                excerpt_hash,
                i64::from(fact.redacted),
                time
            ],
        )
        .map_err(|e| format!("could not store Chronicle evidence for {relative}: {e}"))?;
        let evidence_id = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO observations(
                 project_id, kind, predicate, value, confidence, status,
                 source_kind, source_path, evidence_id, created_at, updated_at
             ) VALUES(?1, 'file_fact', ?2, ?3, 1.0, ?4, 'scan', ?5, ?6, ?7, ?7)",
            params![
                project_id,
                fact.predicate,
                bounded(&fact.value, 240),
                fact.status,
                relative,
                evidence_id,
                time
            ],
        )
        .map_err(|e| format!("could not store Chronicle observation for {relative}: {e}"))?;
    }

    let body = facts
        .iter()
        .map(|fact| format!("{} {}", fact.predicate, fact.value))
        .collect::<Vec<_>>()
        .join("\n");
    tx.execute(
        "INSERT INTO search_docs(
             project_id, kind, entity_id, source_path, title, body, evidence_id, created_at
         ) VALUES(?1, 'file', NULL, ?2, ?3, ?4, NULL, ?5)",
        params![project_id, relative, relative, bounded(&body, 8_000), time],
    )
    .map_err(|e| format!("could not index Chronicle search row for {relative}: {e}"))?;

    upsert_index_state(
        tx,
        project_id,
        generation,
        relative,
        hash,
        size,
        modified,
        language_for_path(Path::new(relative)),
        "indexed",
    )
}

fn upsert_index_state(
    tx: &Connection,
    project_id: &str,
    generation: u64,
    relative: &str,
    hash: &str,
    size: u64,
    modified: Option<i64>,
    language: &str,
    status: &str,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO index_state(
             project_id, path, content_hash, size_bytes, modified_ms,
             language, last_indexed_ms, status, last_seen_generation
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(project_id, path) DO UPDATE SET
             content_hash = excluded.content_hash,
             size_bytes = excluded.size_bytes,
             modified_ms = excluded.modified_ms,
             language = excluded.language,
             last_indexed_ms = excluded.last_indexed_ms,
             status = excluded.status,
             last_seen_generation = excluded.last_seen_generation",
        params![
            project_id,
            relative,
            hash,
            size.min(i64::MAX as u64) as i64,
            modified,
            language,
            now_ms(),
            status,
            generation.min(i64::MAX as u64) as i64
        ],
    )
    .map_err(|e| format!("could not update Chronicle index state for {relative}: {e}"))?;
    Ok(())
}

fn extract_facts(
    text: &str,
    relative: &str,
    size: u64,
    max_excerpt_chars: usize,
) -> Vec<ExtractedFact> {
    let language = language_for_path(Path::new(relative));
    let mut facts = vec![
        ExtractedFact {
            predicate: "file_language",
            value: language.to_string(),
            status: "verified",
            line: 0,
            excerpt: String::new(),
            redacted: false,
        },
        ExtractedFact {
            predicate: "file_size",
            value: size.to_string(),
            status: "verified",
            line: 0,
            excerpt: String::new(),
            redacted: false,
        },
    ];

    for (index, line) in text.lines().enumerate().take(20_000) {
        if facts.len() >= 200 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_lowercase();

        if ["todo", "fixme", "hack", "xxx"]
            .iter()
            .any(|marker| lower.contains(marker))
        {
            let (excerpt, redacted) = redact_excerpt(trimmed, max_excerpt_chars);
            facts.push(ExtractedFact {
                predicate: "todo_marker",
                value: bounded(trimmed, 240),
                status: "inferred",
                line: index + 1,
                excerpt,
                redacted,
            });
        }

        if lower.contains("@decision") || lower.contains("decision:") || lower.contains("adr-") {
            let (excerpt, redacted) = redact_excerpt(trimmed, max_excerpt_chars);
            facts.push(ExtractedFact {
                predicate: "decision_marker",
                value: bounded(trimmed, 240),
                status: "proposed",
                line: index + 1,
                excerpt,
                redacted,
            });
        }

        if let Some(name) = symbol_name(trimmed, language) {
            let (excerpt, redacted) = redact_excerpt(trimmed, max_excerpt_chars);
            facts.push(ExtractedFact {
                predicate: "contains_symbol",
                value: name,
                status: "inferred",
                line: index + 1,
                excerpt,
                redacted,
            });
        }
    }

    facts
}

fn symbol_name(line: &str, language: &str) -> Option<String> {
    let mut rest = line.trim();
    for prefix in ["pub ", "export ", "async ", "default ", "static "] {
        if let Some(stripped) = rest.strip_prefix(prefix) {
            rest = stripped.trim();
        }
    }

    let prefixes: &[&str] = match language {
        "python" => &["class ", "def "],
        "rust" => &["fn ", "struct ", "enum ", "trait ", "impl "],
        "javascript" | "typescript" => &[
            "function ",
            "class ",
            "interface ",
            "type ",
            "enum ",
            "const ",
            "let ",
        ],
        _ => &["class ", "struct ", "function ", "fn ", "def "],
    };

    for prefix in prefixes {
        if let Some(after) = rest.strip_prefix(prefix) {
            let name: String = after
                .chars()
                .take_while(|character| character.is_alphanumeric() || *character == '_')
                .collect();
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}

fn redact_excerpt(line: &str, max_chars: usize) -> (String, bool) {
    let lower = line.to_lowercase();
    let sensitive = [
        "password",
        "passwd",
        "secret",
        "token",
        "api_key",
        "apikey",
        "private_key",
        "authorization",
    ];
    if sensitive.iter().any(|marker| lower.contains(marker)) {
        return ("[redacted potentially sensitive line]".to_string(), true);
    }
    (bounded(line, max_chars), false)
}

fn bounded(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn modified_ms(metadata: &fs::Metadata) -> Option<i64> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
}

fn hex_digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn language_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase()
        .as_str()
    {
        "rs" => "rust",
        "py" => "python",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "ts" | "tsx" | "mts" | "cts" => "typescript",
        "c" | "h" => "c",
        "cc" | "cpp" | "cxx" | "hpp" => "cpp",
        "java" => "java",
        "go" => "go",
        "rb" => "ruby",
        "swift" => "swift",
        "sh" => "shell",
        "json" => "json",
        "md" => "markdown",
        _ => "text",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_DIR: AtomicU64 = AtomicU64::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "talos-chronicle-{label}-{}-{}",
                std::process::id(),
                NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed)
            ));
            if path.exists() {
                fs::remove_dir_all(&path).expect("could not clean test directory");
            }
            fs::create_dir_all(&path).expect("could not create test directory");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            if self.0.exists() {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
    }

    fn project_dir(temp: &TestDir, name: &str) -> PathBuf {
        let path = temp.path().join(name);
        fs::create_dir_all(&path).expect("could not create test project");
        path
    }

    fn write_file(root: &Path, relative: &str, contents: &str) {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("could not create test file parent");
        }
        fs::write(path, contents).expect("could not write test file");
    }

    fn run_test_index(temp: &TestDir, root: &Path, generation: u64) -> ChronicleStatus {
        let data_dir = temp.path().join("data");
        let (project_id, _, _) = project_identity(root).expect("could not read project identity");
        index_project_in(&data_dir, root, &project_id, 1, generation, None, &|| true)
            .expect("could not index test project")
    }

    fn count_with_project(store: &ChronicleStore, sql: &str) -> i64 {
        store
            .conn
            .query_row(sql, params![store.project_id], |row| row.get(0))
            .expect("could not count rows")
    }

    fn count_for_source(store: &ChronicleStore, sql: &str, source: &str) -> i64 {
        store
            .conn
            .query_row(sql, params![store.project_id, source], |row| row.get(0))
            .expect("could not count rows for source")
    }

    #[test]
    fn creates_store_and_migrations() {
        let temp = TestDir::new("create");
        let root = project_dir(&temp, "project");
        let data_dir = temp.path().join("data");

        let store = ChronicleStore::open_in(&data_dir, &root).expect("could not open store");
        let status = store.status().expect("could not read status");

        assert_eq!(status.schema_version, SCHEMA_VERSION);
        assert!(status.initialized);
        assert_eq!(
            status.project_root,
            fs::canonicalize(&root).unwrap().to_string_lossy()
        );
        assert_eq!(status.display_name, "project");
        assert!(status
            .database_path
            .ends_with(&format!("{}.sqlite", status.project_id)));
        assert!(Path::new(&status.database_path).is_file());

        let reopened = ChronicleStore::open_in(&data_dir, &root).expect("could not reopen store");
        assert_eq!(reopened.project_id, store.project_id);
        assert_eq!(reopened.status().unwrap().schema_version, SCHEMA_VERSION);
    }

    #[test]
    fn project_identity_is_stable_for_canonical_paths() {
        let temp = TestDir::new("identity");
        let root = project_dir(&temp, "alpha");
        let other = project_dir(&temp, "beta");

        let first = project_identity(&root).expect("could not read identity");
        let dotted = project_identity(&root.join(".")).expect("could not read dotted identity");
        let second = project_identity(&other).expect("could not read other identity");

        assert_eq!(first, dotted);
        assert_ne!(first.0, second.0);
        assert_eq!(first.1, root.canonicalize().unwrap().to_string_lossy());
    }

    #[test]
    fn rejects_missing_project_root() {
        let temp = TestDir::new("missing");
        let missing = temp.path().join("does-not-exist");

        let error = project_identity(&missing).expect_err("missing root should fail");
        assert!(error.contains("could not resolve project root"));

        let error = match ChronicleStore::open_in(&temp.path().join("data"), &missing) {
            Ok(_) => panic!("missing root should fail"),
            Err(error) => error,
        };
        assert!(error.contains("could not resolve project root"));
    }

    #[test]
    fn settings_round_trip_and_persist() {
        let temp = TestDir::new("settings");
        let root = project_dir(&temp, "project");
        let data_dir = temp.path().join("data");

        let store = ChronicleStore::open_in(&data_dir, &root).unwrap();
        let mut settings = ChronicleSettings::default();
        settings.max_file_bytes = 4_096;
        settings.store_unsaved_content = true;
        settings.exclude_patterns.push("generated/**".to_string());

        store
            .set_settings(settings.clone())
            .expect("could not save settings");
        assert_eq!(store.settings().unwrap(), settings);

        let reopened = ChronicleStore::open_in(&data_dir, &root).unwrap();
        assert_eq!(reopened.settings().unwrap(), settings);
        assert_eq!(reopened.status().unwrap().settings, settings);
    }

    #[test]
    fn settings_validation_rejects_invalid_limits() {
        let mut settings = ChronicleSettings::default();
        settings.max_file_bytes = 0;
        assert!(settings.validate().is_err());

        let mut settings = ChronicleSettings::default();
        settings.max_evidence_chars = 9_000;
        assert!(settings.validate().is_err());

        let mut settings = ChronicleSettings::default();
        settings.exclude_patterns.push(String::new());
        assert!(settings.validate().is_err());
    }

    #[test]
    fn status_reports_counts_and_index_stats() {
        let temp = TestDir::new("status");
        let root = project_dir(&temp, "project");
        let store = ChronicleStore::open_in(&temp.path().join("data"), &root).unwrap();
        let time = now_ms();

        store
            .conn
            .execute(
                "INSERT INTO index_state(
                     project_id, path, content_hash, size_bytes, modified_ms,
                     language, last_indexed_ms, status
                 ) VALUES(?1, 'src/main.rs', 'abc123', 42, ?2, 'rust', ?2, 'indexed')",
                params![store.project_id, time],
            )
            .unwrap();

        store
            .conn
            .execute(
                "INSERT INTO observations(
                     project_id, kind, predicate, value, status, source_kind,
                     source_path, created_at, updated_at
                 ) VALUES(?1, 'fact', 'has_language', 'rust', 'verified', 'scan', 'src/main.rs', ?2, ?2)",
                params![store.project_id, time],
            )
            .unwrap();

        store
            .conn
            .execute(
                "INSERT INTO events(
                     project_id, kind, summary, source_kind, created_at
                 ) VALUES(?1, 'index', 'initial index', 'chronicle', ?2)",
                params![store.project_id, time],
            )
            .unwrap();

        let status = store.status().unwrap();
        assert_eq!(status.indexed_files, 1);
        assert_eq!(status.indexed_bytes, 42);
        assert_eq!(status.last_indexed_at, Some(time));
        assert_eq!(status.observations, 1);
        assert_eq!(status.events, 1);
        assert_eq!(status.relations, 0);
        assert_eq!(status.decisions, 0);
    }

    #[test]
    fn indexer_records_facts_and_respects_ignore_rules() {
        let temp = TestDir::new("index");
        let root = project_dir(&temp, "project");
        write_file(&root, ".gitignore", "ignored.txt\n");
        write_file(
            &root,
            "src/main.rs",
            "fn greet() {\n    // TODO: improve\n}\n",
        );
        write_file(&root, "notes.md", "Decision: use SQLite for Chronicle\n");
        write_file(&root, "ignored.txt", "not memory\n");
        write_file(&root, ".env", "SECRET_TOKEN=abc\n");
        write_file(&root, "secret.pem", "private key\n");

        let status = run_test_index(&temp, &root, 1);
        assert_eq!(status.indexed_files, 2);
        assert!(status.indexed_bytes > 0);
        assert_eq!(status.schema_version, SCHEMA_VERSION);

        let store = ChronicleStore::open_in(&temp.path().join("data"), &root).unwrap();
        assert_eq!(
            count_with_project(
                &store,
                "SELECT COUNT(*) FROM observations WHERE project_id = ?1 AND predicate = 'file_language'"
            ),
            2
        );
        assert_eq!(
            count_with_project(
                &store,
                "SELECT COUNT(*) FROM observations WHERE project_id = ?1 AND predicate = 'contains_symbol'"
            ),
            1
        );
        assert_eq!(
            count_with_project(
                &store,
                "SELECT COUNT(*) FROM observations WHERE project_id = ?1 AND predicate = 'todo_marker'"
            ),
            1
        );
        assert_eq!(
            count_with_project(
                &store,
                "SELECT COUNT(*) FROM observations WHERE project_id = ?1 AND predicate = 'decision_marker'"
            ),
            1
        );
        assert_eq!(
            count_with_project(
                &store,
                "SELECT COUNT(*) FROM search_docs WHERE project_id = ?1"
            ),
            2
        );

        let ignored_sql = "SELECT COUNT(*) FROM index_state WHERE project_id = ?1 AND path = ?2";
        assert_eq!(count_for_source(&store, ignored_sql, "ignored.txt"), 0);
        assert_eq!(count_for_source(&store, ignored_sql, ".env"), 0);
        assert_eq!(count_for_source(&store, ignored_sql, "secret.pem"), 0);
    }

    #[test]
    fn reindex_is_incremental_and_prunes_deleted_files() {
        let temp = TestDir::new("reindex");
        let root = project_dir(&temp, "project");
        write_file(&root, "a.rs", "fn alpha() {}\n");

        let first = run_test_index(&temp, &root, 1);
        assert_eq!(first.indexed_files, 1);

        write_file(&root, "b.rs", "fn beta() {}\n");
        let second = run_test_index(&temp, &root, 2);
        assert_eq!(second.indexed_files, 2);

        let store = ChronicleStore::open_in(&temp.path().join("data"), &root).unwrap();
        assert_eq!(
            count_with_project(
                &store,
                "SELECT COUNT(*) FROM index_state WHERE project_id = ?1 AND status = 'unchanged'"
            ),
            1
        );

        fs::remove_file(root.join("a.rs")).expect("could not remove test file");
        let third = run_test_index(&temp, &root, 3);
        assert_eq!(third.indexed_files, 1);

        let store = ChronicleStore::open_in(&temp.path().join("data"), &root).unwrap();
        let indexed_sql = "SELECT COUNT(*) FROM index_state WHERE project_id = ?1 AND path = ?2";
        assert_eq!(count_for_source(&store, indexed_sql, "a.rs"), 0);
        assert_eq!(count_for_source(&store, indexed_sql, "b.rs"), 1);
    }

    #[test]
    fn indexer_can_be_cancelled() {
        let temp = TestDir::new("cancel");
        let root = project_dir(&temp, "project");
        write_file(&root, "main.rs", "fn main() {}\n");
        let data_dir = temp.path().join("data");
        let (project_id, _, _) = project_identity(&root).unwrap();

        let error = match index_project_in(&data_dir, &root, &project_id, 1, 1, None, &|| false) {
            Ok(_) => panic!("cancelled index should fail"),
            Err(error) => error,
        };
        assert_eq!(error, "cancelled");
    }

    #[test]
    fn sensitive_excerpt_is_redacted() {
        let temp = TestDir::new("redact");
        let root = project_dir(&temp, "project");
        write_file(&root, "notes.md", "TODO password=abc123\n");

        run_test_index(&temp, &root, 1);
        let store = ChronicleStore::open_in(&temp.path().join("data"), &root).unwrap();
        let excerpt: String = store
            .conn
            .query_row(
                "SELECT excerpt FROM evidence WHERE project_id = ?1 AND source_path = 'notes.md' AND redacted = 1 LIMIT 1",
                params![store.project_id],
                |row| row.get(0),
            )
            .expect("could not read redacted evidence");
        assert_eq!(excerpt, "[redacted potentially sensitive line]");
    }

    #[test]
    fn search_returns_evidence_backed_results() {
        let temp = TestDir::new("search");
        let root = project_dir(&temp, "project");
        write_file(&root, "notes.md", "TODO: improve parser caching\n");

        run_test_index(&temp, &root, 1);
        let store = ChronicleStore::open_in(&temp.path().join("data"), &root).unwrap();
        let results = store.search("parser", Some(10)).unwrap();

        let result = results
            .iter()
            .find(|value| value.source_path.as_deref() == Some("notes.md"))
            .expect("indexed file should be searchable");
        assert_eq!(result.kind, "file");
        let evidence = result
            .evidence
            .as_ref()
            .expect("search result should carry evidence");
        assert_eq!(evidence.source_path.as_deref(), Some("notes.md"));
        assert!(evidence.excerpt.contains("TODO"));
    }

    #[test]
    fn decisions_and_timeline_record_evidence() {
        let temp = TestDir::new("decisions");
        let root = project_dir(&temp, "project");
        let mut store = ChronicleStore::open_in(&temp.path().join("data"), &root).unwrap();

        let decision = store
            .record_decision(ChronicleDecisionInput {
                title: "Use SQLite".to_string(),
                context: Some("Local project memory".to_string()),
                decision: "Persist memory in SQLite".to_string(),
                consequences: None,
                status: "accepted".to_string(),
                supersedes_id: None,
                evidence: Some("ADR-001: use SQLite".to_string()),
                source_path: Some("docs/adr.md".to_string()),
                line: Some(12),
            })
            .expect("could not record decision");

        assert_eq!(decision.status, "accepted");
        let evidence = decision
            .evidence
            .as_ref()
            .expect("decision should carry evidence");
        assert_eq!(evidence.source_kind, "user");
        assert_eq!(evidence.source_path.as_deref(), Some("docs/adr.md"));
        assert_eq!(evidence.line_start, Some(12));
        assert!(evidence.excerpt.contains("ADR-001"));

        let timeline = store.timeline(Some(10)).unwrap();
        assert!(timeline
            .iter()
            .any(|event| event.kind == "decision_recorded"));

        let decisions = store.decisions(Some(10)).unwrap();
        assert_eq!(decisions.len(), 1);
        assert_eq!(decisions[0].id, decision.id);

        let results = store.search("sqlite", Some(10)).unwrap();
        assert!(results.iter().any(|result| result.kind == "decision"));
    }

    #[test]
    fn observations_validate_inputs_and_redact_evidence() {
        let temp = TestDir::new("observations");
        let root = project_dir(&temp, "project");
        let mut store = ChronicleStore::open_in(&temp.path().join("data"), &root).unwrap();

        let observation = store
            .observe(ChronicleObservationInput {
                kind: "user_fact".to_string(),
                predicate: "deployment_token".to_string(),
                value: "configured".to_string(),
                confidence: 0.8,
                status: "inferred".to_string(),
                source_kind: "user".to_string(),
                source_path: None,
                line: None,
                evidence: Some("token=abc123".to_string()),
            })
            .expect("could not record observation");

        let evidence = observation
            .evidence
            .as_ref()
            .expect("observation should carry evidence");
        assert!(evidence.redacted);
        assert_eq!(evidence.excerpt, "[redacted potentially sensitive line]");

        let invalid = ChronicleObservationInput {
            kind: "user_fact".to_string(),
            predicate: "bad".to_string(),
            value: "value".to_string(),
            confidence: 1.5,
            status: "inferred".to_string(),
            source_kind: "user".to_string(),
            source_path: None,
            line: None,
            evidence: None,
        };
        assert!(store.observe(invalid).is_err());
    }

    #[test]
    fn decision_status_change_updates_search_and_timeline() {
        let temp = TestDir::new("decision-status");
        let root = project_dir(&temp, "project");
        let mut store = ChronicleStore::open_in(&temp.path().join("data"), &root).unwrap();

        let decision = store
            .record_decision(ChronicleDecisionInput {
                title: "Use SQLite".to_string(),
                context: None,
                decision: "Persist memory locally".to_string(),
                consequences: None,
                status: "accepted".to_string(),
                supersedes_id: None,
                evidence: None,
                source_path: None,
                line: None,
            })
            .expect("could not record decision");

        let updated = store
            .set_decision_status(decision.id, "superseded".to_string(), None)
            .expect("could not update decision status");
        assert_eq!(updated.status, "superseded");

        let results = store.search("sqlite", Some(10)).unwrap();
        assert!(results
            .iter()
            .any(|result| result.kind == "decision" && result.title == "Use SQLite"));

        let timeline = store.timeline(Some(10)).unwrap();
        assert!(timeline
            .iter()
            .any(|event| event.kind == "decision_status_changed"));

        assert!(store
            .set_decision_status(decision.id, "invalid".to_string(), None)
            .is_err());
    }
}
