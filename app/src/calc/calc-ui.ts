// Dedicated Talos Calc interface. This module is dynamically imported only
// when the user opens the calculator, so it never touches the editor hot path.

import {
  availableUnits,
  convertUnit,
  evaluate,
  formatValue,
  unitsByGroup,
} from "./expression";
import type { CalcMode, IntegerBase } from "./expression";
import { getWindowValue, setWindowValue } from "../window-state";

export interface CalcUiOptions {
  onInsertResult?: (value: string) => void;
}

interface HistoryEntry {
  expression: string;
  result: string;
}

interface CalcState {
  mode: CalcMode;
  bitWidth: number;
  base: IntegerBase;
  unsigned: boolean;
  memory: string | null;
  history: HistoryEntry[];
  fromUnit: string;
  toUnit: string;
}

const STATE_KEY = "talos.calc.state";
const HISTORY_LIMIT = 40;
const $ = (id: string) => document.getElementById(id)!;

const defaultState: CalcState = {
  mode: "scientific",
  bitWidth: 32,
  base: 10,
  unsigned: false,
  memory: null,
  history: [],
  fromUnit: "km",
  toUnit: "m",
};

let options: CalcUiOptions = {};
let initialized = false;
let state = loadState();
let lastResult: number | bigint | null = null;
let historyCursor = -1;

function loadState(): CalcState {
  try {
    const raw = getWindowValue(STATE_KEY);
    if (!raw) return { ...defaultState };
    const parsed = JSON.parse(raw) as Partial<CalcState>;
    const mode: CalcMode = parsed.mode === "programmer" ? "programmer" : "scientific";
    const bitWidth = [8, 16, 32, 64].includes(parsed.bitWidth ?? 0) ? parsed.bitWidth! : 32;
    const base = ([2, 8, 10, 16] as number[]).includes(parsed.base ?? 0) ? (parsed.base as IntegerBase) : 10;
    const units = availableUnits();
    const fromUnit = units.includes(parsed.fromUnit ?? "") ? parsed.fromUnit! : "km";
    const toUnit = units.includes(parsed.toUnit ?? "") ? parsed.toUnit! : "m";
    const history = Array.isArray(parsed.history)
      ? parsed.history
          .filter((entry): entry is HistoryEntry => typeof entry?.expression === "string" && typeof entry?.result === "string")
          .slice(0, HISTORY_LIMIT)
      : [];
    return {
      mode,
      bitWidth,
      base,
      unsigned: parsed.unsigned === true,
      memory: typeof parsed.memory === "string" ? parsed.memory : null,
      history,
      fromUnit,
      toUnit,
    };
  } catch {
    return { ...defaultState };
  }
}

function saveState(): void {
  try {
    setWindowValue(STATE_KEY, JSON.stringify(state));
  } catch {
    // Persistence is best-effort; the calculator remains fully usable offline.
  }
}

function calcOptions() {
  return { bitWidth: state.bitWidth, base: state.base, unsigned: state.unsigned };
}

function expressionInput(): HTMLInputElement {
  return $("calc-expression") as HTMLInputElement;
}

function setStatus(text: string, level: "info" | "error" = "info"): void {
  const status = $("calc-status");
  status.textContent = text;
  status.dataset.level = level;
}

function renderResult(): void {
  const result = $("calc-result");
  if (lastResult === null) {
    result.textContent = "0";
    return;
  }
  try {
    result.textContent = formatValue(lastResult, state.mode, calcOptions());
  } catch (error) {
    result.textContent = String(error instanceof Error ? error.message : error);
  }
}

function renderMode(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-calc-mode]")) {
    const active = button.dataset.calcMode === state.mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
  $("calc-dialog").querySelector(".calc-programmer")?.classList.toggle("calc-hidden", state.mode !== "programmer");
  for (const button of document.querySelectorAll<HTMLElement>("[data-calc-group]")) {
    const group = button.dataset.calcGroup;
    const isHex = /^[0-9A-F]$/.test(button.textContent?.trim() ?? "") && /^[A-F]$/.test(button.textContent?.trim() ?? "");
    const visible = group === "functions" ? state.mode === "scientific" : state.mode === "programmer" && (!isHex || state.base === 16);
    button.classList.toggle("calc-hidden", !visible);
  }
  ($("calc-bit-width") as HTMLSelectElement).value = String(state.bitWidth);
  ($("calc-base") as HTMLSelectElement).value = String(state.base);
  ($("calc-unsigned") as HTMLInputElement).checked = state.unsigned;
  renderResult();
}

