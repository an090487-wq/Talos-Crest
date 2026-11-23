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

### Phase 2 — Unify ignore/security policy

- Make Chronicle consume the shared workspace policy instead of its divergent matcher.
- Add real on-disk `.gitignore`, `.ignore`, `.talosignore`, hidden, and sensitive-file tests.

### Phase 3 — Shared scan snapshot

- Reuse one generation-stamped workspace snapshot for find-in-files, watcher setup, dependency source reads, and insights where safe.
- Avoid content reads during workspace open; preserve `spawn_blocking` and generation guards.

### Phase 4 — Watcher and event reliability

- Bound the pending event map.
- Add automatic recovery/re-registration tests and multiple-directory-change coverage.
- Preserve the existing 750 ms emit interval and idle/deferred UI updates.

### Phase 5 — Explorer and project intelligence

- Add lazy child loading, copy/duplicate, drag/drop, inline create/rename, and a project overview panel.
- Keep virtualized rendering and expansion/selection persistence.

### Phase 6 — Constellation and ecosystem integration

- Build the filtered, progressive Project Constellation on the shared dependency model.
- Add Canvas workspace asset browsing and explicit Ollama privacy-gated context retrieval.

### Phase 7 — Measurements and documentation

- Record reproducible scan latency, watcher propagation, memory, and typing-responsiveness measurements.
- Update README/release notes only with measured results and explicit limitations.

## Non-goals for this increment

- No dependency graph rewrite.
- No new npm/crate dependencies.
- No Source Control provider.
- No multi-root `.code-workspace` file support.
- No claim of zero lag or GUI-verified bug-free behavior.
