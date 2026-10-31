// Extension manager + marketplace + API market (no accounts, no servers needed).
// A "registry" is just a JSON index file: a local path or a public URL.
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import type { ThemeDef } from "./theme";

export interface Hooks {
  setTheme: (def: ThemeDef | null) => void;
  newFromTemplate: (filename: string, content: string) => Promise<void>;
  insertText: (text: string) => void;
}

interface Manifest {
  id: string;
  name: string;
  kind: string;
  version?: string;
  author?: string;
  description?: string;
  [k: string]: unknown;
}

interface IndexEntry {
  id: string;
  name: string;
  kind: string;
  version?: string;
  author?: string;
  description?: string;
  url: string;
  sha256: string;
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
}

type MTab = "extensions" | "apis" | "installed" | "templates";

let hooks: Hooks;
let settings: Settings = {};
let registry: RegistryDoc | null = null;
let installed: Manifest[] = [];
let tab: MTab = "extensions";

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

function card(title: string, badge: string, meta: string, desc: string, actions: HTMLElement[]) {
  const c = el("div", "card");
  const top = el("div", "card-top");
  top.append(el("span", "card-title", title), el("span", "badge", badge));
  c.append(top, el("div", "card-meta", meta), el("div", "card-desc", desc));
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
  try {
    const t = await invoke<string | null>("settings_read");
    if (t) settings = JSON.parse(t) as Settings;
  } catch {
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

async function loadRegistry() {
  const text = await fetchSource(settings.registry ?? "");
  registry = JSON.parse(text) as RegistryDoc;
}

const isInstalled = (id: string) => installed.some((m) => m.id === id);

// ---------- actions ----------
function applyThemeById(id: string | null) {
  if (id === null) {
    hooks.setTheme(null);
    delete settings.theme;
  } else {
    const m = installed.find((x) => x.id === id);
    const def = m?.theme as ThemeDef | undefined;
    if (!def) throw new Error("Theme data missing for " + id);
    hooks.setTheme(def);
    settings.theme = id;
  }
  void saveSettings();
  render();
}

async function installExt(e: IndexEntry) {
  const base = settings.registry ?? "";
  const src = resolveRel(base, e.url);
  if (isHttp(base) && !isHttp(src)) {
    throw new Error("A remote registry cannot install from local files.");
  }
  if (!e.sha256) throw new Error("This entry has no checksum, so Talos will not install it.");
  const text = await fetchSource(src);
  const parsed = JSON.parse(text) as { kind?: string; language?: { run?: string } };
  if (parsed.kind === "language") {
    const ok = await ask(
      "This extension adds a command that Talos will run on your computer when you press Run:\n\n" +
        (parsed.language?.run ?? "(none)") +
        "\n\nInstall only if you trust the publisher.",
      { title: "Install language extension", kind: "warning" }
    );
    if (!ok) return;
  }
  await invoke("ext_install", { text, sha256: e.sha256 });
  await refreshInstalled();
  render();
}

async function removeExt(id: string) {
  if (settings.theme === id) applyThemeById(null);
  await invoke("ext_remove", { id });
  await refreshInstalled();
  render();
}

// ---------- rendering ----------
const query = () => ($("market-search") as HTMLInputElement).value.trim().toLowerCase();
function matches(q: string, ...parts: (string | undefined)[]) {
  return !q || parts.join(" ").toLowerCase().includes(q);
}

function renderExtensions(list: HTMLElement) {
  if (!registry) {
    note(list, "Registry not loaded. Check the path above and press Reload.");
    return;
  }
  const q = query();
  const items = (registry.extensions ?? []).filter((e) =>
    matches(q, e.name, e.description, e.kind, e.author)
  );
  if (items.length === 0) note(list, "Nothing found.");
  for (const e of items) {
    const actions: HTMLElement[] = [];
    if (isInstalled(e.id)) {
      if (e.kind === "theme") {
        actions.push(btn(settings.theme === e.id ? "Active" : "Apply", () => applyThemeById(e.id)));
      }
      actions.push(btn("Remove", () => removeExt(e.id)));
    } else {
      actions.push(btn("Install", () => installExt(e), "accent"));
    }
    list.appendChild(
      card(
        e.name,
        e.kind,
        "v" + (e.version ?? "?") + " \u00b7 " + (e.author ?? "unknown"),
        e.description ?? "",
        actions
      )
    );
  }
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
    const actions: HTMLElement[] = [];
    if (m.kind === "theme") {
      actions.push(btn(settings.theme === m.id ? "Active" : "Apply", () => applyThemeById(m.id)));
    }
    actions.push(btn("Remove", () => removeExt(m.id)));
    list.appendChild(
      card(
        m.name,
        m.kind,
        "v" + (m.version ?? "?") + " \u00b7 " + (m.author ?? "unknown"),
        m.description ?? "",
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
  for (const b of document.querySelectorAll<HTMLElement>("[data-mtab]")) {
    b.classList.toggle("active", b.dataset.mtab === tab);
  }
  if (tab === "extensions") renderExtensions(list);
  else if (tab === "apis") renderApis(list);
  else if (tab === "installed") renderInstalled(list);
  else renderTemplates(list);
}

// ---------- modal ----------
function closeMarket() {
  $("market").classList.add("hidden");
}

async function openMarket(t: MTab) {
  tab = t;
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

  try {
    await loadSettings();
    await refreshInstalled();
    if (settings.theme) {
      try {
        applyThemeById(settings.theme);
      } catch {
        delete settings.theme;
      }
    }
  } catch (e) {
    console.error("extensions init failed", e);
  }
}
