import type { ThemeDef } from "../theme";

export type BuiltinThemeId =
  | "talos-industrial"
  | "talos-dark"
  | "talos-midnight"
  | "talos-light"
  | "talos-contrast";

export const DEFAULT_BUILTIN_THEME: BuiltinThemeId = "talos-industrial";

// Canonical UI palette for the default Talos Crest identity. Alternate themes
// remain available for user preference, but new UI is designed against these
// tokens first.
export const builtinThemes: Record<BuiltinThemeId, ThemeDef> = {
  "talos-industrial": {
    dark: true,
    ui: {
      "--bg": "#101519",
      "--panel": "#171f24",
      "--panel-2": "#1c262c",
      "--surface-raised": "#243139",
      "--line": "#2b383f",
      "--line-strong": "#3a4a52",
      "--text": "#e7eef1",
      "--muted": "#94a4ad",
      "--accent": "#42c7b5",
      "--bronze": "#42c7b5",
      "--accent-ink": "#071a18",
      "--focus": "#42c7b5",
      "--danger": "#e47777",
      "--warning": "#e5b567",
      "--success": "#67c995",
      "--info": "#7fb6c6",
      "--overlay": "rgba(8, 13, 16, .76)",
    },
    editor: {
      background: "#101519",
      foreground: "#e7eef1",
      cursor: "#42c7b5",
      selection: "#1b4c46",
      gutterBackground: "#101519",
      gutterForeground: "#82939c",
      activeLine: "#171f24",
    },
    syntax: {
      keyword: "#7fb6c6",
      string: "#67c995",
      comment: "#7d9099",
      number: "#e5b567",
      function: "#b6d8d2",
      type: "#42c7b5",
      variable: "#e7eef1",
      operator: "#94a4ad",
      constant: "#e5b567",
    },
  },
  "talos-dark": {
    dark: true,
    ui: {
      "--bg": "#111318", "--panel": "#191c22", "--panel-2": "#20252d", "--surface-raised": "#222730",
      "--line": "#2b3039", "--line-strong": "#3c434e", "--text": "#ece9e3", "--muted": "#a5aab4",
      "--accent": "#dc9a56", "--bronze": "#dc9a56", "--accent-ink": "#21170f", "--focus": "#f0b277",
      "--danger": "#ff8178", "--warning": "#e7bd63", "--success": "#78cf98", "--info": "#7bbfea",
      "--overlay": "rgba(8, 13, 16, .68)",
    },
    editor: { background: "#111318", foreground: "#ece9e3", cursor: "#dc9a56", selection: "#493522", gutterBackground: "#111318", gutterForeground: "#9298a3", activeLine: "#191c22" },
    syntax: { keyword: "#7bbfea", string: "#8fd0a2", comment: "#78808c", number: "#e7bd63", function: "#d8c3a6", type: "#dc9a56", variable: "#ece9e3", operator: "#a5aab4", constant: "#e7bd63" },
  },
  "talos-midnight": {
    dark: true,
    ui: {
      "--bg": "#0d1119", "--panel": "#141b27", "--panel-2": "#192232", "--surface-raised": "#202b3c",
      "--line": "#28364b", "--line-strong": "#3a4b66", "--text": "#e4ebf6", "--muted": "#a3b1c6",
      "--accent": "#8bb4e8", "--bronze": "#8bb4e8", "--accent-ink": "#101722", "--focus": "#a9cbf3",
      "--danger": "#ff8b88", "--warning": "#efc36d", "--success": "#83d6a5", "--info": "#86c5ed",
      "--overlay": "rgba(8, 13, 16, .72)",
    },
    editor: { background: "#0d1119", foreground: "#e4ebf6", cursor: "#8bb4e8", selection: "#26364b", gutterBackground: "#0d1119", gutterForeground: "#8290a4", activeLine: "#141b27" },
    syntax: { keyword: "#86c5ed", string: "#83d6a5", comment: "#74839a", number: "#efc36d", function: "#c2d7ef", type: "#8bb4e8", variable: "#e4ebf6", operator: "#a3b1c6", constant: "#efc36d" },
  },
  "talos-light": {
    dark: false,
    ui: {
      "--bg": "#f4f5f7", "--panel": "#e9ebef", "--panel-2": "#e2e6ec", "--surface-raised": "#ffffff",
      "--line": "#cbd1da", "--line-strong": "#aeb7c4", "--text": "#252a32", "--muted": "#596271",
      "--accent": "#905315", "--bronze": "#905315", "--accent-ink": "#fffaf4", "--focus": "#b46b22",
      "--danger": "#b42318", "--warning": "#875c00", "--success": "#18733c", "--info": "#17659a",
      "--overlay": "rgba(15, 20, 28, .35)",
    },
    editor: { background: "#f4f5f7", foreground: "#252a32", cursor: "#905315", selection: "#e5d7c8", gutterBackground: "#f4f5f7", gutterForeground: "#69717c", activeLine: "#e9ebef" },
    syntax: { keyword: "#17659a", string: "#18733c", comment: "#7a8492", number: "#875c00", function: "#3f5573", type: "#905315", variable: "#252a32", operator: "#596271", constant: "#875c00" },
  },
  "talos-contrast": {
    dark: true,
    ui: {
      "--bg": "#000000", "--panel": "#090909", "--panel-2": "#101010", "--surface-raised": "#171717",
      "--line": "#ffffff", "--line-strong": "#ffffff", "--text": "#ffffff", "--muted": "#e3e3e3",
      "--accent": "#ffed00", "--bronze": "#ffed00", "--accent-ink": "#000000", "--focus": "#ffed00",
      "--danger": "#ff7777", "--warning": "#ffed00", "--success": "#72ff9a", "--info": "#75d7ff",
      "--overlay": "rgba(0, 0, 0, .85)",
    },
    editor: { background: "#000000", foreground: "#ffffff", cursor: "#ffed00", selection: "#454000", gutterBackground: "#000000", gutterForeground: "#e3e3e3", activeLine: "#171717" },
    syntax: { keyword: "#75d7ff", string: "#72ff9a", comment: "#e3e3e3", number: "#ffed00", function: "#ffffff", type: "#ffed00", variable: "#ffffff", operator: "#e3e3e3", constant: "#ffed00" },
  },
};
