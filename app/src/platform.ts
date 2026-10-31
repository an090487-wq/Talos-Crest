import { invoke } from "@tauri-apps/api/core";
import {
  readFile as fsReadFile,
  readTextFile as fsReadTextFile,
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

export async function readText(path: string): Promise<string> {
  if (await isAndroid()) return fsReadTextFile(path);
  return invoke<string>("read_file", { path });
}

export async function readBytes(path: string): Promise<Uint8Array> {
  if (await isAndroid()) return fsReadFile(path);
  return new Uint8Array(await invoke<ArrayBuffer>("read_file_bytes", { path }));
}

export async function writeText(path: string, contents: string): Promise<void> {
  if (await isAndroid()) return fsWriteTextFile(path, contents);
  await invoke("write_file", { path, contents });
}
