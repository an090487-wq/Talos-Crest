# Phase 1 — Complete Application Audit

## Architecture

- **Frontend**: TypeScript modules loaded by `app/src/main.ts`; no UI framework.
  - Editor: CodeMirror 6, single `EditorView`, tabs swap `EditorState`.
  - Workspace: `app/src/architecture.ts` — scan, tree, watcher, Quick Open.
  - Canvas: `app/src/canvas/canvas-ui.ts` — layered canvas editor.
  - Chronicle: SQLite/FTS5 backend, timeline/decision views.
  - PDF: `app/src/pdf.ts` — pdf.js viewer.
  - Terminal: xterm.js with Tauri backend.
  - Extensions: manifest-driven registry.
- **Backend**: Rust (Tauri 2) in `app/src-tauri/src/lib.rs` + modules.
  - Workspace scan, watcher, file I/O, Chronicle, terminal.
  - Shared `WorkspacePolicy` for ignore/sensitive rules.

## Confirmed Problems and Causes

### 1. File opening reliability
- **Cause**: `loadPath` calls `readFileSnapshot`; if it returns `null` (file not found or inaccessible), throws. `guard()` catches and shows status bar message, but user may not see it.
- **Cause**: `openSnapshotInTab` skips content update if tab already exists for that path (could show stale content).
- **Cause**: Binary files (>64MB or containing NUL) open in a dialog, not the editor. For `.pyc` files inside `__pycache__`, the directory is ignored by default, so files never appear in the tree.
- **Cause**: Unknown extensions are treated as plain text (correct), but no language package may be available.

### 2. Workspace explorer
- **Cause**: Explorer was a full-screen overlay, not a docked sidebar (fixed: now docked).
- **Cause**: Single-click now opens files (fixed).
- **Cause**: `__pycache__`, `node_modules`, etc. are in `DEFAULT_EXCLUSIONS`, making their contents invisible.
- **Cause**: Lazy loading may lose `selectedPath` on refresh.

### 3. Responsive layout
- **Cause**: Fixed 280px panel height, no height breakpoints (partially fixed).
- **Cause**: Canvas, Calc, Chronicle still have view-specific constraints.
- **Cause**: Toolbars clip in compact mode (partially fixed with overflow menu).

### 4. Language support
- **Cause**: CodeMirror language packages are loaded dynamically via `LanguageDescription.matchFilename`. Most common languages are covered by `@codemirror/language-data`.
- **Cause**: LSP integration is not present; diagnostics are pattern-based only.
- **Cause**: No language adapter registry for optional advanced features.

### 5. Canvas
- **Cause**: `canvasPoint` called `getBoundingClientRect()` on every pointer move (fixed: cached).
- **Cause**: Shape preview and selection updates may cause reflow.
- **Cause**: Large images open at reduced resolution by default.

### 6. Performance
- **Cause**: Full scans on every file mutation (partially mitigated by lazy loading).
- **Cause**: `applyWorkspaceChanges` does full scan for directory changes.
- **Cause**: No debouncing on some render paths.

## Test Results

- TypeScript: clean
- JS tests: 133/133 passing
- Rust tests: 60 passing
- Frontend build: successful
- Linux AppImage: built and launched

## Priority Fixes

1. Make file opening more robust with visible error feedback.
2. Add "show ignored files" toggle for __pycache__, node_modules, etc.
3. Improve Canvas pointer performance further.
4. Ensure .pyc and all binary files open reliably.
5. Add language adapter registry for optional LSP support.
}