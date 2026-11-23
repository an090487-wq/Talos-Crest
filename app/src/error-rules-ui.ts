//! UI for creating, validating, and saving local error-detection rules.

import {
  clearCustomRules,
  getCustomRules,
  getErrorRules,
  setCustomRules,
  validateRuleJson,
} from "./error-engine";
import type { ErrorRule } from "./error-rules";

const $ = (id: string) => document.getElementById(id)!;

let wired = false;
let dirty = false;

function renderActiveRules(): void {
  const list = $("error-rules-active");
  list.replaceChildren();
  for (const rule of getErrorRules() as readonly ErrorRule[]) {
    const row = document.createElement("div");
    row.className = `error-rule-row${rule.enabled ? "" : " disabled"}`;

    const badge = document.createElement("span");
    badge.className = `error-rule-severity ${rule.severity}`;
    badge.textContent = rule.severity;

    const title = document.createElement("span");
    title.className = "error-rule-name";
    title.textContent = rule.name;

    const detail = document.createElement("span");
    detail.className = "error-rule-detail";
    detail.textContent = `${rule.builtin ? "built-in" : "custom"} · ${rule.languages.join(", ")}`;

    row.append(badge, title, detail);
    list.appendChild(row);
  }
}

function status(message: string, error = false): void {
  const node = $("error-rules-status");
  node.textContent = message;
  node.classList.toggle("error", error);
}

function refreshEditor(): void {
  if (dirty) return;
  ($("error-rules-json") as HTMLTextAreaElement).value =
    JSON.stringify(getCustomRules(), null, 2);
}

function apply(): void {
  const text = ($("error-rules-json") as HTMLTextAreaElement).value;
  const result = validateRuleJson(text);
  if (!result.ok || !result.rules) {
    status(result.error ?? "Invalid rules.", true);
    return;
  }
  setCustomRules(result.rules);
  dirty = false;
  renderActiveRules();
  refreshEditor();
  status(`Saved ${result.rules.length} custom rule${result.rules.length === 1 ? "" : "s"}.`);
  document.dispatchEvent(new CustomEvent("talos:error-rules-changed"));
}

function wire(): void {
  if (wired) return;
  wired = true;
  $("error-rules-close").addEventListener("click", () => {
    ($("error-rules-dialog") as HTMLDialogElement).close();
  });
  $("error-rules-apply").addEventListener("click", apply);
  $("error-rules-reset").addEventListener("click", () => {
    clearCustomRules();
    dirty = false;
    refreshEditor();
    renderActiveRules();
    status("Custom rules removed. Built-in rules remain active.");
    document.dispatchEvent(new CustomEvent("talos:error-rules-changed"));
  });
  $("error-rules-example").addEventListener("click", () => {
    ($("error-rules-json") as HTMLTextAreaElement).value = JSON.stringify([
      {
        id: "no-alert",
        name: "No alert()",
        message: "Use the in-app notification helper instead of alert().",
        pattern: "\\balert\\s*\\(",
        flags: "g",
        severity: "warning",
        languages: ["JavaScript", "TypeScript"],
        enabled: true,
      },
    ], null, 2);
    dirty = true;
    status("Example loaded. Click Save to activate it.");
  });
  ($("error-rules-json") as HTMLTextAreaElement).addEventListener("input", () => {
    dirty = true;
  });
}

export function openErrorRulesDialog(): void {
  wire();
  dirty = false;
  refreshEditor();
  renderActiveRules();
  status("Rules run locally on the current file. Matches in comments and strings are ignored.");
  const dialog = $("error-rules-dialog") as HTMLDialogElement;
  if (!dialog.open) dialog.showModal();
}
