export interface ProjectSearchEntry {
  path: string;
  name: string;
  kind: "directory" | "file" | "link";
}

function fuzzyScore(name: string, path: string, query: string): number | null {
  if (!query) return 0;
  const lowerName = name.toLocaleLowerCase();
  const lowerPath = path.toLocaleLowerCase();
  if (lowerName === query) return 0;
  const nameIndex = lowerName.indexOf(query);
  if (nameIndex >= 0) return 1 + nameIndex / 100;
  const pathIndex = lowerPath.indexOf(query);
  if (pathIndex >= 0) return 2 + pathIndex / 100;

  let queryIndex = 0;
  let first = -1;
  let previous = -1;
  let gaps = 0;
  for (let index = 0; index < lowerPath.length && queryIndex < query.length; index++) {
    if (lowerPath[index] !== query[queryIndex]) continue;
    if (first < 0) first = index;
    if (previous >= 0) gaps += index - previous - 1;
    previous = index;
    queryIndex++;
  }
  if (queryIndex !== query.length) return null;
  return 10 + gaps + first / 10 + lowerPath.length / 1000;
}

export function searchProjectFiles<T extends ProjectSearchEntry>(
  entries: readonly T[],
  queryText: string,
  recentPaths: readonly string[] = [],
  limit = 100
): T[] {
  const query = queryText.trim().toLocaleLowerCase();
  const recency = new Map(recentPaths.map((path, index) => [path, index]));
  const ranked: { entry: T; score: number; recent: number }[] = [];
  for (const entry of entries) {
    if (entry.kind !== "file") continue;
    if (!query) {
      const recent = recency.get(entry.path);
      if (recent === undefined) continue;
      ranked.push({ entry, score: 0, recent });
      continue;
    }
    const score = fuzzyScore(entry.name, entry.path, query);
    if (score !== null) {
      ranked.push({ entry, score, recent: recency.get(entry.path) ?? Number.MAX_SAFE_INTEGER });
    }
  }
  ranked.sort(
    (a, b) =>
      a.score - b.score ||
      a.recent - b.recent ||
      a.entry.path.localeCompare(b.entry.path)
  );
  return ranked.slice(0, Math.max(0, limit)).map(({ entry }) => entry);
}
