import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function loadTsModule(relativePath) {
  const code = readFileSync(resolve(appDir, relativePath), "utf8");
  const compiled = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const moduleObject = { exports: {} };
  new Function("module", "exports", compiled)(moduleObject, moduleObject.exports);
  return moduleObject;
}

const canvasModule = loadTsModule("src/canvas/image-core.ts");
const pixelsModule = loadTsModule("src/canvas/image-pixels.ts");
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
  ASSET_PRESETS,
  EXPORT_PRESETS,
  arrowHeadPoints,
  constrainShape,
  constrainSquare,
  exportExtensionForMime,
  hexToRgb,
  isImagePath,
  isValidDocumentSize,
  lineEndpoints,
  measureBetween,
  normalizeColor,
  normalizeExportPath,
  regularPolygonPoints,
  rgbToHex,
  rgbToHsl,
  snapPoint,
  starPoints,
} = canvasModule.exports;

const {
  NEUTRAL_GRADING,
  applyFilter,
  applyGrading,
  exposureMultiplier,
  extractPalette,
  isNeutralGrading,
  normalizeGrading,
} = pixelsModule.exports;

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

test("downsampling preserves the aspect ratio of panoramas", () => {
  const fitted = fitWithin(20_000, 2_000);
  assert.ok(fitted.width * fitted.height <= DEFAULT_MAX_PIXELS);
  assert.ok(Math.abs(fitted.width / fitted.height - 10) < 0.02);
  assert.ok(fitted.width > 10_000, "a panorama must not be shrunk to a square");
  assert.deepEqual(fitWithin(4_000, 3_000), { width: 4_000, height: 3_000 });
});

test("document sizes are bounded before a resize allocates memory", () => {
  assert.equal(isValidDocumentSize({ width: 512, height: 512 }), true);
  assert.equal(isValidDocumentSize({ width: 20_001, height: 10 }), false);
  assert.equal(isValidDocumentSize({ width: 20_000, height: 20_000 }), false);
  assert.equal(isValidDocumentSize({ width: 1.5, height: 10 }), false);
});

test("annotation geometry is deterministic", () => {
  const measured = measureBetween({ x: 3, y: 7 }, { x: 6, y: 3 });
  assert.equal(measured.distance, 5);
  assert.equal(measured.dx, 3);
  assert.equal(measured.dy, -4);
  assert.ok(Math.abs(measured.angle - 53.13) < 0.01);
  assert.deepEqual(constrainShape({ x: 0, y: 0 }, { x: 10, y: 2 }), { x: 10, y: 0 });
  assert.deepEqual(constrainShape({ x: 0, y: 0 }, { x: 10, y: 8 }), { x: 10, y: 10 });
  assert.deepEqual(constrainSquare({ x: 0, y: 0 }, { x: 10, y: 2 }), { x: 10, y: 10 });
  assert.deepEqual(lineEndpoints({ x: 0, y: 0 }, { x: 10, y: 8 }), [{ x: 0, y: 0 }, { x: 10, y: 10 }]);
  assert.equal(regularPolygonPoints({ x: 0, y: 0 }, 10, 6).length, 6);
  assert.equal(starPoints({ x: 0, y: 0 }, 10, 5, 5).length, 10);
  assert.equal(arrowHeadPoints({ x: 10, y: 0 }, { x: 0, y: 0 }, 6).length, 2);
  assert.deepEqual(snapPoint({ x: 17, y: 19 }, 8, 100, 100), { x: 16, y: 16 });
});

test("colors round-trip through hex, RGB and HSL", () => {
  assert.equal(normalizeColor("not-a-color", "#59c7d4"), "#59c7d4");
  assert.equal(normalizeColor("#AABBCC"), "#aabbcc");
  assert.deepEqual(hexToRgb("#ff0000"), { r: 255, g: 0, b: 0 });
  assert.equal(rgbToHex(255, 0, 0), "#ff0000");
  const hsl = rgbToHsl(255, 0, 0);
  assert.equal(Math.round(hsl.h), 0);
  assert.equal(Math.round(hsl.s), 100);
  assert.equal(Math.round(hsl.l), 50);
});

