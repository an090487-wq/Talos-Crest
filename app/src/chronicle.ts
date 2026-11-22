import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { chooseWorkspace } from "./architecture";
import { getWindowValue, setWindowValue } from "./window-state";

interface ChronicleSettings {
  enabled: boolean;
  maxFiles: number;
  maxFileBytes: number;
  [key: string]: unknown;
}

interface ChronicleStatus {
  projectId: string;
  projectRoot: string;
  displayName: string;
  indexedFiles: number;
  events: number;
  decisions: number;
  lastIndexedAt: number | null;
  settings: ChronicleSettings;
}

interface ChronicleProgress {
  projectId: string;
  phase: string;
  scanned: number;
  indexed: number;
  unchanged: number;
  skipped: number;
  message: string | null;
}

interface ChronicleEvent {
  id: number;
  kind: string;
  summary: string;
  details: string | null;
  sourcePath: string | null;
  createdAt: number;
}

interface ChronicleDecision {
  id: number;
  title: string;
  context: string | null;
  decision: string;
  status: string;
  createdAt: number;
}

interface ChronicleSearchResult {
  id: string;
  kind: string;
  title: string;
  snippet: string;
  sourcePath: string | null;
  createdAt: number;
}

type ChronicleView = "timeline" | "decisions" | "search";

const el = (id: string) => document.getElementById(id)!;
const dialog = () => el("chronicle-dialog") as HTMLDialogElement;

let currentRoot = "";
let currentProjectId = "";
const storedView = getWindowValue("talos.chronicle-view");
let activeView: ChronicleView =
  storedView === "timeline" || storedView === "decisions" || storedView === "search" ? storedView : "timeline";
let listenersReady: Promise<void> | null = null;
let indexing = false;

function setStatus(message: string) {
  el("chronicle-status").textContent = message;
}

function formatTime(value: number): string {
  const millis = value < 1_000_000_000_000 ? value * 1000 : value;
  return new Date(millis).toLocaleString();
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

function emptyState(title: string, detail: string) {
  const box = document.createElement("div");
  box.className = "tc-empty";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const span = document.createElement("span");
  span.textContent = detail;
  box.append(strong, span);
  return box;
}

function resultRow(title: string, meta: string, detail: string, path: string | null) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "tc-chronicle-row";
  const heading = document.createElement("span");
  heading.className = "tc-chronicle-row-title";
  heading.textContent = title;
  const metadata = document.createElement("span");
  metadata.className = "tc-chronicle-row-meta";
  metadata.textContent = meta;
  const content = document.createElement("span");
  content.className = "tc-chronicle-row-detail";
  content.textContent = detail;
  row.append(heading, metadata, content);
  if (path) {
    row.title = path;
    row.addEventListener("click", () => {
      dialog().close();
      document.dispatchEvent(new CustomEvent("talos:open-path", { detail: path }));
    });
  } else {
    row.disabled = true;
  }
  return row;
}

function renderRows(rows: HTMLElement[], emptyTitle: string, emptyDetail: string) {
  const list = el("chronicle-results");
  list.textContent = "";
  if (rows.length) {
    list.append(...rows);
    return;
  }
  list.appendChild(emptyState(emptyTitle, emptyDetail));
}

async function loadTimeline() {
  const events = await invoke<ChronicleEvent[]>("chronicle_timeline", { root: currentRoot, limit: 100 });
  renderRows(
    events.map((event) => resultRow(
      event.summary,
      [event.kind, event.sourcePath, formatTime(event.createdAt)].filter(Boolean).join(" · "),
      event.details ?? "",
      event.sourcePath,
    )),
    "No Chronicle events yet",
    "Index the workspace to record project events and their evidence.",
  );
  setStatus(`${events.length} event${events.length === 1 ? "" : "s"} in the timeline.`);
}

async function loadDecisions() {
  const decisions = await invoke<ChronicleDecision[]>("chronicle_decisions", { root: currentRoot, limit: 100 });
  renderRows(
    decisions.map((decision) => resultRow(
      decision.title,
      `${decision.status} · ${formatTime(decision.createdAt)}`,
      decision.decision,
      null,
    )),
    "No decisions recorded",
    "Recorded decisions will appear here with their context and status.",
  );
  setStatus(`${decisions.length} decision${decisions.length === 1 ? "" : "s"} recorded.`);
}

async function loadSearch() {
  const query = (el("chronicle-search") as HTMLInputElement).value.trim();
  if (!query) {
    renderRows([], "Search Chronicle", "Enter a term to search indexed evidence, events, and decisions.");
    setStatus("Ready to search the current workspace.");
    return;
  }
  const results = await invoke<ChronicleSearchResult[]>("chronicle_search", {
    root: currentRoot,
    query,
    limit: 100,
  });
  renderRows(
    results.map((result) => resultRow(
      result.title,
      [result.kind, result.sourcePath, formatTime(result.createdAt)].filter(Boolean).join(" · "),
      result.snippet,
      result.sourcePath,
    )),
    "No matching records",
    "Try a different term or reindex the workspace after adding files.",
  );
  setStatus(`${results.length} result${results.length === 1 ? "" : "s"} for “${query}”.`);
}

async function loadView() {
  if (!currentRoot) return;
  try {
    if (activeView === "timeline") await loadTimeline();
    else if (activeView === "decisions") await loadDecisions();
    else await loadSearch();
  } catch (error) {
    renderRows([], "Chronicle could not load", String(error));
    setStatus(`Chronicle error: ${String(error)}`);
  }
}

