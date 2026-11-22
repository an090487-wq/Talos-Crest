import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/project-search.ts");
const source = await readFile(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const searchModule = { exports: {} };
new Function("require", "module", "exports", compiled)(
  createRequire(sourcePath),
  searchModule,
  searchModule.exports
);
const { searchProjectFiles } = searchModule.exports;

const entries = [
  { path: "/work/src/main.py", name: "main.py", kind: "file" },
  { path: "/work/tests/test_main.py", name: "test_main.py", kind: "file" },
  { path: "/work/src/maintenance.py", name: "maintenance.py", kind: "file" },
  { path: "/work/src", name: "src", kind: "directory" },
];

test("quick open ranks exact and substring filename matches before fuzzy matches", () => {
  const paths = searchProjectFiles(entries, "main.py").map(({ path }) => path);
  assert.equal(paths[0], "/work/src/main.py");
  assert.equal(paths[1], "/work/tests/test_main.py");
});

test("quick open supports fuzzy paths and recent-file ordering", () => {
  assert.deepEqual(
    searchProjectFiles(entries, "tstmn", ["/work/tests/test_main.py"]).map(({ path }) => path),
    ["/work/tests/test_main.py"]
  );
  assert.deepEqual(
    searchProjectFiles(entries, "", ["/work/tests/test_main.py", "/work/src/main.py"])
      .map(({ path }) => path),
    ["/work/tests/test_main.py", "/work/src/main.py"]
  );
});

test("quick open limits results and excludes directories", () => {
  assert.deepEqual(searchProjectFiles(entries, "", [], 10), []);
  assert.equal(searchProjectFiles(entries, "main", ["/work/src/main.py"], 1).length, 1);
});

test("quick open bounds results for large workspace indexes", () => {
  const large = Array.from({ length: 50_000 }, (_, index) => ({
    path: `/work/src/module-${index}.ts`,
    name: `module-${index}.ts`,
    kind: "file",
  }));
  const results = searchProjectFiles(large, "module-49", [], 100);
  assert.ok(results.length <= 100);
  assert.equal(results[0].name, "module-49.ts");
});
