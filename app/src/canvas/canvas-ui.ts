// Talos Canvas workspace. Loaded on demand; heavy image work goes to an
// OffscreenCanvas worker with a behaviour-identical main-thread fallback.
// Everything stays on the device; Canvas never makes a network request.

import { open } from "@tauri-apps/plugin-dialog";
import { fileNameFromPath, readBytes, writeBytes } from "../platform";
import { getWindowValue, setWindowValue } from "../window-state";
import {
  ASSET_PRESETS, BoundedHistory, DEFAULT_MAX_PIXELS, DEFAULT_PREVIEW_PIXELS, EXPORT_PRESETS,
  MAX_DOCUMENT_PIXELS, adjustCropRect, arrowHeadPoints, brushBounds, clampRect,
  constrainSquare, estimateRgbaBytes, exportExtensionForMime, fitWithin, hexToRgb, historyOptionsForBytes, isImagePath,
  isValidDocumentSize, lineEndpoints, measureBetween, nextLayerName, normalizeColor, normalizeExportPath,
  normalizeOpacity, regularPolygonPoints, reorderLayers, resizeDimensions, rgbToHex, rgbToHsl,
  snapPoint, starPoints, unionRect, type CropHandle, type Point, type Rect, type Size,
} from "./image-core";
import {
  applyFilter, applyGrading, BLUR_CSS, boxBlurPixels, extractPalette as extractPalettePixels,
  isNeutralGrading, NEUTRAL_GRADING, normalizeGrading, type FilterName, type Grading,
} from "./image-pixels";
import type { ImageRequest, WorkerResponse } from "./image-requests";

type Tool =
  | "select" | "crop" | "pan" | "zoom" | "brush" | "eraser" | "text"
  | "line" | "rect" | "ellipse" | "arrow" | "triangle" | "star" | "polygon"
  | "callout" | "highlight" | "measure" | "eyedropper";

const CANVAS_TOOLS: Tool[] = [
  "select", "crop", "brush", "eraser", "text", "line", "rect", "ellipse",
  "arrow", "triangle", "star", "polygon", "callout", "highlight", "measure", "eyedropper", "pan", "zoom",
];
const DEFAULT_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml",
};
const PREVIEW_DEBOUNCE_MS = 90;
const MAX_PREVIEW_CACHE = 6;

interface DecodedImage {
  bitmap: ImageBitmap;
  downsampled: boolean;
}

interface Layer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  canvas: HTMLCanvasElement;
}

interface Snapshot {
  width: number;
  height: number;
  activeIndex: number;
  layers: Layer[];
}

type WorkerResult = ImageBitmap | Uint8Array | DecodedImage | string[];

const $ = (id: string) => document.getElementById(id)!;
const input = (id: string) => $(id) as HTMLInputElement;
const select = (id: string) => $(id) as HTMLSelectElement;

let width = 0;
let height = 0;
let layers: Layer[] = [];
let activeIndex = 0;
let sourcePath: string | null = null;
let svgSource: string | null = null;
let zoom = 1;
let tool: Tool = "select";
let dragTool: Tool | null = null;
let color = "#59c7d4";
let fillColor = "#59c7d4";
let brushSize = 8;
let brushOpacity = 100;
let fontSize = 20;
let shapeFilled = false;
let shapeSides = 6;
let selection: Rect | null = null;
let dragStart: Point | null = null;
let dragCurrent: Point | null = null;
let cropDrag: { mode: CropHandle; start: Point; original: Rect; pointerId: number } | null = null;
let panStart: { scrollLeft: number; scrollTop: number; x: number; y: number } | null = null;
let drawing = false;
let pendingHistoryLabel: string | null = null;
let calloutNumber = 1;
let measurement: { from: Point; to: Point } | null = null;
let compositing = false;
let pendingDirty: Rect | null = null;
let nextLayerId = 1;
let worker: Worker | null = null;
let history: BoundedHistory<Snapshot> | null = null;
let initialized = false;
let documentVersion = 0;
let transformToken = 0;
let previewToken = 0;
let previewTimer: number | null = null;
let previewBase: Layer[] | null = null;
let previewBaseVersion = -1;
let openToken = 0;
let compareBaseline: HTMLCanvasElement | null = null;
let compareEnabled = false;
let compareSplit = 50;
let compareDragging = false;
let comparePointerId: number | null = null;
let gridVisible = false;
let gridSpacing = 32;
let snapEnabled = false;
let guidesVisible = false;
let transparencyMode = "checker";
let exportBusy = false;
let transformBusy = false;
let exportBasePath = "";
let exportPathEdited = false;
let requestId = 1;

const previewCache = new Map<string, ImageBitmap>();
const pending = new Map<number, { resolve: (value: WorkerResult) => void; reject: (error: Error) => void }>();

function status(text: string): void {
  $("canvas-message").textContent = text;
}

function surface(): HTMLCanvasElement {
  return $("canvas-surface") as HTMLCanvasElement;
}

function preview(): HTMLCanvasElement {
  return $("canvas-preview") as HTMLCanvasElement;
}

function adjustmentOverlay(): HTMLCanvasElement {
  return $("canvas-adjust-preview") as HTMLCanvasElement;
}

function stage(): HTMLElement {
  return $("canvas-stage") as HTMLElement;
}

function activeLayer(): Layer | null {
  return layers[activeIndex] ?? null;
}

function createLayerCanvas(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(w));
  canvas.height = Math.max(1, Math.floor(h));
  return canvas;
}

function cloneCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const copy = createLayerCanvas(source.width, source.height);
  copy.getContext("2d")?.drawImage(source, 0, 0);
  return copy;
}

function releaseSnapshot(snapshot: Snapshot): void {
  for (const layer of snapshot.layers) {
    layer.canvas.width = 0;
    layer.canvas.height = 0;
  }
}

function snapshotBytes(snapshot: Snapshot): number {
  return snapshot.layers.reduce((sum, layer) => sum + estimateRgbaBytes(layer.canvas.width, layer.canvas.height), 0);
}

function capture(): Snapshot {
  return {
    width,
    height,
    activeIndex,
    layers: layers.map((layer) => ({
      id: layer.id, name: layer.name, visible: layer.visible, opacity: layer.opacity, canvas: cloneCanvas(layer.canvas),
    })),
  };
}

function restore(snapshot: Snapshot): void {
  const dimensionsChanged = snapshot.width !== width || snapshot.height !== height;
  width = snapshot.width;
  height = snapshot.height;
  layers = snapshot.layers.map((layer) => ({ ...layer, canvas: cloneCanvas(layer.canvas) }));
  activeIndex = Math.max(0, Math.min(snapshot.activeIndex, layers.length - 1));
  // Selection coordinates are document pixels, so they cannot survive a resize.
  if (dimensionsChanged) {
    selection = null;
    measurement = null;
  }
  resizeSurface();
  renderAll();
}

function createHistory(initial: Snapshot): BoundedHistory<Snapshot> {
  const options = historyOptionsForBytes(snapshotBytes(initial));
  const next = new BoundedHistory<Snapshot>({ ...options, onDrop: releaseSnapshot });
  next.reset(initial, "Open", snapshotBytes(initial));
  return next;
}

function pushHistory(label: string): void {
  if (!history) return;
  const snapshot = capture();
  history.push(label, snapshot, snapshotBytes(snapshot));
  updateHistoryButtons();
}

function updateHistoryButtons(): void {
  ($("canvas-undo") as HTMLButtonElement).disabled = !history?.canUndo;
  ($("canvas-redo") as HTMLButtonElement).disabled = !history?.canRedo;
}

function clearAdjustmentPreview(): void {
  if (previewTimer !== null) {
    window.clearTimeout(previewTimer);
    previewTimer = null;
  }
  previewToken += 1;
  const overlay = document.getElementById("canvas-adjust-preview") as HTMLCanvasElement | null;
  if (overlay) {
    overlay.style.display = "none";
    overlay.getContext("2d")?.clearRect(0, 0, overlay.width, overlay.height);
    overlay.width = 1;
    overlay.height = 1;
  }
  for (const bitmap of previewCache.values()) bitmap.close();
  previewCache.clear();
  previewBase = null;
  previewBaseVersion = -1;
}

function invalidateDocument(): void {
  documentVersion += 1;
  transformToken += 1;
  previewBaseVersion = -1;
  clearAdjustmentPreview();
}

function resizeSurface(): void {
  const canvas = surface();
  const overlay = preview();
  if (canvas.width !== width) canvas.width = Math.max(1, width);
  if (canvas.height !== height) canvas.height = Math.max(1, height);
  if (overlay.width !== width) overlay.width = Math.max(1, width);
  if (overlay.height !== height) overlay.height = Math.max(1, height);
  applyZoom();
}

function scaleX(): number {
  // Use the actual rendered size for pointer mapping AND overlays so rounded
  // stage dimensions can never introduce drift between the two.
  return stage().clientWidth / Math.max(1, width);
}

function scaleY(): number {
  return stage().clientHeight / Math.max(1, height);
}

function applyZoom(): void {
  stage().style.width = `${Math.max(1, Math.round(width * zoom))}px`;
  stage().style.height = `${Math.max(1, Math.round(height * zoom))}px`;
  $("canvas-zoom").textContent = `${Math.round(zoom * 100)}%`;
  applyGrid();
  drawSelection();
  drawMeasurement();
  renderCompare();
}

function setZoom(next: number, anchor?: Point): void {
  const target = Math.max(0.05, Math.min(4, next));
  if (!Number.isFinite(target) || target === zoom) return;
  const before = stage().getBoundingClientRect();
  const imageX = anchor ? Math.max(0, Math.min(width, (anchor.x - before.left) / scaleX())) : null;
  const imageY = anchor ? Math.max(0, Math.min(height, (anchor.y - before.top) / scaleY())) : null;
  zoom = target;
  applyZoom();
  if (anchor && imageX !== null && imageY !== null) {
    const viewport = $("canvas-viewport");
    const after = stage().getBoundingClientRect();
    const factorX = stage().clientWidth / Math.max(1, width);
    const factorY = stage().clientHeight / Math.max(1, height);
    viewport.scrollLeft += after.left + imageX * factorX - anchor.x;
    viewport.scrollTop += after.top + imageY * factorY - anchor.y;
  }
}

