import { invoke } from "@tauri-apps/api/core";
import {
  exists as fsExists,
  readFile as fsReadFile,
  readTextFile as fsReadTextFile,
  writeFile as fsWriteFile,
  writeTextFile as fsWriteTextFile,
} from "@tauri-apps/plugin-fs";

let androidPromise: Promise<boolean> | undefined;

export function fileNameFromPath(path: string): string {
  if (!path.startsWith("content://")) {
    return path.split(/[\\/]/).pop() ?? path;
  }
  const encodedName = path.split(/[?#]/, 1)[0].split("/").pop() ?? path;
  let name = encodedName;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    // Keep the original URI segment if it contains malformed encoding.
  }
  return name.split("/").pop()?.split(":").pop() ?? name;
}

export function isAndroid(): Promise<boolean> {
  androidPromise ??= Promise.resolve(/Android/i.test(navigator.userAgent));
  return androidPromise;
}

export interface FileSnapshot {
  contents: string;
  revision: string;
  binary: boolean;
}

export type CheckedWriteResult =
  | { status: "saved"; revision: string | null }
  | { status: "conflict"; snapshot: FileSnapshot | null };

export async function readText(path: string): Promise<string> {
  if (await isAndroid()) return fsReadTextFile(path);
  return invoke<string>("read_file", { path });
}

export async function readFileSnapshot(path: string): Promise<FileSnapshot | null> {
  if (await isAndroid()) {
    const bytes = await fsReadFile(path);
    try {
      const contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return {
        contents: contents.includes("\0") ? "" : contents,
        revision: "",
        binary: contents.includes("\0"),
      };
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return { contents: "", revision: "", binary: true };
    }
  }
  return invoke<FileSnapshot | null>("read_file_snapshot_command", { path });
}

export async function readBytes(path: string): Promise<Uint8Array> {
  if (await isAndroid()) return fsReadFile(path);
  return new Uint8Array(await invoke<ArrayBuffer>("read_file_bytes", { path }));
}

export interface BinaryPreview {
  size: number;
  bytes: Uint8Array;
}

/** Read one bounded page for the read-only binary preview. */
export async function readBinaryPreview(
  path: string,
  offset: number,
  limit: number
): Promise<BinaryPreview> {
  if (await isAndroid()) {
    const bytes = await fsReadFile(path);
    return { size: bytes.length, bytes: bytes.slice(offset, offset + limit) };
  }
  const result = await invoke<{ size: number; bytes: number[] }>("binary_preview", {
    path,
    offset,
    limit,
  });
  return { size: result.size, bytes: new Uint8Array(result.bytes) };
}

export async function writeText(
  path: string,
  contents: string,
  expectedRevision: string | null,
): Promise<CheckedWriteResult> {
  if (await isAndroid()) {
    await fsWriteTextFile(path, contents);
    return { status: "saved", revision: null };
  }
  return invoke<CheckedWriteResult>("write_file_checked", {
    path,
    contents,
    expectedRevision,
  });
}

function toBase64(bytes: Uint8Array): string {
  const chunkSize = 0x2000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/** Binary export for Canvas. Originals are preserved unless overwrite is explicit. */
export async function writeBytes(path: string, bytes: Uint8Array, overwrite = false): Promise<void> {
  if (await isAndroid()) {
    if (!overwrite && (await fsExists(path))) {
      throw new Error("That file already exists. Choose a new name or confirm an explicit overwrite.");
    }
    await fsWriteFile(path, bytes);
    return;
  }
  await invoke("write_file_bytes", { path, contents: toBase64(bytes), overwrite });
}
