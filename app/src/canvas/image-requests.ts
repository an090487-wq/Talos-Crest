// Wire protocol shared by canvas-ui.ts and image-worker.ts. The request id is
// added by the caller, so request objects never carry a stale placeholder id.

import type { Rect } from "./image-core";
import type { FilterName, Grading } from "./image-pixels";

export type Axis = "horizontal" | "vertical";

export interface LayerPayload {
  bitmap: ImageBitmap;
  opacity: number;
  visible: boolean;
}

export type ImageRequest =
  | { type: "decode"; bytes: Uint8Array; mime: string; maxPixels: number }
  | { type: "resize"; bitmap: ImageBitmap; width: number; height: number }
  | { type: "crop"; bitmap: ImageBitmap; rect: Rect }
  | { type: "rotate"; bitmap: ImageBitmap; angle: 90 | 180 | 270 }
  | { type: "flip"; bitmap: ImageBitmap; axis: Axis }
  | { type: "adjust"; bitmap: ImageBitmap; grading: Grading }
  | { type: "filter"; bitmap: ImageBitmap; filter: FilterName }
  | { type: "encode"; bitmap: ImageBitmap; mime: string; quality: number; background: string | null }
  | { type: "flatten"; layers: LayerPayload[]; width: number; height: number }
  | { type: "palette"; bitmap: ImageBitmap; count: number };

export type WorkerRequest = ImageRequest & { id: number };

export interface WorkerResponse {
  id: number;
  bitmap?: ImageBitmap;
  bytes?: Uint8Array;
  colors?: string[];
  downsampled?: boolean;
  error?: string;
}
