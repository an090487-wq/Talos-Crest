import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(appDir, "index.html"), "utf8");
const css = readFileSync(resolve(appDir, "src/ui/design-system.css"), "utf8");
const main = readFileSync(resolve(appDir, "src/main.ts"), "utf8");
const architecture = readFileSync(resolve(appDir, "src/architecture.ts"), "utf8");

test("native controls keep their own chrome", () => {
  assert.match(html, /input\[type="checkbox"\], input\[type="radio"\], input\[type="range"\], input\[type="color"\]/);
  assert.match(html, /accent-color: var\(--accent\);/);
});

test("tab strips use one consistent indicator and never wrap labels", () => {
  assert.match(html, /\.document-tab\.active \{ color: var\(--text\); background: var\(--bg\); box-shadow: none; \}/);
  assert.match(html, /#tabs \{[^}]*overflow-x: auto;[^}]*overflow-y: hidden;[^}]*flex-wrap: nowrap;/);
  assert.match(html, /#tabs \.tab \{[^}]*flex: 0 0 auto;[^}]*white-space: nowrap;/);
});

test("problem count stays legible in every theme", () => {
  assert.match(html, /#count \{ background: var\(--surface-raised\); border: 1px solid var\(--line\);/);
  assert.match(html, /#count \{[^}]*color: var\(--text\);/);
});

test("canvas section headers do not paint titlebar accents over the status bar", () => {
  assert.match(html, /\.canvas-section > header \{[^}]*padding: 0;[^}]*background: transparent;/);
  assert.match(html, /\.canvas-section > header::after \{ display: none; \}/);
});

test("narrow layouts keep the editor usable", () => {
  assert.match(html, /#panel \{ height: min\(var\(--panel-size\), 32vh\); flex: 0 0 min\(var\(--panel-size\), 32vh\); \}/);
  assert.match(html, /#outline-pane \{ width: 100%; min-width: 0; border-left: 0; border-top: 1px solid var\(--line\); \}/);
  assert.match(html, /#canvas-header \{ flex: 0 0 auto; min-height: 48px; flex-wrap: wrap; padding: 8px; \}/);
  assert.match(html, /#pdf-bar \{ display: flex; flex-wrap: wrap;/);
});

test("design-system controls keep focus and empty states readable", () => {
  assert.match(css, /\.tc-empty \{[^}]*font-size: var\(--font-sm, 11px\);/);
  assert.match(css, /\.tc-activity-bar \{[^}]*overflow-y: auto;/);
  assert.match(css, /\.tc-command-search input:focus-visible \{[\s\S]*?outline: 2px solid var\(--tc-focus\);/);
  assert.match(css, /@media \(max-width: 700px\) \{[\s\S]*?\.tc-nav-item \{\s*padding: 0 8px;\s*\}/);
});

test("closing tool overlays restores the default navigation state", () => {
  assert.match(main, /\$\("chronicle-dialog"\)\.addEventListener\("close"/);
  assert.match(main, /\$\("quick-open-dialog"\)\.addEventListener\("close"/);
  assert.match(main, /talos:explorer-close/);
  assert.match(architecture, /document\.dispatchEvent\(new Event\("talos:explorer-close"\)\)/);
});
