import { invoke } from "@tauri-apps/api/core";
import { getWindowValue, setWindowValue } from "./window-state";
import {
  INITIAL_WORKSPACE_STATE,
  workspaceError,
  workspaceIndexing,
  workspaceOpening,
  workspaceReady,
  workspaceWatcher,
  type WorkspaceIndexStatus,
  type WorkspaceScanLike,
  type WorkspaceState,
  type WorkspaceWatcherStatus,
} from "./workspace-state";

interface RecentWorkspace {
  path: string;
}

type WorkspaceListener = (state: Readonly<WorkspaceState>) => void;

const listeners = new Set<WorkspaceListener>();
let state: WorkspaceState = INITIAL_WORKSPACE_STATE;

function publish(next: WorkspaceState): void {
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener(state);
}

export function currentWorkspace(): Readonly<WorkspaceState> {
  return state;
}

export function subscribeWorkspace(listener: WorkspaceListener): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

export function workspaceRoot(): string | null {
  return getWindowValue("talos.workspace-root");
}

export function rememberWorkspaceRoot(root: string): void {
  setWindowValue("talos.workspace-root", root);
}

export async function workspaceRestoreCandidates(): Promise<string[]> {
  const roots: string[] = [];
  const saved = workspaceRoot();
  if (saved) roots.push(saved);
  try {
    const recent = await invoke<RecentWorkspace[]>("list_recent_workspaces");
    for (const item of recent) {
      if (item.path && !roots.includes(item.path)) roots.push(item.path);
    }
  } catch {
    // Recent projects are only a fallback; restoring the saved root still works.
  }
  return roots;
}

export function markWorkspaceOpening(root: string): void {
  publish(workspaceOpening(root));
}

export function markWorkspaceReady(scan: WorkspaceScanLike, watcher: WorkspaceWatcherStatus): void {
  publish(workspaceReady(state, scan, watcher));
}

export function markWorkspaceError(root: string, error: unknown): void {
  publish(workspaceError(state, root, error));
}

export function markWorkspaceWatcher(watcher: WorkspaceWatcherStatus): void {
  publish(workspaceWatcher(state, watcher));
}

export function markWorkspaceIndexing(indexing: WorkspaceIndexStatus): void {
  publish(workspaceIndexing(state, indexing));
}
