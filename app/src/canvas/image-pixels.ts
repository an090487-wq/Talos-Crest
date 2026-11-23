// DOM-free pixel processing shared by the OffscreenCanvas worker and the
// main-thread fallback. Keeping one implementation guarantees that grading and
// filters look identical on both paths, and lets the rules be unit-tested.

export interface PixelImage {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

export type FilterName = "grayscale" | "sepia" | "invert" | "blur" | "sharpen" | "warm" | "cool" | "vintage" | "noir";

export interface Grading {
  brightness: number;
  contrast: number;
  saturation: number;
  exposure: number;
  temperature: number;
  tint: number;
  highlights: number;
  shadows: number;
  vibrance: number;
  hue: number;
  gamma: number;
}

export const NEUTRAL_GRADING: Grading = {
  brightness: 0, contrast: 0, saturation: 0, exposure: 0,
  temperature: 0, tint: 0, highlights: 0, shadows: 0,
  vibrance: 0, hue: 0, gamma: 0,
};

export const GRADING_KEYS = Object.keys(NEUTRAL_GRADING) as Array<keyof Grading>;
export const BLUR_CSS = "blur(1.5px)";

const clamp = (value: number, low: number, high: number) => (value < low ? low : value > high ? high : value);
const finite = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);

export function normalizeGrading(value: Partial<Grading> | null | undefined): Grading {
  const source = value ?? {};
  const result = { ...NEUTRAL_GRADING };
  for (const key of GRADING_KEYS) {
    const limit = key === "hue" ? 180 : 100;
    result[key] = clamp(finite(source[key] ?? 0, 0), -limit, limit);
  }
  return result;
}

export function isNeutralGrading(value: Partial<Grading> | null | undefined): boolean {
  const grading = normalizeGrading(value);
  return GRADING_KEYS.every((key) => grading[key] === 0);
}

/** Photographic exposure: -100 → 0.25× (-2 EV), +100 → 4× (+2 EV). */
export function exposureMultiplier(value: number): number {
  return Math.pow(2, clamp(finite(value, 0), -100, 100) / 50);
}

function luma(r: number, g: number, b: number): number {
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

export function applyGrading(image: PixelImage, value: Partial<Grading> | null | undefined): PixelImage {
  const grading = normalizeGrading(value);
  const width = Math.max(0, Math.floor(image.width));
  const height = Math.max(0, Math.floor(image.height));
  const output = new Uint8ClampedArray(image.data.length);
  const gammaPow = 1 / Math.pow(2, grading.gamma / 100);
  const gammaLut = new Float32Array(256);
  for (let index = 0; index < 256; index++) gammaLut[index] = 255 * Math.pow(index / 255, gammaPow);
  const light = exposureMultiplier(grading.exposure);
  const bright = grading.brightness * 2.55;
  const contrast = 1 + grading.contrast / 100;
  const temp = grading.temperature / 100;
  const tint = grading.tint / 100;
  const redGain = Math.max(0, 1 + temp * 0.25 + tint * 0.08);
  const greenGain = Math.max(0, 1 + temp * 0.04 - tint * 0.2);
  const blueGain = Math.max(0, 1 - temp * 0.25 + tint * 0.08);
  const highlightAmount = grading.highlights * 1.2;
  const shadowAmount = grading.shadows * 1.2;
  const satAmount = grading.saturation / 100;
  const vibAmount = (grading.vibrance / 100) * 0.8;
  const hueRadians = (grading.hue * Math.PI) / 180;
  const rotate = grading.hue !== 0;
  const cos = Math.cos(hueRadians);
  const sin = Math.sin(hueRadians);
  const hueMatrix = [
    0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928,
    0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.140, 0.072 - cos * 0.072 - sin * 0.283,
    0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072,
  ];
  const source = image.data;

  for (let index = 0; index < width * height; index++) {
    const offset = index * 4;
    let r = gammaLut[source[offset]] * light + bright;
    let g = gammaLut[source[offset + 1]] * light + bright;
    let b = gammaLut[source[offset + 2]] * light + bright;
    r = (r - 127.5) * contrast + 127.5;
    g = (g - 127.5) * contrast + 127.5;
    b = (b - 127.5) * contrast + 127.5;
    r *= redGain;
    g *= greenGain;
    b *= blueGain;

    const luminance = luma(r, g, b) / 255;
    const shadowWeight = (1 - luminance) * (1 - luminance);
    const highlightWeight = luminance * luminance;
    const tone = shadowAmount * shadowWeight + highlightAmount * highlightWeight;
    r += tone;
    g += tone;
    b += tone;

    const grey = luma(r, g, b);
    const max = Math.max(r, g, b);
    const currentSaturation = max > 0 ? (max - Math.min(r, g, b)) / max : 0;
    const saturation = clamp(1 + satAmount + vibAmount * (1 - currentSaturation), 0, 2.5);
    r = grey + (r - grey) * saturation;
    g = grey + (g - grey) * saturation;
    b = grey + (b - grey) * saturation;

    if (rotate) {
      const hr = hueMatrix[0] * r + hueMatrix[1] * g + hueMatrix[2] * b;
      const hg = hueMatrix[3] * r + hueMatrix[4] * g + hueMatrix[5] * b;
      const hb = hueMatrix[6] * r + hueMatrix[7] * g + hueMatrix[8] * b;
      r = hr;
      g = hg;
      b = hb;
    }

    output[offset] = clamp(r, 0, 255);
    output[offset + 1] = clamp(g, 0, 255);
    output[offset + 2] = clamp(b, 0, 255);
    output[offset + 3] = source[offset + 3];
  }
  return { width, height, data: output };
}

/** Small deterministic blur used when a browser has no ctx.filter support. */
export function boxBlurPixels(image: PixelImage): PixelImage {
  const width = Math.max(0, Math.floor(image.width));
  const height = Math.max(0, Math.floor(image.height));
  const source = image.data;
  const output = new Uint8ClampedArray(source.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.max(0, Math.min(height - 1, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.max(0, Math.min(width - 1, x + dx));
          const offset = (yy * width + xx) * 4;
          r += source[offset];
          g += source[offset + 1];
          b += source[offset + 2];
          count += 1;
        }
      }
      const offset = (y * width + x) * 4;
      output[offset] = r / count;
      output[offset + 1] = g / count;
      output[offset + 2] = b / count;
      output[offset + 3] = source[offset + 3];
    }
  }
  return { width, height, data: output };
}

