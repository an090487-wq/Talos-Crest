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
const diagnostics = loadTs("src/diagnostics.ts", { "./error-engine": engine });

const { BUILTIN_RULES } = rules;
const {
  clearCustomRules,
  errorEngineAvailability,
  getCustomRules,
  getErrorRules,
  scanWithErrorEngine,
  setCustomRules,
  validateRuleJson,
} = engine;
const { scanDiagnostics } = diagnostics;

async function stateFor(languageName, doc) {
  const description = languages.find((language) => language.name === languageName);
  assert.ok(description, `${languageName} parser is installed`);
  return EditorState.create({ doc, extensions: await description.load() });
}

test("built-in rules cover common defects and can all be disabled", () => {
  assert.ok(BUILTIN_RULES.length >= 15);
  for (const rule of BUILTIN_RULES) {
    assert.equal(rule.enabled, true);
    assert.ok(rule.id && rule.name && rule.message && rule.pattern);
    assert.ok(["error", "warning", "info"].includes(rule.severity));
    assert.ok(rule.languages.length > 0);
  }
});

test("Python mutable default is reported at the argument, not the whole file", async () => {
  clearCustomRules();
  const state = await stateFor("Python", "def handler(items=[]):\n    return items\n");
  const found = scanWithErrorEngine(state, "Python").filter(
    (diagnostic) => diagnostic.source === "Talos: Mutable default argument"
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "error");
  assert.equal(state.doc.sliceString(found[0].from, found[0].to), "items=[]");
});

test("matches inside comments and strings are ignored", async () => {
  clearCustomRules();
  const commented = await stateFor("Python", "# def bad(x=[]):\npass\n");
  assert.deepEqual(
    scanWithErrorEngine(commented, "Python").filter((d) => d.severity === "error"),
    []
  );
  const inString = await stateFor("JavaScript", 'const note = "a == b";\n');
  assert.deepEqual(
    scanWithErrorEngine(inString, "JavaScript").filter((d) => d.source === "Talos: Loose equality"),
    []
  );
});

test("loose equality reports the operator range", async () => {
  clearCustomRules();
  const state = await stateFor("JavaScript", "if (a == b) {}\nif (a === b) {}\n");
  const found = scanWithErrorEngine(state, "JavaScript").filter(
    (d) => d.source === "Talos: Loose equality"
  );
  assert.equal(found.length, 1);
  assert.equal(state.doc.sliceString(found[0].from, found[0].to), "==");
});

test("custom rules are validated, persisted in memory, and reported distinctly", async () => {
  clearCustomRules();
  const invalid = validateRuleJson('[{"id":"x","pattern":"["}]');
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /required field/i);

  const badRegex = validateRuleJson(JSON.stringify([{
    id: "bad", name: "Bad", message: "bad", pattern: "(", flags: "g",
    severity: "warning", languages: ["*"], enabled: true,
  }]));
  assert.equal(badRegex.ok, false);
  assert.match(badRegex.error, /invalid pattern/i);

  const valid = validateRuleJson(JSON.stringify([{
    id: "no-alert", name: "No alert", message: "Use notify().",
    pattern: "\\balert\\s*\\(", flags: "g", severity: "warning",
    languages: ["JavaScript"], enabled: true,
  }]));
  assert.equal(valid.ok, true);
  setCustomRules(valid.rules);
  assert.equal(getCustomRules().length, 1);
  assert.equal(getErrorRules().some((rule) => rule.id === "custom.no-alert"), true);

  const state = await stateFor("JavaScript", "alert('hi');\n");
  const found = scanWithErrorEngine(state, "JavaScript").filter(
    (d) => d.source === "Custom: No alert"
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "warning");
  clearCustomRules();
});

test("diagnostics panel receives both parser and engine results", async () => {
  clearCustomRules();
  const state = await stateFor("JavaScript", "// TODO: check\nvar x = 1;\nif (x == 2) {}\n");
  const found = scanDiagnostics(state, "JavaScript");
  assert.ok(found.some((d) => d.source === "Talos TODO marker"));
  assert.ok(found.some((d) => d.source === "Talos: var declaration"));
  assert.ok(found.some((d) => d.source === "Talos: Loose equality"));
  assert.deepEqual(found.map((d) => d.from), [...found.map((d) => d.from)].sort((a, b) => a - b));
});

test("availability text reports active local rules without claiming a compiler", () => {
  const text = errorEngineAvailability("Python");
  assert.match(text, /local rule/);
  assert.match(text, /ignored/);
  assert.match(text, /Python/);
});
