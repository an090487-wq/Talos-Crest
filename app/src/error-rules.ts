//! Built-in rules and types for Talos' local error detection engine.
//!
//! Rules are regular expressions over the document text. They never run code,
//! contact a network, or depend on a compiler/LSP. Matches inside comments and
//! string literals are ignored unless a rule opts out with `inCodeOnly: false`.

export type RuleSeverity = "error" | "warning" | "info";

export interface ErrorRule {
  id: string;
  name: string;
  message: string;
  pattern: string;
  flags: string;
  severity: RuleSeverity;
  languages: string[];
  enabled: boolean;
  /** Report this capture group instead of the whole match. */
  matchGroup?: number;
  /** Skip matches inside comments/strings. Defaults to true. */
  inCodeOnly?: boolean;
  builtin?: boolean;
}

const LANG_ALL = ["*"];
const JS = ["JavaScript", "JSX", "TypeScript", "TSX"];
const CPP = ["C", "C++"];

/**
 * Rules chosen for a low false-positive rate. They flag suspicious constructs,
 * not style preferences, and every one can be disabled from the Custom Error
 * Detection dialog.
 */
export const BUILTIN_RULES: readonly ErrorRule[] = Object.freeze([
  // Python
  {
    id: "py.bare-except",
    name: "Bare except",
    message: "Bare except catches every error; name the exception instead.",
    pattern: "\\bexcept\\s*:",
    flags: "g",
    severity: "warning",
    languages: ["Python"],
    enabled: true,
    builtin: true,
  },
  {
    id: "py.wildcard-import",
    name: "Wildcard import",
    message: "Wildcard imports hide where names come from.",
    pattern: "\\bfrom\\s+[\\w.]+\\s+import\\s+\\*",
    flags: "g",
    severity: "warning",
    languages: ["Python"],
    enabled: true,
    builtin: true,
  },
  {
    id: "py.mutable-default",
    name: "Mutable default argument",
    message: "Mutable default arguments are shared between calls.",
    pattern: "\\bdef\\s+\\w+\\s*\\(([^)\\n]*=\\s*(?:\\[[^\\]\\n]*\\]|\\{[^}\\n]*\\}))",
    flags: "g",
    severity: "error",
    languages: ["Python"],
    enabled: true,
    matchGroup: 1,
    builtin: true,
  },
  {
    id: "py.eq-none",
    name: "Equality comparison with None",
    message: "Use `is None` / `is not None` for singleton comparisons.",
    pattern: "==\\s*None\\b|None\\s*==",
    flags: "g",
    severity: "warning",
    languages: ["Python"],
    enabled: true,
    builtin: true,
  },
  {
    id: "py.dynamic-eval",
    name: "Dynamic evaluation",
    message: "eval/exec executes arbitrary code; avoid it on untrusted input.",
    pattern: "\\b(?:eval|exec)\\s*\\(",
    flags: "g",
    severity: "warning",
    languages: ["Python"],
    enabled: true,
    builtin: true,
  },

  // JavaScript / TypeScript
  {
    id: "js.loose-equality",
    name: "Loose equality",
    message: "Use === / !== to avoid implicit type conversion.",
    pattern: "([^=!<>])(==|!=)(?!=)",
    flags: "g",
    severity: "warning",
    languages: [...JS],
    enabled: true,
    matchGroup: 2,
    builtin: true,
  },
  {
    id: "js.var",
    name: "var declaration",
    message: "Prefer let or const; var has function scope and hoisting surprises.",
    pattern: "\\bvar\\s+",
    flags: "g",
    severity: "warning",
    languages: [...JS],
    enabled: true,
    builtin: true,
  },
  {
    id: "js.debugger",
    name: "debugger statement",
    message: "Remove debugger statements before shipping.",
    pattern: "\\bdebugger\\b",
    flags: "g",
    severity: "warning",
    languages: [...JS],
    enabled: true,
    builtin: true,
  },
  {
    id: "js.eval",
    name: "eval call",
    message: "eval executes arbitrary code; avoid it on untrusted input.",
    pattern: "\\beval\\s*\\(",
    flags: "g",
    severity: "warning",
    languages: [...JS],
    enabled: true,
    builtin: true,
  },
  {
    id: "js.empty-catch",
    name: "Empty catch block",
    message: "An empty catch silently discards the error.",
    pattern: "catch\\s*\\([^)]*\\)\\s*\\{\\s*\\}",
    flags: "g",
    severity: "warning",
    languages: [...JS],
    enabled: true,
    builtin: true,
  },

  // C / C++
  {
    id: "cpp.gets",
    name: "Unsafe gets()",
    message: "gets() has no bounds checking; use fgets().",
    pattern: "\\bgets\\s*\\(",
    flags: "g",
    severity: "error",
    languages: [...CPP],
    enabled: true,
    builtin: true,
  },
  {
    id: "cpp.strcpy",
    name: "Unbounded strcpy()",
    message: "strcpy() can overflow; use a bounds-checked copy.",
    pattern: "\\bstrcpy\\s*\\(",
    flags: "g",
    severity: "warning",
    languages: [...CPP],
    enabled: true,
    builtin: true,
  },
  {
    id: "cpp.sprintf",
    name: "Unbounded sprintf()",
    message: "sprintf() can overflow; use snprintf().",
    pattern: "\\bsprintf\\s*\\(",
    flags: "g",
    severity: "warning",
    languages: [...CPP],
    enabled: true,
    builtin: true,
  },
  {
    id: "cpp.assign-in-if",
    name: "Assignment in condition",
    message: "Assignment in an if condition is usually a typo for ==.",
    pattern: "\\bif\\s*\\(\\s*([A-Za-z_]\\w*)\\s*=\\s*[^=]",
    flags: "g",
    severity: "error",
    languages: [...CPP, ...JS],
    enabled: true,
    matchGroup: 1,
    builtin: true,
  },

  // Rust
  {
    id: "rust.unwrap",
    name: "unwrap() call",
    message: "unwrap() can panic; handle the Result explicitly.",
    pattern: "\\.unwrap\\(\\)",
    flags: "g",
    severity: "info",
    languages: ["Rust"],
    enabled: true,
    builtin: true,
  },
  {
    id: "rust.unsafe",
    name: "unsafe block",
    message: "Review unsafe code for memory-safety invariants.",
    pattern: "\\bunsafe\\b",
    flags: "g",
    severity: "info",
    languages: ["Rust"],
    enabled: true,
    builtin: true,
  },

  // Java
  {
    id: "java.string-equality",
    name: "String compared with ==",
    message: "Use String.equals() instead of == for value comparison.",
    pattern: "([A-Za-z_]\\w*)\\s*==\\s*\"",
    flags: "g",
    severity: "warning",
    languages: ["Java"],
    enabled: true,
    matchGroup: 1,
    builtin: true,
  },

  // All languages
  {
    id: "all.trailing-whitespace",
    name: "Trailing whitespace",
    message: "Line ends with spaces or a tab.",
    pattern: "[ \\t]+$",
    flags: "gm",
    severity: "info",
    languages: [...LANG_ALL],
    enabled: true,
    builtin: true,
  },
]);

export const CUSTOM_RULE_LIMIT = 200;
export const RULE_PATTERN_LIMIT = 500;
export const ALLOWED_RULE_FLAGS = new Set(["g", "i", "m", "s", "u", "y"]);
