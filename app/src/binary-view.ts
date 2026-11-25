//! Pure helpers for the read-only binary preview. No DOM or Tauri calls here so
//! the formatting can be tested directly.

export const HEX_PAGE_BYTES = 4096;
export const HEX_BYTES_PER_LINE = 16;

/** True while another full hex page can be reached. */
export function nextPageEnabled(offset: number, size: number): boolean {
  if (!Number.isFinite(offset) || !Number.isFinite(size) || size <= 0) return false;
  return offset >= 0 && offset + HEX_PAGE_BYTES < size;
}

export interface BinaryString {
  offset: number;
  text: string;
}

export interface BinarySummary {
  label: string;
  size: string;
  hint: string;
}

const PRINTABLE_MIN = 0x20;
const PRINTABLE_MAX = 0x7e;

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function binaryLabel(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pyc") || lower.endsWith(".pyo")) return "Python bytecode";
  if (lower.endsWith(".class")) return "Java bytecode";
  if (lower.endsWith(".wasm")) return "WebAssembly module";
  if (/\.(exe|dll|so|dylib|o|a|lib|bin)$/.test(lower)) return "Executable or library";
  if (/\.(zip|jar|whl|tar|gz|7z|rar)$/.test(lower)) return "Archive";
  if (/\.(db|sqlite|sqlite3|mdb)$/.test(lower)) return "Database file";
  if (/\.(woff2?|ttf|otf|eot)$/.test(lower)) return "Font file";
  return "Binary data";
}

export function binarySummary(name: string, size: number): BinarySummary {
  const label = binaryLabel(name);
  const hints: Record<string, string> = {
    "Python bytecode": "Compiled Python module. The Strings tab shows module paths and names embedded in it.",
    "Java bytecode": "Compiled Java class. The Strings tab shows class and member names.",
    "WebAssembly module": "Compiled WebAssembly binary.",
    "Executable or library": "Compiled native code. Hex and printable strings are shown read-only.",
    Archive: "Compressed container. Hex and printable strings are shown read-only.",
    "Database file": "Binary database. Open it with a database tool for structured access.",
    "Font file": "Binary font. Use a font tool for structured access.",
  };
  return {
    label,
    size: formatSize(size),
    hint: hints[label] ?? "This file is not UTF-8 text, so it is shown read-only as hex and printable strings.",
  };
}

/** Format one bounded chunk as offset/hex/ASCII lines. */
export function formatHexDump(
  bytes: Uint8Array,
  baseOffset: number,
  bytesPerLine = HEX_BYTES_PER_LINE
): string[] {
  const width = Math.max(1, Math.min(64, bytesPerLine));
  const lines: string[] = [];
  for (let start = 0; start < bytes.length; start += width) {
    const slice = bytes.subarray(start, Math.min(start + width, bytes.length));
    const hexParts: string[] = [];
    const asciiParts: string[] = [];
    for (const byte of slice) {
      hexParts.push(byte.toString(16).padStart(2, "0"));
      asciiParts.push(byte >= PRINTABLE_MIN && byte <= PRINTABLE_MAX
        ? String.fromCharCode(byte)
        : ".");
    }
    const hex = hexParts.join(" ").padEnd(width * 3 - 1, " ");
    const offset = (baseOffset + start).toString(16).padStart(8, "0");
    lines.push(`${offset}  ${hex}  |${asciiParts.join("")}|`);
  }
  return lines;
}

/** Collect bounded runs of printable ASCII, with their absolute offsets. */
export function extractPrintableStrings(
  bytes: Uint8Array,
  baseOffset: number,
  minLength = 4,
  limit = 500
): BinaryString[] {
  const result: BinaryString[] = [];
  const minimum = Math.max(1, minLength);
  let start = -1;
  for (let index = 0; index <= bytes.length; index++) {
    const byte = index < bytes.length ? bytes[index] : 0;
    const printable = byte >= PRINTABLE_MIN && byte <= PRINTABLE_MAX;
    if (printable && start < 0) start = index;
    if (!printable && start >= 0) {
      const length = index - start;
      if (length >= minimum) {
        result.push({
          offset: baseOffset + start,
          text: String.fromCharCode(...bytes.subarray(start, index)),
        });
        if (result.length >= limit) return result;
      }
      start = -1;
    }
  }
  return result;
}

export function formatStrings(strings: BinaryString[]): string[] {
  return strings.map(({ offset, text }) => `${offset.toString(16).padStart(8, "0")}  ${text}`);
}
