# Talos Chronicle architecture

Talos Chronicle is the local-first project memory engine for Talos Crest. It stores structured observations, timeline events, relationships, decisions, evidence, and searchable text in a per-project SQLite database outside the user's repository.

## Status

| Slice | Status | Scope |
|---|---|---|
| C1 | Complete | SQLite storage, migrations, stable project identity, status/settings commands |
| C2 | Complete | Bounded incremental indexing, ignore support, evidence, observations, events, searchable text, cancellation |
| C3 | Complete | Bounded FTS search, timeline, observations, ADR-style decisions, evidence-backed commands |
| C4 | Shipped with limits | Chronicle panel UI, local privacy controls, async commands, safe evidence links |
| C5 | Not implemented | Optional semantic search and AI grounding |

## Storage layout

Chronicle data lives outside the workspace:

```text
$XDG_DATA_HOME/talos/chronicle/<project-id>.sqlite
```

Fallback:

```text
~/.local/share/talos/chronicle/<project-id>.sqlite
```

The `project-id` is the lowercase SHA-256 of the canonical project root path. Canonicalization makes repeated opens stable even when the user passes `.` or a relative path. The database is never written into the indexed repository, so Chronicle memory is not accidentally committed, deleted, or scanned as project source.

SQLite is used because it provides transactions, durable schema migrations, concurrency-safe access, and FTS5-backed local search without a server. `rusqlite` is compiled with bundled SQLite so FTS5 behavior does not depend on the host distribution.

## Schema model

Core tables:

- `projects` — stable project identity, canonical root, display name.
- `settings` — per-project Chronicle settings as JSON.
- `evidence` — source kind/path, line range, bounded redacted excerpt, excerpt hash.
- `entities` — files, symbols, modules, and future relationship endpoints.
- `observations` — extracted or user-supplied facts with confidence and status.
- `events` — append-only timeline entries.
- `relations` — typed relationships between entities.
- `decisions` — ADR-like recorded decisions with status and supersession.
- `index_state` — per-file hash, size, language, status, and index generation.
- `snapshots` — bounded project summaries.
- `search_docs` — FTS5 index over file facts and future records.
- `migrations` — applied schema migration log.

Every non-user claim carries evidence, confidence, and one of these statuses:

- `verified` — directly derived from filesystem/tool data.
- `inferred` — heuristic extraction from untrusted source text.
- `proposed` — a possible decision or interpretation requiring confirmation.

Chronicle does not fabricate explanations. Indexing stores facts and bounded evidence; C3 search, timeline, observations, and decisions return only stored records and their evidence. The `entities`, `relations`, and `snapshots` tables exist for a future semantic layer but are not populated by shipped analysis, and `commit_hash` remains empty because this build has no Source Control provider.

## Indexing pipeline

Indexing runs in `tauri::async_runtime::spawn_blocking` and is cancelable. The frontend and editor hot path are not involved.

1. A job generation is registered for the project.
2. Files are collected with an iterative, non-recursive-symlink traversal.
3. Exclusions are applied from:
   - default patterns in settings,
   - `.gitignore` when enabled,
   - `.ignore` when enabled,
   - `.talosignore` when enabled,
   - hidden-file rules,
   - defense-in-depth secret rules.
4. Each file is bounded by `maxFileBytes`, `maxFiles`, and `maxTotalBytes`.
5. SHA-256 content hashes skip unchanged files.
6. Changed UTF-8 files produce bounded observations and evidence excerpts.
7. Records are committed in small batches.
8. Stale file-derived `index_state` and search rows are pruned at the end; user-authored decision and observation records are preserved.
9. Progress and completion are emitted as Tauri events.

All Chronicle IPC commands move SQLite and filesystem work to `spawn_blocking`; none of it runs on the UI thread. Indexing requires `settings.enabled`, and the workspace-change path additionally requires `settings.index_on_workspace_change`. A disabled manual start returns an explanatory error; disabled automatic starts are silent no-ops so saving a file cannot surface errors or add work to a typing path.

Cancellation is generation-based. Starting a new index increments the generation, and older jobs stop at their next check. `chronicle_index_cancel` increments the generation for the active job. A cancelled job commits bounded work already completed, skips pruning, and retains its last-good `index_state` rows so reported status remains accurate. Unreadable files and directories are logged and skipped rather than aborting a whole pass.

The frontend coalesces progress and update events, tracks job identity so stale events are ignored, discards late responses after a query or workspace change, and resolves evidence paths only inside the active workspace. Chronicle indexing is not triggered by keystrokes or unsaved buffers; the explorer dispatches `talos:workspace-files-changed` and calls `chronicle_index_on_workspace_change`, which honours the settings gate.

## Privacy and untrusted content

- Repository content is treated as untrusted data, never as instructions.
- `.env*`, key/certificate files, credential files, and `.git` contents are always excluded.
- Excerpt text is bounded and redacted when common sensitive markers appear.
- Unsaved editor content is not indexed; `storeUnsavedContent` exists for future explicit use and defaults to `false`.
- No network calls are made by Chronicle.
- All data can be inspected, exported, and deleted through planned C4 commands.

## IPC surface

Implemented in C1/C2/C3:

```text
chronicle_status
chronicle_settings
chronicle_set_settings
chronicle_index_start
chronicle_index_cancel
chronicle_index_on_workspace_change
chronicle_search
chronicle_timeline
chronicle_decisions
chronicle_record_decision
chronicle_observe
chronicle_set_decision_status
```

Events:

```text
chronicle://progress
chronicle://updated
chronicle://error
```

Planned in C4/C5:

```text
chronicle_inspect
chronicle_export
chronicle_delete_project
chronicle_capture_session
```

## Search and records

C3 adds local FTS5 search over indexed file facts and user-supplied records. Queries are sanitized into bounded prefix terms before reaching FTS5, so repository text and user input are treated as data rather than FTS syntax. Results are capped, carry a bounded snippet, and include the stored evidence row when one exists. An empty or punctuation-only query returns the most recent bounded records rather than an error.

Timeline, observations, and decisions are append-oriented and bounded. User-supplied evidence is redacted with the same rule used by the indexer, stored with a hash, and linked from observations, events, decisions, and search rows. Decision status changes replace the decision's search row and append a new timeline event instead of mutating history silently.

## Performance contract

- No Chronicle parsing or database work runs on the UI thread.
- Indexing is incremental and hash-based.
- Work is cancelable and bounded by file count, file size, total bytes, directories, excerpt length, and facts per file.
- Batch commits avoid large single transactions.
- Database pragmas use WAL, `busy_timeout`, foreign keys, and `synchronous = NORMAL`.
- Later UI work must remain virtualized, deferred, and idle-scheduled to preserve typing responsiveness.
