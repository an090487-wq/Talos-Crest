// Optional GitHub panel in the Observatory. It is inert until the user opens
// this tab: no GitHub API request is made, and the rest of Talos keeps working
// with the network unplugged.
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getWindowValue, setWindowValue } from "./window-state";

interface TokenStatus {
  configured: boolean;
  masked: string;
}

interface GhUser {
  login?: string;
}

interface GhItem {
  number: number;
  title?: string;
  state?: string;
  user?: GhUser | null;
  created_at?: string;
  updated_at?: string;
  comments?: number;
  html_url?: string;
  body?: string | null;
  merged?: boolean;
  draft?: boolean;
}

interface GhRepo {
  full_name?: string;
  description?: string | null;
  private?: boolean;
  html_url?: string;
  updated_at?: string;
}

interface GhComment {
  user?: GhUser | null;
  created_at?: string;
  body?: string | null;
  html_url?: string;
}

type Kind = "issues" | "pulls";
type StateFilter = "open" | "closed" | "all";

const $ = (id: string) => document.getElementById(id)!;

let owner = getWindowValue("talos.github-owner") ?? "";
let repo = getWindowValue("talos.github-repo") ?? "";
let kind: Kind = getWindowValue("talos.github-kind") === "pulls" ? "pulls" : "issues";
let stateFilter: StateFilter = storedState();
let items: GhItem[] = [];
let repositories: GhRepo[] = [];
let selectedNumber: number | null = null;
let detail: GhItem | null = null;
let comments: GhComment[] = [];
let busy = false;
let initialized = false;

function storedState(): StateFilter {
  const value = getWindowValue("talos.github-state");
  return value === "open" || value === "closed" || value === "all" ? value : "open";
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = ""
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function setStatus(message: string, error = false): void {
  const status = $("github-status");
  status.textContent = message;
  status.classList.toggle("error", error);
}

function openExternal(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && parsed.hostname === "github.com") {
      void openUrl(parsed.toString()).catch((error: unknown) =>
        setStatus(`Could not open the browser: ${String(error)}`, true));
      return;
    }
  } catch {
    // Fall through to the same user-facing error below.
  }
  setStatus("GitHub returned an invalid link.", true);
}

function withBusy<T>(work: () => Promise<T>, starting = "Contacting GitHub…"): () => Promise<void> {
  return async () => {
    if (busy) return;
    busy = true;
    setStatus(starting);
    try {
      await work();
    } catch (error) {
      setStatus(String(error), true);
    } finally {
      busy = false;
    }
  };
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  return await invoke<T>("github_api", { method, path, body: body ?? null });
}

function repoPath(): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function syncRepoFields(): void {
  ($("github-owner") as HTMLInputElement).value = owner;
  ($("github-repo") as HTMLInputElement).value = repo;
  setWindowValue("talos.github-owner", owner);
  setWindowValue("talos.github-repo", repo);
}

async function refreshToken(): Promise<void> {
  const status = await invoke<TokenStatus>("github_token_status");
  $("github-token-status").textContent = status.configured
    ? `Connected ${status.masked}`
    : "Not connected — add a token to use this tab";
}

function renderKind(): void {
  $("github-kind-issues").classList.toggle("active", kind === "issues");
  $("github-kind-pulls").classList.toggle("active", kind === "pulls");
  ($("github-state") as HTMLSelectElement).value = stateFilter;
}

