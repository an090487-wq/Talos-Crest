# Talos Crest advanced engineering upgrade — implementation plan

## Scope rule

This plan improves the existing Talos Crest application. It does not replace the
CodeMirror editor, the Tauri 2 Rust backend, the workspace policy, or the
existing feature modules. The application stays local-first and offline by
default; only the opt-in GitHub Observatory may contact GitHub.

## Architecture observed

- **Desktop shell:** Tauri 2, Rust commands in `app/src-tauri/src/lib.rs` and
  modules such as `workspace.rs`, `chronicle.rs`, and `terminal.rs`.
- **Frontend:** TypeScript modules loaded by `app/src/main.ts`; no UI framework.
  Inline shell CSS lives in `app/index.html`; shared design-system rules live in
  `app/src/ui/design-system.css`.
- **Editor:** one CodeMirror 6 `EditorView` mounted once into `#editor`; document
  tabs swap `EditorState` instead of rebuilding the view.
- **Workspace:** recursive, bounded Rust scan plus a native watcher. The shared
  `WorkspacePolicy` is the single ignore/sensitive-file policy.
- **Background work:** Quick Open and project search workers, a Canvas image
  worker, a Chronicle SQLite/FTS5 indexer, and deferred diagnostics/outline work.
- **Persistence:** per-window keys under `talos.window.<label>.` plus global
  device preferences in `localStorage`.

## Implemented, partial, and placeholder features

### Workspace and Explorer

- Implemented: open arbitrary folders, recursive bounded scan, virtualized rows,
  expansion/selection persistence, watcher events, shared scan snapshot for
  search/watcher registration, `.gitignore`/`.ignore`/`.talosignore` policy,
  hidden/sensitive filtering, create/rename/move/delete, duplicate, drag-to-move,
  recent workspaces, and per-window restore.
- Partial: large-project loading still performs a recursive snapshot rather than
  lazy per-directory child loading; create/rename use prompts; no project overview
  panel.
- Not present: source control provider, multi-root workspace files.

### Editor

- Implemented: multiple tabs, CodeMirror multi-cursor/rectangular selection,
  find/replace, command palette, breadcrumbs, syntax highlighting, folding,
  configurable shortcuts, outline, diagnostics, local pattern-based error rules,
  binary preview, session restore, and dirty-buffer handling.
- Partial: diagnostics are parser/local-rule based, not LSP/compiler semantics;
  no minimap; no measured keystroke benchmark.
- Not present: split editor groups, full diff viewer, project-wide replace UI.

### Project intelligence and Chronicle

- Implemented: dependency/import analysis for supported languages, architecture
  classification, project-wide text search, Quick Open, Explorer insights, and
  Chronicle timeline/decision/search views backed by SQLite/FTS5.
- Partial: dependency relationships are inferred from supported source patterns
  and must not be presented as verified runtime facts; Chronicle's
  `entities`/`relations`/`snapshots` schema exists but is not surfaced.
- Not present: Project Constellation, source control history, cloud AI.

### Canvas

- Implemented: image opening, layers, selection/crop, resize, rotation, filters,
  grading, undo/redo, worker transforms, export, and fit-to-viewport behavior.
- Partial: fit mode now re-fits on resize; vector-node editing and some export
  formats are not present.

### Calc

- Implemented: scientific/programmer modes, history, memory, base conversions,
  unit conversion, keyboard input, implicit multiplication, and CSS-responsive
  dialog layout.
- Partial: no dedicated compact-height controller; the dialog relies on CSS and
  scrolling.

### Extensions

- Implemented: registry loading, categories, search/filtering, versions,
  dependency requirements, permission review, manifest validation, install,
  enable/disable, update, rollback, and removal.
- Partial: compatibility is manifest-driven; there is no remote signature chain
  or transparency log.
- The registry contains many local snippet/template/theme packs; no claim is made
  that external integrations work.

### Live preview

- Implemented: sandboxed HTML preview in an iframe with no same-origin access to
  the IDE, debounced live refresh, manual reload, viewport presets, and a bounded
  console/error panel fed by a nonce-checked bridge that accepts messages only
  from the active preview frame.
- Partial: previews the current buffer only; no local asset resolution,
  multi-page navigation, or source-map-aware stack traces. A restrictive CSP in
  the previewed document can block console capture.

## Prioritized implementation plan

### Increment A — adaptive layout foundation (implemented)

- Pure width/height layout model with Auto/Large/Medium/Compact modes.
- Per-window mode override and safe panel/side-pane clamping.
- rAF-coalesced layout sync and CodeMirror remeasurement off the typing path.
- Compact toolbar overflow, wrapped terminal toolbar, Chronicle height relaxation,
  Architecture Explorer exclusion access, and Canvas resize re-fit.
- Tauri minimum window size.

### Increment B — lazy workspace loading and Explorer polish

Implemented:

1. `list_project_directory` lists one directory level through the shared policy
   and a bounded child count, with symlink and path-boundary checks.
2. Initial project open, workspace restore, Quick Open fallback, and project
   watcher registration now use that lazy listing; loaded directories are tracked
   and expanded on demand.
3. Full scan remains available as an explicit fallback for Quick Open, Find in
   Files, dependency analysis, architecture classification, insights, and
   watcher recovery.

Remaining:

1. Inline create/rename with validation and cancellation.
2. A project overview panel built from existing scan/insight data.
3. A faster name-based backend index for Quick Open that avoids a full scan.

### Increment C — search, diff, and editor groups

1. Add project-wide replace with explicit review, per-file confirmation, atomic
   writes, and revision checks.
2. Add a read-only diff view for dirty buffers and disk changes.
3. Introduce editor groups only if the single-view/tab model can be extended
   without duplicating document state or breaking typing performance.

### Increment D — Chronicle evidence model

1. Surface verified file-change evidence and user-entered decision records.
2. Add explicit "inferred" labels for dependency/architecture relationships.
3. Add searchable links between decisions, tests, and affected files without
   inventing intent.

### Increment E — Live Studio

Implemented:

1. Preview viewport presets and a reload control.
2. Console/error capture through a bounded, nonce-checked bridge, with the
   preview frame remaining sandboxed and separate from IDE privileges.

Remaining:

1. Resolve local assets through a safe, read-only preview URL layer.
2. Add multi-page navigation and clearer limits for CSP-blocked capture.

### Increment F — extension integrity and performance measurements

1. Add an explicit integrity/signature design before claiming secure remote
   installation.
2. Record reproducible memory/CPU and typing-latency measurements on the target
   hardware; do not claim zero lag.

## Validation policy

Each increment must pass:

- `cd app && ./node_modules/.bin/tsc --noEmit`
- `npm test`
- `npm run build`
- `cargo test --workspace`
- Windows cross-check/build where the change affects Rust or the shell
- `git diff --check`

GUI resize, high-DPI, screen-reader, and physical Windows tests must be reported
as performed or not performed. Static/unit tests are not a substitute for the
packaged-app matrix.
