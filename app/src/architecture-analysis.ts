export interface SourceFile {
  path: string;
  extension: string;
  content: string;
}

export interface DependencyEdge {
  from: string;
  to: string;
  specifier: string;
  circular: boolean;
}

export interface DependencyResult {
  edges: DependencyEdge[];
  unresolved: string[];
  unreferenced: string[];
  analyzedFiles: number;
}

export interface ArchitectureComponent {
  id: string;
  label: string;
  evidence: string[];
  files: string[];
}

function normalized(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function directory(path: string): string {
  const clean = normalized(path);
  const slash = clean.lastIndexOf("/");
  return slash < 0 ? "" : clean.slice(0, slash);
}

function basename(path: string): string {
  return normalized(path).split("/").pop() ?? path;
}

function joinPath(base: string, value: string): string {
  const absolute = value.startsWith("/") || base.startsWith("/");
  const segments = (value.startsWith("/") ? value : `${base}/${value}`).split("/");
  const normalizedSegments: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") normalizedSegments.pop();
    else normalizedSegments.push(segment);
  }
  return `${absolute ? "/" : ""}${normalizedSegments.join("/")}`;
}

function resolveJavascript(specifier: string, importer: string, known: Set<string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = joinPath(directory(importer), specifier);
  const candidates = [
    base,
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json"].map((ext) => base + ext),
    ...["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs", "index.cjs"].map((name) => `${base}/${name}`),
  ];
  return candidates.map(normalized).find((candidate) => known.has(candidate));
}

function resolvePython(
  specifier: string,
  importer: string,
  root: string,
  known: Set<string>
): string | undefined {
  const dotCount = specifier.match(/^\.+/)?.[0].length ?? 0;
  const module = specifier.slice(dotCount);
  let base = root;
  if (dotCount > 0) {
    base = directory(importer);
    for (let i = 1; i < dotCount; i++) base = directory(base);
  }
  const relativeModule = module.replace(/\./g, "/");
  const candidateBase = relativeModule ? joinPath(base, relativeModule) : base;
  const candidates = [
    `${candidateBase}.py`,
    `${candidateBase}/__init__.py`,
  ];
  return candidates.map(normalized).find((candidate) => known.has(candidate));
}

