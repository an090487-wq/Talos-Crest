import "./ui/design-system.css";
import {
  clampPanelSize,
  clampSidePaneSize,
  layoutModeLabel,
  nextLayoutPreference,
  parseLayoutPreference,
  resolveLayoutMode,
  type LayoutAxis,
  type LayoutMode,
  type LayoutPreference,
} from "./layout";
import { EditorView } from "codemirror";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import type { Text } from "@codemirror/state";
import {
  defaultKeymap,
  history,
  historyKeymap,
  redo,
  redoDepth,
  toggleComment,
  undo,
  undoDepth,
} from "@codemirror/commands";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  snippetCompletion,
  startCompletion,
} from "@codemirror/autocomplete";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  LanguageDescription,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  getSearchQuery,
  highlightSelectionMatches,
  openSearchPanel,
  searchKeymap,
  searchPanelOpen,
} from "@codemirror/search";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { forceLinting, lintGutter, lintKeymap } from "@codemirror/lint";
import type { Diagnostic } from "@codemirror/lint";
import { open, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { basicLinter, diagnosticsAvailability, setDiagnosticsLanguage } from "./diagnostics";
import { openBinaryUi } from "./binary-preview";
import { openErrorRulesDialog } from "./error-rules-ui";
import { measure, LABEL, FUN } from "./meter";
import type { Reading } from "./meter";
import { openPdf, isPdfFocused, initPdfPane } from "./pdf";
import { clearExtensionThemePreference, initExtensions, installedSnippets } from "./extensions";
import { chooseWorkspace, initArchitectureExplorer, openQuickOpen, openObservatory, openRecentWorkspace, openWorkspace, rememberRecent, setExplorerIconPack } from "./architecture";
import { currentWorkspace, markWorkspaceIndexing, subscribeWorkspace } from "./workspace";
import { initCommandPalette, openCommandPalette } from "./command-palette";
import { collectOutline } from "./outline";
import { initSourceControl, openSourceControl } from "./source-control";
import type { OutlineSymbol } from "./outline";
import { parseLineNumber } from "./editor-navigation";
import { buildTheme, applyUi, resetUi } from "./theme";
import type { ThemeDef } from "./theme";
import { builtinThemes, DEFAULT_BUILTIN_THEME } from "./ui/theme-presets";
import type { BuiltinThemeId } from "./ui/theme-presets";
import {
  fileNameFromPath,
  isAndroid,
  readFileSnapshot,
  writeText,
} from "./platform";
import type { CheckedWriteResult } from "./platform";
import { isReadOnlyAppImagePath } from "./workspace-paths";
import { isImagePath } from "./canvas/image-core";
import { getWindowValue, removeWindowValue, setWindowValue } from "./window-state";
import {
  documentKey,
  DocumentTabRegistry,
  findDocumentIndex,
  nextDocumentIndex,
  parseWindowTabsSession,
} from "./document-tabs";
import type { DocumentTabSession } from "./document-tabs";
import {
  editorShortcutBindings,
  initShortcutsUi,
  installGlobalShortcuts,
  openShortcutsDialog,
  registerShortcuts,
} from "./shortcuts";
import type { Shortcut } from "./shortcuts";

const langCompartment = new Compartment();
const themeCompartment = new Compartment();
const wrapCompartment = new Compartment();
let wordWrap = localStorage.getItem("talos.word-wrap") === "true";
let editorFontSize = Number(localStorage.getItem("talos.editor-font-size")) || 0;
let suggestedName: string | undefined;
let currentPath: string | null = null;
let diskRevision: string | null = null;
let dirty = false;
let savedDoc: Text | null = null;
let currentLanguageName = "";
interface EditorTab extends DocumentTabSession {
  id: number;
  state: EditorState;
  savedDoc: Text | null;
  revision: string | null;
  dirty: boolean;
  languageName: string;
  problemRows: Row[];
}

const tabRegistry = new DocumentTabRegistry<EditorTab>();
const editorTabs = tabRegistry.openTabs;
const recentlyClosedTabs = tabRegistry.closedTabs;
let activeTab: EditorTab | null = null;
let nextTabId = 1;
let tabSessionTimer = 0;
let view: EditorView;
let funMode = getWindowValue("talos.fun-mode") === "true";
let lastReading: Reading | null = null;
let android = false;
let productName = "Talos Crest";
let lastNativeTitle = "";
let layoutPreference: LayoutPreference = parseLayoutPreference(getWindowValue("talos.layout-mode"));
let activeLayoutMode: LayoutMode = "medium";
let layoutSyncFrame = 0;
let editorMeasureFrame = 0;
let layoutSignature = "";
// A Source Control commit must never switch the bottom panel to Output or
// trigger the editor's Run command. Source Control brackets its Git work with
// this event so layout/run handlers can stay out of the way.
let sourceControlBusy = false;
document.addEventListener("talos:source-control-busy", (event) => {
  sourceControlBusy = (event as CustomEvent<boolean>).detail === true;
});

const $ = (id: string) => document.getElementById(id)!;

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
};

// Defer non-essential work until the browser has a free moment. The timeout
// guarantees the callback still runs when an engine never reports idle time.
function whenIdle(callback: () => void, timeout = 500) {
  const idle = (window as IdleWindow).requestIdleCallback;
  if (typeof idle === "function") idle(callback, { timeout });
  else window.setTimeout(callback, 0);
}

// Layout work is coalesced into one animation frame. It must never run from the
// CodeMirror update listener, which is the keystroke-critical path.
function scheduleEditorMeasure() {
  if (editorMeasureFrame) return;
  editorMeasureFrame = requestAnimationFrame(() => {
    editorMeasureFrame = 0;
    view?.requestMeasure?.();
  });
}

function currentAppSize() {
  const bounds = $("app").getBoundingClientRect();
  return {
    width: bounds.width || window.innerWidth,
    height: bounds.height || window.innerHeight,
  };
}

function chromeHeightExcludingPanel(): number {
  const appHeight = currentAppSize().height;
  const mainHeight = $("main").getBoundingClientRect().height;
  const panel = $("panel");
  const panelVisible = !panel.classList.contains("hidden") &&
    !$("editor-region").classList.contains("panel-maximized");
  const panelHeight = panelVisible ? panel.getBoundingClientRect().height : 0;
  const splitterHeight = panelVisible ? $("panel-splitter").getBoundingClientRect().height : 0;
  return Math.max(0, appHeight - mainHeight - panelHeight - splitterHeight);
}

function visibleSidePanes(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("#main > .side-pane:not(.hidden)"));
}

function preferredSidePane(): HTMLElement | null {
  const panes = visibleSidePanes();
  if (panes.length <= 1) return panes[0] ?? null;
  const marked = panes.find((pane) => pane.id === $("main").dataset.activeSidePane);
  const chosen = marked ?? panes[panes.length - 1];
  for (const pane of panes) {
    if (pane !== chosen) pane.classList.add("hidden");
  }
  return chosen;
}

function sidePaneAxis(): LayoutAxis {
  return window.matchMedia("(max-width: 700px)").matches ? "y" : "x";
}

function applyPanelSize(mode: LayoutMode) {
  const panel = $("panel");
  const splitter = $("panel-splitter");
  if (panel.classList.contains("hidden") || $("editor-region").classList.contains("panel-maximized")) return;
  const stored = Number(getWindowValue("talos.panel-size"));
  const preferred = Number.isFinite(stored) && stored > 0 ? stored : 280;
  const viewportHeight = currentAppSize().height;
  const chrome = chromeHeightExcludingPanel();
  const min = clampPanelSize(0, viewportHeight, chrome, mode);
  const max = clampPanelSize(Number.MAX_SAFE_INTEGER, viewportHeight, chrome, mode);
  const next = clampPanelSize(preferred, viewportHeight, chrome, mode);
  const current = Number.parseFloat(panel.style.flexBasis) || panel.getBoundingClientRect().height;
  if (!Number.isFinite(current) || Math.abs(current - next) >= 1) panel.style.flexBasis = `${next}px`;
  splitter.setAttribute("aria-valuemin", String(min));
  splitter.setAttribute("aria-valuemax", String(max));
  splitter.setAttribute("aria-valuenow", String(next));
  splitter.setAttribute("aria-orientation", "horizontal");
}

const themeIds = Object.keys(builtinThemes) as BuiltinThemeId[];
const themeMigrationKey = "talos.theme-industrial-migration";
const savedTheme = localStorage.getItem("talos.theme");
// An earlier build rewrote the saved "talos-dark" preference to the new
// industrial default. Restore it for users who never explicitly picked a new
// theme; any explicit selection marks the preference as settled.
const wasAutoMigrated = localStorage.getItem(themeMigrationKey) === "1" && savedTheme === DEFAULT_BUILTIN_THEME;
const restoredTheme = wasAutoMigrated ? "talos-dark" : savedTheme;
let activeBuiltinTheme: BuiltinThemeId = themeIds.includes(restoredTheme as BuiltinThemeId)
  ? (restoredTheme as BuiltinThemeId)
  : DEFAULT_BUILTIN_THEME;
if (wasAutoMigrated) localStorage.setItem("talos.theme", activeBuiltinTheme);
localStorage.setItem(themeMigrationKey, "2");

function applyBuiltinTheme(id: BuiltinThemeId, persist = true) {
  activeBuiltinTheme = id;
  document.documentElement.dataset.theme = id;
  ($("theme-select") as HTMLSelectElement).value = id;
  const def = builtinThemes[id];
  resetUi();
  applyUi(def.ui ?? {});
  reconfigureTabThemes(buildTheme(def));
  if (persist) {
    localStorage.setItem("talos.theme", id);
    localStorage.setItem(themeMigrationKey, "2");
  }
}

function reconfigureTabThemes(theme: ReturnType<typeof buildTheme>) {
  for (const tab of editorTabs) {
    tab.state = tab.state.update({
      effects: themeCompartment.reconfigure(theme),
    }).state;
  }
  if (activeTab) {
    view.setState(activeTab.state);
    syncHistoryButtons(view.state);
  }
}

const editorFonts: Record<string, string> = {
  default: '"Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
  cascadia: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
  jetbrains: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
  consolas: 'Consolas, "Liberation Mono", monospace',
  menlo: 'Menlo, Monaco, "Liberation Mono", monospace',
};

function applyEditorFont(font: string) {
  const selected = editorFonts[font] ? font : "default";
  document.documentElement.style.setProperty("--editor-font", editorFonts[selected]);
  ($("editor-font") as HTMLSelectElement).value = selected;
  scheduleEditorMeasure();
}

const MIN_EDITOR_FONT_SIZE = 9;
const MAX_EDITOR_FONT_SIZE = 28;

function applyEditorFontSize(size: number) {
  const fallback = window.matchMedia("(max-width: 700px)").matches ? 15 : 13;
  const next = Math.min(
    MAX_EDITOR_FONT_SIZE,
    Math.max(MIN_EDITOR_FONT_SIZE, Number.isFinite(size) && size > 0 ? Math.round(size) : fallback),
  );
  editorFontSize = next;
  document.documentElement.style.setProperty("--editor-font-size", `${next}px`);
  localStorage.setItem("talos.editor-font-size", String(next));
  scheduleEditorMeasure();
}

function adjustEditorFontSize(delta: number) {
  applyEditorFontSize((editorFontSize || 13) + delta);
}

function resetEditorFontSize() {
  applyEditorFontSize(0);
}

const UI_SCALE_VALUES = [0.9, 1, 1.1, 1.25];

function applyUiScale(scale: number) {
  const next = UI_SCALE_VALUES.find((value) => Math.abs(value - scale) < 0.001) ?? 1;
  document.documentElement.style.setProperty("--ui-scale", String(next));
  localStorage.setItem("talos.ui-scale", String(next));
  ($("ui-scale") as HTMLSelectElement).value = String(next);
  scheduleEditorMeasure();
}

function setWordWrap(enabled: boolean) {
  wordWrap = enabled;
  const extension = enabled ? EditorView.lineWrapping : [];
  const scrollTop = view.scrollDOM.scrollTop;
  for (const tab of editorTabs) {
    tab.state = tab.state.update({ effects: wrapCompartment.reconfigure(extension) }).state;
  }
  if (activeTab) {
    view.setState(activeTab.state);
    view.scrollDOM.scrollTop = scrollTop;
    syncHistoryButtons(view.state);
    view.focus();
  }
  localStorage.setItem("talos.word-wrap", String(enabled));
  say(`Word wrap ${enabled ? "on" : "off"}`);
}

function toggleWordWrap() {
  setWordWrap(!wordWrap);
}

// Comparing whole document trees on every keystroke is needlessly expensive.
// A length mismatch already proves the document is dirty; only run the full
// comparison when the lengths are equal (for example after undoing back to
// the saved snapshot).
function documentIsDirty(doc: Text): boolean {
  if (savedDoc === null) return true;
  if (doc.length !== savedDoc.length) return true;
  return !savedDoc.eq(doc);
}

// Talos Calc is loaded on demand. Nothing from its parser or UI is evaluated
// while the editor is handling keystrokes.
type CalcUiModule = typeof import("./calc/calc-ui");
let calcUiModulePromise: Promise<CalcUiModule> | null = null;

function currentSelection(): string | undefined {
  if (!view) return undefined;
  const range = view.state.selection.main;
  if (range.empty) return undefined;
  const text = view.state.doc.sliceString(range.from, range.to).trim();
  return text || undefined;
}

function insertCalcResult(text: string): void {
  if (!view) return;
  const range = view.state.selection.main;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    selection: { anchor: range.from + text.length },
    scrollIntoView: true,
  });
  view.focus();
}

async function openCalcUi(initialExpression?: string): Promise<void> {
  calcUiModulePromise ??= import("./calc/calc-ui");
  const module = await calcUiModulePromise;
  module.openCalc(initialExpression, { onInsertResult: insertCalcResult });
}

