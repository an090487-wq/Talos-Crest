// PDF reader pane (pdf.js). Pages render to a canvas; no text search yet.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { fileNameFromPath, readBytes } from "./platform";
import { getWindowValue, setWindowValue } from "./window-state";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let doc: any = null;
let pdfPath: string | null = null;
let pageNum = 1;
let zoom = 1.2;
let fitMode = true;
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
  const pageInput = $("pdf-page") as HTMLInputElement;
  pageInput.value = String(pageNum);
  pageInput.max = String(doc.numPages);
  $("pdf-total").textContent = "/ " + doc.numPages;
  ($("pdf-prev") as HTMLButtonElement).disabled = pageNum <= 1;
  ($("pdf-next") as HTMLButtonElement).disabled = pageNum >= doc.numPages;
  if (pdfPath) {
    setWindowValue("talos.pdf-position:" + pdfPath, JSON.stringify({ page: pageNum, zoom }));
  }
}

function fitToPane() {
  if (!doc) return;
  void doc
    .getPage(pageNum)
    .then((page: { getViewport(options: { scale: number }): { width: number; height: number } }) => {
      const viewport = page.getViewport({ scale: 1 });
      const available = $("pdf-view").clientWidth - 40;
      if (available <= 0) return;
      zoom = Math.min(Math.max(available / viewport.width, 0.3), 2);
      fitMode = true;
      schedule();
    })
    .catch(() => undefined);
}

export function isPdfFocused(): boolean {
  return $("main").classList.contains("pdf-focused");
}

function setPdfFocused(focused: boolean, persist = true) {
  if (persist) setWindowValue("talos.pdf-focus", String(focused));
  $("main").classList.toggle("pdf-focused", focused);
  const button = $("pdf-focus") as HTMLButtonElement;
  button.setAttribute("aria-pressed", String(focused));
  button.textContent = focused ? "Side" : "Focus";
  button.title = focused
    ? "Show the PDF beside the editor"
    : "Use the whole editor area for this PDF";
  button.setAttribute("aria-label", button.title);
  document.dispatchEvent(new Event("talos:pdf-focus-change"));
}

export async function openPdf(path: string) {
  const buf = await readBytes(path);
  if (doc) await doc.destroy();
  doc = await pdfjs.getDocument({ data: buf }).promise;
  pageNum = 1;
  zoom = 1.2;
  fitMode = true;
  pdfPath = path;
  const saved = getWindowValue("talos.pdf-position:" + path);
  if (saved) {
    try {
      const position: unknown = JSON.parse(saved);
      if (typeof position === "object" && position !== null) {
        const values = position as { page?: unknown; zoom?: unknown };
        if (typeof values.page === "number" && Number.isFinite(values.page)) {
          pageNum = Math.min(Math.max(Math.floor(values.page), 1), doc.numPages);
        }
        if (typeof values.zoom === "number" && Number.isFinite(values.zoom)) {
          zoom = Math.min(Math.max(values.zoom, 0.3), 5);
          fitMode = false;
        }
      }
    } catch (error) {
      console.warn("Ignoring an invalid saved PDF position.", error);
    }
  }
  $("pdf-name").textContent = fileNameFromPath(path);
  // The startup path is shared by text and PDF documents; saving it here lets
  // the last PDF reopen after a restart.
  setWindowValue("talos.open-file", path);
  $("pdf-pane").classList.remove("hidden");
  // Remember the chosen arrangement; side-by-side is the default so code,
  // Ollama and the PDF can all stay visible together.
  setPdfFocused(getWindowValue("talos.pdf-focus") === "true", false);
  document.dispatchEvent(new Event("talos:side-pane-change"));
  requestAnimationFrame(() => (fitMode ? fitToPane() : schedule()));
}

export function closePdf() {
  if (doc) void doc.destroy();
  doc = null;
  setPdfFocused(false, false);
  $("pdf-pane").classList.add("hidden");
  document.dispatchEvent(new Event("talos:side-pane-change"));
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
    fitMode = false;
    schedule();
  });
  $("pdf-zout").addEventListener("click", () => {
    zoom = Math.max(zoom / 1.2, 0.3);
    fitMode = false;
    schedule();
  });
  $("pdf-fit").addEventListener("click", fitToPane);
  $("pdf-focus").addEventListener("click", () => {
    setPdfFocused(!isPdfFocused());
    if (fitMode) requestAnimationFrame(fitToPane);
  });
  $("pdf-dark").addEventListener("click", () => {
    const dark = $("pdf-view").classList.toggle("dark");
    setWindowValue("talos.pdf-dark", String(dark));
  });
  if (getWindowValue("talos.pdf-dark") === "true") $("pdf-view").classList.add("dark");
  $("pdf-close").addEventListener("click", closePdf);
  $("pdf-page").addEventListener("change", () => {
    if (!doc) return;
    const n = parseInt(($("pdf-page") as HTMLInputElement).value, 10);
    if (!Number.isNaN(n)) {
      pageNum = Math.min(Math.max(n, 1), doc.numPages);
      schedule();
    }
  });
  document.addEventListener("talos:side-pane-resize", () => {
    if (fitMode) requestAnimationFrame(fitToPane);
  });
  window.addEventListener("resize", () => {
    if (fitMode) requestAnimationFrame(fitToPane);
  });
}
