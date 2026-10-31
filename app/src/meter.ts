// Error Meter scoring (same rules as core/src/meter.rs).
export type Sev = "error" | "warning" | "info" | "hint";
export type Level = "Clean" | "Stable" | "Warning" | "Critical" | "Failing";

export interface Reading {
  score: number; // 0..100
  level: Level;
  errors: number;
  warnings: number;
}

const WEIGHT: Record<Sev, number> = { error: 10, warning: 3, info: 1, hint: 0 };

export const LABEL: Record<Level, string> = {
  Clean: "Clean",
  Stable: "Stable",
  Warning: "Needs attention",
  Critical: "Critical",
  Failing: "Failing",
};

// Fun mode captions (text only for now; images/sounds come later)
export const FUN: Record<Level, string> = {
  Clean: "Suspiciously perfect.",
  Stable: "Tiny bumps. We move.",
  Warning: "This is fine. (It is not fine.)",
  Critical: "Send help and coffee.",
  Failing: "Have you tried turning it off and on again?",
};

function levelOf(score: number): Level {
  if (score === 0) return "Clean";
  if (score <= 15) return "Stable";
  if (score <= 40) return "Warning";
  if (score <= 70) return "Critical";
  return "Failing";
}

export function measure(severities: Sev[], totalLines: number): Reading {
  let raw = 0;
  let errors = 0;
  let warnings = 0;
  for (const s of severities) {
    raw += WEIGHT[s];
    if (s === "error") errors++;
    if (s === "warning") warnings++;
  }
  let score = 0;
  if (raw > 0) {
    const size = Math.max(totalLines, 20) / 20;
    const pressure = raw / size;
    score = Math.round((100 * pressure) / (pressure + 20));
  }
  return { score, level: levelOf(score), errors, warnings };
}
