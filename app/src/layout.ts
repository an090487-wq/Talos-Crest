export type LayoutMode = "large" | "medium" | "compact";
export type LayoutPreference = "auto" | LayoutMode;

export interface LayoutSize {
  width: number;
  height: number;
}

export type LayoutAxis = "x" | "y";

interface ModeSettings {
  minWidth: number;
  minHeight: number;
  editorMinHeight: number;
  panelMinHeight: number;
  panelMaxRatio: number;
  sideMinWidth: number;
  sideMinHeight: number;
  sideReserveWidth: number;
  sideReserveHeight: number;
}

export const LAYOUT_MODES: readonly LayoutMode[] = ["large", "medium", "compact"];
export const DEFAULT_LAYOUT_MODE: LayoutMode = "medium";

const SETTINGS: Record<LayoutMode, ModeSettings> = {
  large: {
    minWidth: 1240,
    minHeight: 740,
    editorMinHeight: 260,
    panelMinHeight: 160,
    panelMaxRatio: 0.42,
    sideMinWidth: 260,
    sideMinHeight: 180,
    sideReserveWidth: 420,
    sideReserveHeight: 220,
  },
  medium: {
    minWidth: 820,
    minHeight: 540,
    editorMinHeight: 220,
    panelMinHeight: 136,
    panelMaxRatio: 0.4,
    sideMinWidth: 220,
    sideMinHeight: 160,
    sideReserveWidth: 340,
    sideReserveHeight: 180,
  },
  compact: {
    minWidth: 0,
    minHeight: 0,
    editorMinHeight: 160,
    panelMinHeight: 112,
    panelMaxRatio: 0.34,
    sideMinWidth: 180,
    sideMinHeight: 140,
    sideReserveWidth: 240,
    sideReserveHeight: 140,
  },
};

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.round(Math.min(Math.max(value, min), max));
}

export function isLayoutMode(value: unknown): value is LayoutMode {
  return typeof value === "string" && (LAYOUT_MODES as readonly string[]).includes(value);
}

export function parseLayoutPreference(value: string | null | undefined): LayoutPreference {
  return value === "auto" || isLayoutMode(value) ? value : "auto";
}

export function detectLayoutMode(size: LayoutSize): LayoutMode {
  if (!finitePositive(size.width) || !finitePositive(size.height)) return DEFAULT_LAYOUT_MODE;
  for (const mode of LAYOUT_MODES) {
    const settings = SETTINGS[mode];
    if (size.width >= settings.minWidth && size.height >= settings.minHeight) return mode;
  }
  return "compact";
}

export function resolveLayoutMode(preference: LayoutPreference, size: LayoutSize): LayoutMode {
  return preference === "auto" ? detectLayoutMode(size) : preference;
}

export function nextLayoutPreference(current: LayoutPreference): LayoutPreference {
  if (current === "auto") return "large";
  const index = LAYOUT_MODES.indexOf(current);
  return index < 0 || index === LAYOUT_MODES.length - 1 ? "auto" : LAYOUT_MODES[index + 1];
}

export function clampPanelSize(
  preferred: number,
  viewportHeight: number,
  chromeHeight: number,
  mode: LayoutMode
): number {
  const settings = SETTINGS[mode];
  const ratioCap = finitePositive(viewportHeight)
    ? Math.floor(viewportHeight * settings.panelMaxRatio)
    : settings.panelMinHeight;
  const available = finitePositive(viewportHeight)
    ? Math.floor(viewportHeight - Math.max(0, chromeHeight) - settings.editorMinHeight)
    : settings.panelMinHeight;
  const max = Math.max(settings.panelMinHeight, Math.min(ratioCap, available));
  const value = finitePositive(preferred) ? preferred : settings.panelMinHeight;
  return clamp(value, settings.panelMinHeight, max);
}

export function clampSidePaneSize(
  preferred: number,
  containerSize: number,
  mode: LayoutMode,
  axis: LayoutAxis
): number {
  const settings = SETTINGS[mode];
  const min = axis === "x" ? settings.sideMinWidth : settings.sideMinHeight;
  const reserve = axis === "x" ? settings.sideReserveWidth : settings.sideReserveHeight;
  const available = finitePositive(containerSize) ? Math.floor(containerSize - reserve) : min;
  const max = Math.max(min, available);
  const value = finitePositive(preferred) ? preferred : min;
  return clamp(value, min, max);
}

export function layoutModeLabel(mode: LayoutMode): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}