// Talos Canvas is equally lazy: opening it never costs the editor keystroke
// path anything, and image codecs/workers are created only on demand.
type CanvasUiModule = typeof import("./canvas/canvas-ui");
let canvasUiModulePromise: Promise<CanvasUiModule> | null = null;

async function openCanvasUi(path?: string): Promise<void> {
  canvasUiModulePromise ??= import("./canvas/canvas-ui");
  const module = await canvasUiModulePromise;
  module.openCanvas(path);
  setActiveNav("canvas");
}

// Every keyboard shortcut lives here. "editor" entries are installed through
// CodeMirror's keymap so they can override CodeMirror defaults; "app" entries
// are handled globally so they work from the outline, dialogs, and toolbars.
const SHORTCUTS: Shortcut[] = [
  { id: "file.new", label: "New file", keys: "Mod+N", group: "File", run: () => showNewUntitledTab() },
  { id: "file.open", label: "Open file", keys: "Mod+O", group: "File", run: () => void guard(openFile) },
  { id: "file.save", label: "Save", keys: "Mod+S", group: "File", run: () => void guard(() => saveFile()) },
  {
    id: "file.save-as",
    label: "Save as",
    keys: "Mod+Shift+S",
    group: "File",
    run: () => void guard(() => saveFile(true)),
  },
  {
    id: "file.close-tab",
    label: "Close tab",
    keys: "Mod+W",
    group: "File",
    run: () => {
      if (activeTab) void guard(() => closeEditorTab(activeTab!));
    },
  },
  { id: "file.reopen-tab", label: "Reopen closed tab", keys: "Mod+Shift+T", group: "File", run: () => reopenEditorTab() },
  {
    id: "file.new-window",
    label: "New window",
    keys: "Mod+Shift+N",
    group: "File",
    run: () => void guard(() => openNewWindow()),
  },
  { id: "file.open-pdf", label: "Open PDF", keys: "Mod+Shift+P", group: "File", run: () => void guard(openPdfDialog) },
  {
    id: "file.open-binary",
    label: "Open binary file (hex preview)",
    keys: "",
    group: "File",
    run: () => void guard(openBinaryDialog),
  },

  { id: "edit.undo", label: "Undo", keys: "Mod+Z", group: "Edit", scope: "editor", run: () => void undo(view) },
  { id: "edit.redo", label: "Redo", keys: "Mod+Shift+Z", group: "Edit", scope: "editor", run: () => void redo(view) },
  { id: "edit.redo-alt", label: "Redo (alternate)", keys: "Mod+Y", group: "Edit", scope: "editor", run: () => void redo(view) },
  { id: "edit.find", label: "Find", keys: "Mod+F", group: "Edit", scope: "editor", run: () => void openSearchPanel(view) },
  {
    id: "edit.replace",
    label: "Find and replace",
    keys: "Mod+H",
    group: "Edit",
    scope: "editor",
    run: () => {
      openSearchPanel(view);
      view.dom.querySelector<HTMLInputElement>('.cm-search input[name="replace"]')?.focus();
    },
  },
  { id: "edit.comment", label: "Toggle line comment", keys: "Mod+/", group: "Edit", scope: "editor", run: () => void toggleComment(view) },
  { id: "edit.complete", label: "Show completion", keys: "Ctrl+Space", group: "Edit", scope: "editor", run: () => void startCompletion(view) },

  { id: "navigate.quick-open", label: "Quick Open", keys: "Mod+P", group: "Navigate", run: () => openQuickOpen() },
  { id: "navigate.goto-line", label: "Go to line", keys: "Mod+G", group: "Navigate", scope: "editor", run: () => openGotoLine() },
  { id: "navigate.goto-symbol", label: "Go to symbol", keys: "Mod+Shift+O", group: "Navigate", run: () => openGotoSymbol() },

  { id: "view.command-palette", label: "Command palette", keys: "Mod+K", group: "View", run: () => openCommandPalette() },
  { id: "view.terminal", label: "Focus integrated terminal", keys: "Mod+`", group: "View", run: () => openTerminalUi() },
  { id: "view.panel", label: "Toggle bottom panel", keys: "Mod+J", group: "View", run: () => togglePanel() },
  { id: "view.outline", label: "Toggle outline", keys: "Mod+B", group: "View", run: () => toggleOutline() },
  { id: "view.architecture", label: "Architecture explorer", keys: "Mod+Shift+E", group: "View", run: () => $("btn-architecture").click() },
  { id: "view.source-control", label: "Source Control", keys: "Mod+Shift+G", group: "View", run: () => void guard(openSourceControl) },
  { id: "view.zoom-in", label: "Increase editor font", keys: "Mod+=", group: "View", run: () => adjustEditorFontSize(1) },
  { id: "view.zoom-in-plus", label: "Increase editor font (plus key)", keys: "Mod+Shift+=", group: "View", run: () => adjustEditorFontSize(1) },
  { id: "view.zoom-out", label: "Decrease editor font", keys: "Mod+-", group: "View", run: () => adjustEditorFontSize(-1) },
  { id: "view.zoom-reset", label: "Reset editor font size", keys: "Mod+0", group: "View", run: () => resetEditorFontSize() },
  { id: "view.word-wrap", label: "Toggle word wrap", keys: "Alt+Z", group: "View", run: () => toggleWordWrap() },

  { id: "tabs.next", label: "Next tab", keys: "Mod+Tab", group: "Tabs", run: () => switchEditorTab(1) },
  { id: "tabs.previous", label: "Previous tab", keys: "Mod+Shift+Tab", group: "Tabs", run: () => switchEditorTab(-1) },
  ...Array.from({ length: 9 }, (_, index): Shortcut => ({
    id: `tabs.${index + 1}`,
    label: `Activate tab ${index + 1}`,
    keys: `Mod+${index + 1}`,
    group: "Tabs",
    run: () => activateEditorTab(editorTabs[index]),
  })),

  { id: "tools.calc", label: "Open Talos Calc", keys: "Mod+Shift+C", group: "Tools", run: () => void guard(() => openCalcUi()) },
  {
    id: "tools.calc-selection",
    label: "Evaluate selection in Talos Calc",
    keys: "Alt+C",
    group: "Tools",
    scope: "editor",
    run: () => void guard(() => openCalcUi(currentSelection())),
  },
  { id: "tools.canvas", label: "Open Talos Canvas", keys: "Mod+Shift+I", group: "Tools", run: () => void guard(() => openCanvasUi()) },
  {
    id: "tools.error-rules",
    label: "Custom Error Detection Rules",
    keys: "",
    group: "Tools",
    run: () => openErrorRulesDialog(),
  },

  // Canvas-local tool keys are handled by canvas-ui while its workspace is
  // visible. They are registered here so F1 documents them, without run
  // handlers that would fire when Canvas is closed.
  { id: "canvas.select", label: "Canvas: select tool", keys: "V", group: "Canvas" },
  { id: "canvas.crop", label: "Canvas: crop tool", keys: "C", group: "Canvas" },
  { id: "canvas.pan", label: "Canvas: pan tool", keys: "H", group: "Canvas" },
  { id: "canvas.zoom", label: "Canvas: zoom tool", keys: "Z", group: "Canvas" },
  { id: "canvas.brush", label: "Canvas: brush tool", keys: "B", group: "Canvas" },
  { id: "canvas.eraser", label: "Canvas: eraser tool", keys: "X", group: "Canvas" },
  { id: "canvas.line", label: "Canvas: line tool", keys: "L", group: "Canvas" },
  { id: "canvas.rect", label: "Canvas: rectangle tool", keys: "R", group: "Canvas" },
  { id: "canvas.ellipse", label: "Canvas: ellipse tool", keys: "O", group: "Canvas" },
  { id: "canvas.arrow", label: "Canvas: arrow annotation", keys: "A", group: "Canvas" },
  { id: "canvas.triangle", label: "Canvas: triangle tool", keys: "N", group: "Canvas" },
  { id: "canvas.star", label: "Canvas: star tool", keys: "S", group: "Canvas" },
  { id: "canvas.polygon", label: "Canvas: polygon tool", keys: "P", group: "Canvas" },
  { id: "canvas.callout", label: "Canvas: numbered callout", keys: "K", group: "Canvas" },
  { id: "canvas.highlight", label: "Canvas: highlight region", keys: "Y", group: "Canvas" },
  { id: "canvas.measure", label: "Canvas: pixel measurement", keys: "M", group: "Canvas" },
  { id: "canvas.eyedropper", label: "Canvas: color eyedropper", keys: "I", group: "Canvas" },
  { id: "canvas.text", label: "Canvas: text tool", keys: "T", group: "Canvas" },
  { id: "canvas.brush-smaller", label: "Canvas: decrease brush size", keys: "[", group: "Canvas" },
  { id: "canvas.brush-larger", label: "Canvas: increase brush size", keys: "]", group: "Canvas" },
  { id: "canvas.fit", label: "Canvas: fit image to screen", keys: "0", group: "Canvas" },
  { id: "canvas.apply-crop", label: "Canvas: apply crop selection", keys: "Enter", group: "Canvas" },
  { id: "canvas.clear-crop", label: "Canvas: clear crop selection or close Canvas", keys: "Escape", group: "Canvas" },

  { id: "run.file", label: "Run file", keys: "F5", group: "Run", run: () => void guard(runFile) },
  { id: "run.file-editor", label: "Run file from editor", keys: "Mod+Enter", group: "Run", scope: "editor", run: () => void guard(runFile) },

  { id: "help.shortcuts", label: "Keyboard shortcuts", keys: "F1", group: "Help", run: () => openShortcutsDialog() },
  { id: "help.shortcuts-alt", label: "Keyboard shortcuts (alternate)", keys: "Mod+Shift+/", group: "Help", run: () => openShortcutsDialog() },
];

const paletteCommands = SHORTCUTS
  .filter((shortcut) => shortcut.run && shortcut.scope !== "editor" && !shortcut.id.startsWith("canvas."))
  .map((shortcut) => ({
    id: shortcut.id,
    label: shortcut.label,
    category: shortcut.group,
    keys: shortcut.keys,
    description: `${shortcut.group} command`,
    run: shortcut.run!,
  }));

paletteCommands.push(
  {
    id: "workspace.choose",
    label: "Open Folder",
    category: "Workspace",
    keys: "",
    description: "Open a project folder; Talos reopens it automatically next time",
    run: () => void guard(() => chooseWorkspace()),
  },
  {
    id: "workspace.open-recent",
    label: "Open Recent Workspace",
    category: "Workspace",
    keys: "",
    description: "Choose a previously opened project folder",
    run: () => openRecentWorkspace(),
  },
  {
    id: "view.chronicle",
    label: "Open Talos Chronicle",
    category: "Talos",
    keys: "",
    description: "Browse indexed project history, evidence, and decisions",
    run: () => void guard(() => openChronicleUi()),
  },
  {
    id: "view.observatory",
    label: "Open Talos Observatory",
    category: "Talos",
    keys: "",
    description: "Explore the current project's dependencies and architecture",
    run: () => openObservatory(),
  },
  {
    id: "tools.ollama",
    label: "Run Ollama model in terminal",
    category: "Tools",
    keys: "",
    description: "Type ollama run <model> into the integrated terminal",
    run: () => runOllamaInTerminal(),
  },
);

initCommandPalette(paletteCommands, (error) => say(`Command failed: ${String(error)}`));

function openChronicleUi() {
  return import("./chronicle").then((module) => module.openChronicle());
}

let terminalModule: typeof import("./terminal") | null = null;

async function ensureTerminal(focus = false): Promise<void> {
  try {
    if (!terminalModule) terminalModule = await import("./terminal");
    await terminalModule.activateTerminal({
      getCwd: () => getWindowValue("talos.workspace-root"),
      reportError: (error: unknown) => say(`Terminal: ${String(error)}`),
    });
    if (focus) terminalModule.focusTerminal();
  } catch (error) {
    say(`Could not load terminal: ${String(error)}`);
  }
}

function openTerminalUi(): Promise<void> {
  showPanel(true);
  showTab("terminal");
  return ensureTerminal(true);
}

async function runOllamaInTerminal(): Promise<void> {
  showPanel(true);
  showTab("terminal");
  await ensureTerminal();
  await terminalModule?.runOllamaModel();
}

function say(text: string) {
  $("msg").textContent = text;
}

function renderWorkspaceStatus() {
  const state = currentWorkspace();
  const status = $("workspace-status");
  status.textContent = state.status === "opening" ? "Opening…" : (state.name ?? "No workspace");
  status.title = [
    state.message,
    state.status === "ready" ? `Watcher: ${state.watcher}` : "",
    state.indexing === "indexing" ? "Chronicle: indexing" : "",
  ].filter(Boolean).join(" · ");
  status.dataset.state = state.status;
  status.dataset.watcher = state.watcher;
  status.dataset.indexing = state.indexing;
}

subscribeWorkspace(renderWorkspaceStatus);
$("workspace-status").addEventListener("click", () => void guard(() => chooseWorkspace()));
void listen<{ phase: string }>("chronicle://progress", ({ payload }) => {
  if (["done", "error", "cancelled"].includes(payload.phase)) markWorkspaceIndexing("idle");
}).catch(() => undefined);

function updateBreadcrumbs() {
  const source = currentPath ?? suggestedName ?? "Untitled";
  const parts = source.replace(/\\/g, "/").split("/").filter(Boolean);
  const visible = parts.length > 4 ? ["…", ...parts.slice(-4)] : parts;
  const label = visible.join(" / ") || "Untitled";
  const breadcrumb = $("breadcrumb-path");
  if (breadcrumb.textContent !== label) breadcrumb.textContent = label;
}

function refreshTitle() {
  const path = currentPath && android ? fileNameFromPath(currentPath) : currentPath;
  const name = (path ?? suggestedName ?? "Untitled") + (dirty ? " \u2022" : "");
  const file = $("file");
  if (file.textContent !== name) file.textContent = name;
  updateBreadcrumbs();
  const workspace = getWindowValue("talos.workspace-root");
  const workspaceName = workspace?.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  const title = [productName, workspaceName, name].filter(Boolean).join(" \u2014 ");
  if (document.title === title) return;
  document.title = title;
  if (title !== lastNativeTitle) {
    lastNativeTitle = title;
    void getCurrentWindow().setTitle(title).catch((error: unknown) => {
      say(`Could not update window title: ${String(error)}`);
    });
  }
}

