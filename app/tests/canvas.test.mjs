import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(resolve(appDir, "src/canvas/image-core.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const canvasModule = { exports: {} };
new Function("module", "exports", compiled)(canvasModule, canvasModule.exports);
const {
  BoundedHistory,
  DEFAULT_MAX_PIXELS,
  adjustCropRect,
  brushBounds,
  clampRect,
  estimateRgbaBytes,
  fitWithin,
  historyOptionsForBytes,
  nextLayerName,
  normalizeOpacity,
  reorderLayers,
  resizeDimensions,
  rotateDimensions,
  unionRect,
} = canvasModule.exports;

test("crop rectangles stay inside the image and keep at least one pixel", () => {
  assert.deepEqual(clampRect({ x: -20, y: -20, width: 500, height: 500 }, 200, 100), {
    x: 0, y: 0, width: 200, height: 100,
  });
  assert.deepEqual(clampRect({ x: 190, y: 90, width: 50, height: 50 }, 200, 100), {
    x: 190, y: 90, width: 10, height: 10,
  });
  assert.deepEqual(clampRect({ x: 10, y: 10, width: 0, height: 0 }, 200, 100), {
    x: 10, y: 10, width: 1, height: 1,
  });
  assert.equal(clampRect({ x: 0, y: 0, width: 10, height: 10 }, 0, 0), null);
});

test("resize keeps aspect ratio unless explicitly disabled", () => {
  assert.deepEqual(resizeDimensions(400, 200, 200, 200), { width: 200, height: 100 });
  assert.deepEqual(resizeDimensions(400, 200, 200, 50), { width: 100, height: 50 });
  assert.deepEqual(resizeDimensions(400, 200, 300, 80, false), { width: 300, height: 80 });
  assert.deepEqual(resizeDimensions(0, 0, 10, 10), { width: 1, height: 1 });
});

test("large images are downsampled to the pixel budget", () => {
  assert.deepEqual(fitWithin(4000, 3000), { width: 4000, height: 3000 });
  assert.equal(DEFAULT_MAX_PIXELS, 24_000_000);
  const fitted = fitWithin(10_000, 10_000);
  assert.ok(fitted.width * fitted.height <= DEFAULT_MAX_PIXELS);
  assert.ok(fitted.width > 0 && fitted.height > 0);
});

test("quarter turns swap dimensions", () => {
  const size = { width: 320, height: 180 };
  assert.deepEqual(rotateDimensions(size, 90), { width: 180, height: 320 });
  assert.deepEqual(rotateDimensions(size, 180), { width: 320, height: 180 });
  assert.deepEqual(rotateDimensions(size, 270), { width: 180, height: 320 });
});

test("layers have bounded opacity, unique names and stable reordering", () => {
  const layers = [
    { id: "a", name: "Layer 1", visible: true, opacity: 0.5 },
    { id: "b", name: "Layer 2", visible: false, opacity: 2 },
  ];
  assert.equal(nextLayerName(layers), "Layer 3");
  assert.equal(normalizeOpacity(layers[1].opacity), 1);
  assert.equal(normalizeOpacity(Number.NaN), 1);
  assert.deepEqual(reorderLayers(layers, 0, 1).map((layer) => layer.id), ["b", "a"]);
  assert.deepEqual(reorderLayers(layers, 3, 0), layers);
  assert.equal(reorderLayers(layers, 0, 1)[0].name, "Layer 2");
});

test("bounded history drops redo branches and evicts old snapshots", () => {
  const dropped = [];
  const history = new BoundedHistory({ maxEntries: 3, maxBytes: 100, onDrop: (v) => dropped.push(v) });
  history.reset("base", "Open", 10);
  history.push("a", "a", 30);
  history.push("b", "b", 30);
  history.push("c", "c", 30);
  assert.deepEqual(dropped, ["base"]);
  assert.equal(history.canUndo, true);
  assert.equal(history.undo(), "b");
  assert.equal(history.canRedo, true);
  history.push("d", "d", 10);
  assert.equal(history.canRedo, false);
  assert.equal(history.undo(), "b");
  assert.deepEqual(dropped, ["base", "c"]);
  history.clear();
  assert.deepEqual(dropped, ["base", "c", "a", "b", "d"]);
});

test("history drops entries when the byte budget is exceeded", () => {
  const dropped = [];
  const history = new BoundedHistory({ maxEntries: 10, maxBytes: 50, onDrop: (v) => dropped.push(v) });
  history.reset("base", "Open", 10);
  history.push("large", "large", 40);
  history.push("next", "next", 20);
  assert.deepEqual(dropped, ["base", "large"]);
  assert.ok(history.bytes <= 50);
});

test("history keeps one usable undo even when snapshots exceed the byte budget", () => {
  const history = new BoundedHistory({ maxEntries: 2, maxBytes: 250 });
  history.reset("base", "Open", 120);
  history.push("edited", "edited", 120);
  assert.equal(history.canUndo, true);
  assert.equal(history.undo(), "base");
  assert.equal(history.canRedo, true);
});

test("brush bounds cover the stroke and clamp to the image", () => {
  assert.deepEqual(brushBounds({ x: 10, y: 10 }, { x: 20, y: 14 }, 2, 40, 30), {
    x: 8, y: 8, width: 14, height: 8,
  });
  assert.deepEqual(brushBounds({ x: -5, y: 15 }, { x: 4, y: 25 }, 3, 10, 20), {
    x: 0, y: 12, width: 7, height: 8,
  });
  assert.deepEqual(unionRect({ x: 2, y: 3, width: 4, height: 5 }, { x: 8, y: 1, width: 2, height: 3 }), {
    x: 2, y: 1, width: 8, height: 7,
  });
});

test("crop handles resize and move within image bounds", () => {
  const original = { x: 10, y: 10, width: 20, height: 20 };
  assert.deepEqual(adjustCropRect(original, "se", 5, 5, 100, 100), {
    x: 10, y: 10, width: 25, height: 25,
  });
  assert.deepEqual(adjustCropRect(original, "nw", -20, -20, 100, 100), {
    x: 0, y: 0, width: 30, height: 30,
  });
  assert.deepEqual(adjustCropRect(original, "move", -15, 80, 100, 100), {
    x: 0, y: 90, width: 15, height: 10,
  });
  assert.deepEqual(adjustCropRect(original, "w", 100, 0, 100, 100), {
    x: 29, y: 10, width: 1, height: 20,
  });
});

test("large documents receive a history budget that preserves undo", () => {
  const options = historyOptionsForBytes(estimateRgbaBytes(4000, 3000));
  assert.equal(options.maxEntries, 2);
  assert.ok(options.maxBytes >= options.maxEntries * estimateRgbaBytes(4000, 3000));
  const history = new BoundedHistory(options);
  history.reset("base", "Open", estimateRgbaBytes(4000, 3000));
  history.push("edited", "edited", estimateRgbaBytes(4000, 3000));
  assert.equal(history.canUndo, true);
});

test("RGBA byte estimates are bounded and non-negative", () => {
  assert.equal(estimateRgbaBytes(100, 100), 40_000);
  assert.equal(estimateRgbaBytes(-1, 100), 0);
  assert.equal(estimateRgbaBytes(Number.NaN, 100), 0);
});