function renderList(): void {
  const list = $("github-list");
  list.textContent = "";
  if (repositories.length) {
    const heading = el("div", "github-section-title", "Repositories on this token");
    list.appendChild(heading);
    for (const item of repositories) {
      const full = item.full_name ?? "";
      const button = el("button", "github-row");
      button.type = "button";
      button.appendChild(el("strong", "", full));
      if (item.description) button.appendChild(el("span", "", item.description));
      button.addEventListener("click", () => {
        const [nextOwner, nextRepo] = full.split("/");
        if (!nextOwner || !nextRepo) return;
        owner = nextOwner;
        repo = nextRepo;
        repositories = [];
        syncRepoFields();
        void withBusy(loadItems)();
      });
      list.appendChild(button);
    }
    return;
  }
  for (const item of items) {
    const button = el("button", `github-row${item.number === selectedNumber ? " active" : ""}`);
    button.type = "button";
    button.appendChild(el("strong", "", `#${item.number} ${item.title ?? "(untitled)"}`));
    const meta = `${item.user?.login ?? "unknown"} · ${item.state ?? "open"}${kind === "pulls" ? (item.draft ? " · draft" : "") : ""}`;
    button.appendChild(el("span", "", meta));
    button.addEventListener("click", () => void withBusy(() => selectItem(item.number))());
    list.appendChild(button);
  }
}

function renderDetail(): void {
  const head = $("github-detail-head");
  const body = $("github-detail-body");
  const commentBox = $("github-comments");
  head.textContent = "";
  body.textContent = "";
  commentBox.textContent = "";
  if (!detail) {
    head.appendChild(el("h3", "", "Select an issue or pull request"));
    return;
  }
  head.appendChild(el("h3", "", `#${detail.number} ${detail.title ?? ""}`));
  const meta = el("div", "github-meta", `${detail.state ?? "open"} · opened by ${detail.user?.login ?? "unknown"}`);
  head.appendChild(meta);
  if (detail.html_url) {
    const link = el("a", "", "Open on GitHub");
    const target = detail.html_url;
    link.href = "#";
    link.addEventListener("click", (event) => {
      event.preventDefault();
      openExternal(target);
    });
    head.appendChild(link);
  }
  body.textContent = detail.body || "No description provided.";
  for (const comment of comments) {
    const box = el("div", "github-comment");
    box.appendChild(el("strong", "", comment.user?.login ?? "unknown"));
    box.appendChild(el("span", "github-meta", comment.created_at ?? ""));
    box.appendChild(el("div", "", comment.body || ""));
    commentBox.appendChild(box);
  }
  ($("github-toggle") as HTMLButtonElement).textContent = detail.state === "closed" ? "Reopen" : "Close";
  ($("github-merge").classList as DOMTokenList).toggle("hidden", kind !== "pulls" || detail.state === "closed");
}

async function loadItems(): Promise<void> {
  if (!owner.trim() || !repo.trim()) {
    setStatus("Enter the repository owner and name first.", true);
    return;
  }
  owner = owner.trim();
  repo = repo.trim();
  syncRepoFields();
  repositories = [];
  selectedNumber = null;
  detail = null;
  comments = [];
  const query = stateFilter === "all" ? "all" : stateFilter;
  const result = await api<GhItem[]>(
    "GET",
    `${repoPath()}/${kind}?state=${query}&per_page=50&sort=updated`,
  );
  items = Array.isArray(result) ? result : [];
  renderList();
  renderDetail();
  setStatus(`Loaded ${items.length} ${kind} from ${owner}/${repo}.`);
}

async function loadRepositories(): Promise<void> {
  const result = await api<GhRepo[]>("GET", "/user/repos?per_page=100&sort=updated");
  repositories = Array.isArray(result) ? result : [];
  items = [];
  detail = null;
  comments = [];
  renderList();
  renderDetail();
  setStatus(`Loaded ${repositories.length} repositories. Choose one to view its ${kind}.`);
}

async function selectItem(number: number): Promise<void> {
  if (!owner || !repo) return;
  selectedNumber = number;
  renderList();
  const base = `${repoPath()}/${kind === "issues" ? "issues" : "pulls"}/${number}`;
  const [found, noteList] = await Promise.all([
    api<GhItem>("GET", base),
    api<GhComment[]>("GET", `${base}/comments?per_page=100`),
  ]);
  detail = found;
  comments = Array.isArray(noteList) ? noteList : [];
  renderDetail();
  setStatus(`Opened #${number}.`);
}

