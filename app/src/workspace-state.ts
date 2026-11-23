export type WorkspaceStatus = "closed" | "opening" | "ready" | "error";
export type WorkspaceWatcherStatus = "idle" | "active" | "error";
export type WorkspaceIndexStatus = "idle" | "indexing";

export interface WorkspaceOverview {
  id: string;
  root: string;
  files: number;
  directories: number;
  links: number;
  warnings: number;
  truncated: boolean;
}

export interface WorkspaceState {
  status: WorkspaceStatus;
  root: string | null;
  id: string | null;
  name: string | null;
  overview: WorkspaceOverview | null;
  watcher: WorkspaceWatcherStatus;
  indexing: WorkspaceIndexStatus;
  message: string;
}

export interface WorkspaceScanLike {
  id: string;
  root: string;
  entries: readonly { kind: "directory" | "file" | "link" }[];
  warnings: readonly unknown[];
  truncated: boolean;
}

export const INITIAL_WORKSPACE_STATE: WorkspaceState = {
  status: "closed",
  root: null,
  id: null,
  name: null,
  overview: null,
  watcher: "idle",
  indexing: "idle",
  message: "No workspace open",
};

export function workspaceNameFromRoot(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).filter(Boolean).pop() ?? root;
}

export function workspaceOpening(root: string): WorkspaceState {
  const name = workspaceNameFromRoot(root);
  return {
    ...INITIAL_WORKSPACE_STATE,
    status: "opening",
    root,
    name,
    message: `Opening ${name}…`,
  };
}

export function workspaceReady(
  state: WorkspaceState,
  scan: WorkspaceScanLike,
  watcher: WorkspaceWatcherStatus,
): WorkspaceState {
  let files = 0;
  let directories = 0;
  let links = 0;
  for (const entry of scan.entries) {
    if (entry.kind === "file") files++;
    else if (entry.kind === "directory") directories++;
    else links++;
  }
  const name = workspaceNameFromRoot(scan.root);
  return {
    ...state,
    status: "ready",
    root: scan.root,
    id: scan.id,
    name,
    overview: {
      id: scan.id,
      root: scan.root,
      files,
      directories,
      links,
      warnings: scan.warnings.length,
      truncated: scan.truncated,
    },
    watcher,
    message: scan.truncated ? `${name} opened; scan limit reached` : `${name} ready`,
  };
}

export function workspaceError(state: WorkspaceState, root: string, error: unknown): WorkspaceState {
  const name = workspaceNameFromRoot(root);
  return {
    ...state,
    status: "error",
    root,
    name,
    overview: null,
    watcher: "idle",
    indexing: "idle",
    message: `Could not open ${name}: ${String(error)}`,
  };
}

export function workspaceWatcher(
  state: WorkspaceState,
  watcher: WorkspaceWatcherStatus,
): WorkspaceState {
  if (!state.root) return state;
  return { ...state, watcher };
}

export function workspaceIndexing(
  state: WorkspaceState,
  indexing: WorkspaceIndexStatus,
): WorkspaceState {
  return { ...state, indexing };
}
