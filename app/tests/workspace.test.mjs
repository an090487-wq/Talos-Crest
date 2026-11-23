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
