// OffscreenCanvas worker for Talos Canvas. Image processing stays off the UI
// thread; bitmaps and encoded bytes are transferred, never copied through JSON.
// All pixel math comes from image-pixels.ts so the fallback cannot drift.

import { fitWithin, MAX_DOCUMENT_PIXELS } from "./image-core";
import { applyFilter, applyGrading, BLUR_CSS, boxBlurPixels, extractPalette } from "./image-pixels";
import type { ImageRequest, WorkerRequest } from "./image-requests";

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

const scope = self as unknown as WorkerScope;

interface ProcessResult {
  bitmap?: ImageBitmap;
  bytes?: Uint8Array;
  colors?: string[];
  downsampled?: boolean;
}

function context(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser could not create a 2D canvas context.");
  return ctx;
}

function canvasFor(width: number, height: number): OffscreenCanvas {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error("Invalid image dimensions.");
  }
  if (width * height > MAX_DOCUMENT_PIXELS) throw new Error("The image is too large to process safely.");
  return new OffscreenCanvas(Math.floor(width), Math.floor(height));
}

function validateBitmap(bitmap: ImageBitmap): void {
  if (!(bitmap.width > 0) || !(bitmap.height > 0) || bitmap.width * bitmap.height > MAX_DOCUMENT_PIXELS) {
    throw new Error("The image has invalid dimensions.");
  }
}

/** Always release a transferred bitmap, even when validation or allocation fails. */
function withBitmap<T>(bitmap: ImageBitmap, work: (source: ImageBitmap) => T): T {
  try {
    return work(bitmap);
  } finally {
    bitmap.close();
  }
}

async function decode(request: Extract<ImageRequest, { type: "decode" }>): Promise<ProcessResult> {
  let bitmap: ImageBitmap | null = null;
  try {
    const blob = new Blob([request.bytes as BlobPart], { type: request.mime || "image/png" });
    try {
      bitmap = await createImageBitmap(blob);
    } catch {
      // SVG is rasterized by the main-thread fallback (it needs an <img> element).
      throw new Error("This format cannot be decoded in the image worker.");
    }
    validateBitmap(bitmap);
    const fitted = fitWithin(bitmap.width, bitmap.height, request.maxPixels);
    if (fitted.width === bitmap.width && fitted.height === bitmap.height) {
      const result = bitmap;
      bitmap = null;
      return { bitmap: result, downsampled: false };
    }
    const resized = await createImageBitmap(bitmap, {
      resizeWidth: fitted.width,
      resizeHeight: fitted.height,
      resizeQuality: "high",
    });
    return { bitmap: resized, downsampled: true };
  } finally {
    bitmap?.close();
  }
}

async function encode(request: Extract<ImageRequest, { type: "encode" }>): Promise<ProcessResult> {
  const bitmap = request.bitmap;
  try {
    const canvas = canvasFor(bitmap.width, bitmap.height);
    const ctx = context(canvas);
    // JPEG has no alpha channel; an explicit matte prevents black fringes.
    if (request.mime === "image/jpeg") {
      const background = request.background && /^#[0-9a-f]{6}$/i.test(request.background)
        ? request.background : "#ffffff";
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: request.mime, quality: request.quality });
    if (blob.type !== request.mime) {
      throw new Error(`${request.mime} export is not supported by this browser. Choose PNG instead.`);
    }
    return { bytes: new Uint8Array(await blob.arrayBuffer()) };
  } finally {
    bitmap.close();
  }
}

function pixels(ctx: OffscreenCanvasRenderingContext2D, width: number, height: number) {
  return ctx.getImageData(0, 0, width, height);
}

