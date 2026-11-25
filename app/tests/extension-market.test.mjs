import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensions = readFileSync(resolve(appDir, "src/extensions.ts"), "utf8");
const architecture = readFileSync(resolve(appDir, "src/architecture.ts"), "utf8");
const rust = readFileSync(resolve(appDir, "src-tauri/src/lib.rs"), "utf8");

test("market installs validate manifest object, identity, and kind", () => {
  assert.match(extensions, /const parsedValue: unknown = JSON\.parse\(text\);/);
  assert.match(extensions, /if \(!isRecord\(parsedValue\)\) \{/);
  assert.match(extensions, /typeof parsed\.kind !== \"string\"/);
  assert.match(extensions, /if \(parsed\.kind !== e\.kind\) \{/);
  assert.match(extensions, /expectedKind: e\.kind,/);
  assert.match(rust, /expected_kind: Option<String>,/);
  assert.match(rust, /manifest kind '\{kind\}' does not match registry kind/);
});

test("permission prompts match the Rust manifest-only requirements", () => {
  assert.match(extensions, /const requiredPermissions = new Set\(\[\s*\.\.\.stringArray\(parsed\.permissions\),/);
  assert.doesNotMatch(extensions, /\.\.\.\(e\.permissions \?\? \[\]\)/);
  assert.match(rust, /fn extension_permission_requirements\(manifest: &serde_json::Value\)/);
});

test("disabling an extension preserves previously granted permissions", () => {
  assert.match(extensions, /const approved = new Set\(stringArray\(extension\.grantedPermissions\)\);/);
  assert.match(rust, /let previous_permissions = state/);
  assert.match(rust, /let effective_permissions = if enabled \{ permissions \} else \{ previous_permissions \};/);
});

test("icon-pack manifests are validated on the Rust side", () => {
  assert.match(rust, /\"icon-pack\" => \{/);
  assert.match(rust, /icon-pack extension needs an 'iconPack' object/);
  assert.match(rust, /icon pack needs a 'mappings' object/);
  assert.match(rust, /icon pack contains an invalid mapping/);
});

test("icon-pack default token reaches the Explorer renderer", () => {
  assert.match(extensions, /interface ActiveIconPack \{[\s\S]*?default: string;/);
  assert.match(extensions, /hooks\.setIconPack\(\{ id, default: fallback, mappings \}\)/);
  assert.match(architecture, /export interface ActiveIconPack \{[\s\S]*?default: string;/);
  assert.match(architecture, /\?\? pack\?\.default/);
  assert.doesNotMatch(architecture, /\?\? mappings\.default/);
});

test("preference cleanup is awaited so stale extension IDs do not survive", () => {
  assert.match(extensions, /async function applyThemeById\(id: string \| null\) \{/);
  assert.match(extensions, /async function applyIconPackById\(id: string \| null\) \{/);
  assert.match(extensions, /await saveSettings\(\);\n  render\(\);/);
  assert.match(extensions, /await saveSettings\(\)\.catch\(\(error: unknown\) => \{\s*console\.error\("could not clear stale/);
});
