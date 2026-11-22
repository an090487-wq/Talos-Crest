// Desktop integrated terminal. xterm.js owns rendering and key encoding while
// the Rust PTY owns the actual shell. This module is imported lazily only when
// the terminal channel is opened, so Canvas/Calc/editor startup stay untouched.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { getWindowValue, setWindowValue } from "./window-state";

const OUTPUT_EVENT = "talos://terminal-output";
const EXIT_EVENT = "talos://terminal-exit";
const MODEL_PATTERN = /^[A-Za-z0-9._:/-]{1,160}$/;

interface TerminalSession {
  id: number;
  nonce: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
}

interface TerminalOutput {
  sessionId: number;
  nonce: string;
  data: string;
}

interface TerminalExit {
  sessionId: number;
  nonce: string;
  code: number | null;
  signal: string | null;
}

interface TerminalOptions {
  getCwd: () => string | null;
  reportError: (error: unknown) => void;
}

let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let session: TerminalSession | null = null;
let starting: Promise<void> | null = null;
let connectingNonce: string | null = null;
let pendingOutput: string[] = [];
let getCwd: () => string | null = () => null;
let reportError: (error: unknown) => void = (error) => console.error(error);
let resizeTimer = 0;
let lastCols = 0;
let lastRows = 0;

function token(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function xtermTheme() {
  return {
    background: token("--bg", "#101519"),
    foreground: token("--text", "#e7eef1"),
    cursor: token("--accent", "#42c7b5"),
    cursorAccent: token("--bg", "#101519"),
    selectionBackground: token("--panel-2", "#1c262c"),
    selectionForeground: token("--text", "#e7eef1"),
    black: token("--panel", "#171f24"),
    red: token("--danger", "#e47777"),
    green: token("--success", "#67c995"),
    yellow: token("--warning", "#e5b567"),
    blue: token("--info", "#7fb6c6"),
    magenta: token("--accent", "#42c7b5"),
    cyan: token("--info", "#7fb6c6"),
    white: token("--text", "#e7eef1"),
    brightBlack: token("--muted", "#94a4ad"),
    brightRed: token("--danger", "#e47777"),
    brightGreen: token("--success", "#67c995"),
    brightYellow: token("--warning", "#e5b567"),
    brightBlue: token("--info", "#7fb6c6"),
    brightMagenta: token("--accent", "#42c7b5"),
    brightCyan: token("--info", "#7fb6c6"),
    brightWhite: token("--text", "#e7eef1"),
  };
}

function setStatus(message: string, tone: "normal" | "success" | "error" = "normal") {
  const status = document.getElementById("terminal-status");
  if (!status) return;
  status.textContent = message;
  if (tone === "normal") status.removeAttribute("data-tone");
  else status.dataset.tone = tone;
}

function nonce(): string {
  const random = Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${random}`;
}

function applyTheme() {
  if (!terminal) return;
  terminal.options.fontFamily = token("--mono-font", "monospace");
  terminal.options.theme = xtermTheme();
}

function sendResize(immediate = false) {
  const run = () => {
    if (!terminal || !fitAddon) return;
    const view = document.getElementById("terminal-view");
    if (!view || view.clientWidth < 20 || view.clientHeight < 20) return;
    try {
      fitAddon.fit();
    } catch {
      return;
    }
    if (!session) return;
    if (terminal.cols === lastCols && terminal.rows === lastRows) return;
    lastCols = terminal.cols;
    lastRows = terminal.rows;
    void invoke("terminal_resize", {
      id: session.id,
      cols: lastCols,
      rows: lastRows,
    }).catch(reportError);
  };

  if (immediate) {
    requestAnimationFrame(run);
    return;
  }
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => requestAnimationFrame(run), 80);
}

function closeSession() {
  const current = session;
  session = null;
  connectingNonce = null;
  pendingOutput = [];
  lastCols = 0;
  lastRows = 0;
  if (!current) return;
  void invoke("terminal_close", { id: current.id }).catch(reportError);
}

function writeToPty(data: string) {
  if (!session) {
    setStatus("Terminal is not running — use Restart", "error");
    return;
  }
  void invoke("terminal_write", { id: session.id, data }).catch(reportError);
}

async function startSession() {
  if (session || starting) return starting ?? Promise.resolve();
  if (!terminal || !fitAddon) return;

  starting = (async () => {
    const view = document.getElementById("terminal-view");
    if (!view || view.clientWidth < 20 || view.clientHeight < 20) return;

    const candidate = nonce();
    connectingNonce = candidate;
    pendingOutput = [];
    setStatus("Starting shell…");

    let cols = terminal!.cols || 80;
    let rows = terminal!.rows || 24;
    try {
      fitAddon!.fit();
      cols = terminal!.cols || cols;
      rows = terminal!.rows || rows;
    } catch {
      // The panel may still be settling; the conservative dimensions above are
      // enough to open the PTY and sendResize() will correct them immediately.
    }

    try {
      const opened = await invoke<TerminalSession>("terminal_open", {
        cwd: getCwd() || getWindowValue("talos.workspace-root") || undefined,
        cols,
        rows,
        nonce: candidate,
      });
      if (connectingNonce !== candidate) {
        void invoke("terminal_close", { id: opened.id }).catch(reportError);
        return;
      }
      session = opened;
      connectingNonce = null;
      lastCols = opened.cols;
      lastRows = opened.rows;
      for (const data of pendingOutput) terminal!.write(data);
      pendingOutput = [];
      setStatus(`${opened.shell} — ${opened.cwd}`, "success");
      sendResize(true);
      terminal!.focus();
    } catch (error) {
      connectingNonce = null;
      pendingOutput = [];
      setStatus("Could not start terminal", "error");
      reportError(error);
      terminal!.writeln(`\r\n\x1b[31mTerminal unavailable:\x1b[0m ${String(error)}`);
    }
  })().finally(() => {
    starting = null;
  });

  return starting;
}

function installListeners() {
  void listen<TerminalOutput>(OUTPUT_EVENT, (event) => {
    const payload = event.payload;
    if (session && payload.sessionId === session.id && payload.nonce === session.nonce) {
      terminal?.write(payload.data);
      return;
    }
    if (connectingNonce && payload.nonce === connectingNonce) pendingOutput.push(payload.data);
  }).catch(reportError);

  void listen<TerminalExit>(EXIT_EVENT, (event) => {
    const payload = event.payload;
    if (!session || payload.sessionId !== session.id || payload.nonce !== session.nonce) return;
    session = null;
    connectingNonce = null;
    pendingOutput = [];
    const detail = payload.signal ? `signal ${payload.signal}` : `code ${payload.code ?? 0}`;
    setStatus(`Shell exited (${detail}) — use Restart`, "error");
    terminal?.write("\r\n");
  }).catch(reportError);

  window.addEventListener("resize", () => sendResize());
  window.addEventListener("beforeunload", closeSession);
}

export function activateTerminal(options: TerminalOptions): void {
  getCwd = options.getCwd;
  reportError = options.reportError;

  const view = document.getElementById("terminal-view");
  if (!view || terminal) {
    void startSession();
    return;
  }

  terminal = new Terminal({
    allowProposedApi: false,
    convertEol: true,
    cursorBlink: true,
    cursorStyle: "bar",
    fontFamily: token("--mono-font", "monospace"),
    fontSize: 12,
    lineHeight: 1.25,
    scrollback: 2000,
    theme: xtermTheme(),
  });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon());
  terminal.open(view);
  terminal.onData(writeToPty);

  installListeners();
  applyTheme();

  const themeObserver = new MutationObserver(applyTheme);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style", "data-theme"],
  });

  if (typeof ResizeObserver !== "undefined") {
    const resizeObserver = new ResizeObserver(() => sendResize());
    resizeObserver.observe(view);
  }

  document.getElementById("btn-terminal-clear")?.addEventListener("click", () => {
    terminal?.clear();
    terminal?.focus();
  });
  document.getElementById("btn-terminal-restart")?.addEventListener("click", () => {
    closeSession();
    void startSession();
  });
  const ollamaInput = document.getElementById("ollama-model") as HTMLInputElement | null;
  const savedModel = getWindowValue("talos.ollama-model");
  if (ollamaInput && savedModel && MODEL_PATTERN.test(savedModel)) ollamaInput.value = savedModel;
  ollamaInput?.addEventListener("change", () => {
    const model = ollamaInput.value.trim();
    if (MODEL_PATTERN.test(model)) setWindowValue("talos.ollama-model", model);
  });
  document.getElementById("btn-ollama-run")?.addEventListener("click", () => runOllamaModel());

  setStatus("Starting shell…");
  void startSession();
}

export function focusTerminal(): void {
  if (!terminal) {
    void startSession();
    return;
  }
  sendResize(true);
  if (!session) void startSession();
  terminal.focus();
}

export function runOllamaModel(): void {
  const input = document.getElementById("ollama-model") as HTMLInputElement | null;
  const model = input?.value.trim() ?? "";
  if (!MODEL_PATTERN.test(model)) {
    setStatus("Model names allow letters, numbers, . _ - / and :", "error");
    input?.focus();
    return;
  }
  if (!session) {
    setStatus("Start the terminal before running Ollama", "error");
    return;
  }
  setWindowValue("talos.ollama-model", model);
  writeToPty(`ollama run ${model}\r`);
  setStatus(`Starting Ollama model ${model}`, "success");
  terminal?.focus();
}