// ---------- Error Meter + Problems panel ----------
interface Row {
  from: number;
  to: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: "error" | "warning" | "info" | "hint";
  source: string;
  message: string;
}

interface WindowContext {
  initialPath: string | null;
  workspacePath: string | null;
}

interface FileSavedNotice {
  path: string;
  revision: string;
  owner: string;
}

let problemRows: Row[] = [];
let outlineTimer = 0;
let outlineCache: {
  doc: EditorState["doc"];
  language: string;
  complete: boolean;
  result: ReturnType<typeof collectOutline>;
} | null = null;
let symbolPicker: OutlineSymbol[] = [];
let symbolPickerIndex = 0;
let symbolPickerMessage = "";
let searchCountTimer = 0;
let searchCountKey = "";
let externalCheckTimer = 0;

let meterLevel = "";
let meterText = "";

function renderMeter(r: Reading) {
  lastReading = r;
  if (meterLevel !== r.level) {
    meterLevel = r.level;
    $("meter").dataset.level = r.level;
  }
  $("gauge-fill").style.width = Math.max(r.score, 4) + "%";
  const label = funMode ? FUN[r.level] : LABEL[r.level];
  const text =
    label + " \u00b7 " + r.score + "% \u00b7 " + r.errors + " err \u00b7 " + r.warnings + " warn";
  if (meterText !== text) {
    meterText = text;
    $("meter-text").textContent = text;
  }
}

async function restoreEditorSession(): Promise<boolean> {
  const raw = getWindowValue("talos.editor-session");
  if (!raw) return false;
  const session = parseWindowTabsSession(raw);
  if (!session) {
    say("The saved editor session is invalid and was not restored.");
    return false;
  }
  const restore = async (saved: DocumentTabSession): Promise<EditorTab | null> => {
    try {
      let snapshot: Awaited<ReturnType<typeof readFileSnapshot>> = null;
      if (saved.path) snapshot = await readFileSnapshot(saved.path);
      if (saved.path && !snapshot && saved.contents === undefined) {
        say(`Skipped inaccessible session file: ${saved.path}`);
        return null;
      }
      const contents = saved.contents ?? snapshot?.contents ?? "";
      if (snapshot?.binary && saved.contents === undefined) {
        say(`Skipped binary session file: ${saved.path}`);
        return null;
      }
      if (snapshot?.binary) say(`Restored unsaved text for ${saved.path}; the disk file is now binary.`);
      const state = createEditorState(contents, view.state).update({
        selection: {
          anchor: Math.min(saved.anchor, contents.length),
          head: Math.min(saved.head, contents.length),
        },
      }).state;
      const dirtyBuffer = saved.contents !== undefined && saved.contents !== snapshot?.contents;
      const savedState = snapshot && !snapshot.binary
        ? EditorState.create({ doc: snapshot.contents }).doc
        : null;
      return {
        id: nextTabId++,
        path: saved.path,
        suggestedName: saved.suggestedName,
        anchor: saved.anchor,
        head: saved.head,
        scrollTop: saved.scrollTop,
        state,
        savedDoc: dirtyBuffer ? savedState : state.doc,
        revision: snapshot?.revision ?? null,
        dirty: dirtyBuffer,
        languageName: "",
        problemRows: [],
      };
    } catch (error) {
      say(`Could not restore ${saved.path ?? saved.suggestedName ?? "an untitled document"}: ${String(error)}`);
      return null;
    }
  };

  const restored: EditorTab[] = [];
  for (const saved of session.documents) {
    const tab = await restore(saved);
    if (tab) restored.push(tab);
  }
  const restoredClosed: EditorTab[] = [];
  for (const saved of session.closedTabs ?? []) {
    const tab = await restore(saved);
    if (tab) restoredClosed.push(tab);
  }
  tabRegistry.replace(restored);
  recentlyClosedTabs.push(...restoredClosed);
  if (!restored.length) return false;
  activeTab = null;
  const selected = restored[session.activeIndex] ?? restored[0];
  activateEditorTab(selected);
  try {
    await setLanguage(selected.path ?? selected.suggestedName ?? "");
  } catch (error) {
    // Session restore must not fail because an optional language package is
    // unavailable; the document is already restored as plain text.
    say(`Restored ${fileNameFromPath(selected.path ?? selected.suggestedName ?? "document")} as plain text: ${String(error)}`);
  }
  return true;
}

function renderProblems(rows = problemRows) {
  const box = $("problems");
  box.textContent = "";
  $("count").textContent = String(rows.length);
  const severity = ($("problems-severity") as HTMLSelectElement).value;
  const visible = severity === "all" ? rows : rows.filter((row) => row.severity === severity);
  if (rows.length === 0) {
    const p = document.createElement("div");
    p.className = "empty";
    p.textContent = diagnosticsAvailability(currentLanguageName);
    box.appendChild(p);
    return;
  }
  if (visible.length === 0) {
    const p = document.createElement("div");
    p.className = "empty";
    p.textContent = "No diagnostics match this severity filter.";
    box.appendChild(p);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const r of visible.slice(0, 300)) {
    const el = document.createElement("div");
    el.className = "row " + r.severity;
    const path = currentPath ?? suggestedName ?? "Untitled";
    el.textContent =
      path +
      ":" +
      r.line +
      ":" +
      r.column +
      "  [" +
      r.source +
      "] " +
      r.message;
    el.title = `From line ${r.line}, column ${r.column} to line ${r.endLine}, column ${r.endColumn}`;
    el.addEventListener("click", () => {
      view.dispatch({
        selection: {
          anchor: Math.min(r.from, view.state.doc.length),
          head: Math.min(r.to, view.state.doc.length),
        },
        scrollIntoView: true,
      });
      view.focus();
    });
    fragment.appendChild(el);
  }
  // Insert once so the browser can lay out the list in a single pass.
  box.appendChild(fragment);
}

// Reuse the last outline while the document is unchanged, so typing in the
// outline filter does not re-parse the file on every key press.
function currentOutline() {
  const doc = view.state.doc;
  if (
    outlineCache &&
    outlineCache.doc === doc &&
    outlineCache.language === currentLanguageName &&
    outlineCache.complete
  ) {
    return outlineCache.result;
  }
  const result = collectOutline(view.state, currentLanguageName);
  outlineCache = { doc, language: currentLanguageName, complete: result.complete, result };
  return result;
}

function renderOutline() {
  const list = $("outline-list");
  list.textContent = "";
  const result = currentOutline();
  const status = $("outline-status");
  if (!result.supported) {
    status.textContent = `No symbol parser is configured for ${currentLanguageName || "Plain text"}.`;
    return;
  }
  status.textContent = result.complete
    ? `${result.symbols.length} symbols from the ${currentLanguageName} syntax parser.`
    : `Parser has not finished this document; showing ${result.symbols.length} available symbols.`;
  const query = ($("outline-search") as HTMLInputElement).value.trim().toLowerCase();
  const symbols = result.symbols.filter((symbol) => !query || symbol.name.toLowerCase().includes(query));
  if (symbols.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = query ? "No symbols match this filter." : "No symbols found.";
    list.appendChild(empty);
    return;
  }
  const kindIcons: Record<OutlineSymbol["kind"], string> = {
    class: "C",
    function: "ƒ",
    method: "ƒ",
    interface: "I",
    type: "T",
    variable: "v",
  };
  const fragment = document.createDocumentFragment();
  for (const symbol of symbols) {
    const row = document.createElement("button");
    row.className = "outline-row";
    row.type = "button";
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-level", String(symbol.depth + 1));
    row.style.paddingInlineStart = `${7 + symbol.depth * 14}px`;
    row.title = `${symbol.kind}: ${symbol.name}`;
    const icon = document.createElement("span");
    icon.className = "outline-kind";
    icon.textContent = kindIcons[symbol.kind];
    const name = document.createElement("span");
    name.className = "outline-name";
    name.textContent = symbol.name;
    row.append(icon, name);
    row.addEventListener("click", () => {
      view.dispatch({
        selection: { anchor: symbol.from, head: symbol.to },
        scrollIntoView: true,
      });
      view.focus();
    });
    fragment.appendChild(row);
  }
  list.appendChild(fragment);
}

function openGotoLine() {
  const dialog = $("goto-line-dialog") as HTMLDialogElement;
  const input = $("goto-line-input") as HTMLInputElement;
  input.value = String(view.state.doc.lineAt(view.state.selection.main.head).number);
  $("goto-line-status").textContent = "";
  if (!dialog.open) dialog.showModal();
  input.focus();
  input.select();
}

