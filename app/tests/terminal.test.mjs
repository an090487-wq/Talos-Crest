import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const terminal = readFileSync(resolve(appDir, "src/terminal.ts"), "utf8");
const main = readFileSync(resolve(appDir, "src/main.ts"), "utf8");
const css = readFileSync(resolve(appDir, "src/ui/design-system.css"), "utf8");
const html = readFileSync(resolve(appDir, "index.html"), "utf8");
const sourceControl = readFileSync(resolve(appDir, "src/source-control.ts"), "utf8");
const shortcuts = readFileSync(resolve(appDir, "src/shortcuts.ts"), "utf8");

test("restart cannot orphan or duplicate a pending PTY", () => {
  assert.match(terminal, /let restarting: Promise<void> \| null = null;/);
  assert.match(terminal, /async function restartSession\(\): Promise<void> \{/);
  assert.match(terminal, /if \(restarting\) return restarting;/);
  assert.match(terminal, /if \(starting\) await starting\.catch\(\(\) => undefined\);/);
  assert.match(terminal, /closeSession\(\);\s*await startSession\(\);/);
  assert.match(terminal, /btn-terminal-restart[\s\S]{0,220}void restartSession\(\);/);
});

test("collapsed and theme-driven resizes are retried instead of being lost", () => {
  assert.match(terminal, /view\.clientHeight < 20\) \{\s*\/\/[\s\S]{0,180}lastCols = 0;\s*lastRows = 0;/);
  assert.match(terminal, /function applyTheme\(\)[\s\S]{0,320}sendResize\(\);/);
  assert.match(terminal, /if \(session \|\| starting\) return starting \?\? Promise\.resolve\(\);/);
});

test("focus waits for a measurable terminal view", () => {
  assert.match(terminal, /requestAnimationFrame\(\(\) => terminal\?\.focus\(\)\);/);
  assert.match(terminal, /export function focusTerminal\(\): void \{[\s\S]{0,320}requestAnimationFrame/);
});

test("user-initiated tab and panel activation focuses Terminal", () => {
  assert.match(main, /function showTab\(tab: BottomTab, focus = false\)/);
  assert.match(main, /void ensureTerminal\(focus\)/);
  assert.match(main, /showTab\(tab, true\)/);
  assert.match(main, /show && !\$\("channel-terminal"\)\.classList\.contains\("hidden"\)\) void ensureTerminal\(true\)/);
});

test("commit shortcut never reaches the editor's Mod+Enter run command", () => {
  assert.match(sourceControl, /event\.stopPropagation\(\);/);
  assert.match(shortcuts, /\(shortcut\.scope \?\? "app"\) === "app"/);
  assert.match(main, /id: "run\.file-editor"[\s\S]{0,180}scope: "editor"/);
});

test("terminal toolbar stays one row and terminal keeps usable height", () => {
  assert.match(css, /\.tc-terminal-toolbar \{[\s\S]*?flex-wrap: nowrap;[\s\S]*?overflow-x: auto;/);
  assert.match(css, /\.tc-terminal-view \{[\s\S]*?min-height: 48px;/);
  assert.match(html, /html\[data-layout-mode="compact"\] \.tc-terminal-toolbar \{ flex-wrap: nowrap; \}/);
});
