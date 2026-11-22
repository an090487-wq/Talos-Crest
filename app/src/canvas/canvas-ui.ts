// Talos Canvas workspace. Loaded on demand; all heavy image work is sent to
// an OffscreenCanvas worker, with a small main-thread fallback.

import { open, save } from "@tauri-apps/plugin-dialog";
import { fileNameFromPath, readBytes, writeBytes } from "../platform";
import { getWindowValue, setWindowValue } from "../window-state";
import type { CropHandle, Rect, Size } from "./image-core";
import {
  BoundedHistory,
  DEFAULT_MAX_PIXELS,
  DEFAULT_PREVIEW_PIXELS,
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
  unionRect,
} from "./image-core";

type FilterName = "grayscale" | "sepia" | "invert" | "blur" | "sharpen";
type Tool = "select" | "crop" | "pan" | "zoom" | "brush" | "eraser" | "line" | "rect" | "ellipse" | "text";
const CANVAS_TOOLS: Tool[] = ["select", "crop", "pan", "zoom", "brush", "eraser", "line", "rect", "ellipse", "text"];
type Axis = "horizontal" | "vertical";

interface Adjustment {
  brightness: number;
  contrast: number;
  saturation: number;
  exposure: number;
}

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
  layers: Layer[];
}

type BitmapRequest =
  | { id: number; type: "decode"; bytes: Uint8Array; mime: string; maxPixels: number }
  | { id: number; type: "resize"; bitmap: ImageBitmap; width: number; height: number }
  | { id: number; type: "crop"; bitmap: ImageBitmap; x: number; y: number; width: number; height: number }
  | { id: number; type: "rotate"; bitmap: ImageBitmap; angle: 90 | 180 | 270 }
  | { id: number; type: "flip"; bitmap: ImageBitmap; axis: Axis }
  | ({ id: number; type: "adjust"; bitmap: ImageBitmap } & Adjustment)
  | { id: number; type: "filter"; bitmap: ImageBitmap; filter: FilterName }
  | { id: number; type: "encode"; bitmap: ImageBitmap; mime: string; quality: number }
  | {
      id: number;
      type: "flatten";
      layers: Array<{ bitmap: ImageBitmap; opacity: number; visible: boolean }>;
      width: number;
      height: number;
    };

type WorkerResult = ImageBitmap | Uint8Array | DecodedImage;

interface WorkerResponse {
  id: number;
  bitmap?: ImageBitmap;
  bytes?: Uint8Array;
  downsampled?: boolean;
  error?: string;
}

const $ = (id: string) => document.getElementById(id)!;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|svg)$/i;
const DEFAULT_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml",
};
const PREVIEW_DEBOUNCE_MS = 90;
const MAX_PREVIEW_CACHE = 6;

function exportExtension(): string {
  const mime = ($("canvas-export-format") as HTMLSelectElement | null)?.value ?? "image/png";
  return mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
}

let width = 0;
let height = 0;
let layers: Layer[] = [];
let activeIndex = 0;
let sourcePath: string | null = null;
let zoom = 1;
let tool: Tool = "select";
let color = "#59c7d4";
let brushSize = 8;
let fontSize = 20;
let selection: Rect | null = null;
let dragStart: { x: number; y: number } | null = null;
let dragCurrent: { x: number; y: number } | null = null;
let cropDrag: { mode: CropHandle; start: { x: number; y: number }; original: Rect; pointerId: number } | null = null;
let panStart: { scrollLeft: number; scrollTop: number; x: number; y: number } | null = null;
let drawing = false;
let pendingHistoryLabel: string | null = null;
let compositing = false;
let pendingDirty: Rect | null = null;
let nextLayerId = 1;
let worker: Worker | null = null;
let nextRequestId = 1;
let history: BoundedHistory<Snapshot> | null = null;
let initialized = false;
let documentVersion = 0;
let transformToken = 0;
let previewToken = 0;
let previewTimer: number | null = null;
let previewBase: HTMLCanvasElement | null = null;
let previewBaseVersion = -1;
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

function layerAt(index: number): Layer | null {
  return layers[index] ?? null;
}

function activeLayer(): Layer | null {
  return layerAt(activeIndex);
}

function createLayerCanvas(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
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
    layers: layers.map((layer) => ({
      id: layer.id, name: layer.name, visible: layer.visible, opacity: layer.opacity, canvas: cloneCanvas(layer.canvas),
    })),
  };
}

