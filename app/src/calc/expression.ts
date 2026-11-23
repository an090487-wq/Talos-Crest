// Safe arithmetic evaluator for Talos Calc.
// No eval/Function and no access to browser or Node globals.

export type CalcMode = "scientific" | "programmer";
export type IntegerBase = 2 | 8 | 10 | 16;

export interface CalcOptions {
  bitWidth?: number;
  unsigned?: boolean;
  base?: IntegerBase;
}

export interface CalcResult {
  value: number | bigint;
  formatted: string;
}

type Token =
  | { kind: "number"; text: string; position: number }
  | { kind: "name"; text: string; position: number }
  | { kind: "operator"; text: string; position: number }
  | { kind: "paren"; text: "(" | ")"; position: number }
  | { kind: "comma"; position: number };

type Node =
  | { kind: "number"; value: number }
  | { kind: "integer"; value: bigint }
  | { kind: "constant"; name: string }
  | { kind: "unary"; op: string; operand: Node }
  | { kind: "binary"; op: string; left: Node; right: Node }
  | { kind: "call"; name: string; args: Node[] };

const MAX_EXPRESSION_LENGTH = 512;
const MAX_TOKENS = 256;
const MAX_DEPTH = 64;
const VALID_BIT_WIDTHS = [8, 16, 32, 64] as const;

const SCIENTIFIC_FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sqrt: Math.sqrt,
  abs: Math.abs,
  ln: Math.log,
  log: Math.log10,
  log10: Math.log10,
  exp: Math.exp,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
};

const SCIENTIFIC_CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

/** Adjacent value tokens imply multiplication, e.g. `(9)3`, `3(4)` or `2pi`. */
function addImplicitMultiplication(tokens: Token[]): Token[] {
  const result: Token[] = [];
  for (const token of tokens) {
    const previous = result[result.length - 1];
    const endsValue = previous !== undefined
      && (previous.kind === "number"
        || (previous.kind === "paren" && previous.text === ")")
        || (previous.kind === "name" && previous.text in SCIENTIFIC_CONSTANTS));
    const startsValue = token.kind === "number"
      || token.kind === "name"
      || (token.kind === "paren" && token.text === "(");
    if (endsValue && startsValue) {
      result.push({ kind: "operator", text: "*", position: token.position });
    }
    result.push(token);
  }
  return result;
}

function fail(message: string): never {
  throw new Error(message);
}

function normalizeBitWidth(value: number | undefined): number {
  const width = value ?? 32;
  if (!(VALID_BIT_WIDTHS as readonly number[]).includes(width)) {
    fail(`Unsupported bit width ${width}; use 8, 16, 32 or 64`);
  }
  return width;
}

function tokenizeScientific(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if ("+-*/^%,()".includes(char)) {
      if (char === ",") tokens.push({ kind: "comma", position: index });
      else if (char === "(" || char === ")") tokens.push({ kind: "paren", text: char, position: index });
      else tokens.push({ kind: "operator", text: char, position: index });
      index += 1;
      continue;
    }
    const numberMatch = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(input.slice(index));
    if (numberMatch) {
      tokens.push({ kind: "number", text: numberMatch[0], position: index });
      index += numberMatch[0].length;
      continue;
    }
    const nameMatch = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(input.slice(index));
    if (nameMatch) {
      tokens.push({ kind: "name", text: nameMatch[0].toLowerCase(), position: index });
      index += nameMatch[0].length;
      continue;
    }
    fail(`Invalid character '${char}' at position ${index + 1}`);
  }
  const expanded = addImplicitMultiplication(tokens);
  if (expanded.length > MAX_TOKENS) fail(`Expression has more than ${MAX_TOKENS} tokens`);
  return expanded;
}

function tokenizeProgrammer(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    const prefixed = /^(0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+)/.exec(input.slice(index));
    if (prefixed) {
      const next = input[prefixed[0].length + index];
      if (next && /[0-9a-zA-Z_]/.test(next)) {
        fail(`Invalid character '${next}' at position ${prefixed[0].length + index + 1}`);
      }
      tokens.push({ kind: "number", text: prefixed[0], position: index });
      index += prefixed[0].length;
      continue;
    }
    const decimal = /^\d+(?:\.\d*)?/.exec(input.slice(index));
    if (decimal) {
      if (decimal[0].includes(".")) fail("Programmer mode requires whole numbers");
      tokens.push({ kind: "number", text: decimal[0], position: index });
      index += decimal[0].length;
      continue;
    }
    if ("+-*/%()".includes(char)) {
      tokens.push(char === "(" || char === ")" ? { kind: "paren", text: char, position: index } : { kind: "operator", text: char, position: index });
      index += 1;
      continue;
    }
    if (input.startsWith("<<", index) || input.startsWith(">>", index)) {
      tokens.push({ kind: "operator", text: input.slice(index, index + 2), position: index });
      index += 2;
      continue;
    }
    if ("&|^~".includes(char)) {
      tokens.push({ kind: "operator", text: char, position: index });
      index += 1;
      continue;
    }
    fail(`Invalid character '${char}' at position ${index + 1}`);
  }
  const expanded = addImplicitMultiplication(tokens);
  if (expanded.length > MAX_TOKENS) fail(`Expression has more than ${MAX_TOKENS} tokens`);
  return expanded;
}

