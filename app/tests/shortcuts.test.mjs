import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(resolve(appDir, "src/shortcuts.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const shortcutsModule = { exports: {} };
new Function("module", "exports", compiled)(shortcutsModule, shortcutsModule.exports);
const {
  editorShortcutBindings,
  formatShortcut,
  getShortcuts,
  matchesShortcut,
  parseShortcut,
  registerShortcuts,
  shortcutKeyParts,
} = shortcutsModule.exports;

function keyboardEvent(key, code, modifiers = {}) {
  return {
    key,
    code,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  };
}

test("Mod resolves to the platform primary modifier", () => {
  const parsed = parseShortcut("Mod+Shift+S");
  const mac = formatShortcut("Mod+S").includes("\u2318");
  assert.equal(parsed.meta, mac);
  assert.equal(parsed.ctrl, !mac);
  assert.equal(parsed.shift, true);
  assert.equal(parsed.key, "s");
  assert.equal(parsed.code, "KeyS");
});

test("shortcut matching requires exact modifiers", () => {
  const binding = parseShortcut("Mod+S");
  assert.equal(matchesShortcut(keyboardEvent("s", "KeyS", { ctrlKey: true }), binding), true);
  assert.equal(
    matchesShortcut(keyboardEvent("s", "KeyS", { ctrlKey: true, shiftKey: true }), binding),
    false,
  );
  assert.equal(matchesShortcut(keyboardEvent("s", "KeyS", {}), binding), false);
});

test("physical key codes keep shortcuts on QWERTY positions", () => {
  const binding = parseShortcut("Mod+S");
  // A Persian layout reports the logical key as "س" but the same physical key.
  assert.equal(matchesShortcut(keyboardEvent("\u0633", "KeyS", { ctrlKey: true }), binding), true);
});

test("shifted punctuation matches by physical key", () => {
  const binding = parseShortcut("Mod+Shift+/");
  assert.equal(
    matchesShortcut(keyboardEvent("?", "Slash", { ctrlKey: true, shiftKey: true }), binding),
    true,
  );
});

test("displayed key parts stay readable", () => {
  const parts = shortcutKeyParts("Mod+Shift+S");
  assert.equal(parts.at(-1), "S");
  assert.equal(parts.length, 3);
  assert.equal(formatShortcut("F1"), "F1");
  assert.match(formatShortcut("Ctrl+Space"), /Space$/);
});

test("editor shortcuts convert to CodeMirror key syntax", () => {
  registerShortcuts([
    {
      id: "test.run",
      label: "Run",
      keys: "Mod+Enter",
      group: "Test",
      scope: "editor",
      run: () => {},
    },
  ]);
  assert.equal(getShortcuts().length, 1);
  assert.equal(editorShortcutBindings()[0].key, "Mod-Enter");
});
