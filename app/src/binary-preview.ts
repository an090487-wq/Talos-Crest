//! Read-only hex/strings preview for files that are not UTF-8 text.

import {
  binarySummary,
  extractPrintableStrings,
  formatHexDump,
  formatSize,
  formatStrings,
  HEX_PAGE_BYTES,
} from "./binary-view";
import { fileNameFromPath, readBinaryPreview } from "./platform";

const $ = (id: string) => document.getElementById(id)!;

let currentPath = "";
let offset = 0;
let mode: "hex" | "strings" = "hex";
let wired = false;

function setControls(pages: number, page: number): void {
  const paging = mode === "hex";
  ($("binary-prev") as HTMLButtonElement).disabled = !paging || offset <= 0;
  ($("binary-next") as HTMLButtonElement).disabled =
    !paging || offset + HEX_PAGE_BYTES >= (pages - 1) * HEX_PAGE_BYTES;
  $("binary-page").textContent = mode === "strings" ? "all" : `${page} / ${pages}`;
  $("binary-mode-hex").setAttribute("aria-pressed", String(mode === "hex"));
  $("binary-mode-strings").setAttribute("aria-pressed", String(mode === "strings"));
}

async function render(): Promise<void> {
  if (!currentPath) return;
  const name = fileNameFromPath(currentPath);
  const view = $("binary-view");
  try {
    if (mode === "hex") {
      const preview = await readBinaryPreview(currentPath, offset, HEX_PAGE_BYTES);
      const summary = binarySummary(name, preview.size);
      $("binary-name").textContent = name;
      $("binary-meta").textContent =
        `${summary.label} · ${summary.size} · offset ${offset.toLocaleString()} · ${summary.hint}`;
      view.textContent = formatHexDump(preview.bytes, offset).join("\n") || "(empty file)";
      const pages = Math.max(1, Math.ceil(preview.size / HEX_PAGE_BYTES));
      setControls(pages, Math.floor(offset / HEX_PAGE_BYTES) + 1);
      return;
    }

    const preview = await readBinaryPreview(currentPath, 0, 64 * 1024);
    const summary = binarySummary(name, preview.size);
    $("binary-name").textContent = name;
    $("binary-meta").textContent =
      `${summary.label} · ${summary.size} · printable strings from the first ${formatSize(preview.bytes.length)} · ${summary.hint}`;
    const strings = extractPrintableStrings(preview.bytes, 0, 4, 500);
    view.textContent = formatStrings(strings).join("\n") || "No printable strings found.";
    setControls(1, 1);
  } catch (error) {
    $("binary-name").textContent = name;
    $("binary-meta").textContent = `Could not read this file: ${String(error)}`;
    view.textContent = "";
    setControls(1, 1);
  }
}

function wire(): void {
  if (wired) return;
  wired = true;
  $("binary-close").addEventListener("click", () => {
    ($("binary-dialog") as HTMLDialogElement).close();
  });
  $("binary-mode-hex").addEventListener("click", () => {
    mode = "hex";
    void render();
  });
  $("binary-mode-strings").addEventListener("click", () => {
    mode = "strings";
    void render();
  });
  $("binary-prev").addEventListener("click", () => {
    offset = Math.max(0, offset - HEX_PAGE_BYTES);
    void render();
  });
  $("binary-next").addEventListener("click", () => {
    offset += HEX_PAGE_BYTES;
    void render();
  });
}

/** Open a binary file in the read-only preview instead of rejecting it. */
export async function openBinaryUi(path: string): Promise<void> {
  currentPath = path;
  offset = 0;
  mode = "hex";
  wire();
  const dialog = $("binary-dialog") as HTMLDialogElement;
  if (!dialog.open) dialog.showModal();
  await render();
}

export function isBinaryPreviewOpen(): boolean {
  return ($("binary-dialog") as HTMLDialogElement | null)?.open ?? false;
}
