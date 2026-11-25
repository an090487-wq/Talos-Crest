// Extension manager + marketplace + API market (no accounts, no servers needed).
// A "registry" is just a JSON index file: a local path or a public URL.
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import type { ThemeDef } from "./theme";

export interface ActiveIconPack {
  id: string;
  default: string;
  mappings: Record<string, string>;
}

export interface Hooks {
  setTheme: (def: ThemeDef | null) => void;
  setIconPack: (pack: ActiveIconPack | null) => void;
  newFromTemplate: (filename: string, content: string) => Promise<void>;
  insertText: (text: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringMap(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!isRecord(value)) return result;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") result[key] = item;
  }
  return result;
}

interface Manifest {
  id: string;
  name: string;
  kind: string;
  version: string;
  author?: string;
  publisher?: string;
  description?: string;
  enabled?: boolean;
  grantedPermissions?: string[];
  permissions?: string[];
  rollbackAvailable?: boolean;
  rollbackVersion?: string;
  language?: { run?: string };
  snippets?: SnippetDef[];
  iconPack?: { default?: string; mappings?: Record<string, string> };
  [k: string]: unknown;
}

export interface SnippetDef {
  prefix: string;
  body: string;
  label?: string;
  description?: string;
  languages?: string[];
}

interface ExternalRequirement {
  name: string;
  kind: "executable" | "system-tool" | "service" | "python-module";
  description: string;
  required: boolean;
}

interface IndexEntry {
  id: string;
  name: string;
  kind: string;
  version?: string;
  author?: string;
  publisher?: string;
  description?: string;
  category?: string;
  categories?: string[];
  compatibility?: string;
  dependencies?: string[];
  permissions?: string[];
  license?: string;
  changelog?: string;
  screenshots?: string[];
  updatedAt?: string;
  featured?: boolean;
  curatedRank?: number;
  free?: boolean;
  features?: string[];
  externalExecutables?: ExternalRequirement[];
  url: string;
  sha256: string;
}

interface DependencyStatus {
  available: boolean;
  detail: string;
}

type DependencyState = "none" | "available" | "missing" | "checking" | "unknown";

interface DependencyCheckRequest {
  name: string;
  kind: ExternalRequirement["kind"];
}

interface DependencyCheckResult {
  name: string;
  available: boolean;
  detail: string;
}

interface ApiEntry {
  id: string;
  name: string;
  description?: string;
  docs?: string;
  auth?: string;
  baseUrl?: string;
  snippets?: Record<string, string>;
}

interface RegistryDoc {
  name?: string;
  extensions?: IndexEntry[];
  apis?: ApiEntry[];
}

interface TemplateDef {
  label: string;
  filename: string;
  content: string;
}

interface Settings {
  registry?: string;
  theme?: string;
  iconPack?: string;
}

type MTab = "extensions" | "apis" | "installed" | "templates";

interface ExtensionCategory {
  id: string;
  name: string;
  description: string;
  icon: string;
}

const categories: ExtensionCategory[] = [
  { id: "programming-languages", name: "Programming Languages", description: "Language bundles and run configurations.", icon: "⌘" },
  { id: "snippets", name: "Snippets", description: "Free, open-source code snippet packs.", icon: "⌁" },
  { id: "themes", name: "Themes", description: "Editor and workspace appearance.", icon: "◐" },
  { id: "icon-packs", name: "Icon Packs", description: "File and workspace icon sets.", icon: "▧" },
  { id: "code-formatting", name: "Code Formatting", description: "Format source files and selections.", icon: "⇥" },
  { id: "linters-diagnostics", name: "Linters and Diagnostics", description: "Static checks and editor diagnostics.", icon: "✓" },
  { id: "debugging", name: "Debugging", description: "Debug adapters and launch support.", icon: "◉" },
  { id: "git-version-control", name: "Git and Version Control", description: "Repository status and history tools.", icon: "⑂" },
  { id: "productivity", name: "Productivity", description: "Templates and focused workflow helpers.", icon: "▣" },
  { id: "documentation", name: "Documentation", description: "Documentation authoring and preview tools.", icon: "¶" },
  { id: "database-tools", name: "Database Tools", description: "Local database inspection and queries.", icon: "▤" },
  { id: "api-development", name: "API Development", description: "API snippets and request workflows.", icon: "⇄" },
  { id: "developer-utilities", name: "Developer Utilities", description: "Small tools for everyday development.", icon: "⚙" },
  { id: "learning-education", name: "Learning and Education", description: "Learning resources and guided examples.", icon: "◇" },
  { id: "extension-packs", name: "Extension Packs", description: "Curated sets of Talos extensions.", icon: "▦" },
  { id: "web-development", name: "Web Development", description: "Frontend, backend, and browser workflow tools.", icon: "◈" },
  { id: "security", name: "Security", description: "Local security and privacy tooling.", icon: "⛨" },
  { id: "database-api", name: "Database and API", description: "Database clients and API development helpers.", icon: "▥" },
  { id: "ai-ml", name: "AI and ML", description: "Local AI and machine learning workflows.", icon: "✧" },
  { id: "linux-sysadmin", name: "Linux Sysadmin", description: "Linux administration and system utilities.", icon: "⌘" },
  { id: "design-creative", name: "Design and Creative", description: "Design assets and creative workflows.", icon: "✎" },
  { id: "talos-exclusive", name: "Talos Exclusive", description: "Extensions built specifically for Talos.", icon: "◆" },
];