const createIssue = withBusy(async () => {
  if (kind !== "issues") {
    setStatus("Switch to Issues to create an issue.", true);
    return;
  }
  const title = ($("github-title") as HTMLInputElement).value.trim();
  const text = ($("github-body") as HTMLTextAreaElement).value;
  if (!title) {
    setStatus("Enter an issue title first.", true);
    return;
  }
  const created = await api<GhItem>("POST", `${repoPath()}/issues`, { title, body: text });
  ($("github-title") as HTMLInputElement).value = "";
  ($("github-body") as HTMLTextAreaElement).value = "";
  await loadItems();
  if (typeof created.number === "number") await selectItem(created.number);
});

const addComment = withBusy(async () => {
  if (!detail) {
    setStatus("Select an issue or pull request first.", true);
    return;
  }
  const text = ($("github-body") as HTMLTextAreaElement).value.trim();
  if (!text) {
    setStatus("Write a comment first.", true);
    return;
  }
  const base = `${repoPath()}/${kind === "issues" ? "issues" : "pulls"}/${detail.number}/comments`;
  await api("POST", base, { body: text });
  ($("github-body") as HTMLTextAreaElement).value = "";
  await selectItem(detail.number);
});

const toggleIssue = withBusy(async () => {
  if (!detail) {
    setStatus("Select an issue first.", true);
    return;
  }
  const nextState = detail.state === "closed" ? "open" : "closed";
  await api("PATCH", `${repoPath()}/issues/${detail.number}`, { state: nextState });
  await loadItems();
  await selectItem(detail.number);
});

const mergePull = withBusy(async () => {
  if (!detail || kind !== "pulls") {
    setStatus("Select a pull request first.", true);
    return;
  }
  await api("PUT", `${repoPath()}/pulls/${detail.number}/merge`, {
    commit_title: `Merge pull request #${detail.number}`,
  });
  await loadItems();
  await selectItem(detail.number);
});

export function initGitHubPanel(): void {
  if (initialized) return;
  initialized = true;
  owner = owner.trim();
  repo = repo.trim();
  syncRepoFields();
  renderKind();
  renderList();
  renderDetail();
  void refreshToken().catch((error: unknown) => setStatus(String(error), true));

  $("github-token-save").addEventListener("click", () => void withBusy(async () => {
    const token = ($("github-token") as HTMLInputElement).value;
    await invoke("github_set_token", { token });
    ($("github-token") as HTMLInputElement).value = "";
    await refreshToken();
    setStatus("Token saved locally. Nothing was sent to GitHub by saving it.");
  }, "Saving token locally…")());
  $("github-token-clear").addEventListener("click", () => void withBusy(async () => {
    await invoke("github_clear_token");
    items = [];
    repositories = [];
    detail = null;
    comments = [];
    selectedNumber = null;
    renderList();
    renderDetail();
    await refreshToken();
    setStatus("Token removed from this device.");
  }, "Removing local token…")());
  $("github-load").addEventListener("click", () => void withBusy(loadItems)());
  $("github-my-repos").addEventListener("click", () => void withBusy(loadRepositories)());
  $("github-kind-issues").addEventListener("click", () => {
    kind = "issues";
    setWindowValue("talos.github-kind", kind);
    renderKind();
    items = [];
    repositories = [];
    detail = null;
    renderList();
    renderDetail();
  });
  $("github-kind-pulls").addEventListener("click", () => {
    kind = "pulls";
    setWindowValue("talos.github-kind", kind);
    renderKind();
    items = [];
    repositories = [];
    detail = null;
    renderList();
    renderDetail();
  });
  ($("github-state") as HTMLSelectElement).addEventListener("change", (event) => {
    stateFilter = (event.target as HTMLSelectElement).value as StateFilter;
    setWindowValue("talos.github-state", stateFilter);
    if (items.length || repositories.length) void withBusy(loadItems)();
  });
  $("github-create").addEventListener("click", () => void createIssue());
  $("github-comment").addEventListener("click", () => void addComment());
  $("github-toggle").addEventListener("click", () => void toggleIssue());
  $("github-merge").addEventListener("click", () => void mergePull());
}

export function renderGitHubPanel(): void {
  if (!initialized) return;
  renderKind();
}
