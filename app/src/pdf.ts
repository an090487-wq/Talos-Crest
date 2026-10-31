// PDF reader pane (pdf.js). Pages render to a canvas; no text search yet.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { fileNameFromPath, readBytes } from "./platform";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let doc: any = null;
let pageNum = 1;
let zoom = 1.2;
let want = 0;
let chain: Promise<void> = Promise.resolve();

const $ = (id: string) => document.getElementById(id)!;

// Only the newest request renders; renders never overlap.
function schedule() {
  const id = ++want;
  chain = chain.then(() => (id === want ? render() : undefined)).catch(() => undefined);
}

async function render() {
  if (!doc) return;
  const page = await doc.getPage(pageNum);
  const dpr = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: zoom * dpr });
  const canvas = $("pdf-canvas") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = Math.floor(viewport.width / dpr) + "px";
  canvas.style.height = Math.floor(viewport.height / dpr) + "px";
  await page.render({ canvasContext: ctx, viewport }).promise;
  ($("pdf-page") as HTMLInputElement).value = String(pageNum);
  $("pdf-total").textContent = "/ " + doc.numPages;
}

export async function openPdf(path: string) {
  const buf = await readBytes(path);
  if (doc) await doc.destroy();
  doc = await pdfjs.getDocument({ data: buf }).promise;
  pageNum = 1;
  $("pdf-name").textContent = fileNameFromPath(path);
  $("pdf-pane").classList.remove("hidden");
  schedule();
}

function closePdf() {
  if (doc) void doc.destroy();
  doc = null;
  $("pdf-pane").classList.add("hidden");
}

export function initPdfPane() {
  $("pdf-prev").addEventListener("click", () => {
    if (doc && pageNum > 1) {
      pageNum--;
      schedule();
    }
  });
  $("pdf-next").addEventListener("click", () => {
    if (doc && pageNum < doc.numPages) {
      pageNum++;
      schedule();
    }
  });
  $("pdf-zin").addEventListener("click", () => {
    zoom = Math.min(zoom * 1.2, 5);
    schedule();
  });
  $("pdf-zout").addEventListener("click", () => {
    zoom = Math.max(zoom / 1.2, 0.3);
    schedule();
  });
  $("pdf-fit").addEventListener("click", async () => {
    if (!doc) return;
    const page = await doc.getPage(pageNum);
    const vp = page.getViewport({ scale: 1 });
    zoom = Math.max(($("pdf-view").clientWidth - 40) / vp.width, 0.3);
    schedule();
  });
  $("pdf-dark").addEventListener("click", () => {
    $("pdf-view").classList.toggle("dark");
  });
  $("pdf-close").addEventListener("click", closePdf);
  $("pdf-page").addEventListener("change", () => {
    if (!doc) return;
    const n = parseInt(($("pdf-page") as HTMLInputElement).value, 10);
    if (!Number.isNaN(n)) {
      pageNum = Math.min(Math.max(n, 1), doc.numPages);
      schedule();
    }
  });
}