class Parser {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly mode: CalcMode,
  ) {}

  parse(): Node {
    if (this.tokens.length === 0) fail("Enter an expression");
    const node = this.expression(0);
    if (this.index < this.tokens.length) {
      const token = this.tokens[this.index];
      fail(`Unexpected token '${tokenText(token)}' at position ${token.position + 1}`);
    }
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private consume(text: string): boolean {
    const token = this.peek();
    if (!token || tokenText(token) !== text) return false;
    this.index += 1;
    return true;
  }

  private expectParen(text: "(" | ")"): void {
    if (!this.consume(text)) fail(`Expected '${text}'`);
  }

  private depthGuard(depth: number): void {
    if (depth > MAX_DEPTH) fail(`Expression nesting exceeds ${MAX_DEPTH} levels`);
  }

  private binary(depth: number, next: (level: number) => Node, operators: string[]): Node {
    this.depthGuard(depth);
    let left = next(depth + 1);
    while (true) {
      const token = this.peek();
      if (!token || token.kind !== "operator" || !operators.includes(token.text)) break;
      this.index += 1;
      const right = next(depth + 1);
      left = { kind: "binary", op: token.text, left, right };
    }
    return left;
  }

  private expression(depth: number): Node {
    return this.mode === "programmer" ? this.bitOr(depth + 1) : this.sum(depth + 1);
  }

  private bitOr(depth: number): Node {
    return this.binary(depth, (level) => this.bitXor(level), ["|"]);
  }

  private bitXor(depth: number): Node {
    return this.binary(depth, (level) => this.bitAnd(level), ["^"]);
  }

  private bitAnd(depth: number): Node {
    return this.binary(depth, (level) => this.shift(level), ["&"]);
  }

  private shift(depth: number): Node {
    return this.binary(depth, (level) => this.sum(level), ["<<", ">>"]);
  }

  private sum(depth: number): Node {
    return this.binary(depth, (level) => this.product(level), ["+", "-"]);
  }

  private product(depth: number): Node {
    const next = this.mode === "programmer" ? (level: number) => this.unary(level) : (level: number) => this.factor(level);
    return this.binary(depth, next, ["*", "/", "%"]);
  }

  private factor(depth: number): Node {
    this.depthGuard(depth);
    const token = this.peek();
    if (token && token.kind === "operator" && (token.text === "+" || token.text === "-")) {
      this.index += 1;
      return { kind: "unary", op: token.text, operand: this.factor(depth + 1) };
    }
    return this.power(depth + 1);
  }

  private power(depth: number): Node {
    this.depthGuard(depth);
    const left = this.primary(depth + 1);
    const token = this.peek();
    if (token && token.kind === "operator" && token.text === "^") {
      this.index += 1;
      const right = this.factor(depth + 1); // right associative, permits 2^-3
      return { kind: "binary", op: "^", left, right };
    }
    return left;
  }

  private unary(depth: number): Node {
    this.depthGuard(depth);
    const token = this.peek();
    if (token && token.kind === "operator" && ["+", "-", "~"].includes(token.text)) {
      this.index += 1;
      return { kind: "unary", op: token.text, operand: this.unary(depth + 1) };
    }
    return this.primary(depth + 1);
  }

  private primary(depth: number): Node {
    this.depthGuard(depth);
    const token = this.peek();
    if (!token) fail("Unexpected end of expression");

    if (token.kind === "paren" && token.text === "(") {
      this.index += 1;
      const node = this.expression(depth + 1);
      this.expectParen(")");
      return node;
    }

    if (token.kind === "number") {
      this.index += 1;
      if (this.mode === "programmer") return { kind: "integer", value: parseIntegerLiteral(token.text) };
      const value = Number(token.text);
      if (!Number.isFinite(value)) fail(`Number '${token.text}' is out of range`);
      return { kind: "number", value };
    }

    if (token.kind === "name") {
      this.index += 1;
      if (this.mode === "programmer") fail(`Names are not valid in Programmer mode at position ${token.position + 1}`);
      if (!this.consume("(")) {
        if (token.text in SCIENTIFIC_CONSTANTS) return { kind: "constant", name: token.text };
        fail(`Unknown name '${token.text}'`);
      }
      const args: Node[] = [];
      if (!this.consume(")")) {
        do {
          args.push(this.expression(depth + 1));
        } while (this.consume(","));
        this.expectParen(")");
      }
      if (!(token.text in SCIENTIFIC_FUNCTIONS)) fail(`Unknown function '${token.text}'`);
      return { kind: "call", name: token.text, args };
    }

    fail(`Unexpected token '${tokenText(token)}' at position ${token.position + 1}`);
  }
}

