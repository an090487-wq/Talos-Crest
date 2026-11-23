import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { EditorState } from "@codemirror/state";
import { languages } from "@codemirror/language-data";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadTs(relativePath, requireMap = {}) {
  const sourcePath = resolve(appDir, relativePath);
  const compiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  const nodeRequire = createRequire(sourcePath);
  new Function("require", "module", "exports", compiled)(
    (id) => requireMap[id] ?? nodeRequire(id),
    module,
    module.exports
  );
  return module.exports;
}

const rules = loadTs("src/error-rules.ts");
const engine = loadTs("src/error-engine.ts", { "./error-rules": rules });
const diagnosticsModule = loadTs("src/diagnostics.ts", { "./error-engine": engine });
const { scanDiagnostics } = diagnosticsModule;

async function stateFor(languageName, doc) {
  const description = languages.find((language) => language.name === languageName);
  assert.ok(description, `${languageName} parser is installed`);
  return EditorState.create({ doc, extensions: await description.load() });
}

test("JSON diagnostics use parser error nodes with source ranges", async () => {
  const state = await stateFor("JSON", '{"value":,}');
  const diagnostics = scanDiagnostics(state, "JSON");
  assert.ok(diagnostics.length > 0);
  for (const diagnostic of diagnostics) {
    assert.equal(diagnostic.severity, "error");
    assert.equal(diagnostic.source, "Talos JSON parser");
    assert.ok(diagnostic.from > 0);
    assert.ok(diagnostic.to > diagnostic.from);
  }
});

test("valid JSON does not treat string contents as TODO markers", async () => {
  const state = await stateFor("JSON", '{"note":"TODO: verify"}');
  assert.deepEqual(scanDiagnostics(state, "JSON"), []);
});

test("TODO markers are informational only when they occur in comments", async () => {
  const state = await stateFor("JavaScript", '// TODO: verify\nconst note = "FIXME";');
  const diagnostics = scanDiagnostics(state, "JavaScript");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].severity, "info");
  assert.equal(diagnostics[0].source, "Talos TODO marker");
  assert.equal(state.doc.sliceString(diagnostics[0].from, diagnostics[0].from + 4), "TODO");
});

test("non-JSON source gets no heuristic compiler errors", () => {
  const state = EditorState.create({ doc: "function broken( {\n" });
  assert.deepEqual(scanDiagnostics(state, "JavaScript"), []);
});