function fitZoom(): void {
  if (!width || !height) return;
  const viewport = $("canvas-viewport");
  // The viewport has 32px padding on every side.
  const availableWidth = Math.max(120, viewport.clientWidth - 64);
  const availableHeight = Math.max(120, viewport.clientHeight - 64);
  zoom = Math.max(0.05, Math.min(4, Math.min(availableWidth / width, availableHeight / height)));
  applyZoom();
  viewport.scrollLeft = 0;
  viewport.scrollTop = 0;
}

function composite(region?: Rect): void {
  const ctx = surface().getContext("2d");
  if (!ctx) return;
  ctx.save();
  const dirty = region ? clampRect(region, width, height) : null;
  if (dirty) ctx.clearRect(dirty.x, dirty.y, dirty.width, dirty.height);
  else ctx.clearRect(0, 0, width, height);
  for (const layer of layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    ctx.globalAlpha = normalizeOpacity(layer.opacity);
    if (dirty) {
      ctx.drawImage(layer.canvas, dirty.x, dirty.y, dirty.width, dirty.height, dirty.x, dirty.y, dirty.width, dirty.height);
    } else {
      ctx.drawImage(layer.canvas, 0, 0);
    }
  }
  ctx.restore();
}

function scheduleComposite(region?: Rect): void {
  pendingDirty = region ? unionRect(pendingDirty, clampRect(region, width, height)) : null;
  if (compositing) return;
  compositing = true;
  requestAnimationFrame(() => {
    compositing = false;
    const dirty = pendingDirty;
    pendingDirty = null;
    composite(dirty ?? undefined);
  });
}

function renderLayers(): void {
  const list = $("canvas-layers");
  list.replaceChildren();
  // Arrays are bottom-to-top for compositing; the list shows top-to-bottom.
  for (let index = layers.length - 1; index >= 0; index--) {
    const layer = layers[index];
    const row = document.createElement("div");
    row.className = "canvas-layer" + (index === activeIndex ? " active" : "");
    row.setAttribute("role", "listitem");

    const eye = document.createElement("button");
    eye.type = "button";
    eye.className = "mini canvas-layer-eye";
    eye.textContent = layer.visible ? "◉" : "○";
    eye.title = layer.visible ? "Hide layer" : "Show layer";
    eye.setAttribute("aria-label", eye.title);
    eye.addEventListener("click", () => {
      layer.visible = !layer.visible;
      invalidateDocument();
      pushHistory("Toggle layer visibility");
      renderLayers();
      composite();
    });

    const name = document.createElement("span");
    name.className = "canvas-layer-name";
    name.textContent = layer.name;
    name.dataset.hidden = String(!layer.visible);
    name.title = index === 0 ? "Background · double-click to rename" : "Double-click to rename";
    name.addEventListener("dblclick", () => {
      const next = window.prompt("Layer name", layer.name)?.trim();
      if (!next || next === layer.name) return;
      layer.name = next;
      invalidateDocument();
      pushHistory("Rename layer");
      renderLayers();
    });

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.value = String(Math.round(layer.opacity * 100));
    slider.title = "Layer opacity";
    slider.setAttribute("aria-label", `${layer.name} opacity`);
    slider.addEventListener("input", () => {
      layer.opacity = Number(slider.value) / 100;
      clearAdjustmentPreview();
      previewBaseVersion = -1;
      if (compareEnabled) renderCompare();
      scheduleComposite();
    });
    slider.addEventListener("change", () => {
      layer.opacity = Number(slider.value) / 100;
      invalidateDocument();
      pushHistory("Layer opacity");
      renderLayers();
      composite();
    });

    row.append(eye, name, slider);
    row.addEventListener("click", (event) => {
      if (event.target === slider || event.target === eye) return;
      activeIndex = index;
      renderLayers();
      status(`${layer.name} selected.`);
    });
    list.appendChild(row);
  }
  const count = `${layers.length} layer${layers.length === 1 ? "" : "s"}`;
  $("canvas-layer-count").textContent = count;
  $("canvas-layer-count-panel").textContent = count;
}

function renderAll(): void {
  invalidateDocument();
  composite();
  renderLayers();
  updateChrome();
  updateHistoryButtons();
}

function updateColorInspector(): void {
  const rgb = hexToRgb(color);
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  input("canvas-hex").value = color.toUpperCase();
  $("canvas-rgb").textContent = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
  $("canvas-hsl").textContent = `hsl(${Math.round(hsl.h)}°, ${Math.round(hsl.s)}°, ${Math.round(hsl.l)}%)`;
  input("canvas-color").value = color;
  input("canvas-fill-color").value = fillColor;
}

