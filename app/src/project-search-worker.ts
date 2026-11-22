import { searchProjectFiles } from "./project-search";
import type { ProjectSearchEntry } from "./project-search";

type SearchWorkerRequest =
  | { type: "index"; entries: ProjectSearchEntry[] }
  | { type: "search"; requestId: number; query: string; recentPaths: string[] };

type SearchWorkerResponse = {
  requestId: number;
  results: ProjectSearchEntry[];
};

let entries: ProjectSearchEntry[] = [];

self.addEventListener("message", (event: MessageEvent<SearchWorkerRequest>) => {
  if (event.data.type === "index") {
    entries = event.data.entries;
    return;
  }
  const response: SearchWorkerResponse = {
    requestId: event.data.requestId,
    results: searchProjectFiles(entries, event.data.query, event.data.recentPaths, 100),
  };
  self.postMessage(response);
});
