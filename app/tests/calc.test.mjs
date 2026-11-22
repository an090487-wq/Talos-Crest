import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(resolve(appDir, "src/calc/expression.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const calcModule = { exports: {} };
new Function("module", "exports", compiled)(calcModule, calcModule.exports);
const { availableUnits, convertUnit, evaluate, formatValue, unitGroups } = calcModule.exports;

function scientific(expression) {
  return evaluate(expression, "scientific");
}

function programmer(expression, options = {}) {
  return evaluate(expression, "programmer", options);
}

test("scientific arithmetic respects precedence and parentheses", () => {
  assert.equal(scientific("2 + 3 * 4").formatted, "14");
  assert.equal(scientific("(2 + 3) * 4").formatted, "20");
  assert.equal(scientific("10 - 3 - 2").formatted, "5");
  assert.equal(scientific("8 / 2 / 2").formatted, "2");
});

test("scientific powers are right associative and bind tighter than unary minus", () => {
  assert.equal(scientific("2^3^2").formatted, "512");
  assert.equal(scientific("-2^2").formatted, "-4");
  assert.equal(scientific("2^-3").formatted, "0.125");
});

test("scientific functions, constants and notation work", () => {
  assert.equal(scientific("sqrt(16) + ln(e)").formatted, "5");
  assert.equal(scientific("sin(0)").formatted, "0");
  assert.equal(scientific("1.2e3 / 2").formatted, "600");
  assert.equal(scientific("pi * 0").formatted, "0");
});

test("scientific errors are clear and do not throw raw exceptions", () => {
  assert.throws(() => scientific("1 / 0"), /Division by zero/);
  assert.throws(() => scientific("2 +"), /Unexpected end of expression/);
  assert.throws(() => scientific("foo(1)"), /Unknown function/);
  assert.throws(() => scientific("2 + @"), /Invalid character/);
  assert.throws(() => scientific("(2 + 3"), /Expected '\)'/);
});

test("programmer arithmetic uses configured bit width and signedness", () => {
  assert.equal(programmer("0xff + 1", { bitWidth: 8 }).formatted, "0");
  assert.equal(programmer("0xff", { bitWidth: 8, unsigned: true, base: 16 }).formatted, "0xFF");
  assert.equal(programmer("0x10 - 1", { bitWidth: 8, unsigned: true, base: 2 }).formatted, "0b1111");
  assert.equal(programmer("-1", { bitWidth: 8, unsigned: false, base: 16 }).formatted, "0xFF (two's complement)");
  assert.equal(programmer("1 << 9", { bitWidth: 8, unsigned: true }).formatted, "0");
});

test("programmer bitwise operators work", () => {
  assert.equal(programmer("0b1010 & 0b1100", { bitWidth: 8, unsigned: true, base: 2 }).formatted, "0b1000");
  assert.equal(programmer("0b1010 | 0b0101", { bitWidth: 8, unsigned: true, base: 2 }).formatted, "0b1111");
  assert.equal(programmer("0b1010 ^ 0b0110", { bitWidth: 8, unsigned: true, base: 2 }).formatted, "0b1100");
  assert.equal(programmer("~0", { bitWidth: 8, unsigned: true, base: 2 }).formatted, "0b11111111");
  assert.equal(programmer("-8 >> 1", { bitWidth: 8, unsigned: false }).formatted, "-4");
});

test("programmer errors cover invalid literals, zero division and bit width", () => {
  assert.throws(() => programmer("0b102"), /Invalid character/);
  assert.throws(() => programmer("5 / 0"), /Division by zero/);
  assert.throws(() => programmer("1 + 2", { bitWidth: 12 }), /Unsupported bit width/);
  assert.throws(() => programmer("1.5 & 1"), /whole numbers/);
});

test("formatValue renders results without re-evaluating", () => {
  assert.equal(formatValue(42, "scientific"), "42");
  assert.equal(formatValue(10n, "programmer", { bitWidth: 8, unsigned: true, base: 16 }), "0xA");
});

test("unit conversion handles compatible units and rejects incompatible ones", () => {
  assert.equal(convertUnit(1, "km", "m"), 1000);
  assert.ok(Math.abs(convertUnit(1, "kg", "lb") - 2.2046226218) < 1e-9);
  assert.equal(convertUnit(1024, "mb", "gb"), 1.024);
  assert.throws(() => convertUnit(1, "km", "s"), /Cannot convert/);
  assert.throws(() => convertUnit(1, "parsec", "m"), /Unknown source unit/);
});

test("unit metadata is sorted and grouped", () => {
  const units = availableUnits();
  assert.ok(units.includes("m"));
  assert.ok(units.includes("kg"));
  assert.deepEqual(unitGroups(), ["data", "length", "mass", "time"]);
});

test("the evaluator never delegates to JavaScript evaluation", () => {
  assert.doesNotMatch(source, /\beval\s*\(/);
  assert.doesNotMatch(source, /\bnew\s+Function\s*\(/);
  assert.throws(() => scientific("alert(1)"), /Unknown function/);
  assert.throws(() => scientific("window.location"), /Invalid character/);
});

test("expressions have bounded length and nesting", () => {
  assert.throws(() => scientific("1+".repeat(300)), /exceeds 512 characters/);
  assert.throws(() => scientific(`${"(".repeat(100)}1${")".repeat(100)}`), /nesting exceeds/);
});