function updateChrome(): void {
  $("canvas-dimensions").textContent = `${width} × ${height}`;
  input("canvas-width").value = String(width);
  input("canvas-height").value = String(height);
  const bytes = layers.reduce((sum, layer) => sum + estimateRgbaBytes(layer.canvas.width, layer.canvas.height), 0);
  $("canvas-memory").textContent = `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  const name = sourcePath ? fileNameFromPath(sourcePath) : "Untitled canvas";
  $("canvas-file").textContent = name;
  $("canvas-status-file").textContent = name;
  updateColorInspector();
  const svgSection = $("canvas-svg-section");
  svgSection.classList.toggle("hidden", !svgSource);
  if (svgSource && input("canvas-svg-source").value !== svgSource) input("canvas-svg-source").value = svgSource;
  input("canvas-svg-raster-width").value = String(width);
  input("canvas-svg-raster-height").value = String(height);
}

function ensureWorker(): Worker | null {
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") return null;
  if (worker) return worker;
  const next = new Worker(new URL("./image-worker.ts", import.meta.url), { type: "module" });
  next.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const entry = pending.get(response.id);
    if (!entry) {
      response.bitmap?.close();
      return;
    }
    pending.delete(response.id);
    if (response.error) {
      entry.reject(new Error(response.error));
    } else if (typeof response.downsampled === "boolean") {
      if (!response.bitmap) entry.reject(new Error("The image worker returned no bitmap."));
      else entry.resolve({ bitmap: response.bitmap, downsampled: response.downsampled });
    } else if (response.bitmap) {
      entry.resolve(response.bitmap);
    } else if (response.bytes) {
      entry.resolve(response.bytes);
    } else if (response.colors) {
      entry.resolve(response.colors);
    } else {
      entry.reject(new Error("The image worker returned no result."));
    }
  });
  next.addEventListener("error", (event) => {
    // A crashed worker must be replaced; leaving it installed hangs every
    // later request.
    const message = event.message || "The image worker stopped unexpectedly.";
    for (const entry of pending.values()) entry.reject(new Error(message));
    pending.clear();
    next.terminate();
    if (worker === next) worker = null;
    status(`${message} Falling back to local image processing.`);
  });
  worker = next;
  return next;
}

function closeRequestBitmaps(request: ImageRequest): void {
  if ("bitmap" in request) {
    try { request.bitmap.close(); } catch { /* already detached */ }
  }
  if ("layers" in request) {
    for (const layer of request.layers) {
      try { layer.bitmap.close(); } catch { /* already detached */ }
    }
  }
}

function transferablesFor(request: ImageRequest): Transferable[] {
  const transfer: Transferable[] = [];
  if ("bitmap" in request) transfer.push(request.bitmap);
  if ("layers" in request) {
    for (const layer of request.layers) transfer.push(layer.bitmap);
  }
  if (request.type === "decode") transfer.push(request.bytes.buffer as ArrayBuffer);
  return transfer;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser could not create a 2D canvas context.");
  return ctx;
}

function fallbackBitmap(request: ImageRequest): Promise<ImageBitmap> {
  if ("layers" in request) {
    const flat = createLayerCanvas(request.width, request.height);
    const ctx = context2d(flat);
    for (const layer of request.layers) {
      if (!layer.visible) continue;
      ctx.globalAlpha = normalizeOpacity(layer.opacity);
      ctx.drawImage(layer.bitmap, 0, 0, request.width, request.height);
    }
    ctx.globalAlpha = 1;
    return createImageBitmap(flat);
  }
  if (!("bitmap" in request)) return Promise.reject(new Error(`Unsupported image operation: ${request.type}`));
  const bitmap = request.bitmap;
  const size: Size = request.type === "resize"
    ? { width: request.width, height: request.height }
    : request.type === "crop"
      ? { width: request.rect.width, height: request.rect.height }
      : request.type === "rotate" && request.angle !== 180
        ? { width: bitmap.height, height: bitmap.width }
        : { width: bitmap.width, height: bitmap.height };
  if (!isValidDocumentSize(size, Number.MAX_SAFE_INTEGER)) throw new Error("Invalid image dimensions.");
  const canvas = createLayerCanvas(size.width, size.height);
  const ctx = context2d(canvas);
  switch (request.type) {
    case "resize":
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0, size.width, size.height);
      break;
    case "crop":
      ctx.drawImage(bitmap, request.rect.x, request.rect.y, size.width, size.height, 0, 0, size.width, size.height);
      break;
    case "rotate":
      ctx.translate(size.width / 2, size.height / 2);
      ctx.rotate((request.angle * Math.PI) / 180);
      ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
      break;
    case "flip":
      if (request.axis === "horizontal") {
        ctx.translate(size.width, 0);
        ctx.scale(-1, 1);
      } else {
        ctx.translate(0, size.height);
        ctx.scale(1, -1);
      }
      ctx.drawImage(bitmap, 0, 0);
      break;
    case "adjust": {
      ctx.drawImage(bitmap, 0, 0);
      const graded = applyGrading(ctx.getImageData(0, 0, size.width, size.height), request.grading);
      ctx.putImageData(new ImageData(graded.data, graded.width, graded.height), 0, 0);
      break;
    }
    case "filter": {
      if (request.filter === "blur") {
        const supportsFilter = "filter" in (ctx as object);
        if (supportsFilter) {
          ctx.filter = BLUR_CSS;
          ctx.drawImage(bitmap, 0, 0);
          ctx.filter = "none";
        } else {
          ctx.drawImage(bitmap, 0, 0);
          const blurred = boxBlurPixels(ctx.getImageData(0, 0, size.width, size.height));
          ctx.putImageData(new ImageData(blurred.data, blurred.width, blurred.height), 0, 0);
        }
      } else {
        ctx.drawImage(bitmap, 0, 0);
        const filtered = applyFilter(ctx.getImageData(0, 0, size.width, size.height), request.filter);
        ctx.putImageData(new ImageData(filtered.data, filtered.width, filtered.height), 0, 0);
      }
      break;
    }
    case "palette":
      break;
    default:
      throw new Error("Unsupported image operation.");
  }
  return createImageBitmap(canvas);
}

async function decodeFallback(bytes: Uint8Array, mime: string, maxPixels: number): Promise<DecodedImage> {
  if (typeof createImageBitmap !== "function") {
    throw new Error("This browser cannot decode images for Canvas.");
  }
  const blob = new Blob([bytes as BlobPart], { type: mime || "image/png" });
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    // SVG needs an <img> element in browsers without worker SVG decoding.
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      bitmap = await createImageBitmap(image);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  if (!(bitmap.width > 0) || !(bitmap.height > 0) || bitmap.width * bitmap.height > Number.MAX_SAFE_INTEGER / 4) {
    bitmap.close();
    throw new Error("The image has invalid dimensions.");
  }
  const fitted = fitWithin(bitmap.width, bitmap.height, maxPixels);
  if (fitted.width === bitmap.width && fitted.height === bitmap.height) {
    return { bitmap, downsampled: false };
  }
  try {
    const resized = await createImageBitmap(bitmap, {
      resizeWidth: fitted.width,
      resizeHeight: fitted.height,
      resizeQuality: "high",
    });
    return { bitmap: resized, downsampled: true };
  } finally {
    bitmap.close();
  }
}

async function encodeFallback(bitmap: ImageBitmap, mime: string, quality: number, background: string | null): Promise<Uint8Array> {
  const canvas = createLayerCanvas(bitmap.width, bitmap.height);
  try {
    const ctx = context2d(canvas);
    if (mime === "image/jpeg") {
      const matte = background && /^#[0-9a-f]{6}$/i.test(background) ? background : "#ffffff";
      ctx.fillStyle = matte;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob>((resolveBlob, rejectBlob) => {
      canvas.toBlob(
        (result) => result ? resolveBlob(result) : rejectBlob(new Error("Could not encode the image.")),
        mime,
        quality,
      );
    });
    if (blob.type !== mime) {
      throw new Error(`${mime} export is not supported by this browser. Choose PNG instead.`);
    }
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

async function runFallback(request: ImageRequest): Promise<WorkerResult> {
  if (request.type === "decode") return decodeFallback(request.bytes, request.mime, request.maxPixels);
  if (request.type === "encode") return encodeFallback(request.bitmap, request.mime, request.quality, request.background);
  try {
    if (request.type === "palette") {
      const fitted = fitWithin(request.bitmap.width, request.bitmap.height, DEFAULT_PREVIEW_PIXELS);
      const canvas = createLayerCanvas(fitted.width, fitted.height);
      const ctx = context2d(canvas);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(request.bitmap, 0, 0, fitted.width, fitted.height);
      // The worker imports the same function; results cannot drift.
      return extractPalettePixels(ctx.getImageData(0, 0, fitted.width, fitted.height), request.count);
    }
    return await fallbackBitmap(request);
  } finally {
    closeRequestBitmaps(request);
  }
}

async function requestResult<T extends WorkerResult>(request: ImageRequest): Promise<T> {
  const activeWorker = ensureWorker();
  const id = ++requestId;
  const message = { ...request, id };
  if (!activeWorker) return await runFallback(request) as T;
  return new Promise<T>((resolvePromise, rejectPromise) => {
    pending.set(id, {
      resolve: (value) => resolvePromise(value as T),
      reject: rejectPromise,
    });
    try {
      activeWorker.postMessage(message, transferablesFor(request));
    } catch (error) {
      pending.delete(id);
      closeRequestBitmaps(request);
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function requestBitmap(request: ImageRequest): Promise<ImageBitmap> {
  return requestResult<ImageBitmap>(request);
}

function requestDecode(request: ImageRequest): Promise<DecodedImage> {
  return requestResult<DecodedImage>(request);
}

function requestPalette(request: ImageRequest): Promise<string[]> {
  return requestResult<string[]>(request);
}

async function requestEncode(bitmap: ImageBitmap, mime: string, quality: number, background: string | null): Promise<Uint8Array> {
  try {
    return await requestResult<Uint8Array>({ type: "encode", bitmap, mime, quality, background });
  } catch (error) {
    try { bitmap.close(); } catch { /* already detached */ }
    throw error;
  }
}

async function transformDocument(build: (bitmap: ImageBitmap) => ImageRequest): Promise<boolean> {
  if (!layers.length || exportBusy || transformBusy) return false;
  const token = ++transformToken;
  transformBusy = true;
  clearAdjustmentPreview();
  status("Processing…");
  try {
    const jobs = layers.map(async (layer) => {
      const bitmap = await createImageBitmap(layer.canvas);
      try {
        const result = await requestBitmap(build(bitmap));
        if (token !== transformToken) {
          result.close();
          throw new Error("Canvas changed during processing.");
        }
        const canvas = createLayerCanvas(result.width, result.height);
        context2d(canvas).drawImage(result, 0, 0);
        result.close();
        return { ...layer, canvas };
      } catch (error) {
        try { bitmap.close(); } catch { /* already transferred */ }
        throw error;
      }
    });
    const nextLayers = await Promise.all(jobs);
    if (token !== transformToken) return false;
    width = nextLayers[0].canvas.width;
    height = nextLayers[0].canvas.height;
    layers = nextLayers;
    // Pixel coordinates no longer describe the same area after a transform.
    selection = null;
    measurement = null;
    resizeSurface();
    renderAll();
    status("Done.");
    return true;
  } catch (error) {
    if (token === transformToken) status(error instanceof Error ? error.message : String(error));
    return false;
  } finally {
    if (token === transformToken) transformBusy = false;
  }
}

async function transformWithHistory(label: string, build: (bitmap: ImageBitmap) => ImageRequest): Promise<boolean> {
  if (!(await transformDocument(build))) return false;
  pushHistory(label);
  return true;
}

async function flatten(): Promise<ImageBitmap | null> {
  if (!layers.length) return null;
  // Capture document state before awaiting so a concurrent edit can never mix
  // old layer bitmaps with new dimensions (or vice versa).
  const sourceLayers = layers.slice();
  const documentWidth = width;
  const documentHeight = height;
  const bitmaps: ImageBitmap[] = [];
  try {
    for (const layer of sourceLayers) bitmaps.push(await createImageBitmap(layer.canvas));
    return await requestBitmap({
      type: "flatten",
      layers: bitmaps.map((bitmap, index) => ({
        bitmap, opacity: sourceLayers[index].opacity, visible: sourceLayers[index].visible,
      })),
      width: documentWidth,
      height: documentHeight,
    });
  } catch (error) {
    for (const bitmap of bitmaps) {
      try { bitmap.close(); } catch { /* already transferred */ }
    }
    throw error;
  }
}

async function decodeImage(bytes: Uint8Array, mime: string, maxPixels = DEFAULT_MAX_PIXELS): Promise<DecodedImage> {
  if (mime !== "image/svg+xml" && typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined") {
    const copy = new Uint8Array(bytes);
    try {
      return await requestDecode({ type: "decode", bytes: copy, mime, maxPixels });
    } catch {
      // Fall back to the main thread for formats the worker cannot decode.
    }
  }
  return decodeFallback(bytes, mime, maxPixels);
}

async function decodeSvgSource(text: string, rasterWidth: number, rasterHeight: number): Promise<DecodedImage> {
  if (!isValidDocumentSize({ width: rasterWidth, height: rasterHeight })) {
    throw new Error("Choose an SVG raster size between 1 and 20000 pixels per side.");
  }
  const blob = new Blob([text], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const source = await createImageBitmap(image);
    const canvas = createLayerCanvas(rasterWidth, rasterHeight);
    const ctx = context2d(canvas);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, rasterWidth, rasterHeight);
    source.close();
    return { bitmap: await createImageBitmap(canvas), downsampled: false };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function resetDocument(path: string | null, bitmap: ImageBitmap, message: string, sourceText: string | null = null): void {
  width = bitmap.width;
  height = bitmap.height;
  const canvas = createLayerCanvas(width, height);
  context2d(canvas).drawImage(bitmap, 0, 0);
  layers = [{ id: String(nextLayerId++), name: "Background", visible: true, opacity: 1, canvas }];
  activeIndex = 0;
  sourcePath = path;
  svgSource = sourceText;
  clearTransientState();
  history = createHistory(capture());
  resizeSurface();
  fitZoom();
  renderAll();
  status(message);
}

async function openImage(path: string, options: { fullResolution?: boolean } = {}): Promise<void> {
  const token = ++openToken;
  showCanvas();
  status("Opening image…");
  const bytes = await readBytes(path);
  const name = fileNameFromPath(path).toLowerCase();
  const extension = name.split(".").pop() ?? "png";
  const mime = DEFAULT_MIME[extension] ?? "image/png";
  const maxPixels = options.fullResolution ? MAX_DOCUMENT_PIXELS : DEFAULT_MAX_PIXELS;
  let decoded: DecodedImage;
  const svgText = mime === "image/svg+xml" ? new TextDecoder().decode(bytes) : null;
  if (svgText) {
    const raster = fitWithin(2048, 2048, maxPixels);
    decoded = await decodeSvgSource(svgText, raster.width, raster.height);
  } else {
    decoded = await decodeImage(bytes, mime, maxPixels);
  }
  if (token !== openToken) {
    decoded.bitmap.close();
    return;
  }
  const notice = decoded.downsampled
    ? " Large image opened at reduced resolution; use Open full size for the original."
    : "";
  resetDocument(path, decoded.bitmap, `Opened ${fileNameFromPath(path)}.${notice}`, svgText);
  decoded.bitmap.close();
  $("canvas-full-res").classList.toggle("hidden", !decoded.downsampled);
}

function showCanvas(): void {
  $("canvas").classList.remove("hidden");
}

function hideTextInput(): void {
  const textInput = input("canvas-text-input");
  textInput.style.display = "none";
  textInput.value = "";
}

function clearTransientState(): void {
  hideTextInput();
  clearAdjustmentPreview();
  selection = null;
  dragStart = null;
  dragCurrent = null;
  dragTool = null;
  cropDrag = null;
  panStart = null;
  drawing = false;
  pendingHistoryLabel = null;
  measurement = null;
  calloutNumber = 1;
  compareBaseline = null;
  compareEnabled = false;
  compareDragging = false;
  comparePointerId = null;
  exportBusy = false;
  exportBasePath = "";
  exportPathEdited = false;
}

function closeCanvas(): void {
  openToken += 1;
  // Invalidate in-flight fallback transforms; a worker transform is rejected by
  // the pending-map cleanup below, but fallback promises are not in that map.
  transformToken += 1;
  transformBusy = false;
  $("canvas").classList.add("hidden");
  clearTransientState();
  for (const layer of layers) {
    layer.canvas.width = 0;
    layer.canvas.height = 0;
  }
  layers = [];
  width = height = 0;
  sourcePath = null;
  svgSource = null;
  history?.clear();
  history = null;
  if (worker) {
    worker.terminate();
    worker = null;
  }
  for (const entry of pending.values()) entry.reject(new Error("Canvas was closed."));
  pending.clear();
  setWindowValue("talos.canvas.zoom", String(zoom));
  document.dispatchEvent(new Event("talos:canvas-close"));
}

function canvasPoint(event: PointerEvent): Point {
  const rect = surface().getBoundingClientRect();
  const point = {
    x: ((event.clientX - rect.left) / Math.max(1, rect.width)) * width,
    y: ((event.clientY - rect.top) / Math.max(1, rect.height)) * height,
  };
  const bounded = {
    x: Math.max(0, Math.min(width, point.x)),
    y: Math.max(0, Math.min(height, point.y)),
  };
  return snapEnabled ? snapPoint(bounded, gridSpacing, width, height) : bounded;
}

function setTool(next: Tool): void {
  if (!CANVAS_TOOLS.includes(next)) return;
  if (drawing || cropDrag || (dragStart && (dragTool === "line" || dragTool === "rect" || dragTool === "ellipse"))) return;
  hideTextInput();
  tool = next;
  setWindowValue("talos.canvas.tool", next);
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-canvas-tool]")) {
    const active = button.dataset.canvasTool === tool;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  drawSelection();
  status(tool === "crop"
    ? "Crop tool selected. Drag a region, adjust its handles, then press Enter."
    : tool === "measure"
      ? "Measurement tool selected. Drag to measure distance in pixels."
      : `${tool[0].toUpperCase()}${tool.slice(1)} tool selected.`);
}

function drawSelection(): void {
  const box = $("canvas-selection") as HTMLElement;
  if (!selection) {
    box.style.display = "none";
    return;
  }
  box.style.display = "block";
  box.dataset.interactive = tool === "crop" || tool === "select" ? "true" : "false";
  box.style.left = `${selection.x * scaleX()}px`;
  box.style.top = `${selection.y * scaleY()}px`;
  box.style.width = `${selection.width * scaleX()}px`;
  box.style.height = `${selection.height * scaleY()}px`;
}

function updateSelectionRect(): void {
  if (!dragStart || !dragCurrent) return;
  const from = dragStart;
  let to = dragCurrent;
  if (from && (dragTool === "rect" || dragTool === "ellipse" || dragTool === "star"
    || dragTool === "polygon" || dragTool === "triangle") && eventShift) {
    to = constrainSquare(from, to);
  }
  selection = clampRect({
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  }, width, height);
  drawSelection();
}

let eventShift = false;

function startCropDrag(event: PointerEvent): void {
  if ((tool !== "crop" && tool !== "select") || !selection || event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const target = event.target as HTMLElement;
  const mode = (target.dataset.handle as CropHandle | undefined) ?? "move";
  const box = $("canvas-selection") as HTMLElement;
  cropDrag = { mode, start: canvasPoint(event), original: { ...selection }, pointerId: event.pointerId };
  box.setPointerCapture(event.pointerId);
}

function updateCropDrag(event: PointerEvent): void {
  if (!cropDrag) return;
  const point = canvasPoint(event);
  selection = adjustCropRect(
    cropDrag.original, cropDrag.mode, point.x - cropDrag.start.x, point.y - cropDrag.start.y, width, height,
  );
  drawSelection();
}

function endCropDrag(): void {
  if (!cropDrag) return;
  const box = $("canvas-selection") as HTMLElement;
  if (box.hasPointerCapture(cropDrag.pointerId)) box.releasePointerCapture(cropDrag.pointerId);
  cropDrag = null;
  if (selection && selection.width > 1 && selection.height > 1) {
    status("Crop region ready. Drag handles or press Enter to apply.");
  }
}

function applyCropSelection(): void {
  if (!selection || selection.width < 1 || selection.height < 1) return;
  const rect = { ...selection };
  selection = null;
  drawSelection();
  void applyCrop(rect);
}

function clearPreview(): void {
  preview().getContext("2d")?.clearRect(0, 0, width, height);
}

function strokeStyleColor(): string {
  return normalizeColor(color);
}

function traceShape(ctx: CanvasRenderingContext2D, activeTool: Tool, from: Point, to: Point, shift: boolean): void {
  const filled = activeTool === "highlight"
    || (shapeFilled && activeTool !== "line" && activeTool !== "arrow" && activeTool !== "measure");
  const alpha = activeTool === "highlight" ? 0.35 : brushOpacity / 100;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = activeTool === "highlight" ? "#ffd54a" : strokeStyleColor();
  ctx.fillStyle = activeTool === "highlight" ? "#ffd54a" : normalizeColor(fillColor, strokeStyleColor());
  ctx.lineWidth = Math.max(1, activeTool === "arrow" || activeTool === "line" ? brushSize / 2 : brushSize / 3);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  let target = to;
  if (shift && (activeTool === "rect" || activeTool === "ellipse" || activeTool === "star"
    || activeTool === "polygon" || activeTool === "triangle")) target = constrainSquare(from, to);
  if (activeTool === "line" || activeTool === "arrow" || activeTool === "measure") {
    const [start, end] = shift && activeTool !== "measure"
      ? lineEndpoints(from, to) as [Point, Point]
      : [from, to];
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    if (activeTool === "arrow") {
      const [left, right] = arrowHeadPoints(end, start, Math.max(10, brushSize * 2));
      ctx.moveTo(left.x, left.y);
      ctx.lineTo(end.x, end.y);
      ctx.lineTo(right.x, right.y);
    }
  } else if (activeTool === "triangle" || activeTool === "rect" || activeTool === "ellipse"
    || activeTool === "star" || activeTool === "polygon" || activeTool === "highlight") {
    const left = Math.min(from.x, target.x);
    const right = Math.max(from.x, target.x);
    const top = Math.min(from.y, target.y);
    const bottom = Math.max(from.y, target.y);
    if (activeTool === "rect" || activeTool === "highlight") {
      ctx.rect(left, top, right - left, bottom - top);
    } else if (activeTool === "ellipse") {
      ctx.ellipse((left + right) / 2, (top + bottom) / 2, (right - left) / 2, (bottom - top) / 2, 0, 0, Math.PI * 2);
    } else if (activeTool === "triangle") {
      const points = regularPolygonPoints({ x: (left + right) / 2, y: (top + bottom) / 2 }, Math.min(right - left, bottom - top) / 2, 3);
      ctx.moveTo(points[0].x, points[0].y);
      for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.closePath();
    } else if (activeTool === "star") {
      const cx = (left + right) / 2;
      const cy = (top + bottom) / 2;
      const outer = Math.min(right - left, bottom - top) / 2;
      const points = starPoints({ x: cx, y: cy }, outer, outer * 0.45, 5);
      ctx.moveTo(points[0].x, points[0].y);
      for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.closePath();
    } else {
      const cx = (left + right) / 2;
      const cy = (top + bottom) / 2;
      const radius = Math.min(right - left, bottom - top) / 2;
      const points = regularPolygonPoints({ x: cx, y: cy }, radius, shapeSides);
      ctx.moveTo(points[0].x, points[0].y);
      for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.closePath();
    }
  }
  if (filled) ctx.fill();
  ctx.stroke();
  ctx.globalAlpha = 1;
}

const SHAPE_TOOLS: Tool[] = ["line", "rect", "ellipse", "arrow", "triangle", "star", "polygon", "highlight"];

function drawShapePreview(): void {
  clearPreview();
  if (!dragStart || !dragCurrent || !dragTool || !SHAPE_TOOLS.includes(dragTool)) return;
  const ctx = preview().getContext("2d");
  if (!ctx) return;
  traceShape(ctx, dragTool, dragStart, dragCurrent, eventShift);
}

function drawMeasurement(): void {
  const label = $("canvas-measure-label") as HTMLElement;
  if (!measurement || compareEnabled) {
    label.style.display = "none";
    return;
  }
  const { from, to } = measurement;
  const data = measureBetween(from, to);
  label.style.display = "block";
  label.style.left = `${to.x * scaleX() + 10}px`;
  label.style.top = `${to.y * scaleY() - 24}px`;
  label.textContent = `${Math.round(data.distance)} px · Δ${Math.round(data.dx)}, ${Math.round(data.dy)} · ${Math.round(data.angle)}°`;
  status(`Measured ${Math.round(data.distance)} px (Δ${Math.round(data.dx)}, ${Math.round(data.dy)}, ${Math.round(data.angle)}°).`);
}

function commitShape(): void {
  const layer = activeLayer();
  if (!layer || !dragStart || !dragCurrent || !dragTool) return;
  const ctx = layer.canvas.getContext("2d");
  if (!ctx) return;
  if (dragTool === "callout") {
    const radius = Math.max(10, brushSize * 1.8);
    ctx.globalAlpha = brushOpacity / 100;
    ctx.fillStyle = strokeStyleColor();
    ctx.beginPath();
    ctx.arc(dragStart.x, dragStart.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${Math.max(10, radius)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(calloutNumber++), dragStart.x, dragStart.y + 1);
    ctx.globalAlpha = 1;
    clearPreview();
    return;
  }
  if (SHAPE_TOOLS.includes(dragTool)) traceShape(ctx, dragTool, dragStart, dragCurrent, eventShift);
  clearPreview();
}

function currentGrading(): Grading {
  const read = (id: string) => Number(input(id).value);
  return normalizeGrading({
    brightness: read("canvas-brightness"),
    contrast: read("canvas-contrast"),
    saturation: read("canvas-saturation"),
    exposure: read("canvas-exposure"),
    temperature: read("canvas-temperature"),
    tint: read("canvas-tint"),
    highlights: read("canvas-highlights"),
    shadows: read("canvas-shadows"),
    vibrance: read("canvas-vibrance"),
    hue: read("canvas-hue"),
    gamma: read("canvas-gamma"),
  });
}

const GRADING_IDS = [
  "canvas-brightness", "canvas-contrast", "canvas-saturation", "canvas-exposure",
  "canvas-temperature", "canvas-tint", "canvas-highlights", "canvas-shadows",
  "canvas-vibrance", "canvas-hue", "canvas-gamma",
];

function resetGrading(): void {
  for (const id of GRADING_IDS) input(id).value = "0";
  select("canvas-grading-preset").value = "";
  clearAdjustmentPreview();
  status("Grading sliders reset.");
}

function gradingKey(grading: Grading): string {
  return `${documentVersion}:${GRADING_IDS.map((id) => input(id).value).join(":")}:${JSON.stringify(grading)}`;
}

function cachePreview(key: string, bitmap: ImageBitmap): void {
  const existing = previewCache.get(key);
  if (existing) existing.close();
  previewCache.set(key, bitmap);
  while (previewCache.size > MAX_PREVIEW_CACHE) {
    const oldest = previewCache.keys().next().value;
    if (oldest === undefined) break;
    previewCache.get(oldest)?.close();
    previewCache.delete(oldest);
  }
}

function scheduleAdjustmentPreview(): void {
  if (!layers.length) return;
  const grading = currentGrading();
  if (isNeutralGrading(grading)) {
    clearAdjustmentPreview();
    status("Adjustments reset.");
    return;
  }
  if (previewTimer !== null) window.clearTimeout(previewTimer);
  status("Previewing adjustments…");
  previewTimer = window.setTimeout(() => void renderAdjustmentPreview(grading), PREVIEW_DEBOUNCE_MS);
}

async function renderAdjustmentPreview(grading: Grading): Promise<void> {
  const token = ++previewToken;
  try {
    if (!previewBase || previewBaseVersion !== documentVersion) {
      const fitted = fitWithin(width, height, DEFAULT_PREVIEW_PIXELS);
      // Grade each layer the same way Apply grading does, then composite. Grading
      // the flattened surface first is not equivalent for layered images.
      previewBase = layers.map((layer) => {
        const canvas = createLayerCanvas(fitted.width, fitted.height);
        const ctx = context2d(canvas);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(layer.canvas, 0, 0, fitted.width, fitted.height);
        return { ...layer, canvas };
      });
      previewBaseVersion = documentVersion;
    }
    const key = gradingKey(grading);
    let result = previewCache.get(key);
    if (!result) {
      const first = previewBase[0];
      if (!first) return;
      const composite = createLayerCanvas(first.canvas.width, first.canvas.height);
      const compositeCtx = context2d(composite);
      for (const layer of previewBase) {
        if (!layer.visible || layer.opacity <= 0) continue;
        const source = await createImageBitmap(layer.canvas);
        if (token !== previewToken) {
          source.close();
          return;
        }
        const graded = await requestBitmap({ type: "adjust", bitmap: source, grading });
        if (token !== previewToken) {
          graded.close();
          return;
        }
        compositeCtx.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
        compositeCtx.drawImage(graded, 0, 0);
        compositeCtx.globalAlpha = 1;
        graded.close();
      }
      result = await createImageBitmap(composite);
      if (token !== previewToken) {
        result.close();
        return;
      }
      cachePreview(key, result);
    }
    if (token !== previewToken) return;
    const overlay = adjustmentOverlay();
    if (overlay.width !== result.width) overlay.width = result.width;
    if (overlay.height !== result.height) overlay.height = result.height;
    const ctx = overlay.getContext("2d");
    ctx?.clearRect(0, 0, overlay.width, overlay.height);
    ctx?.drawImage(result, 0, 0);
    overlay.style.display = "block";
    status("Live grading preview.");
  } catch (error) {
    if (token === previewToken) status(error instanceof Error ? error.message : String(error));
  }
}

async function commitAdjustments(): Promise<void> {
  if (!layers.length) return;
  const grading = currentGrading();
  if (isNeutralGrading(grading)) {
    clearAdjustmentPreview();
    status("No adjustments to apply.");
    return;
  }
  clearAdjustmentPreview();
  const applied = await transformWithHistory("Adjust image", (bitmap) => ({ type: "adjust", bitmap, grading }));
  if (applied) {
    resetGrading();
    status("Adjustments applied.");
  }
}

async function extractPalette(): Promise<void> {
  if (!layers.length) return;
  status("Extracting palette…");
  try {
    const fitted = fitWithin(width, height, DEFAULT_PREVIEW_PIXELS);
    const canvas = createLayerCanvas(fitted.width, fitted.height);
    context2d(canvas).drawImage(surface(), 0, 0, fitted.width, fitted.height);
    const bitmap = await createImageBitmap(canvas);
    const colors = await requestPalette({ type: "palette", bitmap, count: 6 });
    const box = $("canvas-palette");
    box.replaceChildren();
    for (const hex of colors) {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "canvas-swatch";
      swatch.style.backgroundColor = hex;
      swatch.title = `Use ${hex}`;
      swatch.setAttribute("aria-label", `Use color ${hex}`);
      swatch.addEventListener("click", () => {
        color = normalizeColor(hex);
        updateColorInspector();
        setWindowValue("talos.canvas.color", color);
        status(`${color} selected.`);
      });
      box.appendChild(swatch);
    }
    status(colors.length ? "Palette extracted. Click a swatch to use its color." : "No opaque pixels to sample.");
  } catch (error) {
    status(error instanceof Error ? error.message : String(error));
  }
}

function sampleColor(point: Point): void {
  const ctx = surface().getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  const x = Math.max(0, Math.min(width - 1, Math.floor(point.x)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(point.y)));
  try {
    const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
    color = rgbToHex(r, g, b);
    updateColorInspector();
    setWindowValue("talos.canvas.color", color);
    status(`Sampled ${color} at ${x}, ${y}.`);
  } catch (error) {
    status(error instanceof Error ? error.message : "Could not sample this pixel.");
  }
}

function startText(point: Point): void {
  const textInput = input("canvas-text-input");
  const sx = scaleX();
  const sy = scaleY();
  textInput.style.display = "block";
  textInput.style.left = `${point.x * sx}px`;
  textInput.style.top = `${point.y * sy}px`;
  textInput.style.fontSize = `${Math.max(8, fontSize * sy)}px`;
  textInput.dataset.x = String(point.x);
  textInput.dataset.y = String(point.y);
  textInput.value = "";
  textInput.focus();
}

function commitText(): void {
  const textInput = input("canvas-text-input");
  if (textInput.style.display === "none" || !textInput.value.trim()) return;
  const layer = activeLayer();
  if (layer) {
    const ctx = layer.canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = strokeStyleColor();
      ctx.globalAlpha = brushOpacity / 100;
      ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillText(textInput.value, Number(textInput.dataset.x), Number(textInput.dataset.y));
      ctx.globalAlpha = 1;
    }
    invalidateDocument();
    pushHistory("Add text");
    composite();
  }
  hideTextInput();
}

function onPointerDown(event: PointerEvent): void {
  if (!layers.length || (event.button !== 0 && event.button !== 1)) return;
  eventShift = event.shiftKey;
  const point = canvasPoint(event);
  if (tool === "pan" || event.button === 1) {
    event.preventDefault();
    surface().setPointerCapture(event.pointerId);
    const viewport = $("canvas-viewport");
    panStart = { scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop, x: event.clientX, y: event.clientY };
    return;
  }
  if (compareEnabled) {
    compareDragging = true;
    updateCompareFromPointer(event);
    return;
  }
  if (tool === "zoom") {
    setZoom(event.altKey ? zoom / 1.25 : zoom * 1.25, { x: event.clientX, y: event.clientY });
    return;
  }
  if (tool === "eyedropper") {
    sampleColor(point);
    return;
  }
  if (tool === "text") {
    clearAdjustmentPreview();
    startText(point);
    return;
  }
  clearAdjustmentPreview();
  dragTool = tool;
  dragStart = point;
  dragCurrent = point;
  surface().setPointerCapture(event.pointerId);
  if (tool === "brush" || tool === "eraser") {
    pendingHistoryLabel = tool === "brush" ? "Brush stroke" : "Eraser stroke";
    drawing = true;
    const ctx = activeLayer()?.canvas.getContext("2d");
    if (ctx) {
      ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
      ctx.globalAlpha = brushOpacity / 100;
      ctx.strokeStyle = strokeStyleColor();
      ctx.lineWidth = brushSize;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(point.x, point.y);
      ctx.lineTo(point.x + 0.01, point.y + 0.01);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
    scheduleComposite(brushBounds(point, point, brushSize / 2 + 1, width, height) ?? undefined);
  } else if (tool === "measure") {
    measurement = { from: point, to: point };
    drawMeasurement();
  }
}

function onPointerMove(event: PointerEvent): void {
  eventShift = event.shiftKey;
  if (compareDragging) {
    updateCompareFromPointer(event);
    return;
  }
  if (panStart) {
    const viewport = $("canvas-viewport");
    viewport.scrollLeft = panStart.scrollLeft - (event.clientX - panStart.x);
    viewport.scrollTop = panStart.scrollTop - (event.clientY - panStart.y);
    return;
  }
  if (!dragStart) return;
  dragCurrent = canvasPoint(event);
  if (dragTool === "select" || dragTool === "crop") updateSelectionRect();
  else if (dragTool && SHAPE_TOOLS.includes(dragTool)) drawShapePreview();
  else if (tool === "measure" && measurement) {
    measurement.to = dragCurrent;
    drawMeasurement();
  } else if (drawing) {
    const ctx = activeLayer()?.canvas.getContext("2d");
    if (ctx) {
      ctx.globalCompositeOperation = dragTool === "eraser" ? "destination-out" : "source-over";
      ctx.globalAlpha = brushOpacity / 100;
      ctx.strokeStyle = strokeStyleColor();
      ctx.lineWidth = brushSize;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(dragStart.x, dragStart.y);
      ctx.lineTo(dragCurrent.x, dragCurrent.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      scheduleComposite(brushBounds(dragStart, dragCurrent, brushSize / 2 + 1, width, height) ?? undefined);
      dragStart = dragCurrent;
    }
  }
}

function onPointerUp(event: PointerEvent): void {
  if (surface().hasPointerCapture(event.pointerId)) surface().releasePointerCapture(event.pointerId);
  if (compareDragging) {
    endCompareDrag();
    return;
  }
  if (panStart) {
    panStart = null;
    return;
  }
  if (!dragStart) return;
  dragCurrent = canvasPoint(event);
  const finishedTool = dragTool;
  if (finishedTool === "crop" || finishedTool === "select") {
    updateSelectionRect();
    if (selection && selection.width > 1 && selection.height > 1) {
      status("Crop region ready. Drag handles or press Enter to apply.");
    }
  } else if (finishedTool && SHAPE_TOOLS.includes(finishedTool)) {
    commitShape();
    invalidateDocument();
    pushHistory(`Draw ${finishedTool}`);
    composite();
  } else if (finishedTool === "callout") {
    commitShape();
    invalidateDocument();
    pushHistory("Add callout");
    composite();
  } else if (finishedTool === "measure") {
    measurement = { from: dragStart, to: dragCurrent };
    drawMeasurement();
  }
  if (drawing && pendingHistoryLabel) {
    invalidateDocument();
    pushHistory(pendingHistoryLabel);
    pendingHistoryLabel = null;
    composite();
  }
  drawing = false;
  dragStart = null;
  dragCurrent = null;
  dragTool = null;
}

async function applyCrop(rect: Rect): Promise<void> {
  const applied = await transformWithHistory("Crop", (bitmap) => ({ type: "crop", bitmap, rect }));
  if (applied) {
    selection = null;
    drawSelection();
    measurement = null;
    drawMeasurement();
  }
}

async function resizeTo(size: Size, label = "Resize"): Promise<void> {
  if (!isValidDocumentSize(size)) {
    status("Choose dimensions from 1 to 20000 with at most 100 megapixels.");
    return;
  }
  if (size.width === width && size.height === height) return;
  await transformWithHistory(label, (bitmap) => ({ type: "resize", bitmap, width: size.width, height: size.height }));
}

async function applyResize(): Promise<void> {
  const requestedWidth = Number(input("canvas-width").value);
  const requestedHeight = Number(input("canvas-height").value);
  const keepAspect = input("canvas-lock-aspect").checked;
  await resizeTo(resizeDimensions(width, height, requestedWidth, requestedHeight, keepAspect));
}

function undo(): void {
  const value = history?.undo();
  if (!value) return;
  restore(value);
  status("Undo.");
}

function redo(): void {
  const value = history?.redo();
  if (!value) return;
  restore(value);
  status("Redo.");
}

function addLayer(): void {
  layers.push({
    id: String(nextLayerId++), name: nextLayerName(layers), visible: true, opacity: 1,
    canvas: createLayerCanvas(width, height),
  });
  activeIndex = layers.length - 1;
  renderAll();
  pushHistory("Add layer");
  status("Layer added.");
}

function deleteLayer(): void {
  if (layers.length <= 1) {
    status("A canvas needs at least one layer.");
    return;
  }
  layers.splice(activeIndex, 1);
  activeIndex = Math.min(activeIndex, layers.length - 1);
  renderAll();
  pushHistory("Delete layer");
  status("Layer deleted.");
}

function moveLayer(delta: number): void {
  const target = activeIndex + delta;
  if (target < 0 || target >= layers.length) return;
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  layers = reorderLayers(layers, activeIndex, target).map((info) => byId.get(info.id)!);
  activeIndex = target;
  renderAll();
  pushHistory("Reorder layers");
  status("Layer order updated.");
}

function applyGrid(): void {
  stage().dataset.grid = gridVisible ? "true" : "false";
  // Overlay CSS pixels must track document-pixel snapping at the current zoom.
  // Use both axes so rounded stage dimensions cannot introduce drift.
  stage().style.setProperty(
    "--canvas-grid-size",
    `${gridSpacing * scaleX()}px ${gridSpacing * scaleY()}px`,
  );
  stage().dataset.guides = guidesVisible ? "true" : "false";
  stage().dataset.transparency = transparencyMode;
}

function makePreviewCanvas(): HTMLCanvasElement {
  const fitted = fitWithin(width, height, DEFAULT_PREVIEW_PIXELS);
  const canvas = createLayerCanvas(fitted.width, fitted.height);
  context2d(canvas).drawImage(surface(), 0, 0, fitted.width, fitted.height);
  return canvas;
}

function renderCompare(): void {
  const overlay = $("canvas-compare") as HTMLElement;
  overlay.classList.toggle("hidden", !compareEnabled || !compareBaseline);
  if (!compareEnabled || !compareBaseline) return;
  const canvas = $("canvas-compare-canvas") as HTMLCanvasElement;
  const targetWidth = Math.max(1, stage().clientWidth);
  const targetHeight = Math.max(1, stage().clientHeight);
  if (canvas.width !== targetWidth) canvas.width = targetWidth;
  if (canvas.height !== targetHeight) canvas.height = targetHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const split = (Math.max(0, Math.min(100, compareSplit)) / 100) * targetWidth;
  ctx.clearRect(0, 0, targetWidth, targetHeight);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, split, targetHeight);
  ctx.clip();
  ctx.drawImage(compareBaseline, 0, 0, targetWidth, targetHeight);
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.rect(split, 0, targetWidth - split, targetHeight);
  ctx.clip();
  ctx.drawImage(surface(), 0, 0, targetWidth, targetHeight);
  ctx.restore();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(split - 1, 0, 2, targetHeight);
  const divider = $("canvas-compare-divider") as HTMLElement;
  divider.style.left = `${split}px`;
  input("canvas-compare-split").value = String(Math.round(compareSplit));
}

function updateCompareFromPointer(event: PointerEvent): void {
  const rect = stage().getBoundingClientRect();
  compareSplit = Math.max(0, Math.min(100, ((event.clientX - rect.left) / Math.max(1, rect.width)) * 100));
  renderCompare();
}

function endCompareDrag(): void {
  const overlay = $("canvas-compare") as HTMLElement;
  if (comparePointerId !== null && overlay.hasPointerCapture(comparePointerId)) {
    overlay.releasePointerCapture(comparePointerId);
  }
  comparePointerId = null;
  compareDragging = false;
}

function setComparisonBaseline(): void {
  if (!layers.length) return;
  compareBaseline = makePreviewCanvas();
  compareEnabled = true;
  renderCompare();
  status("Comparison baseline captured. Drag the divider to compare.");
}

function exportExtension(): "png" | "jpg" | "webp" {
  return exportExtensionForMime(select("canvas-export-format").value);
}

function openExportDialog(): void {
  if (!layers.length) return;
  if (transformBusy) {
    status("Wait for the current image operation to finish.");
    return;
  }
  const base = sourcePath && /\.[^./\\]+$/.test(sourcePath)
    ? sourcePath.replace(/\.[^./\\]+$/, "") : (sourcePath ?? "untitled");
  const mime = EXPORT_PRESETS[0].mime;
  exportBasePath = base;
  exportPathEdited = false;
  input("canvas-export-path").value = normalizeExportPath(
    `${base}${EXPORT_PRESETS[0].suffix}.${exportExtensionForMime(mime)}`, mime,
  );
  input("canvas-export-width").value = String(width);
  input("canvas-export-height").value = String(height);
  input("canvas-export-quality").value = String(EXPORT_PRESETS[0].quality);
  input("canvas-export-background").value = "#ffffff";
  input("canvas-export-aspect").checked = true;
  input("canvas-export-overwrite").checked = false;
  select("canvas-export-format").value = mime;
  select("canvas-export-presets").value = "source";
  updateExportExtension();
  $("canvas-export-status").textContent = "Ready.";
  $("canvas-export-dialog").classList.remove("hidden");
  ($("canvas-export-dialog") as HTMLDialogElement).showModal();
}

function applyExportPreset(): void {
  const preset = EXPORT_PRESETS.find((item) => item.id === select("canvas-export-presets").value);
  if (!preset) return;
  select("canvas-export-format").value = preset.mime;
  input("canvas-export-quality").value = String(preset.quality);
  if (preset.width && preset.height) {
    input("canvas-export-width").value = String(preset.width);
    input("canvas-export-height").value = String(preset.height);
    input("canvas-export-aspect").checked = true;
  } else {
    input("canvas-export-width").value = String(width);
    input("canvas-export-height").value = String(height);
    input("canvas-export-aspect").checked = true;
  }
  if (!exportPathEdited && exportBasePath) {
    input("canvas-export-path").value = normalizeExportPath(
      `${exportBasePath}${preset.suffix}.${exportExtensionForMime(preset.mime)}`, preset.mime,
    );
  }
  updateExportExtension();
}

function updateExportExtension(): void {
  const extension = exportExtension();
  $("canvas-export-extension").textContent = extension.toUpperCase();
  const path = input("canvas-export-path");
  if (path.value) path.value = normalizeExportPath(path.value, select("canvas-export-format").value);
}

async function exportImage(): Promise<void> {
  if (exportBusy) return;
  if (transformBusy) {
    $("canvas-export-status").textContent = "Wait for the current image operation to finish.";
    return;
  }
  const target = input("canvas-export-path").value.trim();
  if (!target) {
    $("canvas-export-status").textContent = "Choose a destination.";
    return;
  }
  const overwrite = input("canvas-export-overwrite").checked;
  if (target === sourcePath && !overwrite) {
    $("canvas-export-status").textContent = "Confirm overwrite to replace the original image.";
    return;
  }
  const mime = select("canvas-export-format").value;
  const normalized = normalizeExportPath(target, mime);
  if (normalized !== target) input("canvas-export-path").value = normalized;
  const qualityValue = Number(input("canvas-export-quality").value);
  const quality = Math.max(0.1, Math.min(1, (Number.isFinite(qualityValue) ? qualityValue : 92) / 100));
  const size: Size = {
    width: Math.floor(Number(input("canvas-export-width").value)),
    height: Math.floor(Number(input("canvas-export-height").value)),
  };
  if (!isValidDocumentSize(size)) {
    $("canvas-export-status").textContent = "Invalid export dimensions.";
    return;
  }
  exportBusy = true;
  ($("canvas-export-save") as HTMLButtonElement).disabled = true;
  let bitmap: ImageBitmap | null = null;
  try {
    $("canvas-export-status").textContent = "Flattening image…";
    bitmap = await flatten();
    if (!bitmap) throw new Error("Open an image before exporting.");
    if (size.width !== width || size.height !== height) {
      $("canvas-export-status").textContent = "Resizing image…";
      const resized = await requestBitmap({ type: "resize", bitmap, width: size.width, height: size.height });
      try { bitmap.close(); } catch { /* already transferred */ }
      bitmap = resized;
    }
    $("canvas-export-status").textContent = "Encoding image…";
    const background = normalizeColor(input("canvas-export-background").value, "#ffffff");
    const bytes = await requestEncode(bitmap, mime, quality, background);
    bitmap = null;
    $("canvas-export-status").textContent = "Writing file…";
    await writeBytes(normalized, bytes, overwrite);
    sourcePath = normalized;
    // Exports are raster files; keep SVG text only while an SVG is open.
    svgSource = null;
    $("canvas-full-res").classList.add("hidden");
    setWindowValue("talos.canvas.path", normalized);
    updateChrome();
    ($("canvas-export-dialog") as HTMLDialogElement).close();
    status(`Exported ${fileNameFromPath(normalized)}.`);
  } catch (error) {
    $("canvas-export-status").textContent = error instanceof Error ? error.message : String(error);
  } finally {
    if (bitmap) {
      try { bitmap.close(); } catch { /* already closed */ }
    }
    exportBusy = false;
    ($("canvas-export-save") as HTMLButtonElement).disabled = false;
  }
}

async function openImageDialog(): Promise<void> {
  const last = getWindowValue("talos.canvas.path");
  const picked = await open({
    multiple: false,
    directory: false,
    defaultPath: last ?? undefined,
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "svg"] }],
  });
  if (typeof picked === "string") await openImage(picked);
}

function canvasVisible(): boolean {
  return !$("canvas").classList.contains("hidden");
}

function restoreSettings(): void {
  const storedZoom = Number(getWindowValue("talos.canvas.zoom"));
  if (Number.isFinite(storedZoom) && storedZoom > 0) zoom = Math.min(4, Math.max(0.05, storedZoom));
  color = normalizeColor(getWindowValue("talos.canvas.color"));
  fillColor = normalizeColor(getWindowValue("talos.canvas.fill-color"), color);
  const storedBrush = Number(getWindowValue("talos.canvas.brush-size"));
  if (Number.isFinite(storedBrush) && storedBrush > 0) brushSize = Math.min(200, storedBrush);
  const storedOpacity = Number(getWindowValue("talos.canvas.opacity"));
  if (Number.isFinite(storedOpacity)) brushOpacity = Math.max(1, Math.min(100, storedOpacity || 100));
  const storedFont = Number(getWindowValue("talos.canvas.font-size"));
  if (Number.isFinite(storedFont) && storedFont > 0) fontSize = Math.min(200, storedFont);
  const storedTool = getWindowValue("talos.canvas.tool");
  if (storedTool && CANVAS_TOOLS.includes(storedTool as Tool)) tool = storedTool as Tool;
  const storedSpacing = Number(getWindowValue("talos.canvas.grid-spacing"));
  if (Number.isFinite(storedSpacing) && storedSpacing >= 2) gridSpacing = Math.min(500, storedSpacing);
  gridVisible = getWindowValue("talos.canvas.grid") === "true";
  snapEnabled = getWindowValue("talos.canvas.snap") === "true";
  guidesVisible = getWindowValue("talos.canvas.guides") === "true";
  transparencyMode = getWindowValue("talos.canvas.transparency") ?? "checker";
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-canvas-tool]")) {
    const active = button.dataset.canvasTool === tool;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  input("canvas-color").value = color;
  input("canvas-fill-color").value = fillColor;
  input("canvas-brush-size").value = String(brushSize);
  input("canvas-opacity").value = String(brushOpacity);
  input("canvas-font-size").value = String(fontSize);
  input("canvas-show-grid").checked = gridVisible;
  input("canvas-grid-spacing").value = String(gridSpacing);
  input("canvas-snap-grid").checked = snapEnabled;
  input("canvas-show-guides").checked = guidesVisible;
  select("canvas-transparency").value = transparencyMode;
  applyGrid();
  updateColorInspector();
}

const GRADING_PRESETS: Record<string, Partial<Grading>> = {
  warm: { temperature: 32, highlights: 12, shadows: -10, vibrance: 14, saturation: 6 },
  cool: { temperature: -32, shadows: 14, highlights: -8, vibrance: 10 },
  cinematic: { contrast: 18, temperature: 16, tint: -8, shadows: -18, highlights: -12, saturation: -6, gamma: 6 },
  vintage: { temperature: 24, saturation: -22, contrast: -8, gamma: 10, shadows: 12 },
  noir: { saturation: -100, contrast: 24, gamma: -6 },
};

function applyGradingPreset(): void {
  const preset = GRADING_PRESETS[select("canvas-grading-preset").value];
  if (!preset) return;
  const grading = { ...NEUTRAL_GRADING, ...preset };
  const values: Record<string, number> = {
    "canvas-brightness": grading.brightness, "canvas-contrast": grading.contrast,
    "canvas-saturation": grading.saturation, "canvas-exposure": grading.exposure,
    "canvas-temperature": grading.temperature, "canvas-tint": grading.tint,
    "canvas-highlights": grading.highlights, "canvas-shadows": grading.shadows,
    "canvas-vibrance": grading.vibrance, "canvas-hue": grading.hue, "canvas-gamma": grading.gamma,
  };
  for (const [id, value] of Object.entries(values)) input(id).value = String(value);
  scheduleAdjustmentPreview();
  status("Grading preset loaded. Apply to commit.");
}

function onCanvasSurface(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  return target === document.body
    || target === document.documentElement
    || target.closest("#canvas") !== null;
}

function initialize(): void {
  if (initialized) return;
  initialized = true;
  restoreSettings();

  $("canvas-close").addEventListener("click", closeCanvas);
  $("canvas-open").addEventListener("click", () => void openImageDialog().catch((error: unknown) => status(String(error))));
  $("canvas-undo").addEventListener("click", undo);
  $("canvas-redo").addEventListener("click", redo);
  $("canvas-fit").addEventListener("click", fitZoom);
  $("canvas-zoom-in").addEventListener("click", () => setZoom(zoom * 1.25));
  $("canvas-zoom-out").addEventListener("click", () => setZoom(zoom / 1.25));
  $("canvas-export").addEventListener("click", openExportDialog);
  $("canvas-full-res").addEventListener("click", () => {
    if (sourcePath) void openImage(sourcePath, { fullResolution: true }).catch((error: unknown) => status(String(error)));
  });
  $("canvas-inspector-toggle").addEventListener("click", () => {
    $("canvas-inspector").classList.toggle("inspector-open");
  });
  $("canvas-compare-toggle").addEventListener("click", () => {
    if (!compareBaseline) setComparisonBaseline();
    else {
      compareEnabled = !compareEnabled;
      renderCompare();
    }
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-canvas-tool]")) {
    button.addEventListener("click", () => setTool(button.dataset.canvasTool as Tool));
  }

  surface().addEventListener("pointerdown", onPointerDown);
  surface().addEventListener("pointermove", onPointerMove);
  surface().addEventListener("pointerup", onPointerUp);
  surface().addEventListener("pointercancel", onPointerUp);
  const selectionBox = $("canvas-selection") as HTMLElement;
  selectionBox.addEventListener("pointerdown", startCropDrag);
  selectionBox.addEventListener("pointermove", updateCropDrag);
  selectionBox.addEventListener("pointerup", endCropDrag);
  selectionBox.addEventListener("pointercancel", endCropDrag);
  const compareOverlay = $("canvas-compare") as HTMLElement;
  compareOverlay.addEventListener("pointerdown", (event) => {
    comparePointerId = event.pointerId;
    compareOverlay.setPointerCapture(event.pointerId);
    compareDragging = true;
    updateCompareFromPointer(event);
  });
  compareOverlay.addEventListener("pointermove", (event) => {
    if (compareDragging) updateCompareFromPointer(event);
  });
  compareOverlay.addEventListener("pointerup", endCompareDrag);
  compareOverlay.addEventListener("pointercancel", endCompareDrag);

  $("canvas-viewport").addEventListener("wheel", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    setZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1), { x: event.clientX, y: event.clientY });
  }, { passive: false });

  input("canvas-text-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitText();
    } else if (event.key === "Escape") {
      hideTextInput();
    }
  });

  $("canvas-resize").addEventListener("click", () => void applyResize());
  $("canvas-apply-crop").addEventListener("click", applyCropSelection);
  $("canvas-rotate-left").addEventListener("click", () => void transformWithHistory("Rotate left", (bitmap) => ({ type: "rotate", bitmap, angle: 270 })));
  $("canvas-rotate-right").addEventListener("click", () => void transformWithHistory("Rotate right", (bitmap) => ({ type: "rotate", bitmap, angle: 90 })));
  $("canvas-flip-h").addEventListener("click", () => void transformWithHistory("Flip horizontally", (bitmap) => ({ type: "flip", bitmap, axis: "horizontal" })));
  $("canvas-flip-v").addEventListener("click", () => void transformWithHistory("Flip vertically", (bitmap) => ({ type: "flip", bitmap, axis: "vertical" })));
  $("canvas-apply-adjust").addEventListener("click", () => void commitAdjustments().catch((error: unknown) => status(String(error))));
  $("canvas-reset-adjust").addEventListener("click", resetGrading);
  select("canvas-grading-preset").addEventListener("change", applyGradingPreset);
  $("canvas-apply-filter").addEventListener("click", () => {
    const filter = select("canvas-filter").value as FilterName;
    if (!filter) return;
    void transformWithHistory(`Filter: ${filter}`, (bitmap) => ({ type: "filter", bitmap, filter }))
      .catch((error: unknown) => status(String(error)));
  });

  for (const id of GRADING_IDS) $(id).addEventListener("input", scheduleAdjustmentPreview);

  input("canvas-color").addEventListener("change", () => {
    color = normalizeColor(input("canvas-color").value);
    updateColorInspector();
    setWindowValue("talos.canvas.color", color);
  });
  input("canvas-fill-color").addEventListener("change", () => {
    fillColor = normalizeColor(input("canvas-fill-color").value, color);
    updateColorInspector();
    setWindowValue("talos.canvas.fill-color", fillColor);
  });
  input("canvas-hex").addEventListener("change", () => {
    const next = normalizeColor(input("canvas-hex").value, color);
    color = next;
    updateColorInspector();
    setWindowValue("talos.canvas.color", color);
  });
  input("canvas-brush-size").addEventListener("change", () => {
    brushSize = Math.max(1, Math.min(200, Number(input("canvas-brush-size").value) || 8));
    input("canvas-brush-size").value = String(brushSize);
    setWindowValue("talos.canvas.brush-size", String(brushSize));
  });
  input("canvas-opacity").addEventListener("change", () => {
    brushOpacity = Math.max(1, Math.min(100, Number(input("canvas-opacity").value) || 100));
    setWindowValue("talos.canvas.opacity", String(brushOpacity));
  });
  input("canvas-font-size").addEventListener("change", () => {
    fontSize = Math.max(6, Math.min(200, Number(input("canvas-font-size").value) || 20));
    input("canvas-font-size").value = String(fontSize);
    setWindowValue("talos.canvas.font-size", String(fontSize));
  });
  input("canvas-shape-filled").addEventListener("change", () => {
    shapeFilled = input("canvas-shape-filled").checked;
  });
  input("canvas-shape-sides").addEventListener("change", () => {
    shapeSides = Math.max(3, Math.min(24, Number(input("canvas-shape-sides").value) || 6));
    input("canvas-shape-sides").value = String(shapeSides);
  });
  $("canvas-reset-callouts").addEventListener("click", () => {
    calloutNumber = 1;
    status("Callout numbering reset to 1.");
  });
  $("canvas-extract-palette").addEventListener("click", () => void extractPalette());

  $("canvas-add-layer").addEventListener("click", addLayer);
  $("canvas-delete-layer").addEventListener("click", deleteLayer);
  $("canvas-layer-up").addEventListener("click", () => moveLayer(1));
  $("canvas-layer-down").addEventListener("click", () => moveLayer(-1));

  select("canvas-asset-preset").addEventListener("change", () => {
    const preset = ASSET_PRESETS.find((item) => item.id === select("canvas-asset-preset").value);
    if (!preset) return;
    input("canvas-width").value = String(preset.width);
    input("canvas-height").value = String(preset.height);
    input("canvas-lock-aspect").checked = false;
  });
  $("canvas-apply-asset-preset").addEventListener("click", () => {
    const preset = ASSET_PRESETS.find((item) => item.id === select("canvas-asset-preset").value);
    if (!preset) return;
    void resizeTo({ width: preset.width, height: preset.height }, `Asset preset: ${preset.label}`);
  });

  input("canvas-show-grid").addEventListener("change", () => {
    gridVisible = input("canvas-show-grid").checked;
    setWindowValue("talos.canvas.grid", String(gridVisible));
    applyGrid();
  });
  input("canvas-grid-spacing").addEventListener("change", () => {
    gridSpacing = Math.max(2, Math.min(500, Number(input("canvas-grid-spacing").value) || 32));
    input("canvas-grid-spacing").value = String(gridSpacing);
    setWindowValue("talos.canvas.grid-spacing", String(gridSpacing));
    applyGrid();
  });
  input("canvas-snap-grid").addEventListener("change", () => {
    snapEnabled = input("canvas-snap-grid").checked;
    setWindowValue("talos.canvas.snap", String(snapEnabled));
  });
  input("canvas-show-guides").addEventListener("change", () => {
    guidesVisible = input("canvas-show-guides").checked;
    setWindowValue("talos.canvas.guides", String(guidesVisible));
    applyGrid();
  });
  select("canvas-transparency").addEventListener("change", () => {
    transparencyMode = select("canvas-transparency").value;
    setWindowValue("talos.canvas.transparency", transparencyMode);
    applyGrid();
  });
  $("canvas-compare-baseline").addEventListener("click", setComparisonBaseline);
  $("canvas-compare-clear").addEventListener("click", () => {
    compareBaseline = null;
    compareEnabled = false;
    renderCompare();
    status("Comparison cleared.");
  });
  input("canvas-compare-split").addEventListener("input", () => {
    compareSplit = Number(input("canvas-compare-split").value);
    renderCompare();
  });

  $("canvas-svg-apply").addEventListener("click", () => {
    if (!sourcePath || !svgSource) return;
    void decodeSvgSource(
      input("canvas-svg-source").value,
      Number(input("canvas-svg-raster-width").value),
      Number(input("canvas-svg-raster-height").value),
    ).then((decoded) => {
      resetDocument(sourcePath, decoded.bitmap, "SVG source applied to the local preview. The source file was not changed.", input("canvas-svg-source").value);
      decoded.bitmap.close();
      $("canvas-full-res").classList.add("hidden");
    }).catch((error: unknown) => status(String(error)));
  });
  $("canvas-svg-save").addEventListener("click", () => {
    const path = sourcePath;
    if (!path || !svgSource) return;
    void writeBytes(path, new TextEncoder().encode(input("canvas-svg-source").value), true)
      .then(() => status(`Saved SVG source to ${fileNameFromPath(path)}.`))
      .catch((error: unknown) => status(String(error)));
  });

  select("canvas-export-presets").addEventListener("change", applyExportPreset);
  select("canvas-export-format").addEventListener("change", updateExportExtension);
  input("canvas-export-path").addEventListener("input", () => { exportPathEdited = true; });
  input("canvas-export-path").addEventListener("change", updateExportExtension);
  input("canvas-export-width").addEventListener("change", () => {
    if (!input("canvas-export-aspect").checked || !width || !height) return;
    const next = Number(input("canvas-export-width").value);
    if (next > 0) input("canvas-export-height").value = String(Math.max(1, Math.round((next * height) / width)));
  });
  input("canvas-export-height").addEventListener("change", () => {
    if (!input("canvas-export-aspect").checked || !width || !height) return;
    const next = Number(input("canvas-export-height").value);
    if (next > 0) input("canvas-export-width").value = String(Math.max(1, Math.round((next * width) / height)));
  });
  $("canvas-export-close").addEventListener("click", () => ($("canvas-export-dialog") as HTMLDialogElement).close());
  $("canvas-export-cancel").addEventListener("click", () => ($("canvas-export-dialog") as HTMLDialogElement).close());
  $("canvas-export-save").addEventListener("click", () => void exportImage());

  document.addEventListener("keydown", (event) => {
    if (!canvasVisible()) return;
    const dialog = $("canvas-export-dialog") as HTMLDialogElement;
    const onCanvasSurfaceArea = onCanvasSurface(event.target);
    // Native select popups emit Escape when they close, so only close Canvas
    // when focus is on the image itself.
    if (event.key === "Escape" && !dialog.open && onCanvasSurfaceArea) {
      event.preventDefault();
      event.stopPropagation();
      if ((tool === "crop" || tool === "select") && selection) {
        selection = null;
        drawSelection();
        status("Crop selection cleared.");
      } else {
        closeCanvas();
      }
      return;
    }
    if (dialog.open || event.target === input("canvas-text-input")
      || ["INPUT", "TEXTAREA", "SELECT"].includes((event.target as HTMLElement | null)?.tagName ?? "")) return;

    if (event.key === "Enter" && onCanvasSurfaceArea && (tool === "crop" || tool === "select") && selection) {
      event.preventDefault();
      event.stopPropagation();
      applyCropSelection();
      return;
    }
    if (!onCanvasSurfaceArea) return;

    eventShift = event.shiftKey;
    if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      const toolByCode: Record<string, Tool> = {
        KeyV: "select", KeyC: "crop", KeyH: "pan", KeyZ: "zoom", KeyB: "brush", KeyX: "eraser",
        KeyL: "line", KeyR: "rect", KeyO: "ellipse", KeyA: "arrow", KeyN: "triangle", KeyT: "text",
        KeyS: "star", KeyP: "polygon", KeyK: "callout", KeyY: "highlight", KeyM: "measure", KeyI: "eyedropper",
      };
      let handled = true;
      if (toolByCode[event.code]) setTool(toolByCode[event.code]);
      else if (event.code === "BracketLeft") {
        brushSize = Math.max(1, brushSize - 2);
        input("canvas-brush-size").value = String(brushSize);
      } else if (event.code === "BracketRight") {
        brushSize = Math.min(200, brushSize + 2);
        input("canvas-brush-size").value = String(brushSize);
      } else if (event.code === "Digit0") fitZoom();
      else if (event.code === "Equal" || event.code === "NumpadAdd") setZoom(zoom * 1.25);
      else if (event.code === "Minus" || event.code === "NumpadSubtract") setZoom(zoom / 1.25);
      else handled = false;
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    const key = event.code;
    let handled = true;
    if (key === "KeyZ") event.shiftKey ? redo() : undo();
    else if (key === "KeyY") redo();
    else if (key === "KeyO") void openImageDialog().catch((error: unknown) => status(String(error)));
    else if (key === "KeyE") openExportDialog();
    else if (key === "Digit0") fitZoom();
    else if (key === "Equal" || key === "NumpadAdd") setZoom(zoom * 1.25);
    else if (key === "Minus" || key === "NumpadSubtract") setZoom(zoom / 1.25);
    else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);
}

export function openCanvas(path?: string): void {
  initialize();
  showCanvas();
  if (path) void openImage(path).catch((error: unknown) => status(String(error)));
  else if (!layers.length) status("Choose Open image… to start editing.");
}

export function isCanvasImagePath(path: string): boolean {
  return isImagePath(path);
}
