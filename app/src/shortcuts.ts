// Central keyboard-shortcut registry. Keeping the key strings in one place
// means the editor keymap, the global (app-wide) handler, and the shortcuts
// dialog can never drift apart.

export type ShortcutScope = "app" | "editor";

export interface Shortcut {
  /** Stable identifier, useful for diagnostics and future customization. */
  id: string;
  /** Human-readable action name shown in the shortcuts dialog. */
  label: string;
  /** Canonical binding, for example "Mod+Shift+S" or "F5". */
  keys: string;
  /** Group heading in the shortcuts dialog. */
  group: string;
  /**
   * "editor" bindings are installed inside CodeMirror (so they can override
   * CodeMirror's own defaults); "app" bindings are handled globally. Defaults
   * to "app".
   */
  scope?: ShortcutScope;
  run?: () => void | Promise<void>;
}

export interface ShortcutEvent {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

interface ParsedShortcut {
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
  code: string;
}

const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

const codeByKey: Record<string, string> = {
  a: "KeyA",
  b: "KeyB",
  c: "KeyC",
  d: "KeyD",
  e: "KeyE",
  f: "KeyF",
  g: "KeyG",
  h: "KeyH",
  i: "KeyI",
  j: "KeyJ",
  k: "KeyK",
  l: "KeyL",
  m: "KeyM",
  n: "KeyN",
  o: "KeyO",
  p: "KeyP",
  q: "KeyQ",
  r: "KeyR",
  s: "KeyS",
  t: "KeyT",
  u: "KeyU",
  v: "KeyV",
  w: "KeyW",
  x: "KeyX",
  y: "KeyY",
  z: "KeyZ",
  "0": "Digit0",
  "1": "Digit1",
  "2": "Digit2",
  "3": "Digit3",
  "4": "Digit4",
  "5": "Digit5",
  "6": "Digit6",
  "7": "Digit7",
  "8": "Digit8",
  "9": "Digit9",
  "`": "Backquote",
  "-": "Minus",
  "=": "Equal",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  ";": "Semicolon",
  "'": "Quote",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  " ": "Space",
};

const namedCodes: Record<string, string> = {
  enter: "Enter",
  escape: "Escape",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
};

const displayKeys: Record<string, string> = {
  arrowup: "\u2191",
  arrowdown: "\u2193",
  arrowleft: "\u2190",
  arrowright: "\u2192",
  escape: "Esc",
  pageup: "PgUp",
  pagedown: "PgDn",
  enter: "Enter",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  " ": "Space",
};

export function parseShortcut(keys: string): ParsedShortcut {
  const parsed: ParsedShortcut = {
    ctrl: false,
    meta: false,
    alt: false,
    shift: false,
    key: "",
    code: "",
  };
  for (const part of keys.split("+")) {
    const token = part.trim();
    if (!token) continue;
    const lower = token.toLowerCase();
    if (lower === "mod") {
      if (isMac) parsed.meta = true;
      else parsed.ctrl = true;
    } else if (lower === "ctrl" || lower === "control") {
      parsed.ctrl = true;
    } else if (lower === "meta" || lower === "cmd" || lower === "command") {
      parsed.meta = true;
    } else if (lower === "alt" || lower === "option") {
      parsed.alt = true;
    } else if (lower === "shift") {
      parsed.shift = true;
    } else {
      parsed.key = lower;
      parsed.code = codeByKey[lower] ?? namedCodes[lower] ?? token;
    }
  }
  return parsed;
}

// Match both the logical key and the physical key code. The code fallback
// keeps shortcuts on the familiar QWERTY positions even when the OS keyboard
// layout is something else (for example a Persian or Dvorak layout).
export function matchesShortcut(event: ShortcutEvent, parsed: ParsedShortcut): boolean {
  if (
    event.ctrlKey !== parsed.ctrl ||
    event.metaKey !== parsed.meta ||
    event.altKey !== parsed.alt ||
    event.shiftKey !== parsed.shift
  ) {
    return false;
  }
  if (parsed.code && event.code === parsed.code) return true;
  return event.key.toLowerCase() === parsed.key;
}

function displayKey(key: string): string {
  if (/^f\d+$/.test(key)) return key.toUpperCase();
  return displayKeys[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

export function shortcutKeyParts(keys: string): string[] {
  const parsed = parseShortcut(keys);
  const parts: string[] = [];
  if (parsed.ctrl) parts.push(isMac ? "\u2303" : "Ctrl");
  if (parsed.meta) parts.push(isMac ? "\u2318" : "Meta");
  if (parsed.alt) parts.push(isMac ? "\u2325" : "Alt");
  if (parsed.shift) parts.push(isMac ? "\u21e7" : "Shift");
  parts.push(displayKey(parsed.key));
  return parts;
}

export function formatShortcut(keys: string): string {
  return shortcutKeyParts(keys).join(isMac ? "" : "+");
}

// CodeMirror uses "Mod-Shift-s" rather than "Mod+Shift+S".
function toCodeMirrorKey(keys: string): string {
  const parts = keys.split("+");
  const key = parts.pop() ?? "";
  return [...parts, key.length === 1 ? key.toLowerCase() : key].join("-");
}

let registered: Shortcut[] = [];
let appBindings: Array<{ shortcut: Shortcut; parsed: ParsedShortcut }> = [];

export function registerShortcuts(shortcuts: Shortcut[]): void {
  registered = shortcuts.slice();
  appBindings = registered
    .filter((shortcut) => (shortcut.scope ?? "app") === "app" && shortcut.run)
    .map((shortcut) => ({ shortcut, parsed: parseShortcut(shortcut.keys) }));

  const seen = new Map<string, string>();
  for (const shortcut of registered) {
    const key = shortcut.keys.toLowerCase();
    const previous = seen.get(key);
    if (previous) {
      console.warn(`Shortcut ${shortcut.keys} is used by both ${previous} and ${shortcut.id}.`);
    } else {
      seen.set(key, shortcut.id);
    }
  }
}

export function getShortcuts(): readonly Shortcut[] {
  return registered;
}

export function editorShortcutBindings(): Array<{
  key: string;
  stopPropagation?: boolean;
  run: () => boolean;
}> {
  return registered
    .filter((shortcut) => shortcut.scope === "editor" && shortcut.run)
    .map((shortcut) => ({
      key: toCodeMirrorKey(shortcut.keys),
      stopPropagation: true,
      run: () => {
        void shortcut.run?.();
        return true;
      },
    }));
}

function isTextEntry(target: HTMLElement): boolean {
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export function installGlobalShortcuts(): void {
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    // xterm needs every key, including modified ones such as Ctrl+C and
    // Ctrl+Shift+Arrow. App shortcuts must not hijack terminal input.
    if (target?.classList.contains("xterm-helper-textarea")) return;
    const modifier = event.ctrlKey || event.metaKey || event.altKey;
    for (const { shortcut, parsed } of appBindings) {
      if (!matchesShortcut(event, parsed)) continue;
      // Never steal plain typing keys from inputs, but let modified keys and
      // function keys work everywhere (including search fields and dialogs).
      if (target && isTextEntry(target) && !modifier && !/^f\d+$/i.test(parsed.key)) continue;
      event.preventDefault();
      void shortcut.run?.();
      return;
    }
  });
}

let dialogInitialized = false;

function closeOtherDialogs(exceptId: string): void {
  for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog[open]")) {
    if (dialog.id === exceptId || dialog.id === "file-conflict-dialog" || dialog.id === "close-confirm-dialog") {
      continue;
    }
    dialog.close();
  }
}

function renderShortcuts(filter: string): void {
  const list = document.getElementById("shortcuts-list");
  const status = document.getElementById("shortcuts-status");
  if (!list) return;

  const needle = filter.trim().toLowerCase();
  const groups = new Map<string, Shortcut[]>();
  let count = 0;
  for (const shortcut of registered) {
    const haystack =
      `${shortcut.group} ${shortcut.label} ${shortcut.keys} ${formatShortcut(shortcut.keys)}`.toLowerCase();
    if (needle && !haystack.includes(needle)) continue;
    count++;
    const items = groups.get(shortcut.group);
    if (items) items.push(shortcut);
    else groups.set(shortcut.group, [shortcut]);
  }

  const fragment = document.createDocumentFragment();
  for (const [group, items] of groups) {
    const section = document.createElement("section");
    section.className = "shortcuts-group";
    const heading = document.createElement("h3");
    heading.textContent = group;
    section.appendChild(heading);
    for (const shortcut of items) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "shortcut-row";
      row.title = shortcut.run ? `Run ${shortcut.label}` : shortcut.label;
      const label = document.createElement("span");
      label.className = "shortcut-label";
      label.textContent = shortcut.label;
      const keys = document.createElement("span");
      keys.className = "shortcut-keys";
      for (const part of shortcutKeyParts(shortcut.keys)) {
        const kbd = document.createElement("kbd");
        kbd.textContent = part;
        keys.appendChild(kbd);
      }
      row.append(label, keys);
      if (shortcut.run) {
        row.addEventListener("click", () => {
          (document.getElementById("shortcuts-dialog") as HTMLDialogElement | null)?.close();
          void shortcut.run?.();
        });
      } else {
        row.disabled = true;
      }
      section.appendChild(row);
    }
    fragment.appendChild(section);
  }

  list.textContent = "";
  list.appendChild(fragment);
  if (status) {
    status.textContent =
      count === 0
        ? "No shortcuts match this filter."
        : count === 1
          ? "1 shortcut"
          : `${count} shortcuts`;
  }
}

export function openShortcutsDialog(): void {
  const dialog = document.getElementById("shortcuts-dialog") as HTMLDialogElement | null;
  const search = document.getElementById("shortcuts-search") as HTMLInputElement | null;
  if (!dialog) return;
  if (search) search.value = "";
  renderShortcuts("");
  closeOtherDialogs("shortcuts-dialog");
  if (!dialog.open) dialog.showModal();
  search?.focus();
}

export function initShortcutsUi(): void {
  if (dialogInitialized) return;
  const dialog = document.getElementById("shortcuts-dialog") as HTMLDialogElement | null;
  if (!dialog) return;
  dialogInitialized = true;
  const search = document.getElementById("shortcuts-search") as HTMLInputElement | null;
  document.getElementById("shortcuts-close")?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  search?.addEventListener("input", () => renderShortcuts(search.value));
  renderShortcuts("");
}
