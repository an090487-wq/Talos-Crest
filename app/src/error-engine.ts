//! Local, rule-driven error detection engine.
//!
//! This is deliberately independent of compilers and language servers: it runs
//! bounded regular expressions over the editor document, ignores matches in
//! comments/strings, and produces CodeMirror diagnostics. Users can add their
//! own rules from the Custom Error Detection dialog; everything is stored
//! locally in this window.

import { syntaxTree } from "@codemirror/language";
import type { Diagnostic } from "@codemirror/lint";
import type { EditorState } from "@codemirror/state";
import {
  ALLOWED_RULE_FLAGS,
  BUILTIN_RULES,
  CUSTOM_RULE_LIMIT,
  RULE_PATTERN_LIMIT,
  type ErrorRule,
  type RuleSeverity,
} from "./error-rules";

const STORAGE_KEY = "talos.error-rules";
const MAX_SCAN_CHARS = 1_000_000;
const DEFAULT_LIMIT = 300;

const SEVERITIES: ReadonlySet<string> = new Set(["error", "warning", "info"]);
const MASK_NODE = /(comment|string|char|regexp|template)/i;
const MASKED_KINDS = "comments, strings, characters, regexps, and templates";

let customRules: ErrorRule[] = loadCustomRules();

function loadCustomRules(): ErrorRule[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isErrorRule).slice(0, CUSTOM_RULE_LIMIT).map((rule) => ({
      ...rule,
      id: `custom.${rule.id.replace(/^custom\./, "")}`,
      builtin: false,
    }));
  } catch {
    return [];
  }
}

function persist(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(customRules));
  } catch {
    // Private windows or disabled storage: custom rules still work in memory.
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorRule(value: unknown): value is ErrorRule {
  if (!isObject(value)) return false;
  return (
    typeof value.id === "string" && value.id.trim().length > 0 &&
    typeof value.name === "string" && value.name.trim().length > 0 &&
    typeof value.message === "string" && value.message.trim().length > 0 &&
    typeof value.pattern === "string" && value.pattern.length > 0 &&
    typeof value.flags === "string" &&
    typeof value.severity === "string" && SEVERITIES.has(value.severity) &&
    Array.isArray(value.languages) && value.languages.every((item) => typeof item === "string") &&
    typeof value.enabled === "boolean"
  );
}

export function getErrorRules(): readonly ErrorRule[] {
  return [...BUILTIN_RULES, ...customRules];
}

export function getCustomRules(): readonly ErrorRule[] {
  return [...customRules];
}

export function setCustomRules(rules: readonly ErrorRule[]): void {
  customRules = rules.slice(0, CUSTOM_RULE_LIMIT).map((rule) => ({
    ...rule,
    id: `custom.${rule.id.replace(/^custom\./, "")}`,
    builtin: false,
  }));
  persist();
}

export function clearCustomRules(): void {
  customRules = [];
  persist();
}

export interface RuleValidation {
  ok: boolean;
  error?: string;
  rules?: ErrorRule[];
}

/** Parse and validate the JSON text used by the Custom Error Detection dialog. */
export function validateRuleJson(text: string): RuleValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `Invalid JSON: ${String(error)}` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: "Rules must be a JSON array." };
  }
  if (parsed.length > CUSTOM_RULE_LIMIT) {
    return { ok: false, error: `At most ${CUSTOM_RULE_LIMIT} custom rules are allowed.` };
  }
  const rules: ErrorRule[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < parsed.length; index++) {
    const candidate = parsed[index];
    const problem = validateRule(candidate, index, seen);
    if (problem) return { ok: false, error: problem };
    rules.push(candidate as ErrorRule);
  }
  return { ok: true, rules };
}