function renderHistory(): void {
  const list = $("calc-history");
  list.replaceChildren();
  if (!state.history.length) {
    const empty = document.createElement("span");
    empty.className = "calc-history-empty";
    empty.textContent = "No evaluations yet.";
    list.appendChild(empty);
    return;
  }
  state.history.forEach((entry, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "listitem");
    button.dataset.calcHistory = String(index);
    button.textContent = `${entry.expression} = ${entry.result}`;
    button.title = "Recall this expression";
    list.appendChild(button);
  });
}

function renderMemory(): void {
  $("calc-memory-value").textContent = state.memory ?? "0";
}

function remember(expression: string, result: string): void {
  if (state.history[0]?.expression === expression && state.history[0]?.result === result) return;
  state.history.unshift({ expression, result });
  state.history = state.history.slice(0, HISTORY_LIMIT);
  historyCursor = -1;
  renderHistory();
  saveState();
}

function evaluateAndRender(): void {
  const input = expressionInput();
  const expression = input.value.trim();
  try {
    const result = evaluate(expression, state.mode, calcOptions());
    lastResult = result.value;
    const formatted = formatValue(result.value, state.mode, calcOptions());
    renderResult();
    setStatus(`${expression} = ${formatted}`);
    remember(expression, formatted);
    input.classList.remove("calc-invalid");
  } catch (error) {
    lastResult = null;
    renderResult();
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message, "error");
    input.classList.add("calc-invalid");
  }
}

function insertText(text: string, caretOffset?: number): void {
  const input = expressionInput();
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.setRangeText(text, start, end, "end");
  const caret = caretOffset === undefined ? start + text.length : start + caretOffset;
  input.setSelectionRange(caret, caret);
  input.focus();
}

function recallHistory(direction: -1 | 1): void {
  if (!state.history.length) return;
  historyCursor = Math.max(0, Math.min(state.history.length - 1, historyCursor + direction));
  expressionInput().value = state.history[historyCursor].expression;
  setStatus(`History ${historyCursor + 1} of ${state.history.length}`);
}

function populateUnits(): void {
  const grouped = unitsByGroup();
  const from = $("calc-unit-from") as HTMLSelectElement;
  const to = $("calc-unit-to") as HTMLSelectElement;
  for (const select of [from, to]) {
    select.replaceChildren();
    for (const [group, units] of Object.entries(grouped)) {
      const optgroup = document.createElement("optgroup");
      optgroup.label = group;
      for (const unit of units) {
        const option = document.createElement("option");
        option.value = unit;
        option.textContent = unit;
        optgroup.appendChild(option);
      }
      select.appendChild(optgroup);
    }
  }
  from.value = state.fromUnit;
  to.value = state.toUnit;
}

function runUnitConversion(): void {
  const value = Number(($("calc-unit-value") as HTMLInputElement).value);
  const result = $("calc-unit-result");
  try {
    const converted = convertUnit(value, state.fromUnit, state.toUnit);
    result.textContent = formatValue(converted, "scientific");
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : String(error);
  }
  saveState();
}

function applySettings(): void {
  state.bitWidth = Number(($("calc-bit-width") as HTMLSelectElement).value);
  state.base = Number(($("calc-base") as HTMLSelectElement).value) as IntegerBase;
  state.unsigned = ($("calc-unsigned") as HTMLInputElement).checked;
  state.fromUnit = ($("calc-unit-from") as HTMLSelectElement).value;
  state.toUnit = ($("calc-unit-to") as HTMLSelectElement).value;
  renderMode();
  saveState();
}

async function copyResult(): Promise<void> {
  const text = lastResult === null ? "" : formatValue(lastResult, state.mode, calcOptions());
  if (!text) {
    setStatus("Evaluate an expression before copying.", "error");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`Copied ${text}`);
  } catch {
    const field = document.createElement("textarea");
    field.value = text;
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    const copied = document.execCommand("copy");
    field.remove();
    setStatus(copied ? `Copied ${text}` : "Clipboard is unavailable in this window.", copied ? "info" : "error");
  }
}