function tokenText(token: Token): string {
  return token.kind === "comma" ? "," : token.text;
}

function parseIntegerLiteral(text: string): bigint {
  if (/^0[xXoObB]/.test(text)) return BigInt(text);
  return BigInt(text);
}

function evaluateNode(node: Node, mode: CalcMode, bitWidth: number): number | bigint {
  switch (node.kind) {
    case "number":
      return node.value;
    case "integer":
      return mode === "programmer" ? normalizeInteger(node.value, bitWidth, false) : Number(node.value);
    case "constant":
      return SCIENTIFIC_CONSTANTS[node.name];
    case "unary": {
      const value = evaluateNode(node.operand, mode, bitWidth);
      if (mode === "programmer") {
        const integer = toBigInt(value);
        if (node.op === "+") return normalizeInteger(integer, bitWidth, false);
        if (node.op === "-") return normalizeInteger(-integer, bitWidth, false);
        return normalizeInteger(~integer, bitWidth, false);
      }
      const number = toNumber(value);
      if (node.op === "+") return number;
      if (node.op === "-") return -number;
      fail("Bitwise NOT is only available in Programmer mode");
    }
    case "call": {
      const fn = SCIENTIFIC_FUNCTIONS[node.name];
      const args = node.args.map((arg) => toNumber(evaluateNode(arg, mode, bitWidth)));
      const result = fn(...args);
      if (!Number.isFinite(result)) fail(`Function '${node.name}' produced an invalid result`);
      return result;
    }
    case "binary": {
      if (mode === "programmer") {
        const left = toBigInt(evaluateNode(node.left, mode, bitWidth));
        const right = toBigInt(evaluateNode(node.right, mode, bitWidth));
        switch (node.op) {
          case "+": return normalizeInteger(left + right, bitWidth, false);
          case "-": return normalizeInteger(left - right, bitWidth, false);
          case "*": return normalizeInteger(left * right, bitWidth, false);
          case "/":
            if (right === 0n) fail("Division by zero");
            return normalizeInteger(left / right, bitWidth, false);
          case "%":
            if (right === 0n) fail("Division by zero");
            return normalizeInteger(left % right, bitWidth, false);
          case "&": return normalizeInteger(left & right, bitWidth, false);
          case "|": return normalizeInteger(left | right, bitWidth, false);
          case "^": return normalizeInteger(left ^ right, bitWidth, false);
          case "<<":
          case ">>": {
            if (right < 0n || right > 1024n) fail(`Shift amount must be between 0 and 1024`);
            return normalizeInteger(node.op === "<<" ? left << right : left >> right, bitWidth, false);
          }
          default: fail(`Unsupported operator '${node.op}'`);
        }
      }
      const left = toNumber(evaluateNode(node.left, mode, bitWidth));
      const right = toNumber(evaluateNode(node.right, mode, bitWidth));
      switch (node.op) {
        case "+": return left + right;
        case "-": return left - right;
        case "*": return left * right;
        case "/":
          if (right === 0) fail("Division by zero");
          return left / right;
        case "%":
          if (right === 0) fail("Division by zero");
          return left % right;
        case "^": {
          const result = Math.pow(left, right);
          if (!Number.isFinite(result)) fail("Power produced an out-of-range result");
          return result;
        }
        default: fail(`Unsupported operator '${node.op}'`);
      }
    }
  }
}

function toNumber(value: number | bigint): number {
  return typeof value === "number" ? value : Number(value);
}

function toBigInt(value: number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (!Number.isFinite(value) || !Number.isInteger(value)) fail("Programmer mode requires whole numbers");
  return BigInt(Math.trunc(value));
}

function normalizeInteger(value: bigint, bitWidth: number, unsigned: boolean): bigint {
  const bits = BigInt(bitWidth);
  const modulus = 1n << bits;
  let normalized = value % modulus;
  if (normalized < 0n) normalized += modulus;
  if (!unsigned) {
    const signBit = 1n << (bits - 1n);
    if (normalized >= signBit) normalized -= modulus;
  }
  return normalized;
}

function formatScientific(value: number): string {
  if (!Number.isFinite(value)) fail("Result is not finite");
  if (Object.is(value, -0)) return "0";
  const absolute = Math.abs(value);
  if (absolute !== 0 && (absolute >= 1e12 || absolute < 1e-9)) return value.toExponential(10).replace(/\.?0+e/, "e");
  return Number.parseFloat(value.toPrecision(12)).toString();
}

