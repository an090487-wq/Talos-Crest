// Local-only analysis helpers for the three Observatory insight panels.
// This module has no Tauri imports so it can be tested directly. Nothing here
// executes project code, installs packages, or sends data anywhere.

export interface SourceLike {
  path: string;
  extension: string;
  content: string;
}

export interface FileCost {
  path: string;
  component: string;
  bytes: number;
  wall_ms: number;
  cpu_ms: number;
}

export interface ComponentCost {
  name: string;
  files: number;
  bytes: number;
  wall_ms: number;
  cpu_ms: number;
}

export interface PerformanceMeasurement {
  components: ComponentCost[];
  files: FileCost[];
  peak_rss_kb: number;
  wall_ms: number;
  cpu_ms: number;
  files_analyzed: number;
  warnings: string[];
}

export interface Budgets {
  wall_ms: number;
  cpu_ms: number;
  bytes: number;
}

export type BudgetStatus = "under" | "near" | "over";

export interface PerformanceRow extends ComponentCost {
  wall_status: BudgetStatus;
  cpu_status: BudgetStatus;
  bytes_status: BudgetStatus;
}

export const DEFAULT_BUDGETS: Budgets = { wall_ms: 250, cpu_ms: 150, bytes: 2 * 1024 * 1024 };

function statusOf(value: number, budget: number): BudgetStatus {
  if (!Number.isFinite(budget) || budget <= 0) return "under";
  if (value > budget) return "over";
  if (value >= budget * 0.8) return "near";
  return "under";
}

export function performanceRows(
  measurement: PerformanceMeasurement,
  budgets: Budgets,
): PerformanceRow[] {
  return measurement.components.map((component) => ({
    ...component,
    wall_status: statusOf(component.wall_ms, budgets.wall_ms),
    cpu_status: statusOf(component.cpu_ms, budgets.cpu_ms),
    bytes_status: statusOf(component.bytes, budgets.bytes),
  }));
}

export function budgetCounts(rows: PerformanceRow[]): Record<BudgetStatus, number> {
  const counts: Record<BudgetStatus, number> = { under: 0, near: 0, over: 0 };
  for (const row of rows) {
    if (row.wall_status === "over" || row.cpu_status === "over" || row.bytes_status === "over") {
      counts.over++;
    } else if (
      row.wall_status === "near" ||
      row.cpu_status === "near" ||
      row.bytes_status === "near"
    ) {
      counts.near++;
    } else {
      counts.under++;
    }
  }
  return counts;
}

// ---------- dependency sandbox ----------

export interface ManifestLike {
  path: string;
  name: string;
  content: string;
}

export type FindingSeverity = "info" | "warning" | "critical";

export interface DependencyFinding {
  severity: FindingSeverity;
  package: string;
  message: string;
  sources: string[];
}

export interface SandboxReport {
  manifests: number;
  declarations: number;
  findings: DependencyFinding[];
  isolated: true;
}

type Ecosystem = "npm" | "python" | "cargo" | "go" | "generic";

interface Declaration {
  specs: string[];
  sources: string[];
  checks: VersionCheck[];
}

function ecosystemOf(name: string): Ecosystem {
  switch (name.toLowerCase()) {
    case "package.json": return "npm";
    case "requirements.txt":
    case "pyproject.toml": return "python";
    case "cargo.toml": return "cargo";
    case "go.mod": return "go";
    default: return "generic";
  }
}

function splitRequirement(line: string): { name: string; spec: string } | null {
  const cleaned = line.split("#")[0].trim();
  if (!cleaned || cleaned.startsWith("-")) return null;
  const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*(.*)$/.exec(cleaned);
  if (!match) return null;
  return { name: match[1], spec: match[2].trim() || "any" };
}

function packageJsonDeclarations(content: string): Map<string, string> {
  const result = new Map<string, string>();
  const parsed: unknown = JSON.parse(content);
  if (!parsed || typeof parsed !== "object") return result;
  const root = parsed as Record<string, unknown>;
  for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
    const value = root[section];
    if (!value || typeof value !== "object") continue;
    for (const [name, spec] of Object.entries(value as Record<string, unknown>)) {
      if (typeof spec === "string") result.set(name, spec);
    }
  }
  return result;
}