let hooks: Hooks;
let settings: Settings = {};
let initialization: Promise<void> = Promise.resolve();
let registry: RegistryDoc | null = null;
let installed: Manifest[] = [];
let tab: MTab = "extensions";
let selectedCategory: string | null = null;
let selectedDetails: IndexEntry | null = null;

// Read-only dependency detection results, keyed by requirement kind + name.
const dependencyStatuses = new Map<string, DependencyStatus>();
const dependencyChecks = new Set<string>();
const dependencyAttempted = new Set<string>();
const dependencyErrors = new Map<string, string>();

function requirementKey(name: string, kind: ExternalRequirement["kind"]): string {
  return JSON.stringify([kind, name]);
}

function entryRequirements(entry: IndexEntry): ExternalRequirement[] {
  return entry.externalExecutables ?? [];
}

function dependencyState(entry: IndexEntry): DependencyState {
  const requirements = entryRequirements(entry);
  if (!requirements.length) return "none";
  let missing = false;
  let unknown = false;
  for (const requirement of requirements) {
    const key = requirementKey(requirement.name, requirement.kind);
    if (dependencyChecks.has(key)) {
      unknown = true;
      continue;
    }
    const status = dependencyStatuses.get(key);
    if (!status) {
      unknown = true;
    } else if (!status.available) {
      missing = true;
    }
  }
  if (missing) return "missing";
  return unknown ? "unknown" : "available";
}

function warningRequirements(entry: IndexEntry): ExternalRequirement[] {
  const state = dependencyState(entry);
  if (state === "available" || state === "none") return [];
  return entryRequirements(entry).filter((requirement) => {
    const status = dependencyStatuses.get(requirementKey(requirement.name, requirement.kind));
    return !status || !status.available || dependencyChecks.has(requirementKey(requirement.name, requirement.kind));
  });
}

// Fire-and-forget: Talos only checks for local requirements; it never runs extension code.
function requestDependencyStatuses(entries: IndexEntry[]): void {
  const requested: DependencyCheckRequest[] = [];
  for (const entry of entries) {
    for (const requirement of entryRequirements(entry)) {
      const key = requirementKey(requirement.name, requirement.kind);
      if (dependencyChecks.has(key) || dependencyAttempted.has(key)) continue;
      dependencyChecks.add(key);
      dependencyAttempted.add(key);
      requested.push({ name: requirement.name, kind: requirement.kind });
    }
  }
  if (!requested.length) return;
  void (async () => {
    try {
      const results = await invoke<DependencyCheckResult[]>("ext_check_dependencies", {
        requirements: requested,
      });
      results.forEach((result, index) => {
        const sameName = requested.filter((candidate) => candidate.name === result.name);
        const request = sameName.length === 1 ? sameName[0] : requested[index];
        if (!request) return;
        dependencyStatuses.set(requirementKey(request.name, request.kind), {
          available: result.available === true,
          detail: typeof result.detail === "string" ? result.detail : "",
        });
      });
      for (const entry of entries) dependencyErrors.delete(entry.id);
    } catch (e) {
      const message = String(e);
      for (const entry of entries) {
        if (entryRequirements(entry).length) dependencyErrors.set(entry.id, message);
      }
    } finally {
      for (const request of requested) dependencyChecks.delete(requirementKey(request.name, request.kind));
    }
    const marketOpen = !$("market").classList.contains("hidden");
    if (
      (selectedDetails && entries.some((entry) => entry.id === selectedDetails?.id)) ||
      (marketOpen && tab === "extensions" && !selectedDetails)
    ) {
      render();
    }
  })();
}

const $ = (id: string) => document.getElementById(id)!;
const isHttp = (s: string) => /^https?:\/\//i.test(s);

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = "",
  text = ""
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function setMsg(t: string) {
  $("market-msg").textContent = t;
}

async function run(fn: () => void | Promise<void>) {
  try {
    setMsg("");
    await fn();
  } catch (e) {
    setMsg(String(e));
  }
}

function btn(label: string, onClick: () => void | Promise<void>, cls = ""): HTMLButtonElement {
  const b = el("button", ("mini " + cls).trim(), label);
  b.addEventListener("click", () => void run(onClick));
  return b;
}

function card(title: string, badge: string, meta: string, desc: string, actions: HTMLElement[], warning = "") {
  const c = el("div", "card");
  const top = el("div", "card-top");
  top.append(el("span", "card-title", title), el("span", "badge", badge));
  c.append(top, el("div", "card-meta", meta), el("div", "card-desc", desc));
  if (warning) c.appendChild(el("div", "market-warning", warning));
  const act = el("div", "card-actions");
  act.append(...actions);
  c.append(act);
  return c;
}

function note(list: HTMLElement, text: string) {
  list.appendChild(el("div", "note", text));
}