function formatInteger(
  value: bigint,
  bitWidth: number,
  base: IntegerBase,
  unsigned: boolean,
  expressionSafe = false,
): string {
  const bits = BigInt(bitWidth);
  const modulus = 1n << bits;
  const masked = ((value % modulus) + modulus) % modulus;
  const signBit = 1n << (bits - 1n);
  const isNegative = !unsigned && masked >= signBit;
  const magnitude = isNegative ? masked - modulus : masked;

  if (base === 10) return magnitude.toString();
  const prefix = base === 2 ? "0b" : base === 8 ? "0o" : "0x";
  const digits = masked.toString(base).toUpperCase();
  // Display annotations are helpful in the UI but make the text invalid as an
  // expression. Insert/Copy must always produce something re-evaluable.
  return `${prefix}${digits}${!expressionSafe && isNegative ? " (two's complement)" : ""}`;
}

export function evaluate(input: string, mode: CalcMode, options: CalcOptions = {}): CalcResult {
  if (typeof input !== "string") fail("Expression must be text");
  const expression = input.trim();
  if (expression.length === 0) fail("Enter an expression");
  if (expression.length > MAX_EXPRESSION_LENGTH) fail(`Expression exceeds ${MAX_EXPRESSION_LENGTH} characters`);

  if (mode === "scientific") {
    const node = new Parser(tokenizeScientific(expression), mode).parse();
    const value = toNumber(evaluateNode(node, mode, 32));
    return { value, formatted: formatScientific(value) };
  }

  const bitWidth = normalizeBitWidth(options.bitWidth);
  const unsigned = options.unsigned ?? false;
  const base = options.base ?? 10;
  const node = new Parser(tokenizeProgrammer(expression), mode).parse();
  const value = toBigInt(evaluateNode(node, mode, bitWidth));
  return { value, formatted: formatInteger(value, bitWidth, base, unsigned) };
}

export function formatValue(
  value: number | bigint,
  mode: CalcMode,
  options: CalcOptions = {},
  expressionSafe = false,
): string {
  if (mode === "scientific") return formatScientific(toNumber(value));
  const bitWidth = normalizeBitWidth(options.bitWidth);
  return formatInteger(toBigInt(value), bitWidth, options.base ?? 10, options.unsigned ?? false, expressionSafe);
}

const UNIT_FACTORS: Record<string, { group: string; factor: number }> = {
  m: { group: "length", factor: 1 },
  km: { group: "length", factor: 1000 },
  cm: { group: "length", factor: 0.01 },
  mm: { group: "length", factor: 0.001 },
  mi: { group: "length", factor: 1609.344 },
  ft: { group: "length", factor: 0.3048 },
  in: { group: "length", factor: 0.0254 },
  kg: { group: "mass", factor: 1 },
  g: { group: "mass", factor: 0.001 },
  lb: { group: "mass", factor: 0.45359237 },
  oz: { group: "mass", factor: 0.028349523125 },
  s: { group: "time", factor: 1 },
  min: { group: "time", factor: 60 },
  h: { group: "time", factor: 3600 },
  d: { group: "time", factor: 86400 },
  b: { group: "data", factor: 1 },
  kb: { group: "data", factor: 1000 },
  mb: { group: "data", factor: 1e6 },
  gb: { group: "data", factor: 1e9 },
  tb: { group: "data", factor: 1e12 },
};

export function convertUnit(value: number, fromUnit: string, toUnit: string): number {
  if (!Number.isFinite(value)) fail("Value must be finite");
  const from = UNIT_FACTORS[fromUnit.toLowerCase()];
  const to = UNIT_FACTORS[toUnit.toLowerCase()];
  if (!from) fail(`Unknown source unit '${fromUnit}'`);
  if (!to) fail(`Unknown target unit '${toUnit}'`);
  if (from.group !== to.group) fail(`Cannot convert ${fromUnit} to ${toUnit}`);
  if (from.group === "temperature") {
    // Reserved for future implementation; temperature needs offset conversion.
    fail("Temperature conversion is not available yet");
  }
  return (value * from.factor) / to.factor;
}

export function availableUnits(): string[] {
  return Object.keys(UNIT_FACTORS).sort();
}

// Kept as a named export for tests and future UI grouping without exposing mutable data.
export function unitGroups(): string[] {
  const groups = new Set<string>();
  for (const unit of Object.values(UNIT_FACTORS)) groups.add(unit.group);
  return [...groups].sort();
}

export function unitsByGroup(): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const [unit, info] of Object.entries(UNIT_FACTORS)) {
    (grouped[info.group] ??= []).push(unit);
  }
  for (const units of Object.values(grouped)) units.sort();
  return grouped;
}
