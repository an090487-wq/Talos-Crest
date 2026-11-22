import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { EditorState } from "@codemirror/state";
import { languages } from "@codemirror/language-data";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(appDir, "src/outline.ts");
const source = await readFile(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const outlineModule = { exports: {} };
new Function("require", "module", "exports", compiled)(
  createRequire(sourcePath),
  outlineModule,
  outlineModule.exports
);
const { collectOutline } = outlineModule.exports;

async function outlineFor(languageName, doc) {
  const description = languages.find((language) => language.name === languageName);
  assert.ok(description, `${languageName} language parser is installed`);
  const state = EditorState.create({ doc, extensions: await description.load() });
  return collectOutline(state, languageName, 100);
}

test("Python outline uses parsed classes and methods with navigation ranges", async () => {
  const result = await outlineFor(
    "Python",
    "class Store:\n    def connect(self):\n        pass\n"
  );
  assert.equal(result.supported, true);
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.symbols.map(({ name, kind, depth }) => [name, kind, depth]),
    [
      ["Store", "class", 0],
      ["connect", "function", 1],
    ]
  );
});

test("JavaScript and TypeScript outline declarations from their syntax trees", async () => {
  const javascript = await outlineFor(
    "JavaScript",
    "class Store { connect() {} }\nfunction main() {}\nconst helper = () => 1;"
  );
  assert.deepEqual(
    javascript.symbols.map(({ name, kind }) => [name, kind]),
    [
      ["Store", "class"],
      ["connect", "method"],
      ["main", "function"],
      ["helper", "function"],
    ]
  );

  const typescript = await outlineFor(
    "TypeScript",
    "interface Item { id: string }\nclass Store { connect(): void {} }"
  );
  assert.deepEqual(
    typescript.symbols.map(({ name, kind }) => [name, kind]),
    [
      ["Item", "interface"],
      ["Store", "class"],
      ["connect", "method"],
    ]
  );
});

test("unsupported languages are explicitly reported instead of guessed", () => {
  const state = EditorState.create({ doc: "fn main() {}" });
  assert.deepEqual(collectOutline(state, "Rust"), {
    supported: false,
    complete: false,
    symbols: [],
  });
});
