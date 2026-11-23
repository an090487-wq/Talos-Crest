// DOM-free helpers for Talos Canvas. Kept separate from rendering so the
// geometry, layer and history rules can be tested without a browser.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface LayerInfo {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
}

export interface HistoryOptions<T> {
  maxEntries?: number;
  maxBytes?: number;
  onDrop?: (entry: T) => void;
}

export const DEFAULT_MAX_PIXELS = 24_000_000;
export const MAX_DOCUMENT_PIXELS = 100_000_000;
export const DEFAULT_HISTORY_ENTRIES = 6;
export const DEFAULT_HISTORY_BYTES = 64 * 1024 * 1024;
export const DEFAULT_PREVIEW_PIXELS = 640_000;

export type CropHandle = "move" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function clampRect(rect: Rect, width: number, height: number): Rect | null {
  if (!(width > 0) || !(height > 0)) return null;
  const x = Math.max(0, Math.min(width - 1, Math.floor(finite(rect.x, 0))));
  const y = Math.max(0, Math.min(height - 1, Math.floor(finite(rect.y, 0))));
  const right = Math.max(x + 1, Math.min(width, Math.floor(finite(rect.x + rect.width, x + 1))));
  const bottom = Math.max(y + 1, Math.min(height, Math.floor(finite(rect.y + rect.height, y + 1))));
  return { x, y, width: right - x, height: bottom - y };
}

export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

export function brushBounds(
  from: { x: number; y: number },
  to: { x: number; y: number },
  radius: number,
  width: number,
  height: number,
): Rect | null {
  const padding = Math.max(0, finite(radius, 0));
  const x = Math.floor(Math.min(from.x, to.x) - padding);
  const y = Math.floor(Math.min(from.y, to.y) - padding);
  return clampRect({
    x,
    y,
    width: Math.ceil(Math.max(from.x, to.x) + padding) - x,
    height: Math.ceil(Math.max(from.y, to.y) + padding) - y,
  }, width, height);
}

