import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(resolve(appDir, "src/layout.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const layoutModule = { exports: {} };
new Function("module", "exports", compiled)(layoutModule, layoutModule.exports);
const {
  detectLayoutMode,
  parseLayoutPreference,
  resolveLayoutMode,
  nextLayoutPreference,
  clampPanelSize,
  clampSidePaneSize,
  layoutModeLabel,
} = layoutModule.exports;

test("layout mode uses both width and height", () => {
  assert.equal(detectLayoutMode({ width: 1440, height: 900 }), "large");
  assert.equal(detectLayoutMode({ width: 1100, height: 720 }), "medium");
  assert.equal(detectLayoutMode({ width: 620, height: 800 }), "compact");
  assert.equal(detectLayoutMode({ width: 1400, height: 480 }), "compact");
  assert.equal(detectLayoutMode({ width: 0, height: 0 }), "medium");
});

test("layout preference is validated and cycled safely", () => {
  assert.equal(parseLayoutPreference("compact"), "compact");
  assert.equal(parseLayoutPreference("nonsense"), "auto");
  assert.equal(resolveLayoutMode("compact", { width: 1920, height: 1080 }), "compact");
  assert.equal(resolveLayoutMode("auto", { width: 1920, height: 1080 }), "large");
  assert.equal(nextLayoutPreference("auto"), "large");
  assert.equal(nextLayoutPreference("large"), "medium");
  assert.equal(nextLayoutPreference("medium"), "compact");
  assert.equal(nextLayoutPreference("compact"), "auto");
  assert.equal(layoutModeLabel("medium"), "Medium");
});

test("panel size is clamped to a usable editor and a mode ratio", () => {
  assert.equal(clampPanelSize(280, 900, 160, "large"), 280);
  assert.equal(clampPanelSize(280, 720, 170, "medium"), 280);
  assert.equal(clampPanelSize(400, 720, 170, "medium"), 288);
  assert.equal(clampPanelSize(400, 600, 170, "medium"), 210);
  assert.equal(clampPanelSize(20, 400, 200, "compact"), 112);
  assert.equal(clampPanelSize(Number.NaN, 900, 160, "large"), 160);
});

test("side panes never consume the reserved editor space", () => {
  assert.equal(clampSidePaneSize(360, 1000, "large", "x"), 360);
  assert.equal(clampSidePaneSize(900, 1000, "large", "x"), 580);
  assert.equal(clampSidePaneSize(900, 1000, "medium", "x"), 660);
  assert.equal(clampSidePaneSize(900, 600, "compact", "y"), 460);
  assert.equal(clampSidePaneSize(40, 200, "medium", "x"), 220);
  assert.equal(clampSidePaneSize(Number.NaN, 900, "compact", "x"), 180);
});