// ---------- sources ----------
async function fetchSource(src: string): Promise<string> {
  if (isHttp(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error("HTTP " + res.status + " for " + src);
    return await res.text();
  }
  if (src.startsWith("asset://")) return await readTextFile(src);
  return await invoke<string>("read_file", { path: src });
}

function resolveRel(base: string, rel: string): string {
  if (isHttp(rel)) return rel;
  if (isHttp(base)) return new URL(rel, base).href;
  if (rel.startsWith("/")) return rel;
  return base.slice(0, base.lastIndexOf("/") + 1) + rel;
}

// ---------- settings + installed ----------
async function loadSettings() {
  const text = await invoke<string | null>("settings_read");
  if (text) {
    try {
      settings = JSON.parse(text) as Settings;
    } catch (error) {
      throw new Error("Could not parse Talos extension settings: " + String(error));
    }
  } else {
    settings = {};
  }
  if (!settings.registry) settings.registry = await invoke<string>("default_registry");
}

async function saveSettings() {
  await invoke("settings_write", { contents: JSON.stringify(settings, null, 2) });
}

async function refreshInstalled() {
  installed = await invoke<Manifest[]>("ext_list");
}

export function installedSnippets(): SnippetDef[] {
  const snippets: SnippetDef[] = [];
  for (const extension of installed) {
    if (!extension.enabled || extension.kind !== "snippets") continue;
    snippets.push(...(extension.snippets ?? []));
  }
  return snippets;
}

async function loadRegistry() {
  const text = await fetchSource(settings.registry ?? "");
  const parsed = JSON.parse(text) as RegistryDoc;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.extensions)) {
    throw new Error("Registry must contain an extensions array.");
  }
  const ids = new Set<string>();
  for (const entry of parsed.extensions) {
    if (
      !entry ||
      typeof entry.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(entry.id) ||
      ids.has(entry.id) ||
      typeof entry.name !== "string" ||
      typeof entry.kind !== "string" ||
      typeof entry.version !== "string" ||
      !validVersion(entry.version) ||
      typeof entry.url !== "string" ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(entry.sha256)
    ) {
      throw new Error("Registry contains an invalid or duplicate extension entry.");
    }
    ids.add(entry.id);
  }
  registry = parsed;
}

function extensionCategory(entry: IndexEntry): string | null {
  if (entry.category && categories.some((category) => category.id === entry.category)) {
    return entry.category;
  }
  const listed = entry.categories?.find((id) => categories.some((category) => category.id === id));
  if (listed) return listed;
  if (entry.kind === "language") return "programming-languages";
  if (entry.kind === "snippets") return "snippets";
  if (entry.kind === "theme") return "themes";
  if (entry.kind === "template") return "productivity";
  if (entry.kind === "extension-pack") return "extension-packs";
  if (entry.kind === "icon-pack") return "icon-packs";
  return null;
}

function entryMatchesCategory(entry: IndexEntry, categoryId: string): boolean {
  return extensionCategory(entry) === categoryId || (entry.categories ?? []).includes(categoryId);
}

function categoryEntries(categoryId: string): IndexEntry[] {
  return (registry?.extensions ?? []).filter((entry) => entryMatchesCategory(entry, categoryId));
}

function validVersion(version: string): boolean {
  const match = version.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/
  );
  if (!match) return false;
  const prerelease = match[4]?.split(".") ?? [];
  const build = match[5]?.split(".") ?? [];
  return (
    prerelease.every(
      (part) =>
        part.length > 0 &&
        /^[0-9A-Za-z-]+$/.test(part) &&
        !(/^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))
    ) &&
    build.every((part) => part.length > 0 && /^[0-9A-Za-z-]+$/.test(part))
  );
}