test("export paths always match the encoded format", () => {
  assert.equal(exportExtensionForMime("image/jpeg"), "jpg");
  assert.equal(exportExtensionForMime("image/webp"), "webp");
  assert.equal(normalizeExportPath("photo.svg", "image/png"), "photo.png");
  assert.equal(normalizeExportPath("no-extension", "image/webp"), "no-extension.webp");
  assert.equal(isImagePath("/tmp/Photo.JPEG"), true);
  assert.equal(isImagePath("/tmp/notes.txt"), false);
  for (const preset of ASSET_PRESETS) assert.ok(isValidDocumentSize({ width: preset.width, height: preset.height }));
  for (const preset of EXPORT_PRESETS) {
    assert.ok(["image/png", "image/jpeg", "image/webp"].includes(preset.mime));
    if (preset.width) assert.ok(isValidDocumentSize({ width: preset.width, height: preset.height }));
  }
});

function solid(width, height, r, g, b) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    data[index * 4] = r;
    data[index * 4 + 1] = g;
    data[index * 4 + 2] = b;
    data[index * 4 + 3] = 255;
  }
  return { width, height, data };
}

test("exposure is symmetric photographic stops", () => {
  assert.equal(exposureMultiplier(0), 1);
  assert.equal(exposureMultiplier(-100), 0.25);
  assert.equal(exposureMultiplier(100), 4);
});

test("neutral grading is an identity transform", () => {
  const source = solid(2, 2, 30, 90, 180);
  assert.deepEqual(isNeutralGrading(NEUTRAL_GRADING), true);
  assert.deepEqual(isNeutralGrading({ brightness: 1 }), false);
  assert.deepEqual(applyGrading(source, NEUTRAL_GRADING).data, source.data);
  assert.deepEqual(applyGrading(source, null).data, source.data);
});

test("color grading changes tonal and color channels predictably", () => {
  const mid = solid(1, 1, 128, 128, 128);
  const brighter = applyGrading(mid, { exposure: 50 });
  assert.ok(brighter.data[0] > mid.data[0]);
  const darker = applyGrading(mid, { exposure: -50 });
  assert.ok(darker.data[0] < mid.data[0]);
  const warmer = applyGrading(mid, { temperature: 100 });
  assert.ok(warmer.data[0] > mid.data[0]);
  assert.ok(warmer.data[0] > warmer.data[2]);
  const cool = applyGrading(mid, { temperature: -100 });
  assert.ok(cool.data[2] > cool.data[0]);
  const grey = applyGrading(solid(1, 1, 200, 100, 40), { saturation: -100 });
  assert.equal(grey.data[0], grey.data[1]);
  assert.equal(grey.data[1], grey.data[2]);
  const gamma = applyGrading(mid, { gamma: 50 });
  assert.ok(gamma.data[0] > mid.data[0]);
  const shadows = applyGrading(solid(1, 1, 20, 20, 20), { shadows: 100 });
  const highlights = applyGrading(solid(1, 1, 20, 20, 20), { highlights: 100 });
  assert.ok(shadows.data[0] - 20 > highlights.data[0] - 20);
});

test("filters transform pixels without a DOM", () => {
  const source = solid(1, 1, 200, 100, 50);
  assert.deepEqual([...applyFilter(source, "invert").data.slice(0, 3)], [55, 155, 205]);
  const grey = applyFilter(source, "grayscale");
  assert.equal(grey.data[0], grey.data[1]);
  assert.equal(grey.data[1], grey.data[2]);
  const sepia = applyFilter(source, "sepia");
  assert.ok(sepia.data[0] > sepia.data[2]);
  const graded = applyGrading(source, { contrast: 40, vibrance: 30, hue: 30, tint: 20 });
  assert.ok([...graded.data.slice(0, 3)].every((value) => value >= 0 && value <= 255));
  assert.equal(normalizeGrading({ brightness: 500 }).brightness, 100);
  assert.equal(normalizeGrading({ hue: 180 }).hue, 180);
});

