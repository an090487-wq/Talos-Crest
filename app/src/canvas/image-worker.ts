// OffscreenCanvas worker for Talos Canvas. Image processing stays off the UI
// thread; bitmaps and encoded bytes are transferred, never copied through JSON.

import { fitWithin } from "./image-core";

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

const scope = self as unknown as WorkerScope;

type FilterName = "grayscale" | "sepia" | "invert" | "blur" | "sharpen";
type Axis = "horizontal" | "vertical";

interface LayerPayload {
  bitmap: ImageBitmap;
  opacity: number;
  visible: boolean;
}

interface ProcessResult {
  bitmap?: ImageBitmap;
  bytes?: Uint8Array;
  downsampled?: boolean;
}

type CanvasRequest =
  | { id: number; type: "decode"; bytes: Uint8Array; mime: string; maxPixels: number }
  | { id: number; type: "resize"; bitmap: ImageBitmap; width: number; height: number }
  | { id: number; type: "crop"; bitmap: ImageBitmap; x: number; y: number; width: number; height: number }
  | { id: number; type: "rotate"; bitmap: ImageBitmap; angle: 90 | 180 | 270 }
  | { id: number; type: "flip"; bitmap: ImageBitmap; axis: Axis }
  | {
      id: number;
      type: "adjust";
      bitmap: ImageBitmap;
      brightness: number;
      contrast: number;
      saturation: number;
      exposure: number;
    }
  | { id: number; type: "filter"; bitmap: ImageBitmap; filter: FilterName }
  | { id: number; type: "encode"; bitmap: ImageBitmap; mime: string; quality: number }
  | { id: number; type: "flatten"; layers: LayerPayload[]; width: number; height: number };

function context(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser could not create a 2D canvas context.");
  return ctx;
}

function canvasFor(width: number, height: number): OffscreenCanvas {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error("Invalid image dimensions.");
  }
  return new OffscreenCanvas(Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)));
}

function sharpen(ctx: OffscreenCanvasRenderingContext2D, width: number, height: number): void {
  const image = ctx.getImageData(0, 0, width, height);
  const source = image.data;
  const output = new Uint8ClampedArray(source);
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
  image.data.set(output);
  ctx.putImageData(image, 0, 0);
}

async function decode(request: Extract<CanvasRequest, { type: "decode" }>): Promise<ProcessResult> {
  const blob = new Blob([request.bytes as BlobPart], { type: request.mime || "image/png" });
  const bitmap = await createImageBitmap(blob);
  const fitted = fitWithin(bitmap.width, bitmap.height, request.maxPixels);
  if (fitted.width === bitmap.width && fitted.height === bitmap.height) {
    return { bitmap, downsampled: false };
  }
  const resized = await createImageBitmap(bitmap, {
    resizeWidth: fitted.width,
    resizeHeight: fitted.height,
  });
  bitmap.close();
  return { bitmap: resized, downsampled: true };
}

async function encode(request: Extract<CanvasRequest, { type: "encode" }>): Promise<ProcessResult> {
  const canvas = canvasFor(request.bitmap.width, request.bitmap.height);
  try {
    const ctx = context(canvas);
    ctx.drawImage(request.bitmap, 0, 0);
    let blob: Blob;
    try {
      blob = await canvas.convertToBlob({ type: request.mime, quality: request.quality });
    } catch {
      blob = await canvas.convertToBlob({ type: "image/png" });
    }
    return { bytes: new Uint8Array(await blob.arrayBuffer()) };
  } finally {
    request.bitmap.close();
  }
}

function process(request: CanvasRequest): ProcessResult {
  switch (request.type) {
    case "decode":
      throw new Error("Decode requests are handled asynchronously.");
    case "resize": {
      const canvas = canvasFor(request.width, request.height);
      try {
        const ctx = context(canvas);
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(request.bitmap, 0, 0, request.width, request.height);
        return { bitmap: canvas.transferToImageBitmap() };
      } finally {
        request.bitmap.close();
      }
    }
    case "crop": {
      const canvas = canvasFor(request.width, request.height);
      try {
        const ctx = context(canvas);
        ctx.drawImage(
          request.bitmap,
          request.x, request.y, request.width, request.height,
          0, 0, request.width, request.height,
        );
        return { bitmap: canvas.transferToImageBitmap() };
      } finally {
        request.bitmap.close();
      }
    }
    case "rotate": {
      const swaps = request.angle === 180;
      const width = swaps ? request.bitmap.width : request.bitmap.height;
      const height = swaps ? request.bitmap.height : request.bitmap.width;
      const canvas = canvasFor(width, height);
      try {
        const ctx = context(canvas);
        ctx.translate(width / 2, height / 2);
        ctx.rotate((request.angle * Math.PI) / 180);
        ctx.drawImage(request.bitmap, -request.bitmap.width / 2, -request.bitmap.height / 2);
        return { bitmap: canvas.transferToImageBitmap() };
      } finally {
        request.bitmap.close();
      }
    }
    case "flip": {
      const canvas = canvasFor(request.bitmap.width, request.bitmap.height);
      try {
        const ctx = context(canvas);
        if (request.axis === "horizontal") {
          ctx.translate(canvas.width, 0);
          ctx.scale(-1, 1);
        } else {
          ctx.translate(0, canvas.height);
          ctx.scale(1, -1);
        }
        ctx.drawImage(request.bitmap, 0, 0);
        return { bitmap: canvas.transferToImageBitmap() };
      } finally {
        request.bitmap.close();
      }
    }
    case "adjust": {
      const { brightness, contrast, saturation, exposure } = request;
      const canvas = canvasFor(request.bitmap.width, request.bitmap.height);
      try {
        const ctx = context(canvas);
        const light = Math.max(0.1, Math.min(3, 1 + brightness / 100 + exposure));
        const contrastValue = Math.max(0, Math.min(3, 1 + contrast / 100));
        const saturationValue = Math.max(0, Math.min(3, 1 + saturation / 100));
        ctx.filter = `brightness(${light}) contrast(${contrastValue}) saturate(${saturationValue})`;
        ctx.drawImage(request.bitmap, 0, 0);
        return { bitmap: canvas.transferToImageBitmap() };
      } finally {
        request.bitmap.close();
      }
    }
    case "filter": {
      const canvas = canvasFor(request.bitmap.width, request.bitmap.height);
      try {
        const ctx = context(canvas);
        const filters: Record<FilterName, string> = {
          grayscale: "grayscale(1)",
          sepia: "sepia(1)",
          invert: "invert(1)",
          blur: "blur(1.5px)",
          sharpen: "none",
        };
        ctx.filter = filters[request.filter];
        ctx.drawImage(request.bitmap, 0, 0);
        if (request.filter === "sharpen") sharpen(ctx, canvas.width, canvas.height);
        return { bitmap: canvas.transferToImageBitmap() };
      } finally {
        request.bitmap.close();
      }
    }
    case "encode":
      throw new Error("Encode requests are handled asynchronously.");
    case "flatten": {
      const canvas = canvasFor(request.width, request.height);
      try {
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
    default: {
      const exhaustive: never = request;
      throw new Error(`Unsupported image operation: ${JSON.stringify(exhaustive)}`);
    }
  }
}

scope.addEventListener("message", (event: MessageEvent<CanvasRequest>) => {
  const request = event.data;
  void (async () => {
    try {
      const result = request.type === "decode"
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
      } else {
        throw new Error("The image worker returned no result.");
      }
    } catch (error) {
      scope.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
    }
  })();
});
