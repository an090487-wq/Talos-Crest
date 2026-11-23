# TALOS Universal Workspace Engine (TUWE) — Phase 0 audit and implementation plan

## Scope rule

This is an enhancement of the existing Talos Crest workspace stack, not a rewrite. The existing CodeMirror editor, Tauri 2 Rust commands, Chronicle, Canvas, Calc, Observatory, terminal, extensions, themes, diagnostics, and offline defaults remain in place.

## Phase 0 audit summary

### Existing workspace opening flow

- Folder selection is frontend-owned: `open({ directory: true })` in `app/src/architecture.ts:1533-1536`.
- `scanProject()` serializes scans, applies generation guards, invokes `scan_project`, stores the canonical root, remembers it globally, and broadcasts workspace events (`app/src/architecture.ts:1713-1824`).
- Backend `scan_project` runs `scan_project_tree` in `spawn_blocking` and is bounded to 50,000 entries / depth 64 (`app/src-tauri/src/lib.rs:838-1020`).
- The saved root is restored per window on startup (`app/src/architecture.ts:2310-2311`), but there is no fallback if that root moved or was deleted.

### Existing capabilities worth reusing

- `ProjectScan` / `ProjectEntry` already carry id, root, path, parent, kind, extension, language, size, mtime, depth, and counts (`app/src/architecture.ts:27-47`, `app/src-tauri/src/lib.rs:801-814`).
- Shared ignore policy: `.gitignore`, `.ignore`, `.talosignore`, user exclusions, hidden files, and sensitive names (`app/src-tauri/src/workspace.rs:24-126`).
- Debounced native watcher with per-path coalescing and bounded watched-directory registration (`app/src-tauri/src/lib.rs:1453-1688`).
- Bounded, cancellable, hash-based Chronicle indexer with SQLite/FTS5 (`app/src-tauri/src/chronicle.rs`).
- Virtualized Explorer rows and Quick Open worker search (`app/src/architecture.ts:634-770`, `app/src/project-search-worker.ts`).
- Recent projects persisted in `recent.json` (`app/src-tauri/src/lib.rs:308-375`).

### Duplication and gaps

- Four separate tree walks exist: Explorer scan, find-in-files, watcher directory collection, and Chronicle collection.
- No single frontend workspace state object consumes those signals; state is split across `scan`, localStorage, module globals, events, and Chronicle SQLite.
- No explicit global “always open this workspace” setting; restore is per window only.
- No status-bar workspace/indexing indicator.
- No true lazy per-directory loading, drag/drop, copy operation, inline rename, or resizable Explorer overlay.
- Chronicle uses its own ignore matcher, which has drifted from the Explorer policy.
- Raw file read/write commands are not workspace-boundary checked.

## Implementation plan

### Phase 1 — Shared workspace state and reliable restore (this increment)

1. Add a pure `workspace-state.ts` model for id, root, name, status, counts, indexing, watcher status, and messages.
2. Add a thin `workspace.ts` service that owns state updates, subscriptions, recent-workspace candidates, and persistence.
3. Wire `architecture.ts` to publish scan opening/ready/error, watcher, and indexing state through the service.
4. Restore the last workspace, falling back to recent projects when the saved root fails.
5. Add explicit **Open Folder** and **Open Recent Workspace** commands; relabel the Explorer button for VS Code familiarity.
6. Add a status-bar workspace indicator with indexing/watcher state.
7. Add functional unit tests for the state model and static wiring checks.

Checkpoint: `tsc --noEmit`, `npm test`, `npm run build`, `cargo test --workspace`, `git diff --check`.

### Phase 2 — Unify ignore/security policy (completed)

- Chronicle now consumes `WorkspacePolicy::load_with_options` from the shared module instead of its private `IgnoreMatcher`; the duplicate `is_always_excluded` / `has_hidden_component` code is removed.
- Sensitive-name protection is centralized in `WorkspacePolicy` and cannot be disabled by subsystem settings.
- Added `subsystem_policy_options_keep_hidden_and_sensitive_rules` Rust test.

