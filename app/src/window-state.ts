import { getCurrentWindow } from "@tauri-apps/api/window";

const windowLabel = getCurrentWindow().label;
const prefix = `talos.window.${windowLabel}.`;

export function getWindowValue(key: string): string | null {
  const scopedKey = prefix + key;
  const value = localStorage.getItem(scopedKey);
  if (value !== null || windowLabel !== "main") return value;

  const legacyValue = localStorage.getItem(key);
  if (legacyValue !== null) localStorage.setItem(scopedKey, legacyValue);
  return legacyValue;
}

export function setWindowValue(key: string, value: string): void {
  localStorage.setItem(prefix + key, value);
}

export function removeWindowValue(key: string): void {
  localStorage.removeItem(prefix + key);
  if (windowLabel === "main") localStorage.removeItem(key);
}
