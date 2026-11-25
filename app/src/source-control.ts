import { invoke } from "@tauri-apps/api/core";
import { workspaceRoot } from "./workspace";

interface GitFileStatus {
  path: string;
  status: string;
  staged: boolean;
  conflict: boolean;
  originalPath?: string | null;
}

interface GitRepoInfo {
  root: string;
  branch: string;
  upstream: string | null;
  remote: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
}

interface GitBranch {
  name: string;
  current: boolean;
  upstream: string | null;
}

interface GitRemote {
  name: string;
  url: string;
}

interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
}

let initialized = false;
let refreshing = false;
let committing = false;
let refreshTimer = 0;
let currentRoot: string | null = null;
let repoInfo: GitRepoInfo | null = null;
let entries: GitFileStatus[] = [];
let branches: GitBranch[] = [];
let remotes: GitRemote[] = [];
let commits: GitCommit[] = [];
let selectedFile: { path: string; staged: boolean } | null = null;
let selectedCommit: string | null = null;
let diffOpenPath: string | null = null;

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing Source Control element: ${id}`);
  return node as T;
}

function pane(): HTMLElement {
  return el("source-control-pane");
}

function setStatus(text: string): void {
  el("sc-status").textContent = text;
}

function setBusy(value: boolean): void {
  committing = value;
  document.dispatchEvent(new CustomEvent<boolean>("talos:source-control-busy", { detail: value }));
}

function friendlyGitError(error: unknown): string {
  const raw = String(error instanceof Error ? error.message : error);
  if (/terminal prompt|authentication failed|could not read username|permission denied \(publickey\)|(^|\s)(401|403)(\s|$)/i.test(raw)) {
    return `${raw} — configure a Git credential helper or SSH key first; Talos does not store passwords.`;
  }
  return raw;
}

function reportError(error: unknown): void {
  const message = friendlyGitError(error);
  setStatus(message);
  document.dispatchEvent(new CustomEvent<string>("talos:open-error", { detail: message }));
}

function setRepoControlsEnabled(enabled: boolean): void {
  for (const id of [
    "sc-stage-all", "sc-unstage-all", "sc-fetch", "sc-pull", "sc-push",
    "sc-commit", "sc-message", "sc-branch", "sc-remote",
  ]) {
    const node = document.getElementById(id) as HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement | null;
    if (node) node.disabled = !enabled;
  }
  el<HTMLButtonElement>("sc-init").classList.toggle("hidden", enabled);
}

function absoluteRepoPath(relative: string): string {
  const base = (repoInfo?.root ?? currentRoot ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const clean = relative.replace(/\\/g, "/").replace(/^\.\//, "");
  return base ? `${base}/${clean}` : clean;
}

function actionButton(label: string, title: string, run: () => void | Promise<void>): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mini";
  button.textContent = label;
  button.title = title;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    void Promise.resolve().then(run).catch(reportError);
  });
  return button;
}

function emptyRow(text: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "sc-empty";
  row.textContent = text;
  return row;
}

function renderFileGroup(containerId: string, items: GitFileStatus[], staged: boolean): void {
  const container = el(containerId);
  container.replaceChildren();
  if (!items.length) {
    container.append(emptyRow(staged ? "Nothing staged yet." : "No changes."));
    return;
  }

  for (const entry of items) {
    const row = document.createElement("div");
    row.className = `sc-row${entry.conflict ? " conflict" : ""}`;
    if (selectedFile?.path === entry.path && selectedFile.staged === entry.staged) {
      row.classList.add("selected");
    }

    const marker = document.createElement("span");
    marker.className = "sc-status";
    marker.textContent = entry.conflict ? "!" : staged ? "✓" : entry.status.charAt(0).toUpperCase();
    marker.title = entry.status;

    const name = document.createElement("button");
    name.type = "button";
    name.className = "sc-path";
    name.textContent = entry.originalPath
      ? `${entry.originalPath} → ${entry.path}`
      : entry.path;
    name.title = `Show diff for ${entry.path}`;
    name.addEventListener("click", () => {
      void showFileDiff(entry).catch(reportError);
    });

    const badge = document.createElement("span");
    badge.className = "sc-badge";
    badge.textContent = entry.status;

    const actions = document.createElement("div");
    actions.className = "sc-actions";
    if (entry.conflict) {
      actions.append(actionButton("+", "Mark conflict resolved and stage", () => stagePaths([entry.path])));
    } else if (staged) {
      actions.append(actionButton("−", "Unstage", () => unstagePaths([entry.path])));
    } else {
      actions.append(actionButton("+", "Stage", () => stagePaths([entry.path])));
      actions.append(actionButton("⊘", "Add to .gitignore", () => ignorePaths([entry.path])));
      actions.append(actionButton("×", "Discard local changes", () => discardPaths([entry.path])));
    }

    row.append(marker, name, badge, actions);
    container.append(row);
  }
}

function renderHistory(): void {
  const container = el("sc-history");
  container.replaceChildren();
  if (!commits.length) {
    container.append(emptyRow("No commits yet."));
    return;
  }
  for (const commit of commits) {
    const row = document.createElement("div");
    row.className = "sc-row";
    if (selectedCommit === commit.hash) row.classList.add("selected");

    const marker = document.createElement("span");
    marker.className = "sc-status";
    marker.textContent = "◷";
    const name = document.createElement("button");
    name.type = "button";
    name.className = "sc-path";
    name.textContent = `${commit.shortHash}  ${commit.subject}`;
    name.title = `${commit.author} · ${commit.date}`;
    name.addEventListener("click", () => {
      void showCommitDiff(commit).catch(reportError);
    });
    const badge = document.createElement("span");
    badge.className = "sc-badge";
    badge.textContent = commit.date || commit.author;
    row.append(marker, name, badge);
    container.append(row);
  }
}

function render(): void {
  const branchSelect = el<HTMLSelectElement>("sc-branch");
  const remoteSelect = el<HTMLSelectElement>("sc-remote");
  const hasRepo = repoInfo !== null;

  setRepoControlsEnabled(hasRepo);
  el("sc-repo").textContent = hasRepo
    ? `${repoInfo!.root} · ${repoInfo!.branch}${repoInfo!.upstream ? ` → ${repoInfo!.upstream}` : ""}${repoInfo!.detached ? " (detached)" : ""}`
    : currentRoot
      ? `${currentRoot} is not a Git repository`
      : "Open a folder to use Source Control";
  el("sc-sync").textContent = `↑${repoInfo?.ahead ?? 0} ↓${repoInfo?.behind ?? 0}`;

  branchSelect.replaceChildren();
  for (const branch of branches) {
    const option = document.createElement("option");
    option.value = branch.name;
    option.textContent = branch.current ? `${branch.name} ●` : branch.name;
    branchSelect.append(option);
  }
  if (hasRepo && !branches.some((branch) => branch.current)) {
    const option = document.createElement("option");
    option.value = repoInfo!.branch;
    option.textContent = repoInfo!.branch;
    branchSelect.append(option);
  }
  if (hasRepo) branchSelect.value = repoInfo!.branch;
  branchSelect.disabled = !hasRepo || branches.length === 0;

  const previousRemote = remoteSelect.value;
  remoteSelect.replaceChildren();
  for (const remote of remotes) {
    const option = document.createElement("option");
    option.value = remote.name;
    option.textContent = remote.name;
    option.title = remote.url;
    remoteSelect.append(option);
  }
  if (!remotes.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No remote";
    remoteSelect.append(option);
  } else if (remotes.some((remote) => remote.name === previousRemote)) {
    remoteSelect.value = previousRemote;
  }
  for (const id of ["sc-fetch", "sc-pull", "sc-push"]) {
    el<HTMLButtonElement>(id).disabled = !hasRepo || remotes.length === 0;
  }

  renderFileGroup("sc-conflicts", entries.filter((entry) => entry.conflict), false);
  renderFileGroup("sc-staged", entries.filter((entry) => entry.staged && !entry.conflict), true);
  renderFileGroup("sc-changes", entries.filter((entry) => !entry.staged && !entry.conflict), false);
  renderHistory();
}

async function refresh(): Promise<void> {
  const root = workspaceRoot();
  currentRoot = root;
  if (!root) {
    repoInfo = null;
    entries = [];
    branches = [];
    remotes = [];
    commits = [];
    render();
    setStatus("Open a folder to use Source Control.");
    return;
  }

  if (refreshing) return;
  refreshing = true;
  try {
    setStatus("Reading Git status…");
    repoInfo = await invoke<GitRepoInfo | null>("git_repo_info", { root });
    if (!repoInfo) {
      entries = [];
      branches = [];
      remotes = [];
      commits = [];
      render();
      setStatus("No Git repository found. Choose Initialize to create one.");
      return;
    }
    const [status, branchList, remoteList, log] = await Promise.all([
      invoke<GitFileStatus[]>("git_status", { root }),
      invoke<GitBranch[]>("git_branches", { root }),
      invoke<GitRemote[]>("git_remotes", { root }),
      invoke<GitCommit[]>("git_log", { root, limit: 12 }),
    ]);
    entries = status;
    branches = branchList;
    remotes = remoteList;
    commits = log;
    render();
    const conflicts = entries.filter((entry) => entry.conflict).length;
    setStatus(conflicts
      ? `${conflicts} merge conflict${conflicts === 1 ? "" : "s"} need attention.`
      : `${entries.length} change${entries.length === 1 ? "" : "s"}.`);
  } finally {
    refreshing = false;
  }
}

function scheduleRefresh(): void {
  if (pane().classList.contains("hidden")) return;
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    void refresh().catch(reportError);
  }, 250);
}

async function requireRoot(): Promise<string> {
  if (!currentRoot) throw new Error("Open a folder before using Source Control.");
  return currentRoot;
}

async function stagePaths(paths: string[]): Promise<void> {
  const root = await requireRoot();
  await invoke("git_stage", { root, paths });
  await refresh();
}

async function unstagePaths(paths: string[]): Promise<void> {
  const root = await requireRoot();
  await invoke("git_unstage", { root, paths });
  await refresh();
}

async function discardPaths(paths: string[]): Promise<void> {
  const root = await requireRoot();
  const label = paths.length === 1 ? paths[0] : `${paths.length} files`;
  if (!window.confirm(`Discard local changes in ${label}? This cannot be undone.`)) return;
  await invoke("git_discard", { root, paths });
  await refresh();
}

async function ignorePaths(paths: string[]): Promise<void> {
  const root = await requireRoot();
  const added = await invoke<number>("git_ignore", { root, paths });
  await refresh();
  setStatus(added ? `Added ${added} rule${added === 1 ? "" : "s"} to .gitignore.` : "Those paths are already ignored.");
}

function closeDiff(): void {
  el("sc-diff").classList.add("hidden");
  el("sc-diff-text").textContent = "";
  el("sc-diff-name").textContent = "";
  diffOpenPath = null;
  selectedFile = null;
  selectedCommit = null;
}

function showDiff(title: string, text: string, openPath: string | null): void {
  el("sc-diff-name").textContent = title;
  el("sc-diff-text").textContent = text.trim() || "No textual changes.";
  el<HTMLButtonElement>("sc-diff-open").classList.toggle("hidden", !openPath);
  diffOpenPath = openPath;
  el("sc-diff").classList.remove("hidden");
}

async function showFileDiff(entry: GitFileStatus): Promise<void> {
  const root = await requireRoot();
  selectedFile = { path: entry.path, staged: entry.staged };
  selectedCommit = null;
  let patch = await invoke<string>("git_diff", { root, path: entry.path, staged: entry.staged });
  if (!patch.trim() && !entry.staged) {
    patch = await invoke<string>("git_file_preview", { root, path: entry.path });
  }
  showDiff(entry.path, patch, absoluteRepoPath(entry.path));
  render();
}

async function showCommitDiff(commit: GitCommit): Promise<void> {
  const root = await requireRoot();
  selectedFile = null;
  selectedCommit = commit.hash;
  const patch = await invoke<string>("git_commit_diff", { root, hash: commit.hash });
  showDiff(`${commit.shortHash} ${commit.subject}`, patch, null);
  render();
}

function syncOptions(): { remote?: string; branch?: string } {
  const remote = el<HTMLSelectElement>("sc-remote").value;
  return {
    ...(remote ? { remote } : {}),
    ...(repoInfo && !repoInfo.detached ? { branch: repoInfo.branch } : {}),
  };
}

export async function openSourceControl(): Promise<void> {
  const target = pane();
  closeDiff();
  target.classList.remove("hidden");
  document.dispatchEvent(new CustomEvent<string>("talos:side-pane-change", { detail: target.id }));
  await refresh();
}

export function initSourceControl(): void {
  if (initialized) return;
  initialized = true;

  el("sc-refresh").addEventListener("click", () => {
    void refresh().catch(reportError);
  });
  el("sc-close").addEventListener("click", () => {
    closeDiff();
    pane().classList.add("hidden");
    document.dispatchEvent(new CustomEvent<string | null>("talos:side-pane-change", { detail: null }));
    document.dispatchEvent(new Event("talos:source-control-closed"));
  });
  el("sc-diff-close").addEventListener("click", closeDiff);
  el("sc-diff-open").addEventListener("click", () => {
    if (diffOpenPath) {
      document.dispatchEvent(new CustomEvent<string>("talos:open-path", { detail: diffOpenPath }));
    }
  });
  el("sc-branch").addEventListener("change", (event) => {
    const branch = (event.target as HTMLSelectElement).value;
    if (!branch || branch === repoInfo?.branch) return;
    void (async () => {
      const root = await requireRoot();
      await invoke("git_checkout", { root, branch });
      await refresh();
    })().catch(reportError);
  });
  el("sc-init").addEventListener("click", () => {
    void (async () => {
      const root = await requireRoot();
      await invoke("git_init", { root });
      await refresh();
    })().catch(reportError);
  });
  el("sc-stage-all").addEventListener("click", () => {
    void stagePaths(entries.filter((entry) => !entry.staged && !entry.conflict).map((entry) => entry.path))
      .catch(reportError);
  });
  el("sc-unstage-all").addEventListener("click", () => {
    void unstagePaths(entries.filter((entry) => entry.staged).map((entry) => entry.path))
      .catch(reportError);
  });
  el("sc-commit").addEventListener("click", () => {
    if (committing) return;
    void (async () => {
      const root = await requireRoot();
      const input = el<HTMLTextAreaElement>("sc-message");
      const message = input.value.trim();
      if (!message) {
        setStatus("Enter a commit message first.");
        return;
      }
      const button = el<HTMLButtonElement>("sc-commit");
      const originalLabel = button.textContent || "Commit";
      setBusy(true);
      button.disabled = true;
      button.textContent = "Committing…";
      try {
        const output = await invoke<string>("git_commit", { root, message });
        input.value = "";
        closeDiff();
        await refresh();
        setStatus(output.trim().split("\n")[0] || "Commit created.");
      } finally {
        setBusy(false);
        button.disabled = false;
        button.textContent = originalLabel;
      }
    })().catch(reportError);
  });
  el<HTMLTextAreaElement>("sc-message").addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      el<HTMLButtonElement>("sc-commit").click();
    }
  });
  el("sc-fetch").addEventListener("click", () => {
    void (async () => {
      const root = await requireRoot();
      const remote = el<HTMLSelectElement>("sc-remote").value;
      const output = await invoke<string>("git_fetch", { root, remote: remote || null });
      await refresh();
      setStatus(output.trim() || "Fetch complete.");
    })().catch(reportError);
  });
  el("sc-pull").addEventListener("click", () => {
    void (async () => {
      const root = await requireRoot();
      const output = await invoke<string>("git_pull", { root, ...syncOptions() });
      await refresh();
      setStatus(output.trim() || "Pull complete.");
    })().catch(reportError);
  });
  el("sc-push").addEventListener("click", () => {
    void (async () => {
      const root = await requireRoot();
      const output = await invoke<string>("git_push", { root, ...syncOptions() });
      await refresh();
      setStatus(output.trim() || "Push complete.");
    })().catch(reportError);
  });

  document.addEventListener("talos:workspace-change", scheduleRefresh);
  document.addEventListener("talos:workspace-opened", scheduleRefresh);
  document.addEventListener("talos:workspace-files-changed", (event) => {
    const detail = (event as CustomEvent<{ root?: string }>).detail;
    if (detail?.root && currentRoot && detail.root !== currentRoot) return;
    scheduleRefresh();
  });
}