function insertResult(): void {
  if (lastResult === null) {
    setStatus("Evaluate an expression before inserting.", "error");
    return;
  }
  const text = formatValue(lastResult, state.mode, calcOptions());
  ($("calc-dialog") as HTMLDialogElement).close();
  options.onInsertResult?.(text);
}

function initialize(): void {
  if (initialized) return;
  initialized = true;

  $("calc-close").addEventListener("click", () => ($("calc-dialog") as HTMLDialogElement).close());
  $("calc-copy").addEventListener("click", () => void copyResult());
  $("calc-insert").addEventListener("click", insertResult);

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-calc-mode]")) {
    button.addEventListener("click", () => {
      state.mode = button.dataset.calcMode === "programmer" ? "programmer" : "scientific";
      historyCursor = -1;
      renderMode();
      saveState();
      expressionInput().focus();
    });
  }

  const input = expressionInput();
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      evaluateAndRender();
    } else if (event.altKey && event.key === "ArrowUp") {
      event.preventDefault();
      recallHistory(-1);
    } else if (event.altKey && event.key === "ArrowDown") {
      event.preventDefault();
      recallHistory(1);
    }
  });

  $("calc-dialog").querySelector(".calc-keypad")?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!button) return;
    const action = button.dataset.calcAction;
    if (action === "equals") return evaluateAndRender();
    if (action === "clear") {
      input.value = "";
      lastResult = null;
      renderResult();
      setStatus("Enter an expression, then press Enter or =.");
      input.focus();
      return;
    }
    if (action === "backspace") {
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      if (end > start) input.setRangeText("", start, end, "start");
      else if (start > 0) input.setRangeText("", start - 1, start, "start");
      input.focus();
      return;
    }
    const fn = button.dataset.calcFunction;
    if (fn) insertText(`${fn}()`, fn.length + 1);
    else if (button.dataset.calcInsert) insertText(button.dataset.calcInsert);
  });

  $("calc-history").addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-calc-history]");
    if (!button) return;
    const index = Number(button.dataset.calcHistory);
    const entry = state.history[index];
    if (!entry) return;
    historyCursor = index;
    input.value = entry.expression;
    evaluateAndRender();
  });

  $("calc-mc").addEventListener("click", () => {
    state.memory = null;
    renderMemory();
    saveState();
  });
  $("calc-mr").addEventListener("click", () => {
    if (state.memory === null) {
      setStatus("Memory is empty.", "error");
      return;
    }
    insertText(state.memory);
  });
  $("calc-ms").addEventListener("click", () => {
    if (lastResult === null) return setStatus("Evaluate a value before storing it.", "error");
    state.memory = lastResult.toString();
    renderMemory();
    saveState();
  });
  $("calc-madd").addEventListener("click", () => void memoryAdd(1));
  $("calc-msub").addEventListener("click", () => void memoryAdd(-1));

  for (const id of ["calc-bit-width", "calc-base", "calc-unsigned", "calc-unit-from", "calc-unit-to"]) {
    $(id).addEventListener("change", applySettings);
  }
  $("calc-unit-run").addEventListener("click", runUnitConversion);
  $("calc-dialog").addEventListener("close", saveState);

  populateUnits();
  renderMode();
  renderHistory();
  renderMemory();
}

function memoryAdd(sign: 1 | -1): void {
  if (lastResult === null) {
    setStatus("Evaluate a value before updating memory.", "error");
    return;
  }
  try {
    const current = state.memory === null ? 0n : BigInt(state.memory);
    const next = typeof lastResult === "bigint" ? lastResult : BigInt(lastResult);
    state.memory = (current + next * BigInt(sign)).toString();
    renderMemory();
    saveState();
  } catch {
    setStatus("Memory operations require whole-number results.", "error");
  }
}

export function openCalc(initialExpression?: string, nextOptions: CalcUiOptions = {}): void {
  options = { ...options, ...nextOptions };
  initialize();
  const dialog = $("calc-dialog") as HTMLDialogElement;
  if (!dialog.open) dialog.showModal();
  if (initialExpression !== undefined && initialExpression.trim()) {
    expressionInput().value = initialExpression.trim();
    evaluateAndRender();
  }
  expressionInput().focus();
}
