import { closeOtherDialogs } from "./ui/dialogs";
import { getWindowValue, setWindowValue } from "./window-state";

export interface PaletteCommand {
  id: string;
  label: string;
  category: string;
  description?: string;
  keys?: string;
  run: () => void | Promise<void>;
}

const RECENT_KEY = "talos.command-palette.recent";
const MAX_RECENT = 8;
const MAX_RESULTS = 60;

let commands: PaletteCommand[] = [];
let matches: PaletteCommand[] = [];
let selected = 0;
let reportError: (error: unknown) => void = (error) => console.error(error);

const element = (id: string) => document.getElementById(id)!;

function recentIds(): string[] {
  const raw = getWindowValue(RECENT_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string").slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

function remember(id: string) {
  const next = [id, ...recentIds().filter((item) => item !== id)].slice(0, MAX_RECENT);
  setWindowValue(RECENT_KEY, JSON.stringify(next));
}

function score(command: PaletteCommand, query: string): number {
  const haystack = `${command.label} ${command.category} ${command.description ?? ""}`.toLowerCase();
  const tokens = query.split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;
  let total = 0;
  for (const token of tokens) {
    const direct = haystack.indexOf(token);
    if (direct < 0) return -1;
    total += direct === 0 ? 12 : 6;
  }
  if (haystack.startsWith(query)) total += 10;
  return total;
}

function matchingCommands(query: string): PaletteCommand[] {
  if (!query) {
    const recents = recentIds()
      .map((id) => commands.find((command) => command.id === id))
      .filter((command): command is PaletteCommand => !!command);
    const seen = new Set(recents.map((command) => command.id));
    return [...recents, ...commands.filter((command) => !seen.has(command.id))];
  }
  return commands
    .map((command) => ({ command, value: score(command, query) }))
    .filter((item) => item.value >= 0)
    .sort((a, b) => b.value - a.value || a.command.label.localeCompare(b.command.label))
    .map((item) => item.command);
}

function syncSelection() {
  for (const node of element("command-palette-results").querySelectorAll<HTMLElement>("[data-palette-index]")) {
    const active = Number(node.dataset.paletteIndex) === selected;
    node.classList.toggle("active", active);
    node.setAttribute("aria-selected", String(active));
    if (active) node.scrollIntoView({ block: "nearest" });
  }
}

function render() {
  const query = (element("command-palette-input") as HTMLInputElement).value.trim().toLowerCase();
  const list = element("command-palette-results");
  list.textContent = "";
  matches = matchingCommands(query).slice(0, MAX_RESULTS);
  selected = Math.min(selected, Math.max(0, matches.length - 1));

  const status = element("command-palette-status");
  status.textContent = query
    ? `${matches.length}${matches.length === MAX_RESULTS ? "+" : ""} matching commands`
    : "Recent and available commands";

  if (!matches.length) {
    const empty = document.createElement("div");
    empty.className = "tc-empty";
    const title = document.createElement("strong");
    title.textContent = "No matching commands";
    const detail = document.createElement("span");
    detail.textContent = "Try an action name such as Canvas, Outline, Save, or Run.";
    empty.append(title, detail);
    list.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  const recent = query ? [] : recentIds();
  let lastCategory = "";
  matches.forEach((command, index) => {
    const category = index < recent.length && recent[index] === command.id ? "Recent" : command.category;
    if (category !== lastCategory) {
      lastCategory = category;
      const heading = document.createElement("div");
      heading.className = "tc-command-category";
      heading.textContent = category;
      fragment.appendChild(heading);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tc-command-result";
    button.dataset.paletteIndex = String(index);
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(index === selected));

    const label = document.createElement("span");
    label.className = "tc-command-result-label";
    label.textContent = command.label;

    const detail = document.createElement("span");
    detail.className = "tc-command-result-detail";
    detail.textContent = command.description ?? command.category;

    const keys = document.createElement("kbd");
    keys.textContent = command.keys ?? "";

    button.append(label, detail, keys);
    button.addEventListener("mouseenter", () => {
      selected = index;
      syncSelection();
    });
    button.addEventListener("click", () => void runSelected());
    fragment.appendChild(button);
  });
  list.appendChild(fragment);
  syncSelection();
}

async function runSelected() {
  const command = matches[selected];
  if (!command) return;
  const dialog = element("command-palette") as HTMLDialogElement;
  if (dialog.open) dialog.close();
  remember(command.id);
  try {
    await command.run();
  } catch (error) {
    reportError(error);
  }
}

function moveSelection(delta: number) {
  if (!matches.length) return;
  selected = (selected + delta + matches.length) % matches.length;
  syncSelection();
}

export function initCommandPalette(
  entries: PaletteCommand[],
  onError?: (error: unknown) => void,
) {
  commands = entries;
  if (onError) reportError = onError;

  const input = element("command-palette-input") as HTMLInputElement;
  input.addEventListener("input", () => {
    selected = 0;
    render();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      (element("command-palette") as HTMLDialogElement).close();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      void runSelected();
    }
  });
  element("command-palette-close").addEventListener("click", () => {
    (element("command-palette") as HTMLDialogElement).close();
  });
  window.addEventListener("resize", () => {
    if ((element("command-palette") as HTMLDialogElement).open) positionCommandPalette();
  });
}

function positionCommandPalette() {
  const dialog = element("command-palette") as HTMLDialogElement;
  const trigger = element("btn-command-palette").getBoundingClientRect();
  const top = Math.max(8, Math.min(trigger.bottom + 8, window.innerHeight - 240));
  const center = trigger.left + trigger.width / 2;
  const clampedCenter = Math.max(160, Math.min(center, window.innerWidth - 160));

  dialog.style.top = `${Math.round(top)}px`;
  dialog.style.left = `${Math.round(clampedCenter)}px`;
  dialog.style.right = "auto";
  dialog.style.bottom = "auto";
  dialog.style.margin = "0";
  dialog.style.transform = "translateX(-50%)";

  const box = dialog.querySelector<HTMLElement>(".tc-command-box");
  if (box) {
    box.style.maxHeight = `${Math.round(Math.min(560, Math.max(220, window.innerHeight - top - 16)))}px`;
  }
}

export function openCommandPalette() {
  const dialog = element("command-palette") as HTMLDialogElement;
  const input = element("command-palette-input") as HTMLInputElement;
  input.value = "";
  selected = 0;
  render();
  closeOtherDialogs("command-palette");
  positionCommandPalette();
  if (!dialog.open) dialog.showModal();
  positionCommandPalette();
  input.focus();
  input.select();
}