function renderSymbolPicker() {
  const results = $("symbol-results");
  const status = $("symbol-status");
  results.textContent = "";
  const query = ($("symbol-search") as HTMLInputElement).value.trim().toLocaleLowerCase();
  const matches = symbolPicker.filter((symbol) => symbol.name.toLocaleLowerCase().includes(query));
  symbolPickerIndex = Math.min(symbolPickerIndex, Math.max(0, matches.length - 1));
  status.textContent = symbolPickerMessage || `${matches.length} symbols${query ? " match" : ""}`;
  const fragment = document.createDocumentFragment();
  for (const [index, symbol] of matches.entries()) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `workspace-result${index === symbolPickerIndex ? " active" : ""}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(index === symbolPickerIndex));
    const name = document.createElement("span");
    name.className = "workspace-result-name";
    name.textContent = `${"  ".repeat(symbol.depth)}${symbol.name}`;
    const kind = document.createElement("span");
    kind.className = "workspace-result-path";
    kind.textContent = symbol.kind;
    row.append(name, kind);
    row.addEventListener("mouseenter", () => {
      symbolPickerIndex = index;
      [...results.children].forEach((item, itemIndex) => {
        item.classList.toggle("active", itemIndex === index);
        item.setAttribute("aria-selected", String(itemIndex === index));
      });
    });
    row.addEventListener("click", () => {
      view.dispatch({
        selection: { anchor: symbol.from, head: symbol.to },
        scrollIntoView: true,
      });
      ($("symbol-dialog") as HTMLDialogElement).close();
      view.focus();
    });
    fragment.appendChild(row);
  }
  results.appendChild(fragment);
  if (!matches.length) {
    const empty = document.createElement("div");
    empty.className = "workspace-dialog-status";
    empty.textContent = query ? "No symbols match this filter." : "No symbols found.";
    results.appendChild(empty);
  }
}

function scheduleSearchCount() {
  if (searchCountTimer) window.clearTimeout(searchCountTimer);
  searchCountTimer = window.setTimeout(() => {
    searchCountTimer = 0;
    whenIdle(() => {
      if (!searchPanelOpen(view.state)) return;
      const panel = view.dom.querySelector<HTMLElement>(".cm-search");
      if (!panel) return;
      let status = panel.querySelector<HTMLElement>(".talos-search-count");
      if (!status) {
        status = document.createElement("span");
        status.className = "talos-search-count";
        status.setAttribute("role", "status");
        panel.appendChild(status);
      }
      const query = getSearchQuery(view.state);
      if (!query.search) {
        status.textContent = "";
        return;
      }
      if (!query.valid) {
        status.textContent = "Invalid search expression";
        return;
      }
      let count = 0;
      const cursor = query.getCursor(view.state);
      let match = cursor.next();
      while (!match.done) {
        count++;
        if (count > 1000) break;
        match = cursor.next();
      }
      status.textContent = count > 1000 ? "1000+ matches" : `${count} match${count === 1 ? "" : "es"}`;
    }, 250);
  }, 150);
}

function openGotoSymbol() {
  const result = collectOutline(view.state, currentLanguageName);
  symbolPicker = result.symbols;
  symbolPickerIndex = 0;
  if (!result.supported) {
    symbolPickerMessage = `No symbol parser is configured for ${currentLanguageName || "Plain text"}.`;
  } else {
    symbolPickerMessage = result.complete
      ? `${symbolPicker.length} symbols from the ${currentLanguageName} parser.`
      : `Parser is incomplete; showing ${symbolPicker.length} available symbols.`;
  }
  ($("symbol-search") as HTMLInputElement).value = "";
  renderSymbolPicker();
  const dialog = $("symbol-dialog") as HTMLDialogElement;
  if (!dialog.open) dialog.showModal();
  $("symbol-search").focus();
}

function scheduleOutline() {
  if ($("outline-pane").classList.contains("hidden")) return;
  if (outlineTimer) window.clearTimeout(outlineTimer);
  outlineTimer = window.setTimeout(() => {
    outlineTimer = 0;
    // Parsing and rebuilding the outline can take a few milliseconds on large
    // files, so keep it out of the frame where typing stopped.
    whenIdle(renderOutline, 400);
  }, 300);
}

// The outline can contain thousands of rows, so filter typing is coalesced
// instead of rebuilding the list on every keystroke.
let outlineFilterTimer = 0;

function scheduleOutlineFilter() {
  if (outlineFilterTimer) window.clearTimeout(outlineFilterTimer);
  outlineFilterTimer = window.setTimeout(() => {
    outlineFilterTimer = 0;
    renderOutline();
  }, 80);
}

// The symbol picker rebuilds every row plus its listeners on each keystroke;
// coalesce those rebuilds the same way the outline does.
let symbolFilterTimer = 0;

function flushSymbolFilter() {
  if (symbolFilterTimer) window.clearTimeout(symbolFilterTimer);
  symbolFilterTimer = 0;
  renderSymbolPicker();
}

function scheduleSymbolFilter() {
  if (symbolFilterTimer) window.clearTimeout(symbolFilterTimer);
  symbolFilterTimer = window.setTimeout(flushSymbolFilter, 80);
}

function onDiagnostics(diags: readonly Diagnostic[], doc: Text) {
  const rows: Row[] = diags.map((diagnostic) => {
    const from = Math.min(diagnostic.from, doc.length);
    const to = Math.min(diagnostic.to, doc.length);
    const start = doc.lineAt(from);
    const end = doc.lineAt(to);
    return {
      from,
      to,
      line: start.number,
      column: from - start.from + 1,
      endLine: end.number,
      endColumn: to - end.from + 1,
      severity: diagnostic.severity,
      source: diagnostic.source ?? "Unknown source",
      message: diagnostic.message,
    };
  });
  rows.sort((a, b) => a.line - b.line);
  problemRows = rows;
  if (activeTab && activeTab.state.doc === doc) activeTab.problemRows = rows;
  // Rebuilding the problems list is only visible when the panel is open.
  if (!$("panel").classList.contains("hidden") && !$("problems").classList.contains("hidden")) {
    renderProblems();
  }
  renderMeter(
    measure(
      rows.map((x) => x.severity),
      doc.lines
    )
  );
}

// ---------- Panel + tabs ----------
type BottomTab = "problems" | "output" | "terminal" | "build" | "debug";
const bottomViews: Record<BottomTab, string> = {
  problems: "problems",
  output: "output",
  terminal: "channel-terminal",
  build: "channel-build",
  debug: "channel-debug",
};

function showTab(tab: BottomTab, focus = false) {
  if (tab === "output" && sourceControlBusy) return;
  setWindowValue("talos.bottom-panel-tab", tab);
  for (const b of document.querySelectorAll<HTMLElement>("[data-tab]")) {
    b.classList.toggle("active", b.dataset.tab === tab);
  }
  for (const [name, id] of Object.entries(bottomViews)) {
    $(id).classList.toggle("hidden", name !== tab);
  }
  $("problems-toolbar").classList.toggle("hidden", tab !== "problems");
  if (tab === "problems" && !$("panel").classList.contains("hidden")) renderProblems();
  if (tab === "terminal" && !$("panel").classList.contains("hidden")) void ensureTerminal(focus);
}

function setPanelMaximized(maximized: boolean) {
  setWindowValue("talos.panel-maximized", String(maximized));
  const region = $("editor-region");
  region.classList.toggle("panel-maximized", maximized);
  const button = $("btn-panel-max") as HTMLButtonElement;
  const title = maximized ? "Restore panel" : "Maximize panel";
  button.setAttribute("aria-pressed", String(maximized));
  button.setAttribute("aria-label", title);
  button.title = title;
  button.textContent = maximized ? "Restore" : "Max";
  scheduleLayoutSync(maximized ? "panel-maximize" : "panel-restore");
  scheduleEditorMeasure();
}

function showPanel(show: boolean, persist = true) {
  if (show && sourceControlBusy) return;
  if (!show && $("editor-region").classList.contains("panel-maximized")) setPanelMaximized(false);
  $("panel").classList.toggle("hidden", !show);
  $("panel-splitter").classList.toggle("hidden", !show);
  if (show && !$("problems").classList.contains("hidden")) renderProblems();
  if (show && !$("channel-terminal").classList.contains("hidden")) void ensureTerminal(true);
  if (persist) setWindowValue("talos.panel-visible", String(show));
  scheduleLayoutSync(show ? "panel-open" : "panel-close");
  scheduleEditorMeasure();
}

let previewNonce = "";
let previewRefreshTimer = 0;

function previewConsoleRow(kind: string, text: string) {
  const log = $("preview-console");
  const row = document.createElement("div");
  row.className = `preview-console-row ${kind}`;
  const label = document.createElement("span");
  label.className = "preview-console-kind";
  label.textContent = kind;
  row.append(label, document.createTextNode(text.slice(0, 2_000)));
  log.appendChild(row);
  while (log.childElementCount > 200) log.firstElementChild?.remove();
  log.scrollTop = log.scrollHeight;
}

function clearPreviewConsole() {
  $("preview-console").replaceChildren();
}

function injectPreviewBridge(source: string): string {
  const nonce = JSON.stringify(previewNonce);
  const bridge = `<script>(function(){var channel="talos-preview";var nonce=${nonce};function normalize(value){try{if(typeof value==="string")return value;if(typeof value==="undefined")return "undefined";if(typeof value==="function")return "[function]";return JSON.stringify(value);}catch(error){return String(value);}}function send(kind,args){try{parent.postMessage({channel:channel,nonce:nonce,kind:kind,args:args},"*");}catch(error){}}["log","info","warn","error"].forEach(function(kind){var original=console[kind];console[kind]=function(){send(kind,Array.prototype.map.call(arguments,normalize));return original.apply(console,arguments);};});window.addEventListener("error",function(event){send("error",[(event.message||"Script error")+" ("+(event.filename||"inline")+":"+(event.lineno||0)+":"+(event.colno||0)+")"]);});window.addEventListener("unhandledrejection",function(event){send("error",["Unhandled promise rejection: "+normalize(event.reason)]);});})();</script>`;
  const head = /<head(?:\s[^>]*)?>/i.exec(source);
  if (head) {
    const index = head.index + head[0].length;
    return `${source.slice(0, index)}${bridge}${source.slice(index)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(source);
  if (doctype) {
    const index = doctype.index + doctype[0].length;
    return `${source.slice(0, index)}${bridge}${source.slice(index)}`;
  }
  return `${bridge}${source}`;
}

function applyPreviewViewport() {
  const value = ($("preview-viewport") as HTMLSelectElement).value;
  const frame = $("html-preview-frame") as HTMLIFrameElement;
  if (value === "fit") frame.style.removeProperty("--preview-width");
  else frame.style.setProperty("--preview-width", `${Number(value)}px`);
  setWindowValue("talos.preview-viewport", value);
}

function refreshHtmlPreview() {
  if ($("html-preview").classList.contains("hidden")) return;
  previewNonce = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  clearPreviewConsole();
  const frame = $("html-preview-frame") as HTMLIFrameElement;
  frame.srcdoc = injectPreviewBridge(view.state.doc.toString());
}

function scheduleHtmlPreviewRefresh() {
  if ($("html-preview").classList.contains("hidden")) return;
  window.clearTimeout(previewRefreshTimer);
  previewRefreshTimer = window.setTimeout(() => {
    previewRefreshTimer = 0;
    refreshHtmlPreview();
  }, 250);
}

function onPreviewMessage(event: MessageEvent) {
  const frame = $("html-preview-frame") as HTMLIFrameElement;
  if (event.source !== frame.contentWindow || $("html-preview").classList.contains("hidden")) return;
  const data = event.data as {
    channel?: unknown;
    nonce?: unknown;
    kind?: unknown;
    args?: unknown;
  } | null;
  if (!data || data.channel !== "talos-preview" || data.nonce !== previewNonce || typeof data.kind !== "string") return;
  if (!Array.isArray(data.args)) return;
  const kind = data.kind === "error" ? "error" : data.kind === "warn" ? "warn" : "log";
  const text = data.args.map((value) => typeof value === "string" ? value : String(value)).join(" ");
  previewConsoleRow(kind, text);
}

function initPreviewControls() {
  const select = $("preview-viewport") as HTMLSelectElement;
  const saved = getWindowValue("talos.preview-viewport");
  if (saved && Array.from(select.options, (option) => option.value).includes(saved)) select.value = saved;
  select.addEventListener("change", applyPreviewViewport);
  applyPreviewViewport();
  $("preview-reload").addEventListener("click", refreshHtmlPreview);
  $("preview-console-toggle").addEventListener("click", () => {
    const log = $("preview-console");
    const hidden = log.classList.toggle("hidden");
    const button = $("preview-console-toggle") as HTMLButtonElement;
    button.setAttribute("aria-pressed", String(!hidden));
    button.textContent = hidden ? "Console" : "Hide console";
  });
  window.addEventListener("message", onPreviewMessage);
}

function previewHtml() {
  toggleOutline(false);
  const preview = $("html-preview");
  preview.classList.remove("hidden");
  $("main").dataset.activeSidePane = preview.id;
  syncSidePane();
  scheduleEditorMeasure();
  refreshHtmlPreview();
}

function closeHtmlPreview() {
  window.clearTimeout(previewRefreshTimer);
  previewRefreshTimer = 0;
  clearPreviewConsole();
  ($("html-preview-frame") as HTMLIFrameElement).srcdoc = "";
  $("html-preview").classList.add("hidden");
  syncSidePane();
  scheduleEditorMeasure();
}

function togglePanel() {
  showPanel($("panel").classList.contains("hidden"));
}

function sidePaneSizeKey(id: string): string {
  if (id === "panel") return "talos.panel-size";
  if (id === "pdf-pane") return "talos.pdf-pane-size";
  if (id === "html-preview") return "talos.html-preview-size";
  return "talos.side-pane-size";
}

function syncSidePane() {
  const pane = preferredSidePane();
  const open = pane !== null;
  $("main").classList.toggle("side-pane-open", open);
  $("side-splitter").classList.toggle("hidden", !open);
  if (!pane) return;
  const axis = sidePaneAxis();
  const bounds = $("main").getBoundingClientRect();
  const containerSize = axis === "x" ? bounds.width : bounds.height;
  const sizeKey = sidePaneSizeKey(pane.id);
  const storedSize = Number(getWindowValue(sizeKey));
  const inlineSize = Number.parseFloat(pane.style.flexBasis);
  const measuredSize = pane.getBoundingClientRect()[axis === "x" ? "width" : "height"];
  const preferredSize = Number.isFinite(inlineSize) && inlineSize > 0
    ? inlineSize
    : Number.isFinite(storedSize) && storedSize > 0
      ? storedSize
      : measuredSize;
  const min = clampSidePaneSize(0, containerSize, activeLayoutMode, axis);
  const max = clampSidePaneSize(Number.MAX_SAFE_INTEGER, containerSize, activeLayoutMode, axis);
  // Clamp only the applied size. The stored preference is kept so a larger
  // window can restore the user's preferred pane size later.
  const size = clampSidePaneSize(preferredSize, containerSize, activeLayoutMode, axis);
  if (Number.isFinite(preferredSize) && preferredSize > 0) pane.style.flexBasis = `${size}px`;
  const axisSize = pane.getBoundingClientRect()[axis === "x" ? "width" : "height"];
  $("side-splitter").setAttribute("aria-valuemin", String(min));
  $("side-splitter").setAttribute("aria-valuemax", String(max));
  $("side-splitter").setAttribute("aria-valuenow", String(Math.round(axisSize)));
  $("side-splitter").setAttribute("aria-orientation", axis === "x" ? "vertical" : "horizontal");
}

function toggleOutline(force?: boolean) {
  const pane = $("outline-pane");
  const shouldOpen = force ?? pane.classList.contains("hidden");
  if (shouldOpen) {
    closeHtmlPreview();
    if (!$("pdf-pane").classList.contains("hidden")) ($("pdf-close") as HTMLButtonElement).click();
  }
  pane.classList.toggle("hidden", !shouldOpen);
  if (shouldOpen) $("main").dataset.activeSidePane = pane.id;
  $("btn-outline").classList.toggle("active", shouldOpen);
  setWindowValue("talos.outline-visible", String(shouldOpen));
  syncSidePane();
  scheduleEditorMeasure();
  if (shouldOpen) renderOutline();
}

function installResizeHandle(
  handle: HTMLElement,
  getTarget: () => HTMLElement | null,
  axis: "x" | "y"
) {
  const readSize = (target: HTMLElement, dimension: "x" | "y") =>
    dimension === "x" ? target.getBoundingClientRect().width : target.getBoundingClientRect().height;

  const resizeTo = (target: HTMLElement, size: number, dimension: "x" | "y") => {
    const bounds = target.parentElement?.getBoundingClientRect();
    const sidePane = handle.id === "side-splitter";
    const containerSize = dimension === "x"
      ? bounds?.width ?? window.innerWidth
      : bounds?.height ?? window.innerHeight;
    const min = sidePane
      ? clampSidePaneSize(0, containerSize, activeLayoutMode, dimension)
      : clampPanelSize(0, currentAppSize().height, chromeHeightExcludingPanel(), activeLayoutMode);
    const max = sidePane
      ? clampSidePaneSize(Number.MAX_SAFE_INTEGER, containerSize, activeLayoutMode, dimension)
      : clampPanelSize(Number.MAX_SAFE_INTEGER, currentAppSize().height, chromeHeightExcludingPanel(), activeLayoutMode);
    const next = sidePane
      ? clampSidePaneSize(size, containerSize, activeLayoutMode, dimension)
      : clampPanelSize(size, currentAppSize().height, chromeHeightExcludingPanel(), activeLayoutMode);
    const requested = Math.max(1, Math.min(4096, Math.round(size)));
    target.style.flexBasis = `${next}px`;
    if (sidePane) document.dispatchEvent(new Event("talos:side-pane-resize"));
    else document.dispatchEvent(new Event("talos:panel-resize"));
    handle.setAttribute("aria-valuemin", String(min));
    handle.setAttribute("aria-valuemax", String(max));
    handle.setAttribute("aria-valuenow", String(next));
    handle.setAttribute("aria-orientation", dimension === "x" ? "vertical" : "horizontal");
    // Store the requested size, not the clamped size, so shrinking a window
    // temporarily does not destroy the user's preferred pane dimensions.
    setWindowValue(sidePaneSizeKey(target.id), String(requested));
    scheduleEditorMeasure();
  };

  const targetId = getTarget()?.id;
  const storedSize = targetId ? getWindowValue(sidePaneSizeKey(targetId)) : null;
  const initialTarget = getTarget();
  if (initialTarget && storedSize) {
    const size = Number(storedSize);
    if (Number.isFinite(size) && size > 0) initialTarget.style.flexBasis = `${size}px`;
  }

  handle.addEventListener("pointerdown", (event: PointerEvent) => {
    const target = getTarget();
    if (!target || event.button !== 0) return;
    event.preventDefault();
    const mobile = axis === "x" && window.matchMedia("(max-width: 700px)").matches;
    const coordinate = mobile ? event.clientY : axis === "x" ? event.clientX : event.clientY;
    const actualAxis = mobile ? "y" : axis;
    const startSize = readSize(target, actualAxis);
    const startCoordinate = coordinate;
    handle.setPointerCapture(event.pointerId);
    const move = (nextEvent: PointerEvent) => {
      const current = actualAxis === "x" ? nextEvent.clientX : nextEvent.clientY;
      resizeTo(target, startSize + startCoordinate - current, actualAxis);
    };
    const finish = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      scheduleLayoutSync("resize-end");
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish, { once: true });
    handle.addEventListener("pointercancel", finish, { once: true });
  });

  handle.addEventListener("keydown", (event: KeyboardEvent) => {
    const target = getTarget();
    if (!target) return;
    const mobile = axis === "x" && window.matchMedia("(max-width: 700px)").matches;
    const dimension = mobile ? "y" : axis;
    const horizontal = dimension === "x";
    const increase = horizontal ? event.key === "ArrowLeft" : event.key === "ArrowUp";
    const decrease = horizontal ? event.key === "ArrowRight" : event.key === "ArrowDown";
    if (!increase && !decrease) return;
    event.preventDefault();
    const step = event.shiftKey ? 80 : 20;
    resizeTo(target, readSize(target, dimension) + (increase ? step : -step), dimension);
  });
}

