import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/editor-navigation.ts");
const source = await readFile(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const navigationModule = { exports: {} };
new Function("require", "module", "exports", compiled)(
  createRequire(sourcePath),
  navigationModule,
  navigationModule.exports
);
const { parseLineNumber } = navigationModule.exports;

test("Go to Line accepts only whole line numbers in document bounds", () => {
  assert.equal(parseLineNumber("1", 10), 1);
  assert.equal(parseLineNumber(" 10 ", 10), 10);
  assert.equal(parseLineNumber("0", 10), null);
  assert.equal(parseLineNumber("11", 10), null);
  assert.equal(parseLineNumber("1.5", 10), null);
  assert.equal(parseLineNumber("nope", 10), null);
});