function packageLockVersions(content: string): Map<string, string> {
  const result = new Map<string, string>();
  const parsed: unknown = JSON.parse(content);
  if (!parsed || typeof parsed !== "object") return result;
  const packages = (parsed as { packages?: unknown }).packages;
  if (!packages || typeof packages !== "object") return result;
  for (const [key, value] of Object.entries(packages as Record<string, unknown>)) {
    const marker = "node_modules/";
    const index = key.lastIndexOf(marker);
    if (index < 0) continue;
    const name = key.slice(index + marker.length);
    const version = (value as { version?: unknown } | null)?.version;
    if (name && typeof version === "string") result.set(name, version);
  }
  return result;
}

function requirementsDeclarations(content: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const requirement = splitRequirement(line);
    if (requirement) result.set(requirement.name, requirement.spec);
  }
  return result;
}

function cargoDeclarations(content: string): Map<string, string> {
  const result = new Map<string, string>();
  let inDependencies = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inDependencies = /^\[(dev-|build-)?dependencies(\.[^\]]+)?\]$/.test(line);
      continue;
    }
    if (!inDependencies || !line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals < 0) continue;
    const name = line.slice(0, equals).trim().replace(/^"|"$/g, "");
    const rest = line.slice(equals + 1).trim();
    const versionMatch = /version\s*=\s*"([^"]+)"/.exec(rest);
    const quoted = /^"([^"]+)"$/.exec(rest);
    const spec = versionMatch?.[1] ?? quoted?.[1] ?? (rest.startsWith("{") ? "any" : rest);
    if (name) result.set(name, spec || "any");
  }
  return result;
}