function compareVersions(left = "0.0.0", right = "0.0.0"): number {
  const parse = (version: string) => {
    const [withoutBuild] = version.split("+", 1);
    const [core, prerelease] = withoutBuild.split("-", 2);
    return {
      core: core.split(".").map((part) => Number.parseInt(part, 10) || 0),
      prerelease: prerelease?.split(".") ?? [],
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return (a.core[index] ?? 0) > (b.core[index] ?? 0) ? 1 : -1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return a.prerelease.length ? -1 : b.prerelease.length ? 1 : 0;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) return leftNumber > rightNumber ? 1 : -1;
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function supportedByTalos(entry: IndexEntry): boolean {
  const compatibility = entry.compatibility?.trim();
  if (!compatibility) return true;
  const minimum = compatibility.match(/(?:Talos\s*)?>=\s*(\d+\.\d+\.\d+)/i)?.[1];
  if (minimum) return compareVersions("0.1.0", minimum) >= 0;
  return /^talos(?:\s+manifest)?\s*v?1$/i.test(compatibility);
}

// ---------- actions ----------
async function applyThemeById(id: string | null) {
  if (id === null) {
    hooks.setTheme(null);
    delete settings.theme;
  } else {
    const m = installed.find((x) => x.id === id);
    if (!m?.enabled) throw new Error("Enable this extension before applying its theme.");
    const def = m?.theme as ThemeDef | undefined;
    if (!def) throw new Error("Theme data missing for " + id);
    hooks.setTheme(def);
    settings.theme = id;
  }
  await saveSettings();
  render();
}

async function applyIconPackById(id: string | null) {
  if (id === null) {
    hooks.setIconPack(null);
    delete settings.iconPack;
  } else {
    const manifest = installed.find((item) => item.id === id);
    if (!manifest?.enabled) throw new Error("Enable this extension before applying its icon pack.");
    if (manifest.kind !== "icon-pack") throw new Error("This extension is not an icon pack.");
    if (!manifest.iconPack) throw new Error("Icon pack data missing for " + id);
    const mappings = stringMap(manifest.iconPack.mappings);
    const fallback = typeof manifest.iconPack.default === "string" && manifest.iconPack.default.trim()
      ? manifest.iconPack.default
      : "file";
    hooks.setIconPack({ id, default: fallback, mappings });
    settings.iconPack = id;
  }
  await saveSettings();
  render();
}

export async function clearExtensionThemePreference() {
  await initialization;
  if (!settings.theme) return;
  delete settings.theme;
  await saveSettings();
}

async function installExt(e: IndexEntry) {
  const base = settings.registry ?? "";
  const src = resolveRel(base, e.url);
  if (isHttp(base) && !isHttp(src)) {
    throw new Error("A remote registry cannot install from local files.");
  }
  if (typeof e.sha256 !== "string" || !e.sha256) {
    throw new Error("This entry has no checksum, so Talos will not install it.");
  }
  if (typeof e.kind !== "string") {
    throw new Error("This registry entry has no extension kind.");
  }
  const text = await fetchSource(src);
  const parsedValue: unknown = JSON.parse(text);
  if (!isRecord(parsedValue)) {
    throw new Error("Downloaded manifest is not a JSON object.");
  }
  const parsed = parsedValue as unknown as Manifest;
  if (
    typeof parsed.id !== "string" ||
    typeof parsed.name !== "string" ||
    typeof parsed.kind !== "string" ||
    typeof parsed.version !== "string" ||
    parsed.id !== e.id ||
    parsed.version !== e.version ||
    !validVersion(parsed.version)
  ) {
    throw new Error("Downloaded manifest identity or version does not match the registry entry.");
  }
  if (parsed.kind !== e.kind) {
    throw new Error("Downloaded manifest kind does not match the registry entry.");
  }
  if (!supportedByTalos(e)) {
    throw new Error("This extension declares compatibility outside the current Talos manifest support.");
  }
  const dependencies = stringArray(e.dependencies);
  const missingDependencies = dependencies.filter(
    (dependency) => !installed.some((extension) => extension.id === dependency)
  );
  if (missingDependencies.length) {
    throw new Error("Install required dependencies first: " + missingDependencies.join(", "));
  }
  // Rust derives requirements from the manifest only; the prompt must match
  // exactly, so index-declared permissions cannot create phantom approvals.
  const requiredPermissions = new Set([
    ...stringArray(parsed.permissions),
    ...(parsed.kind === "language" && isRecord(parsed.language) && typeof parsed.language.run === "string" && parsed.language.run
      ? ["process.execution"]
      : []),
  ]);
  const supportedPermissions = new Set(["process.execution"]);
  const unsupported = [...requiredPermissions].filter((permission) => !supportedPermissions.has(permission));
  if (unsupported.length) {
    throw new Error("Talos cannot grant unsupported permissions: " + unsupported.join(", "));
  }
  const approvedPermissions: string[] = [];
  if (requiredPermissions.has("process.execution")) {
    const ok = await ask(
      "This extension declares a language command that Talos can execute only after you choose Run. It will not execute during installation or activation.\n\n" +
        (isRecord(parsed.language) && typeof parsed.language.run === "string" && parsed.language.run
          ? parsed.language.run
          : "(command not provided)") +
        "\n\nGrant the process.execution permission?",
      { title: "Approve extension permission", kind: "warning" }
    );
    if (!ok) return;
    approvedPermissions.push("process.execution");
  }
  await invoke("ext_install", {
    text,
    sha256: e.sha256,
    expectedId: e.id,
    expectedVersion: e.version,
    expectedKind: e.kind,
    approvedPermissions,
    dependencies,
  });
  await refreshInstalled();
  selectedDetails = null;
  if (e.kind === "icon-pack" && !settings.iconPack) await applyIconPackById(e.id);
  else if (settings.theme === e.id) await applyThemeById(e.id);
  else if (settings.iconPack === e.id) await applyIconPackById(e.id);
  else render();
}

async function setExtensionEnabled(extension: Manifest, enabled: boolean) {
  const required = new Set([
    ...stringArray(extension.permissions),
    ...(extension.kind === "language" && isRecord(extension.language) && typeof extension.language.run === "string" && extension.language.run
      ? ["process.execution"]
      : []),
  ]);
  const approved = new Set(stringArray(extension.grantedPermissions));
  const missing = [...required].filter((permission) => !approved.has(permission));
  if (missing.some((permission) => permission !== "process.execution")) {
    throw new Error("This extension requests a permission Talos does not support.");
  }
  if (enabled && missing.includes("process.execution")) {
    const ok = await ask(
      "Enabling this language extension allows its configured command to run only when you choose Run:\n\n" +
        (isRecord(extension.language) && typeof extension.language.run === "string" && extension.language.run
          ? extension.language.run
          : "(command not provided)") +
        "\n\nGrant the process.execution permission?",
      { title: "Approve extension permission", kind: "warning" }
    );
    if (!ok) return;
    approved.add("process.execution");
  }
  await invoke("ext_set_enabled", {
    id: extension.id,
    enabled,
    permissions: [...approved],
  });
  if (!enabled && settings.theme === extension.id) await applyThemeById(null);
  if (!enabled && settings.iconPack === extension.id) await applyIconPackById(null);
  await refreshInstalled();
  if (enabled && extension.kind === "icon-pack" && !settings.iconPack) await applyIconPackById(extension.id);
  else render();
}

async function removeExt(id: string) {
  const ok = await ask("Remove this extension and its local configuration?", {
    title: "Remove extension",
    kind: "warning",
  });
  if (!ok) return;
  const activeTheme = settings.theme === id;
  const activeIconPack = settings.iconPack === id;
  await invoke("ext_remove", { id });
  await refreshInstalled();
  selectedDetails = null;
  if (activeTheme) await applyThemeById(null);
  if (activeIconPack) await applyIconPackById(null);
  else if (!activeTheme) render();
}

async function rollbackExt(id: string) {
  const extension = installed.find((item) => item.id === id);
  const version = extension?.rollbackVersion ?? "previous";
  const ok = await ask(`Restore ${extension?.name ?? id} to version ${version}?`, {
    title: "Roll back extension update",
    kind: "warning",
  });
  if (!ok) return;
  await invoke("ext_rollback", { id });
  await refreshInstalled();
  if (settings.theme === id) await applyThemeById(id);
  else if (settings.iconPack === id) await applyIconPackById(id);
  else render();
}

// ---------- rendering ----------
const query = () => ($("market-search") as HTMLInputElement).value.trim().toLowerCase();
function matches(q: string, ...parts: (string | undefined)[]) {
  return !q || parts.join(" ").toLowerCase().includes(q);
}

function renderCategories() {
  const nav = $("market-categories");
  nav.textContent = "";
  const all = el("button", "market-category" + (selectedCategory === null ? " active" : ""));
  all.type = "button";
  all.setAttribute("aria-pressed", String(selectedCategory === null));
  all.append(el("span", "category-icon", "⌕"), el("span", "category-name", "All extensions"));
  all.appendChild(el("span", "category-count", String(registry?.extensions?.length ?? 0)));
  all.addEventListener("click", () => {
    selectedCategory = null;
    selectedDetails = null;
    render();
  });
  nav.appendChild(all);

  for (const category of categories) {
    const count = categoryEntries(category.id).length;
    const item = el(
      "button",
      "market-category" + (selectedCategory === category.id ? " active" : "")
    );
    item.type = "button";
    item.title = category.description;
    item.setAttribute("aria-pressed", String(selectedCategory === category.id));
    item.append(
      el("span", "category-icon", category.icon),
      el("span", "category-name", category.name),
      el("span", "category-count", String(count))
    );
    item.addEventListener("click", () => {
      selectedCategory = category.id;
      selectedDetails = null;
      render();
    });
    nav.appendChild(item);
  }
}

function filteredEntries(entries: IndexEntry[]): IndexEntry[] {
  const q = query();
  const status = ($("market-status") as HTMLSelectElement).value;
  const compatibility = ($("market-compatibility") as HTMLSelectElement).value;
  const license = ($("market-license") as HTMLSelectElement).value;
  const updated = ($("market-updated") as HTMLSelectElement).value;
  const dependencies = ($("market-dependencies") as HTMLSelectElement).value;
  const highlight = ($("market-highlight") as HTMLSelectElement).value;
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return entries
    .filter((entry) => {
      const installedEntry = installed.find((item) => item.id === entry.id);
      if (selectedCategory && !entryMatchesCategory(entry, selectedCategory)) return false;
      if (status === "installed" && !installedEntry) return false;
      if (status === "not-installed" && installedEntry) return false;
      if (compatibility === "compatible" && !supportedByTalos(entry)) return false;
      if (compatibility === "incompatible" && supportedByTalos(entry)) return false;
      if (license === "open-source" && !entry.license) return false;
      if (license === "free" && entry.free !== true) return false;
      if (
        updated === "recent" &&
        (!entry.updatedAt || !Number.isFinite(Date.parse(entry.updatedAt)) || Date.parse(entry.updatedAt) < cutoff)
      ) {
        return false;
      }
      if (dependencies !== "all" && dependencyState(entry) !== dependencies) return false;
      if (highlight === "featured" && entry.featured !== true) return false;
      if (highlight === "curated" && typeof entry.curatedRank !== "number") return false;
      const categoryName = categories.find((item) => item.id === extensionCategory(entry))?.name;
      return matches(
        q,
        entry.id,
        entry.name,
        entry.description,
        entry.kind,
        entry.author,
        entry.publisher,
        entry.license,
        entry.compatibility,
        categoryName,
        ...(entry.features ?? [])
      );
    })
    .sort((left, right) => {
      const featured = Number(right.featured === true) - Number(left.featured === true);
      if (featured) return featured;
      const rank = (entry: IndexEntry) =>
        typeof entry.curatedRank === "number" && Number.isFinite(entry.curatedRank)
          ? entry.curatedRank
          : Number.MAX_SAFE_INTEGER;
      if (rank(left) !== rank(right)) return rank(left) - rank(right);
      const leftUpdated = Date.parse(left.updatedAt ?? "");
      const rightUpdated = Date.parse(right.updatedAt ?? "");
      const leftTime = Number.isFinite(leftUpdated) ? leftUpdated : 0;
      const rightTime = Number.isFinite(rightUpdated) ? rightUpdated : 0;
      if (leftTime !== rightTime) return rightTime - leftTime;
      return left.name.localeCompare(right.name);
    });
}

function extensionActions(entry: IndexEntry): HTMLElement[] {
  const actions: HTMLElement[] = [
    btn("Details", () => {
      selectedDetails = entry;
      render();
    }),
  ];
  const current = installed.find((item) => item.id === entry.id);
  if (!current) {
    const install = btn("Install", () => installExt(entry), "accent");
    const missing = (entry.dependencies ?? []).filter(
      (dependency) => !installed.some((extension) => extension.id === dependency)
    );
    if (!supportedByTalos(entry) || missing.length) {
      install.disabled = true;
      install.title = !supportedByTalos(entry)
        ? "This extension is incompatible with the current Talos manifest support."
        : "Requires: " + missing.join(", ");
    }
    actions.push(install);
  } else {
    if (compareVersions(entry.version, current.version) > 0) {
      actions.push(btn("Update to v" + entry.version, () => installExt(entry), "accent"));
    } else {
      actions.push(btn(current.enabled ? "Installed" : "Disabled", () => {
        selectedDetails = entry;
        render();
      }));
    }
    if (entry.kind === "theme" && current.enabled) {
      actions.push(btn(settings.theme === entry.id ? "Active" : "Apply", () => applyThemeById(entry.id)));
    }
    if (entry.kind === "icon-pack" && current.enabled) {
      actions.push(btn(settings.iconPack === entry.id ? "Active" : "Apply", () => applyIconPackById(entry.id)));
    }
    if (current.rollbackAvailable) {
      actions.push(btn("Roll back to v" + current.rollbackVersion, () => rollbackExt(entry.id)));
    }
    actions.push(btn("Remove", () => removeExt(entry.id)));
  }
  return actions;
}

function renderExtensions(list: HTMLElement) {
  if (!registry) {
    note(list, "Registry not loaded. Check the path above and press Reload.");
    return;
  }
  const items = filteredEntries(registry.extensions ?? []);
  if (items.length === 0) note(list, "Nothing found.");
  for (const e of items) {
    const current = installed.find((item) => item.id === e.id);
    const categoryName = categories.find((item) => item.id === extensionCategory(e))?.name ?? e.kind;
    const state = current ? (current.enabled ? "Installed" : "Disabled") : e.featured ? "Featured" : categoryName;
    const version = (current && compareVersions(current.version, e.version) > 0 ? "Installed v" + current.version + " · " : "") +
      "v" + (e.version ?? "?");
    const needs = warningRequirements(e);
    const warning = needs.length ? "Requires: " + needs.map((requirement) => requirement.name).join(", ") : "";
    list.appendChild(
      card(
        e.name,
        state,
        version + " · " + (e.publisher ?? e.author ?? "publisher not declared"),
        e.description ?? "",
        extensionActions(e),
        warning
      )
    );
  }
}

function renderExtensionDetails(list: HTMLElement, entry: IndexEntry) {
  requestDependencyStatuses([entry]);
  const panel = el("article", "extension-details");
  const title = el("div", "details-title");
  const category = categories.find((item) => item.id === extensionCategory(entry));
  title.append(
    el("span", "details-icon", category?.icon ?? "◇"),
    el("h2", "", entry.name),
    btn("Back to results", () => {
      selectedDetails = null;
      render();
    })
  );
  panel.append(title);
  panel.append(el("p", "details-description", entry.description ?? "No description provided."));
  const metadata = el("dl", "details-metadata");
  const addMetadata = (label: string, value: string) => {
    metadata.append(el("dt", "", label), el("dd", "", value));
  };
  addMetadata("Version", entry.version ?? "Not specified");
  addMetadata("Category", category?.name ?? entry.kind);
  addMetadata("Publisher", (entry.publisher ?? entry.author ?? "Not declared") + " (not cryptographically verified)");
  addMetadata("Compatibility", entry.compatibility ?? "Talos legacy manifest format (supported)");
  addMetadata("License", entry.license ?? "Not specified by registry");
  addMetadata("Updated", entry.updatedAt ?? "Not specified by registry");
  addMetadata("SHA-256", entry.sha256);
  if (entry.dependencies?.length) addMetadata("Dependencies", entry.dependencies.join(", "));
  if (entry.permissions?.length) addMetadata("Declared permissions", entry.permissions.join(", "));
  else addMetadata("Permissions", entry.kind === "language" ? "process.execution (approval required)" : "None");
  panel.append(metadata);
  if (entryRequirements(entry).length) {
    panel.appendChild(el("h3", "", "External requirements"));
    const external = el("ul", "details-list");
    const labels: Record<"available" | "missing" | "checking" | "unknown", string> = {
      available: "Available",
      missing: "Missing",
      checking: "Checking",
      unknown: "Unknown",
    };
    for (const requirement of entryRequirements(entry)) {
      const key = requirementKey(requirement.name, requirement.kind);
      const status = dependencyStatuses.get(key);
      const state: keyof typeof labels = dependencyChecks.has(key)
        ? "checking"
        : status
          ? status.available
            ? "available"
            : "missing"
          : "unknown";
      const row = el(
        "li",
        "",
        requirement.name +
          " · " +
          requirement.kind +
          " · " +
          (requirement.required ? "required" : "optional") +
          " — "
      );
      const stateEl = el("span", "dependency-status", labels[state]);
      stateEl.dataset.dependencyState = state;
      row.appendChild(stateEl);
      if (status?.detail) row.appendChild(el("span", "", " — " + status.detail));
      row.appendChild(el("div", "details-description", requirement.description));
      external.appendChild(row);
    }
    panel.appendChild(external);
    panel.appendChild(
      el(
        "p",
        "details-description",
        "Talos detects requirements locally; it does not install or execute them for you."
      )
    );
    const error = dependencyErrors.get(entry.id);
    if (error) panel.appendChild(el("p", "market-warning", "Dependency status unavailable: " + error));
  }
  if (entry.features?.length) {
    panel.append(el("h3", "", "Capabilities"));
    const features = el("ul", "details-list");
    for (const feature of entry.features) features.appendChild(el("li", "", feature));
    panel.appendChild(features);
  } else if (entry.kind === "language") {
    panel.append(
      el("h3", "", "Capabilities"),
      el(
        "p",
        "details-description",
        "Provides a language run configuration. Syntax highlighting, diagnostics, autocomplete, formatting, LSP, and debugging are only available where Talos or another installed component implements them; this extension does not claim those features."
      )
    );
  }
  if (entry.changelog) {
    panel.append(el("h3", "", "Changelog"), el("pre", "details-changelog", entry.changelog));
  }
  if (entry.screenshots?.length) {
    panel.append(el("h3", "", "Screenshots"));
    for (const source of entry.screenshots) {
      if (!isHttp(source)) continue;
      const image = el("img", "extension-screenshot");
      image.src = source;
      image.alt = entry.name + " screenshot";
      image.loading = "lazy";
      panel.appendChild(image);
    }
  }
  const actions = el("div", "details-actions");
  const current = installed.find((item) => item.id === entry.id);
  if (!current) {
    const install = btn("Install", () => installExt(entry), "accent");
    if (!supportedByTalos(entry)) {
      install.disabled = true;
      install.title = "Incompatible with the current Talos manifest support.";
    }
    actions.appendChild(install);
  } else {
    actions.appendChild(
      btn(current.enabled ? "Disable" : "Enable", () =>
        setExtensionEnabled(current, !current.enabled)
      )
    );
    if (compareVersions(entry.version, current.version) > 0) {
      actions.appendChild(
        btn("Update to v" + entry.version, () => installExt(entry), "accent")
      );
    }
    if (entry.kind === "theme" && current.enabled) {
      actions.appendChild(
        btn(settings.theme === entry.id ? "Active" : "Apply", () => applyThemeById(entry.id))
      );
    }
    if (entry.kind === "icon-pack" && current.enabled) {
      actions.appendChild(
        btn(settings.iconPack === entry.id ? "Active" : "Apply", () => applyIconPackById(entry.id))
      );
    }
    if (current.rollbackAvailable) {
      actions.appendChild(
        btn("Roll back to v" + current.rollbackVersion, () => rollbackExt(entry.id))
      );
    }
    actions.appendChild(btn("Remove", () => removeExt(entry.id)));
  }
  panel.appendChild(actions);
  list.appendChild(panel);
}

function renderApis(list: HTMLElement) {
  if (!registry) {
    note(list, "Registry not loaded. Check the path above and press Reload.");
    return;
  }
  const q = query();
  const items = (registry.apis ?? []).filter((a) => matches(q, a.name, a.description, a.baseUrl));
  if (items.length === 0) note(list, "Nothing found.");
  for (const a of items) {
    const actions: HTMLElement[] = [];
    for (const key of Object.keys(a.snippets ?? {})) {
      actions.push(
        btn("Insert " + key, () => {
          hooks.insertText((a.snippets ?? {})[key] ?? "");
          closeMarket();
        })
      );
    }
    const meta = (a.auth ?? "none") + " auth \u00b7 " + (a.baseUrl ?? "");
    const desc = (a.description ?? "") + (a.docs ? "  Docs: " + a.docs : "");
    list.appendChild(card(a.name, "api", meta, desc, actions));
  }
}

function renderInstalled(list: HTMLElement) {
  const q = query();
  const items = installed.filter((m) => matches(q, m.name, m.description, m.kind));
  if (items.length === 0) note(list, "No extensions installed yet.");
  for (const m of items) {
    const catalogEntry = registry?.extensions?.find((entry) => entry.id === m.id);
    const updateAvailable =
      catalogEntry && compareVersions(catalogEntry.version, m.version) > 0
        ? catalogEntry.version
        : null;
    const actions: HTMLElement[] = [
      btn(m.enabled ? "Disable" : "Enable", () => setExtensionEnabled(m, !m.enabled)),
      btn("Details", () => {
        selectedDetails = catalogEntry ?? null;
        if (selectedDetails) {
          tab = "extensions";
          selectedCategory = null;
        }
        render();
      }),
    ];
    if (updateAvailable && catalogEntry) {
      actions.push(btn("Update to v" + updateAvailable, () => installExt(catalogEntry), "accent"));
    }
    if (m.rollbackAvailable) {
      actions.push(
        btn("Roll back to v" + (m.rollbackVersion ?? "?"), () => rollbackExt(m.id))
      );
    }
    if (m.kind === "theme" && m.enabled) {
      actions.push(btn(settings.theme === m.id ? "Active" : "Apply", () => applyThemeById(m.id)));
    }
    if (m.kind === "icon-pack" && m.enabled) {
      actions.push(btn(settings.iconPack === m.id ? "Active" : "Apply", () => applyIconPackById(m.id)));
    }
    actions.push(btn("Remove", () => removeExt(m.id)));
    list.appendChild(
      card(
        m.name,
        (m.enabled ? "Enabled" : "Disabled") +
          " · " +
          m.kind +
          (updateAvailable ? " · Update available" : ""),
        "v" + (m.version ?? "?") + " · " + (m.publisher ?? m.author ?? "publisher not declared"),
        (m.description ?? "No description provided.") +
          "\nPermissions: " +
          ((m.grantedPermissions ?? []).join(", ") || "none granted"),
        actions
      )
    );
  }
  if (settings.theme) {
    list.appendChild(
      card("Default theme", "theme", "built in", "Go back to the built-in dark theme.", [
        btn("Use default", () => applyThemeById(null)),
      ])
    );
  }
  if (settings.iconPack) {
    list.appendChild(
      card("Default icons", "icon-pack", "built in", "Go back to the built-in Explorer icons.", [
        btn("Use default", () => applyIconPackById(null)),
      ])
    );
  }
}

function renderTemplates(list: HTMLElement) {
  const q = query();
  let count = 0;
  for (const m of installed) {
    if (m.kind !== "template") continue;
    const ts = (m.templates as TemplateDef[] | undefined) ?? [];
    for (const t of ts) {
      if (!matches(q, t.label, t.filename, m.name)) continue;
      count++;
      list.appendChild(
        card(t.label, "template", t.filename + " \u00b7 " + m.name, "Creates a new file from this template.", [
          btn(
            "Create file",
            async () => {
              await hooks.newFromTemplate(t.filename, t.content);
              closeMarket();
            },
            "accent"
          ),
        ])
      );
    }
  }
  if (count === 0) note(list, "No templates installed. Install a template pack from the Extensions tab.");
}

function render() {
  const list = $("market-list");
  list.textContent = "";
  const categoriesNav = $("market-categories");
  const filters = $("market-filters");
  for (const b of document.querySelectorAll<HTMLElement>("[data-mtab]")) {
    b.classList.toggle("active", b.dataset.mtab === tab);
  }
  const browseExtensions = tab === "extensions" || tab === "installed";
  categoriesNav.classList.toggle("hidden", !browseExtensions || tab === "installed");
  filters.classList.toggle("hidden", !browseExtensions || tab === "installed");
  renderCategories();
  if (tab === "extensions") {
    if (selectedDetails) renderExtensionDetails(list, selectedDetails);
    else renderExtensions(list);
  } else if (tab === "apis") renderApis(list);
  else if (tab === "installed") renderInstalled(list);
  else renderTemplates(list);
}

// ---------- modal ----------
function closeMarket() {
  $("market").classList.add("hidden");
}

async function openMarket(t: MTab) {
  tab = t;
  selectedDetails = null;
  if (t !== "extensions") selectedCategory = null;
  $("market").classList.remove("hidden");
  ($("market-registry") as HTMLInputElement).value = settings.registry ?? "";
  await run(async () => {
    await refreshInstalled();
    if (!registry) {
      try {
        await loadRegistry();
      } catch (e) {
        setMsg("Could not load registry: " + String(e));
      }
    }
  });
  if (registry) requestDependencyStatuses(registry.extensions ?? []);
  render();
}

export async function initExtensions(h: Hooks) {
  hooks = h;

  $("btn-ext").addEventListener("click", () => void openMarket("extensions"));
  $("btn-tpl").addEventListener("click", () => void openMarket("templates"));
  $("market-close").addEventListener("click", closeMarket);
  $("market").addEventListener("click", (e) => {
    if (e.target === $("market")) closeMarket();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMarket();
  });
  $("market-search").addEventListener("input", render);
  for (const id of [
    "market-status",
    "market-compatibility",
    "market-license",
    "market-updated",
    "market-dependencies",
    "market-highlight",
  ]) {
    $(id).addEventListener("change", render);
  }
  for (const b of document.querySelectorAll<HTMLElement>("[data-mtab]")) {
    b.addEventListener("click", () => {
      tab = b.dataset.mtab as MTab;
      render();
    });
  }
  $("market-reload").addEventListener(
    "click",
    () =>
      void run(async () => {
        settings.registry = ($("market-registry") as HTMLInputElement).value.trim();
        await saveSettings();
        registry = null;
        await loadRegistry();
        render();
      })
  );

  initialization = (async () => {
    try {
      await loadSettings();
      await refreshInstalled();
      if (settings.theme) {
        try {
          await applyThemeById(settings.theme);
        } catch {
          delete settings.theme;
          await saveSettings().catch((error: unknown) => {
            console.error("could not clear stale theme preference", error);
          });
        }
      }
      if (settings.iconPack) {
        try {
          await applyIconPackById(settings.iconPack);
        } catch {
          hooks.setIconPack(null);
          delete settings.iconPack;
          await saveSettings().catch((error: unknown) => {
            console.error("could not clear stale icon pack preference", error);
          });
        }
      } else {
        hooks.setIconPack(null);
      }
    } catch (e) {
      console.error("extensions init failed", e);
    }
  })();
  await initialization;
}
