// Turns a theme extension's JSON into a CodeMirror theme + UI colors.
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { TagStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

export interface ThemeDef {
  dark?: boolean;
  ui?: Record<string, string>;
  editor?: Record<string, string>;
  syntax?: Record<string, string>;
}

// Only plain color values are accepted from extensions.
const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/deg]+\))$/i;
function color(v: unknown): string | undefined {
  return typeof v === "string" && COLOR.test(v.trim()) ? v.trim() : undefined;
}

let appliedUi: string[] = [];

export function resetUi() {
  for (const k of appliedUi) document.documentElement.style.removeProperty(k);
  appliedUi = [];
}

export function applyUi(ui: Record<string, string>) {
  resetUi();
  const resolved: Record<string, string> = {};

  for (const [k, v] of Object.entries(ui)) {
    const c = color(v);
    if (/^--[a-z0-9-]+$/.test(k) && c) resolved[k] = c;
  }

  // Older themes only set a few legacy tokens. Keep their palettes coherent by
  // deriving the newer design-system tokens instead of leaving teal defaults.
  const aliases: Array<[string, string]> = [
    ["--bronze", "--accent"],
    ["--accent", "--bronze"],
    ["--accent", "--focus"],
    ["--panel", "--panel-2"],
    ["--panel", "--surface-raised"],
    ["--line", "--line-strong"],
  ];
  for (const [source, target] of aliases) {
    if (resolved[source] && !resolved[target]) resolved[target] = resolved[source];
  }

  for (const [k, v] of Object.entries(resolved)) {
    document.documentElement.style.setProperty(k, v);
    appliedUi.push(k);
  }
}

export function buildTheme(def: ThemeDef): Extension {
  const e = def.editor ?? {};
  const SEL = "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection";
  const CUR = ".cm-cursor, .cm-dropCursor";
  const spec: Record<string, Record<string, string>> = {
    "&": {},
    ".cm-gutters": {},
    ".cm-activeLine": {},
    ".cm-activeLineGutter": {},
  };
  spec[SEL] = {};
  spec[CUR] = {};

  const bg = color(e.background);
  const fg = color(e.foreground);
  const cur = color(e.cursor);
  const sel = color(e.selection);
  const gbg = color(e.gutterBackground);
  const gfg = color(e.gutterForeground);
  const act = color(e.activeLine);

  if (bg) spec["&"].backgroundColor = bg;
  if (fg) spec["&"].color = fg;
  if (cur) spec[CUR].borderLeftColor = cur;
  if (sel) spec[SEL].backgroundColor = sel;
  if (gbg) spec[".cm-gutters"].backgroundColor = gbg;
  if (gfg) spec[".cm-gutters"].color = gfg;
  if (act) {
    spec[".cm-activeLine"].backgroundColor = act;
    spec[".cm-activeLineGutter"].backgroundColor = act;
  }

  const s = def.syntax ?? {};
  const rules: TagStyle[] = [];
  const add = (tag: TagStyle["tag"], c: unknown) => {
    const v = color(c);
    if (v) rules.push({ tag, color: v });
  };
  add(t.keyword, s.keyword);
  add(t.string, s.string);
  add([t.comment, t.lineComment, t.blockComment], s.comment);
  add(t.number, s.number);
  add([t.function(t.variableName), t.function(t.propertyName)], s.function);
  add([t.typeName, t.className], s.type);
  add(t.variableName, s.variable);
  add(t.operator, s.operator);
  add([t.bool, t.null, t.atom], s.constant);

  return [
    EditorView.theme(spec, { dark: !!def.dark }),
    syntaxHighlighting(HighlightStyle.define(rules)),
  ];
}
