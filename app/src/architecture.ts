import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { closeOtherDialogs, closeTopmostDialog } from "./ui/dialogs";
import { initGitHubPanel, renderGitHubPanel } from "./github-ui";
import { getWindowValue, setWindowValue } from "./window-state";
import {
  markWorkspaceError,
  markWorkspaceIndexing,
  markWorkspaceOpening,
  markWorkspaceReady,
  markWorkspaceWatcher,
  rememberWorkspaceRoot,
  workspaceRestoreCandidates,
  workspaceRoot,
} from "./workspace";
import {
  analyzeDependencies,
  classifyArchitecture,
  type ArchitectureComponent,
  type DependencyResult,
  type SourceFile,
} from "./architecture-analysis";
import {
  analyzeDebt,
  analyzeSandbox,
  budgetCounts,
  DEFAULT_BUDGETS,
  performanceRows,
  type Budgets,
  type DebtReport,
  type ManifestLike,
  type PerformanceMeasurement,
  type SourceLike,
} from "./observatory-insights";

interface ProjectEntry {
  path: string;
  parent: string;
  name: string;
  kind: "directory" | "file" | "link";
  extension: string;
  language: string;
  size: number;
  modified_ms: number | null;
  depth: number;
  child_count: number;
  file_count: number;
  /** Client-only: true once this directory's immediate children were loaded. */
  children_loaded?: boolean;
}

interface ProjectScan {
  id: string;
  root: string;
  entries: ProjectEntry[];
  warnings: string[];
  truncated: boolean;
  /** Client-only: the initial tree was loaded one directory at a time. */
  lazy?: boolean;
}

interface ProjectDirectory {
  root: string;
  path: string;
  entry: ProjectEntry;
  entries: ProjectEntry[];
  warnings: string[];
  truncated: boolean;
}

interface DuplicatedEntry {
  path: string;
  skipped: number;
}

interface RecentWorkspace {
  id: string;
  path: string;
  name: string;
  openedAt: number;
}

interface WorkspaceChange {
  path: string;
  kind: "create" | "modify" | "delete" | "__talos_rescan__";
}

interface WorkspaceChangeEvent {
  root: string;
  changes: WorkspaceChange[];
}

interface WorkspaceTextMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

interface ChronicleIndexJob {
  projectId: string;
  jobId: number;
  accepted: boolean;
}

interface ArchitectureRow {
  id: string;
  label: string;
  kind: "component" | "file";
  path?: string;
  component?: ArchitectureComponent;
  depth: number;
}

interface FileDecoration {
  modified: boolean;
  errors: number;
  warnings: number;
}

const DEFAULT_EXCLUSIONS = [".git", "node_modules", "__pycache__", "dist", "build", ".venv", "vendor"];
const NS = "http://www.w3.org/2000/svg";
const ROW_HEIGHT = 44;
const NODE_WIDTH = 206;
const NODE_HEIGHT = 32;

type InsightMode = "performance" | "sandbox" | "debt";
type ArchMode = "structure" | "dependencies" | "architecture" | InsightMode | "github";

interface ManifestSet {
  manifests: ManifestLike[];
  warnings: string[];
}

let scan: ProjectScan | null = null;
let selectedPath = "";
let onOpenFile: ((path: string) => Promise<void>) | undefined;
let zoom = storedZoom();
let busy = false;
let scanWaiters: (() => void)[] = [];
let expanded = new Set<string>(storedStringList("talos.arch-expanded"));
let mode: ArchMode = storedMode();
let dependencyResult: DependencyResult | null = null;
let analyzedPaths: string[] = [];
let components: ArchitectureComponent[] = [];
let expandedComponents = new Set<string>(storedStringList("talos.arch-expanded-components"));
let selectedComponent = "";
let analysisBusy = false;
let focusMode = getWindowValue("talos.arch-focus") === "true";
let queuedRoot = "";
let watchedRoot = "";
let watcherFailed = false;
let watcherRecoveryTimer = 0;
let watcherRecoveryAttempts = 0;
let watchedDirectories = new Set<string>();
let watcherPolicyKey = "";
let refreshTimer = 0;
let scanGeneration = 0;
let archSearchTimer = 0;
let quickOpenTimer = 0;
let chronicleIndexTimer = 0;
let treeScrollFrame = 0;
let explorerOpen = getWindowValue("talos.explorer-open") === "true";
let exportFullGraph = false;
let performanceReport: PerformanceMeasurement | null = null;
let manifestSet: ManifestSet | null = null;
let debtReport: DebtReport | null = null;
let insightBusy = false;
let insightRefreshPending = false;
let budgets: Budgets = {
  wall_ms: positiveStoredNumber("talos.insight-budget-wall", DEFAULT_BUDGETS.wall_ms),
  cpu_ms: positiveStoredNumber("talos.insight-budget-cpu", DEFAULT_BUDGETS.cpu_ms),
  bytes: positiveStoredNumber("talos.insight-budget-bytes", DEFAULT_BUDGETS.bytes),
};