function pyprojectDeclarations(content: string): Map<string, string> {
  const result = new Map<string, string>();
  const addRequirement = (value: string) => {
    const requirement = splitRequirement(value);
    if (requirement) result.set(requirement.name, requirement.spec);
  };
  const addQuoted = (line: string) => {
    for (const match of line.matchAll(/(['"])(.*?)\1/g)) addRequirement(match[2]);
  };
  let section = "";
  let inArray = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (inArray) {
      addQuoted(line);
      if (line.includes("]")) inArray = false;
      continue;
    }
    if (line.startsWith("[")) {
      section = line.replace(/\s+/g, "");
      continue;
    }
    if (section === "[project]") {
      const match = /^dependencies\s*=\s*\[(.*)$/.exec(line);
      if (match) {
        addQuoted(match[1]);
        inArray = !match[1].includes("]");
        continue;
      }
    }
    if (section === "[project.optional-dependencies]") {
      const match = /^[A-Za-z0-9_.-]+\s*=\s*\[(.*)$/.exec(line);
      if (match) {
        addQuoted(match[1]);
        inArray = !match[1].includes("]");
        continue;
      }
    }
    const poetryTable =
      section === "[tool.poetry.dependencies]" ||
      /^\[tool\.poetry\.group\.[^.\]]+\.dependencies\]$/.test(section);
    if (poetryTable) {
      const equals = line.indexOf("=");
      if (equals < 0) continue;
      const name = line.slice(0, equals).trim().replace(/^['"]|['"]$/g, "");
      if (!name || name === "python") continue;
      const rest = line.slice(equals + 1).trim();
      const quoted = /^['"](.*?)['"]/.exec(rest);
      const version = /\bversion\s*=\s*['"](.*?)['"]/.exec(rest);
      result.set(name, (quoted?.[1] ?? version?.[1] ?? (rest.startsWith("{") ? "any" : rest)) || "any");
    }
  }
  return result;
}

function goModDeclarations(content: string): Map<string, string> {
  const result = new Map<string, string>();
  let inBlock = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim().replace(/\/\/.*$/, "");
    if (!line) continue;
    if (line === "require (") {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ")") {
      inBlock = false;
      continue;
    }
    const parts = (inBlock ? line : line.startsWith("require ") ? line.slice(8) : "").split(/\s+/);
    if (parts.length >= 2) result.set(parts[0], parts[1]);
  }
  return result;
}

function yarnLockVersions(content: string): Map<string, string> {
  const result = new Map<string, string>();
  let pendingName = "";
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw) && line.trim().endsWith(":")) {
      const selector = line.trim().slice(0, -1).split(",")[0].trim().replace(/^['"]|['"]$/g, "");
      const at = selector.lastIndexOf("@");
      pendingName = at > 0 ? selector.slice(0, at) : selector;
      continue;
    }
    const version = /^\s+version\s+["']([^"']+)["']/.exec(line);
    if (version && pendingName) {
      result.set(pendingName, version[1]);
      pendingName = "";
    }
  }
  return result;
}

function pnpmLockVersions(content: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.endsWith(":")) continue;
    const key = line.slice(0, -1).trim();
    let name = "";
    let version = "";
    if (key.startsWith("/")) {
      const parts = key.split("/").filter(Boolean);
      version = parts.pop() ?? "";
      name = parts.join("/");
    } else {
      const at = key.lastIndexOf("@");
      if (at > 0) {
        name = key.slice(0, at);
        version = key.slice(at + 1);
      }
    }
    if (name && /^\d/.test(version)) result.set(name, version);
  }
  return result;
}

function lockedVersions(manifests: ManifestLike[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const manifest of manifests) {
    switch (manifest.name.toLowerCase()) {
      case "package-lock.json":
        for (const [name, version] of packageLockVersions(manifest.content)) result.set(name, version);
        break;
      case "yarn.lock":
        for (const [name, version] of yarnLockVersions(manifest.content)) result.set(name, version);
        break;
      case "pnpm-lock.yaml":
        for (const [name, version] of pnpmLockVersions(manifest.content)) result.set(name, version);
        break;
      case "cargo.lock": {
        let name = "";
        for (const raw of manifest.content.split(/\r?\n/)) {
          const line = raw.trim();
          if (line.startsWith("name = ")) {
            name = line.slice(7).replace(/"/g, "");
          } else if (line.startsWith("version = ") && name) {
            result.set(name, line.slice(10).replace(/"/g, ""));
            name = "";
          }
        }
        break;
      }
      case "go.sum":
        for (const raw of manifest.content.split(/\r?\n/)) {
          const parts = raw.trim().split(/\s+/);
          const version = parts[1]?.replace(/\/go\.mod$/, "") ?? "";
          if (parts.length >= 2 && /^v\d/.test(version)) result.set(parts[0], version);
        }
        break;
      case "requirements.txt":
        for (const raw of manifest.content.split(/\r?\n/)) {
          const requirement = splitRequirement(raw);
          if (requirement && requirement.spec.startsWith("==")) {
            result.set(requirement.name, requirement.spec.slice(2));
          }
        }
        break;
    }
  }
  return result;
}

function declarationsFor(manifest: ManifestLike): Map<string, string> {
  switch (manifest.name.toLowerCase()) {
    case "package.json":
      return packageJsonDeclarations(manifest.content);
    case "requirements.txt":
      return requirementsDeclarations(manifest.content);
    case "cargo.toml":
      return cargoDeclarations(manifest.content);
    case "pyproject.toml":
      return pyprojectDeclarations(manifest.content);
    case "go.mod":
      return goModDeclarations(manifest.content);
    default:
      return new Map();
  }
}

interface VersionCheck {
  pinned: boolean;
  matches: (locked: string) => boolean;
}

function versionParts(value: string): number[] {
  const cleaned = value.trim().replace(/^v/i, "").split(/[+-]/, 1)[0];
  const parts = cleaned.split(".").map((part) => {
    const number = Number.parseInt(part, 10);
    return Number.isFinite(number) ? number : 0;
  });
  return parts.length ? parts : [0];
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function bumpVersion(value: string, index: number): string {
  const parts = versionParts(value);
  while (parts.length <= index) parts.push(0);
  parts[index] += 1;
  parts.length = index + 1;
  while (parts.length < 3) parts.push(0);
  return parts.join(".");
}

function compareComparator(locked: string, comparator: string): boolean {
  const match = /^(>=|<=|>|<|=)\s*(v?\d+(?:\.\d+)*)$/.exec(comparator.trim());
  if (!match) return true;
  const comparison = compareVersions(locked, match[2]);
  switch (match[1]) {
    case ">=": return comparison >= 0;
    case "<=": return comparison <= 0;
    case ">": return comparison > 0;
    case "<": return comparison < 0;
    default: return comparison === 0;
  }
}

function unpinnedVersion(): VersionCheck {
  return { pinned: false, matches: () => true };
}

function classifySpec(spec: string, ecosystem: Ecosystem): VersionCheck {
  const value = spec.trim();
  const lower = value.toLowerCase();
  if (
    !value || lower === "any" || lower === "*" || lower === "latest" ||
    value.includes("*") || value.includes(";") || value.includes("://") ||
    value.startsWith("git+") || value.startsWith("file:")
  ) {
    return unpinnedVersion();
  }

  if (ecosystem === "go") {
    return /^v?\d+\.\d+\.\d+$/.test(value)
      ? { pinned: true, matches: (locked) => compareVersions(locked, value) === 0 }
      : unpinnedVersion();
  }

  if (ecosystem === "python") {
    const exact = /^==\s*(v?\d+(?:\.\d+)*)$/.exec(value);
    if (exact) return { pinned: true, matches: (locked) => compareVersions(locked, exact[1]) === 0 };
    if (/^v?\d+(?:\.\d+)*$/.test(value)) {
      return { pinned: true, matches: (locked) => compareVersions(locked, value) === 0 };
    }
    const parts = value.split(",").map((part) => part.trim());
    if (parts.length && parts.every((part) => /^(>=|<=|>|<|=)\s*v?\d+(?:\.\d+)*$/.test(part))) {
      return { pinned: true, matches: (locked) => parts.every((part) => compareComparator(locked, part)) };
    }
    return unpinnedVersion();
  }

  const alternatives = value.split("||").map((part) => part.trim());
  if (alternatives.length > 1) {
    const checks = alternatives.map((part) => classifySpec(part, ecosystem));
    return checks.every((check) => check.pinned)
      ? { pinned: true, matches: (locked) => checks.some((check) => check.matches(locked)) }
      : unpinnedVersion();
  }

  const caret = /^\^\s*(v?\d+(?:\.\d+)*)$/.exec(value);
  if (caret) {
    const base = caret[1];
    const parts = versionParts(base);
    const upper = bumpVersion(base, (parts[0] ?? 0) > 0 ? 0 : (parts[1] ?? 0) > 0 ? 1 : 2);
    return {
      pinned: true,
      matches: (locked) => compareVersions(locked, base) >= 0 && compareVersions(locked, upper) < 0,
    };
  }
  const tilde = /^~\s*(v?\d+(?:\.\d+)*)$/.exec(value);
  if (tilde) {
    const base = tilde[1];
    const upper = bumpVersion(base, versionParts(base).length >= 3 ? 1 : 0);
    return {
      pinned: true,
      matches: (locked) => compareVersions(locked, base) >= 0 && compareVersions(locked, upper) < 0,
    };
  }
  if (/^v?\d+(?:\.\d+)*$/.test(value)) {
    // Cargo treats a bare version as a caret requirement; npm treats a complete
    // three-part version as exact and a shorter one as a range.
    if (ecosystem === "cargo") return classifySpec(`^${value}`, ecosystem);
    const exact = /^v?\d+\.\d+\.\d+$/.test(value);
    return {
      pinned: exact,
      matches: (locked) => !exact || compareVersions(locked, value) === 0,
    };
  }
  const parts = value.split(/[\s,]+/).filter(Boolean);
  if (parts.length && parts.every((part) => /^(>=|<=|>|<|=)?\s*v?\d+(?:\.\d+)*$/.test(part))) {
    const checks = parts.map((part) =>
      /^(>=|<=|>|<|=)/.test(part) ? part : `=${part}`,
    );
    return {
      pinned: true,
      matches: (locked) => checks.every((check) => compareComparator(locked, check)),
    };
  }
  return unpinnedVersion();
}

export function analyzeSandbox(manifests: ManifestLike[]): SandboxReport {
  const declarations = new Map<string, Declaration>();
  const findings: DependencyFinding[] = [];
  let count = 0;

  for (const manifest of manifests) {
    let parsed: Map<string, string>;
    try {
      parsed = declarationsFor(manifest);
    } catch (error) {
      findings.push({
        severity: "warning",
        package: "",
        message: `Could not parse ${manifest.name}: ${String(error)}`,
        sources: [manifest.path],
      });
      continue;
    }
    for (const [name, spec] of parsed) {
      count++;
      const check = classifySpec(spec, ecosystemOf(manifest.name));
      const existing = declarations.get(name);
      if (!existing) {
        declarations.set(name, { specs: [spec], sources: [manifest.path], checks: [check] });
        continue;
      }
      if (!existing.sources.includes(manifest.path)) existing.sources.push(manifest.path);
      if (!existing.specs.includes(spec)) {
        existing.specs.push(spec);
        existing.checks.push(check);
      }
    }
  }

  const locked = lockedVersions(manifests);
  const hasLockfile = manifests.some((manifest) =>
    ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "cargo.lock", "go.sum", "requirements.txt"]
      .includes(manifest.name.toLowerCase()),
  );

  for (const [name, declaration] of declarations) {
    if (declaration.specs.length > 1) {
      findings.push({
        severity: "critical",
        package: name,
        message: "Different version constraints are declared for this name in more than one manifest",
        sources: declaration.sources,
      });
    }
    let hasVerifiableSpec = false;
    declaration.specs.forEach((spec, index) => {
      const check = declaration.checks[index];
      if (!check?.pinned) {
        findings.push({
          severity: "warning",
          package: name,
          message: `Version is not pinned to an exact release (${spec})`,
          sources: declaration.sources,
        });
        return;
      }
      hasVerifiableSpec = true;
      const version = locked.get(name);
      if (version && !check.matches(version)) {
        findings.push({
          severity: "critical",
          package: name,
          message: `Locked version ${version} does not match declared version ${spec}`,
          sources: declaration.sources,
        });
      }
    });
    if (hasVerifiableSpec && hasLockfile && !locked.has(name)) {
      findings.push({
        severity: "warning",
        package: name,
        message: "No locked version found for this dependency",
        sources: declaration.sources,
      });
    }
  }

  if (count > 0 && !hasLockfile) {
    findings.push({
      severity: "warning",
      package: "",
      message: "No lockfile found; compatibility cannot be verified offline",
      sources: [],
    });
  }
  findings.push({
    severity: "info",
    package: "",
    message: "Isolated check: no project code was executed, nothing installed, no network access.",
    sources: [],
  });

  return { manifests: manifests.length, declarations: count, findings, isolated: true };
}

// ---------- technical debt ----------

export type DebtLevel = "Low" | "Moderate" | "High" | "Critical";

export interface DebtFile {
  path: string;
  lines: number;
  complexity: number;
  duplicated: number;
  markers: number;
  longLines: number;
  risk: number;
  level: DebtLevel;
}

export interface DebtReport {
  files: DebtFile[];
  totalLines: number;
  averageRisk: number;
  hotspots: DebtFile[];
}

const JS_BRANCH = /\b(if|for|while|case|catch|switch|try|else)\b|&&|\|\||\?\?/g;
const PY_BRANCH = /\b(if|elif|for|while|except|with|and|or|assert)\b/g;

function skipLine(line: string, extension: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (extension === "py") return trimmed.startsWith("#");
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("*/")
  );
}

function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, " ").toLowerCase();
}

function levelOf(risk: number): DebtLevel {
  if (risk < 20) return "Low";
  if (risk < 45) return "Moderate";
  if (risk < 70) return "High";
  return "Critical";
}

export function analyzeDebt(sources: SourceLike[]): DebtReport {
  const normalizedCounts = new Map<string, number>();
  for (const source of sources) {
    for (const line of source.content.split(/\r?\n/)) {
      if (skipLine(line, source.extension)) continue;
      const normalized = normalizeLine(line);
      normalizedCounts.set(normalized, (normalizedCounts.get(normalized) ?? 0) + 1);
    }
  }

  const files: DebtFile[] = sources.map((source) => {
    const lines = source.content.split(/\r?\n/).length;
    const branch = source.extension === "py" ? PY_BRANCH : JS_BRANCH;
    let complexity = 1;
    let duplicated = 0;
    let markers = 0;
    let longLines = 0;
    for (const line of source.content.split(/\r?\n/)) {
      const matches = line.match(branch);
      if (matches) complexity += matches.length;
      if (line.length > 120) longLines++;
      if (/\b(TODO|FIXME|HACK|XXX)\b/.test(line)) markers++;
      if (!skipLine(line, source.extension) && (normalizedCounts.get(normalizeLine(line)) ?? 0) > 1) {
        duplicated++;
      }
    }
    const risk = Math.min(
      100,
      Math.round(complexity * 1.4 + duplicated * 2 + markers * 3 + longLines * 0.5 + lines / 60),
    );
    return {
      path: source.path,
      lines,
      complexity,
      duplicated,
      markers,
      longLines,
      risk,
      level: levelOf(risk),
    };
  });

  files.sort((left, right) => right.risk - left.risk || left.path.localeCompare(right.path));
  const totalLines = files.reduce((total, file) => total + file.lines, 0);
  const averageRisk = files.length
    ? Math.round(files.reduce((total, file) => total + file.risk, 0) / files.length)
    : 0;
  return { files, totalLines, averageRisk, hotspots: files.filter((file) => file.risk >= 45).slice(0, 12) };
}
