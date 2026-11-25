import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(appDir, "src/binary-view.ts");
const compiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const module = { exports: {} };
new Function("require", "module", "exports", compiled)(
  createRequire(sourcePath), module, module.exports
);
const {
  binaryLabel,
  binarySummary,
  extractPrintableStrings,
  formatHexDump,
  formatSize,
  formatStrings,
  HEX_PAGE_BYTES,
  nextPageEnabled,
} = module.exports;

test("binary files get an honest, type-specific label", () => {
  assert.equal(binaryLabel("arp_spoof.cpython-312.pyc"), "Python bytecode");
  assert.equal(binaryLabel("Main.class"), "Java bytecode");
  assert.equal(binaryLabel("libtalos.so"), "Executable or library");
  assert.equal(binaryLabel("notes.txt"), "Binary data");
  const summary = binarySummary("arp_spoof.cpython-312.pyc", 2048);
  assert.equal(summary.size, "2.0 KiB");
  assert.match(summary.hint, /Strings tab/);
});

test("formatSize handles byte and large values", () => {
  assert.equal(formatSize(12), "12 B");
  assert.equal(formatSize(1024), "1.0 KiB");
  assert.equal(formatSize(5 * 1024 * 1024), "5.0 MiB");
  assert.equal(formatSize(-1), "unknown size");
});

test("hex dump aligns offset, bytes, and ASCII", () => {
  const bytes = new Uint8Array([0x53, 0x6f, 0x75, 0x72, 0x63, 0x65, 0x00, 0xff]);
  const lines = formatHexDump(bytes, 0x10, 8);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], "00000010  53 6f 75 72 63 65 00 ff  |Source..|");
});

test("printable strings are bounded and keep absolute offsets", () => {
  const bytes = new Uint8Array([
    0x00, 0x53, 0x6f, 0x75, 0x72, 0x63, 0x65, 0x00,
    0x61, 0x62, 0x63, 0x00,
  ]);
  const strings = extractPrintableStrings(bytes, 0x40, 4, 10);
  assert.deepEqual(strings, [
    { offset: 0x41, text: "Source" },
  ]);
  assert.equal(formatStrings(strings)[0], "00000041  Source");
});

test("hex pages are bounded", () => {
  assert.equal(HEX_PAGE_BYTES, 4096);
  assert.equal(nextPageEnabled(0, 4096), false);
  assert.equal(nextPageEnabled(0, 8192), true);
  assert.equal(nextPageEnabled(4096, 8192), false);
  assert.equal(nextPageEnabled(4096, 8193), true);
  assert.equal(nextPageEnabled(8192, 8193), false);
});