function positiveStoredNumber(key: string, fallback: number): number {
  const value = Number(getWindowValue(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function storedStringList(key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(getWindowValue(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function storedZoom(): number {
  const value = Number(getWindowValue("talos.arch-zoom"));
  return Number.isFinite(value) && value >= 0.6 && value <= 1.8 ? value : 1;
}

function storedMode(): ArchMode {
  const value = getWindowValue("talos.arch-mode") ?? "";
  if (value === "structure" || value === "dependencies" || value === "architecture" || value === "github" || isInsightMode(value)) {
    return value;
  }
  return "structure";
}

let expandedSaveTimer = 0;
function scheduleExpandedSave(): void {
  if (expandedSaveTimer) return;
  expandedSaveTimer = window.setTimeout(() => {
    expandedSaveTimer = 0;
    try {
      setWindowValue("talos.arch-expanded", JSON.stringify([...expanded]));
      setWindowValue("talos.arch-expanded-components", JSON.stringify([...expandedComponents]));
    } catch {
      // Tree expansion is cosmetic; a storage failure must not break rendering.
    }
  }, 300);
}

function isInsightMode(value: string): value is InsightMode {
  return value === "performance" || value === "sandbox" || value === "debt";
}

function showArchitectureWindow() {
  explorerOpen = true;
  setWindowValue("talos.explorer-open", "true");
  $("architecture").classList.remove("hidden");
}
let panStart: { x: number; y: number; left: number; top: number } | null = null;
let spaceHeld = false;
let expandedVersion = 0;
let loadingDirectories = new Set<string>();
let componentExpandedVersion = 0;
let cachedTreeRows: {
  snapshot: ProjectScan;
  query: string;
  version: number;
  showHidden: boolean;
  rows: ProjectEntry[];
} | null = null;
let cachedArchitectureRows: {
  snapshot: ProjectScan;
  query: string;
  expandedVersion: number;
  focusMode: boolean;
  selectedComponent: string;
  rows: ArchitectureRow[];
} | null = null;
let entryByPath = new Map<string, ProjectEntry>();
let draggedEntryPath = "";
let showHidden = getWindowValue("talos.show-hidden-files") === "true";
let quickOpenIndex = 0;
let quickOpenWorker: Worker | null = null;
let quickOpenRequestId = 0;
let quickOpenQuery = "";
const RECENT_PATHS_KEY = "talos.recent-files";
let onWorkspacePathChange: ((oldPath: string, newPath: string | null) => void) | undefined;
let getFileDecoration: ((path: string) => FileDecoration | null) | undefined;

const $ = (id: string) => document.getElementById(id)!;
const normalizedPath = (path: string) => path.replace(/\\/g, "/");

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text = ""
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  if (text) element.textContent = text;
  return element;
}

function moveGraphFocus(canvas: SVGSVGElement, index: number, event: KeyboardEvent) {
  const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
  if (!delta) return;
  event.preventDefault();
  (canvas.querySelector(`[data-index="${index + delta}"]`) as SVGElement | null)?.focus();
}

function setMessage(text: string, error = false) {
  const message = $("arch-message");
  message.textContent = text;
  message.classList.toggle("error", error);
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function selectedEntry(): ProjectEntry | undefined {
  return entryByPath.get(selectedPath);
}

function relativePath(path: string): string {
  if (!scan) return "";
  const root = normalizedPath(scan.root).replace(/\/$/, "");
  const normalized = normalizedPath(path);
  return normalized === root ? "" : normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : "";
}

function absolutePath(relative: string): string {
  return scan ? `${normalizedPath(scan.root).replace(/\/$/, "")}/${relative}` : relative;
}

function recentPaths(): string[] {
  try {
    const stored: unknown = JSON.parse(getWindowValue(RECENT_PATHS_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((path): path is string => typeof path === "string") : [];
  } catch {
    return [];
  }
}

export function rememberRecent(path: string) {
  try {
    setWindowValue(
      RECENT_PATHS_KEY,
      JSON.stringify([path, ...recentPaths().filter((recent) => recent !== path)].slice(0, 30))
    );
  } catch (error) {
    setMessage(`Could not save recent files: ${String(error)}`, true);
  }
}

function validEntryName(name: string | null): string | null {
  const value = name?.trim() ?? "";
  if (!value) return null;
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    setMessage("Enter a single file or folder name without path separators.", true);
    return null;
  }
  return value;
}

function validWorkspaceRelativePath(value: string | null): string | null {
  const normalized = value?.trim().replace(/\\/g, "/") ?? "";
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    setMessage("Enter a workspace-relative path starting with a file or folder name.", true);
    return null;
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\0"))) {
    setMessage("Enter a path without empty, '.', or '..' segments.", true);
    return null;
  }
  return segments.join("/");
}

function addDetailRows(details: HTMLElement, rows: [string, string][]) {
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    row.className = "arch-detail-row";
    const key = document.createElement("span");
    key.className = "arch-detail-key";
    key.textContent = label;
    const val = document.createElement("span");
    val.className = "arch-detail-value";
    val.textContent = value;
    row.append(key, val);
    details.appendChild(row);
  }
}

function renderDetails() {
  const details = $("arch-details");
  details.textContent = "";
  if (mode === "architecture") {
    const component = components.find((item) => item.id === selectedComponent);
    if (component) {
      addDetailRows(details, [
        ["Component", component.label],
        ["Files", String(component.files.length)],
        ["Evidence", component.evidence.length ? component.evidence.join(", ") : "No matching path/name evidence"],
      ]);
      const inspect = document.createElement("button");
      inspect.textContent = expandedComponents.has(component.id) ? "Collapse files" : "Expand files";
      inspect.addEventListener("click", () => {
        if (expandedComponents.has(component.id)) expandedComponents.delete(component.id);
        else expandedComponents.add(component.id);
        componentExpandedVersion++;
        render();
      });
      details.appendChild(inspect);
      return;
    }
  }

  const entry = selectedEntry();
  if (!entry) {
    const empty = document.createElement("p");
    empty.textContent = analysisBusy ? "Analyzing project sources…" : "Select a node to inspect it.";
    details.appendChild(empty);
    return;
  }

  const rows: [string, string][] = [
    ["Name", entry.name],
    ["Type", entry.kind === "directory" ? "Folder" : entry.kind === "link" ? "Symbolic link (not followed)" : entry.extension ? `${entry.extension.toUpperCase()} file` : "File"],
    ["Path", entry.path],
    ["Size", entry.kind === "directory" ? (scan?.lazy ? "Not counted in lazy view" : `${entry.file_count} files`) : humanSize(entry.size)],
    ["Children", entry.kind === "directory" ? String(entry.child_count) : "—"],
    ["Modified", entry.modified_ms ? new Date(entry.modified_ms).toLocaleString() : "Unavailable"],
  ];
  if (mode === "dependencies" && dependencyResult) {
    const path = normalizedPath(entry.path);
    const outgoing = dependencyResult.edges.filter((edge) => edge.from === path);
    const incoming = dependencyResult.edges.filter((edge) => edge.to === path);
    rows.push(
      ["Outgoing dependencies", String(outgoing.length)],
      ["Incoming references", String(incoming.length)],
      ["Circular", outgoing.some((edge) => edge.circular) || incoming.some((edge) => edge.circular) ? "Detected" : "Not detected"],
    );
    if (dependencyResult.unreferenced.includes(path)) {
      rows.push(["Usage", "No in-project imports; could be an entry point."]);
    }
  }
  addDetailRows(details, rows);
  const decoration = getFileDecoration?.(entry.path);
  if (decoration) {
    const labels = [
      decoration.modified ? "Modified in editor" : "",
      decoration.errors ? `${decoration.errors} error${decoration.errors === 1 ? "" : "s"}` : "",
      decoration.warnings ? `${decoration.warnings} warning${decoration.warnings === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    if (labels.length) addDetailRows(details, [["Editor status", labels.join(", ")]]);
  }
  if (entry.kind !== "directory" && entry.kind !== "link") {
    const openButton = document.createElement("button");
    openButton.className = "accent";
    openButton.textContent = "Open in editor";
    openButton.addEventListener("click", () => void openSelected());
    details.appendChild(openButton);
  }
  if (mode === "structure" && entry.kind !== "link") {
    const actions = document.createElement("div");
    actions.className = "arch-actions";
    if (entry.kind === "directory") {
      const newFile = document.createElement("button");
      newFile.textContent = "New File";
      newFile.addEventListener("click", () => void createEntry("file"));
      const newFolder = document.createElement("button");
      newFolder.textContent = "New Folder";
      newFolder.addEventListener("click", () => void createEntry("directory"));
      actions.append(newFile, newFolder);
    }
    const copyAbsolute = document.createElement("button");
    copyAbsolute.textContent = "Copy Path";
    copyAbsolute.addEventListener("click", () => void copyPath(entry.path));
    const copyRelative = document.createElement("button");
    copyRelative.textContent = "Copy Relative Path";
    copyRelative.addEventListener("click", () => void copyPath(relativePath(entry.path)));
    actions.append(copyAbsolute, copyRelative);
    if (entry.path !== scan?.root) {
      const duplicate = document.createElement("button");
      duplicate.textContent = "Duplicate";
      duplicate.addEventListener("click", () => void duplicateSelected(entry));
      const rename = document.createElement("button");
      rename.textContent = "Rename";
      rename.addEventListener("click", () => void renameSelected());
      const remove = document.createElement("button");
      remove.textContent = "Delete";
      remove.className = "danger";
      remove.addEventListener("click", () => void deleteSelected());
      actions.append(duplicate, rename, remove);
    }
    details.appendChild(actions);
  }
}

async function openSelected() {
  const entry = selectedEntry();
  if (!entry || entry.kind !== "file" || !onOpenFile) return;
  try {
    await onOpenFile(entry.path);
    rememberRecent(entry.path);
    $("architecture").classList.add("hidden");
  } catch (error) {
    setMessage(`Could not open ${entry.name}: ${String(error)}`, true);
  }
}

function targetDirectory(entry: ProjectEntry): string {
  return entry.kind === "directory" ? relativePath(entry.path) : relativePath(entry.parent);
}

async function createEntry(kind: "file" | "directory") {
  if (!scan) return;
  const entry = selectedEntry();
  const name = validEntryName(window.prompt(`New ${kind === "file" ? "file" : "folder"} name:`));
  if (!name) return;
  const root = scan.root;
  const parent = targetDirectory(entry ?? scan.entries[0]);
  const path = [parent, name].filter(Boolean).join("/");
  const createdPath = absolutePath(path);
  try {
    await invoke(kind === "file" ? "create_project_file" : "create_project_folder", {
      root,
      path,
    });
    await refreshTree(root);
    selectedPath = createdPath;
    render();
    setMessage(`Created ${path}`);
    if (kind === "file" && onOpenFile) {
      try {
        await onOpenFile(createdPath);
        rememberRecent(createdPath);
        $("architecture").classList.add("hidden");
      } catch (error) {
        setMessage(`Created ${path}, but could not open it: ${String(error)}`, true);
      }
    }
  } catch (error) {
    setMessage(`Could not create ${path}: ${String(error)}`, true);
  }
}

async function renameSelected() {
  if (!scan) return;
  const entry = selectedEntry();
  if (!entry || entry.path === scan.root || entry.kind === "link") return;
  const name = validEntryName(window.prompt(`Rename ${entry.name} to:`, entry.name));
  if (!name || name === entry.name) return;
  const from = relativePath(entry.path);
  const parent = relativePath(entry.parent);
  const to = [parent, name].filter(Boolean).join("/");
  const root = scan.root;
  try {
    await invoke("rename_project_entry", { root, from, to });
    onWorkspacePathChange?.(entry.path, absolutePath(to));
    await refreshTree(root);
    selectedPath = absolutePath(to);
    render();
    setMessage(`Renamed to ${to}`);
  } catch (error) {
    setMessage(`Could not rename ${entry.name}: ${String(error)}`, true);
  }
}

async function performMove(entry: ProjectEntry, to: string) {
  if (!scan) return;
  const from = relativePath(entry.path);
  if (to === from) return;
  const root = scan.root;
  const descendants = scan.entries
    .filter((candidate) => candidate.path === entry.path || candidate.path.startsWith(`${entry.path}/`))
    .map((candidate) => candidate.path);
  try {
    await invoke("move_project_entry", { root, from, to });
    const movedRoot = absolutePath(to);
    for (const oldPath of descendants) {
      const suffix = oldPath.slice(entry.path.length);
      const newPath = `${movedRoot}${suffix}`;
      onWorkspacePathChange?.(oldPath, newPath);
      if (expanded.delete(oldPath)) expanded.add(newPath);
    }
    await refreshTree(root);
    selectedPath = movedRoot;
    render();
    setMessage(`Moved ${from} to ${to}`);
  } catch (error) {
    setMessage(`Could not move ${entry.name}: ${String(error)}`, true);
  }
}

async function moveSelected() {
  if (!scan) return;
  const entry = selectedEntry();
  if (!entry || entry.path === scan.root || entry.kind === "link") return;
  const from = relativePath(entry.path);
  const to = validWorkspaceRelativePath(window.prompt(`Move "${entry.name}" to a new workspace-relative path:`, from));
  if (!to) return;
  await performMove(entry, to);
}

async function duplicateSelected(entryOverride?: ProjectEntry) {
  if (!scan) return;
  const entry = entryOverride ?? selectedEntry();
  if (!entry || entry.path === scan.root || entry.kind === "link") return;
  const root = scan.root;
  const path = relativePath(entry.path);
  try {
    const result = await invoke<DuplicatedEntry>("duplicate_project_entry", {
      root,
      path,
      exclusions: currentExclusions(),
      showHidden,
    });
    await refreshTree(root);
    const createdPath = absolutePath(result.path);
    selectedPath = createdPath;
    render();
    const skipped = result.skipped
      ? ` · ${result.skipped} ignored, sensitive, or symbolic child item(s) skipped`
      : "";
    setMessage(`Duplicated ${path} to ${result.path}${skipped}`);
    if (entry.kind === "file" && onOpenFile) {
      try {
        await onOpenFile(createdPath);
        rememberRecent(createdPath);
        $("architecture").classList.add("hidden");
      } catch (error) {
        setMessage(`Duplicated to ${result.path}, but could not open it: ${String(error)}`, true);
      }
    }
  } catch (error) {
    setMessage(`Could not duplicate ${path}: ${String(error)}`, true);
  }
}

async function dropEntryOn(sourcePath: string, target: ProjectEntry) {
  if (!scan || target.kind !== "directory") return;
  const source = entryByPath.get(sourcePath);
  if (!source || source.path === scan.root || source.kind === "link") return;
  if (target.path === source.path || target.path.startsWith(`${source.path}/`)) {
    setMessage("A folder cannot be moved inside itself.", true);
    return;
  }
  const to = [relativePath(target.path), source.name].filter(Boolean).join("/");
  expanded.add(target.path);
  await performMove(source, to);
}

async function deleteSelected() {
  if (!scan) return;
  const entry = selectedEntry();
  if (!entry || entry.path === scan.root || entry.kind === "link") return;
  const detail = entry.kind === "directory"
    ? `Delete folder "${entry.name}" and all of its contents?`
    : `Delete file "${entry.name}"?`;
  if (!window.confirm(detail)) return;
  const root = scan.root;
  const path = relativePath(entry.path);
  const parentPath = entry.parent;
  try {
    await invoke("delete_project_entry", { root, path });
    onWorkspacePathChange?.(entry.path, null);
    await refreshTree(root);
    selectedPath = parentPath;
    render();
    setMessage(`Deleted ${path}`);
  } catch (error) {
    setMessage(`Could not delete ${path}: ${String(error)}`, true);
  }
}

async function copyPath(path: string) {
  try {
    await navigator.clipboard.writeText(path);
    setMessage("Path copied to clipboard.");
  } catch (error) {
    setMessage(`Could not copy path: ${String(error)}`, true);
  }
}

async function toggleDirectory(entry: ProjectEntry, index: number): Promise<void> {
  if (!scan || entry.kind !== "directory") return;
  const snapshot = scan;
  const generation = scanGeneration;
  if (expanded.has(entry.path)) {
    expanded.delete(entry.path);
    expandedVersion++;
    cachedTreeRows = null;
    render();
    focusTreeRow(index);
    return;
  }
  expanded.add(entry.path);
  expandedVersion++;
  cachedTreeRows = null;
  if (entry.children_loaded === true || loadingDirectories.has(entry.path)) {
    render();
    focusTreeRow(index);
    return;
  }
  loadingDirectories.add(entry.path);
  render();
  try {
    const listing = await invoke<ProjectDirectory>("list_project_directory", {
      root: snapshot.root,
      path: entry.path,
      exclusions: currentExclusions(),
      showHidden,
    });
    if (generation !== scanGeneration || scan !== snapshot || !scan) return;
    const children = listing.entries.map((child) => ({
      ...child,
      children_loaded: false,
    }));
    const nextEntries = scan.entries.filter(
      (candidate) => !(candidate.path === entry.path ? false : isPathInside(candidate.path, entry.path)),
    );
    const targetIndex = nextEntries.findIndex((candidate) => candidate.path === entry.path);
    const updatedEntry = {
      ...(targetIndex >= 0 ? nextEntries[targetIndex] : entry),
      ...listing.entry,
      children_loaded: true,
      child_count: children.length,
    };
    if (targetIndex >= 0) nextEntries[targetIndex] = updatedEntry;
    else nextEntries.push(updatedEntry);
    for (const child of children) nextEntries.push(child);
    // Remove expansion state for descendants that were replaced by the fresh listing.
    for (const path of [...expanded]) {
      if (isPathInside(path, entry.path) && path !== entry.path && !nextEntries.some((candidate) => candidate.path === path)) {
        expanded.delete(path);
      }
    }
    scan = {
      ...scan,
      entries: nextEntries,
      warnings: listing.warnings.length ? listing.warnings : scan.warnings,
      truncated: scan.truncated || listing.truncated,
    };
    entryByPath = new Map(scan.entries.map((candidate) => [candidate.path, candidate]));
    cachedTreeRows = null;
    expandedVersion++;
    if (listing.warnings.length) setMessage(`Loaded ${entry.name} with ${listing.warnings.length} warning(s).`, true);
  } catch (error) {
    expanded.delete(entry.path);
    expandedVersion++;
    cachedTreeRows = null;
    setMessage(`Could not load ${entry.name}: ${String(error)}`, true);
  } finally {
    loadingDirectories.delete(entry.path);
    cachedTreeRows = null;
    render();
    focusTreeRow(index);
  }
}

async function restoreLazyExpansion(generation: number): Promise<void> {
  if (!scan?.lazy) return;
  const root = scan.root;
  const expandedPaths = [...expanded]
    .filter((path) => path !== root)
    .sort((a, b) => a.length - b.length);
  let loaded = 0;
  for (const path of expandedPaths) {
    if (generation !== scanGeneration || !scan?.lazy || loaded >= 40) break;
    const entry = entryByPath.get(path);
    if (!entry || entry.kind !== "directory" || entry.children_loaded) continue;
    let parent = entry.parent;
    let ancestorsExpanded = true;
    while (parent && parent !== root) {
      if (!expanded.has(parent)) {
        ancestorsExpanded = false;
        break;
      }
      parent = entryByPath.get(parent)?.parent ?? "";
    }
    if (!ancestorsExpanded || (parent && parent !== root && !entryByPath.has(parent))) continue;
    expanded.delete(path);
    await toggleDirectory(entry, -1);
    loaded++;
  }
}

async function refreshTree(root: string, forceWatch = false): Promise<boolean> {
  return scanProject(root, forceWatch, { lazy: scan?.lazy ?? false });
}

function isPathInside(path: string, ancestor: string): boolean {
  if (path === ancestor) return true;
  const separator = ancestor.includes("\\\\") && !ancestor.includes("/") ? "\\\\" : "/";
  const prefix = ancestor.endsWith(separator) ? ancestor : `${ancestor}${separator}`;
  return path.startsWith(prefix);
}

function visibleEntries(): ProjectEntry[] {
  if (!scan) return [];
  const query = ($("arch-search") as HTMLInputElement).value.trim().toLowerCase();
  if (
    cachedTreeRows?.snapshot === scan &&
    cachedTreeRows.query === query &&
    cachedTreeRows.version === expandedVersion &&
    cachedTreeRows.showHidden === showHidden
  ) {
    return cachedTreeRows.rows;
  }
  const children = new Map<string, ProjectEntry[]>();
  const byPath = new Map(scan.entries.map((entry) => [entry.path, entry]));
  for (const entry of scan.entries) {
    const siblings = children.get(entry.parent) ?? [];
    siblings.push(entry);
    children.set(entry.parent, siblings);
  }
  const matchingPaths = new Set<string>();
  if (query) {
    for (const entry of scan.entries) {
      if (!`${entry.name} ${entry.path}`.toLowerCase().includes(query)) continue;
      let current: ProjectEntry | undefined = entry;
      while (current) {
        matchingPaths.add(current.path);
        current = current.parent ? byPath.get(current.parent) : undefined;
      }
    }
  }

  const result: ProjectEntry[] = [];
  const root = scan.entries.find((entry) => entry.path === scan?.root);
  if (!root) return result;
  result.push(root);
  const stack = [...(children.get(root.path) ?? [])].reverse();
  while (stack.length > 0) {
    const entry = stack.pop()!;
    if (!showHidden && entry.name.startsWith(".")) continue;
    if (query && !matchingPaths.has(entry.path)) continue;
    result.push(entry);
    if (
      entry.kind === "directory" &&
      (expanded.has(entry.path) || (query && matchingPaths.has(entry.path)))
    ) {
      const descendants = children.get(entry.path) ?? [];
      for (let i = descendants.length - 1; i >= 0; i--) stack.push(descendants[i]);
    }
  }
  cachedTreeRows = { snapshot: scan, query, version: expandedVersion, showHidden, rows: result };
  return result;
}

function focusTreeRow(index: number) {
  const rows = visibleEntries();
  if (index < 0 || index >= rows.length) return;
  const viewport = $("arch-graph-viewport");
  const rowTop = index * 32;
  if (rowTop < viewport.scrollTop || rowTop + 32 > viewport.scrollTop + viewport.clientHeight) {
    viewport.scrollTop = Math.max(0, rowTop - viewport.clientHeight + 64);
    renderFileTree();
  }
  ($("arch-tree").querySelector(`[data-index="${index}"]`) as HTMLElement | null)?.focus();
}

function clearDropTargets() {
  for (const row of document.querySelectorAll("#arch-tree .arch-tree-row.drop-target")) {
    row.classList.remove("drop-target");
  }
}

function renderFileTree() {
  const viewport = $("arch-graph-viewport");
  const tree = $("arch-tree");
  const canvas = $("arch-graph");
  const space = $("arch-graph-space");
  viewport.classList.add("file-tree-mode");
  tree.classList.remove("hidden");
  canvas.classList.add("hidden");
  space.classList.add("hidden");
  tree.textContent = "";
  const rows = visibleEntries();
  const rowHeight = 32;
  const totalHeight = Math.max(viewport.clientHeight, rows.length * rowHeight);
  const first = Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - 4);
  const last = Math.min(rows.length, Math.ceil((viewport.scrollTop + viewport.clientHeight) / rowHeight) + 4);
  tree.style.height = `${totalHeight}px`;

  for (let index = first; index < last; index++) {
    const entry = rows[index];
    const row = document.createElement("div");
    row.className = `arch-tree-row ${entry.kind}${entry.path === selectedPath ? " selected" : ""}`;
    row.tabIndex = 0;
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-level", String(entry.depth + 1));
    row.setAttribute("aria-label", `${entry.kind}: ${entry.name}`);
    row.title = entry.kind === "file"
      ? `${entry.name} — double-click or press Enter to open; drag to move`
      : `${entry.name} — double-click or press Enter to ${expanded.has(entry.path) ? "collapse" : "expand"}; drop files here to move`;
    row.dataset.index = String(index);
    row.style.top = `${index * rowHeight}px`;
    row.style.paddingInlineStart = `${8 + entry.depth * 18}px`;
    if (entry.path !== scan?.root && entry.kind !== "link") {
      row.draggable = true;
      row.addEventListener("dragstart", (event) => {
        draggedEntryPath = entry.path;
        event.dataTransfer?.setData("text/plain", entry.path);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", () => {
        draggedEntryPath = "";
        row.classList.remove("dragging");
        clearDropTargets();
      });
    }
    if (entry.kind === "directory") {
      const isExpanded = expanded.has(entry.path) || !!($("arch-search") as HTMLInputElement).value.trim();
      row.setAttribute("aria-expanded", String(isExpanded));
      const toggle = document.createElement("button");
      toggle.className = "arch-tree-chevron";
      toggle.type = "button";
      toggle.textContent = loadingDirectories.has(entry.path) ? "…" : (isExpanded ? "▾" : "▸");
      toggle.disabled = loadingDirectories.has(entry.path);
      toggle.setAttribute("aria-label", `${isExpanded ? "Collapse" : "Expand"} ${entry.name}`);
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        void toggleDirectory(entry, index);
      });
      row.appendChild(toggle);
      row.addEventListener("dragover", (event) => {
        if (!event.dataTransfer) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        clearDropTargets();
        row.classList.add("drop-target");
      });
      row.addEventListener("dragleave", (event) => {
        if (!row.contains(event.relatedTarget as Node | null)) row.classList.remove("drop-target");
      });
      row.addEventListener("drop", (event) => {
        event.preventDefault();
        row.classList.remove("drop-target");
        const sourcePath = event.dataTransfer?.getData("text/plain") || draggedEntryPath;
        draggedEntryPath = "";
        if (sourcePath) void dropEntryOn(sourcePath, entry);
      });
    } else {
      const spacer = document.createElement("span");
      spacer.className = "arch-tree-chevron";
      spacer.setAttribute("aria-hidden", "true");
      row.appendChild(spacer);
    }
    const icon = document.createElement("span");
    icon.className = `arch-tree-icon ${entry.kind}`;
    icon.textContent = entryIcon(entry);
    icon.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "arch-tree-name";
    name.textContent = entry.name;
    row.append(icon, name);
    const decoration = getFileDecoration?.(entry.path);
    if (decoration) {
      for (const [label, className] of [
        ...(decoration.modified ? [["M", "modified"]] : []),
        ...(decoration.errors ? [[`E ${decoration.errors}`, "error"]] : []),
        ...(decoration.warnings ? [[`W ${decoration.warnings}`, "warning"]] : []),
      ]) {
        const badge = document.createElement("span");
        badge.className = `arch-tree-badge ${className}`;
        badge.textContent = label;
        row.appendChild(badge);
      }
    }
    row.addEventListener("click", () => {
      selectedPath = entry.path;
      for (const previous of tree.querySelectorAll(".arch-tree-row.selected")) {
        previous.classList.remove("selected");
      }
      row.classList.add("selected");
      renderDetails();
      focusTreeRow(index);
      if (entry.kind === "file") void openSelected();
    });
    row.addEventListener("dblclick", () => {
      if (entry.kind === "file") void openSelected();
      else if (entry.kind === "directory") void toggleDirectory(entry, index);
    });
    row.addEventListener("contextmenu", (event) => showEntryContextMenu(event, entry));
    row.addEventListener("keydown", (event) => {
      const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
      if (delta) {
        event.preventDefault();
        focusTreeRow(index + delta);
      } else if (event.key === "ArrowRight" && entry.kind === "directory" && !expanded.has(entry.path)) {
        event.preventDefault();
        void toggleDirectory(entry, index);
      } else if (event.key === "ArrowLeft" && entry.kind === "directory" && expanded.has(entry.path)) {
        event.preventDefault();
        void toggleDirectory(entry, index);
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (entry.kind === "file") void openSelected();
        else if (entry.kind === "directory") void toggleDirectory(entry, index);
      }
    });
    tree.appendChild(row);
  }
  renderDetails();
  const summary = scan
    ? `${scan.entries.length.toLocaleString()} nodes${scan.truncated ? " · scan capped at 50,000 entries" : ""}${scan.warnings.length ? ` · ${scan.warnings.length} scan warning(s)` : ""}`
    : "Choose a project folder to explore.";
  $("arch-summary").textContent = summary;
  $("arch-export").toggleAttribute("disabled", !scan || rows.length === 0);
  $("arch-export-png").toggleAttribute("disabled", !scan || rows.length === 0);
  $("arch-focus").setAttribute("disabled", "true");
}

function entryIcon(entry: ProjectEntry): string {
  if (entry.kind === "directory") return "DIR";
  if (entry.kind === "link") return "LNK";
  const icons: Record<string, string> = {
    ts: "TS", tsx: "TS", js: "JS", jsx: "JS", mjs: "JS", py: "PY",
    rs: "RS", go: "GO", json: "{}", md: "MD", html: "HT", css: "CS",
    toml: "TM", yaml: "YM", yml: "YM", sql: "DB", png: "IMG", jpg: "IMG",
    pdf: "PDF", sh: "SH", java: "JV", c: "C", cpp: "C++",
  };
  const languageIcons: Record<string, string> = {
    python: "PY", typescript: "TS", javascript: "JS", rust: "RS", go: "GO",
    java: "JV", c: "C", cpp: "C++", csharp: "C#", ruby: "RB", php: "PHP",
    swift: "SW", kotlin: "KT", shell: "SH", html: "HT", css: "CS", json: "{}",
  };
  return languageIcons[entry.language]
    ?? icons[entry.extension]
    ?? (entry.extension ? entry.extension.slice(0, 3).toUpperCase() : "FILE");
}

function showEntryContextMenu(event: MouseEvent, entry: ProjectEntry) {
  event.preventDefault();
  document.getElementById("arch-context-menu")?.remove();
  selectedPath = entry.path;
  render();
  const menu = document.createElement("div");
  menu.id = "arch-context-menu";
  menu.setAttribute("role", "menu");
  const actions: [string, () => void][] = [];
  if (entry.kind === "directory") {
    actions.push(["New File", () => void createEntry("file")]);
    actions.push(["New Folder", () => void createEntry("directory")]);
  } else if (onOpenFile) {
    actions.push(["Open", () => void onOpenFile?.(entry.path)]);
    if (/\.(png|jpe?g|webp|svg)$/i.test(entry.path)) {
      actions.push(["Edit in Talos Canvas", () => void onOpenFile?.(entry.path)]);
    }
  }
  actions.push(["Copy Path", () => void copyPath(entry.path)]);
  actions.push(["Copy Relative Path", () => void copyPath(relativePath(entry.path))]);
  if (entry.path !== scan?.root && entry.kind !== "link") {
    actions.push(["Duplicate", () => void duplicateSelected(entry)]);
    actions.push(["Rename", () => void renameSelected()]);
    actions.push(["Move…", () => void moveSelected()]);
    actions.push(["Delete", () => void deleteSelected()]);
  }
  let listenerInstalled = false;
  const closeMenu = (nextEvent: PointerEvent) => {
    if (!menu.contains(nextEvent.target as Node)) {
      menu.remove();
      document.removeEventListener("pointerdown", closeMenu);
      listenerInstalled = false;
    }
  };
  for (const [label, action] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.textContent = label;
    button.addEventListener("click", () => {
      menu.remove();
      if (listenerInstalled) document.removeEventListener("pointerdown", closeMenu);
      action();
    });
    menu.appendChild(button);
  }
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(event.clientX, window.innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(event.clientY, window.innerHeight - rect.height - 4))}px`;
  menu.querySelector("button")?.focus();
  menu.addEventListener("keydown", (nextEvent) => {
    if (nextEvent.key === "Escape") {
      menu.remove();
      if (listenerInstalled) document.removeEventListener("pointerdown", closeMenu);
    }
  });
  window.setTimeout(() => {
    if (!menu.isConnected) return;
    document.addEventListener("pointerdown", closeMenu);
    listenerInstalled = true;
  }, 0);
}

function renderGraph() {
  if (mode === "structure" && !exportFullGraph) {
    renderFileTree();
    return;
  }
  $("arch-graph-viewport").classList.remove("file-tree-mode");
  $("arch-tree").classList.add("hidden");
  $("arch-graph").classList.remove("hidden");
  $("arch-graph-space").classList.remove("hidden");
  if (mode === "dependencies") {
    renderDependencyGraph();
    return;
  }
  if (mode === "architecture") {
    renderArchitectureGraph();
    return;
  }
  const viewport = $("arch-graph-viewport");
  const canvas = $("arch-graph") as unknown as SVGSVGElement;
  const space = $("arch-graph-space");
  const rows = visibleEntries();
  const query = ($("arch-search") as HTMLInputElement).value.trim().toLowerCase();
  const rowHeight = ROW_HEIGHT * zoom;
  const nodeWidth = NODE_WIDTH * zoom;
  const nodeHeight = NODE_HEIGHT * zoom;
  const width = rows.reduce(
    (max, entry) => Math.max(max, 34 + entry.depth * 220 * zoom + nodeWidth + 34),
    760,
  );
  const totalHeight = Math.max(viewport.clientHeight, rows.length * rowHeight + 20);
  const scrollTop = exportFullGraph ? 0 : viewport.scrollTop;
  const first = exportFullGraph ? 0 : Math.max(0, Math.floor(scrollTop / rowHeight) - 3);
  const last = exportFullGraph ? rows.length : Math.min(rows.length, Math.ceil((scrollTop + viewport.clientHeight) / rowHeight) + 3);
  const canvasHeight = exportFullGraph ? totalHeight : Math.max(1, viewport.clientHeight);
  const indexByPath = new Map<string, number>();
  for (let index = first; index < last; index++) indexByPath.set(rows[index].path, index);

  space.style.width = `${width}px`;
  space.style.height = `${totalHeight}px`;
  canvas.setAttribute("width", String(width));
  canvas.setAttribute("height", String(canvasHeight));
  canvas.setAttribute("viewBox", `0 0 ${width} ${canvasHeight}`);
  canvas.style.top = `${exportFullGraph ? 0 : scrollTop}px`;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${canvasHeight}px`;
  canvas.textContent = "";

  for (let index = first; index < last; index++) {
    const entry = rows[index];
    const x = 26 + entry.depth * 220 * zoom;
    const y = index * rowHeight - scrollTop + (rowHeight - nodeHeight) / 2;
    const parentIndex = indexByPath.get(entry.parent);
    if (parentIndex !== undefined && parentIndex >= first && parentIndex < last) {
      const parent = rows[parentIndex];
      const parentX = 26 + parent.depth * 220 * zoom + nodeWidth;
      const parentY = parentIndex * rowHeight - scrollTop + rowHeight / 2;
      canvas.appendChild(svg("path", {
        d: `M ${parentX} ${parentY} C ${parentX + 30 * zoom} ${parentY}, ${x - 30 * zoom} ${y + nodeHeight / 2}, ${x} ${y + nodeHeight / 2}`,
        class: "arch-edge",
      }));
    }

    const group = svg("g", {
      class: `arch-node ${entry.path === selectedPath ? "selected" : ""} ${entry.kind}`,
      tabindex: "0",
      role: "button",
      "aria-label": `${entry.kind}: ${entry.name}`,
      "aria-level": String(entry.depth + 1),
      ...(entry.kind === "directory"
        ? { "aria-expanded": String(expanded.has(entry.path) || !!query) }
        : {}),
      "data-path": entry.path,
      "data-index": String(index),
    });
    const isRecent = entry.modified_ms !== null && Date.now() - entry.modified_ms < 86_400_000;
    group.appendChild(svg("rect", {
      x: String(x),
      y: String(y),
      width: String(nodeWidth),
      height: String(nodeHeight),
      rx: String(7 * zoom),
      class: isRecent ? "recent" : "",
    }));
    const icon = svg("text", {
      x: String(x + 10 * zoom),
      y: String(y + 21 * zoom),
      class: `arch-icon ${entry.kind}`,
      "font-size": String(9 * zoom),
    }, entryIcon(entry));
    group.appendChild(icon);
    if (entry.kind === "directory") {
      const isExpanded = expanded.has(entry.path) || !!query;
      group.appendChild(svg("text", {
        x: String(x + 40 * zoom),
        y: String(y + 21 * zoom),
        class: "arch-toggle",
        "data-toggle": "true",
        "font-size": String(12 * zoom),
      }, isExpanded ? "▾" : "▸"));
    }
    const titleX = x + (entry.kind === "directory" ? 57 : 42) * zoom;
    const title = entry.kind === "directory" && entry.path === scan?.root
      ? `${entry.name}  ·  ${scan?.lazy ? "lazy" : `${entry.file_count} files`}`
      : entry.kind === "directory"
        ? `${entry.name}  ·  ${scan?.lazy ? "lazy" : entry.file_count}`
        : entry.name;
    const label = svg("text", {
      x: String(titleX),
      y: String(y + 21 * zoom),
      class: "arch-label",
      "font-size": String(12 * zoom),
    }, title);
    label.setAttribute("textLength", String(Math.min(nodeWidth - (titleX - x) - 10 * zoom, title.length * 7 * zoom)));
    label.setAttribute("lengthAdjust", "spacingAndGlyphs");
    group.appendChild(label);

    group.addEventListener("click", (event) => {
      if ((event.target as Element).closest("[data-toggle]")) {
        if (expanded.has(entry.path)) expanded.delete(entry.path);
        else expanded.add(entry.path);
        expandedVersion++;
      }
      selectedPath = entry.path;
      render();
    });
    group.addEventListener("dblclick", () => {
      if (entry.kind === "file") void openSelected();
    });
    group.addEventListener("contextmenu", (event) => showEntryContextMenu(event, entry));
    group.addEventListener("keydown", (event) => {
      moveGraphFocus(canvas, index, event);
      if (event.key === "Enter") {
        selectedPath = entry.path;
        if (entry.kind === "file") void openSelected();
        else render();
      } else if (event.key === " " && entry.kind === "directory") {
        event.preventDefault();
        if (expanded.has(entry.path)) expanded.delete(entry.path);
        else expanded.add(entry.path);
        expandedVersion++;
        render();
      }
    });
    canvas.appendChild(group);
  }

  renderDetails();
  const summary = scan
    ? `${scan.entries.length.toLocaleString()} nodes${scan.truncated ? " · scan capped at 50,000 entries" : ""}${scan.warnings.length ? ` · ${scan.warnings.length} scan warning(s)` : ""}`
    : "Choose a project folder to explore.";
  $("arch-summary").textContent = summary;
  $("arch-export").toggleAttribute("disabled", !scan || rows.length === 0);
  $("arch-export-png").toggleAttribute("disabled", !scan || rows.length === 0);
  $("arch-focus").setAttribute("disabled", "true");
}

function renderDependencyGraph() {
  const viewport = $("arch-graph-viewport");
  const canvas = $("arch-graph") as unknown as SVGSVGElement;
  const space = $("arch-graph-space");
  const query = ($("arch-search") as HTMLInputElement).value.trim().toLowerCase();
  const linked = new Set<string>();
  for (const edge of dependencyResult?.edges ?? []) {
    if (edge.from === normalizedPath(selectedPath)) linked.add(edge.to);
    if (edge.to === normalizedPath(selectedPath)) linked.add(edge.from);
  }
  let paths = analyzedPaths.filter((path) => !query || path.toLowerCase().includes(query));
  if (focusMode && selectedPath) {
    paths = paths.filter((path) => normalizedPath(path) === normalizedPath(selectedPath) || linked.has(normalizedPath(path)));
  }
  const rowHeight = ROW_HEIGHT * zoom;
  const nodeWidth = Math.max(300, NODE_WIDTH * 2.15 * zoom);
  const nodeHeight = NODE_HEIGHT * zoom;
  const width = Math.max(viewport.clientWidth, nodeWidth + 180 * zoom);
  const totalHeight = Math.max(viewport.clientHeight, paths.length * rowHeight + 20);
  const scrollTop = exportFullGraph ? 0 : viewport.scrollTop;
  const first = exportFullGraph ? 0 : Math.max(0, Math.floor(scrollTop / rowHeight) - 3);
  const last = exportFullGraph ? paths.length : Math.min(paths.length, Math.ceil((scrollTop + viewport.clientHeight) / rowHeight) + 3);
  const canvasHeight = exportFullGraph ? totalHeight : Math.max(1, viewport.clientHeight);
  const indexByPath = new Map(paths.map((path, index) => [normalizedPath(path), index]));
  space.style.width = `${width}px`;
  space.style.height = `${totalHeight}px`;
  canvas.setAttribute("width", String(width));
  canvas.setAttribute("height", String(canvasHeight));
  canvas.setAttribute("viewBox", `0 0 ${width} ${canvasHeight}`);
  canvas.style.top = `${exportFullGraph ? 0 : scrollTop}px`;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${canvasHeight}px`;
  canvas.textContent = "";
  const defs = svg("defs");
  const marker = svg("marker", {
    id: "arch-arrow",
    viewBox: "0 0 10 10",
    refX: "9",
    refY: "5",
    markerWidth: "5",
    markerHeight: "5",
    orient: "auto-start-reverse",
  });
  marker.appendChild(svg("path", { d: "M 0 0 L 10 5 L 0 10 z", class: "arch-arrow" }));
  defs.appendChild(marker);
  canvas.appendChild(defs);

  for (const edge of dependencyResult?.edges ?? []) {
    const from = indexByPath.get(normalizedPath(edge.from));
    const to = indexByPath.get(normalizedPath(edge.to));
    if (from === undefined || to === undefined || from < first || from >= last || to < first || to >= last) continue;
    const y1 = from * rowHeight - scrollTop + rowHeight / 2;
    const y2 = to * rowHeight - scrollTop + rowHeight / 2;
    const path = svg("path", {
      d: `M ${26 + nodeWidth} ${y1} C ${width - 20} ${y1}, ${width - 20} ${y2}, ${26 + nodeWidth} ${y2}`,
      class: `arch-edge dependency-edge ${edge.circular ? "circular" : ""} ${normalizedPath(selectedPath) === edge.from || normalizedPath(selectedPath) === edge.to ? "connected" : ""}`,
      "marker-end": "url(#arch-arrow)",
    });
    canvas.appendChild(path);
  }

  for (let index = first; index < last; index++) {
    const path = paths[index];
    const entry = entryByPath.get(path);
    const y = index * rowHeight - scrollTop + (rowHeight - nodeHeight) / 2;
    const active = normalizedPath(path) === normalizedPath(selectedPath);
    const group = svg("g", {
      class: `arch-node file ${active ? "selected" : ""} ${linked.has(normalizedPath(path)) ? "connected-node" : ""}`,
      tabindex: "0",
      role: "button",
      "aria-label": `Dependency node: ${path}`,
      "data-index": String(index),
    });
    group.appendChild(svg("rect", {
      x: "26",
      y: String(y),
      width: String(nodeWidth),
      height: String(nodeHeight),
      rx: String(7 * zoom),
      class: entry?.modified_ms && Date.now() - entry.modified_ms < 86_400_000 ? "recent" : "",
    }));
    group.appendChild(svg("text", {
      x: String(38 * zoom),
      y: String(y + 21 * zoom),
      class: "arch-icon file",
      "font-size": String(9 * zoom),
    }, entry ? entryIcon(entry) : "FILE"));
    const label = svg("text", {
      x: String(72 * zoom),
      y: String(y + 21 * zoom),
      class: "arch-label",
      "font-size": String(12 * zoom),
    }, path.slice((scan?.root.length ?? 0) + 1));
    label.setAttribute("textLength", String(Math.min(nodeWidth - 90 * zoom, path.length * 7 * zoom)));
    label.setAttribute("lengthAdjust", "spacingAndGlyphs");
    group.appendChild(label);
    group.addEventListener("click", () => {
      selectedPath = path;
      selectedComponent = "";
      render();
    });
    group.addEventListener("dblclick", () => {
      selectedPath = path;
      void openSelected();
    });
    group.addEventListener("keydown", (event) => {
      moveGraphFocus(canvas, index, event);
      if (event.key === "Enter") {
        selectedPath = path;
        void openSelected();
      }
    });
    canvas.appendChild(group);
  }

  const result = dependencyResult;
  $("arch-summary").textContent = analysisBusy
    ? "Analyzing supported source files…"
    : result
      ? `${result.analyzedFiles} files analyzed · ${result.edges.length} local dependencies · ${result.edges.filter((edge) => edge.circular).length} circular edges · ${result.unresolved.length} unresolved relative imports`
      : "Choose Dependencies to analyze project imports.";
  $("arch-export").toggleAttribute("disabled", paths.length === 0);
  $("arch-export-png").toggleAttribute("disabled", paths.length === 0);
  $("arch-focus").toggleAttribute(
    "disabled",
    !selectedPath || !result || !analyzedPaths.some((path) => normalizedPath(path) === normalizedPath(selectedPath)),
  );
  renderDetails();
}

function architectureRows(query: string): ArchitectureRow[] {
  if (
    scan &&
    cachedArchitectureRows?.snapshot === scan &&
    cachedArchitectureRows.query === query &&
    cachedArchitectureRows.expandedVersion === componentExpandedVersion &&
    cachedArchitectureRows.focusMode === focusMode &&
    cachedArchitectureRows.selectedComponent === selectedComponent
  ) {
    return cachedArchitectureRows.rows;
  }
  const rows: ArchitectureRow[] = [];
  for (const component of components) {
    const matchingFiles = component.files.filter((path) => !query || path.toLowerCase().includes(query));
    const matchesComponent = !query || `${component.label} ${component.evidence.join(" ")}`.toLowerCase().includes(query);
    if (!matchesComponent && matchingFiles.length === 0) continue;
    rows.push({ id: component.id, label: component.label, kind: "component", component, depth: 0 });
    if (expandedComponents.has(component.id) || (query && matchingFiles.length > 0)) {
      for (const path of matchingFiles) {
        const entry = entryByPath.get(path);
        rows.push({ id: path, label: entry?.name ?? path, kind: "file", path, component, depth: 1 });
      }
    }
  }
  const filtered = focusMode && selectedComponent
    ? rows.filter((row) => row.component?.id === selectedComponent || row.id === selectedComponent)
    : rows;
  if (scan) {
    cachedArchitectureRows = {
      snapshot: scan,
      query,
      expandedVersion: componentExpandedVersion,
      focusMode,
      selectedComponent,
      rows: filtered,
    };
  }
  return filtered;
}

function renderArchitectureGraph() {
  const viewport = $("arch-graph-viewport");
  const canvas = $("arch-graph") as unknown as SVGSVGElement;
  const space = $("arch-graph-space");
  const query = ($("arch-search") as HTMLInputElement).value.trim().toLowerCase();
  const rows = architectureRows(query);
  const rowHeight = ROW_HEIGHT * zoom;
  const nodeWidth = NODE_WIDTH * zoom;
  const nodeHeight = NODE_HEIGHT * zoom;
  const width = Math.max(viewport.clientWidth, 26 + 220 * zoom + nodeWidth + 24);
  const totalHeight = Math.max(viewport.clientHeight, rows.length * rowHeight + 20);
  const scrollTop = exportFullGraph ? 0 : viewport.scrollTop;
  const first = exportFullGraph ? 0 : Math.max(0, Math.floor(scrollTop / rowHeight) - 3);
  const last = exportFullGraph ? rows.length : Math.min(rows.length, Math.ceil((scrollTop + viewport.clientHeight) / rowHeight) + 3);
  const canvasHeight = exportFullGraph ? totalHeight : Math.max(1, viewport.clientHeight);
  const indexById = new Map(rows.map((row, index) => [row.id, index]));
  space.style.width = `${width}px`;
  space.style.height = `${totalHeight}px`;
  canvas.setAttribute("width", String(width));
  canvas.setAttribute("height", String(canvasHeight));
  canvas.setAttribute("viewBox", `0 0 ${width} ${canvasHeight}`);
  canvas.style.top = `${exportFullGraph ? 0 : scrollTop}px`;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${canvasHeight}px`;
  canvas.textContent = "";

  for (let index = first; index < last; index++) {
    const row = rows[index];
    const x = 26 + row.depth * 220 * zoom;
    const y = index * rowHeight - scrollTop + (rowHeight - nodeHeight) / 2;
    if (row.kind === "file" && row.component) {
      const parentIndex = indexById.get(row.component.id);
      if (parentIndex !== undefined && parentIndex >= first && parentIndex < last) {
        const parentY = parentIndex * rowHeight - scrollTop + rowHeight / 2;
        canvas.appendChild(svg("path", {
          d: `M ${26 + nodeWidth} ${parentY} C ${26 + nodeWidth + 26 * zoom} ${parentY}, ${x - 26 * zoom} ${y + nodeHeight / 2}, ${x} ${y + nodeHeight / 2}`,
          class: "arch-edge",
        }));
      }
    }
    const active = row.kind === "component" ? selectedComponent === row.id : selectedPath === row.path;
    const group = svg("g", {
      class: `arch-node ${row.kind === "component" ? "directory" : "file"} ${active ? "selected" : ""}`,
      tabindex: "0",
      role: "button",
      "aria-label": `${row.kind}: ${row.label}`,
      "data-index": String(index),
    });
    group.appendChild(svg("rect", {
      x: String(x),
      y: String(y),
      width: String(nodeWidth),
      height: String(nodeHeight),
      rx: String(7 * zoom),
    }));
    const entry = row.path ? entryByPath.get(row.path) : undefined;
    const icon = row.kind === "component" ? "MOD" : entry ? entryIcon(entry) : "FILE";
    group.appendChild(svg("text", {
      x: String(x + 10 * zoom),
      y: String(y + 21 * zoom),
      class: `arch-icon ${row.kind === "component" ? "directory" : "file"}`,
      "font-size": String(9 * zoom),
    }, icon));
    if (row.kind === "component") {
      group.appendChild(svg("text", {
        x: String(x + 42 * zoom),
        y: String(y + 21 * zoom),
        class: "arch-toggle",
        "data-toggle": "true",
        "font-size": String(12 * zoom),
      }, expandedComponents.has(row.id) ? "▾" : "▸"));
    }
    const label = svg("text", {
      x: String(x + (row.kind === "component" ? 60 : 42) * zoom),
      y: String(y + 21 * zoom),
      class: "arch-label",
      "font-size": String(12 * zoom),
    }, row.kind === "component" ? `${row.label} · ${row.component?.files.length ?? 0}` : row.label);
    label.setAttribute("textLength", String(Math.min(nodeWidth - 72 * zoom, row.label.length * 7 * zoom)));
    label.setAttribute("lengthAdjust", "spacingAndGlyphs");
    group.appendChild(label);
    group.addEventListener("click", (event) => {
      if (row.kind === "component") {
        selectedComponent = row.id;
        selectedPath = "";
        if ((event.target as Element).closest("[data-toggle]")) {
          if (expandedComponents.has(row.id)) expandedComponents.delete(row.id);
          else expandedComponents.add(row.id);
          componentExpandedVersion++;
        }
      } else {
        selectedComponent = "";
        selectedPath = row.path ?? "";
      }
      render();
    });
    if (row.path) {
      group.addEventListener("dblclick", () => {
        selectedPath = row.path ?? "";
        void openSelected();
      });
    }
    group.addEventListener("keydown", (event) => moveGraphFocus(canvas, index, event));
    canvas.appendChild(group);
  }
  $("arch-summary").textContent = `${components.length} evidence-based components · ${components.reduce((total, component) => total + component.files.length, 0)} files grouped`;
  $("arch-export").toggleAttribute("disabled", rows.length === 0);
  $("arch-export-png").toggleAttribute("disabled", rows.length === 0);
  $("arch-focus").toggleAttribute("disabled", !selectedComponent);
  renderDetails();
}

function insightBadge(label: string, kind: string): HTMLSpanElement {
  const badge = document.createElement("span");
  badge.className = `insight-badge ${kind}`;
  badge.textContent = label;
  return badge;
}

function shortPath(path: string): string {
  const segments = path.replace(/\\/g, "/").split("/");
  return segments.slice(-2).join("/");
}

function setInsightTable(headers: string[], rows: (string | HTMLElement)[][], pathColumn = 0): void {
  const table = $("insight-table") as HTMLTableElement;
  const head = table.tHead ?? table.createTHead();
  head.textContent = "";
  const headerRow = head.insertRow();
  for (const header of headers) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = header;
    headerRow.appendChild(cell);
  }
  const body = table.tBodies[0] ?? table.createTBody();
  body.textContent = "";
  for (const row of rows) {
    const tr = body.insertRow();
    row.forEach((value, index) => {
      const cell = tr.insertCell();
      if (index === pathColumn) cell.className = "path";
      if (typeof value === "string") cell.textContent = value;
      else cell.appendChild(value);
    });
  }
}

function renderInsights(): void {
  const insight = isInsightMode(mode);
  const github = mode === "github";
  $("arch-find-text").toggleAttribute("disabled", insight || github);
  $("arch-content").classList.toggle("hidden", insight || github);
  $("arch-insights").classList.toggle("hidden", !insight);
  $("github-panel").classList.toggle("hidden", !github);
  $("arch-window").dataset.insight = String(insight || github);
  if (github) {
    renderGitHubPanel();
    return;
  }
  if (!insight) return;
  $("insight-budgets").style.display = mode === "performance" ? "flex" : "none";
  const summary = $("insight-summary");
  const note = $("insight-note");
  if (!scan) {
    summary.textContent = "Choose a project folder to explore.";
    note.textContent = "";
    setInsightTable(["Result"], [["No project selected"]]);
    return;
  }
  if (insightBusy) {
    summary.textContent = "Analyzing local files…";
    note.textContent = "";
    return;
  }

  if (mode === "performance") {
    if (!performanceReport) {
      summary.textContent = "No measurement yet. Refresh the project to run one.";
      setInsightTable(["Result"], [["No measurement available"]]);
      return;
    }
    const report = performanceReport;
    const rows = performanceRows(report, budgets);
    const counts = budgetCounts(rows);
    const worst = (row: (typeof rows)[number]) => {
      if (
        row.wall_status === "over" ||
        row.cpu_status === "over" ||
        row.bytes_status === "over"
      ) return "over";
      if (
        row.wall_status === "near" ||
        row.cpu_status === "near" ||
        row.bytes_status === "near"
      ) return "near";
      return "under";
    };
    summary.textContent =
      `${report.files_analyzed} files · ${report.wall_ms.toFixed(2)} ms wall · ${report.cpu_ms.toFixed(2)} ms CPU · ` +
      `peak process RAM ${(report.peak_rss_kb / 1024).toFixed(1)} MiB · ` +
      `${counts.over} over budget, ${counts.near} near`;
    note.textContent =
      "Measures Talos's real read and analysis cost per top-level component. CPU time is the process CPU used during this pass and peak RAM is process-wide; this does not measure your program's runtime. " +
      (report.warnings.length ? `Warnings: ${report.warnings.slice(0, 3).join(" · ")}` : "");
    setInsightTable(
      ["Component", "Files", "Source", "Wall", "CPU", "Status"],
      rows.map((row) => [
        row.name,
        String(row.files),
        `${(row.bytes / 1024).toFixed(1)} KB`,
        `${row.wall_ms.toFixed(2)} ms`,
        `${row.cpu_ms.toFixed(2)} ms`,
        insightBadge(worst(row), worst(row)),
      ]),
    );
    return;
  }

  if (mode === "sandbox") {
    const report = analyzeSandbox(manifestSet?.manifests ?? []);
    summary.textContent =
      `${report.manifests} manifests · ${report.declarations} declarations · ` +
      `${report.findings.filter((finding) => finding.severity === "critical").length} critical, ` +
      `${report.findings.filter((finding) => finding.severity === "warning").length} warnings`;
    note.textContent =
      "Read-only, offline check of dependency manifests and lockfiles. No project code is executed, nothing is installed, and no network is used. Conflicts are inferred from declarations only." +
      (manifestSet?.warnings.length ? ` Warnings: ${manifestSet.warnings.slice(0, 3).join(" · ")}` : "");
    setInsightTable(
      ["Severity", "Package", "Finding", "Sources"],
      report.findings.length
        ? report.findings.map((finding) => [
            insightBadge(finding.severity, finding.severity),
            finding.package || "—",
            finding.message,
            finding.sources.map(shortPath).join(", ") || "—",
          ])
        : [["—", "—", "No dependency declarations found in this project.", "—"]],
      3,
    );
    return;
  }

  if (!debtReport) {
    summary.textContent = "No analysis yet. Switch to Technical Debt to run one.";
    setInsightTable(["Result"], [["No analysis available"]]);
    return;
  }
  const report = debtReport;
  summary.textContent =
    `${report.files.length} files · ${report.totalLines.toLocaleString()} lines · ` +
    `average risk ${report.averageRisk} · ${report.hotspots.length} hotspots`;
  note.textContent =
    "Heuristic static metrics: branch count, repeated normalized lines, TODO/FIXME markers, and long lines. They flag places worth inspecting; they are not proof of a bug.";
  setInsightTable(
    ["File", "Lines", "Complexity", "Repeated", "Markers", "Long lines", "Risk"],
    report.files.map((file) => [
      shortPath(file.path),
      String(file.lines),
      String(file.complexity),
      String(file.duplicated),
      String(file.markers),
      String(file.longLines),
      insightBadge(`${file.level} ${file.risk}`, file.level.toLowerCase()),
    ]),
  );
}

async function loadInsights() {
  if (!scan || !isInsightMode(mode)) return;
  if (insightBusy) {
    // A project refresh or tab switch happened mid-load. Run it again once
    // the current invocation settles; otherwise its result can be stranded.
    insightRefreshPending = true;
    return;
  }
  const snapshot = scan;
  const requested = mode;
  const ready =
    requested === "performance" ? performanceReport !== null
    : requested === "sandbox" ? manifestSet !== null
    : debtReport !== null;
  if (ready) return;
  insightBusy = true;
  insightRefreshPending = false;
  setMessage("Analyzing project files locally…");
  renderInsights();
  try {
    const files = snapshot.entries.filter((entry) => entry.kind === "file");
    if (requested === "performance") {
      const paths = files.filter((entry) =>
        ["py", "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"].includes(entry.extension),
      ).map((entry) => entry.path);
      const report = await invoke<PerformanceMeasurement>("measure_project_components", {
        root: snapshot.root,
        paths,
      });
      if (scan !== snapshot) return;
      performanceReport = report;
    } else if (requested === "sandbox") {
      const names = new Set([
        "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
        "requirements.txt", "pyproject.toml", "cargo.toml", "cargo.lock", "go.mod", "go.sum",
      ]);
      const paths = files
        .filter((entry) => names.has(entry.name.toLowerCase()))
        .map((entry) => entry.path);
      const set = await invoke<ManifestSet>("load_project_manifests", {
        root: snapshot.root,
        paths,
      });
      if (scan !== snapshot) return;
      manifestSet = set;
    } else {
      const paths = files.filter((entry) =>
        ["py", "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"].includes(entry.extension),
      ).map((entry) => entry.path);
      const loaded = await invoke<{ sources: SourceLike[]; warnings: string[] }>(
        "load_project_sources",
        { root: snapshot.root, paths },
      );
      if (scan !== snapshot) return;
      debtReport = analyzeDebt(loaded.sources);
    }
    if (scan === snapshot) setMessage("Local insight analysis complete.");
  } catch (error) {
    if (scan === snapshot) setMessage(`Insight analysis failed: ${String(error)}`, true);
  } finally {
    insightBusy = false;
    renderInsights();
    if (insightRefreshPending && scan && isInsightMode(mode)) {
      const needed =
        mode === "performance" ? performanceReport === null
        : mode === "sandbox" ? manifestSet === null
        : debtReport === null;
      if (needed) void loadInsights();
    }
  }
}

function render() {
  scheduleExpandedSave();
  for (const button of document.querySelectorAll<HTMLElement>("[data-arch-mode]")) {
    button.classList.toggle("active", button.dataset.archMode === mode);
  }
  $("arch-focus").classList.toggle("active", focusMode);
  // Restore the graph panel (and hide the insights panel) on every mode
  // switch, not only when entering an insight tab.
  renderInsights();
  if (isInsightMode(mode) || mode === "github") return;
  renderGraph();
}

async function chooseProject() {
  const picked = await open({ multiple: false, directory: true });
  if (typeof picked === "string") await scanProject(picked, false, { lazy: true });
}

export async function chooseWorkspace() {
  await chooseProject();
}

async function loadRecentWorkspaces() {
  const select = document.getElementById("arch-recent") as HTMLSelectElement | null;
  if (!select) return;
  let items: RecentWorkspace[] = [];
  try {
    items = await invoke<RecentWorkspace[]>("list_recent_workspaces");
  } catch {
    return;
  }
  select.textContent = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = items.length ? "Recent projects" : "No recent projects";
  select.appendChild(placeholder);
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.path;
    option.textContent = item.name;
    option.title = item.path;
    select.appendChild(option);
  }
}

async function findInWorkspace() {
  if (!scan) {
    setMessage("Open a project before searching across its files.", true);
    return;
  }
  const snapshot = scan;
  const generation = scanGeneration;
  // A truncated scan is not a complete file list, so let the backend walk the
  // tree in that case instead of searching only the captured prefix.
  const snapshotPaths = snapshot.truncated || snapshot.lazy
    ? undefined
    : snapshot.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path);
  const query = window.prompt("Search text in all workspace files:");
  if (!query?.trim()) return;
  const summary = $("arch-details");
  summary.textContent = "Searching workspace files…";
  try {
    const matches = await invoke<WorkspaceTextMatch[]>("search_workspace_text", {
      root: snapshot.root,
      query,
      exclusions: currentExclusions(),
      showHidden,
      limit: 200,
      paths: snapshotPaths,
    });
    if (generation !== scanGeneration || scan !== snapshot) return;
    summary.textContent = "";
    const heading = document.createElement("strong");
    heading.textContent = `${matches.length}${matches.length === 200 ? "+" : ""} match${matches.length === 1 ? "" : "es"} for “${query}”`;
    summary.appendChild(heading);
    for (const match of matches) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "workspace-search-result";
      row.textContent = `${relativePath(match.path) || match.path}:${match.line}:${match.column}  ${match.text.trim()}`;
      row.title = match.path;
      row.addEventListener("click", () => {
        if (onOpenFile) void onOpenFile(match.path);
      });
      summary.appendChild(row);
    }
    if (!matches.length) summary.appendChild(document.createTextNode("No matching files."));
    setMessage(`Workspace text search finished with ${matches.length} result${matches.length === 1 ? "" : "s"}.`);
  } catch (error) {
    if (generation !== scanGeneration || scan !== snapshot) return;
    summary.textContent = "Search failed.";
    setMessage(`Workspace text search failed: ${String(error)}`, true);
  }
}

function showQuickOpenResults(results: ProjectEntry[], query: string) {
  const status = $("quick-open-status");
  const list = $("quick-open-results");
  list.textContent = "";
  const recents = !query.trim();
  status.textContent = recents
    ? results.length ? "Recently opened files" : "No recent files. Type to search the workspace."
    : `${results.length}${results.length === 100 ? "+" : ""} matching files`;
  quickOpenIndex = Math.min(quickOpenIndex, Math.max(0, results.length - 1));
  results.forEach((entry, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `workspace-result${index === quickOpenIndex ? " active" : ""}`;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(index === quickOpenIndex));
    const name = document.createElement("span");
    name.className = "workspace-result-name";
    name.textContent = entry.name;
    const path = document.createElement("span");
    path.className = "workspace-result-path";
    path.textContent = relativePath(entry.path);
    button.append(name, path);
    button.addEventListener("mouseenter", () => {
      quickOpenIndex = index;
      for (const [rowIndex, row] of [...list.children].entries()) {
        row.classList.toggle("active", rowIndex === index);
        row.setAttribute("aria-selected", String(rowIndex === index));
      }
    });
    button.addEventListener("click", () => void openQuickEntry(entry));
    list.appendChild(button);
  });
}

function updateQuickOpenIndex() {
  if (!scan || !quickOpenWorker) return;
  quickOpenWorker.postMessage({
    type: "index",
    entries: scan.entries
      .filter((entry) => entry.kind === "file" && (showHidden || !entry.name.startsWith(".")))
      .map(({ path, name, kind }) => ({ path, name, kind })),
  });
}

function renderQuickOpen() {
  const input = $("quick-open-input") as HTMLInputElement;
  const status = $("quick-open-status");
  $("quick-open-results").textContent = "";
  if (!scan) {
    status.textContent = "Open a project folder to search its files.";
    return;
  }
  if (!quickOpenWorker) {
    quickOpenWorker = new Worker(new URL("./project-search-worker.ts", import.meta.url), {
      type: "module",
    });
    quickOpenWorker.addEventListener("message", (event: MessageEvent<{
      requestId: number;
      results: { path: string }[];
    }>) => {
      if (event.data.requestId !== quickOpenRequestId) return;
      const results = event.data.results
        .map((item) => entryByPath.get(item.path))
        .filter((entry): entry is ProjectEntry => !!entry);
      showQuickOpenResults(results, quickOpenQuery);
    });
    quickOpenWorker.addEventListener("error", (event) => {
      status.textContent = `Quick Open search failed: ${event.message}`;
    });
    updateQuickOpenIndex();
  }
  quickOpenQuery = input.value;
  quickOpenIndex = 0;
  const requestId = ++quickOpenRequestId;
  status.textContent = "Searching workspace…";
  quickOpenWorker.postMessage({
    type: "search",
    requestId,
    query: quickOpenQuery,
    recentPaths: recentPaths(),
  });
}

async function openQuickEntry(entry: ProjectEntry) {
  if (!onOpenFile) return;
  try {
    await onOpenFile(entry.path);
    rememberRecent(entry.path);
    ($("quick-open-dialog") as HTMLDialogElement).close();
  } catch (error) {
    $("quick-open-status").textContent = `Could not open ${relativePath(entry.path)}: ${String(error)}`;
  }
}

export function openQuickOpen() {
  const dialog = $("quick-open-dialog") as HTMLDialogElement;
  closeOtherDialogs("quick-open-dialog");
  if (!dialog.open) dialog.showModal();
  const input = $("quick-open-input") as HTMLInputElement;
  input.value = "";
  quickOpenIndex = 0;
  const savedRoot = getWindowValue("talos.workspace-root");
  if (!scan && savedRoot && !busy) void scanProject(savedRoot, false, { lazy: true });
  if (scan?.lazy) {
    $("quick-open-status").textContent = "Indexing the full project for Quick Open…";
    void ensureFullScan().then(() => {
      if (!($("quick-open-dialog") as HTMLDialogElement).open) return;
      if (scan && quickOpenWorker) updateQuickOpenIndex();
      renderQuickOpen();
    });
  } else if (scan && quickOpenWorker) {
    updateQuickOpenIndex();
  }
  renderQuickOpen();
  input.focus();
}

interface ScanProjectOptions { lazy?: boolean; }
async function scanProject(root: string, forceWatch = false, options: ScanProjectOptions = {}): Promise<boolean> {
  if (busy) {
    queuedRoot = root;
    await new Promise<void>((resolve) => scanWaiters.push(resolve));
    return false;
  }
  busy = true;
  const generation = ++scanGeneration;
  markWorkspaceOpening(root);
  setMessage("Scanning project…");
  $("arch-refresh").setAttribute("disabled", "true");
  try {
    const changedRoot = scan?.root !== root;
    const previousExpanded = expanded;
    const result = options.lazy
      ? await invoke<ProjectDirectory>("list_project_directory", {
          root,
          path: root,
          exclusions: currentExclusions(),
          showHidden,
        }).then((listing) => ({
          id: listing.root,
          root: listing.root,
          entries: [
            { ...listing.entry, children_loaded: true },
            ...listing.entries.map((entry) => ({ ...entry, children_loaded: false })),
          ],
          warnings: listing.warnings,
          truncated: listing.truncated,
          lazy: true as const,
        }))
      : await invoke<ProjectScan>("scan_project", {
          root,
          exclusions: currentExclusions(),
          showHidden: showHidden,
        }).then((scanResult) => ({
          ...scanResult,
          lazy: false as const,
          entries: scanResult.entries.map((entry) => ({
            ...entry,
            children_loaded: entry.kind === "directory",
          })),
        }));
    if (generation !== scanGeneration) return false;
    scan = result;
    try {
      rememberWorkspaceRoot(result.root);
    } catch (error) {
      setMessage(`Project opened, but its location could not be remembered: ${String(error)}`, true);
    }
    void invoke("remember_workspace", { root: result.root })
      .then(() => loadRecentWorkspaces())
      .catch(() => undefined);
    document.dispatchEvent(new CustomEvent("talos:workspace-opened", { detail: result.root }));
    if (changedRoot) document.dispatchEvent(new Event("talos:workspace-change"));
    entryByPath = new Map(result.entries.map((entry) => [entry.path, entry]));
    updateQuickOpenIndex();
    dependencyResult = null;
    analyzedPaths = [];
    performanceReport = null;
    manifestSet = null;
    debtReport = null;
    components = mode === "architecture"
      ? classifyArchitecture(
          result.root,
          result.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path),
        )
      : [];
    selectedComponent = "";
    if (changedRoot && mode !== "github") {
      mode = "structure";
      focusMode = false;
      try {
        setWindowValue("talos.arch-mode", mode);
        setWindowValue("talos.arch-focus", "false");
      } catch {
        // Mode persistence is noncritical; scanning must still render.
      }
    }
    const directories = new Set(
      result.entries.filter((entry) => entry.kind === "directory").map((entry) => entry.path),
    );
    if (result.lazy) {
      expanded = changedRoot ? new Set([result.root]) : new Set(previousExpanded);
    } else {
      expanded = changedRoot
        ? new Set([result.root])
        : new Set([...previousExpanded].filter((path) => directories.has(path)));
    }
    expanded.add(result.root);
    expandedVersion++;
    cachedTreeRows = null;
    componentExpandedVersion++;
    cachedArchitectureRows = null;
    selectedPath = result.root;
    $("arch-root").textContent = result.root;
    let watcherWarning = "";
    let watcherStatus: "idle" | "active" | "error" = "idle";
    const policyKey = JSON.stringify([currentExclusions(), showHidden]);
    const newDirectories = !result.lazy && [...directories].some((path) => !watchedDirectories.has(path));
    if (forceWatch || watchedRoot !== result.root || newDirectories || watcherPolicyKey !== policyKey) {
      try {
        await invoke("watch_project", {
          root: result.root,
          exclusions: currentExclusions(),
          showHidden: showHidden,
          // A truncated or lazy scan has an incomplete directory list; fall back
          // to a real directory walk on the backend in that case.
          directories: result.truncated || result.lazy ? undefined : [...directories],
        });
        watchedRoot = result.root;
        watchedDirectories = result.lazy ? new Set() : directories;
        watcherPolicyKey = policyKey;
        watcherFailed = false;
        watcherRecoveryAttempts = 0;
        if (watcherRecoveryTimer) {
          window.clearTimeout(watcherRecoveryTimer);
          watcherRecoveryTimer = 0;
        }
        watcherStatus = "active";
      } catch (error) {
        watcherWarning = `Could not watch workspace changes: ${String(error)}`;
        watcherFailed = true;
        watcherStatus = "error";
      }
    } else if (watchedRoot === result.root && !watcherFailed) {
      watcherStatus = "active";
    }
    markWorkspaceReady(result, watcherStatus);
    const warnings = result.warnings.slice(0, 3).join(" · ");
    setMessage(
      `${result.entries.length.toLocaleString()} entries ${result.lazy ? "loaded" : "scanned"}${result.lazy ? " (folders load on expand)" : result.truncated ? " (limit reached)" : ""}${warnings ? ` · ${warnings}` : ""}${watcherWarning ? ` · ${watcherWarning}` : ""}`,
      result.warnings.length > 0 || !!watcherWarning
    );
    $("arch-graph-viewport").scrollTop = 0;
    render();
    if (result.lazy) void restoreLazyExpansion(scanGeneration);
    if (($("quick-open-dialog") as HTMLDialogElement).open) renderQuickOpen();
    if (mode === "dependencies") void analyzeCurrentProject();
    if (isInsightMode(mode)) void loadInsights();
    return true;
  } catch (error) {
    markWorkspaceError(root, error);
    setMessage(`Project scan failed: ${String(error)}`, true);
    if (($("quick-open-dialog") as HTMLDialogElement).open) {
      $("quick-open-status").textContent = `Project scan failed: ${String(error)}`;
    }
    return false;
  } finally {
    busy = false;
    $("arch-refresh").removeAttribute("disabled");
    if (queuedRoot) {
      const nextRoot = queuedRoot;
      queuedRoot = "";
      const waiters = scanWaiters.splice(0);
      void scanProject(nextRoot).finally(() => waiters.forEach((resolve) => resolve()));
    } else {
      scanWaiters.splice(0).forEach((resolve) => resolve());
    }
  }
}

function currentExclusions(): string[] {
  const field = $("arch-excludes") as HTMLInputElement;
  const configured = field.value.trim();
  return [...new Set((configured ? configured : DEFAULT_EXCLUSIONS.join(","))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean))];
}

async function analyzeCurrentProject() {
  if (!scan || analysisBusy || dependencyResult) return;
  const snapshot = scan;
  analysisBusy = true;
  setMessage("Reading supported source files locally…");
  render();
  try {
    const allFilePaths = snapshot.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path);
    const supportedExtensions = new Set(["py", "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"]);
    const sourcePaths = snapshot.entries
      .filter((entry) => entry.kind === "file" && supportedExtensions.has(entry.extension))
      .map((entry) => entry.path);
    const loaded = await invoke<{ sources: SourceFile[]; warnings: string[] }>("load_project_sources", {
      root: snapshot.root,
      paths: sourcePaths,
    });
    if (scan !== snapshot) return;
    analyzedPaths = loaded.sources.map((source) => source.path);
    dependencyResult = analyzeDependencies(scan.root, loaded.sources, allFilePaths);
    const warnings = loaded.warnings.slice(0, 3).join(" · ");
    setMessage(
      `${dependencyResult.analyzedFiles} source files analyzed; only statically resolved in-project imports are shown.${warnings ? ` ${warnings}` : ""}`,
      loaded.warnings.length > 0
    );
  } catch (error) {
    setMessage(`Dependency analysis failed: ${String(error)}`, true);
  } finally {
    analysisBusy = false;
    render();
    if (scan && scan !== snapshot && mode === "dependencies") void analyzeCurrentProject();
  }
}

function setMode(next: ArchMode) {
  mode = next;
  setWindowValue("talos.arch-mode", next);
  focusMode = false;
  setWindowValue("talos.arch-focus", "false");
  $("arch-focus").classList.remove("active");
  const needsFullTree = next === "dependencies" || next === "architecture" || isInsightMode(next);
  if (needsFullTree && scan?.lazy) {
    render();
    void ensureFullScan();
    return;
  }
  if (next === "architecture" && scan) {
    components = classifyArchitecture(
      scan.root,
      scan.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path),
    );
    expandedComponents = new Set();
    componentExpandedVersion++;
    selectedComponent = components[0]?.id ?? "";
  }
  render();
  if (next === "dependencies") void analyzeCurrentProject();
  if (isInsightMode(next)) void loadInsights();
}

async function ensureFullScan(): Promise<boolean> {
  if (!scan?.lazy) return !!scan;
  return scanProject(scan.root, false, { lazy: false });
}

function graphNodeCount(): number {
  const query = ($("arch-search") as HTMLInputElement).value.trim().toLowerCase();
  if (mode === "structure") return visibleEntries().length;
  if (mode === "dependencies") {
    let paths = analyzedPaths.filter((path) => !query || path.toLowerCase().includes(query));
    if (focusMode && selectedPath && dependencyResult) {
      const selected = normalizedPath(selectedPath);
      const related = new Set([selected]);
      for (const edge of dependencyResult.edges) {
        if (edge.from === selected) related.add(edge.to);
        if (edge.to === selected) related.add(edge.from);
      }
      paths = paths.filter((path) => related.has(normalizedPath(path)));
    }
    return paths.length;
  }
  return components.reduce((total, component) => {
    const files = component.files.filter((path) => !query || path.toLowerCase().includes(query));
    const matchesComponent = !query || `${component.label} ${component.evidence.join(" ")}`.toLowerCase().includes(query);
    if ((!matchesComponent && files.length === 0) || (focusMode && selectedComponent !== component.id)) return total;
    return total + 1 + (expandedComponents.has(component.id) || (!!query && files.length > 0) ? files.length : 0);
  }, 0);
}

function createExportClone(maxNodes: number): SVGSVGElement | null {
  const count = graphNodeCount();
  if (count === 0) {
    setMessage("There is no graph content to export.", true);
    return null;
  }
  if (count > maxNodes) {
    setMessage(`Export is limited to ${maxNodes.toLocaleString()} visible nodes. Search or collapse folders first.`, true);
    return null;
  }
  const viewport = $("arch-graph-viewport");
  const scrollTop = viewport.scrollTop;
  const scrollLeft = viewport.scrollLeft;
  exportFullGraph = true;
  try {
    renderGraph();
    const canvas = $("arch-graph") as unknown as SVGSVGElement;
    const clone = canvas.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", NS);
    clone.insertBefore(svg("style", {}, `
      .arch-edge{fill:none;stroke:#8b8f98;stroke-width:1.4}
      .arch-edge.circular{stroke:#ff5555;stroke-width:2}
      .arch-edge.connected{stroke:#c9863a;stroke-width:2}
      .arch-arrow{fill:#8db4e2}
      .arch-node rect{fill:#1b1e24;stroke:#2a2e36;stroke-width:1.2}
      .arch-node.directory rect{fill:#29241e}
      .arch-node.selected rect{fill:#3b3024;stroke:#c9863a;stroke-width:2}
      .arch-node.connected-node rect{stroke:#c9863a}
      .arch-label{fill:#e8e6e1;font:12px system-ui,sans-serif}
      .arch-icon{fill:#8db4e2;font:700 9px monospace}
      .arch-icon.directory{fill:#c9863a}
      .arch-toggle{fill:#8b8f98}
    `), clone.firstChild);
    return clone;
  } finally {
    exportFullGraph = false;
    renderGraph();
    viewport.scrollTo({ top: scrollTop, left: scrollLeft });
  }
}

function exportSvg() {
  const clone = createExportClone(10_000);
  if (!clone) return;
  const viewport = $("arch-graph-viewport");
  clone.setAttribute("width", clone.getAttribute("width") ?? String(viewport.clientWidth));
  const blob = new Blob([new XMLSerializer().serializeToString(clone)], {
    type: "image/svg+xml;charset=utf-8",
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${scan?.entries[0]?.name ?? "talos-project"}.svg`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function exportPng() {
  const maxPngNodes = Math.min(1_000, Math.floor(24_000 / (ROW_HEIGHT * zoom)));
  const clone = createExportClone(maxPngNodes);
  if (!clone) return;
  const source = new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" });
  const image = await createImageBitmap(source);
  const output = document.createElement("canvas");
  const scale = Math.min(1, 16_000 / image.width, 24_000 / image.height);
  output.width = Math.max(1, Math.floor(image.width * scale));
  output.height = Math.max(1, Math.floor(image.height * scale));
  const context = output.getContext("2d");
  if (!context) throw new Error("Could not create an image export canvas.");
  context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--bg");
  context.fillRect(0, 0, output.width, output.height);
  context.drawImage(image, 0, 0, output.width, output.height);
  image.close();
  const blob = await new Promise<Blob>((resolve, reject) =>
    output.toBlob((result) => result ? resolve(result) : reject(new Error("Could not encode PNG export.")), "image/png"),
  );
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${scan?.entries[0]?.name ?? "talos-project"}.png`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

function notifyWorkspaceFilesChanged(root: string, paths: string[]) {
  document.dispatchEvent(new CustomEvent("talos:workspace-files-changed", {
    detail: { root, paths },
  }));
  if (chronicleIndexTimer) window.clearTimeout(chronicleIndexTimer);
  chronicleIndexTimer = window.setTimeout(() => {
    chronicleIndexTimer = 0;
    if (scan?.root !== root) return;
    void invoke<ChronicleIndexJob>("chronicle_index_on_workspace_change", { root })
      .then((job) => {
        if (!job?.accepted || typeof job.jobId !== "number") return;
        markWorkspaceIndexing("indexing");
        document.dispatchEvent(new CustomEvent("talos:chronicle-index-queued", { detail: job }));
      })
      .catch(() => undefined);
  }, 700);
}

async function applyWorkspaceChanges(payload: WorkspaceChangeEvent) {
  if (!scan || scan.root !== payload.root || payload.changes.length === 0) return;
  const root = scan.root;
  const generation = scanGeneration;
  const paths = payload.changes.map((change) => change.path);
  if (payload.changes.some((change) => change.kind === "__talos_rescan__")) {
    void refreshTree(root, true);
    return;
  }
  if (payload.changes.some((change) => entryByPath.get(change.path)?.kind === "directory")) {
    notifyWorkspaceFilesChanged(root, paths);
    void refreshTree(root, true);
    return;
  }
  const metadata = await Promise.all(payload.changes.map(async (change) => {
    if (change.kind === "delete") return null;
    try {
      return await invoke<ProjectEntry | null>("workspace_entry_metadata", {
        root,
        path: change.path,
        exclusions: currentExclusions(),
        showHidden,
      });
    } catch {
      // A transient inspection error is not evidence that the entry vanished.
      return undefined;
    }
  }));
  if (generation !== scanGeneration || !scan || scan.root !== root) return;

  let entries = scan.entries.slice();
  let fullScanNeeded = false;
  let changed = false;
  for (let index = 0; index < payload.changes.length; index++) {
    const change = payload.changes[index];
    const existingIndex = entries.findIndex((entry) => entry.path === change.path);
    const existing = existingIndex >= 0 ? entries[existingIndex] : undefined;
    const fresh = metadata[index];
    if (fresh === undefined) continue;
    if (fresh?.kind === "directory" || existing?.kind === "directory") {
      fullScanNeeded = true;
      break;
    }
    if (fresh) {
      if (existingIndex >= 0) entries[existingIndex] = fresh;
      else entries.push(fresh);
      changed = true;
    } else if (existingIndex >= 0) {
      entries.splice(existingIndex, 1);
      changed = true;
    }
  }
  if (fullScanNeeded) {
    notifyWorkspaceFilesChanged(root, paths);
    void refreshTree(root, true);
    return;
  }
  if (!changed) return;
  scan = { ...scan, entries };
  entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  dependencyResult = null;
  analyzedPaths = [];
  components = mode === "architecture"
    ? classifyArchitecture(
        root,
        entries.filter((entry) => entry.kind === "file").map((entry) => entry.path),
      )
    : [];
  performanceReport = null;
  manifestSet = null;
  debtReport = null;
  cachedTreeRows = null;
  updateQuickOpenIndex();
  render();
  if (($("quick-open-dialog") as HTMLDialogElement).open) renderQuickOpen();
  notifyWorkspaceFilesChanged(root, paths);
}

async function restoreWorkspace(): Promise<void> {
  const candidates = await workspaceRestoreCandidates();
  for (const root of candidates) {
    if (await scanProject(root, false, { lazy: true })) return;
  }
  if (candidates.length > 0) {
    setMessage("No saved workspace could be opened. Choose a project folder.", true);
  }
}

export function initArchitectureExplorer(
  openFile: (path: string) => Promise<void>,
  onPathChange?: (oldPath: string, newPath: string | null) => void,
  decorationForPath?: (path: string) => FileDecoration | null
) {
  onOpenFile = openFile;
  onWorkspacePathChange = onPathChange;
  getFileDecoration = decorationForPath;
  initGitHubPanel();
  const showArchitecture = () => {
    showArchitectureWindow();
    if (!scan) void chooseProject();
    else void refreshTree(scan.root);
  };
  $("btn-architecture").addEventListener("click", showArchitecture);
  const closeExplorer = () => {
    explorerOpen = false;
    setWindowValue("talos.explorer-open", "false");
    $("architecture").classList.add("hidden");
    document.dispatchEvent(new Event("talos:explorer-close"));
    if (refreshTimer) window.clearTimeout(refreshTimer);
    refreshTimer = 0;
  };
  $("arch-close").addEventListener("click", closeExplorer);
  $("arch-open-project").addEventListener("click", () => void chooseProject());
  const recent = document.getElementById("arch-recent") as HTMLSelectElement | null;
  if (recent) {
    recent.addEventListener("change", () => {
      const path = recent.value;
      recent.value = "";
      if (path) openWorkspace(path);
    });
    void loadRecentWorkspaces();
  }
  $("arch-refresh").addEventListener("click", () => {
    if (scan) void refreshTree(scan.root);
    else void chooseProject();
  });
  $("arch-find-text").addEventListener("click", () => void findInWorkspace());
  $("arch-search").addEventListener("input", () => {
    if (archSearchTimer) window.clearTimeout(archSearchTimer);
    archSearchTimer = window.setTimeout(() => {
      archSearchTimer = 0;
      cachedTreeRows = null;
      render();
    }, 120);
  });
  const budgetFields: [string, keyof Budgets, number, string][] = [
    ["insight-budget-wall", "wall_ms", 1, "talos.insight-budget-wall"],
    ["insight-budget-cpu", "cpu_ms", 1, "talos.insight-budget-cpu"],
    ["insight-budget-bytes", "bytes", 1024, "talos.insight-budget-bytes"],
  ];
  for (const [id, key, scale, storageKey] of budgetFields) {
    const input = $(id) as HTMLInputElement;
    input.value = String(Math.round(budgets[key] / scale));
    input.addEventListener("change", () => {
      const value = Number(input.value);
      if (!Number.isFinite(value) || value <= 0) {
        input.value = String(Math.round(budgets[key] / scale));
        return;
      }
      budgets = { ...budgets, [key]: value * scale };
      setWindowValue(storageKey, String(budgets[key]));
      renderInsights();
    });
  }
  const exclusions = $("arch-excludes") as HTMLInputElement;
  exclusions.value = getWindowValue("talos-architecture-exclusions") ?? DEFAULT_EXCLUSIONS.join(", ");
  exclusions.addEventListener("change", () => {
    setWindowValue("talos-architecture-exclusions", exclusions.value);
    if (scan) void refreshTree(scan.root);
  });
  const hiddenToggle = $("arch-show-hidden") as HTMLInputElement;
  hiddenToggle.checked = showHidden;
  hiddenToggle.addEventListener("change", () => {
    showHidden = hiddenToggle.checked;
    try {
      setWindowValue("talos.show-hidden-files", String(showHidden));
    } catch (error) {
      setMessage(`Could not save hidden-file preference: ${String(error)}`, true);
    }
    render();
    updateQuickOpenIndex();
    if (($("quick-open-dialog") as HTMLDialogElement).open) renderQuickOpen();
  });
  $("btn-quick-open").addEventListener("click", openQuickOpen);
  $("quick-open-close").addEventListener("click", () =>
    ($("quick-open-dialog") as HTMLDialogElement).close(),
  );
  $("quick-open-dialog").addEventListener("close", () => {
    document.querySelector<HTMLElement>("#editor .cm-content")?.focus();
  });
  $("quick-open-input").addEventListener("input", () => {
    quickOpenIndex = 0;
    if (quickOpenTimer) window.clearTimeout(quickOpenTimer);
    quickOpenTimer = window.setTimeout(() => {
      quickOpenTimer = 0;
      renderQuickOpen();
    }, 80);
  });
  $("quick-open-input").addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      ($("quick-open-dialog") as HTMLDialogElement).close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
    const rows = [...$("quick-open-results").querySelectorAll<HTMLButtonElement>(".workspace-result")];
    if (event.key === "Enter") {
      event.preventDefault();
      if (rows[quickOpenIndex]) rows[quickOpenIndex].click();
      return;
    }
    if (rows.length === 0) return;
    event.preventDefault();
    quickOpenIndex = (quickOpenIndex + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
    rows.forEach((row, index) => {
      row.classList.toggle("active", index === quickOpenIndex);
      row.setAttribute("aria-selected", String(index === quickOpenIndex));
    });
    rows[quickOpenIndex].scrollIntoView({ block: "nearest" });
  });
  $("quick-open-project").addEventListener("click", () => {
    ($("quick-open-dialog") as HTMLDialogElement).close();
    explorerOpen = true;
    setWindowValue("talos.explorer-open", "true");
    $("architecture").classList.remove("hidden");
    void chooseProject();
  });
  for (const button of document.querySelectorAll<HTMLElement>("[data-arch-mode]")) {
    button.addEventListener("click", () => {
      const selected = button.dataset.archMode;
      if (
        typeof selected === "string" &&
        (selected === "structure" ||
          selected === "dependencies" ||
          selected === "architecture" ||
          selected === "github" ||
          isInsightMode(selected))
      ) {
        setMode(selected);
      }
    });
  }
  $("arch-zoom-in").addEventListener("click", () => {
    zoom = Math.min(1.8, zoom + 0.1);
    setWindowValue("talos.arch-zoom", String(zoom));
    render();
  });
  $("arch-zoom-out").addEventListener("click", () => {
    zoom = Math.max(0.6, zoom - 0.1);
    setWindowValue("talos.arch-zoom", String(zoom));
    render();
  });
  $("arch-fit").addEventListener("click", () => {
    zoom = 1;
    setWindowValue("talos.arch-zoom", String(zoom));
    $("arch-graph-viewport").scrollTo({ top: 0, left: 0 });
    render();
  });
  $("arch-export").addEventListener("click", exportSvg);
  $("arch-export-png").addEventListener("click", () => {
    void exportPng().catch((error: unknown) => setMessage(`PNG export failed: ${String(error)}`, true));
  });
  $("arch-focus").addEventListener("click", () => {
    focusMode = !focusMode;
    setWindowValue("talos.arch-focus", String(focusMode));
    $("arch-focus").classList.toggle("active", focusMode);
    render();
  });
  const viewport = $("arch-graph-viewport");
  viewport.addEventListener("scroll", () => {
    if (mode === "structure" && !exportFullGraph) {
      if (treeScrollFrame) return;
      treeScrollFrame = window.requestAnimationFrame(() => {
        treeScrollFrame = 0;
        renderFileTree();
      });
    } else {
      renderGraph();
    }
  }, { passive: true });
  viewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 1 && !(spaceHeld && event.target === viewport)) return;
    panStart = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add("panning");
    event.preventDefault();
  });
  viewport.addEventListener("pointermove", (event) => {
    if (!panStart) return;
    viewport.scrollLeft = panStart.left - (event.clientX - panStart.x);
    viewport.scrollTop = panStart.top - (event.clientY - panStart.y);
  });
  const endPan = (event: PointerEvent) => {
    if (!panStart) return;
    panStart = null;
    viewport.classList.remove("panning");
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
  };
  viewport.addEventListener("pointerup", endPan);
  viewport.addEventListener("pointercancel", endPan);
  window.addEventListener("resize", renderGraph);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      if (closeTopmostDialog()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      // A protected confirmation dialog is still open; don't close the view
      // underneath it as a side effect of Escape.
      if (document.querySelector("dialog[open]")) return;
      if (explorerOpen) {
        event.preventDefault();
        closeExplorer();
        return;
      }
    }
    if (event.code === "Space" && !(event.target instanceof HTMLInputElement)) spaceHeld = true;
  });
  document.addEventListener("keyup", (event) => {
    if (event.code === "Space") spaceHeld = false;
  });
  void listen<WorkspaceChangeEvent>("architecture://changed", (event) => {
    if (!scan || event.payload.root !== scan.root) return;
    if (refreshTimer) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      refreshTimer = 0;
      void applyWorkspaceChanges(event.payload);
    }, 180);
  }).catch((error: unknown) => setMessage(`Could not subscribe to project changes: ${String(error)}`, true));
  void listen<string>("architecture://watch-error", (event) => {
    watcherFailed = true;
    markWorkspaceWatcher("error");
    setMessage(`Project watcher error: ${event.payload}`, true);
    const root = scan?.root;
    if (!root || watcherRecoveryTimer || watcherRecoveryAttempts >= 3) {
      if (watcherRecoveryAttempts >= 3) {
        setMessage("Project watcher stopped after repeated errors. Use Refresh to resume.", true);
      }
      return;
    }
    watcherRecoveryAttempts++;
    const delay = 1000 * 2 ** (watcherRecoveryAttempts - 1);
    watcherRecoveryTimer = window.setTimeout(() => {
      watcherRecoveryTimer = 0;
      if (scan?.root !== root) return;
      void invoke("watch_project", {
        root,
        exclusions: currentExclusions(),
        showHidden,
        directories: scan?.truncated || scan?.lazy
          ? undefined
          : [...new Set(scan?.entries.filter((entry) => entry.kind === "directory").map((entry) => entry.path) ?? [])],
      }).then(() => {
        watcherFailed = false;
        watcherRecoveryAttempts = 0;
        markWorkspaceWatcher("active");
        setMessage("Project watcher reconnected.");
      }).catch((error: unknown) => {
        setMessage(`Could not reconnect project watcher: ${String(error)}`, true);
      });
    }, delay);
  }).catch((error: unknown) => setMessage(`Could not subscribe to watcher errors: ${String(error)}`, true));
  void restoreWorkspace();
  $("architecture").classList.toggle("hidden", !explorerOpen);
  render();
}

export function openWorkspace(root: string) {
  showArchitectureWindow();
  void scanProject(root, false, { lazy: true });
}

export function openRecentWorkspace() {
  showArchitectureWindow();
  window.setTimeout(() => ($("arch-recent") as HTMLSelectElement | null)?.focus(), 0);
}

export function openObservatory() {
  setMode("dependencies");
  showArchitectureWindow();
  if (!scan) {
    const savedRoot = workspaceRoot();
    if (savedRoot) void scanProject(savedRoot);
    else void chooseProject();
  }
}
