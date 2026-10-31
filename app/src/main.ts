import { EditorView, basicSetup } from "codemirror";
import { Compartment, Prec } from "@codemirror/state";
import type { Text } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { forceLinting, lintGutter } from "@codemirror/lint";
import type { Diagnostic } from "@codemirror/lint";
import { open, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { basicLinter, setDiagnosticsLanguage } from "./diagnostics";
import { measure, LABEL, FUN } from "./meter";
import type { Reading } from "./meter";
import { openPdf, initPdfPane } from "./pdf";
import { initExtensions } from "./extensions";
import { buildTheme, applyUi, resetUi } from "./theme";
import type { ThemeDef } from "./theme";
import { fileNameFromPath, isAndroid, readText, writeText } from "./platform";

const langCompartment = new Compartment();
const themeCompartment = new Compartment();
let suggestedName: string | undefined;
let currentPath: string | null = null;
let dirty = false;
let funMode = false;
let lastReading: Reading | null = null;
let android = false;
let productName = "Talos Crest";

const $ = (id: string) => document.getElementById(id)!;

function say(text: string) {
  $("msg").textContent = text;
}

function refreshTitle() {
  const path = currentPath && android ? fileNameFromPath(currentPath) : currentPath;
  const name = (path ?? "Untitled") + (dirty ? " \u2022" : "");
  $("file").textContent = name;
  document.title = productName + " \u2014 " + name;
}

// ---------- Error Meter + Problems panel ----------
interface Row {
  from: number;
  line: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
}

function renderMeter(r: Reading) {
  lastReading = r;
  $("meter").dataset.level = r.level;
  $("gauge-fill").style.width = Math.max(r.score, 4) + "%";
  const label = funMode ? FUN[r.level] : LABEL[r.level];
  $("meter-text").textContent =
    label + " \u00b7 " + r.score + "% \u00b7 " + r.errors + " err \u00b7 " + r.warnings + " warn";
}

function renderProblems(rows: Row[]) {
  const box = $("problems");
  box.textContent = "";
  $("count").textContent = String(rows.length);
  if (rows.length === 0) {
    const p = document.createElement("div");
    p.className = "empty";
    p.textContent = "No problems found by the basic checks.";
    box.appendChild(p);
    return;
  }
  for (const r of rows.slice(0, 300)) {
    const el = document.createElement("div");
    el.className = "row " + r.severity;
    el.textContent = "Ln " + r.line + "   " + r.message;
    el.addEventListener("click", () => {
      view.dispatch({
        selection: { anchor: Math.min(r.from, view.state.doc.length) },
        scrollIntoView: true,
      });
      view.focus();
    });
    box.appendChild(el);
  }
}

function onDiagnostics(diags: readonly Diagnostic[], doc: Text) {
  const rows: Row[] = diags.map((d) => ({
    from: d.from,
    line: doc.lineAt(Math.min(d.from, doc.length)).number,
    severity: d.severity,
    message: d.message,
  }));
  rows.sort((a, b) => a.line - b.line);
  renderProblems(rows);
  renderMeter(
    measure(
      rows.map((x) => x.severity),
      doc.lines
    )
  );
}

// ---------- Panel + tabs ----------
function showTab(tab: "problems" | "output") {
  for (const b of document.querySelectorAll<HTMLElement>("[data-tab]")) {
    b.classList.toggle("active", b.dataset.tab === tab);
  }
  $("problems").classList.toggle("hidden", tab !== "problems");
  $("output").classList.toggle("hidden", tab !== "output");
}

function showPanel(show: boolean) {
  $("panel").classList.toggle("hidden", !show);
}

function togglePanel() {
  $("panel").classList.toggle("hidden");
}

// ---------- Files ----------
async function setLanguage(fileName: string) {
  const desc = LanguageDescription.matchFilename(languages, fileNameFromPath(fileName));
  const support = desc ? await desc.load() : [];
  view.dispatch({ effects: langCompartment.reconfigure(support) });
  $("lang").textContent = desc ? desc.name : "Plain text";
  setDiagnosticsLanguage(desc ? desc.name : "");
  forceLinting(view);
}

async function loadPath(path: string) {
  const text = await readText(path);
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  currentPath = path;
  dirty = false;
  refreshTitle();
  await setLanguage(path);
}

async function openAny(path: string) {
  if (fileNameFromPath(path).toLowerCase().endsWith(".pdf")) {
    await openPdf(path);
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
  await openPdf(picked);
}

async function saveFile(forceDialog = false) {
  let path = currentPath;
  if (!path || forceDialog) {
    const defaultPath = path && android ? fileNameFromPath(path) : path ?? suggestedName;
    const chosen = await save({ defaultPath });
    if (!chosen) return;
    path = chosen;
  }
  await writeText(path, view.state.doc.toString());
  currentPath = path;
  dirty = false;
  refreshTitle();
  await setLanguage(path);
}

// ---------- Run + Output ----------
interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  language: string;
}

function appendOut(text: string, cls = "") {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  $("output").appendChild(s);
}

async function runFile() {
  const selectedLanguage = ($("run-language") as HTMLSelectElement).value;
  const fileName = fileNameFromPath(currentPath ?? suggestedName ?? "");
  const extension = fileName.split(".").pop()?.toLowerCase();
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
      appendOut("Choose a run language, or use a file with a .py, .c, .cpp, or .java extension.\n", "err");
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
  try {
    let result: RunResult;
    if (currentPath) {
      if (dirty) await saveFile();
      appendOut("Running " + currentPath + " ...\n", "dim");
      result = await invoke<RunResult>("run_file", { path: currentPath });
    } else {
      appendOut("Running the current editor contents...\n", "dim");
      result = await invoke<RunResult>("run_source", {
        source: view.state.doc.toString(),
        languageId: language,
        fileName: suggestedName ?? null,
      });
    }
    if (result.stdout) appendOut(result.stdout);
    if (result.stderr) appendOut(result.stderr, "err");
    const ms = Math.round(performance.now() - t0);
    appendOut(
      "\n\u2014 " + result.language + " finished with exit code " + result.code + " in " + ms + " ms\n",
      result.code === 0 ? "ok" : "err"
    );
  } catch (e) {
    appendOut("Run failed: " + String(e) + "\n", "err");
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

// ---------- Editor ----------
const view = new EditorView({
  doc: "Welcome to Talos\n\nOpen a file with Ctrl+O, save with Ctrl+S, run with F5.\n",
  extensions: [
    Prec.highest(
      keymap.of([
        { key: "Mod-o", run: () => { void guard(openFile); return true; } },
        { key: "Mod-s", run: () => { void guard(() => saveFile()); return true; } },
        { key: "Mod-Shift-s", run: () => { void guard(() => saveFile(true)); return true; } },
        { key: "F5", run: () => { void guard(runFile); return true; } },
        { key: "Mod-Enter", run: () => { void guard(runFile); return true; } },
        { key: "Mod-j", run: () => { togglePanel(); return true; } },
      ])
    ),
    basicSetup,
    themeCompartment.of(oneDark),
    lintGutter(),
    basicLinter(onDiagnostics),
    langCompartment.of([]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        dirty = true;
        refreshTitle();
      }
      const pos = u.state.selection.main.head;
      const line = u.state.doc.lineAt(pos);
      $("pos").textContent = "Ln " + line.number + ", Col " + (pos - line.from + 1);
    }),
  ],
  parent: $("editor"),
});

// ---------- Buttons ----------
$("btn-open").addEventListener("click", () => void guard(openFile));
$("btn-pdf").addEventListener("click", () => void guard(openPdfDialog));
$("btn-save").addEventListener("click", () => void guard(() => saveFile()));
$("btn-saveas").addEventListener("click", () => void guard(() => saveFile(true)));
$("btn-run").addEventListener("click", () => void guard(runFile));
$("btn-panel").addEventListener("click", togglePanel);
$("btn-panel-close").addEventListener("click", () => showPanel(false));
$("btn-fun").addEventListener("click", () => {
  funMode = !funMode;
  $("btn-fun").textContent = funMode ? "Fun mode: on" : "Fun mode: off";
  if (lastReading) renderMeter(lastReading);
});
for (const b of document.querySelectorAll<HTMLElement>("[data-tab]")) {
  b.addEventListener("click", () => showTab(b.dataset.tab === "output" ? "output" : "problems"));
}

initPdfPane();
void initExtensions({
  setTheme: (def: ThemeDef | null) => {
    if (def) {
      view.dispatch({ effects: themeCompartment.reconfigure(buildTheme(def)) });
      applyUi(def.ui ?? {});
    } else {
      view.dispatch({ effects: themeCompartment.reconfigure(oneDark) });
      resetUi();
    }
  },
  newFromTemplate: async (filename: string, content: string) => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
    currentPath = null;
    suggestedName = filename;
    await setLanguage(filename);
    dirty = true;
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
      $("brand").textContent = "TALOS POCKET";
      refreshTitle();
      runButton.textContent = "▶ Run";
      runButton.title = "Run Python, C, C++, or Java locally through Termux.";
    }
  })
  .catch((e: unknown) => {
    say("Could not detect platform: " + String(e));
  });

invoke<string | null>("startup_file").then((p) => {
  if (p) void guard(() => openAny(p));
});
