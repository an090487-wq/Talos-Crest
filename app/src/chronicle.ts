import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { chooseWorkspace } from "./architecture";
import { getWindowValue, setWindowValue } from "./window-state";
import { resolveWorkspacePath, sameWorkspaceRoot } from "./workspace-paths";

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
  jobId?: number | null;
  phase: string;
  scanned: number;
  indexed: number;
  unchanged: number;
  skipped: number;
  message: string | null;
}

interface ChronicleIndexJob {
  projectId?: string;
  jobId: number;
  accepted?: boolean;
}

interface ChronicleErrorEvent {
  projectId?: string;
  jobId?: number | null;
  message: string;
}

interface ChronicleEvidence {
  sourcePath?: string | null;
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
  evidence?: ChronicleEvidence | null;
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

const REFRESH_COALESCE_MS = 150;
const PROGRESS_THROTTLE_MS = 120;
const SEARCH_DEBOUNCE_MS = 180;
const TERMINAL_PHASES = new Set(["done", "error", "cancelled"]);

const el = (id: string) => document.getElementById(id)!;
const dialog = () => el("chronicle-dialog") as HTMLDialogElement;

let currentRoot = "";
let currentProjectId = "";
let activeJobId: number | null = null;
let lastTerminalJobId: number | null = null;
const storedView = getWindowValue("talos.chronicle-view");
let activeView: ChronicleView =
  storedView === "timeline" || storedView === "decisions" || storedView === "search" ? storedView : "timeline";
let listenersReady: Promise<void> | null = null;
const listenerRegistrations = new Map<string, Promise<UnlistenFn>>();
let indexing = false;
let refreshTimer = 0;
let statusGeneration = 0;
let loadGeneration = 0;
let lastProgressUpdate = 0;
let searchTimer = 0;
let searchPending = false;

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

// Chronicle evidence paths are relative to the project root. Resolve them without
// ever following a path that escapes the current workspace.
function resolveSourcePath(sourcePath: string | null | undefined): string | null {
  return resolveWorkspacePath(currentRoot, sourcePath);
}

function isCurrentEvent(projectId: string | null | undefined, jobId: number | null | undefined): boolean {
  if (projectId && currentProjectId && projectId !== currentProjectId) return false;
  if (typeof jobId !== "number") return true;
  if (activeJobId !== null) return jobId === activeJobId;
  return jobId !== lastTerminalJobId;
}

function clearSearchTimer() {
  if (searchTimer) {
    window.clearTimeout(searchTimer);
    searchTimer = 0;
  }
}

function scheduleRefresh() {
  if (refreshTimer) window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    refreshTimer = 0;
    void refresh();
  }, REFRESH_COALESCE_MS);
}

