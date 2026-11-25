import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/workspace-paths.ts");
const source = await readFile(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const pathModule = { exports: {} };
new Function("require", "module", "exports", compiled)(
  createRequire(sourcePath),
  pathModule,
  pathModule.exports
);
const {
  resolveWorkspacePath,
  sameWorkspaceRoot,
  isInsideWorkspace,
  isReadOnlyAppImagePath,
} = pathModule.exports;

test("relative evidence paths resolve against the workspace root", () => {
  assert.equal(resolveWorkspacePath("/work/project", "src/api.py"), "/work/project/src/api.py");
  assert.equal(resolveWorkspacePath("/work/project/", "./src/../src/api.py"), "/work/project/src/api.py");
  assert.equal(resolveWorkspacePath("/work/project", "src\\api.py"), "/work/project/src/api.py");
});

test("absolute evidence paths are accepted only inside the workspace", () => {
  assert.equal(resolveWorkspacePath("/work/project", "/work/project/src/api.py"), "/work/project/src/api.py");
  assert.equal(resolveWorkspacePath("/work/project", "/etc/passwd"), null);
  assert.equal(resolveWorkspacePath("C:\\Work\\Project", "C:\\Work\\Project\\src\\api.py"), "C:/Work/Project/src/api.py");
  assert.equal(resolveWorkspacePath("C:\\Work\\Project", "D:\\secrets.txt"), null);
});

test("traversal and empty paths are rejected", () => {
  assert.equal(resolveWorkspacePath("/work/project", "../../etc/passwd"), null);
  assert.equal(resolveWorkspacePath("/work/project", "src/../../../etc/passwd"), null);
  assert.equal(resolveWorkspacePath("/work/project", ""), null);
  assert.equal(resolveWorkspacePath("/work/project", null), null);
});

test("workspace root comparison is stable across separators and Windows case", () => {
  assert.equal(sameWorkspaceRoot("/work/project/", "/work/project"), true);
  assert.equal(sameWorkspaceRoot("C:\\Work\\Project", "c:/work/project"), true);
  assert.equal(sameWorkspaceRoot("/work/project", "/work/other"), false);
  assert.equal(isInsideWorkspace("/work/project-other/file", "/work/project"), false);
});

test("AppImage internal files are detected as read-only", () => {
  assert.equal(isReadOnlyAppImagePath("/tmp/.mount_talos-AaIehN/usr/HelloWorld.java"), true);
  assert.equal(isReadOnlyAppImagePath("/tmp/.mount_talos-AaIehN/usr/share/demo.py"), true);
  assert.equal(isReadOnlyAppImagePath("C:/Program Files/Talos Crest/HelloWorld.java"), false);
  assert.equal(isReadOnlyAppImagePath("/home/user/HelloWorld.java"), false);
});