function process(request: ImageRequest): ProcessResult {
  switch (request.type) {
    case "decode":
      throw new Error("Decode requests are handled asynchronously.");
    case "resize":
      return withBitmap(request.bitmap, (bitmap) => {
        validateBitmap(bitmap);
        const canvas = canvasFor(request.width, request.height);
        const ctx = context(canvas);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bitmap, 0, 0, request.width, request.height);
        return { bitmap: canvas.transferToImageBitmap() };
      });
    case "crop":
      return withBitmap(request.bitmap, (bitmap) => {
        validateBitmap(bitmap);
        const { rect } = request;
        const canvas = canvasFor(rect.width, rect.height);
        const ctx = context(canvas);
        ctx.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
        return { bitmap: canvas.transferToImageBitmap() };
      });
    case "rotate":
      return withBitmap(request.bitmap, (bitmap) => {
        validateBitmap(bitmap);
        const swaps = request.angle === 180;
        const width = swaps ? bitmap.width : bitmap.height;
        const height = swaps ? bitmap.height : bitmap.width;
        const canvas = canvasFor(width, height);
        const ctx = context(canvas);
        ctx.translate(width / 2, height / 2);
        ctx.rotate((request.angle * Math.PI) / 180);
        ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
        return { bitmap: canvas.transferToImageBitmap() };
      });
    case "flip":
      return withBitmap(request.bitmap, (bitmap) => {
        validateBitmap(bitmap);
        const canvas = canvasFor(bitmap.width, bitmap.height);
        const ctx = context(canvas);
        if (request.axis === "horizontal") {
          ctx.translate(canvas.width, 0);
          ctx.scale(-1, 1);
        } else {
          ctx.translate(0, canvas.height);
          ctx.scale(1, -1);
        }
        ctx.drawImage(bitmap, 0, 0);
        return { bitmap: canvas.transferToImageBitmap() };
      });
    case "adjust":
      return withBitmap(request.bitmap, (bitmap) => {
        validateBitmap(bitmap);
        const canvas = canvasFor(bitmap.width, bitmap.height);
        const ctx = context(canvas);
        ctx.drawImage(bitmap, 0, 0);
        const result = applyGrading(pixels(ctx, canvas.width, canvas.height), request.grading);
        ctx.putImageData(new ImageData(result.data, result.width, result.height), 0, 0);
        return { bitmap: canvas.transferToImageBitmap() };
      });
    case "filter":
      return withBitmap(request.bitmap, (bitmap) => {
        validateBitmap(bitmap);
        const canvas = canvasFor(bitmap.width, bitmap.height);
        const ctx = context(canvas);
        if (request.filter === "blur") {
          if ("filter" in (ctx as object)) {
            ctx.filter = BLUR_CSS;
            ctx.drawImage(bitmap, 0, 0);
            ctx.filter = "none";
          } else {
            ctx.drawImage(bitmap, 0, 0);
            const blurred = boxBlurPixels(pixels(ctx, canvas.width, canvas.height));
            ctx.putImageData(new ImageData(blurred.data, blurred.width, blurred.height), 0, 0);
          }
        } else {
          ctx.drawImage(bitmap, 0, 0);
          const result = applyFilter(pixels(ctx, canvas.width, canvas.height), request.filter);
          ctx.putImageData(new ImageData(result.data, result.width, result.height), 0, 0);
        }
        return { bitmap: canvas.transferToImageBitmap() };
      });
    case "encode":
      throw new Error("Encode requests are handled asynchronously.");
    case "flatten": {
      try {
        const canvas = canvasFor(request.width, request.height);
        const ctx = context(canvas);
        for (const layer of request.layers) {
          if (!layer.visible || layer.opacity <= 0) continue;
          ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
          ctx.drawImage(layer.bitmap, 0, 0, request.width, request.height);
        }
        ctx.globalAlpha = 1;
        return { bitmap: canvas.transferToImageBitmap() };
      } finally {
        for (const layer of request.layers) layer.bitmap.close();
      }
    }
    case "palette":
      return withBitmap(request.bitmap, (bitmap) => {
        validateBitmap(bitmap);
        const fitted = fitWithin(bitmap.width, bitmap.height, 640_000);
        const canvas = canvasFor(fitted.width, fitted.height);
        const ctx = context(canvas);
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bitmap, 0, 0, fitted.width, fitted.height);
        return { colors: extractPalette(pixels(ctx, fitted.width, fitted.height), request.count) };
      });
    default: {
      const exhaustive: never = request;
      throw new Error(`Unsupported image operation: ${JSON.stringify(exhaustive)}`);
    }
  }
}

scope.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  void (async () => {
    try {
      const result: ProcessResult = request.type === "decode"
        ? await decode(request)
        : request.type === "encode"
          ? await encode(request)
          : process(request);
      if (result.bitmap) {
        scope.postMessage(
          { id: request.id, bitmap: result.bitmap, downsampled: result.downsampled },
          [result.bitmap],
        );
      } else if (result.bytes) {
        scope.postMessage({ id: request.id, bytes: result.bytes }, [result.bytes.buffer as ArrayBuffer]);
      } else if (result.colors) {
        scope.postMessage({ id: request.id, colors: result.colors });
      } else {
        throw new Error("The image worker returned no result.");
      }
    } catch (error) {
      scope.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
    }
  })();
});