function updateLayoutButton() {
  const button = $("btn-layout-mode") as HTMLButtonElement;
  const current = layoutPreference === "auto"
    ? `Auto (${layoutModeLabel(activeLayoutMode)})`
    : layoutModeLabel(layoutPreference);
  button.textContent = `Layout: ${current}`;
  button.title = `Layout mode: ${current}. Click to cycle Auto, Large, Medium and Compact.`;
  button.setAttribute("aria-label", button.title);
}

const overflowActionIds = [
  "btn-open",
  "btn-quick-open",
  "btn-architecture",
  "btn-outline",
  "btn-pdf",
  "btn-preview",
  "btn-calc",
  "btn-canvas",
  "btn-undo",
  "btn-redo",
  "btn-save",
  "btn-saveas",
  "btn-run",
  "btn-ext",
  "btn-tpl",
];

function closeToolbarOverflow() {
  $("toolbar-overflow-menu").classList.add("hidden");
  $("btn-toolbar-overflow").setAttribute("aria-expanded", "false");
}

function refreshToolbarOverflow() {
  const menu = $("toolbar-overflow-menu");
  menu.replaceChildren();
  for (const id of overflowActionIds) {
    const source = document.getElementById(id) as HTMLButtonElement | null;
    if (!source) continue;
    const item = document.createElement("button");
    item.type = "button";
    item.className = "toolbar-overflow-item";
    item.textContent = source.textContent?.trim() || id;
    item.disabled = source.disabled;
    item.title = source.title || item.textContent || id;
    item.setAttribute("role", "menuitem");
    item.addEventListener("click", () => {
      closeToolbarOverflow();
      source.click();
    });
    menu.appendChild(item);
  }
}

function openToolbarOverflow() {
  const button = $("btn-toolbar-overflow");
  const menu = $("toolbar-overflow-menu");
  refreshToolbarOverflow();
  const rect = button.getBoundingClientRect();
  menu.style.top = `${Math.round(rect.bottom + 4)}px`;
  menu.style.right = `${Math.max(8, Math.round(window.innerWidth - rect.right))}px`;
  menu.classList.remove("hidden");
  button.setAttribute("aria-expanded", "true");
  (menu.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? menu.querySelector<HTMLButtonElement>("button"))?.focus();
}

function installToolbarOverflow() {
  $("btn-toolbar-overflow").addEventListener("click", () => {
    if ($("toolbar-overflow-menu").classList.contains("hidden")) openToolbarOverflow();
    else closeToolbarOverflow();
  });
  document.addEventListener("pointerdown", (event) => {
    if ($("toolbar-overflow-menu").classList.contains("hidden")) return;
    const target = event.target as Node | null;
    if ($("toolbar-overflow-menu").contains(target) || $("btn-toolbar-overflow").contains(target)) return;
    closeToolbarOverflow();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeToolbarOverflow();
  });
  window.addEventListener("resize", closeToolbarOverflow);
}

function syncLayout(reason: string) {
  const size = currentAppSize();
  const mode = resolveLayoutMode(layoutPreference, size);
  if (mode !== activeLayoutMode || document.documentElement.dataset.layoutMode !== mode) {
    activeLayoutMode = mode;
    document.documentElement.dataset.layoutMode = mode;
  }
  if (mode !== "compact") closeToolbarOverflow();
  applyPanelSize(mode);
  syncSidePane();
  updateLayoutButton();
  const panel = $("panel");
  const sidePane = preferredSidePane();
  const signature = [
    reason,
    mode,
    Math.round(size.width),
    Math.round(size.height),
    panel.classList.contains("hidden") ? "panel-hidden" : panel.style.flexBasis,
    $("editor-region").classList.contains("panel-maximized") ? "maximized" : "normal",
    sidePane ? `${sidePane.id}:${sidePane.style.flexBasis}` : "no-side",
  ].join("|");
  if (signature !== layoutSignature) {
    layoutSignature = signature;
    scheduleEditorMeasure();
  }
}

function scheduleLayoutSync(reason = "resize") {
  if (layoutSyncFrame) return;
  layoutSyncFrame = requestAnimationFrame(() => {
    layoutSyncFrame = 0;
    syncLayout(reason);
  });
}

function installLayoutObserver() {
  if (typeof ResizeObserver === "undefined") return;
  const observer = new ResizeObserver(() => scheduleLayoutSync("observer"));
  observer.observe($("app"));
  observer.observe($("main"));
}

function installWorkspaceResizers() {
  installResizeHandle(
    $("side-splitter"),
    () => preferredSidePane(),
    "x"
  );
  installResizeHandle($("panel-splitter"), () => $("panel"), "y");
  window.addEventListener("resize", () => scheduleLayoutSync("window"));
  installLayoutObserver();
  $("btn-layout-mode").addEventListener("click", () => {
    layoutPreference = nextLayoutPreference(layoutPreference);
    setWindowValue("talos.layout-mode", layoutPreference);
    scheduleLayoutSync("preference");
    say(`Layout mode: ${layoutPreference === "auto" ? "Auto" : layoutModeLabel(layoutPreference)}`);
  });
}

function persistEditorTabs() {
  if (!($("restore-session-on-startup") as HTMLInputElement).checked) return;
  const serialize = (tab: EditorTab): DocumentTabSession => ({
    path: tab.path,
    suggestedName: tab.suggestedName,
    anchor: tab.state.selection.main.anchor,
    head: tab.state.selection.main.head,
    scrollTop: tab === activeTab ? view.scrollDOM.scrollTop : tab.scrollTop,
    ...(tab.dirty ? { contents: tab.state.doc.toString() } : {}),
  });
  try {
    setWindowValue(
      "talos.editor-session",
      JSON.stringify({
        version: 1,
        documents: editorTabs.map(serialize),
        activeIndex: Math.max(0, editorTabs.indexOf(activeTab!)),
        closedTabs: recentlyClosedTabs.map(serialize),
      }),
    );
  } catch (error) {
    say(`Could not persist editor session: ${String(error)}`);
  }
}

function scheduleEditorSessionSave() {
  if (tabSessionTimer) window.clearTimeout(tabSessionTimer);
  tabSessionTimer = window.setTimeout(() => {
    tabSessionTimer = 0;
    // Serializing every dirty document and writing it to localStorage can
    // stall the main thread. Wait for an idle slot so typing stays responsive.
    whenIdle(persistEditorTabs, 1500);
  }, 800);
}

function renderDocumentTabs() {
  const strip = $("document-tabs");
  strip.textContent = "";
  for (const [index, tab] of editorTabs.entries()) {
    const button = document.createElement("div");
    button.className = `document-tab${tab === activeTab ? " active" : ""}`;
    button.dataset.tabId = String(tab.id);
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(tab === activeTab));
    button.tabIndex = tab === activeTab ? 0 : -1;
    button.title = tab.path ?? tab.suggestedName ?? "Untitled";
    const name = document.createElement("span");
    name.className = "document-tab-name";
    name.textContent = fileNameFromPath(tab.path ?? tab.suggestedName ?? "Untitled");
    button.appendChild(name);
    if (tab.dirty) {
      const marker = document.createElement("span");
      marker.className = "document-tab-dirty";
      marker.setAttribute("aria-label", "Modified");
      marker.textContent = "●";
      button.appendChild(marker);
    }
    const close = document.createElement("button");
    close.className = "document-tab-close";
    close.type = "button";
    close.setAttribute("aria-label", `Close ${name.textContent}`);
    close.textContent = "×";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      void guard(() => closeEditorTab(tab));
    });
    button.appendChild(close);
    button.addEventListener("click", () => activateEditorTab(tab));
    button.addEventListener("auxclick", (event) => {
      if (event.button === 1) {
        event.preventDefault();
        void guard(() => closeEditorTab(tab));
      }
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      showTabContextMenu(tab, event.clientX, event.clientY);
    });
    button.addEventListener("keydown", (event) => {
      if (event.key === "Delete" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void guard(() => closeEditorTab(tab));
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        activateEditorTab(editorTabs[nextDocumentIndex(index, editorTabs.length, event.key === "ArrowRight" ? 1 : -1)]);
      }
    });
    strip.appendChild(button);
  }
}

// Update just the active tab's dirty dot instead of rebuilding the whole
// strip (and all its listeners) on every keystroke.
function syncActiveTabDirty() {
  if (!activeTab) return;
  const button = $("document-tabs").querySelector<HTMLElement>(
    `.document-tab[data-tab-id="${activeTab.id}"]`,
  );
  if (!button) {
    renderDocumentTabs();
    return;
  }
  const marker = button.querySelector<HTMLElement>(".document-tab-dirty");
  if (activeTab.dirty && !marker) {
    const dot = document.createElement("span");
    dot.className = "document-tab-dirty";
    dot.setAttribute("aria-label", "Modified");
    dot.textContent = "●";
    button.insertBefore(dot, button.querySelector(".document-tab-close"));
  } else if (!activeTab.dirty && marker) {
    marker.remove();
  }
}

function showTabContextMenu(tab: EditorTab, x: number, y: number) {
  document.querySelector(".document-tab-context")?.remove();
  const menu = document.createElement("div");
  menu.className = "document-tab-context";
  menu.setAttribute("role", "menu");
  menu.style.left = `${Math.min(x, window.innerWidth - 180)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 80)}px`;
  const closeItem = document.createElement("button");
  closeItem.type = "button";
  closeItem.setAttribute("role", "menuitem");
  closeItem.textContent = "Close Tab";
  closeItem.addEventListener("click", () => {
    menu.remove();
    void guard(() => closeEditorTab(tab));
  });
  const reopenItem = document.createElement("button");
  reopenItem.type = "button";
  reopenItem.setAttribute("role", "menuitem");
  reopenItem.textContent = "Reopen Closed Tab";
  reopenItem.disabled = recentlyClosedTabs.length === 0;
  reopenItem.addEventListener("click", () => {
    menu.remove();
    reopenEditorTab();
  });
  menu.append(closeItem, reopenItem);
  document.body.appendChild(menu);
  const dismiss = (event: MouseEvent) => {
    if (!menu.contains(event.target as Node)) {
      menu.remove();
      document.removeEventListener("pointerdown", dismiss);
    }
  };
  window.setTimeout(() => document.addEventListener("pointerdown", dismiss), 0);
}

function activateEditorTab(tab: EditorTab | undefined) {
  if (!tab || tab === activeTab) {
    view.focus();
    return;
  }
  if (activeTab) {
    activeTab.state = view.state;
    activeTab.scrollTop = view.scrollDOM.scrollTop;
  }
  activeTab = tab;
  currentPath = tab.path;
  suggestedName = tab.suggestedName ?? undefined;
  diskRevision = tab.revision;
  dirty = tab.dirty;
  savedDoc = tab.savedDoc;
  currentLanguageName = tab.languageName;
  setDiagnosticsLanguage(currentLanguageName);
  view.setState(tab.state);
  view.scrollDOM.scrollTop = tab.scrollTop;
  problemRows = tab.problemRows;
  if (!$("panel").classList.contains("hidden") && !$("problems").classList.contains("hidden")) {
    renderProblems();
  }
  syncHistoryButtons(view.state);
  refreshTitle();
  renderDocumentTabs();
  if (tab.path) setWindowValue("talos.open-file", tab.path);
  // Linting can parse the whole document; let the tab finish painting first.
  whenIdle(() => {
    if (activeTab === tab) forceLinting(view);
  }, 350);
  scheduleOutline();
  scheduleHtmlPreviewRefresh();
  scheduleEditorSessionSave();
  view.focus();
}

function showNewUntitledTab(name: string | null = null, contents = "") {
  const state = createEditorState(contents, view.state);
  const tab: EditorTab = {
    id: nextTabId++,
    path: null,
    suggestedName: name,
    anchor: 0,
    head: 0,
    scrollTop: 0,
    state,
    savedDoc: null,
    revision: null,
    dirty: contents.length > 0,
    languageName: "",
    problemRows: [],
  };
  tabRegistry.open(tab);
  activateEditorTab(tab);
  void setLanguage(name ?? "");
  renderDocumentTabs();
}

async function openSnapshotInTab(path: string, snapshot: { contents: string; revision: string; binary: boolean }) {
  const state = createEditorState(snapshot.contents, view.state);
  const tab: EditorTab = {
    id: nextTabId++,
    path,
    suggestedName: null,
    anchor: 0,
    head: 0,
    scrollTop: 0,
    state,
    savedDoc: state.doc,
    revision: snapshot.revision,
    dirty: false,
    languageName: "",
    problemRows: [],
  };
  const opened = tabRegistry.open(tab);
  if (!opened.created) {
    activateEditorTab(opened.tab);
    return;
  }
  activateEditorTab(tab);
  setWindowValue("talos.open-file", path);
  try {
    await setLanguage(path);
  } catch (error) {
    // The file itself is already open; a missing optional language package
    // must never turn into a failed open.
    say(`Opened ${fileNameFromPath(path)} as plain text: ${String(error)}`);
  }
  renderDocumentTabs();
}