function restore(snapshot: Snapshot): void {
  width = snapshot.width;
  height = snapshot.height;
  layers = snapshot.layers.map((layer) => ({ ...layer, canvas: cloneCanvas(layer.canvas) }));
  activeIndex = Math.min(activeIndex, Math.max(0, layers.length - 1));
  selection = null;
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

function applyZoom(): void {
  const stage = $("canvas-stage") as HTMLElement;
  stage.style.width = `${Math.max(1, Math.round(width * zoom))}px`;
  stage.style.height = `${Math.max(1, Math.round(height * zoom))}px`;
  $("canvas-zoom").textContent = `${Math.round(zoom * 100)}%`;
  drawSelection();
}

function setZoom(next: number, anchor?: { x: number; y: number }): void {
  const target = Math.max(0.05, Math.min(4, next));
  if (!Number.isFinite(target) || target === zoom) return;
  const stage = $("canvas-stage") as HTMLElement;
  const before = stage.getBoundingClientRect();
  const imageX = anchor ? (anchor.x - before.left) / zoom : null;
  const imageY = anchor ? (anchor.y - before.top) / zoom : null;
  zoom = target;
  applyZoom();
  if (anchor && imageX !== null && imageY !== null) {
    const viewport = $("canvas-viewport");
    const after = stage.getBoundingClientRect();
    viewport.scrollLeft += after.left + imageX * zoom - anchor.x;
    viewport.scrollTop += after.top + imageY * zoom - anchor.y;
  }
}

function fitZoom(): void {
  if (!width || !height) return;
  const viewport = $("canvas-viewport");
  const availableWidth = Math.max(120, viewport.clientWidth - 48);
  const availableHeight = Math.max(120, viewport.clientHeight - 48);
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
  if (dirty) {
    ctx.clearRect(dirty.x, dirty.y, dirty.width, dirty.height);
  } else {
    ctx.clearRect(0, 0, width, height);
  }
  for (const layer of layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    ctx.globalAlpha = normalizeOpacity(layer.opacity);
    if (dirty) {
      ctx.drawImage(
        layer.canvas,
        dirty.x, dirty.y, dirty.width, dirty.height,
        dirty.x, dirty.y, dirty.width, dirty.height,
      );
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
  layers.forEach((layer, index) => {
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
      updateHistoryButtons();
    });

    const name = document.createElement("span");
    name.className = "canvas-layer-name";
    name.textContent = layer.name;
    name.dataset.hidden = String(!layer.visible);
    name.title = "Double-click to rename";
    name.addEventListener("dblclick", () => {
      const next = window.prompt("Layer name", layer.name)?.trim();
      if (!next || next === layer.name) return;
      layer.name = next;
      invalidateDocument();
      pushHistory("Rename layer");
      renderLayers();
      updateHistoryButtons();
    });

    const opacity = document.createElement("input");
    opacity.type = "range";
    opacity.min = "0";
    opacity.max = "100";
    opacity.value = String(Math.round(layer.opacity * 100));
    opacity.title = "Layer opacity";
    opacity.setAttribute("aria-label", `${layer.name} opacity`);
    opacity.addEventListener("input", () => {
      layer.opacity = Number(opacity.value) / 100;
      scheduleComposite();
    });
    opacity.addEventListener("change", () => {
      layer.opacity = Number(opacity.value) / 100;
      invalidateDocument();
      pushHistory("Layer opacity");
      renderLayers();
      updateHistoryButtons();
    });

    row.append(eye, name, opacity);
    row.addEventListener("click", (event) => {
      if (event.target === opacity || event.target === eye) return;
      activeIndex = index;
      renderLayers();
      status(`${layer.name} selected.`);
    });
    list.appendChild(row);
  });
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

function updateChrome(): void {
  $("canvas-dimensions").textContent = `${width} × ${height}`;
  const widthInput = $("canvas-width") as HTMLInputElement | null;
  if (widthInput) widthInput.value = String(width);
  ($("canvas-height") as HTMLInputElement).value = String(height);
  const bytes = layers.reduce((sum, layer) => sum + estimateRgbaBytes(layer.canvas.width, layer.canvas.height), 0);
  $("canvas-memory").textContent = `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  $("canvas-file").textContent = sourcePath ? fileNameFromPath(sourcePath) : "Untitled canvas";
  $("canvas-status-file").textContent = sourcePath ? fileNameFromPath(sourcePath) : "Untitled canvas";
}

function ensureWorker(): Worker | null {
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") return null;
  if (worker) return worker;
  worker = new Worker(new URL("./image-worker.ts", import.meta.url), { type: "module" });
  worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const entry = pending.get(response.id);
    if (!entry) {
      // A superseded or cancelled request still owns its transferred bitmap.
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
    } else {
      entry.reject(new Error("The image worker returned no result."));
    }
  });
  worker.addEventListener("error", (event) => {
    for (const entry of pending.values()) entry.reject(new Error(event.message || "Image worker failed."));
    pending.clear();
  });
  return worker;
}

function closeRequestBitmaps(request: BitmapRequest): void {
  if (request.type === "flatten") {
    for (const layer of request.layers) {
      try { layer.bitmap.close(); } catch { /* already detached */ }
    }
  } else if ("bitmap" in request) {
    try { request.bitmap.close(); } catch { /* already detached */ }
  }
}

async function fallbackBitmap(request: BitmapRequest): Promise<ImageBitmap> {
  if (request.type === "flatten") {
    const flat = createLayerCanvas(request.width, request.height);
    const flatCtx = flat.getContext("2d")!;
    for (const layer of request.layers) {
      if (!layer.visible) continue;
      flatCtx.globalAlpha = normalizeOpacity(layer.opacity);
      flatCtx.drawImage(layer.bitmap, 0, 0, request.width, request.height);
    }
    return await createImageBitmap(flat);
  }
  if (request.type === "decode" || request.type === "encode" || !("bitmap" in request)) {
    throw new Error(`Unsupported image operation: ${request.type}`);
  }
  const canvas = createLayerCanvas(
    request.type === "resize" || request.type === "crop" ? request.width : request.bitmap.width,
    request.type === "resize" || request.type === "crop" ? request.height : request.bitmap.height,
  );
  const ctx = canvas.getContext("2d")!;
  switch (request.type) {
    case "resize":
      ctx.drawImage(request.bitmap, 0, 0, request.width, request.height);
      break;
    case "crop":
      ctx.drawImage(request.bitmap, request.x, request.y, request.width, request.height, 0, 0, request.width, request.height);
      break;
    case "rotate": {
      const swaps = request.angle === 180;
      canvas.width = swaps ? request.bitmap.width : request.bitmap.height;
      canvas.height = swaps ? request.bitmap.height : request.bitmap.width;
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((request.angle * Math.PI) / 180);
      ctx.drawImage(request.bitmap, -request.bitmap.width / 2, -request.bitmap.height / 2);
      break;
    }
    case "flip":
      if (request.axis === "horizontal") {
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
      } else {
        ctx.translate(0, canvas.height);
        ctx.scale(1, -1);
      }
      ctx.drawImage(request.bitmap, 0, 0);
      break;
    case "adjust": {
      const { brightness, contrast, saturation, exposure } = request;
      const light = Math.max(0.1, Math.min(3, 1 + brightness / 100 + exposure));
      const contrastValue = Math.max(0, Math.min(3, 1 + contrast / 100));
      const saturationValue = Math.max(0, Math.min(3, 1 + saturation / 100));
      ctx.filter = `brightness(${light}) contrast(${contrastValue}) saturate(${saturationValue})`;
      ctx.drawImage(request.bitmap, 0, 0);
      break;
    }
    case "filter": {
      const filters: Record<FilterName, string> = {
        grayscale: "grayscale(1)", sepia: "sepia(1)", invert: "invert(1)", blur: "blur(1.5px)", sharpen: "none",
      };
      ctx.filter = filters[request.filter];
      ctx.drawImage(request.bitmap, 0, 0);
      break;
    }
    default:
      throw new Error("Unsupported image operation.");
  }
  return await createImageBitmap(canvas);
}

async function decodeFallback(bytes: Uint8Array, mime: string, maxPixels: number): Promise<DecodedImage> {
  const blob = new Blob([bytes as BlobPart], { type: mime || "image/png" });
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
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
  const fitted = fitWithin(bitmap.width, bitmap.height, maxPixels);
  if (fitted.width === bitmap.width && fitted.height === bitmap.height) {
    return { bitmap, downsampled: false };
  }
  const resized = await createImageBitmap(bitmap, { resizeWidth: fitted.width, resizeHeight: fitted.height });
  bitmap.close();
  return { bitmap: resized, downsampled: true };
}

async function encodeFallback(bitmap: ImageBitmap, mime: string, quality: number): Promise<Uint8Array> {
  const canvas = createLayerCanvas(bitmap.width, bitmap.height);
  try {
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob>((resolveBlob, rejectBlob) => {
      canvas.toBlob(
        (result) => result ? resolveBlob(result) : rejectBlob(new Error("Could not encode the image.")),
        mime,
        quality,
      );
    });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

async function runFallback(request: BitmapRequest): Promise<WorkerResult> {
  if (request.type === "decode") return decodeFallback(request.bytes, request.mime, request.maxPixels);
  if (request.type === "encode") return encodeFallback(request.bitmap, request.mime, request.quality);
  try {
    return await fallbackBitmap(request);
  } finally {
    closeRequestBitmaps(request);
  }
}

async function requestResult<T extends WorkerResult>(request: BitmapRequest, transfer: Transferable[]): Promise<T> {
  const activeWorker = ensureWorker();
  const id = ++nextRequestId;
  const message = { ...request, id } as BitmapRequest;
  if (!activeWorker) return await runFallback(request) as T;
  return new Promise<T>((resolvePromise, rejectPromise) => {
    pending.set(id, {
      resolve: (value) => resolvePromise(value as T),
      reject: rejectPromise,
    });
    try {
      activeWorker.postMessage(message, transfer);
    } catch (error) {
      pending.delete(id);
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function requestBitmap(request: BitmapRequest, transfer: Transferable[]): Promise<ImageBitmap> {
  return requestResult<ImageBitmap>(request, transfer);
}

function requestBytes(request: BitmapRequest, transfer: Transferable[]): Promise<Uint8Array> {
  return requestResult<Uint8Array>(request, transfer);
}

function requestDecode(request: BitmapRequest, transfer: Transferable[]): Promise<DecodedImage> {
  return requestResult<DecodedImage>(request, transfer);
}

async function requestEncode(bitmap: ImageBitmap, mime: string, quality: number): Promise<Uint8Array> {
  try {
    return await requestBytes({ id: nextRequestId, type: "encode", bitmap, mime, quality }, [bitmap]);
  } catch (error) {
    try { bitmap.close(); } catch { /* already detached */ }
    throw error;
  }
}

async function transformDocument(build: (id: number, bitmap: ImageBitmap) => BitmapRequest): Promise<boolean> {
  if (!layers.length) return false;
  const token = ++transformToken;
  clearAdjustmentPreview();
  status("Processing…");
  try {
    const jobs = layers.map(async (layer) => {
      const bitmap = await createImageBitmap(layer.canvas);
      try {
        const request = build(nextRequestId, bitmap);
        const result = await requestBitmap(request, [bitmap]);
        if (token !== transformToken) {
          result.close();
          throw new Error("Canvas changed during processing.");
        }
        const canvas = createLayerCanvas(result.width, result.height);
        canvas.getContext("2d")?.drawImage(result, 0, 0);
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
    selection = null;
    resizeSurface();
    renderAll();
    status("Done.");
    return true;
  } catch (error) {
    if (token === transformToken) status(error instanceof Error ? error.message : String(error));
    return false;
  }
}

async function transformWithHistory(
  label: string,
  build: (id: number, bitmap: ImageBitmap) => BitmapRequest,
): Promise<boolean> {
  // Store the state after a successful edit so undo/redo both see real states.
  if (!(await transformDocument(build))) return false;
  pushHistory(label);
  updateHistoryButtons();
  return true;
}

async function flatten(): Promise<ImageBitmap | null> {
  if (!layers.length) return null;
  const bitmaps: ImageBitmap[] = [];
  try {
    for (const layer of layers) bitmaps.push(await createImageBitmap(layer.canvas));
    const request: BitmapRequest = {
      id: nextRequestId,
      type: "flatten",
      layers: bitmaps.map((bitmap, index) => ({ bitmap, opacity: layers[index].opacity, visible: layers[index].visible })),
      width,
      height,
    };
    return await requestBitmap(request, bitmaps);
  } catch (error) {
    for (const bitmap of bitmaps) {
      try { bitmap.close(); } catch { /* already transferred */ }
    }
    throw error;
  }
}

async function decodeImage(bytes: Uint8Array, mime: string): Promise<DecodedImage> {
  if (typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined") {
    try {
      const copy = new Uint8Array(bytes);
      return await requestDecode(
        { id: nextRequestId, type: "decode", bytes: copy, mime, maxPixels: DEFAULT_MAX_PIXELS },
        [copy.buffer],
      );
    } catch {
      // Fall back to the main thread if the worker cannot decode this format.
    }
  }
  return decodeFallback(bytes, mime, DEFAULT_MAX_PIXELS);
}

function resetDocument(path: string | null, bitmap: ImageBitmap, message: string): void {
  width = bitmap.width;
  height = bitmap.height;
  const canvas = createLayerCanvas(width, height);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  layers = [{ id: String(nextLayerId++), name: "Background", visible: true, opacity: 1, canvas }];
  activeIndex = 0;
  sourcePath = path;
  selection = null;
  const initial = capture();
  history = createHistory(initial);
  resizeSurface();
  fitZoom();
  renderAll();
  status(message);
}

async function openImage(path: string): Promise<void> {
  const bytes = await readBytes(path);
  const name = fileNameFromPath(path).toLowerCase();
  const extension = name.split(".").pop() ?? "png";
  const decoded = await decodeImage(bytes, DEFAULT_MIME[extension] ?? "image/png");
  const notice = decoded.downsampled
    ? " Large images are opened at reduced resolution to keep editing responsive."
    : "";
  showCanvas();
  resetDocument(path, decoded.bitmap, `Opened ${fileNameFromPath(path)}.${notice}`);
  decoded.bitmap.close();
}

function showCanvas(): void {
  $("canvas").classList.remove("hidden");
}

function closeCanvas(): void {
  $("canvas").classList.add("hidden");
  clearAdjustmentPreview();
  for (const layer of layers) {
    layer.canvas.width = 0;
    layer.canvas.height = 0;
  }
  layers = [];
  width = height = 0;
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

function canvasPoint(event: PointerEvent): { x: number; y: number } {
  const rect = surface().getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(width, ((event.clientX - rect.left) / Math.max(1, rect.width)) * width)),
    y: Math.max(0, Math.min(height, ((event.clientY - rect.top) / Math.max(1, rect.height)) * height)),
  };
}

function setTool(next: Tool): void {
  tool = next;
  setWindowValue("talos.canvas.tool", next);
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-canvas-tool]")) {
    button.classList.toggle("active", button.dataset.canvasTool === tool);
  }
  drawSelection();
  status(tool === "crop"
    ? "Crop tool selected. Drag a region, adjust its handles, then press Enter."
    : `${tool[0].toUpperCase()}${tool.slice(1)} tool selected.`);
}

function drawSelection(): void {
  const box = $("canvas-selection") as HTMLElement;
  if (!selection) {
    box.style.display = "none";
    return;
  }
  box.style.display = "block";
  box.dataset.interactive = tool === "crop" ? "true" : "false";
  box.style.left = `${selection.x * zoom}px`;
  box.style.top = `${selection.y * zoom}px`;
  box.style.width = `${selection.width * zoom}px`;
  box.style.height = `${selection.height * zoom}px`;
}

function updateSelectionRect(): void {
  if (!dragStart || !dragCurrent) return;
  selection = clampRect({
    x: Math.min(dragStart.x, dragCurrent.x),
    y: Math.min(dragStart.y, dragCurrent.y),
    width: Math.abs(dragCurrent.x - dragStart.x),
    height: Math.abs(dragCurrent.y - dragStart.y),
  }, width, height);
  drawSelection();
}

function startCropDrag(event: PointerEvent): void {
  if (tool !== "crop" || !selection || event.button !== 0) return;
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
    cropDrag.original,
    cropDrag.mode,
    point.x - cropDrag.start.x,
    point.y - cropDrag.start.y,
    width,
    height,
  );
  drawSelection();
}

function endCropDrag(): void {
  if (!cropDrag) return;
  const box = $("canvas-selection") as HTMLElement;
  if (box.hasPointerCapture(cropDrag.pointerId)) box.releasePointerCapture(cropDrag.pointerId);
  cropDrag = null;
  if (selection && selection.width > 1 && selection.height > 1) {
    status("Crop region updated. Press Enter or choose Apply crop.");
  }
}

function applyCropSelection(): void {
  if (!selection) return;
  if (selection.width < 1 || selection.height < 1) return;
  const rect = { ...selection };
  selection = null;
  drawSelection();
  void applyCrop(rect);
}

function clearPreview(): void {
  const canvas = preview();
  canvas.getContext("2d")?.clearRect(0, 0, width, height);
}

function drawShapePreview(): void {
  clearPreview();
  if (!dragStart || !dragCurrent) return;
  const ctx = preview().getContext("2d");
  if (!ctx) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, brushSize / 2);
  ctx.beginPath();
  if (tool === "line") {
    ctx.moveTo(dragStart.x, dragStart.y);
    ctx.lineTo(dragCurrent.x, dragCurrent.y);
  } else if (tool === "rect") {
    ctx.rect(dragStart.x, dragStart.y, dragCurrent.x - dragStart.x, dragCurrent.y - dragStart.y);
  } else if (tool === "ellipse") {
    ctx.ellipse(
      (dragStart.x + dragCurrent.x) / 2, (dragStart.y + dragCurrent.y) / 2,
      Math.abs(dragCurrent.x - dragStart.x) / 2, Math.abs(dragCurrent.y - dragStart.y) / 2, 0, 0, Math.PI * 2,
    );
  }
  ctx.stroke();
}

function commitShape(): void {
  const layer = activeLayer();
  if (!layer || !dragStart || !dragCurrent) return;
  const ctx = layer.canvas.getContext("2d");
  if (!ctx) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, brushSize / 2);
  ctx.beginPath();
  if (tool === "line") {
    ctx.moveTo(dragStart.x, dragStart.y);
    ctx.lineTo(dragCurrent.x, dragCurrent.y);
  } else if (tool === "rect") {
    ctx.rect(dragStart.x, dragStart.y, dragCurrent.x - dragStart.x, dragCurrent.y - dragStart.y);
  } else if (tool === "ellipse") {
    ctx.ellipse(
      (dragStart.x + dragCurrent.x) / 2, (dragStart.y + dragCurrent.y) / 2,
      Math.abs(dragCurrent.x - dragStart.x) / 2, Math.abs(dragCurrent.y - dragStart.y) / 2, 0, 0, Math.PI * 2,
    );
  }
  ctx.stroke();
  clearPreview();
}

function currentAdjustment(): Adjustment {
  return {
    brightness: Number(($("canvas-brightness") as HTMLInputElement).value),
    contrast: Number(($("canvas-contrast") as HTMLInputElement).value),
    saturation: Number(($("canvas-saturation") as HTMLInputElement).value),
    exposure: Number(($("canvas-exposure") as HTMLInputElement).value),
  };
}

function neutralAdjustment(adjustment: Adjustment): boolean {
  return adjustment.brightness === 0 && adjustment.contrast === 0
    && adjustment.saturation === 0 && adjustment.exposure === 0;
}

function adjustmentKey(adjustment: Adjustment): string {
  return `${documentVersion}:${adjustment.brightness}:${adjustment.contrast}:${adjustment.saturation}:${adjustment.exposure}`;
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
  const adjustment = currentAdjustment();
  if (neutralAdjustment(adjustment)) {
    clearAdjustmentPreview();
    status("Adjustments reset.");
    return;
  }
  if (previewTimer !== null) window.clearTimeout(previewTimer);
  status("Previewing adjustments…");
  previewTimer = window.setTimeout(() => void renderAdjustmentPreview(adjustment), PREVIEW_DEBOUNCE_MS);
}

async function renderAdjustmentPreview(adjustment: Adjustment): Promise<void> {
  const token = ++previewToken;
  try {
    if (!previewBase || previewBaseVersion !== documentVersion) {
      const fitted = fitWithin(width, height, DEFAULT_PREVIEW_PIXELS);
      const base = createLayerCanvas(fitted.width, fitted.height);
      base.getContext("2d")?.drawImage(surface(), 0, 0, fitted.width, fitted.height);
      previewBase = base;
      previewBaseVersion = documentVersion;
    }
    const key = adjustmentKey(adjustment);
    let result = previewCache.get(key);
    if (!result) {
      const source = await createImageBitmap(previewBase);
      if (token !== previewToken) {
        source.close();
        return;
      }
      result = await requestBitmap({ id: nextRequestId, type: "adjust", bitmap: source, ...adjustment }, [source]);
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
    status("Live adjustment preview.");
  } catch (error) {
    if (token === previewToken) status(error instanceof Error ? error.message : String(error));
  }
}

async function commitAdjustments(): Promise<void> {
  if (!layers.length) return;
  const adjustment = currentAdjustment();
  if (neutralAdjustment(adjustment)) {
    clearAdjustmentPreview();
    status("No adjustments to apply.");
    return;
  }
  clearAdjustmentPreview();
  const applied = await transformWithHistory("Adjust image", (id, bitmap) => ({
    id, type: "adjust", bitmap, ...adjustment,
  }));
  if (applied) {
    for (const id of ["canvas-brightness", "canvas-contrast", "canvas-saturation", "canvas-exposure"]) {
      (($(id) as HTMLInputElement)).value = "0";
    }
    status("Adjustments applied.");
  }
}

function startText(point: { x: number; y: number }): void {
  const input = $("canvas-text-input") as HTMLInputElement;
  input.style.display = "block";
  input.style.left = `${point.x * zoom}px`;
  input.style.top = `${point.y * zoom}px`;
  input.dataset.x = String(point.x);
  input.dataset.y = String(point.y);
  input.value = "";
  input.focus();
}

function commitText(): void {
  const input = $("canvas-text-input") as HTMLInputElement;
  if (input.style.display === "none" || !input.value.trim()) return;
  const layer = activeLayer();
  if (layer) {
    const ctx = layer.canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = color;
      ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillText(input.value, Number(input.dataset.x), Number(input.dataset.y));
    }
    invalidateDocument();
    pushHistory("Add text");
    updateHistoryButtons();
    composite();
  }
  input.style.display = "none";
  input.value = "";
}

function onPointerDown(event: PointerEvent): void {
  if (!layers.length || (event.button !== 0 && event.button !== 1)) return;
  const point = canvasPoint(event);
  surface().setPointerCapture(event.pointerId);
  if (tool === "pan" || event.button === 1) {
    event.preventDefault();
    const viewport = $("canvas-viewport");
    panStart = { scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop, x: event.clientX, y: event.clientY };
    return;
  }
  if (tool === "zoom") {
    setZoom(event.altKey ? zoom / 1.25 : zoom * 1.25, { x: event.clientX, y: event.clientY });
    return;
  }
  if (tool === "text") {
    clearAdjustmentPreview();
    startText(point);
    return;
  }
  clearAdjustmentPreview();
  dragStart = point;
  dragCurrent = point;
  if (tool === "brush" || tool === "eraser") {
    pendingHistoryLabel = tool === "brush" ? "Brush stroke" : "Eraser stroke";
    drawing = true;
    const ctx = activeLayer()?.canvas.getContext("2d");
    if (ctx) {
      ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
      ctx.strokeStyle = color;
      ctx.lineWidth = brushSize;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(point.x, point.y);
      ctx.lineTo(point.x + 0.01, point.y + 0.01);
      ctx.stroke();
      ctx.globalCompositeOperation = "source-over";
    }
    scheduleComposite(brushBounds(point, point, brushSize / 2, width, height) ?? undefined);
  }
}

function onPointerMove(event: PointerEvent): void {
  if (panStart) {
    const viewport = $("canvas-viewport");
    viewport.scrollLeft = panStart.scrollLeft - (event.clientX - panStart.x);
    viewport.scrollTop = panStart.scrollTop - (event.clientY - panStart.y);
    return;
  }
  if (!dragStart) return;
  dragCurrent = canvasPoint(event);
  if (tool === "select" || tool === "crop") updateSelectionRect();
  else if (tool === "line" || tool === "rect" || tool === "ellipse") drawShapePreview();
  else if (drawing) {
    const ctx = activeLayer()?.canvas.getContext("2d");
    if (ctx) {
      ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
      ctx.strokeStyle = color;
      ctx.lineWidth = brushSize;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(dragStart.x, dragStart.y);
      ctx.lineTo(dragCurrent.x, dragCurrent.y);
      ctx.stroke();
      ctx.globalCompositeOperation = "source-over";
      scheduleComposite(brushBounds(dragStart, dragCurrent, brushSize / 2, width, height) ?? undefined);
      dragStart = dragCurrent;
    }
  }
}

function onPointerUp(event: PointerEvent): void {
  if (surface().hasPointerCapture(event.pointerId)) surface().releasePointerCapture(event.pointerId);
  if (panStart) {
    panStart = null;
    return;
  }
  if (!dragStart) return;
  dragCurrent = canvasPoint(event);
  if (tool === "crop") {
    updateSelectionRect();
    if (selection && selection.width > 1 && selection.height > 1) {
      status("Crop region ready. Drag handles or press Enter to apply.");
    }
  } else if (tool === "line" || tool === "rect" || tool === "ellipse") {
    commitShape();
    invalidateDocument();
    pushHistory(`Draw ${tool}`);
    updateHistoryButtons();
    composite();
  }
  if (drawing && pendingHistoryLabel) {
    invalidateDocument();
    pushHistory(pendingHistoryLabel);
    pendingHistoryLabel = null;
    updateHistoryButtons();
    composite();
  }
  drawing = false;
  dragStart = null;
  dragCurrent = null;
}

async function applyCrop(rect: Rect): Promise<void> {
  await transformWithHistory("Crop", (id, bitmap) => ({
    id, type: "crop", bitmap, x: rect.x, y: rect.y, width: rect.width, height: rect.height,
  }));
  selection = null;
  drawSelection();
}

async function applyResize(): Promise<void> {
  const requestedWidth = Number(($("canvas-width") as HTMLInputElement).value);
  const requestedHeight = Number(($("canvas-height") as HTMLInputElement).value);
  const keepAspect = ($("canvas-lock-aspect") as HTMLInputElement).checked;
  const size: Size = resizeDimensions(width, height, requestedWidth, requestedHeight, keepAspect);
  if (size.width === width && size.height === height) return;
  await transformWithHistory("Resize", (id, bitmap) => ({ id, type: "resize", bitmap, ...size }));
}

function undo(): void {
  const value = history?.undo();
  if (!value) return;
  restore(value);
  status("Undo.");
  updateHistoryButtons();
}

function redo(): void {
  const value = history?.redo();
  if (!value) return;
  restore(value);
  status("Redo.");
  updateHistoryButtons();
}

function addLayer(): void {
  layers.push({ id: String(nextLayerId++), name: nextLayerName(layers), visible: true, opacity: 1, canvas: createLayerCanvas(width, height) });
  activeIndex = layers.length - 1;
  renderAll();
  pushHistory("Add layer");
  updateHistoryButtons();
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
  updateHistoryButtons();
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
  updateHistoryButtons();
  status("Layer order updated.");
}

async function openExportDialog(): Promise<void> {
  if (!layers.length) return;
  const extension = sourcePath?.split(".").pop()?.toLowerCase() ?? "png";
  const suggested = sourcePath ? sourcePath.replace(/\.[^.]+$/, `-edited.${extension}`) : `untitled.${extension}`;
  const target = await save({
    title: "Export image",
    defaultPath: suggested,
    filters: [
      { name: "PNG image", extensions: ["png"] },
      { name: "JPEG image", extensions: ["jpg", "jpeg"] },
      { name: "WebP image", extensions: ["webp"] },
    ],
  });
  if (!target) return;
  const targetExtension = target.split(".").pop()?.toLowerCase();
  if (targetExtension === "jpg" || targetExtension === "jpeg") {
    ($("canvas-export-format") as HTMLSelectElement).value = "image/jpeg";
  } else if (targetExtension === "webp") {
    ($("canvas-export-format") as HTMLSelectElement).value = "image/webp";
  } else {
    ($("canvas-export-format") as HTMLSelectElement).value = "image/png";
  }
  ($("canvas-export-extension") as HTMLElement).textContent = exportExtension().toUpperCase();
  ($("canvas-export-path") as HTMLInputElement).value = target;
  ($("canvas-export-width") as HTMLInputElement).value = String(width);
  ($("canvas-export-height") as HTMLInputElement).value = String(height);
  ($("canvas-export-overwrite") as HTMLInputElement).checked = false;
  ($("canvas-export-dialog") as HTMLDialogElement).showModal();
}

async function exportImage(): Promise<void> {
  const target = ($("canvas-export-path") as HTMLInputElement).value;
  const overwrite = ($("canvas-export-overwrite") as HTMLInputElement).checked;
  if (!target) return;
  if (target === sourcePath && !overwrite) {
    status("Confirm overwrite to replace the original image.");
    return;
  }
  const mime = ($("canvas-export-format") as HTMLSelectElement).value;
  const quality = Number(($("canvas-export-quality") as HTMLInputElement).value) / 100;
  const exportWidth = Number(($("canvas-export-width") as HTMLInputElement).value);
  const exportHeight = Number(($("canvas-export-height") as HTMLInputElement).value);
  ($("canvas-export-dialog") as HTMLDialogElement).close();
  status("Flattening image…");
  try {
    let bitmap = await flatten();
    if (!bitmap) throw new Error("Open an image before exporting.");
    if (exportWidth > 0 && exportHeight > 0 && (exportWidth !== width || exportHeight !== height)) {
      status("Resizing image…");
      const resized = await requestBitmap({ id: nextRequestId, type: "resize", bitmap, width: exportWidth, height: exportHeight }, [bitmap]);
      try { bitmap.close(); } catch { /* already transferred */ }
      bitmap = resized;
    }
    status("Encoding image…");
    const bytes = await requestEncode(bitmap, mime, quality);
    status("Writing file…");
    await writeBytes(target, bytes, overwrite);
    setWindowValue("talos.canvas.path", target);
    status(`Exported ${fileNameFromPath(target)}.`);
  } catch (error) {
    status(error instanceof Error ? error.message : String(error));
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
  const storedColor = getWindowValue("talos.canvas.color");
  if (storedColor) color = storedColor;
  const storedBrush = Number(getWindowValue("talos.canvas.brush-size"));
  if (Number.isFinite(storedBrush) && storedBrush > 0) brushSize = Math.min(200, storedBrush);
  const storedFont = Number(getWindowValue("talos.canvas.font-size"));
  if (Number.isFinite(storedFont) && storedFont > 0) fontSize = Math.min(200, storedFont);
  const storedTool = getWindowValue("talos.canvas.tool");
  if (storedTool && CANVAS_TOOLS.includes(storedTool as Tool)) tool = storedTool as Tool;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-canvas-tool]")) {
    button.classList.toggle("active", button.dataset.canvasTool === tool);
  }
  ($("canvas-color") as HTMLInputElement).value = color;
  ($("canvas-brush-size") as HTMLInputElement).value = String(brushSize);
  ($("canvas-font-size") as HTMLInputElement).value = String(fontSize);
}

function updateBrushSize(next: number): void {
  brushSize = Math.max(1, Math.min(200, Math.round(next)));
  ($("canvas-brush-size") as HTMLInputElement).value = String(brushSize);
  setWindowValue("talos.canvas.brush-size", String(brushSize));
  status(`Brush size ${brushSize}px.`);
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
  $("canvas-export").addEventListener("click", () => void openExportDialog().catch((error: unknown) => status(String(error))));

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

  $("canvas-viewport").addEventListener("wheel", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    setZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1), { x: event.clientX, y: event.clientY });
  }, { passive: false });

  const textInput = $("canvas-text-input") as HTMLInputElement;
  textInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitText();
    } else if (event.key === "Escape") {
      textInput.style.display = "none";
    }
  });

  $("canvas-resize").addEventListener("click", () => void applyResize());
  $("canvas-apply-crop").addEventListener("click", applyCropSelection);
  $("canvas-rotate-left").addEventListener("click", () => void transformWithHistory("Rotate left", (id, bitmap) => ({ id, type: "rotate", bitmap, angle: 270 })));
  $("canvas-rotate-right").addEventListener("click", () => void transformWithHistory("Rotate right", (id, bitmap) => ({ id, type: "rotate", bitmap, angle: 90 })));
  $("canvas-flip-h").addEventListener("click", () => void transformWithHistory("Flip horizontally", (id, bitmap) => ({ id, type: "flip", bitmap, axis: "horizontal" })));
  $("canvas-flip-v").addEventListener("click", () => void transformWithHistory("Flip vertically", (id, bitmap) => ({ id, type: "flip", bitmap, axis: "vertical" })));
  $("canvas-apply-adjust").addEventListener("click", () => void commitAdjustments().catch((error: unknown) => status(String(error))));
  $("canvas-apply-filter").addEventListener("click", () => {
    const filter = ($("canvas-filter") as HTMLSelectElement).value as FilterName;
    if (!filter) return;
    void transformWithHistory(`Filter: ${filter}`, (id, bitmap) => ({ id, type: "filter", bitmap, filter }))
      .catch((error: unknown) => status(String(error)));
  });

  for (const id of ["canvas-brightness", "canvas-contrast", "canvas-saturation", "canvas-exposure"]) {
    $(id).addEventListener("input", scheduleAdjustmentPreview);
  }

  $("canvas-color").addEventListener("change", () => {
    color = ($("canvas-color") as HTMLInputElement).value;
    setWindowValue("talos.canvas.color", color);
  });
  $("canvas-brush-size").addEventListener("change", () => {
    updateBrushSize(Number(($("canvas-brush-size") as HTMLInputElement).value) || 8);
  });
  $("canvas-font-size").addEventListener("change", () => {
    fontSize = Math.max(6, Number(($("canvas-font-size") as HTMLInputElement).value) || 20);
    setWindowValue("talos.canvas.font-size", String(fontSize));
  });

  $("canvas-add-layer").addEventListener("click", addLayer);
  $("canvas-delete-layer").addEventListener("click", deleteLayer);
  $("canvas-layer-up").addEventListener("click", () => moveLayer(-1));
  $("canvas-layer-down").addEventListener("click", () => moveLayer(1));

  $("canvas-export-format").addEventListener("change", () => {
    const extension = exportExtension();
    ($("canvas-export-extension") as HTMLElement).textContent = extension.toUpperCase();
    const pathInput = $("canvas-export-path") as HTMLInputElement;
    if (pathInput.value) pathInput.value = pathInput.value.replace(/\.[^./]+$/, `.${extension}`);
  });

  document.addEventListener("keydown", (event) => {
    if (!canvasVisible()) return;
    const dialog = $("canvas-export-dialog") as HTMLDialogElement;
    const target = event.target as HTMLElement | null;
    const onCanvasSurface = !target
      || target === document.body
      || target === document.documentElement
      || ["canvas", "canvas-stage", "canvas-viewport", "canvas-adjust-preview", "canvas-selection"].includes(target.id);
    // A native select popup emits Escape when it closes; only treat Escape as
    // a Canvas close when focus is on the image itself.
    if (event.key === "Escape" && !dialog.open && onCanvasSurface) {
      event.preventDefault();
      event.stopPropagation();
      if (tool === "crop" && selection) {
        selection = null;
        drawSelection();
        status("Crop selection cleared.");
      } else {
        closeCanvas();
      }
      return;
    }
    if (dialog.open || target?.id === "canvas-text-input" || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")) return;
    if (event.key === "Enter" && onCanvasSurface && tool === "crop" && selection) {
      event.preventDefault();
      event.stopPropagation();
      applyCropSelection();
      return;
    }

    if (!event.ctrlKey && !event.metaKey) {
      const key = event.key.toLowerCase();
      const toolKeys: Record<string, Tool> = {
        v: "select", c: "crop", h: "pan", z: "zoom", b: "brush", x: "eraser",
        l: "line", r: "rect", o: "ellipse", t: "text",
      };
      let handled = true;
      if (toolKeys[key]) setTool(toolKeys[key]);
      else if (key === "[") updateBrushSize(brushSize - 2);
      else if (key === "]") updateBrushSize(brushSize + 2);
      else if (key === "0") fitZoom();
      else if (key === "+" || key === "=") setZoom(zoom * 1.25);
      else if (key === "-") setZoom(zoom / 1.25);
      else handled = false;
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    const key = event.key.toLowerCase();
    let handled = true;
    if (key === "z") event.shiftKey ? redo() : undo();
    else if (key === "y") redo();
    else if (key === "o") void openImageDialog().catch((error: unknown) => status(String(error)));
    else if (key === "e") void openExportDialog().catch((error: unknown) => status(String(error)));
    else if (key === "0") fitZoom();
    else if (key === "+" || key === "=") setZoom(zoom * 1.25);
    else if (key === "-") setZoom(zoom / 1.25);
    else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);

  $("canvas-export-close").addEventListener("click", () => ($("canvas-export-dialog") as HTMLDialogElement).close());
  $("canvas-export-cancel").addEventListener("click", () => ($("canvas-export-dialog") as HTMLDialogElement).close());
  $("canvas-export-save").addEventListener("click", () => void exportImage());
}

export function openCanvas(path?: string): void {
  initialize();
  showCanvas();
  if (path) void openImage(path).catch((error: unknown) => status(String(error)));
  else if (!layers.length) status("Choose Open image… to start editing.");
}

export function isCanvasImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.test(path);
}
