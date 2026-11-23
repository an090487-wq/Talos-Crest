/** Pure path helpers shared by workspace-aware UI code. */
export function normalizeWorkspacePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\0/g, "");
}

export function trimWorkspaceRoot(value: string): string {
  return normalizeWorkspacePath(value).replace(/\/+$/, "");
}

export function sameWorkspaceRoot(left: string, right: string): boolean {
  if (!left || !right) return false;
  const a = trimWorkspaceRoot(left);
  const b = trimWorkspaceRoot(right);
  return /^[A-Za-z]:/.test(a)
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

export function isInsideWorkspace(candidate: string, root: string): boolean {
  if (!root) return false;
  const normalizedCandidate = trimWorkspaceRoot(candidate);
  const normalizedRoot = trimWorkspaceRoot(root);
  if (/^[A-Za-z]:/.test(normalizedRoot)) {
    const lowerCandidate = normalizedCandidate.toLowerCase();
    const lowerRoot = normalizedRoot.toLowerCase();
    return lowerCandidate === lowerRoot || lowerCandidate.startsWith(`${lowerRoot}/`);
  }
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

/** Resolve an evidence path without ever escaping the current workspace. */
export function resolveWorkspacePath(root: string, sourcePath: string | null | undefined): string | null {
  if (!sourcePath || !root) return null;
  const normalizedRoot = trimWorkspaceRoot(root);
  const value = normalizeWorkspacePath(sourcePath);
  if (value.startsWith("/") || /^[A-Za-z]:\//.test(value)) {
    const candidate = trimWorkspaceRoot(value);
    return isInsideWorkspace(candidate, normalizedRoot) ? candidate : null;
  }
  const parts: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  if (!parts.length) return null;
  const candidate = `${normalizedRoot}/${parts.join("/")}`;
  return isInsideWorkspace(candidate, normalizedRoot) ? candidate : null;
}
