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
const tauriConfig = readFileSync(resolve(appDir, "src-tauri/tauri.conf.json"), "utf8");
const canvas = readFileSync(resolve(appDir, "src/canvas/canvas-ui.ts"), "utf8");
const rust = readFileSync(resolve(appDir, "src-tauri/src/lib.rs"), "utf8");

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

test("adaptive layout uses width and height, with a user override and safe clamping", () => {
  assert.match(html, /html\[data-layout-mode="compact"\]/);
  assert.match(html, /id="btn-layout-mode"/);
  assert.match(main, /resolveLayoutMode\(layoutPreference/);
  assert.match(main, /clampPanelSize\(/);
  assert.match(main, /clampSidePaneSize\(/);
  assert.match(main, /ResizeObserver/);
  assert.match(main, /requestAnimationFrame\(\(\) => \{\s*layoutSyncFrame = 0;\s*syncLayout\(reason\);/);
  assert.match(main, /scheduleEditorMeasure/);
  assert.doesNotMatch(main, /storedPanelSize < 280/);
  assert.match(tauriConfig, /"minWidth": 480/);
  assert.match(tauriConfig, /"minHeight": 360/);
  assert.match(canvas, /fitToViewport/);
  assert.match(canvas, /addEventListener\("resize"/);
});

test("compact layout exposes secondary toolbar actions through an overflow menu", () => {
  assert.match(html, /id="btn-toolbar-overflow"/);
  assert.match(html, /id="toolbar-overflow-menu"/);
  assert.match(main, /function openToolbarOverflow/);
  assert.match(main, /function refreshToolbarOverflow/);
  assert.match(html, /html\[data-layout-mode="compact"\] #btn-toolbar-overflow \{ display: inline-flex; \}/);
});

test("Live Studio keeps preview execution sandboxed and adds isolated controls", () => {
  assert.match(html, /id="preview-viewport"/);
  assert.match(html, /id="preview-reload"/);
  assert.match(html, /id="preview-console-toggle"/);
  assert.match(html, /id="preview-console"/);
  assert.match(html, /sandbox="allow-scripts"/);
  assert.match(main, /function injectPreviewBridge/);
  assert.match(main, /function onPreviewMessage/);
  assert.match(main, /event\.source !== frame\.contentWindow/);
  assert.match(main, /data\.nonce !== previewNonce/);
  assert.match(main, /scheduleHtmlPreviewRefresh/);
  assert.match(main, /talos\.preview-viewport/);
});

test("closing tool overlays restores the default navigation state", () => {
  assert.match(main, /\$\("chronicle-dialog"\)\.addEventListener\("close"/);
  assert.match(main, /\$\("quick-open-dialog"\)\.addEventListener\("close"/);
  assert.match(main, /talos:explorer-close/);
  assert.match(architecture, /document\.dispatchEvent\(new Event\("talos:explorer-close"\)\)/);
});

test("file-open failures surface globally and optional language failures never block opening", () => {
  assert.match(architecture, /CustomEvent\("talos:open-error"/);
  assert.match(main, /talos:open-error/);
  assert.match(main, /as plain text/);
});

test("desktop runs expose a live stdin channel for interactive input", () => {
  assert.match(html, /id="output-input-bar"/);
  assert.match(html, /id="run-input"/);
  assert.match(main, /run_file_interactive/);
  assert.match(main, /run_source_interactive/);
  assert.match(main, /run_write_stdin/);
  assert.match(rust, /fn run_write_stdin/);
  assert.match(rust, /Stdio::piped\(\)/);
});

test("interface size is a persisted preference independent of editor font", () => {
  assert.match(html, /id="ui-scale"/);
  assert.match(html, /--ui-scale: 1;/);
  assert.match(html, /calc\(13px \* var\(--ui-scale\)\)/);
  assert.match(main, /function applyUiScale\(scale: number\)/);
  assert.match(main, /talos\.ui-scale/);
  assert.match(main, /\$\("ui-scale"\)\.addEventListener\("change"/);
});

test("data files explain why they cannot be run", () => {
  assert.match(main, /const dataExtensions = \[/);
  assert.match(main, /is a data file, not runnable source/);
  assert.match(main, /or choose a run language/);
});

test("read-only AppImage files are saved through Save As", () => {
  assert.match(main, /import \{ isReadOnlyAppImagePath \} from "\.\/workspace-paths"/);
  assert.match(main, /readOnlyAppImageFile && !forceDialog/);
  assert.match(main, /Choose a writable location to save a copy/);
});

test("binary files open in a bounded hex and strings preview", () => {
  assert.match(html, /id="binary-dialog"/);
  assert.match(html, /id="binary-mode-hex"/);
  assert.match(html, /id="binary-mode-strings"/);
  assert.match(main, /import \{ openBinaryUi \} from "\.\/binary-preview"/);
  assert.match(main, /id: "file\.open-binary"/);
});

test("installed icon packs visibly change Explorer file icons", () => {
  assert.ok(architecture.includes("export function setExplorerIconPack"));
  assert.ok(architecture.includes("ICON_PACK_STYLES"));
  assert.ok(architecture.includes("iconPackGlyph("));
  assert.ok(architecture.includes("styleExplorerIcon(icon)"));
  assert.ok(main.includes("setIconPack: (pack) => setExplorerIconPack(pack)"));
  for (const id of [
    "icon-pack-material", "icon-pack-seti", "icon-pack-vscode", "icon-pack-feather",
    "icon-pack-phosphor", "icon-pack-heroicons", "icon-pack-lucide", "icon-pack-tabler",
    "icon-pack-remix", "icon-pack-simple",
  ]) {
    assert.ok(architecture.includes(`"${id}"`), `missing visible style for ${id}`);
  }
});
