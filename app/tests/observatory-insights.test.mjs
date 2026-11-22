import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(appDir, "src/observatory-insights.ts");
const source = await readFile(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleRecord = { exports: {} };
new Function("require", "module", "exports", compiled)(
  createRequire(sourcePath),
  moduleRecord,
  moduleRecord.exports
);
const {
  DEFAULT_BUDGETS,
  analyzeDebt,
  analyzeSandbox,
  budgetCounts,
  performanceRows,
} = moduleRecord.exports;

test("performance rows classify budgets and count the worst status", () => {
  const measurement = {
    components: [
      { name: "src", files: 2, bytes: 100, wall_ms: 10, cpu_ms: 5 },
      { name: "app", files: 3, bytes: 2_000_000, wall_ms: 240, cpu_ms: 140 },
      { name: "docs", files: 1, bytes: 50, wall_ms: 300, cpu_ms: 10 },
    ],
    files: [],
    peak_rss_kb: 1024,
    wall_ms: 550,
    cpu_ms: 155,
    files_analyzed: 6,
    warnings: [],
  };
  const rows = performanceRows(measurement, DEFAULT_BUDGETS);
  assert.equal(rows[0].wall_status, "under");
  assert.equal(rows[1].wall_status, "near");
  assert.equal(rows[1].bytes_status, "near");
  assert.equal(rows[2].wall_status, "over");
  const counts = budgetCounts(rows);
  assert.equal(counts.under, 1);
  assert.equal(counts.near, 1);
  assert.equal(counts.over, 1);
});

test("dependency sandbox reports conflicts, unpinned versions and lockfile mismatches", () => {
  const report = analyzeSandbox([
    {
      path: "/p/package.json",
      name: "package.json",
      content: JSON.stringify({ dependencies: { left: "^1.0.0", right: "2.0.0", loose: "*" } }),
    },
    {
      path: "/p/requirements.txt",
      name: "requirements.txt",
      content: "left==1.4.0\n",
    },
    {
      path: "/p/package-lock.json",
      name: "package-lock.json",
      content: JSON.stringify({
        packages: {
          "node_modules/left": { version: "1.9.0" },
          "node_modules/right": { version: "2.0.0" },
        },
      }),
    },
  ]);
  assert.equal(report.declarations, 4);
  assert.equal(report.isolated, true);
  const critical = report.findings.filter((finding) => finding.severity === "critical");
  assert.ok(critical.some((finding) => finding.package === "left" && /[Dd]ifferent version constraints/.test(finding.message)));
  assert.ok(critical.some((finding) => finding.package === "left" && /Locked version/.test(finding.message)));
  assert.ok(report.findings.some((finding) => finding.package === "loose" && /not pinned/.test(finding.message)));
  assert.ok(report.findings.some((finding) => finding.severity === "info" && /Isolated check/.test(finding.message)));
});

test("dependency sandbox handles invalid manifests without throwing", () => {
  const report = analyzeSandbox([
    { path: "/p/package.json", name: "package.json", content: "{ not json" },
    { path: "/p/go.mod", name: "go.mod", content: "module demo\n\ngo 1.22\n\nrequire example.com/lib v1.2.3\n" },
  ]);
  assert.ok(report.findings.some((finding) => /Could not parse/.test(finding.message)));
  assert.equal(report.declarations, 1);
});

test("dependency sandbox understands Cargo and Go version syntax", () => {
  const report = analyzeSandbox([
    {
      path: "/p/Cargo.toml",
      name: "cargo.toml",
      content: '[package]\nname = "demo"\n\n[dependencies]\nserde = "1"\n',
    },
    {
      path: "/p/Cargo.lock",
      name: "cargo.lock",
      content: '[[package]]\nname = "serde"\nversion = "1.0.200"\n',
    },
    {
      path: "/p/go.mod",
      name: "go.mod",
      content: "module demo\n\ngo 1.22\n\nrequire example.com/lib v1.2.3\n",
    },
    {
      path: "/p/go.sum",
      name: "go.sum",
      content: "example.com/lib v1.2.3 h1:abc=\nexample.com/lib v1.2.3/go.mod h1:def=\n",
    },
  ]);
  assert.equal(report.findings.filter((finding) => finding.severity === "critical").length, 0);
  assert.ok(!report.findings.some((finding) => finding.package === "serde" && /not pinned/.test(finding.message)));
  assert.ok(!report.findings.some((finding) => finding.package === "example.com/lib" && /not pinned/.test(finding.message)));
});

test("dependency sandbox reads compact and Poetry pyproject layouts", () => {
  const report = analyzeSandbox([
    {
      path: "/p/pyproject.toml",
      name: "pyproject.toml",
      content: [
        "[project]",
        'dependencies=["requests>=2.0"]',
        "",
        "[project.optional-dependencies]",
        "dev = [",
        '  "pytest>=7",',
        "]",
        "",
        "[tool.poetry.dependencies]",
        'python = "^3.10"',
        'click = "^8.0"',
        "",
        "[tool.poetry.group.dev.dependencies]",
        'ruff = {version = "0.5.0", optional = true}',
        "",
      ].join("\n"),
    },
  ]);
  assert.equal(report.declarations, 4);
  assert.ok(!report.findings.some((finding) => /Could not parse/.test(finding.message)));
});

test("dependency sandbox accepts yarn and pnpm lockfiles", () => {
  const packageJson = {
    path: "/p/package.json",
    name: "package.json",
    content: JSON.stringify({ dependencies: { left: "1.0.0" } }),
  };
  const yarn = {
    path: "/p/yarn.lock",
    name: "yarn.lock",
    content: 'left@1.0.0:\n  version "1.0.0"\n',
  };
  const pnpm = {
    path: "/p/pnpm-lock.yaml",
    name: "pnpm-lock.yaml",
    content: "lockfileVersion: '9.0'\n\npackages:\n  /left/1.0.0:\n    resolution: {integrity: sha512-abc}\n",
  };
  for (const lock of [yarn, pnpm]) {
    const report = analyzeSandbox([packageJson, lock]);
    assert.ok(!report.findings.some((finding) => /No lockfile found/.test(finding.message)));
    assert.ok(!report.findings.some((finding) => /No locked version found/.test(finding.message)));
  }
});

test("technical debt detects complexity, repeated lines and markers", () => {
  const report = analyzeDebt([
    {
      path: "/p/src/a.ts",
      extension: "ts",
      content: "export function a(x) {\n  if (x && x > 1) {\n    return x;\n  }\n  // TODO: handle this\n  return 0;\n}\n",
    },
    {
      path: "/p/src/b.ts",
      extension: "ts",
      content: "export function b(x) {\n  if (x && x > 1) {\n    return x;\n  }\n  return 0;\n}\n",
    },
  ]);
  assert.equal(report.files.length, 2);
  assert.equal(report.files[0].complexity, 3);
  assert.ok(report.files[0].duplicated >= 3);
  assert.equal(report.files[0].markers, 1);
  assert.ok(report.files[0].risk > 0);
  assert.ok(["Low", "Moderate", "High", "Critical"].includes(report.files[0].level));
});

test("technical debt returns an empty report for an empty project", () => {
  const report = analyzeDebt([]);
  assert.equal(report.files.length, 0);
  assert.equal(report.averageRisk, 0);
  assert.equal(report.hotspots.length, 0);
});
