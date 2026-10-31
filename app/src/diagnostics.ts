// Basic built-in checks (brackets, JSON, TODO notes).
// Real language-server diagnostics replace/extend this in the next step.
import { linter } from "@codemirror/lint";
import type { Diagnostic } from "@codemirror/lint";
import type { Text } from "@codemirror/state";

export type Listener = (diags: readonly Diagnostic[], doc: Text) => void;

let languageName = "";
export function setDiagnosticsLanguage(name: string) {
  languageName = name;
}

// Languages where bracket checking is reliable enough.
const BRACKET_LANGS = new Set([
  "C", "C++", "C#", "Java", "JavaScript", "TypeScript", "JSX", "TSX",
  "Rust", "Go", "Kotlin", "Swift", "PHP", "Scala", "CSS", "Python",
]);
const BACKTICK_LANGS = new Set(["JavaScript", "TypeScript", "JSX", "TSX", "Go"]);

function findClose(text: string, start: number, quote: string, multiline: boolean): number {
  for (let j = start + 1; j < text.length; j++) {
    const ch = text[j];
    if (ch === "\\") {
      j++;
      continue;
    }
    if (ch === quote) return j;
    if (ch === "\n" && !multiline) return -1;
  }
  return -1;
}

function bracketCheck(text: string, name: string, out: Diagnostic[]) {
  const hash = name === "Python";
  const slash = !hash && name !== "CSS";
  const backtick = BACKTICK_LANGS.has(name);
  const rust = name === "Rust";
  const stack: { ch: string; pos: number }[] = [];
  const closeToOpen: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

  let i = 0;
  while (i < text.length) {
    const c = text[i];

    if (hash && c === "#") {
      const e = text.indexOf("\n", i);
      i = e < 0 ? text.length : e;
      continue;
    }
    if (slash && c === "/" && text[i + 1] === "/") {
      const e = text.indexOf("\n", i);
      i = e < 0 ? text.length : e;
      continue;
    }
    if (!hash && c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      i = e < 0 ? text.length : e + 2;
      continue;
    }

    if (c === '"' || c === "'" || (backtick && c === "`")) {
      if (hash && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
        const q = text.slice(i, i + 3);
        const e = text.indexOf(q, i + 3);
        if (e >= 0) {
          i = e + 3;
          continue;
        }
      }
      if (rust && c === "'") {
        const m = /^'(\\.|[^\\'])'/.exec(text.slice(i, i + 6));
        i += m ? m[0].length : 1;
        continue;
      }
      const end = findClose(text, i, c, c === "`");
      i = end >= 0 ? end + 1 : i + 1;
      continue;
    }

    if (c === "(" || c === "[" || c === "{") {
      stack.push({ ch: c, pos: i });
    } else if (c === ")" || c === "]" || c === "}") {
      const top = stack.pop();
      if (!top) {
        out.push({ from: i, to: i + 1, severity: "error", message: "Unmatched '" + c + "'" });
      } else if (top.ch !== closeToOpen[c]) {
        out.push({
          from: i,
          to: i + 1,
          severity: "error",
          message: "'" + c + "' does not match '" + top.ch + "'",
        });
      }
    }
    i++;
  }
  for (const s of stack) {
    out.push({ from: s.pos, to: s.pos + 1, severity: "error", message: "Unclosed '" + s.ch + "'" });
  }
}

function jsonCheck(text: string, out: Diagnostic[]) {
  if (!text.trim()) return;
  try {
    JSON.parse(text);
  } catch (e) {
    out.push({
      from: 0,
      to: Math.min(1, text.length),
      severity: "error",
      message: "Invalid JSON: " + (e as Error).message,
    });
  }
}

const TODO = /\b(TODO|FIXME|HACK|XXX)\b/g;
function todoCheck(text: string, out: Diagnostic[]) {
  TODO.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TODO.exec(text)) !== null) {
    const end = text.indexOf("\n", m.index);
    out.push({
      from: m.index,
      to: end < 0 ? text.length : end,
      severity: "info",
      message: m[1] + " note",
    });
  }
}

function scan(text: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!languageName || BRACKET_LANGS.has(languageName)) bracketCheck(text, languageName, out);
  if (languageName === "JSON") jsonCheck(text, out);
  todoCheck(text, out);
  return out.slice(0, 500);
}

export function basicLinter(onResult: Listener) {
  return linter(
    (view) => {
      const diags = scan(view.state.doc.toString());
      onResult(diags, view.state.doc);
      return diags;
    },
    { delay: 300 }
  );
}