function importsFrom(source: SourceFile): string[] {
  const imports = new Set<string>();
  const extension = source.extension.toLowerCase();
  if (extension === "py") {
    for (const line of source.content.split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const imported = line.match(/^\s*import\s+(.+)/);
      if (imported) {
        for (const module of imported[1].split(",")) {
          const item = module.trim().match(/^([A-Za-z_][\w.]*)/);
          if (item) imports.add(item[1]);
        }
      }
      const from = line.match(/^\s*from\s+([.\w]+)\s+import\s+(.+)/);
      if (from) {
        imports.add(from[1]);
        if (/^\.+$/.test(from[1])) {
          for (const name of from[2].split(",")) {
            const item = name.trim().match(/^([A-Za-z_]\w*)/);
            if (item && item[1] !== "*") imports.add(from[1] + item[1]);
          }
        }
      }
    }
    return [...imports];
  }

  const expression = /\b(?:import\s+(?:[^'"]*?\s+from\s+)?|export\s+[^'"]*?\s+from\s+|require\s*\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const line of source.content.split(/\r?\n/)) {
    if (/^\s*(?:\/\/|\/\*|\*|\*)/.test(line)) continue;
    for (const match of line.matchAll(expression)) imports.add(match[1]);
  }
  return [...imports];
}

function findCircularEdges(edges: DependencyEdge[]): void {
  const adjacency = new Map<string, string[]>();
  const nodes = new Set<string>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
    nodes.add(edge.from);
    nodes.add(edge.to);
  }
  const reverse = new Map<string, string[]>();
  for (const [from, targets] of adjacency) {
    for (const to of targets) {
      const incoming = reverse.get(to) ?? [];
      incoming.push(from);
      reverse.set(to, incoming);
    }
  }
  const visited = new Set<string>();
  const order: string[] = [];
  for (const start of nodes) {
    if (visited.has(start)) continue;
    visited.add(start);
    const stack: { node: string; next: number }[] = [{ node: start, next: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const targets = adjacency.get(frame.node) ?? [];
      if (frame.next >= targets.length) {
        order.push(frame.node);
        stack.pop();
        continue;
      }
      const target = targets[frame.next++];
      if (visited.has(target)) continue;
      visited.add(target);
      stack.push({ node: target, next: 0 });
    }
  }

  const componentByNode = new Map<string, number>();
  const cyclicComponents = new Set<number>();
  let componentIndex = 0;
  for (let index = order.length - 1; index >= 0; index--) {
    const start = order[index];
    if (componentByNode.has(start)) continue;
    const id = componentIndex++;
    const component: string[] = [];
    const stack = [start];
    componentByNode.set(start, id);
    while (stack.length) {
      const node = stack.pop()!;
      component.push(node);
      for (const source of reverse.get(node) ?? []) {
        if (componentByNode.has(source)) continue;
        componentByNode.set(source, id);
        stack.push(source);
      }
    }
    if (component.length > 1 || (adjacency.get(start) ?? []).includes(start)) cyclicComponents.add(id);
  }
  for (const edge of edges) {
    const from = componentByNode.get(edge.from);
    edge.circular = from !== undefined && from === componentByNode.get(edge.to) && cyclicComponents.has(from);
  }
}

export function analyzeDependencies(
  root: string,
  sources: SourceFile[],
  allFilePaths: string[],
): DependencyResult {
  const normalizedRoot = normalized(root);
  const known = new Set(allFilePaths.map(normalized));
  const edges: DependencyEdge[] = [];
  const unresolved: string[] = [];
  const incoming = new Set<string>();
  const seen = new Set<string>();
  for (const source of sources) {
    const sourcePath = normalized(source.path);
    for (const specifier of importsFrom(source)) {
      let target: string | undefined;
      if (source.extension === "py") {
        target = resolvePython(specifier, sourcePath, normalizedRoot, known);
        if (!target && specifier.startsWith(".") && !/^\.+$/.test(specifier)) {
          unresolved.push(`${basename(sourcePath)} → ${specifier}`);
        }
      } else {
        target = resolveJavascript(specifier, sourcePath, known);
        if (!target && specifier.startsWith(".")) {
          unresolved.push(`${basename(sourcePath)} → ${specifier}`);
        }
      }
      if (!target || target === sourcePath) {
        if (target === sourcePath) {
          const key = `${sourcePath}\0${sourcePath}`;
          if (!seen.has(key)) {
            seen.add(key);
            edges.push({ from: sourcePath, to: sourcePath, specifier, circular: true });
          }
        }
        continue;
      }
      const key = `${sourcePath}\0${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: sourcePath, to: target, specifier, circular: false });
      incoming.add(target);
    }
  }
  findCircularEdges(edges);
  const analyzed = new Set(sources.map((source) => normalized(source.path)));
  const unreferenced = [...analyzed].filter((path) => !incoming.has(path));
  return { edges, unresolved, unreferenced, analyzedFiles: sources.length };
}

const COMPONENTS: { id: string; label: string; terms: string[] }[] = [
  { id: "authentication", label: "Authentication", terms: ["auth", "authentication", "login", "session"] },
  { id: "database", label: "Database", terms: ["database", "db", "model", "models", "migration", "schema", "repository"] },
  { id: "api", label: "API layer", terms: ["api", "route", "routes", "endpoint", "controller", "handler"] },
  { id: "frontend", label: "Frontend", terms: ["frontend", "ui", "component", "components", "pages", "views", "web"] },
  { id: "backend", label: "Backend", terms: ["backend", "server", "service", "worker"] },
  { id: "configuration", label: "Configuration", terms: ["config", "configuration", "settings", "environment"] },
  { id: "utilities", label: "Utilities", terms: ["util", "utils", "helper", "helpers", "common", "shared"] },
  { id: "integrations", label: "External integrations", terms: ["integration", "integrations", "adapter", "provider", "client", "plugin"] },
  { id: "tests", label: "Tests", terms: ["test", "tests", "spec", "specs", "__tests__"] },
];

export function classifyArchitecture(root: string, paths: string[]): ArchitectureComponent[] {
  const rootPath = normalized(root);
  const groups = new Map<string, ArchitectureComponent>();
  for (const path of paths) {
    const relative = normalized(path).slice(rootPath.length).replace(/^\/+/, "");
    const segments = relative.split("/");
    const tokens = segments.flatMap((segment) => segment.toLowerCase().split(/[^a-z0-9]+/));
    const component = COMPONENTS.find((candidate) =>
      tokens.some((token) => candidate.terms.includes(token))
    );
    const id = component?.id ?? "other";
    const label = component?.label ?? "Other";
    const group = groups.get(id) ?? { id, label, evidence: [], files: [] };
    group.files.push(path);
    if (component) {
      for (const term of component.terms) {
        if (tokens.includes(term) && !group.evidence.includes(term)) group.evidence.push(term);
      }
    }
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}