export function adjustCropRect(
  original: Rect,
  handle: CropHandle,
  dx: number,
  dy: number,
  width: number,
  height: number,
): Rect {
  let left = original.x;
  let top = original.y;
  let right = original.x + original.width;
  let bottom = original.y + original.height;

  if (handle === "move" || handle.includes("w")) left += dx;
  if (handle === "move" || handle.includes("e")) right += dx;
  if (handle === "move" || handle.includes("n")) top += dy;
  if (handle === "move" || handle.includes("s")) bottom += dy;

  left = Math.max(0, Math.min(width - 1, Math.round(left)));
  right = Math.max(0, Math.min(width, Math.round(right)));
  top = Math.max(0, Math.min(height - 1, Math.round(top)));
  bottom = Math.max(0, Math.min(height, Math.round(bottom)));

  if (right - left < 1) {
    if (handle === "move") right = Math.min(width, left + 1);
    else if (handle.includes("w")) left = Math.max(0, right - 1);
    else right = Math.min(width, left + 1);
  }
  if (bottom - top < 1) {
    if (handle === "move") bottom = Math.min(height, top + 1);
    else if (handle.includes("n")) top = Math.max(0, bottom - 1);
    else bottom = Math.min(height, top + 1);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function resizeDimensions(
  width: number,
  height: number,
  maxWidth?: number,
  maxHeight?: number,
  keepAspect = true,
): Size {
  if (!(width > 0) || !(height > 0)) return { width: 1, height: 1 };
  const targetWidth = Math.max(1, Math.floor(finite(maxWidth ?? width, width)));
  const targetHeight = Math.max(1, Math.floor(finite(maxHeight ?? height, height)));
  if (!keepAspect) return { width: targetWidth, height: targetHeight };
  const scale = Math.min(targetWidth / width, targetHeight / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function fitWithin(width: number, height: number, maxPixels = DEFAULT_MAX_PIXELS): Size {
  if (!(width > 0) || !(height > 0) || !(maxPixels > 0)) return { width: 1, height: 1 };
  if (width * height <= maxPixels) return { width, height };
  // Scale both axes by the same factor. Fitting each axis into a sqrt() box
  // destroys the aspect ratio of panoramas and tall images.
  const scale = Math.sqrt(maxPixels / (width * height));
  let fittedWidth = Math.max(1, Math.floor(width * scale));
  let fittedHeight = Math.max(1, Math.floor(height * scale));
  // Rounding can overshoot the budget by a few pixels; step down deterministically.
  while (fittedWidth > 1 && fittedHeight > 1 && fittedWidth * fittedHeight > maxPixels) {
    if (fittedWidth / width > fittedHeight / height) fittedWidth -= 1;
    else fittedHeight -= 1;
  }
  return { width: fittedWidth, height: fittedHeight };
}

export function isValidDocumentSize(size: Size, maxPixels = MAX_DOCUMENT_PIXELS): boolean {
  return Number.isInteger(size.width) && Number.isInteger(size.height)
    && size.width > 0 && size.height > 0 && size.width <= 20_000 && size.height <= 20_000
    && size.width * size.height <= maxPixels;
}

export function rotateDimensions(size: Size, angle: 90 | 180 | 270): Size {
  return angle === 180 ? { ...size } : { width: size.height, height: size.width };
}

export function normalizeOpacity(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

export function reorderLayers(layers: LayerInfo[], from: number, to: number): LayerInfo[] {
  if (from < 0 || from >= layers.length || to < 0 || to >= layers.length || from === to) {
    return [...layers];
  }
  const next = [...layers];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function nextLayerName(layers: LayerInfo[]): string {
  const used = new Set(layers.map((layer) => layer.name));
  for (let index = 1; ; index++) {
    const name = `Layer ${index}`;
    if (!used.has(name)) return name;
  }
}

export interface HistoryEntry<T> {
  label: string;
  value: T;
  bytes: number;
}

export class BoundedHistory<T> {
  private entries: HistoryEntry<T>[] = [];
  private cursor = -1;
  private totalBytes = 0;

  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly onDrop?: (entry: T) => void;

  constructor(options: HistoryOptions<T> = {}) {
    this.maxEntries = Math.max(1, Math.floor(finite(options.maxEntries ?? DEFAULT_HISTORY_ENTRIES, DEFAULT_HISTORY_ENTRIES)));
    this.maxBytes = Math.max(1, Math.floor(finite(options.maxBytes ?? DEFAULT_HISTORY_BYTES, DEFAULT_HISTORY_BYTES)));
    this.onDrop = options.onDrop;
  }

  private dropOldest(): void {
    const entry = this.entries.shift();
    if (!entry) return;
    this.totalBytes -= entry.bytes;
    this.cursor = Math.max(-1, this.cursor - 1);
    this.onDrop?.(entry.value);
  }

  reset(value: T, label = "Open", bytes = 0): void {
    for (const entry of this.entries) this.onDrop?.(entry.value);
    this.entries = [{ label, value, bytes }];
    this.totalBytes = bytes;
    this.cursor = 0;
  }

  push(label: string, value: T, bytes = 0): void {
    if (this.cursor < this.entries.length - 1) {
      for (const entry of this.entries.splice(this.cursor + 1)) {
        this.totalBytes -= entry.bytes;
        this.onDrop?.(entry.value);
      }
    }
    this.entries.push({ label, value, bytes });
    this.totalBytes += bytes;
    this.cursor = this.entries.length - 1;
    // Keep at least one real state even when a single snapshot exceeds the
    // budget; otherwise large images silently lose undo/redo.
    while (this.entries.length > this.maxEntries || (this.totalBytes > this.maxBytes && this.entries.length > 1)) {
      this.dropOldest();
    }
  }

  undo(): T | null {
    if (this.cursor <= 0) return null;
    this.cursor -= 1;
    return this.entries[this.cursor].value;
  }

  redo(): T | null {
    if (this.cursor >= this.entries.length - 1) return null;
    this.cursor += 1;
    return this.entries[this.cursor].value;
  }

  current(): T | null {
    return this.cursor >= 0 ? this.entries[this.cursor].value : null;
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor >= 0 && this.cursor < this.entries.length - 1;
  }

  get length(): number {
    return this.entries.length;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  clear(): void {
    for (const entry of this.entries) this.onDrop?.(entry.value);
    this.entries = [];
    this.totalBytes = 0;
    this.cursor = -1;
  }
}

export function historyOptionsForBytes(bytes: number): { maxEntries: number; maxBytes: number } {
  const usable = Math.max(0, finite(bytes, 0));
  const maxEntries = usable > 32 * 1024 * 1024 ? 2 : DEFAULT_HISTORY_ENTRIES;
  return {
    maxEntries,
    maxBytes: Math.max(DEFAULT_HISTORY_BYTES, usable * maxEntries),
  };
}

export function estimateRgbaBytes(width: number, height: number): number {
  return Math.max(0, Math.floor(finite(width, 0))) * Math.max(0, Math.floor(finite(height, 0))) * 4;
}

export interface Point {
  x: number;
  y: number;
}

export interface Measurement {
  dx: number;
  dy: number;
  distance: number;
  angle: number;
}

export function measureBetween(from: Point, to: Point): Measurement {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return {
    dx,
    dy,
    distance: Math.hypot(dx, dy),
    angle: (Math.atan2(-dy, dx) * 180) / Math.PI,
  };
}

export function snapPoint(point: Point, spacing: number, width: number, height: number): Point {
  if (!(spacing >= 1)) return { x: point.x, y: point.y };
  return {
    x: Math.max(0, Math.min(width, Math.round(point.x / spacing) * spacing)),
    y: Math.max(0, Math.min(height, Math.round(point.y / spacing) * spacing)),
  };
}

/** Constrain a shape so rectangles/ellipses stay square and lines snap to 45°. */
export function constrainShape(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy) * 2) return { x: to.x, y: from.y };
  if (Math.abs(dy) >= Math.abs(dx) * 2) return { x: from.x, y: to.y };
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: from.x + Math.sign(dx || 1) * side, y: from.y + Math.sign(dy || 1) * side };
}

/** Keep a rectangle-like shape square without collapsing shallow drags. */
export function constrainSquare(from: Point, to: Point): Point {
  const side = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  return {
    x: from.x + (Math.sign(to.x - from.x) || 1) * side,
    y: from.y + (Math.sign(to.y - from.y) || 1) * side,
  };
}

export function lineEndpoints(from: Point, to: Point): [Point, Point] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy) * 2) return [from, { x: to.x, y: from.y }];
  if (Math.abs(dy) >= Math.abs(dx) * 2) return [from, { x: from.x, y: to.y }];
  const constrained = constrainShape(from, to);
  return [from, constrained];
}

export function regularPolygonPoints(center: Point, radius: number, sides: number, rotation = -Math.PI / 2): Point[] {
  const count = Math.max(3, Math.min(24, Math.floor(finite(sides, 5))));
  const r = Math.max(0, finite(radius, 0));
  const points: Point[] = [];
  for (let index = 0; index < count; index++) {
    const angle = rotation + (index * Math.PI * 2) / count;
    points.push({ x: center.x + Math.cos(angle) * r, y: center.y + Math.sin(angle) * r });
  }
  return points;
}

export function starPoints(center: Point, outerRadius: number, innerRadius: number, points = 5): Point[] {
  const count = Math.max(3, Math.min(16, Math.floor(finite(points, 5))));
  const outer = Math.max(0, finite(outerRadius, 0));
  const inner = Math.max(0, finite(innerRadius, 0));
  const result: Point[] = [];
  for (let index = 0; index < count * 2; index++) {
    const radius = index % 2 === 0 ? outer : inner;
    const angle = -Math.PI / 2 + (index * Math.PI) / count;
    result.push({ x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
  }
  return result;
}

export function arrowHeadPoints(tip: Point, from: Point, size: number): [Point, Point] {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const s = Math.max(2, finite(size, 12));
  const backX = tip.x - ux * s;
  const backY = tip.y - uy * s;
  const spread = s * 0.5;
  return [
    { x: backX - uy * spread, y: backY + ux * spread },
    { x: backX + uy * spread, y: backY - ux * spread },
  ];
}

export const IMAGE_PATH_PATTERN = /\.(png|jpe?g|webp|svg)$/i;

export function isImagePath(path: string): boolean {
  return IMAGE_PATH_PATTERN.test(path);
}

export const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function normalizeColor(value: string | null | undefined, fallback = "#59c7d4"): string {
  return value && HEX_COLOR.test(value.trim()) ? value.trim().toLowerCase() : fallback;
}

export interface RGB { r: number; g: number; b: number }
export interface HSL { h: number; s: number; l: number }

export function hexToRgb(hex: string): RGB {
  const value = normalizeColor(hex);
  return {
    r: Number.parseInt(value.slice(1, 3), 16),
    g: Number.parseInt(value.slice(3, 5), 16),
    b: Number.parseInt(value.slice(5, 7), 16),
  };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const part = (value: number) => Math.max(0, Math.min(255, Math.round(finite(value, 0)))).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

export function rgbToHsl(r: number, g: number, b: number): HSL {
  const rn = Math.max(0, Math.min(1, r / 255));
  const gn = Math.max(0, Math.min(1, g / 255));
  const bn = Math.max(0, Math.min(1, b / 255));
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const l = (max + min) / 2;
  if (delta === 0) return { h: 0, s: 0, l: l * 100 };
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (max === rn) h = ((gn - bn) / delta) % 6;
  else if (max === gn) h = (bn - rn) / delta + 2;
  else h = (rn - gn) / delta + 4;
  h = (h * 60 + 360) % 360;
  return { h, s: s * 100, l: l * 100 };
}

export function exportExtensionForMime(mime: string): "png" | "jpg" | "webp" {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  return "png";
}

export function normalizeExportPath(path: string, mime: string): string {
  const extension = exportExtensionForMime(mime);
  if (!path || /[\\/]$/.test(path)) return `${path}untitled.${extension}`;
  if (!/\.[^./\\]+$/.test(path)) return `${path}.${extension}`;
  return path.replace(/\.[^./\\]+$/, `.${extension}`);
}

export interface AssetPreset {
  id: string;
  label: string;
  width: number;
  height: number;
}

export const ASSET_PRESETS: AssetPreset[] = [
  { id: "favicon", label: "Favicon 32×32", width: 32, height: 32 },
  { id: "icon-128", label: "App icon 128×128", width: 128, height: 128 },
  { id: "icon-256", label: "App icon 256×256", width: 256, height: 256 },
  { id: "icon-512", label: "PWA icon 512×512", width: 512, height: 512 },
  { id: "avatar", label: "Avatar 512×512", width: 512, height: 512 },
  { id: "og", label: "Social card 1200×630", width: 1200, height: 630 },
];

export interface ExportPreset {
  id: string;
  label: string;
  suffix: string;
  width: number | null;
  height: number | null;
  mime: "image/png" | "image/jpeg" | "image/webp";
  quality: number;
}

export const EXPORT_PRESETS: ExportPreset[] = [
  { id: "source", label: "Source resolution (PNG)", suffix: "-edited", width: null, height: null, mime: "image/png", quality: 100 },
  { id: "web", label: "Web asset (WebP 90)", suffix: "-web", width: null, height: null, mime: "image/webp", quality: 90 },
  { id: "photo", label: "Photo (JPEG 88)", suffix: "-photo", width: null, height: null, mime: "image/jpeg", quality: 88 },
  { id: "favicon", label: "Favicon 32×32 PNG", suffix: "-32", width: 32, height: 32, mime: "image/png", quality: 100 },
  { id: "avatar", label: "Avatar 512×512 PNG", suffix: "-avatar", width: 512, height: 512, mime: "image/png", quality: 100 },
  { id: "og", label: "Social card 1200×630 PNG", suffix: "-card", width: 1200, height: 630, mime: "image/png", quality: 100 },
];
