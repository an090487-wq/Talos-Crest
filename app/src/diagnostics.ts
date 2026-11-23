import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { linter } from "@codemirror/lint";
import type { Diagnostic } from "@codemirror/lint";
import type { EditorState } from "@codemirror/state";
import { errorEngineAvailability, scanWithErrorEngine } from "./error-engine";

export type Listener = (diags: readonly Diagnostic[], doc: EditorState["doc"]) => void;

let languageName = "";

export function setDiagnosticsLanguage(name: string) {
  languageName = name;
}

export function diagnosticsAvailability(name = languageName): string {
  const label = name || "Plain text";
  const engine = errorEngineAvailability(label);
  if (name === "JSON") {
    return `Talos JSON parser diagnostics are active. ${engine}`;
  }
  return `${engine} No compiler or language-server diagnostics are configured; these are local pattern checks, not semantic analysis.`;
}

const commentNodes: Record<string, ReadonlySet<string>> = {
  Python: new Set(["Comment"]),
  JavaScript: new Set(["LineComment", "BlockComment"]),
  JSX: new Set(["LineComment", "BlockComment"]),
  TypeScript: new Set(["LineComment", "BlockComment"]),
  TSX: new Set(["LineComment", "BlockComment"]),
  Rust: new Set(["LineComment", "BlockComment"]),
  Go: new Set(["LineComment", "BlockComment"]),
  C: new Set(["LineComment", "BlockComment"]),
  "C++": new Set(["LineComment", "BlockComment"]),
  Java: new Set(["LineComment", "BlockComment"]),
};

// Reuse whatever the editor's incremental parser already produced. Only ask
// for a bounded parse when the tree does not cover the document yet. This
// keeps linting from re-parsing the whole file on the main thread every time.
function documentTree(state: EditorState, timeout: number): ReturnType<typeof syntaxTree> {
  const parsed = syntaxTree(state);
  if (parsed.length >= state.doc.length) return parsed;
  return ensureSyntaxTree(state, state.doc.length, timeout) ?? parsed;
}

const marker = /\b(TODO|FIXME|HACK|XXX)\b/g;
const MAX_DIAGNOSTICS = 500;

function scanTree(state: EditorState, name: string, limit: number): Diagnostic[] {
  const isJson = name === "JSON";
  const nodes = commentNodes[name];
  if (!isJson && !nodes) return [];
  const doc = state.doc;
  if (doc.length === 0) return [];

  const tree = documentTree(state, isJson ? 8 : 6);
  // A partial tree would produce misleading results (missing or extra errors),
  // so wait for the background parser and report nothing until it catches up.
  if (tree.length < doc.length) return [];

  const diagnostics: Diagnostic[] = [];
  let full = false;
  tree.iterate({
    enter(node) {
      if (full) return false;
      if (diagnostics.length >= limit) {
        full = true;
        return false;
      }
      if (isJson && node.name === "\u26a0") {
        const from = Math.min(node.from, doc.length);
        const to = Math.max(from, Math.min(node.to, doc.length));
        diagnostics.push({
          from,
          to: to > from ? to : Math.min(from + 1, doc.length),
          severity: "error",
          source: "Talos JSON parser",
          message: "Invalid JSON syntax.",
        });
        return;
      }
      if (!nodes?.has(node.name)) return;
      const comment = doc.sliceString(node.from, node.to);
      marker.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = marker.exec(comment)) !== null) {
        diagnostics.push({
          from: node.from + match.index,
          to: node.to,
          severity: "info",
          source: "Talos TODO marker",
          message: match[1] + " note",
        });
        if (diagnostics.length >= limit) {
          full = true;
          return false;
        }
      }
    },
  });
  return diagnostics;
}

export function scanDiagnostics(
  state: EditorState,
  name = languageName,
  limit = MAX_DIAGNOSTICS
): Diagnostic[] {
  const budget = Math.max(1, limit);
  const parser = scanTree(state, name, budget);
  const rules = scanWithErrorEngine(state, name, budget - parser.length);
  return [...parser, ...rules]
    .sort((left, right) => left.from - right.from || left.to - right.to)
    .slice(0, budget);
}

export function basicLinter(onResult: Listener) {
  return linter(
    (view) => {
      const diags = scanDiagnostics(view.state);
      onResult(diags, view.state.doc);
      return diags;
    },
    { delay: 500 }
  );
}