function setView(view: ChronicleView) {
  activeView = view;
  setWindowValue("talos.chronicle-view", view);
  for (const button of document.querySelectorAll<HTMLElement>("#chronicle-dialog [data-chronicle-view]")) {
    button.classList.toggle("active", button.dataset.chronicleView === view);
  }
  void loadView();
}

async function loadStatus() {
  const status = await invoke<ChronicleStatus>("chronicle_status", { root: currentRoot });
  currentProjectId = status.projectId;
  el("chronicle-root").textContent = status.projectRoot;
  el("chronicle-files").textContent = formatCount(status.indexedFiles);
  el("chronicle-events").textContent = formatCount(status.events);
  el("chronicle-decisions").textContent = formatCount(status.decisions);
  el("chronicle-last-index").textContent = status.lastIndexedAt
    ? formatTime(status.lastIndexedAt)
    : "Never";
  const toggle = el("chronicle-enabled") as HTMLInputElement;
  toggle.checked = status.settings.enabled;
  toggle.disabled = false;
  await loadView();
}

async function refresh() {
  if (!currentRoot) return;
  try {
    await loadStatus();
  } catch (error) {
    setStatus(`Chronicle is unavailable for this workspace: ${String(error)}`);
  }
}

async function ensureListeners() {
  if (listenersReady) return listenersReady;
  listenersReady = (async () => {
    await listen<ChronicleProgress>("chronicle://progress", ({ payload }) => {
      if (currentProjectId && payload.projectId !== currentProjectId) return;
      const detail = payload.message
        ? ` — ${payload.message}`
        : ` — ${payload.indexed} indexed, ${payload.unchanged} unchanged, ${payload.skipped} skipped`;
      setStatus(`${payload.phase}${detail}`);
      if (payload.phase === "done" || payload.phase === "error" || payload.phase === "cancelled") {
        indexing = false;
        el("chronicle-index").removeAttribute("disabled");
        void refresh();
      }
    });
    await listen("chronicle://updated", () => void refresh());
    await listen<{ message: string }>("chronicle://error", ({ payload }) => {
      indexing = false;
      el("chronicle-index").removeAttribute("disabled");
      setStatus(`Indexing failed: ${payload.message}`);
    });
  })();
  return listenersReady;
}

function wire() {
  el("chronicle-close").addEventListener("click", () => dialog().close());
  for (const button of document.querySelectorAll<HTMLElement>("#chronicle-dialog [data-chronicle-view]")) {
    button.addEventListener("click", () => setView(button.dataset.chronicleView as ChronicleView));
    button.classList.toggle("active", button.dataset.chronicleView === activeView);
  }
  let searchTimer = 0;
  el("chronicle-search").addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      if (activeView === "search") void loadView();
    }, 180);
  });
  el("chronicle-refresh").addEventListener("click", () => void refresh());
  el("chronicle-index").addEventListener("click", () => void (async () => {
    if (indexing || !currentRoot) return;
    indexing = true;
    el("chronicle-index").setAttribute("disabled", "true");
    try {
      await invoke("chronicle_index_start", { root: currentRoot });
      setStatus("Indexing queued…");
    } catch (error) {
      indexing = false;
      el("chronicle-index").removeAttribute("disabled");
      setStatus(`Could not start indexing: ${String(error)}`);
    }
  })());
  el("chronicle-cancel").addEventListener("click", () => void (async () => {
    if (!indexing || !currentRoot) return;
    try {
      await invoke("chronicle_index_cancel", { root: currentRoot });
      setStatus("Cancellation requested…");
    } catch (error) {
      setStatus(`Could not cancel indexing: ${String(error)}`);
    }
  })());
  (el("chronicle-enabled") as HTMLInputElement).addEventListener("change", (event) => {
    const enabled = (event.target as HTMLInputElement).checked;
    void (async () => {
      try {
        const status = await invoke<ChronicleStatus>("chronicle_status", { root: currentRoot });
        await invoke("chronicle_set_settings", {
          root: currentRoot,
          settings: { ...status.settings, enabled },
        });
        setStatus(`Chronicle ${enabled ? "enabled" : "disabled"} for this workspace.`);
      } catch (error) {
        (event.target as HTMLInputElement).checked = !enabled;
        setStatus(`Could not update Chronicle settings: ${String(error)}`);
      }
    })();
  });
  document.addEventListener("talos:workspace-change", () => {
    const root = getWindowValue("talos.workspace-root");
    if (root && root !== currentRoot && dialog().open) {
      currentRoot = root;
      void refresh();
    }
  });
}

export async function openChronicle() {
  wireOnce();
  void ensureListeners();
  if (!dialog().open) dialog().showModal();
  const root = getWindowValue("talos.workspace-root");
  if (!root) {
    renderRows([], "Choose a workspace", "Talos Chronicle indexes the current project folder on this device.");
    setStatus("No workspace selected.");
    await chooseWorkspace();
  }
  const selectedRoot = getWindowValue("talos.workspace-root") ?? root;
  if (!selectedRoot) return;
  currentRoot = selectedRoot;
  setStatus("Loading Chronicle…");
  await refresh();
}

let wired = false;
function wireOnce() {
  if (wired) return;
  wired = true;
  wire();
}