async function closeEditorTab(tab: EditorTab) {
  if (tab.dirty) {
    activateEditorTab(tab);
    const choice = await askUnsavedChanges(`Save changes to ${fileNameFromPath(tab.path ?? tab.suggestedName ?? "Untitled")} before closing?`);
    if (choice === "cancel") return;
    if (choice === "save") {
      await saveFile();
      if (tab.dirty) return;
    }
  }
  if (tab === activeTab) {
    tab.state = view.state;
    tab.scrollTop = view.scrollDOM.scrollTop;
  }
  const closingIndex = editorTabs.indexOf(tab);
  if (closingIndex < 0) return;
  tabRegistry.close(tab);
  if (tab === activeTab) {
    activeTab = null;
    if (!editorTabs.length) {
      showNewUntitledTab();
      return;
    }
    activateEditorTab(editorTabs[Math.min(closingIndex, editorTabs.length - 1)]);
  } else {
    renderDocumentTabs();
  }
  scheduleEditorSessionSave();
}

function reopenEditorTab() {
  const tab = tabRegistry.reopen();
  if (!tab) return;
  activateEditorTab(tab);
}

function switchEditorTab(direction: -1 | 1) {
  const current = editorTabs.indexOf(activeTab!);
  activateEditorTab(editorTabs[nextDocumentIndex(current, editorTabs.length, direction)]);
}

// ---------- Files ----------
async function setLanguage(fileName: string) {
  const target = activeTab;
  if (!target) return;
  const desc = LanguageDescription.matchFilename(languages, fileNameFromPath(fileName));
  const support = desc ? await desc.load() : [];
  target.state = target.state.update({
    effects: langCompartment.reconfigure(support),
  }).state;
  target.languageName = desc ? desc.name : "";
  if (target === activeTab) {
    view.setState(target.state);
    currentLanguageName = target.languageName;
    setDiagnosticsLanguage(currentLanguageName);
    $("lang").textContent = desc ? desc.name : "Plain text";
    whenIdle(() => {
      if (activeTab === target) forceLinting(view);
    }, 350);
    scheduleOutline();
  }
}

async function loadPath(path: string) {
  // If the PDF is using the whole area, step aside instead of closing it —
  // that keeps code, terminal/Ollama and the PDF usable at the same time.
  if (isPdfFocused()) ($("pdf-focus") as HTMLButtonElement).click();
  const existingIndex = findDocumentIndex(editorTabs, path);
  if (existingIndex >= 0) {
    activateEditorTab(editorTabs[existingIndex]);
    await checkExternalFileRevision();
    return;
  }
  const snapshot = await readFileSnapshot(path);
  if (!snapshot) throw new Error(`The file no longer exists: ${path}`);
  if (snapshot.binary) {
    await openBinaryUi(path);
    return;
  }
  await openSnapshotInTab(path, snapshot);
}

async function openAny(path: string) {
  rememberRecent(path);
  const name = fileNameFromPath(path).toLowerCase();
  if (name.endsWith(".pdf")) {
    closeHtmlPreview();
    toggleOutline(false);
    await openPdf(path);
    return;
  }
  if (isImagePath(name)) {
    await openCanvasUi(path);
    return;
  }
  await loadPath(path);
}

async function openFile() {
  const picked = await open({ multiple: false, directory: false });
  if (typeof picked !== "string") return;
  await openAny(picked);
}

async function openPdfDialog() {
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (typeof picked !== "string") return;
  closeHtmlPreview();
  toggleOutline(false);
  await openPdf(picked);
}

async function openBinaryDialog() {
  const picked = await open({
    multiple: false,
    directory: false,
    title: "Open binary file (read-only preview)",
  });
  if (typeof picked !== "string") return;
  rememberRecent(picked);
  await openBinaryUi(picked);
}

async function askFileConflict(path: string): Promise<"reload" | "overwrite" | "cancel"> {
  const dialog = $("file-conflict-dialog") as HTMLDialogElement;
  $("file-conflict-path").textContent = path;
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => {
        const choice = dialog.returnValue;
        resolve(choice === "reload" || choice === "overwrite" ? choice : "cancel");
      },
      { once: true },
    );
  });
}

async function askUnsavedChanges(message: string): Promise<"save" | "discard" | "cancel"> {
  $("close-confirm-message").textContent = message;
  const dialog = $("close-confirm-dialog") as HTMLDialogElement;
  if (dialog.open) {
    // Reuse a stale dialog safely: let its pending close event settle first so
    // it cannot resolve this call with the previous return value.
    const settled = new Promise<void>((resolve) => {
      dialog.addEventListener("close", () => resolve(), { once: true });
    });
    dialog.close("cancel");
    await settled;
  }
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => {
        const choice = dialog.returnValue;
        resolve(choice === "save" || choice === "discard" ? choice : "cancel");
      },
      { once: true },
    );
  });
}

async function saveFile(forceDialog = false) {
  let path = currentPath;
  const readOnlyAppImageFile = !!path && isReadOnlyAppImagePath(path);
  if (!path || forceDialog || readOnlyAppImageFile) {
    if (readOnlyAppImageFile && !forceDialog) {
      say("This file is bundled read-only inside the AppImage. Choose a writable location to save a copy.");
    }
    const defaultPath = path && (android || readOnlyAppImageFile)
      ? fileNameFromPath(path)
      : path ?? suggestedName;
    const chosen = await save({ defaultPath });
    if (!chosen) return;
    path = chosen;
  }
  if (path !== currentPath && findDocumentIndex(editorTabs, path) >= 0) {
    throw new Error("That file is already open in another tab. Activate its tab before saving to it.");
  }
  const documentAtSave = view.state.doc;
  let expectedRevision =
    path === currentPath
      ? diskRevision
      : (await isAndroid() ? null : (await readFileSnapshot(path))?.revision ?? null);

  while (true) {
    const result: CheckedWriteResult = await writeText(
      path,
      documentAtSave.toString(),
      expectedRevision,
    );
    if (result.status === "saved") {
      currentPath = path;
      if (activeTab) {
        activeTab.path = path;
        activeTab.suggestedName = null;
        activeTab.revision = result.revision;
      }
      diskRevision = result.revision;
      setWindowValue("talos.open-file", path);
      savedDoc = documentAtSave;
      dirty = !savedDoc.eq(view.state.doc);
      if (activeTab) {
        activeTab.savedDoc = savedDoc;
        activeTab.dirty = dirty;
        activeTab.state = view.state;
      }
      refreshTitle();
      renderDocumentTabs();
      scheduleEditorSessionSave();
      await setLanguage(path);
      return;
    }

    const choice = await askFileConflict(path);
    if (choice === "cancel") return;
    if (choice === "reload") {
      if (!result.snapshot) {
        say(`The file was deleted outside Talos: ${path}`);
        return;
      }
      if (result.snapshot.binary) {
        say(`Cannot reload ${fileNameFromPath(path)}: the file now contains binary data.`);
        return;
      }
      replaceDocument(result.snapshot.contents, true);
      currentPath = path;
      if (activeTab) {
        activeTab.path = path;
        activeTab.suggestedName = null;
        activeTab.revision = result.snapshot.revision;
      }
      diskRevision = result.snapshot.revision;
      if (activeTab) activeTab.revision = diskRevision;
      setWindowValue("talos.open-file", path);
      refreshTitle();
      await setLanguage(path);
      say("Reloaded the newer file from disk.");
      return;
    }
    expectedRevision = result.snapshot?.revision ?? null;
  }
}

// ---------- Run + Output ----------
interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  language: string;
}

type RunEvent =
  | { type: "start"; id: string; language: string }
  | { type: "output"; id: string; stream: string; text: string }
  | { type: "end"; id: string; code: number }
  | { type: "error"; id: string; message: string };

type RunUnlisten = () => void;

let activeRunId: string | null = null;
let activeRunStartedAt = 0;
let activeRunLanguage = "Program";
let activeRunUnlisten: RunUnlisten | null = null;

function appendOut(text: string, cls = "") {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  $("output").appendChild(s);
  $("output").scrollTop = $("output").scrollHeight;
}

function setRunInputVisible(visible: boolean) {
  $("output-input-bar").classList.toggle("hidden", !visible);
  ($("run-input") as HTMLInputElement).disabled = !visible;
}

function clearActiveRunListener() {
  if (!activeRunUnlisten) return;
  const unlisten = activeRunUnlisten;
  activeRunUnlisten = null;
  unlisten();
}

function handleRunEvent(event: RunEvent) {
  if (!activeRunId || event.id !== activeRunId) return;
  if (event.type === "start") {
    activeRunLanguage = event.language;
    return;
  }
  if (event.type === "output") {
    appendOut(event.text, event.stream === "stderr" ? "err" : "");
    return;
  }
  if (event.type === "error") {
    appendOut(`${event.message}\n`, "err");
    return;
  }
  const ms = Math.round(performance.now() - activeRunStartedAt);
  appendOut(
    `\n— ${activeRunLanguage} finished with exit code ${event.code} in ${ms} ms\n`,
    event.code === 0 ? "ok" : "err"
  );
  activeRunId = null;
  setRunInputVisible(false);
  clearActiveRunListener();
}

function sendRunInput() {
  const input = $("run-input") as HTMLInputElement;
  const text = input.value;
  if (!text) return;
  input.value = "";
  const id = activeRunId;
  if (!id) {
    appendOut("No program is waiting for input.\n", "err");
    return;
  }
  appendOut(`${text}\n`, "dim");
  void invoke("run_write_stdin", { id, text: `${text}\n` }).catch((e: unknown) => {
    appendOut(`Could not send input: ${String(e)}\n`, "err");
  });
}

async function runFile() {
  if (sourceControlBusy) return;
  const selectedLanguage = ($("run-language") as HTMLSelectElement).value;
  const fileName = fileNameFromPath(currentPath ?? suggestedName ?? "");
  const extension = fileName.split(".").pop()?.toLowerCase();
  if (extension === "html" || extension === "htm") {
    showPanel(true);
    showTab("output");
    $("output").textContent = "";
    appendOut("Previewing HTML in Talos. Inline CSS and JavaScript are supported.\n", "dim");
    previewHtml();
    return;
  }
  if (extension === "css") {
    showPanel(true);
    showTab("output");
    $("output").textContent = "";
    appendOut("CSS cannot run by itself. Add it to an HTML file's <style> block and tap Preview.\n", "err");
    return;
  }
  const dataExtensions = ["json", "jsonc", "xml", "yaml", "yml", "toml", "ini", "md", "txt", "log", "csv"];
  if (dataExtensions.includes(extension ?? "") && (selectedLanguage === "auto" || !selectedLanguage)) {
    showPanel(true);
    showTab("output");
    $("output").textContent = "";
    appendOut(
      `${(extension ?? "This").toUpperCase()} is a data file, not runnable source. Open a .py, .js, .c, .cpp, or .java file, or choose a run language.\n`,
      "err"
    );
    return;
  }
  const inferredLanguage =
    extension === "py" ? "python" :
    extension === "js" || extension === "mjs" ? "javascript" :
    extension === "c" ? "c" :
    extension === "cpp" || extension === "cc" || extension === "cxx" ? "cpp" :
    extension === "java" ? "java" :
    null;
  const language =
    selectedLanguage === "auto"
      ? inferredLanguage ?? (fileName ? null : "python")
      : selectedLanguage;

  showPanel(true);
  showTab("output");
  $("output").textContent = "";
  const t0 = performance.now();

  if (android) {
    if (!language) {
      appendOut("Choose a run language, or use a file with a .py, .js, .c, .cpp, or .java extension. Use Preview for HTML.\n", "err");
      return;
    }
    appendOut("Running locally with Termux...\n", "dim");
    try {
      const result = await invoke<RunResult>("plugin:runner|run_android_code", {
        language,
        source: view.state.doc.toString(),
      });
      if (result.stdout) appendOut(result.stdout);
      if (result.stderr) appendOut(result.stderr, "err");
      const ms = Math.round(performance.now() - t0);
      appendOut(
        "\n— " + result.language + " finished with exit code " + result.code + " in " + ms + " ms\n",
        result.code === 0 ? "ok" : "err"
      );
    } catch (e) {
      appendOut("Run failed: " + String(e) + "\n", "err");
    }
    return;
  }
  clearActiveRunListener();
  activeRunId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  activeRunStartedAt = performance.now();
  activeRunLanguage = language ?? "Program";
  activeRunUnlisten = await listen<RunEvent>("talos://run-event", (event) => {
    handleRunEvent(event.payload);
  });
  setRunInputVisible(true);
  try {
    if (currentPath) {
      if (dirty) await saveFile();
      appendOut("Running " + currentPath + " ...\n", "dim");
      await invoke("run_file_interactive", { id: activeRunId, path: currentPath });
    } else {
      appendOut("Running the current editor contents...\n", "dim");
      await invoke("run_source_interactive", {
        id: activeRunId,
        source: view.state.doc.toString(),
        languageId: language,
        fileName: suggestedName ?? null,
      });
    }
    ($("run-input") as HTMLInputElement).focus();
  } catch (e) {
    appendOut("Run failed: " + String(e) + "\n", "err");
    activeRunId = null;
    setRunInputVisible(false);
    clearActiveRunListener();
  }
}

async function guard(fn: () => Promise<void>) {
  try {
    say("");
    await fn();
  } catch (e) {
    say(String(e));
  }
}

async function openNewWindow(initialPath: string | null = null, workspacePath: string | null = null) {
  if (await isAndroid()) throw new Error("Additional windows are available in Talos Crest desktop.");
  await invoke<string>("create_window", { initialPath, workspacePath });
}