function refreshNow(): Promise<void> {
  if (refreshTimer) window.clearTimeout(refreshTimer);
  refreshTimer = 0;
  return refresh();
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
  const resolved = resolveSourcePath(path);
  if (resolved) {
    row.title = resolved;
    row.addEventListener("click", () => {
      const target = resolveSourcePath(path);
      if (!target) return;
      dialog().close();
      document.dispatchEvent(new CustomEvent("talos:open-path", { detail: target }));
    });
  } else {
    row.disabled = true;
    if (path) row.title = "Evidence path is outside the current workspace";
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
  const generation = ++loadGeneration;
  const root = currentRoot;
  const events = await invoke<ChronicleEvent[]>("chronicle_timeline", { root, limit: 100 });
  if (generation !== loadGeneration || root !== currentRoot || activeView !== "timeline") return;
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
  const generation = ++loadGeneration;
  const root = currentRoot;
  const decisions = await invoke<ChronicleDecision[]>("chronicle_decisions", { root, limit: 100 });
  if (generation !== loadGeneration || root !== currentRoot || activeView !== "decisions") return;
  renderRows(
    decisions.map((decision) => resultRow(
      decision.title,
      `${decision.status} · ${formatTime(decision.createdAt)}`,
      decision.decision,
      decision.evidence?.sourcePath ?? null,
    )),
    "No decisions recorded",
    "Recorded decisions will appear here with their context and status.",
  );
  setStatus(`${decisions.length} decision${decisions.length === 1 ? "" : "s"} recorded.`);
}

async function loadSearch() {
  const generation = ++loadGeneration;
  const root = currentRoot;
  const query = (el("chronicle-search") as HTMLInputElement).value.trim();
  searchPending = false;
  clearSearchTimer();
  if (!query) {
    renderRows([], "Search Chronicle", "Enter a term to search indexed evidence, events, and decisions.");
    setStatus("Ready to search the current workspace.");
    return;
  }
  const results = await invoke<ChronicleSearchResult[]>("chronicle_search", {
    root,
    query,
    limit: 100,
  });
  if (generation !== loadGeneration || root !== currentRoot || activeView !== "search") return;
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
  const root = currentRoot;
  const view = activeView;
  try {
    if (view === "timeline") await loadTimeline();
    else if (view === "decisions") await loadDecisions();
    else await loadSearch();
  } catch (error) {
    if (root !== currentRoot || view !== activeView) return;
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
  clearSearchTimer();
  void loadView();
}

async function loadStatus(generation = ++statusGeneration) {
  const root = currentRoot;
  const status = await invoke<ChronicleStatus>("chronicle_status", { root });
  if (generation !== statusGeneration || root !== currentRoot) return;
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
  const generation = ++statusGeneration;
  try {
    await loadStatus(generation);
  } catch (error) {
    if (generation !== statusGeneration) return;
    setStatus(`Chronicle is unavailable for this workspace: ${String(error)}`);
  }
}

async function registerListener(name: string, register: () => Promise<UnlistenFn>): Promise<UnlistenFn> {
  const existing = listenerRegistrations.get(name);
  if (existing) return existing;
  const pending = register().catch((error) => {
    listenerRegistrations.delete(name);
    throw error;
  });
  listenerRegistrations.set(name, pending);
  return pending;
}

async function ensureListeners() {
  if (!listenersReady) {
    listenersReady = (async () => {
      await Promise.all([
        registerListener("progress", () => listen<ChronicleProgress>("chronicle://progress", ({ payload }) => {
          if (!isCurrentEvent(payload.projectId, payload.jobId)) return;
          const terminal = TERMINAL_PHASES.has(payload.phase);
          const now = Date.now();
          if (!terminal && now - lastProgressUpdate < PROGRESS_THROTTLE_MS) return;
          lastProgressUpdate = now;
          const detail = payload.message
            ? ` — ${payload.message}`
            : ` — ${payload.indexed} indexed, ${payload.unchanged} unchanged, ${payload.skipped} skipped`;
          setStatus(`${payload.phase}${detail}`);
          if (terminal) {
            indexing = false;
            if (typeof payload.jobId === "number") {
              lastTerminalJobId = payload.jobId;
              if (payload.jobId === activeJobId) activeJobId = null;
            }
            el("chronicle-index").removeAttribute("disabled");
            scheduleRefresh();
          }
        })),
        registerListener("updated", () => listen<{ projectId?: string }>("chronicle://updated", ({ payload }) => {
          if (!isCurrentEvent(payload.projectId, undefined)) return;
          scheduleRefresh();
        })),
        registerListener("error", () => listen<ChronicleErrorEvent>("chronicle://error", ({ payload }) => {
          if (!isCurrentEvent(payload.projectId, payload.jobId)) return;
          indexing = false;
          if (typeof payload.jobId === "number") {
            lastTerminalJobId = payload.jobId;
            if (payload.jobId === activeJobId) activeJobId = null;
          }
          el("chronicle-index").removeAttribute("disabled");
          setStatus(`Indexing failed: ${payload.message}`);
        })),
      ]);
    })().catch((error) => {
      listenersReady = null;
      throw error;
    });
  }
  return listenersReady;
}

function wire() {
  el("chronicle-close").addEventListener("click", () => dialog().close());
  for (const button of document.querySelectorAll<HTMLElement>("#chronicle-dialog [data-chronicle-view]")) {
    button.addEventListener("click", () => setView(button.dataset.chronicleView as ChronicleView));
    button.classList.toggle("active", button.dataset.chronicleView === activeView);
  }
  el("chronicle-search").addEventListener("input", () => {
    searchPending = true;
    clearSearchTimer();
    if (activeView !== "search") return;
    searchTimer = window.setTimeout(() => {
      searchTimer = 0;
      if (activeView !== "search" || !searchPending) return;
      void loadView();
    }, SEARCH_DEBOUNCE_MS);
  });
  el("chronicle-refresh").addEventListener("click", () => void refreshNow());
  el("chronicle-index").addEventListener("click", () => void (async () => {
    if (indexing || !currentRoot) return;
    indexing = true;
    el("chronicle-index").setAttribute("disabled", "true");
    try {
      const job = await invoke<ChronicleIndexJob>("chronicle_index_start", { root: currentRoot });
      if (job && typeof job.jobId === "number") activeJobId = job.jobId;
      if (job?.projectId) currentProjectId = job.projectId;
      setStatus("Indexing queued…");
    } catch (error) {
      indexing = false;
      activeJobId = null;
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
    if (root && (!currentRoot || !sameWorkspaceRoot(root, currentRoot)) && dialog().open) {
      currentRoot = root;
      void refreshNow();
    }
  });
  document.addEventListener("talos:workspace-files-changed", (event) => {
    const detail = (event as CustomEvent<{ root?: string; paths?: string[] }>).detail;
    if (!detail || typeof detail.root !== "string" || !sameWorkspaceRoot(detail.root, currentRoot)) return;
    scheduleRefresh();
  });
  document.addEventListener("talos:chronicle-index-queued", (event) => {
    const job = (event as CustomEvent<ChronicleIndexJob>).detail;
    if (!job?.accepted || typeof job.jobId !== "number") return;
    if (job.projectId && currentProjectId && job.projectId !== currentProjectId) return;
    activeJobId = job.jobId;
    if (job.projectId) currentProjectId = job.projectId;
    indexing = true;
    el("chronicle-index").setAttribute("disabled", "true");
    setStatus("Indexing queued after workspace changes…");
  });
}

export async function openChronicle() {
  wireOnce();
  void ensureListeners().catch(() => {
    setStatus("Chronicle events are unavailable; reopen Chronicle to retry.");
  });
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
  await refreshNow();
}

let wired = false;
function wireOnce() {
  if (wired) return;
  wired = true;
  wire();
}