Additional Phase 2 defect fixes:
- Stale dependency/insight caches are invalidated when the watcher changes files.
- `workspace_entry_metadata` inspects the symlink itself, so links outside the root no longer fail canonicalization or report as files.
- Explorer rows carry a tooltip explaining that double-click or Enter opens/expands.

### Phase 3 — Shared scan snapshot (completed)

- Find-in-files now receives the file paths from the frontend's current
  `ProjectScan` snapshot. The backend validates each path against the canonical
  root and the live `WorkspacePolicy` before reading it; if no paths are
  supplied, it falls back to the original tree walk.
- Watcher registration receives the snapshot's directory list with the same
  validation and a fallback walk. Truncated scans deliberately keep the fallback
  because their snapshot is incomplete.
- `findInWorkspace` captures both the scan object and `scanGeneration` and drops
  results if either changed while the search was running.
- Dependency analysis and insights already consumed snapshot paths, so they were
  left unchanged. Chronicle's own settings-driven indexer also stays separate.
- Synthetic 2,000-file microbenchmark in `cargo test` (three runs): full walk
  42–49 ms, reused snapshot 28–40 ms. This is one machine and one workload; it
  is not a general latency guarantee.

### Phase 4 — Watcher and event reliability (completed)

- Bounded the pending change map at 10,000 paths; overflow collapses to one `__talos_rescan__` event that forces a full scan instead of unbounded growth or silent loss.
- Added frontend watcher recovery with three exponential-backoff re-registration attempts; successful scans reset the counter and clear pending timers.
- Preserved the existing 750 ms emit interval and idle/deferred UI updates.
- Added Rust test `workspace_change_queue_is_bounded_and_requests_rescan_on_overflow` and static frontend wiring checks.

### Phase 5 — Explorer and project intelligence (in progress)

- Completed in this increment: **duplicate** and **drag-to-move**. Duplicate is available from the context menu and details pane, chooses a unique `name (copy)` destination, and is bounded to 10,000 entries, 64 MiB, and 64 levels. Ignored, sensitive, special, and symbolic children are skipped and counted. All paths are validated against the canonical root and the live workspace policy before any write. Drag-and-drop reuses the existing root-bound move command, rejects dropping a folder into itself, maps open tab paths/expanded folders to their new locations, and refreshes the snapshot. Virtualized rows gained drag/drop affordances and a drop-target highlight.
- Still remaining: lazy per-directory child loading, inline create/rename, and a project overview panel.
- Keep virtualized rendering and expansion/selection persistence.

### Phase 6 — Constellation and ecosystem integration

- Build the filtered, progressive Project Constellation on the shared dependency model.
- Add Canvas workspace asset browsing and explicit Ollama privacy-gated context retrieval.

### Phase 7 — Measurements and documentation

- Record reproducible scan latency, watcher propagation, memory, and typing-responsiveness measurements.
- Update README/release notes only with measured results and explicit limitations.

## Additional defect fixes (editor increment)

Two user-reported dead ends were addressed outside the workspace phases:

- Binary files such as `arp_spoof.cpython-312.pyc` are no longer rejected with a
  message only. `loadPath` opens a read-only preview backed by a new bounded
  `binary_preview` Tauri command (64 KiB per page), with a hex dump and
  printable-strings view. Formatting lives in pure, tested helpers in
  `app/src/binary-view.ts`.
- A real local error detection engine was added in `app/src/error-engine.ts`
  with data-driven rules in `app/src/error-rules.ts`. It scans the CodeMirror
  document with bounded regexes, ignores matches in comments/strings, merges
  results into the Problems panel, and supports user-defined JSON rules saved
  locally through a validated dialog. It is explicitly pattern-based, not a
  compiler or language server.

## Non-goals for this increment

- No dependency graph rewrite.
- No new npm/crate dependencies.
- No Source Control provider.
- No multi-root `.code-workspace` file support.
- No claim of zero lag or GUI-verified bug-free behavior.
