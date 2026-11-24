import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = resolve(appDir, "../registry/index.json");
const androidRegistryPath = resolve(
  appDir,
  "src-tauri/gen/android/app/src/main/assets/registry/index.json"
);
const requiredCategories = [
  "themes",
  "programming-languages",
  "snippets",
  "productivity",
  "web-development",
  "security",
  "database-api",
  "ai-ml",
  "linux-sysadmin",
  "documentation",
  "design-creative",
  "talos-exclusive",
  "icon-packs",
];
const dependencyKinds = new Set(["executable", "system-tool", "service", "python-module"]);
const executableName = /^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,63}$/;
const pythonModuleName = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

async function loadRegistry(path = registryPath) {
  return JSON.parse(await readFile(path, "utf8"));
}

function requirementsOf(entry) {
  return new Map(
    (entry.externalExecutables ?? []).map((requirement) => [
      requirement.name,
      requirement.kind,
    ])
  );
}

test("the bundled local registry is the complete 145-extension catalogue", async () => {
  const registry = await loadRegistry();
  assert.equal(registry.schemaVersion, 1);
  assert.ok(Array.isArray(registry.extensions));
  assert.ok(Array.isArray(registry.apis));
  assert.equal(registry.extensions.length, 145);
  assert.equal(new Set(registry.extensions.map(({ id }) => id)).size, 145);

  for (const entry of registry.extensions) {
    assert.match(entry.id, /^[a-z0-9][a-z0-9._-]{0,63}$/);
    assert.ok(entry.name && entry.description);
    assert.ok(entry.publisher, `${entry.id} needs a publisher`);
    assert.ok(entry.category, `${entry.id} needs a category`);
    assert.equal(entry.compatibility, "Talos manifest v1");
    assert.equal(entry.version, "1.0.0");
    assert.equal(entry.license, "MIT");
    assert.equal(entry.free, true);
    assert.match(entry.updatedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Array.isArray(entry.features));
    assert.ok(Array.isArray(entry.dependencies));
    assert.ok(Array.isArray(entry.permissions));
    assert.ok(Array.isArray(entry.externalExecutables));
    assert.ok(!/^https?:\/\//i.test(entry.url), `${entry.id} must install from a bundled file`);
  }

  const categories = new Set(
    registry.extensions.flatMap((entry) => [entry.category, ...(entry.categories ?? [])])
  );
  for (const category of requiredCategories) {
    assert.ok(categories.has(category), `missing category: ${category}`);
  }
});

test("featured and curated popular entries use a genuine offline ranking", async () => {
  const registry = await loadRegistry();
  const featured = registry.extensions.filter((entry) => entry.featured === true);
  assert.ok(featured.length >= 15, "expected at least 15 curated featured entries");
  assert.ok(featured.length <= 20, "curated featured list should stay selective");
  const ranks = featured.map((entry) => entry.curatedRank);
  assert.ok(ranks.every((rank) => Number.isInteger(rank) && rank >= 1 && rank <= 100));
  assert.equal(new Set(ranks).size, ranks.length, "curated ranks must be unique");
  for (const entry of registry.extensions) {
    if (entry.featured !== true) {
      assert.equal(entry.curatedRank, undefined, `${entry.id} is not curated`);
    }
  }
});

test("every registry package exists locally and matches its declared checksum", async () => {
  const registry = await loadRegistry();
  for (const entry of registry.extensions) {
    assert.match(entry.sha256, /^[a-f0-9]{64}$/i);
    const packagePath = resolve(dirname(registryPath), entry.url);
    const packageText = await readFile(packagePath, "utf8");
    const checksum = createHash("sha256").update(packageText).digest("hex");
    assert.equal(checksum, entry.sha256, `${entry.id} checksum`);

    const manifest = JSON.parse(packageText);
    assert.equal(manifest.id, entry.id);
    assert.equal(manifest.version, entry.version);
    assert.equal(manifest.kind, entry.kind);
    assert.ok(manifest.description, `${entry.id} manifest needs a description`);

    if (entry.kind === "theme") {
      assert.ok(manifest.theme && typeof manifest.theme === "object");
      assert.ok(manifest.theme.ui && manifest.theme.editor && manifest.theme.syntax);
    } else if (entry.kind === "language") {
      assert.ok(manifest.language?.id && manifest.language?.name);
      assert.ok(manifest.language.extensions?.length > 0);
      assert.ok(manifest.language.run?.trim());
    } else if (entry.kind === "snippets") {
      assert.ok(Array.isArray(manifest.snippets));
      assert.ok(manifest.snippets.length >= 1 && manifest.snippets.length <= 200);
    } else if (entry.kind === "template") {
      assert.ok(Array.isArray(manifest.templates));
      assert.ok(manifest.templates.length >= 1 && manifest.templates.length <= 100);
    } else if (entry.kind === "icon-pack") {
      assert.ok(manifest.iconPack && typeof manifest.iconPack === "object");
      assert.ok(manifest.iconPack.mappings && typeof manifest.iconPack.mappings === "object");
      assert.ok(Object.keys(manifest.iconPack.mappings).length >= 10);
    }
  }
});

test("snippet packs are free, open source, and well formed", async () => {
  const registry = await loadRegistry();
  const packs = registry.extensions.filter((entry) => entry.kind === "snippets");
  assert.ok(packs.length >= 16, "expected the catalogue to expand snippet coverage");
  for (const entry of packs) {
    assert.equal(entry.license, "MIT");
    assert.equal(entry.free, true);
    const manifest = JSON.parse(
      await readFile(resolve(dirname(registryPath), entry.url), "utf8")
    );
    assert.equal(manifest.kind, "snippets");
    const prefixes = new Set();
    for (const snippet of manifest.snippets) {
      assert.ok(snippet.prefix && snippet.body);
      assert.equal(prefixes.has(snippet.prefix), false, `${entry.id} duplicate ${snippet.prefix}`);
      prefixes.add(snippet.prefix);
      assert.ok(Array.isArray(snippet.languages) && snippet.languages.length > 0);
    }
  }
});

test("external requirement metadata is valid and honest", async () => {
  const registry = await loadRegistry();
  const expected = new Map([
    ["lang-rust", ["rustc"]],
    ["lang-php", ["php"]],
    ["lang-bash", ["bash"]],
    ["lang-perl", ["perl"]],
    ["lang-ruby", ["ruby"]],
    ["lang-lua", ["lua"]],
    ["lang-go", ["go"]],
    ["lang-cpp", ["g++"]],
    ["lang-csharp", ["dotnet"]],
    ["lang-typescript", ["node", "tsx"]],
    ["lang-dart", ["dart"]],
    ["lang-elixir", ["elixir"]],
    ["lang-haskell", ["runghc"]],
    ["lang-kotlin", ["kotlinc"]],
    ["lang-scala", ["scala-cli"]],
    ["lang-clojure", ["clojure"]],
    ["lang-julia", ["julia"]],
    ["lang-r", ["Rscript"]],
    ["lang-make", ["make"]],
    ["lang-zsh", ["zsh"]],
    ["lang-fish", ["fish"]],
    ["ai-ollama-prompts-snippets", ["ollama"]],
    ["sec-tls-check-snippets", ["openssl", "curl"]],
  ]);

  for (const entry of registry.extensions) {
    for (const requirement of entry.externalExecutables ?? []) {
      assert.ok(dependencyKinds.has(requirement.kind), `${entry.id} has invalid requirement kind`);
      assert.ok(requirement.description, `${entry.id} requirement needs a description`);
      assert.equal(typeof requirement.required, "boolean");
      if (requirement.kind === "python-module") {
        assert.match(requirement.name, pythonModuleName);
      } else {
        assert.match(requirement.name, executableName);
      }
    }
  }

  for (const [id, names] of expected) {
    const entry = registry.extensions.find((candidate) => candidate.id === id);
    assert.ok(entry, `${id} is missing from the catalogue`);
    const actual = [...requirementsOf(entry).keys()];
    for (const name of names) {
      assert.ok(actual.includes(name), `${id} should declare ${name}`);
    }
  }
});

test("catalogue does not claim ratings, reviews, or extension-host compatibility", async () => {
  const registry = await loadRegistry();
  for (const entry of registry.extensions) {
    assert.equal("rating" in entry, false);
    assert.equal("reviews" in entry, false);
    assert.equal("vscodeCompatible" in entry, false);
    assert.equal("openVsxCompatible" in entry, false);
  }
});

test("the Android asset registry ships the same 145 extension IDs offline", async () => {
  const source = await loadRegistry();
  const android = await loadRegistry(androidRegistryPath);
  assert.equal(android.extensions.length, source.extensions.length);
  assert.deepEqual(
    android.extensions.map((entry) => entry.id).sort(),
    source.extensions.map((entry) => entry.id).sort()
  );
  for (const entry of android.extensions) {
    const packagePath = resolve(dirname(androidRegistryPath), entry.url);
    const packageText = await readFile(packagePath, "utf8");
    const checksum = createHash("sha256").update(packageText).digest("hex");
    assert.equal(checksum, entry.sha256, `${entry.id} Android checksum`);
  }
});
