export interface DocumentTabSession {
  path: string | null;
  suggestedName: string | null;
  anchor: number;
  head: number;
  scrollTop: number;
  contents?: string;
}

export interface WindowTabsSession {
  version: 1;
  documents: DocumentTabSession[];
  activeIndex: number;
  closedTabs?: DocumentTabSession[];
}

export class DocumentTabRegistry<T extends Pick<DocumentTabSession, "path">> {
  readonly openTabs: T[] = [];
  readonly closedTabs: T[] = [];

  constructor(private readonly recentlyClosedLimit = 20) {}

  open(tab: T): { tab: T; created: boolean } {
    if (tab.path !== null) {
      const existing = findDocumentIndex(this.openTabs, tab.path);
      if (existing >= 0) return { tab: this.openTabs[existing], created: false };
    }
    this.openTabs.push(tab);
    return { tab, created: true };
  }

  close(tab: T): number {
    const index = this.openTabs.indexOf(tab);
    if (index < 0) return -1;
    this.openTabs.splice(index, 1);
    this.closedTabs.push(tab);
    if (this.closedTabs.length > this.recentlyClosedLimit) this.closedTabs.shift();
    return index;
  }

  reopen(): T | null {
    const tab = this.closedTabs.pop();
    if (!tab) return null;
    if (tab.path !== null) {
      const existing = findDocumentIndex(this.openTabs, tab.path);
      if (existing >= 0) return this.openTabs[existing];
    }
    this.openTabs.push(tab);
    return tab;
  }

  replace(tabs: readonly T[]): void {
    this.openTabs.splice(0, this.openTabs.length, ...tabs);
    this.closedTabs.length = 0;
  }
}

export function documentKey(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  const isWindows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
  const root = slashed.startsWith("/")
    ? "/"
    : isWindows && /^[a-z]:\//i.test(slashed)
      ? slashed.slice(0, 3)
      : "";
  const segments: string[] = [];
  for (const segment of slashed.slice(root.length).split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === ".." && segments.length && segments[segments.length - 1] !== "..") {
      segments.pop();
    } else if (segment !== ".." || !root) {
      segments.push(segment);
    }
  }
  const normalized = root + segments.join("/");
  return isWindows ? normalized.toLocaleLowerCase() : normalized;
}

export function findDocumentIndex(
  documents: readonly Pick<DocumentTabSession, "path">[],
  path: string,
): number {
  const key = documentKey(path);
  return documents.findIndex(
    (document) => document.path !== null && documentKey(document.path) === key,
  );
}

export function nextDocumentIndex(current: number, count: number, direction: -1 | 1): number {
  if (count < 1) return -1;
  return (current + direction + count) % count;
}

function parseTabSessions(value: unknown, limit: number, seen: Set<string>): DocumentTabSession[] {
  if (!Array.isArray(value) || value.length > limit) return [];
  const sessions: DocumentTabSession[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const tab = candidate as Record<string, unknown>;
    if (
      !(typeof tab.path === "string" || tab.path === null) ||
      !(typeof tab.suggestedName === "string" || tab.suggestedName === null) ||
      !Number.isSafeInteger(tab.anchor) ||
      !Number.isSafeInteger(tab.head) ||
      typeof tab.scrollTop !== "number" ||
      !Number.isFinite(tab.scrollTop) ||
      tab.scrollTop < 0 ||
      (tab.contents !== undefined && typeof tab.contents !== "string")
    ) {
      continue;
    }
    if (tab.path !== null) {
      const key = documentKey(tab.path);
      if (!key || seen.has(key)) continue;
      seen.add(key);
    }
    sessions.push({
      path: tab.path,
      suggestedName: tab.suggestedName,
      anchor: Math.max(0, tab.anchor as number),
      head: Math.max(0, tab.head as number),
      scrollTop: tab.scrollTop,
      ...(typeof tab.contents === "string" ? { contents: tab.contents } : {}),
    });
  }
  return sessions;
}

export function parseWindowTabsSession(value: string | null): WindowTabsSession | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1 || !Array.isArray(record.documents) || record.documents.length > 200) {
      return null;
    }

    const seen = new Set<string>();
    const documents = parseTabSessions(record.documents, 200, seen);
    const closedTabs = parseTabSessions(record.closedTabs, 20, seen);
    if (!documents.length && !closedTabs.length) return null;
    const activeIndex =
      typeof record.activeIndex === "number" && Number.isInteger(record.activeIndex)
        ? Math.min(Math.max(record.activeIndex, 0), Math.max(documents.length - 1, 0))
        : 0;
    return { version: 1, documents, activeIndex, closedTabs };
  } catch {
    return null;
  }
}
