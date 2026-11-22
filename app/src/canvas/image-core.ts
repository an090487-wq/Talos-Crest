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
  return resizeDimensions(width, height, Math.sqrt(maxPixels), Math.sqrt(maxPixels));
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