async function openFolderInNewWindow() {
  const picked = await open({ multiple: false, directory: true });
  if (typeof picked === "string") await openNewWindow(null, picked);
}

async function openFileInNewWindow() {
  const picked = await open({ multiple: false, directory: false });
  if (typeof picked === "string") await openNewWindow(picked);
}

async function openCurrentWorkspaceInNewWindow() {
  const workspace = getWindowValue("talos.workspace-root");
  if (workspace) {
    await openNewWindow(null, workspace);
    return;
  }
  await openFolderInNewWindow();
}

async function showWindowSwitcher() {
  const dialog = $("window-dialog") as HTMLDialogElement;
  const list = $("window-list");
  list.textContent = "";
  const windows = await getAllWebviewWindows();
  for (const nativeWindow of windows) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "workspace-result";
    const title = await nativeWindow.title().catch(() => nativeWindow.label);
    const name = document.createElement("span");
    name.className = "workspace-result-name";
    name.textContent = title;
    const label = document.createElement("span");
    label.className = "workspace-result-path";
    label.textContent = nativeWindow.label;
    button.append(name, label);
    button.addEventListener("click", () => {
      dialog.close();
      void nativeWindow.setFocus().catch((error: unknown) => say(`Could not focus window: ${String(error)}`));
    });
    list.appendChild(button);
  }
  if (!windows.length) {
    const status = document.createElement("div");
    status.className = "workspace-dialog-status";
    status.textContent = "No Talos windows are open.";
    list.appendChild(status);
  }
  if (!dialog.open) dialog.showModal();
}

async function checkExternalFileRevision(tab: EditorTab | null = activeTab) {
  if (!tab?.path || android || !tab.revision) return;
  const snapshot = await readFileSnapshot(tab.path);
  if (snapshot?.revision !== tab.revision) {
    say(snapshot
      ? `${tab.path} changed outside this editor. Saving will ask before replacing newer contents.`
      : `${tab.path} was removed outside this editor.`);
  }
}

// A close request must always finish. Cleanup is best-effort, the in-progress
// flag is always released, and a watchdog can terminate the process if the
// webview itself refuses to go away.
const CLOSE_WATCHDOG_MS = 3000;
let closeInProgress = false;

function emergencyExit(): void {
  void invoke("force_quit").catch(() => {
    // No renderer-side recovery is left if the backend cannot be reached.
  });
}

async function destroyCurrentWindow(): Promise<void> {
  const watchdog = window.setTimeout(emergencyExit, CLOSE_WATCHDOG_MS);
  try {
    await getCurrentWindow().destroy();
  } catch (error) {
    emergencyExit();
    throw error;
  } finally {
    window.clearTimeout(watchdog);
  }
}

async function finishWindowClose(discardUnsaved = false) {
  if (discardUnsaved) {
    for (const tab of editorTabs) {
      if (tab.dirty) {
        tab.dirty = false;
        tab.savedDoc = tab.state.doc;
      }
    }
  }
  try {
    persistEditorTabs();
  } catch (error) {
    say(`Could not save the editor session: ${String(error)}`);
  }
  try {
    await invoke("stop_project_watch");
  } catch (error) {
    say(`Could not stop the project watcher: ${String(error)}`);
  }
  await destroyCurrentWindow();
}

async function handleWindowCloseRequest(event: { preventDefault: () => void }) {
  event.preventDefault();
  if (closeInProgress) return;
  closeInProgress = true;

  try {
    if (!editorTabs.some((tab) => tab.dirty)) {
      await finishWindowClose();
      return;
    }

    const dirtyCount = editorTabs.filter((tab) => tab.dirty).length;
    let choice: "save" | "discard" | "cancel" = "cancel";
    try {
      choice = await askUnsavedChanges(
        `Save changes in ${dirtyCount} open document${dirtyCount === 1 ? "" : "s"} before closing this window?`,
      );
    } catch (error) {
      // A broken modal must never trap the window. Nothing is silently
      // discarded: the message tells the user what happened.
      say(`Could not show the save dialog; closing without saving: ${String(error)}`);
      choice = "discard";
    }
    if (choice === "cancel") return;
    if (choice === "discard") {
      await finishWindowClose(true);
      return;
    }

    const activeId = activeTab?.id;
    try {
      for (const tab of [...editorTabs]) {
        if (!tab.dirty) continue;
        activateEditorTab(tab);
        await saveFile();
        if (tab.dirty) {
          say(`Could not save ${fileNameFromPath(tab.path ?? tab.suggestedName ?? "Untitled")}. Close cancelled; no changes were discarded.`);
          return;
        }
      }
    } finally {
      if (activeId !== undefined) {
        const previous = editorTabs.find((item) => item.id === activeId);
        if (previous) activateEditorTab(previous);
      }
    }
    await finishWindowClose();
  } catch (error) {
    say(`Could not close the window cleanly: ${String(error)}`);
    await destroyCurrentWindow().catch(() => emergencyExit());
  } finally {
    // Release the guard on every path, including errors. A later close request
    // is therefore never ignored because an earlier one failed.
    closeInProgress = false;
  }
}

// ---------- Editor ----------
// Snippet packs are installed from the extension market. They are offered on
// demand with Ctrl+Space so typing never pays for completion queries.
function snippetCompletionSource(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/[\w!#$@-]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  const candidates = new Set<string>();
  if (currentLanguageName) candidates.add(currentLanguageName.trim().toLowerCase());
  const filename = currentPath ?? suggestedName ?? "";
  const dot = filename.lastIndexOf(".");
  if (dot >= 0 && dot < filename.length - 1) {
    candidates.add(filename.slice(dot + 1).toLowerCase());
  }
  const options = installedSnippets()
    .filter((snippet) =>
      !snippet.languages?.length ||
      snippet.languages.some((language) => candidates.has(language.trim().toLowerCase()))
    )
    .map((snippet) =>
      snippetCompletion(snippet.body, {
        label: snippet.label?.trim() || snippet.prefix,
        detail: snippet.description?.trim() || undefined,
        type: "snippet",
      })
    );
  if (!options.length) return null;
  return { from: word.from, options, validFor: /^[\w!#$@-]*$/ };
}

// A trimmed copy of CodeMirror's basicSetup with typing-oriented tuning.
// Language packages ship completion sources that otherwise run a query for
// every word typed; completion stays available on demand with Ctrl+Space.
const editorSetup = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  foldGutter(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  closeBrackets(),
  autocompletion({
    activateOnTyping: false,
    override: [snippetCompletionSource],
    maxRenderedOptions: 50,
  }),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  // WebKit's spellchecker/autocorrect add input latency and are not useful for
  // source code, so keep the platform from attaching them to the editor.
  EditorView.contentAttributes.of({
    spellcheck: "false",
    autocorrect: "off",
    autocapitalize: "off",
    translate: "no",
  }),
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...foldKeymap,
    ...completionKeymap,
    ...lintKeymap,
  ]),
];

function createEditorState(doc: string, previous?: EditorState): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      Prec.highest(keymap.of(editorShortcutBindings())),
      editorSetup,
      themeCompartment.of(previous ? themeCompartment.get(previous) ?? oneDark : oneDark),
      wrapCompartment.of(wordWrap ? EditorView.lineWrapping : []),
      lintGutter(),
      basicLinter(onDiagnostics),
      langCompartment.of(previous ? langCompartment.get(previous) ?? [] : []),
      EditorView.updateListener.of((u) => {
        if (activeTab) activeTab.state = u.state;
        if (u.docChanged) {
          // Only touch the title and tab strip when the dirty flag actually
          // changes. Rebuilding them on every keystroke adds input latency.
          const nextDirty = documentIsDirty(u.state.doc);
          if (nextDirty !== dirty) {
            dirty = nextDirty;
            if (activeTab) activeTab.dirty = dirty;
            refreshTitle();
            syncActiveTabDirty();
          }
          scheduleOutline();
          scheduleHtmlPreviewRefresh();
        }
        if (u.docChanged || u.selectionSet) {
          scheduleEditorSessionSave();
          scheduleEditorChrome();
        }
        if (searchPanelOpen(u.state)) {
          const query = getSearchQuery(u.state);
          const key = `${query.search}\0${query.caseSensitive}\0${query.wholeWord}\0${query.regexp}`;
          if (u.docChanged || key !== searchCountKey) scheduleSearchCount();
          searchCountKey = key;
        } else {
          searchCountKey = "";
        }
      }),
    ],
  });
}

let undoDisabled: boolean | null = null;
let redoDisabled: boolean | null = null;

function syncHistoryButtons(state: EditorState) {
  const nextUndo = undoDepth(state) === 0;
  if (nextUndo !== undoDisabled) {
    undoDisabled = nextUndo;
    ($("btn-undo") as HTMLButtonElement).disabled = nextUndo;
  }
  const nextRedo = redoDepth(state) === 0;
  if (nextRedo !== redoDisabled) {
    redoDisabled = nextRedo;
    ($("btn-redo") as HTMLButtonElement).disabled = nextRedo;
  }
}

// Cursor position and undo/redo buttons only need to be correct once per
// frame. Coalescing them keeps fast typing from doing layout work per key.
let chromeFrame = 0;
let chromePosition = "";

function scheduleEditorChrome() {
  if (chromeFrame) return;
  chromeFrame = window.requestAnimationFrame(() => {
    chromeFrame = 0;
    const state = view.state;
    const pos = state.selection.main.head;
    const line = state.doc.lineAt(pos);
    const text = "Ln " + line.number + ", Col " + (pos - line.from + 1);
    if (text !== chromePosition) {
      chromePosition = text;
      $("pos").textContent = text;
    }
    syncHistoryButtons(state);
  });
}

function replaceDocument(doc: string, saved: boolean) {
  const state = createEditorState(doc, view.state);
  savedDoc = saved ? state.doc : null;
  dirty = !saved;
  if (activeTab) {
    activeTab.state = state;
    activeTab.savedDoc = savedDoc;
    activeTab.dirty = dirty;
    activeTab.revision = saved ? diskRevision : null;
  }
  view.setState(state);
  syncHistoryButtons(view.state);
  renderDocumentTabs();
  scheduleEditorSessionSave();
}

registerShortcuts(SHORTCUTS);

view = new EditorView({
  state: createEditorState(
    "Welcome to Talos\n\nOpen a file with Ctrl+O, save with Ctrl+S, run with F5.\n"
  ),
  parent: $("editor"),
});
savedDoc = view.state.doc;
activeTab = {
  id: nextTabId++,
  path: null,
  suggestedName: null,
  anchor: 0,
  head: 0,
  scrollTop: 0,
  state: view.state,
  savedDoc,
  revision: null,
  dirty: false,
  languageName: "",
  problemRows: [],
};
tabRegistry.open(activeTab);
renderDocumentTabs();
view.scrollDOM.addEventListener("scroll", () => {
  if (activeTab) activeTab.scrollTop = view.scrollDOM.scrollTop;
  scheduleEditorSessionSave();
}, { passive: true });
syncHistoryButtons(view.state);

// ---------- Buttons ----------
$("btn-open").addEventListener("click", () => void guard(openFile));
$("btn-new-window").addEventListener("click", () => void guard(() => openNewWindow()));
$("btn-open-folder-new").addEventListener("click", () => void guard(openFolderInNewWindow));
$("btn-open-file-new").addEventListener("click", () => void guard(openFileInNewWindow));
$("btn-workspace-new").addEventListener("click", () => void guard(openCurrentWorkspaceInNewWindow));
$("btn-window-switcher").addEventListener("click", () => void guard(showWindowSwitcher));
($("restore-session-on-startup") as HTMLInputElement).checked =
  localStorage.getItem("talos.restore-session") === "true" ||
  localStorage.getItem("talos.restore-last-file") === "true";
