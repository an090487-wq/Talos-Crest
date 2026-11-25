import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(appDir, "src/workspace-state.ts");
const compiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const stateModule = { exports: {} };
new Function("require", "module", "exports", compiled)(
  createRequire(sourcePath),
  stateModule,
  stateModule.exports
);
const {
  INITIAL_WORKSPACE_STATE,
  workspaceNameFromRoot,
  workspaceOpening,
  workspaceReady,
  workspaceError,
  workspaceWatcher,
  workspaceIndexing,
} = stateModule.exports;

const architecture = readFileSync(resolve(appDir, "src/architecture.ts"), "utf8");
const main = readFileSync(resolve(appDir, "src/main.ts"), "utf8");
const html = readFileSync(resolve(appDir, "index.html"), "utf8");
const libRs = readFileSync(resolve(appDir, "src-tauri/src/lib.rs"), "utf8");
const chronicleRs = readFileSync(resolve(appDir, "src-tauri/src/chronicle.rs"), "utf8");

test("workspace names handle POSIX, Windows, and trailing separators", () => {
  assert.equal(workspaceNameFromRoot("/work/my project/"), "my project");
  assert.equal(workspaceNameFromRoot("C:\\work\\Talos Crest"), "Talos Crest");
  assert.equal(workspaceNameFromRoot("/"), "/");
});

test("opening a workspace records the root before metadata is available", () => {
  const opening = workspaceOpening("/work/demo");
  assert.equal(opening.status, "opening");
  assert.equal(opening.root, "/work/demo");
  assert.equal(opening.name, "demo");
  assert.equal(opening.overview, null);
});

test("a ready workspace exposes identity, counts, and watcher state", () => {
  const opening = workspaceOpening("/work/demo");
  const indexing = workspaceIndexing(opening, "indexing");
  const ready = workspaceReady(indexing, {
    id: "abc123",
    root: "/work/demo",
    entries: [
      { kind: "file" },
      { kind: "file" },
      { kind: "directory" },
      { kind: "link" },
    ],
    warnings: ["one warning"],
    truncated: true,
  }, "active");

  assert.equal(ready.status, "ready");
  assert.equal(ready.id, "abc123");
  assert.equal(ready.watcher, "active");
  assert.equal(ready.indexing, "indexing");
  assert.deepEqual(
    {
      files: ready.overview.files,
      directories: ready.overview.directories,
      links: ready.overview.links,
      warnings: ready.overview.warnings,
      truncated: ready.overview.truncated,
    },
    { files: 2, directories: 1, links: 1, warnings: 1, truncated: true }
  );
});

test("failed, watcher, and indexing transitions preserve a coherent state", () => {
  const failed = workspaceError(INITIAL_WORKSPACE_STATE, "/work/gone", new Error("missing"));
  assert.equal(failed.status, "error");
  assert.match(failed.message, /Could not open gone: Error: missing/);

  const opened = workspaceReady(failed, {
    id: "id",
    root: "/work/demo",
    entries: [],
    warnings: [],
    truncated: false,
  }, "idle");
  assert.equal(workspaceWatcher(opened, "error").watcher, "error");
  assert.equal(workspaceWatcher(INITIAL_WORKSPACE_STATE, "active").watcher, "idle");
  assert.equal(workspaceIndexing(opened, "idle").indexing, "idle");
});

test("architecture publishes workspace state and restores with recent fallback", () => {
  assert.match(architecture, /from "\.\/workspace"/);
  assert.match(architecture, /workspaceRestoreCandidates\(\)/);
  assert.match(architecture, /markWorkspaceReady\(result, watcherStatus\)/);
  assert.match(architecture, /markWorkspaceError\(root, error\)/);
  assert.match(architecture, /markWorkspaceIndexing\("indexing"\)/);
  assert.match(architecture, /export function openRecentWorkspace\(\)/);
});

test("shell exposes Open Folder, Open Recent, and workspace status", () => {
  assert.match(main, /label: "Open Folder"/);
  assert.match(main, /label: "Open Recent Workspace"/);
  assert.match(main, /subscribeWorkspace\(renderWorkspaceStatus\)/);
  assert.match(main, /chronicle:\/\/progress/);
  assert.match(html, /id="workspace-status"/);
  assert.match(html, /id="arch-open-project"[^>]*>Open Folder</);
});

test("Chronicle uses the shared workspace policy instead of a private parser", () => {
  assert.match(chronicleRs, /use crate::workspace::\{WorkspacePolicy, WorkspacePolicyOptions\}/);
  assert.match(chronicleRs, /WorkspacePolicy::load_with_options/);
  assert.doesNotMatch(chronicleRs, /struct IgnoreMatcher/);
  assert.doesNotMatch(chronicleRs, /fn is_always_excluded/);
});

test("watcher queue is bounded and frontend handles rescan and recovery", () => {
  assert.match(libRs, /const MAX_PENDING_CHANGES: usize = 10_000;/);
  assert.match(libRs, /RESCAN_KIND/);
  assert.match(architecture, /change\.kind === "__talos_rescan__"/);
  assert.match(architecture, /watcherRecoveryAttempts >= 3/);
  assert.match(architecture, /watcherRecoveryTimer/);
});

