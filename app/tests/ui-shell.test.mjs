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
const sourceControl = readFileSync(resolve(appDir, "src/source-control.ts"), "utf8");
const tauriConfig = readFileSync(resolve(appDir, "src-tauri/tauri.conf.json"), "utf8");
const capabilities = readFileSync(resolve(appDir, "src-tauri/capabilities/default.json"), "utf8");
const canvas = readFileSync(resolve(appDir, "src/canvas/canvas-ui.ts"), "utf8");
const commandPalette = readFileSync(resolve(appDir, "src/command-palette.ts"), "utf8");
const rust = readFileSync(resolve(appDir, "src-tauri/src/lib.rs"), "utf8");
const installScript = readFileSync(resolve(appDir, "../scripts/install-linux-appimage.sh"), "utf8");
const brandIcon = readFileSync(resolve(appDir, "public/talos.svg"), "utf8");

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

test("Source Control replaces the Explorer in the sidebar slot", () => {
  assert.match(main, /let explorerWasOpenBeforeSourceControl = false;/);
  assert.match(main, /function setExplorerVisible\(open: boolean\): void \{/);
  assert.match(main, /new CustomEvent<\{ open: boolean \}>\("talos:explorer-visibility"/);
  assert.match(main, /case "explorer":[\s\S]{0,300}\$\("sc-close"\) as HTMLButtonElement\)\.click\(\);/);
  assert.match(main, /case "source-control": \{[\s\S]{0,700}if \(explorerWasOpenBeforeSourceControl\) setExplorerVisible\(false\);/);
  assert.match(main, /talos:source-control-closed[\s\S]{0,180}if \(explorerWasOpenBeforeSourceControl\) setExplorerVisible\(true\);/);
  assert.match(architecture, /talos:explorer-visibility/);
  assert.match(architecture, /setExplorerOpen\(detail\.open, false, false\)/);
});

test("Source Control never stacks into the bottom panel area", () => {
  assert.match(html, /#main\.side-pane-open > #source-control-pane \{[\s\S]*?position: absolute;[\s\S]*?inset: 0 0 0 auto;[\s\S]*?height: 100%;/);
  assert.match(html, /#main\[data-active-side-pane="source-control-pane"\] > #side-splitter \{ display: none; \}/);
  assert.match(html, /#main\.side-pane-open > \.side-pane:not\(#source-control-pane\) \{[^}]*min-height: 160px;/);
  assert.match(main, /previousNavBeforeSourceControl/);
  assert.match(main, /case "source-control": \{[\s\S]{0,420}\$\("sc-close"\) as HTMLButtonElement\)\.click\(\);/);
  assert.match(main, /talos:source-control-closed[\s\S]{0,260}setActiveNav\(previousNavBeforeSourceControl \?\? "explorer"\)/);
});

test("the three-dot More menu exposes secondary toolbar actions", () => {
  assert.match(html, /id="btn-toolbar-overflow"/);
  assert.match(html, /id="toolbar-overflow-menu"/);
  assert.match(main, /function openToolbarOverflow/);
  assert.match(main, /function refreshToolbarOverflow/);
  assert.match(html, /#btn-toolbar-overflow \{ display: inline-flex; \}/);
});

test("More adds creation and UI size actions instead of repeating sidebar buttons", () => {
  assert.match(architecture, /export function createExplorerEntry/);
  assert.match(main, /createExplorerEntry\("file"\)/);
  assert.match(main, /createExplorerEntry\("directory"\)/);
  assert.match(main, /appendOverflowItem\(`UI \$\{Math\.round\(Number\(scaleSelect\.value\) \* 100\)\}%`/);
  assert.doesNotMatch(main, /const overflowActionIds = \[[\s\S]{0,400}"btn-architecture"/);
  assert.doesNotMatch(main, /const overflowActionIds = \[[\s\S]{0,400}"btn-quick-open"/);
  assert.match(html, /#btn-architecture,[\s\S]{0,120}#btn-calc,[\s\S]{0,120}#ui-scale,[\s\S]{0,120}display: none !important/);
});

test("window actions live in a three-dot More menu", () => {
  assert.match(html, /id="btn-toolbar-overflow"[^>]*>⋯<\/button>/);
  assert.match(html, /id="btn-new-window"/);
  assert.match(html, /id="btn-window-switcher"/);
  assert.match(html, /#btn-new-window,[\s\S]{0,160}#btn-window-switcher,[\s\S]{0,160}display: none !important/);
  assert.match(main, /"btn-new-window",\s*"btn-window-switcher"/);
});

test("the in-app header replaces terminal-like native chrome", () => {
  assert.match(tauriConfig, /"decorations": false/);
  assert.doesNotMatch(html, /id="window-titlebar"/);
  assert.match(rust, /window\.set_decorations\(false\)/);
  assert.match(capabilities, /core:window:allow-set-decorations/);
  assert.match(main, /nativeWindow\.setDecorations\(false\)/);
  assert.match(rust, /GDK_BACKEND/, "Rust must prefer a decoration-free GTK backend");
  assert.match(installScript, /GDK_BACKEND/, "Linux launcher must prefer a decoration-free GTK backend");
  assert.match(html, /data-tauri-drag-region="deep"/);
  assert.match(html, /id="window-title-text"/);
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/talos\.svg" \/>/);
  assert.match(html, /class="tc-brand-mark" aria-hidden="true"/);
  assert.match(brandIcon, /<polygon points="256,72 414,164 414,348 256,440 98,348 98,164"/);
  assert.match(html, /id="win-min"[^>]*aria-label="Minimize"/);
  assert.match(html, /id="win-max"[^>]*aria-label="Maximize"/);
  assert.match(html, /id="win-close"[^>]*aria-label="Close"/);
  const controlsArea = html.slice(html.indexOf('id="window-controls"'), html.indexOf("</header>"));
  assert.match(controlsArea, /class="tc-titlebar-controls" role="toolbar" aria-label="Window controls"/);
  assert.match(main, /nativeWindow\.minimize\(\)/);
  assert.match(main, /nativeWindow\.toggleMaximize\(\)/);
  assert.match(main, /guard\(\(\) => nativeWindow\.close\(\)\)/);
  assert.doesNotMatch(main, /\[productName, workspaceName, name\]\.filter\(Boolean\)\.join/);
});

test("launcher matches the running window so the Talos icon is shown", () => {
  assert.match(installScript, /Icon=\$icon_dest\/512x512\/apps\/talos-crest\.png/);
  assert.match(installScript, /StartupWMClass=talos-gui/);
  assert.match(installScript, /apps\/talos-gui\.png/);
  assert.doesNotMatch(installScript, /StartupWMClass=talos-crest/);
  assert.match(rust, /\.decorations\(false\)/);
});

test("the top search bar sits in the header's top row", () => {
  assert.match(css, /"title search windows"\s*"actions actions actions"/);
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\) minmax\(380px, 560px\) minmax\(0, 1fr\)/);
  assert.match(css, /\.tc-command-trigger \{[\s\S]*?grid-area: search;[\s\S]*?max-width: 560px;[\s\S]*?min-height: var\(--tc-control-height\);/);
  assert.doesNotMatch(css, /\.tc-command-trigger \{[^}]*min-height: 30px;/);
  assert.match(html, /<\/div>\s*<button id="btn-command-palette"[\s\S]{0,200}<\/button>\s*<div class="tc-row tc-header-actions">/);
  assert.doesNotMatch(html, /<div class="tc-row tc-header-actions">\s*<button id="btn-command-palette"/);
});

test("the command palette opens under the top search field", () => {
  assert.match(css, /dialog#command-palette\.tc-command-dialog\s*\{[^}]*top: 72px;[^}]*transform: translateX\(-50%\)/);
  assert.match(css, /\.tc-command-dialog \{[^}]*width: min\(820px/);
  assert.match(commandPalette, /Math\.min\(680, Math\.max\(280/);
  assert.match(commandPalette, /function positionCommandPalette/);
  assert.match(commandPalette, /element\("btn-command-palette"\)\.getBoundingClientRect\(\)/);
  assert.match(commandPalette, /positionCommandPalette\(\);[\s\S]{0,80}if \(!dialog\.open\) dialog\.showModal\(\)/);
  assert.match(commandPalette, /window\.addEventListener\("resize"/);
});

test("run arguments are accepted and passed to desktop programs", () => {
  assert.match(html, /id="run-args"[^>]*class="run-args-input"/);
  assert.match(css, /\.run-args-input \{/);
  assert.match(main, /function runArguments/);
  assert.match(main, /run_file_interactive", \{ id: activeRunId, path: currentPath, args \}/);
  assert.match(main, /fileName: suggestedName \?\? null,\s*args,/);
  assert.match(main, /talos\.run-args/);
  assert.match(rust, /fn append_run_arguments/);
  assert.match(rust, /fn split_run_arguments/);
  assert.match(rust, /args: Option<String>/);
});

test("the status bar shows the active file icon and language instead of Untitled", () => {
  assert.ok(!html.includes(`id="file"`));
  assert.ok(!html.includes(`<span id="breadcrumb-path">Untitled</span>`));
  assert.match(html, /id="active-file-status"/);
  assert.match(html, /id="active-file-icon"/);
  assert.match(html, /id="active-file-name">Working file</);
  assert.match(html, /id="lang">Plain text</);
  assert.match(main, /function languageFromFileName/);
  assert.match(main, /function activeFileGlyph/);
  assert.match(main, /function updateActiveFileStatus/);
  assert.match(main, /updateActiveFileStatus\(source\)/);
  assert.doesNotMatch(main, /suggestedName \?\? "Untitled"/);
});

test("the breadcrumb follows the active document, including non-editor views", () => {
  assert.match(main, /let breadcrumbPath: string \| null = null/);
  assert.match(main, /breadcrumbPath \?\? currentPath \?\? suggestedName/);
  assert.match(main, /async function openAny\(path: string\) \{[\s\S]{0,160}breadcrumbPath = path;/);
  assert.match(main, /breadcrumbPath = picked;[\s\S]{0,80}updateBreadcrumbs\(\);[\s\S]{0,160}await openPdf/);
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

test("new Explorer files cannot be created inside the read-only AppImage", () => {
  assert.match(architecture, /import \{ open, save \} from "@tauri-apps\/plugin-dialog"/);
  assert.match(architecture, /import \{ isReadOnlyAppImagePath \} from "\.\/workspace-paths"/);
  assert.match(architecture, /function splitPathForCreation/);
  assert.match(architecture, /function writableProject/);
  assert.match(architecture, /save\(\{ title: "Create file in a writable location"/);
  assert.match(architecture, /Choose a writable folder instead/);
  assert.match(architecture, /Bundled files are read-only\. Open a writable folder to/);
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

test("the shell has one compact brand and an active-file title", () => {
  assert.match(html, /<span id="brand" class="brand">/);
  assert.match(html, /<span id="window-title-text" class="tc-window-title">Talos Crest<\/span>/);
  assert.match(main, /const displayTitle = path \? name : productName;/);
  assert.match(main, /if \(titleText\.textContent !== displayTitle\) titleText\.textContent = displayTitle;/);
  assert.doesNotMatch(html, /id="window-titlebar"/);
  assert.match(html, /class="tc-drag-region" data-tauri-drag-region="deep"/);
  assert.match(main, /function syncWindowMaxButton\(\)/);
});

test("a hung renderer cannot trap the window on close", () => {
  assert.match(rust, /CLOSE_WATCHDOG_TOKEN/);
  assert.match(rust, /fn arm_close_watchdog\(/);
  assert.match(rust, /fn cancel_close_watchdog\(/);
  assert.match(rust, /tauri::WindowEvent::CloseRequested/);
  assert.match(main, /function cancelBackendCloseWatchdog\(\)/);
  assert.match(main, /function startCloseWatchdogKeepalive\(\)/);
  assert.match(main, /window\.setInterval\(cancelBackendCloseWatchdog, 1000\)/);
  assert.match(main, /stopCloseWatchdogKeepalive\(\);/);
});

test("no native browser modal can block a close request", () => {
  for (const source of [architecture, canvas, sourceControl]) {
    assert.doesNotMatch(source, /window\.prompt\(/);
    assert.doesNotMatch(source, /window\.confirm\(/);
    assert.doesNotMatch(source, /window\.alert\(/);
  }
  assert.match(html, /id="shell-prompt-dialog"/);
  assert.match(html, /id="shell-confirm-dialog"/);
});

test("search entry points state exactly what they search", () => {
  assert.match(html, /<span>Search commands<\/span>/);
  assert.doesNotMatch(html, /<span>Search files and commands<\/span>/);
  assert.match(html, /data-view="search"[^>]*aria-label="Find files by name"/);
  assert.match(html, /id="arch-search"[^>]*placeholder="Filter files and folders…"/);
  assert.match(html, /id="workspace-text-search-dialog"/);
  assert.match(architecture, /openModalDialog\("workspace-text-search-dialog"\)/);
  assert.doesNotMatch(architecture, /window\.prompt\("Search text in all workspace files:"\)/);
  assert.match(html, /data-search-results="true"\] #arch-details-pane/);
});

test("Explorer keeps project controls separate from graph controls and can resize", () => {
  assert.match(html, /<div class="arch-control-group" role="group" aria-label="Project actions">/);
  assert.match(html, /<div class="arch-control-group" id="arch-graph-actions"/);
  assert.match(html, /#architecture:not\(\.fullscreen\) #arch-graph-actions \{ display: none; \}/);
  assert.match(html, /#architecture:not\(\.fullscreen\) #arch-header \{ min-height: 28px;/);
  assert.match(html, /id="explorer-splitter"[^>]*role="separator"/);
  assert.match(main, /function installExplorerResizer\(\)/);
  assert.match(main, /setWindowValue\("talos\.explorer-size"/);
  assert.match(architecture, /export function selectExplorerPath\(path: string \| null\)/);
  assert.match(main, /selectExplorerPath\(tab\.path \?\? null\)/);
});

test("active document identity and status metrics stay synchronized", () => {
  assert.match(main, /scheduleEditorChrome\(\);[\s\S]{0,400}renderMeter\(/);
  assert.match(main, /\$\("meter"\)\.setAttribute\(\s*"aria-valuetext"/);
  assert.match(html, /id="meter"[^>]*role="meter"/);
  assert.match(html, /<span id="meter-label">Diagnostic pressure<\/span>/);
  assert.match(html, /id="tabs" class="tc-tabs" role="tablist"/);
  assert.match(main, /b\.setAttribute\("aria-selected", String\(active\)\)/);
  assert.match(main, /button\.setAttribute\("aria-current", "page"\)/);
});

test("the design system scales controls through shared tokens", () => {
  assert.match(css, /--tc-control-height: var\(--control-height, 30px\)/);
  assert.match(css, /--tc-activity-width: calc\(52px \* var\(--ui-scale, 1\)\)/);
  assert.match(css, /min-height: var\(--tc-control-height\);/);
  assert.match(html, /<option value="1\.5">UI 150%<\/option>/);
  assert.match(main, /const UI_SCALE_VALUES = \[0\.9, 1, 1\.1, 1\.25, 1\.5\]/);
  assert.doesNotMatch(css, /var\(--sans-font/);
});

test("the command palette stays inside short and narrow windows", () => {
  assert.match(commandPalette, /const edge = Math\.min\(160, Math\.max\(8, window\.innerWidth \/ 2 - 8\)\)/);
  assert.match(commandPalette, /const availableHeight = Math\.max\(120, window\.innerHeight - top - 12\)/);
  assert.match(commandPalette, /Math\.min\(preferredHeight, availableHeight\)/);
});