$("restore-session-on-startup").addEventListener("change", (event) => {
  const enabled = (event.currentTarget as HTMLInputElement).checked;
  localStorage.setItem("talos.restore-session", String(enabled));
  if (enabled) scheduleEditorSessionSave();
  else removeWindowValue("talos.editor-session");
});
$("window-dialog-close").addEventListener("click", () =>
  ($("window-dialog") as HTMLDialogElement).close(),
);
$("close-save").addEventListener("click", () =>
  ($("close-confirm-dialog") as HTMLDialogElement).close("save"),
);
$("close-discard").addEventListener("click", () =>
  ($("close-confirm-dialog") as HTMLDialogElement).close("discard"),
);
$("close-cancel").addEventListener("click", () =>
  ($("close-confirm-dialog") as HTMLDialogElement).close("cancel"),
);
$("file-conflict-cancel").addEventListener("click", () =>
  ($("file-conflict-dialog") as HTMLDialogElement).close("cancel"),
);
$("file-conflict-reload").addEventListener("click", () =>
  ($("file-conflict-dialog") as HTMLDialogElement).close("reload"),
);
$("file-conflict-overwrite").addEventListener("click", () =>
  ($("file-conflict-dialog") as HTMLDialogElement).close("overwrite"),
);
$("btn-pdf").addEventListener("click", () => void guard(openPdfDialog));
$("btn-calc").addEventListener("click", () => void guard(() => openCalcUi(currentSelection())));
$("calc-dialog").addEventListener("close", () => {
  setActiveNav("explorer");
  view.focus();
});
$("chronicle-dialog").addEventListener("close", () => {
  setActiveNav("explorer");
  view.focus();
});
$("quick-open-dialog").addEventListener("close", () => setActiveNav("explorer"));
document.addEventListener("talos:explorer-close", () => {
  setActiveNav("explorer");
  view.focus();
});
$("btn-canvas").addEventListener("click", () => void guard(() => openCanvasUi()));
document.addEventListener("talos:canvas-close", () => {
  setActiveNav("explorer");
  view.focus();
});
$("btn-outline").addEventListener("click", () => toggleOutline());
$("outline-close").addEventListener("click", () => toggleOutline(false));
$("outline-refresh").addEventListener("click", renderOutline);
$("outline-search").addEventListener("input", scheduleOutlineFilter);
$("goto-line-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("goto-line-input") as HTMLInputElement;
  const line = parseLineNumber(input.value, view.state.doc.lines);
  if (line === null) {
    $("goto-line-status").textContent = `Enter a line from 1 to ${view.state.doc.lines}.`;
    input.focus();
    return;
  }
  const position = view.state.doc.line(line).from;
  view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
  ($("goto-line-dialog") as HTMLDialogElement).close();
  view.focus();
});
for (const dialogId of ["goto-line-dialog", "symbol-dialog"]) {
  $(dialogId).addEventListener("close", () => view.focus());
}
$("symbol-search").addEventListener("input", () => {
  symbolPickerIndex = 0;
  scheduleSymbolFilter();
});
$("symbol-search").addEventListener("keydown", (event) => {
  if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
  flushSymbolFilter();
  const rows = [...$("symbol-results").querySelectorAll<HTMLButtonElement>(".workspace-result")];
  if (event.key === "Enter") {
    event.preventDefault();
    rows[symbolPickerIndex]?.click();
    return;
  }
  if (!rows.length) return;
  event.preventDefault();
  symbolPickerIndex =
    (symbolPickerIndex + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
  rows.forEach((row, index) => {
    row.classList.toggle("active", index === symbolPickerIndex);
    row.setAttribute("aria-selected", String(index === symbolPickerIndex));
  });
  rows[symbolPickerIndex].scrollIntoView({ block: "nearest" });
});
$("symbol-dialog-close").addEventListener("click", () =>
  ($("symbol-dialog") as HTMLDialogElement).close(),
);
$("btn-undo").addEventListener("click", () => {
  undo(view);
  view.focus();
});
$("btn-redo").addEventListener("click", () => {
  redo(view);
  view.focus();
});
$("btn-save").addEventListener("click", () => void guard(() => saveFile()));
$("btn-saveas").addEventListener("click", () => void guard(() => saveFile(true)));
$("btn-run").addEventListener("click", () => void guard(runFile));
$("btn-run-send").addEventListener("click", sendRunInput);
$("run-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    sendRunInput();
  }
});
$("btn-preview").addEventListener("click", previewHtml);
$("btn-preview-close").addEventListener("click", closeHtmlPreview);
$("btn-panel").addEventListener("click", togglePanel);
$("btn-panel-close").addEventListener("click", () => showPanel(false));
$("btn-panel-max").addEventListener("click", () =>
  setPanelMaximized(!$("editor-region").classList.contains("panel-maximized"))
);
$("problems-severity").addEventListener("change", () => renderProblems());
$("btn-error-rules").addEventListener("click", openErrorRulesDialog);
document.addEventListener("talos:error-rules-changed", () => {
  if (activeTab) forceLinting(view);
});
$("theme-select").addEventListener("change", () => {
  const id = ($("theme-select") as HTMLSelectElement).value as BuiltinThemeId;
  void clearExtensionThemePreference()
    .then(() => applyBuiltinTheme(id))
    .catch((e: unknown) => say("Could not save theme preference: " + String(e)));
});
$("editor-font").addEventListener("change", () => {
  const font = ($("editor-font") as HTMLSelectElement).value;
  applyEditorFont(font);
  localStorage.setItem("talos.editor-font", font);
});
$("ui-scale").addEventListener("change", () => {
  applyUiScale(Number(($("ui-scale") as HTMLSelectElement).value));
});
installGlobalShortcuts();
initShortcutsUi();
initSourceControl();
$("btn-shortcuts").addEventListener("click", openShortcutsDialog);
void getCurrentWindow()
  .onCloseRequested(async (event) => {
    await handleWindowCloseRequest(event);
  })
  .catch((error: unknown) => say(`Could not guard window close: ${String(error)}`));
document.addEventListener("talos:side-pane-change", (event) => {
  const id = (event as CustomEvent<string | null>).detail;
  if (id) $("main").dataset.activeSidePane = id;
  syncSidePane();
  scheduleEditorMeasure();
});
document.addEventListener("talos:source-control-closed", () => setActiveNav("explorer"));
document.addEventListener("talos:pdf-focus-change", () => {
  scheduleLayoutSync("pdf-focus");
  scheduleEditorMeasure();
});
installWorkspaceResizers();
installToolbarOverflow();
initPreviewControls();
applyBuiltinTheme(activeBuiltinTheme, false);
applyEditorFont(localStorage.getItem("talos.editor-font") ?? "default");
applyEditorFontSize(editorFontSize);
applyUiScale(Number(localStorage.getItem("talos.ui-scale")) || 1);
$("btn-fun").textContent = funMode ? "Fun mode: on" : "Fun mode: off";
$("btn-fun").addEventListener("click", () => {
  funMode = !funMode;
  setWindowValue("talos.fun-mode", String(funMode));
  $("btn-fun").textContent = funMode ? "Fun mode: on" : "Fun mode: off";
  if (lastReading) renderMeter(lastReading);
});
for (const b of document.querySelectorAll<HTMLElement>("[data-tab]")) {
  b.addEventListener("click", () => {
    const tab = b.dataset.tab as BottomTab | undefined;
    if (tab && tab in bottomViews) showTab(tab, true);
  });
}
initPdfPane();
initArchitectureExplorer(openAny, (oldPath, newPath) => {
  if (!currentPath) return;
  const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/$/, "");
  const normalizedOld = normalize(oldPath);
  const normalizedCurrent = normalize(currentPath);
  if (normalizedCurrent !== normalizedOld && !normalizedCurrent.startsWith(`${normalizedOld}/`)) return;
  if (newPath) {
    currentPath = newPath + normalizedCurrent.slice(normalizedOld.length);
    if (activeTab) activeTab.path = currentPath;
  } else {
    currentPath = null;
    savedDoc = null;
    dirty = true;
    if (activeTab) {
      activeTab.path = null;
      activeTab.savedDoc = null;
      activeTab.dirty = true;
    }
  }
  refreshTitle();
  renderDocumentTabs();
}, (path) => {
  const normalize = (value: string) => value.replace(/\\/g, "/");
  if (!currentPath || normalize(currentPath) !== normalize(path)) return null;
  return {
    modified: dirty,
    errors: problemRows.filter((row) => row.severity === "error").length,
    warnings: problemRows.filter((row) => row.severity === "warning").length,
  };
});
function updateWorkspaceLabel() {
  const workspace = getWindowValue("talos.workspace-root");
  const label = workspace?.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  $("workspace-name").textContent = label ?? "No workspace";
  $("btn-workspace").title = workspace ? `Workspace: ${workspace}` : "Choose workspace";
}

function setActiveNav(view: string) {
  for (const button of document.querySelectorAll<HTMLElement>("#activity-bar [data-view]")) {
    button.classList.toggle("active", button.dataset.view === view);
  }
}

updateWorkspaceLabel();
document.addEventListener("talos:workspace-change", updateWorkspaceLabel);
document.addEventListener("talos:open-path", (event) => {
  const path = (event as CustomEvent<string>).detail;
  if (typeof path === "string") void guard(() => openAny(path));
});
document.addEventListener("talos:open-error", (event) => {
  const detail = (event as CustomEvent<string>).detail;
  if (typeof detail === "string") say(detail);
});
$("btn-workspace").addEventListener("click", () => void guard(() => chooseWorkspace()));
$("breadcrumb-root").addEventListener("click", () => openObservatory());
$("btn-command-palette").addEventListener("click", () => openCommandPalette());

const activityBar = $("activity-bar");
const activityToggle = $("btn-activity-toggle");
activityBar.classList.toggle("expanded", getWindowValue("talos.activity-bar-expanded") === "true");
activityToggle.title = activityBar.classList.contains("expanded") ? "Collapse navigation" : "Expand navigation";
activityToggle.addEventListener("click", () => {
  const expanded = activityBar.classList.toggle("expanded");
  setWindowValue("talos.activity-bar-expanded", String(expanded));
  activityToggle.title = expanded ? "Collapse navigation" : "Expand navigation";
});

for (const button of document.querySelectorAll<HTMLElement>("#activity-bar [data-view]")) {
  button.addEventListener("click", () => {
    const view = button.dataset.view;
    if (button.getAttribute("aria-disabled") === "true") {
      say("Source Control is not available in this build.");
      return;
    }
    switch (view) {
      case "explorer":
        $("btn-architecture").click();
        setActiveNav(view);
        break;
      case "source-control":
        void guard(openSourceControl);
        setActiveNav(view);
        break;
      case "search":
        openQuickOpen();
        setActiveNav(view);
        break;
      case "run":
        showPanel(true);
        showTab("output");
        $("btn-run").focus();
        setActiveNav(view);
        break;
      case "extensions":
        $("btn-ext").click();
        setActiveNav(view);
        break;
      case "chronicle":
        void guard(() => openChronicleUi());
        setActiveNav(view);
        break;
      case "observatory":
        openObservatory();
        setActiveNav(view);
        break;
      case "canvas":
        void openCanvasUi();
        setActiveNav(view);
        break;
      case "calc":
        void openCalcUi();
        setActiveNav(view);
        break;
    }
  });
}

function restoreSelect(id: string, key: string): void {
  const select = $(id) as HTMLSelectElement;
  const saved = getWindowValue(key);
  const values = new Set(Array.from(select.options, (option) => option.value));
  if (saved && values.has(saved)) select.value = saved;
  select.addEventListener("change", () => setWindowValue(key, select.value));
}

restoreSelect("problems-severity", "talos.problems-severity");
restoreSelect("run-language", "talos.run-language");
if (getWindowValue("talos.panel-visible") === "false") showPanel(false, false);
if (
  getWindowValue("talos.panel-maximized") === "true" &&
  getWindowValue("talos.panel-visible") !== "false"
) {
  setPanelMaximized(true);
}
const savedPanelTab = getWindowValue("talos.bottom-panel-tab");
if (savedPanelTab && savedPanelTab in bottomViews) showTab(savedPanelTab as BottomTab);
if (getWindowValue("talos.outline-visible") === "true") toggleOutline(true);
syncLayout("init");
document.addEventListener("talos:workspace-change", refreshTitle);
void listen<FileSavedNotice>("talos://file-saved", (event) => {
  if (event.payload.owner !== getCurrentWindow().label) {
    const changedTab = editorTabs.find((tab) =>
      tab.path && documentKey(tab.path) === documentKey(event.payload.path) &&
      tab.revision !== event.payload.revision,
    );
    if (changedTab) {
      say(`${changedTab.path} was saved by another Talos window. Saving here will require confirmation.`);
    }
  }
}).catch((error: unknown) => say(`Could not subscribe to file changes: ${String(error)}`));
void listen<{ root: string; changes: { path: string; kind: string }[] } | string>(
  "architecture://changed",
  (event) => {
    const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/$/, "");
    const payload = event.payload;
    const changedPaths = (
      typeof payload === "string" ? [payload] : payload.changes.map((change) => change.path)
    ).map(normalize);
    const changedTabs = editorTabs.filter((tab) => {
      if (!tab.path) return false;
      const path = normalize(tab.path);
      return changedPaths.some((changed) => path === changed || path.startsWith(`${changed}/`));
    });
    if (!changedTabs.length) return;
    if (externalCheckTimer) window.clearTimeout(externalCheckTimer);
    externalCheckTimer = window.setTimeout(() => {
      externalCheckTimer = 0;
      void Promise.all(changedTabs.map((tab) => checkExternalFileRevision(tab))).catch((error: unknown) => {
        say(`Could not check open files for external changes: ${String(error)}`);
      });
    }, 250);
  },
).catch((error: unknown) => say(`Could not subscribe to workspace file changes: ${String(error)}`));
void initExtensions({
  setTheme: (def: ThemeDef | null) => {
    if (def) {
      reconfigureTabThemes(buildTheme(def));
      applyUi(def.ui ?? {});
      ($("theme-select") as HTMLSelectElement).value = "extension";
      localStorage.setItem(themeMigrationKey, "2");
    } else {
      applyBuiltinTheme(activeBuiltinTheme, false);
    }
  },
  setIconPack: (pack) => setExplorerIconPack(pack),
  newFromTemplate: async (filename: string, content: string) => {
    currentPath = null;
    diskRevision = null;
    suggestedName = filename;
    showNewUntitledTab(filename, content);
    await setLanguage(filename);
    refreshTitle();
    view.focus();
  },
  insertText: (text: string) => {
    view.dispatch(view.state.replaceSelection(text));
    view.focus();
  },
});
renderMeter(measure([], 1));
refreshTitle();
view.focus();

const runButton = $("btn-run") as HTMLButtonElement;
void isAndroid()
  .then((isMobile) => {
    android = isMobile;
    if (android) {
      productName = "Talos Pocket";
      $("brand").querySelector(".brand-name")!.textContent = "TALOS POCKET";
      $("window-controls").classList.add("hidden");
      refreshTitle();
      runButton.textContent = "▶ Run";
      runButton.title = "Run Python, C, C++, or Java locally through Termux.";
    }
  })
  .catch((e: unknown) => {
    say("Could not detect platform: " + String(e));
  });

async function initializeWindowContext() {
  try {
    const context = await invoke<WindowContext>("take_window_context");
    if (context.workspacePath) openWorkspace(context.workspacePath);

    let path = context.initialPath;
    if (!path && getCurrentWindow().label === "main") {
      path = await invoke<string | null>("startup_file");
    }
    const restoreEnabled =
      getCurrentWindow().label === "main" &&
      ($("restore-session-on-startup") as HTMLInputElement).checked;
    const restored = restoreEnabled ? await restoreEditorSession() : false;
    if (!path && restoreEnabled && !restored) {
      path = getWindowValue("talos.open-file");
    }
    if (path) {
      try {
        await openAny(path);
      } catch (error) {
        say(`Could not restore ${path}: ${String(error)}`);
      }
    }
  } catch (error) {
    say(`Could not initialize this window: ${String(error)}`);
  }
}

void initializeWindowContext();