test("stale analysis caches are invalidated on file changes", () => {
  assert.match(architecture, /dependencyResult = null;/);
  assert.match(architecture, /performanceReport = null;/);
  assert.match(architecture, /manifestSet = null;/);
  assert.match(architecture, /debtReport = null;/);
});

test("symlink metadata inspects the link itself", () => {
  assert.match(libRs, /fs::symlink_metadata\(&candidate\)/);
  assert.match(libRs, /Inspect the link itself, not its target/);
});

test("find-in-files reuses the generation-stamped snapshot", () => {
  assert.match(architecture, /const snapshot = scan;\s*const generation = scanGeneration;/);
  assert.match(architecture, /paths: snapshotPaths/);
  assert.match(architecture, /generation !== scanGeneration \|\| scan !== snapshot/);
  assert.match(libRs, /fn snapshot_file_paths\(/);
  assert.match(libRs, /paths: Option<Vec<String>>/);
  assert.match(libRs, /scan_project_tree\(root, exclusions, show_hidden, show_ignored, None\)/);
});

test("watcher registration reuses snapshot directories with a fallback", () => {
  assert.match(architecture, /directories: result\.truncated \|\| result\.lazy \? undefined : \[\.\.\.directories\]/);
  assert.match(libRs, /directories: Option<Vec<String>>/);
  assert.match(libRs, /_ => collect_watch_dirs\(&root, &policy\)/);
});

test("show-ignored reaches scan, watch, metadata, and search", () => {
  assert.match(architecture, /JSON\.stringify\(\[currentExclusions\(\), showHidden, showIgnored\]\)/);
  assert.match(architecture, /showIgnored: showIgnored,[\s\S]{0,160}directories:/);
  assert.match(architecture, /showHidden,\s*showIgnored,\s*limit: 200/);
  assert.match(architecture, /showHidden,\s*showIgnored,\s*\}\);/);
  assert.match(libRs, /fn workspace_policy\(/);
  assert.match(libRs, /show_ignored: bool,[\s\S]{0,120}directories: Option<Vec<String>>/);
  assert.match(libRs, /show_ignored: bool,[\s\S]{0,80}registry: Option<&Registry>/);
  assert.match(libRs, /show_ignored: bool,[\s\S]{0,120}paths: Option<&\[String\]>/);
});

test("Explorer visibility is centralized and file opens keep the dock in place", () => {
  assert.match(architecture, /function setExplorerOpen\(open: boolean, notify = true\)/);
  assert.match(architecture, /document\.body\.classList\.toggle\("explorer-open", open\)/);
  assert.doesNotMatch(architecture, /\$\("architecture"\)\.classList\.add\("hidden"\)/);
  assert.doesNotMatch(architecture, /\$\("architecture"\)\.classList\.remove\("hidden"\)/);
  assert.match(architecture, /function showArchitectureWindow\(\) \{\s*setExplorerOpen\(true\);\s*\}/);
  assert.match(architecture, /setExplorerOpen\(explorerOpen, false\)/);
  assert.match(architecture, /\$\("arch-close-docked"\)\.addEventListener\("click", closeExplorer\)/);
});

test("Explorer docks inside the workspace body with a close control", () => {
  const shell = readFileSync(resolve(appDir, "index.html"), "utf8");
  assert.match(shell, /<nav id="activity-bar"[\s\S]{0,4000}<div id="architecture" class="hidden">/);
  assert.match(shell, /#architecture \{ position: relative; z-index: 30; display: flex; flex: 0 0 min\(300px, 28vw\)/);
  assert.match(shell, /#architecture\.fullscreen \{ position: fixed; inset: 0; z-index: 100;/);
  assert.match(shell, /id="arch-close-docked"/);
  assert.doesNotMatch(shell, /#architecture \{ position: fixed; top: 0; left: 48px/);
});

test("basic folder opening always returns to the file tree", () => {
  assert.match(architecture, /setMode\("structure"\);\s*await scanProject/);
  assert.match(architecture, /setMode\("structure"\);\s*showArchitectureWindow\(\);\s*void scanProject/);
});

test("Explorer duplicate is wired through menu, details, and a bounded backend command", () => {
  assert.match(architecture, /interface DuplicatedEntry/);
  assert.match(architecture, /actions\.push\(\["Duplicate", \(\) => void duplicateSelected\(entry\)\]\)/);
  assert.match(architecture, /duplicate\.textContent = "Duplicate"/);
  assert.match(architecture, /invoke<DuplicatedEntry>\("duplicate_project_entry"/);
  assert.match(architecture, /exclusions: currentExclusions\(\),\s*showHidden/);
  assert.match(libRs, /fn duplicate_project_entry_at\(/);
  assert.match(libRs, /MAX_DUPLICATE_ENTRIES/);
  assert.match(libRs, /MAX_DUPLICATE_BYTES/);
  assert.match(libRs, /duplicate_project_entry,/);
});

test("tree rows support drag-to-move with containment checks", () => {
  assert.match(architecture, /row\.draggable = true/);
  assert.match(architecture, /addEventListener\("dragstart"/);
  assert.match(architecture, /addEventListener\("dragover"/);
  assert.match(architecture, /addEventListener\("drop"/);
  assert.match(architecture, /dropEntryOn\(sourcePath, entry\)/);
  assert.match(architecture, /A folder cannot be moved inside itself/);
  assert.match(html, /arch-tree-row\.drop-target/);
});