test("palette extraction is bounded and returns valid hex colors", () => {
  const image = solid(8, 8, 40, 90, 160);
  const palette = extractPalette(image, 6);
  assert.equal(palette.length, 1);
  assert.match(palette[0], /^#[0-9a-f]{6}$/);
  const many = solid(16, 16, 0, 0, 0);
  for (let index = 0; index < 16 * 16; index++) {
    if (index % 4 === 0) many.data[index * 4] = 255;
    if (index % 4 === 1) many.data[index * 4 + 1] = 255;
  }
  assert.ok(extractPalette(many, 12).length <= 12);
});

test("pixel results become real ImageData before canvas drawing", () => {
  for (const file of ["src/canvas/canvas-ui.ts", "src/canvas/image-worker.ts"]) {
    const code = readFileSync(resolve(appDir, file), "utf8");
    assert.match(code, /new ImageData\(/, file);
    assert.doesNotMatch(code, /putImageData\([^;]*\bas ImageData\b/, file);
  }
});

test("canvas center guides use a subtle grid-matched color", () => {
  const html = readFileSync(resolve(appDir, "index.html"), "utf8");
  const rule = html.split("\n").find((line) => line.includes('data-guides="true"]::after'));
  assert.ok(rule, "center guide overlay rule exists");
  assert.doesNotMatch(rule, /255\s*,\s*120\s*,\s*180/);
  assert.match(rule, /120\s*,\s*190\s*,\s*220/);
});

test("canvas async, export, and keyboard invariants are enforced", () => {
  const ui = readFileSync(resolve(appDir, "src/canvas/canvas-ui.ts"), "utf8");
  assert.match(ui, /!layers\.length \|\| exportBusy \|\| transformBusy/);
  assert.match(ui, /const run = \+\+transformRun;/);
  assert.match(ui, /if \(run === transformRun\) transformBusy = false;/);
  assert.match(ui, /transformRun \+= 1;/);
  assert.match(ui, /const sourceLayers = layers\.slice\(\);/);
  assert.match(ui, /target\.closest\("#canvas"\)/);
  assert.match(ui, /select\("canvas-export-format"\)\.value = mime;/);
  assert.match(ui, /previewBase = layers\.map\(/);
});

test("locked resizing syncs the other dimension and reports no-op sizes", () => {
  const ui = readFileSync(resolve(appDir, "src/canvas/canvas-ui.ts"), "utf8");
  assert.match(ui, /function syncLockedAspect\(changed: "width" \| "height"\)/);
  assert.match(ui, /input\("canvas-width"\)\.addEventListener\("input", \(\) => syncLockedAspect\("width"\)\)/);
  assert.match(ui, /input\("canvas-height"\)\.addEventListener\("input", \(\) => syncLockedAspect\("height"\)\)/);
  assert.match(ui, /Canvas already has these dimensions\./);
});

test("typed canvas text survives tool changes and click-away", () => {
  const ui = readFileSync(resolve(appDir, "src/canvas/canvas-ui.ts"), "utf8");
  const setTool = ui.slice(ui.indexOf("function setTool("), ui.indexOf("function drawSelection("));
  const pointerDown = ui.slice(ui.indexOf("if (tool === \"text\") {"), ui.indexOf("clearAdjustmentPreview();\n  dragTool"));
  assert.match(setTool, /commitText\(\);/);
  assert.doesNotMatch(setTool, /hideTextInput\(\);/);
  assert.match(pointerDown, /commitText\(\);\n    startText\(point\);/);
  assert.match(ui, /input\("canvas-text-input"\)\.addEventListener\("blur", \(\) => commitText\(\)\)/);
});