function validateRule(candidate: unknown, index: number, seen: Set<string>): string | null {
  if (!isErrorRule(candidate)) {
    return `Rule ${index + 1} is missing a required field or has an invalid type.`;
  }
  const rule = candidate;
  if (rule.pattern.length > RULE_PATTERN_LIMIT) {
    return `Rule ${index + 1}: pattern exceeds ${RULE_PATTERN_LIMIT} characters.`;
  }
  const flags = [...rule.flags];
  if (flags.some((flag) => !ALLOWED_RULE_FLAGS.has(flag))) {
    return `Rule ${index + 1}: flags may only contain gimsuy.`;
  }
  if (new Set(flags).size !== flags.length) {
    return `Rule ${index + 1}: duplicate flags.`;
  }
  if (!flags.includes("g")) {
    return `Rule ${index + 1}: the "g" flag is required.`;
  }
  if (rule.languages.length === 0) {
    return `Rule ${index + 1}: select at least one language (or "*").`;
  }
  if (rule.matchGroup !== undefined) {
    const group = rule.matchGroup;
    if (!Number.isInteger(group) || group < 0 || group > 9) {
      return `Rule ${index + 1}: matchGroup must be an integer from 0 to 9.`;
    }
  }
  if (seen.has(rule.id)) {
    return `Rule ${index + 1}: duplicate id ${rule.id}.`;
  }
  seen.add(rule.id);
  try {
    new RegExp(rule.pattern, rule.flags);
  } catch (error) {
    return `Rule ${index + 1}: invalid pattern (${String(error)}).`;
  }
  return null;
}

interface MaskRange {
  from: number;
  to: number;
}

function maskedRanges(state: EditorState): MaskRange[] {
  const ranges: MaskRange[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (!MASK_NODE.test(node.name)) return;
      ranges.push({ from: node.from, to: node.to });
      return false;
    },
  });
  return ranges;
}

function isMasked(position: number, ranges: MaskRange[], cursor: { value: number }): boolean {
  while (cursor.value < ranges.length && ranges[cursor.value].to <= position) cursor.value++;
  const range = ranges[cursor.value];
  return !!range && position >= range.from && position < range.to;
}

function ruleMatchesLanguage(rule: ErrorRule, language: string): boolean {
  const name = language.toLowerCase();
  return rule.languages.some((entry) => {
    const candidate = entry.toLowerCase();
    return candidate === "*" || candidate === name;
  });
}

function matchRange(match: RegExpExecArray, group?: number): { from: number; to: number } | null {
  if (!group) {
    return { from: match.index, to: match.index + match[0].length };
  }
  const text = match[group];
  if (!text) return null;
  const offset = match[0].indexOf(text);
  if (offset < 0) return null;
  return { from: match.index + offset, to: match.index + offset + text.length };
}

function scanRule(
  text: string,
  rule: ErrorRule,
  ranges: MaskRange[],
  limit: number
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const flags = rule.flags.replace("y", "");
  const regex = new RegExp(rule.pattern, flags.includes("g") ? flags : `${flags}g`);
  const cursor = { value: 0 };
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match[0].length === 0) {
      regex.lastIndex++;
      continue;
    }
    if (rule.inCodeOnly !== false && isMasked(match.index, ranges, cursor)) continue;
    const range = matchRange(match, rule.matchGroup);
    if (!range) continue;
    const from = Math.min(range.from, text.length);
    const to = Math.max(from, Math.min(range.to, text.length));
    diagnostics.push({
      from,
      to: to > from ? to : Math.min(from + 1, text.length),
      severity: rule.severity as RuleSeverity,
      source: rule.builtin ? `Talos: ${rule.name}` : `Custom: ${rule.name}`,
      message: rule.message,
    });
    if (diagnostics.length >= limit) break;
  }
  return diagnostics;
}

/** Run every enabled rule that applies to `language`. Results are bounded. */
export function scanWithErrorEngine(
  state: EditorState,
  language: string,
  limit = DEFAULT_LIMIT
): Diagnostic[] {
  const budget = Math.max(0, Math.min(limit, DEFAULT_LIMIT));
  if (budget === 0 || state.doc.length === 0) return [];
  const text = state.doc.sliceString(0, Math.min(state.doc.length, MAX_SCAN_CHARS));
  const ranges = maskedRanges(state);
  const diagnostics: Diagnostic[] = [];
  for (const rule of getErrorRules()) {
    if (!rule.enabled || !ruleMatchesLanguage(rule, language)) continue;
    diagnostics.push(...scanRule(text, rule, ranges, budget - diagnostics.length));
    if (diagnostics.length >= budget) break;
  }
  return diagnostics;
}

export function errorEngineAvailability(language: string): string {
  const active = getErrorRules().filter(
    (rule) => rule.enabled && ruleMatchesLanguage(rule, language)
  ).length;
  return `${active} local rule${active === 1 ? "" : "s"} active for ${language || "Plain text"}; matches in ${MASKED_KINDS} are ignored.`;
}