export function sharpenPixels(image: PixelImage): PixelImage {
  const width = Math.max(0, Math.floor(image.width));
  const height = Math.max(0, Math.floor(image.height));
  const output = new Uint8ClampedArray(image.data);
  if (width < 3 || height < 3) return { width, height, data: output };
  const source = image.data;
  const kernel = [0, -1, 0, -1, 5, -1, 0, -1, 0];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            sum += source[((y + ky) * width + x + kx) * 4 + channel] * kernel[(ky + 1) * 3 + kx + 1];
          }
        }
        output[(y * width + x) * 4 + channel] = sum;
      }
    }
  }
  return { width, height, data: output };
}

const SEPIA: ReadonlyArray<number> = [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131];

export function applyFilter(image: PixelImage, filter: FilterName): PixelImage {
  if (filter === "sharpen") return sharpenPixels(image);
  const width = Math.max(0, Math.floor(image.width));
  const height = Math.max(0, Math.floor(image.height));
  const output = new Uint8ClampedArray(image.data.length);
  const source = image.data;
  const grade = (r: number, g: number, b: number): [number, number, number] => {
    switch (filter) {
      case "grayscale": {
        const value = luma(r, g, b);
        return [value, value, value];
      }
      case "sepia":
        return [
          SEPIA[0] * r + SEPIA[1] * g + SEPIA[2] * b,
          SEPIA[3] * r + SEPIA[4] * g + SEPIA[5] * b,
          SEPIA[6] * r + SEPIA[7] * g + SEPIA[8] * b,
        ];
      case "invert":
        return [255 - r, 255 - g, 255 - b];
      case "warm":
        return [Math.min(255, r * 1.12 + 8), g, Math.max(0, b * 0.86 - 4)];
      case "cool":
        return [Math.max(0, r * 0.88 - 4), g, Math.min(255, b * 1.14 + 8)];
      case "vintage":
        return [
          Math.min(255, r * 0.95 + g * 0.12 + b * 0.05 + 12),
          Math.min(255, g * 0.92 + b * 0.08 + 6),
          Math.min(255, b * 0.72 + 14),
        ];
      case "noir": {
        const value = Math.pow(luma(r, g, b) / 255, 0.85) * 255;
        return [value, value, value];
      }
      default:
        return [r, g, b];
    }
  };
  for (let index = 0; index < width * height; index++) {
    const offset = index * 4;
    const [r, g, b] = grade(source[offset], source[offset + 1], source[offset + 2]);
    output[offset] = clamp(r, 0, 255);
    output[offset + 1] = clamp(g, 0, 255);
    output[offset + 2] = clamp(b, 0, 255);
    output[offset + 3] = source[offset + 3];
  }
  return { width, height, data: output };
}

const hexPart = (value: number) => clamp(Math.round(finite(value, 0)), 0, 255).toString(16).padStart(2, "0");

export function pixelHex(r: number, g: number, b: number): string {
  return `#${hexPart(r)}${hexPart(g)}${hexPart(b)}`;
}

/** Median-cut style bucket sampling: bounded work, no dependency on the DOM. */
export function extractPalette(image: PixelImage, count = 6): string[] {
  const wanted = Math.max(1, Math.min(12, Math.floor(finite(count, 6))));
  const width = Math.max(0, Math.floor(image.width));
  const height = Math.max(0, Math.floor(image.height));
  const total = width * height;
  if (!total) return [];
  const step = Math.max(1, Math.floor(total / 120_000));
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  for (let index = 0; index < total; index += step) {
    const offset = index * 4;
    if (image.data[offset + 3] < 8) continue;
    const r = image.data[offset];
    const g = image.data[offset + 1];
    const b = image.data[offset + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
    } else {
      buckets.set(key, { count: 1, r, g, b });
    }
  }
  const ranked = [...buckets.values()].sort((a, b) => b.count - a.count);
  const colors: Array<[number, number, number]> = [];
  for (const bucket of ranked) {
    const rgb: [number, number, number] = [bucket.r / bucket.count, bucket.g / bucket.count, bucket.b / bucket.count];
    const tooClose = colors.some(([r, g, b]) =>
      Math.abs(r - rgb[0]) + Math.abs(g - rgb[1]) + Math.abs(b - rgb[2]) < 60);
    if (!tooClose) colors.push(rgb);
    if (colors.length >= wanted) break;
  }
  return colors.map(([r, g, b]) => pixelHex(r, g, b));
}
