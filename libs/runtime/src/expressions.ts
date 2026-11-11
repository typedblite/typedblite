import {
  isBinaryExpression,
  isBooleanLiteral,
  isDateLiteral,
  isDatetimeLiteral,
  isDatetimeTzLiteral,
  isDurationLiteral,
  isComparisonPattern,
  isDecimalLiteral,
  isDoubleLiteral,
  isFunctionExpression,
  isIntLiteral,
  isLabelExpression,
  isLetPattern,
  isLiteralExpression,
  isNegationExpression,
  isStringLiteral,
  isVariableExpression,
  type ComparisonPattern,
  type Expression,
  type LetPattern,
  type Pattern,
} from '@typedblite/language';
import type { Range } from 'vscode-languageserver';
import { DiagnosticCode, rangeOf } from './diagnostics.js';
import { callSchemaFunction, checkSchemaCall, isSchemaFunction, schemaFunctionWidth, type ArgumentShape, type SchemaArgument } from './schema-functions.js';
import type { Refuse, SchemaFacts } from './schema-rules.js';
import { canonicalTemporal, temporalArithmetic, temporalResultType, type TemporalValue } from './temporal.js';

/**
 * Value expressions — Phase 06 of the conformance feature.
 *
 * A value is a `Numeric` — an integer as a `BigInt`, a double as a `number`, a decimal as a
 * scaled `BigInt` (`10.2dec` is `102` at scale 1) — or a string or boolean, carried as text. The
 * promotion rules are `expression.feature`'s *operator definitions* tables, read off the pin:
 * integer ∘ integer → integer; any double → double; decimal ∘ integer → decimal; decimal ∘ double
 * → double; and **`/` is always a double** — even `6.0dec / 3.0dec` (L406). `round` is half to
 * even (L920: 12.5 → 12, -11.5 → -12).
 *
 * 🔴 Decimals never pass through a `number`. `61.8dec + 86.5dec + 24.8dec` is `173.1dec` exactly
 * (reduce.feature L122), and a float would make it `173.10000000000002`.
 */
export type ValueType = 'integer' | 'double' | 'decimal' | 'string' | 'boolean' | 'date' | 'datetime' | 'datetime-tz' | 'duration';

const NUMERIC_TYPES = new Set(['integer', 'long', 'double', 'decimal']);
/** Carried as text: a string, a boolean, and the temporal types this phase does not compute with. */
const TEMPORAL_TYPES = new Set(['date', 'datetime', 'datetime-tz', 'duration']);
const isNumericType = (valueType: string): boolean => NUMERIC_TYPES.has(valueType);
/** `long` is `integer` (review, round 16). */
const normaliseType = (valueType: string): string => (valueType === 'long' ? 'integer' : valueType);

export interface Value {
  readonly valueType: ValueType;
  /** The value as TypeQLite text — `9`, `2.0`, `173.1`, `"a"`'s content, `true`. */
  readonly text: string;
}

/** A value bound in a combination — an attribute's, with its type, or a `let`'s. */
export type ValueBinding =
  | { readonly kind: 'attribute'; readonly attributeType: string; readonly valueType: string; readonly value: string }
  | { readonly kind: 'value'; readonly valueType: string; readonly value: string };

type Numeric =
  | { readonly kind: 'integer'; readonly value: bigint }
  | { readonly kind: 'double'; readonly value: number }
  | { readonly kind: 'decimal'; readonly unscaled: bigint; readonly scale: number };

// ⚠️ No bigint literals (`0n`) and no `**` on a bigint anywhere in this file:
// `persistence-infrastructure` and `document-store-infrastructure` typecheck these sources under
// a pre-ES2020 target, and both forms are refused there (TS2737, TS2791). `BigInt(…)`, `ZERO`
// and `pow10` are the spelling.
const ZERO = BigInt(0);
const ONE = BigInt(1);
/** `10^n` as a bigint — for rescaling decimals. */
const pow10 = (n: number): bigint => BigInt(`1${'0'.repeat(n)}`);
export const INTEGER_MIN = -BigInt('9223372036854775808');
export const INTEGER_MAX = BigInt('9223372036854775807');

// ── parsing values ──────────────────────────────────────────────────────────

function toNumeric(valueType: string, text: string, refuse: Refuse, at: Range | undefined): Numeric {
  switch (valueType) {
    case 'integer':
    case 'long': {
      if (!/^-?\d+$/.test(text)) return refuse(DiagnosticCode.valueTypeConflict, `'${text}' is not an integer.`, at);
      return { kind: 'integer', value: BigInt(text) };
    }
    case 'double': {
      const value = Number(text);
      if (Number.isNaN(value)) return refuse(DiagnosticCode.valueTypeConflict, `'${text}' is not a double.`, at);
      return { kind: 'double', value };
    }
    case 'decimal':
      return parseDecimal(text, refuse, at);
    default:
      return refuse(DiagnosticCode.valueTypeConflict, `A '${valueType}' has no arithmetic; '${text}' cannot be an operand.`, at);
  }
}

/**
 * A decimal from its text — `10.2dec`, `10.2`, `-5`, and a double's `1.0e2` or `1e+21` stored on
 * a decimal attribute (review, round 3): the exponent is applied exactly, never through a float.
 */
function parseDecimal(text: string, refuse: Refuse, at: Range | undefined, literal = true): Numeric {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text.replace(/dec$/, ''));
  if (!match) return refuse(DiagnosticCode.valueTypeConflict, `'${text}' is not a decimal.`, at);
  const [, sign, whole, fraction = '', exponent = '0'] = match;
  let unscaled = BigInt(`${sign}${whole}${fraction}`);
  let scale = fraction.length;
  const shift = Number(exponent);
  if (shift > 0) {
    if (shift > 400) return refuse(DiagnosticCode.valueOutOfRange, `Decimal overflow: ${text} is outside the 64-bit range.`, at);
    if (shift >= scale) { unscaled = unscaled * pow10(shift - scale); scale = 0; } else scale -= shift;
  } else if (shift < 0) {
    if (shift < -400) return refuse(DiagnosticCode.valueOutOfRange, `Decimal precision: ${text} has more fractional digits than a decimal holds.`, at);
    scale += -shift;
  }
  // A LITERAL with more fractional digits than a decimal holds is refused, never silently zero
  // (QA, B2); a computed result is cut to nineteen in `checkedDecimal`.
  if (literal && scale > DECIMAL_SCALE) {
    return refuse(DiagnosticCode.valueOutOfRange, `Decimal precision: ${text} has more fractional digits than a decimal holds.`, at);
  }
  if (scale > DECIMAL_SCALE + 400) {
    return refuse(DiagnosticCode.valueOutOfRange, `Decimal precision: ${text} has more fractional digits than a decimal holds.`, at);
  }
  return checkedDecimal({ kind: 'decimal', unscaled, scale }, refuse, at);
}

const formatDecimal = (unscaled: bigint, scale: number): string => {
  const negative = unscaled < ZERO;
  const digits = (negative ? -unscaled : unscaled).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? '-' : ''}${whole}${scale > 0 ? `.${fraction}` : ''}`;
};

const toDouble = (n: Numeric): number =>
  n.kind === 'double' ? n.value : n.kind === 'integer' ? Number(n.value) : Number(n.unscaled) / Number(pow10(n.scale));

const toDecimal = (n: Numeric): { unscaled: bigint; scale: number } =>
  n.kind === 'decimal' ? n : n.kind === 'integer' ? { unscaled: n.value, scale: 0 } : parseDecimalFromDouble(n.value);

function parseDecimalFromDouble(value: number): { unscaled: bigint; scale: number } {
  // `1e+21` included: the same reader as a decimal attribute's text, with nothing to refuse
  // that a finite double could carry past `checkedDouble`.
  const parsed = parseDecimal(value.toString(), () => { throw new Error(`'${value}' is not a decimal`); }, undefined);
  return parsed.kind === 'decimal' ? parsed : { unscaled: ZERO, scale: 0 };
}

function toValue(n: Numeric): Value {
  switch (n.kind) {
    case 'integer':
      return { valueType: 'integer', text: n.value.toString() };
    case 'double':
      return { valueType: 'double', text: formatDouble(n.value) };
    case 'decimal':
      return { valueType: 'decimal', text: formatDecimal(n.unscaled, n.scale) };
  }
}

/**
 * `2` → `2.0`: a double reads as one, as the spec's `value:double:2.0` does. Past 1e21 JavaScript
 * renders `1e+21`, which `Number()` reads back and `1e+21.0` would not (review, round 1).
 */
const formatDouble = (value: number): string =>
  Number.isInteger(value) && Math.abs(value) < 1e21 ? `${value}.0` : String(value);

/**
 * `1.8e308` is not a double TypeDB holds (expression.feature L668), and neither is what
 * `log10(-1.0)` produces — an overflow and an undefined result, each named as what it is
 * (review, round 4).
 */
function checkedDouble(value: number, refuse: Refuse, at: Range | undefined): Numeric {
  if (Number.isNaN(value)) return refuse(DiagnosticCode.valueOutOfRange, 'The result is not a number: the operation is undefined for these operands.', at);
  if (!Number.isFinite(value)) return refuse(DiagnosticCode.valueOutOfRange, `Double overflow: the value is outside the 64-bit range.`, at);
  return { kind: 'double', value };
}

/** A decimal whose integer part is outside 64 bits is refused, as the literal form is (L680). */
/** TypeDB's decimal carries nineteen fractional digits; a result with more is cut to nineteen, toward zero. */
const DECIMAL_SCALE = 19;

function checkedDecimal(value: Numeric & { kind: 'decimal' }, refuse: Refuse, at: Range | undefined): Numeric {
  // The integer part by FLOOR — TypeDB's decimal is an i64 integer part and an unsigned fraction,
  // so `-9223372036854775808.5dec` has integer part −2^63−1 and is outside it (QA, B6).
  const divisor = pow10(value.scale);
  const truncated = value.unscaled / divisor;
  const integerPart = value.unscaled < ZERO && value.unscaled % divisor !== ZERO ? truncated - ONE : truncated;
  if (integerPart < INTEGER_MIN || integerPart > INTEGER_MAX) {
    return refuse(DiagnosticCode.valueOutOfRange, `Decimal overflow: ${formatDecimal(value.unscaled, value.scale)} is outside the 64-bit range.`, at);
  }
  // `0.1dec` twenty-two times over has twenty-two fractional digits; a decimal holds nineteen,
  // in a `let` as in a `mean` (review, round 11).
  if (value.scale > DECIMAL_SCALE) {
    return { kind: 'decimal', unscaled: value.unscaled / pow10(value.scale - DECIMAL_SCALE), scale: DECIMAL_SCALE };
  }
  return value;
}

function checkedInteger(value: bigint, refuse: Refuse, at: Range | undefined): Numeric {
  if (value < INTEGER_MIN || value > INTEGER_MAX) {
    return refuse(DiagnosticCode.valueOutOfRange, `Integer overflow: ${value} is outside the 64-bit range.`, at);
  }
  return { kind: 'integer', value };
}

// ── arithmetic ──────────────────────────────────────────────────────────────

function arithmetic(operator: string, left: Numeric, right: Numeric, refuse: Refuse, at: Range | undefined): Numeric {
  // `/` and `^` are always doubles (expression.feature L352, L406, L1265).
  if (operator === '^') return checkedDouble(toDouble(left) ** toDouble(right), refuse, at);
  if (operator === '/') {
    const divisor = toDouble(right);
    if (divisor === 0) return refuse(DiagnosticCode.valueOutOfRange, 'Division by zero.', at);
    return checkedDouble(toDouble(left) / divisor, refuse, at);
  }
  if (left.kind === 'double' || right.kind === 'double') {
    const a = toDouble(left);
    const b = toDouble(right);
    // Every result through `checkedDouble`: `1.0e308 * 10.0` is an overflow, not an `Infinity`
    // cell, and `5.0 % 0.0` is refused as the integer and decimal forms are (review, round 1).
    switch (operator) {
      case '+': return checkedDouble(a + b, refuse, at);
      case '-': return checkedDouble(a - b, refuse, at);
      case '*': return checkedDouble(a * b, refuse, at);
      case '%': return b === 0 ? refuse(DiagnosticCode.valueOutOfRange, 'Modulo by zero.', at) : checkedDouble(a % b, refuse, at);
      case '^': return checkedDouble(a ** b, refuse, at);
    }
  }
  if (left.kind === 'decimal' || right.kind === 'decimal') {
    const a = toDecimal(left);
    const b = toDecimal(right);
    const scale = Math.max(a.scale, b.scale);
    const au = a.unscaled * pow10(scale - a.scale);
    const bu = b.unscaled * pow10(scale - b.scale);
    // Every decimal result through `checkedDecimal`: its integer part is 64-bit, as a literal's
    // is (review, round 2).
    switch (operator) {
      case '+': return checkedDecimal({ kind: 'decimal', unscaled: au + bu, scale }, refuse, at);
      case '-': return checkedDecimal({ kind: 'decimal', unscaled: au - bu, scale }, refuse, at);
      case '*': return checkedDecimal({ kind: 'decimal', unscaled: a.unscaled * b.unscaled, scale: a.scale + b.scale }, refuse, at);
      case '%': return bu === ZERO ? refuse(DiagnosticCode.valueOutOfRange, 'Modulo by zero.', at) : { kind: 'decimal', unscaled: au % bu, scale };
      case '^': return checkedDouble(toDouble(left) ** toDouble(right), refuse, at);
    }
  }
  if (left.kind === 'integer' && right.kind === 'integer') {
    switch (operator) {
      case '+': return checkedInteger(left.value + right.value, refuse, at);
      case '-': return checkedInteger(left.value - right.value, refuse, at);
      case '*': return checkedInteger(left.value * right.value, refuse, at);
      case '%': return right.value === ZERO ? refuse(DiagnosticCode.valueOutOfRange, 'Modulo by zero.', at) : { kind: 'integer', value: left.value % right.value };
      // `^` is a double whatever its operands, as `/` is: `6 * 5 ^ 3 + 2` is `value:double:752.0`
      // (expression.feature L1265), `2 ^ 2 ^ 2 ^ 2` is `value:double:65536` (L1318) — review, round 6.
      case '^': return checkedDouble(Number(left.value) ** Number(right.value), refuse, at);
    }
  }
  return refuse(DiagnosticCode.valueTypeConflict, `Operator '${operator}' is not defined for these operands.`, at);
}

// ── the built-ins ───────────────────────────────────────────────────────────

/** The built-ins, by bare name: their namespace and arity (expression.feature L853–995, L2385). */
const BUILTINS: Readonly<Record<string, { namespace: string; arity: number }>> = {
  abs: { namespace: 'std::math', arity: 1 },
  ceil: { namespace: 'std::math', arity: 1 },
  floor: { namespace: 'std::math', arity: 1 },
  round: { namespace: 'std::math', arity: 1 },
  log10: { namespace: 'std::math', arity: 1 },
  max: { namespace: 'std::math', arity: 2 },
  min: { namespace: 'std::math', arity: 2 },
  len: { namespace: 'std::string', arity: 1 },
};

function builtin(name: string, args: readonly Evaluated[], refuse: Refuse, at: Range | undefined): Evaluated {
  const separator = name.lastIndexOf('::');
  const bare = separator < 0 ? name : name.slice(separator + 2);
  // Own keys only: `constructor(1)` is not a built-in (review, round 11).
  const known = Object.prototype.hasOwnProperty.call(BUILTINS, bare) ? BUILTINS[bare] : undefined;
  if (known === undefined || (name.includes('::') && name !== `${known.namespace}::${bare}`)) {
    return refuse(DiagnosticCode.unknownFunction, `Unknown function '${name}'.`, at);
  }
  if (args.length !== known.arity) {
    return refuse(DiagnosticCode.functionArity, `Function '${bare}' expects '${known.arity}' arguments but received '${args.length}'.`, at);
  }
  const qualified = `${known.namespace}::${bare}`;
  const notApplicable = (type: string): never =>
    refuse(DiagnosticCode.valueTypeConflict, `Built-in function '${qualified}' cannot be applied to arguments of type '${type}'.`, at);
  const [a, b] = args;
  if (bare === 'len') {
    // Unicode scalar values, not UTF-16 units: `"❤️‍🔥"` is 4 (L978).
    return a.kind === 'text' && a.value.valueType === 'string'
      ? { kind: 'integer', value: BigInt([...a.value.text].length) }
      : notApplicable(kindOf(a));
  }
  if (a.kind === 'text') return notApplicable(kindOf(a));
  switch (bare) {
    case 'abs':
      // `abs(INTEGER_MIN)` is one past INTEGER_MAX (review, round 2).
      return a.kind === 'integer'
        ? checkedInteger(a.value < ZERO ? -a.value : a.value, refuse, at)
        : a.kind === 'double'
          ? { kind: 'double', value: Math.abs(a.value) }
          : checkedDecimal({ kind: 'decimal', unscaled: a.unscaled < ZERO ? -a.unscaled : a.unscaled, scale: a.scale }, refuse, at);
    case 'ceil':
    case 'floor':
    case 'round': {
      // Doubles and decimals round to an integer — half to even (L920); an integer is refused (L990).
      if (a.kind === 'integer') return notApplicable('integer');
      if (a.kind === 'decimal') return checkedInteger(roundDecimal(a, bare), refuse, at);
      const value = toDouble(a);
      const rounded = bare === 'ceil' ? Math.ceil(value) : bare === 'floor' ? Math.floor(value) : roundHalfEven(value);
      return checkedInteger(BigInt(rounded), refuse, at);
    }
    case 'log10':
      return checkedDouble(Math.log10(toDouble(a)), refuse, at);
    case 'max':
    case 'min': {
      if (b === undefined || b.kind === 'text' || a.kind !== b.kind) {
        return refuse(DiagnosticCode.valueTypeConflict, `Function '${bare}' expects matching argument types.`, at);
      }
      return compareNumeric(a, b) >= 0 === (bare === 'max') ? a : b;
    }
  }
  return refuse(DiagnosticCode.unknownFunction, `Unknown function '${name}'.`, at);
}

const kindOf = (evaluated: Evaluated): string => (evaluated.kind === 'text' ? evaluated.value.valueType : evaluated.kind);

/**
 * `ceil`, `floor` and half-to-even `round` of a decimal, exactly — `floor(1234567890123456789.5dec)`
 * keeps every digit a double would drop (review, round 3).
 */
function roundDecimal(value: Numeric & { kind: 'decimal' }, mode: string): bigint {
  const divisor = pow10(value.scale);
  const quotient = value.unscaled / divisor; // truncates toward zero
  const remainder = value.unscaled % divisor; // carries the sign of `unscaled`
  if (remainder === ZERO) return quotient;
  const floor = value.unscaled < ZERO ? quotient - ONE : quotient;
  if (mode === 'floor') return floor;
  if (mode === 'ceil') return floor + ONE;
  const twiceFraction = (remainder < ZERO ? remainder + divisor : remainder) * BigInt(2);
  if (twiceFraction < divisor) return floor;
  if (twiceFraction > divisor) return floor + ONE;
  return floor % BigInt(2) === ZERO ? floor : floor + ONE;
}

function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

function compareNumeric(a: Numeric, b: Numeric): number {
  if (a.kind === 'integer' && b.kind === 'integer') return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  if (a.kind === 'double' || b.kind === 'double') {
    const x = toDouble(a);
    const y = toDouble(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = toDecimal(a);
  const y = toDecimal(b);
  const scale = Math.max(x.scale, y.scale);
  const xu = x.unscaled * pow10(scale - x.scale);
  const yu = y.unscaled * pow10(scale - y.scale);
  return xu < yu ? -1 : xu > yu ? 1 : 0;
}

// ── evaluating ──────────────────────────────────────────────────────────────

export type Environment = (variable: string) => ValueBinding | undefined;

/**
 * What a schema function reads beyond values: the applied schema, and the label a type variable
 * is bound to in this combination (`$ty label person; let $d = get_doc($ty);`).
 */
export interface SchemaContext {
  readonly facts: SchemaFacts;
  readonly typeOf: (variable: string) => string | undefined;
}

const bareName = (name: string): string => {
  const separator = name.lastIndexOf('::');
  return separator < 0 ? name : name.slice(separator + 2);
};

/** `get_doc(…)`, `label(…)` — a call `schema-functions.ts` answers, not `builtin`. */
const isSchemaCall = (expression: Expression): boolean =>
  isFunctionExpression(expression) && isSchemaFunction(bareName(expression.function));

/**
 * The variables a schema call takes as its own arguments — which may be TYPE variables, and so are
 * exempt from the "a type is not an operand" refusal that applies everywhere else.
 */
function typeArgumentsOf(expression: Expression): string[] {
  if (isSchemaCall(expression) && isFunctionExpression(expression)) {
    return expression.arguments.flatMap((argument) => (isVariableExpression(argument) ? [argument.variable] : []));
  }
  if (isBinaryExpression(expression)) return [...typeArgumentsOf(expression.left), ...typeArgumentsOf(expression.right)];
  if (isNegationExpression(expression)) return typeArgumentsOf(expression.operand);
  if (isFunctionExpression(expression)) return expression.arguments.flatMap(typeArgumentsOf);
  return [];
}

/** Every tuple a schema call answers, its arguments resolved in this combination. */
function schemaTuples(expression: Expression, env: Environment, refuse: Refuse, schema: SchemaContext | undefined): ReadonlyArray<ReadonlyArray<Value>> {
  const at = rangeOf(expression);
  if (!isFunctionExpression(expression)) return refuse(DiagnosticCode.notImplemented, 'TypeDBLite does not evaluate this expression yet.', at);
  if (schema === undefined) {
    return refuse(DiagnosticCode.notImplemented, `TypeDBLite does not evaluate '${expression.function}' here.`, at);
  }
  const args = expression.arguments.map((argument): SchemaArgument => {
    if (isLabelExpression(argument)) return { kind: 'type', label: argument.label };
    if (isVariableExpression(argument)) {
      const label = schema.typeOf(argument.variable);
      if (label !== undefined) return { kind: 'type', label };
    }
    return { kind: 'value', value: evaluate(argument, env, refuse, schema) };
  });
  return callSchemaFunction(expression.function, args, schema.facts, refuse, at);
}

/** The variables an expression reads. */
export function variablesOf(expression: Expression): string[] {
  if (isVariableExpression(expression)) return [expression.variable];
  if (isBinaryExpression(expression)) return [...variablesOf(expression.left), ...variablesOf(expression.right)];
  if (isNegationExpression(expression)) return variablesOf(expression.operand);
  if (isFunctionExpression(expression)) return expression.arguments.flatMap(variablesOf);
  return [];
}

/** Evaluate an expression to a value; every variable it reads must be bound in `env`. */
export function evaluate(expression: Expression, env: Environment, refuse: Refuse, schema?: SchemaContext): Value {
  const numeric = evaluateNumeric(expression, env, refuse, schema);
  return numeric.kind === 'text' ? numeric.value : toValue(numeric);
}

type Evaluated = Numeric | { kind: 'text'; value: Value };

function evaluateNumeric(expression: Expression, env: Environment, refuse: Refuse, schema?: SchemaContext): Evaluated {
  const at = rangeOf(expression);
  if (isLiteralExpression(expression)) {
    const literal = expression.literal;
    // 🔴 The literal's TEXT, not the AST's number: `INT returns number`, and `9223372036854775807`
    // has already rounded to 2^63 by the time it is a `number` (expression.feature L656).
    if (isIntLiteral(literal)) return checkedInteger(BigInt(literal.$cstNode?.text.trim() ?? literal.value), refuse, at);
    if (isDoubleLiteral(literal)) return checkedDouble(Number(literal.value), refuse, at);
    if (isDecimalLiteral(literal)) return parseDecimal(literal.value, refuse, at);
    if (isStringLiteral(literal)) return { kind: 'text', value: { valueType: 'string', text: literal.value } };
    if (isBooleanLiteral(literal)) return { kind: 'text', value: { valueType: 'boolean', text: literal.value } };
    // A temporal literal is carried as text, as a temporal attribute is: `$d == 2020-01-01`
    // compares as written (review, round 9); its arithmetic is refused by name where it is used.
    // A temporal literal is checked as it is read — an out-of-range date, a zoned time in a gap or an
    // overlap, a duration over the limit are refused here (expression.feature L692–L837) — and
    // carried in its one spelling.
    if (isDateLiteral(literal)) return { kind: 'text', value: { valueType: 'date', text: canonicalTemporal('date', literal.value, refuse, at) } };
    if (isDatetimeLiteral(literal)) return { kind: 'text', value: { valueType: 'datetime', text: canonicalTemporal('datetime', literal.value, refuse, at) } };
    if (isDatetimeTzLiteral(literal)) return { kind: 'text', value: { valueType: 'datetime-tz', text: canonicalTemporal('datetime-tz', literal.value, refuse, at) } };
    if (isDurationLiteral(literal)) return { kind: 'text', value: { valueType: 'duration', text: canonicalTemporal('duration', literal.value, refuse, at) } };
    return refuse(DiagnosticCode.notImplemented, `TypeDBLite does not evaluate a ${(literal as { $type: string }).$type} in an expression yet.`, at);
  }
  if (isVariableExpression(expression)) {
    const bound = env(expression.variable);
    if (bound === undefined) {
      return refuse(
        DiagnosticCode.unboundValue,
        `The variable '${expression.variable.slice(1)}' must be bound to a value before it's used.`,
        at,
      );
    }
    if (!isNumericType(bound.valueType)) {
      // A string, a boolean, or a temporal value — carried as text; `let $v = $d` passes a date
      // through, and arithmetic on it is refused by name below (review, round 7).
      return { kind: 'text', value: { valueType: bound.valueType as ValueType, text: bound.value } };
    }
    return toNumeric(bound.valueType, bound.value, refuse, at);
  }
  if (isNegationExpression(expression)) {
    // `-9223372036854775808` is INTEGER_MIN, and its operand alone is one past INTEGER_MAX: a
    // negated integer or decimal literal is read as one signed text, not range-checked and then
    // negated (review, round 2). Same for `-9223372036854775808.0dec`.
    const operand = expression.operand;
    if (isLiteralExpression(operand) && isIntLiteral(operand.literal)) {
      return checkedInteger(-BigInt(operand.literal.$cstNode?.text.trim() ?? operand.literal.value), refuse, at);
    }
    if (isLiteralExpression(operand) && isDecimalLiteral(operand.literal)) {
      return parseDecimal(`-${operand.literal.value}`, refuse, at);
    }
    const value = numericOrRefuse(evaluateNumeric(operand, env, refuse, schema), refuse, at);
    return arithmetic('-', { kind: 'integer', value: ZERO }, value, refuse, at);
  }
  if (isBinaryExpression(expression)) {
    const left = evaluateNumeric(expression.left, env, refuse, schema);
    const right = evaluateNumeric(expression.right, env, refuse, schema);
    if (left.kind === 'text' && right.kind === 'text' && expression.operator === '+' && left.value.valueType === 'string' && right.value.valueType === 'string') {
      return { kind: 'text', value: { valueType: 'string', text: left.value.text + right.value.text } };
    }
    // Dates, datetimes and durations add and subtract by TypeDB's table — `temporal.ts`.
    if (left.kind === 'text' && right.kind === 'text' && TEMPORAL_TYPES.has(left.value.valueType) && TEMPORAL_TYPES.has(right.value.valueType)) {
      const result = temporalArithmetic(expression.operator, left.value as TemporalValue, right.value as TemporalValue, refuse, at);
      return { kind: 'text', value: result };
    }
    return arithmetic(expression.operator, numericOrRefuse(left, refuse, at), numericOrRefuse(right, refuse, at), refuse, at);
  }
  if (isSchemaCall(expression)) {
    // Inside an expression a schema call must be one value: `get_doc(person) + "!"`. A call that
    // answers no row or a tuple has no single value to compute with.
    const tuples = schemaTuples(expression, env, refuse, schema);
    if (tuples.length !== 1 || tuples[0].length !== 1) {
      return refuse(DiagnosticCode.notImplemented, `TypeDBLite does not evaluate '${(expression as { function: string }).function}' inside an expression unless it answers exactly one value.`, at);
    }
    return { kind: 'text', value: tuples[0][0] };
  }
  if (isFunctionExpression(expression)) {
    return builtin(expression.function, expression.arguments.map((argument) => evaluateNumeric(argument, env, refuse, schema)), refuse, at);
  }
  if (isLabelExpression(expression)) {
    return refuse(DiagnosticCode.valueTypeConflict, `'${expression.label}' is a type, not a value, and cannot be an operand.`, at);
  }
  return refuse(DiagnosticCode.notImplemented, `TypeDBLite does not evaluate this expression yet.`, at);
}

const numericOrRefuse = (evaluated: Evaluated, refuse: Refuse, at: Range | undefined): Numeric =>
  evaluated.kind === 'text'
    ? refuse(DiagnosticCode.valueTypeConflict, `A ${evaluated.value.valueType} is not a number and cannot be an operand here.`, at)
    : evaluated;

/** `$a > 10`, `$v == $a` — over numbers by value, over strings and booleans by text. */
/** Dates and datetimes, which order by instant — `temporalKey`. Zoned datetimes and durations do not yet. */
const ORDERED_TEMPORAL = new Set(['date', 'datetime']);

/** A date or datetime as one comparable text: a date is its midnight, seconds to the nanosecond. */
export function temporalKey(text: string): string {
  const [date, time = '00:00:00'] = text.split('T');
  const [whole, fraction = ''] = time.split('.');
  return `${date}T${whole}.${fraction.padEnd(9, '0')}`;
}

/** Strings order by Unicode code point, not UTF-16 code unit: `"𝔸"` (U+1D538) is above `"ﬀ"` (U+FB00) (review, round 14). */
export function compareStrings(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const cx = x[i].codePointAt(0) ?? 0;
    const cy = y[i].codePointAt(0) ?? 0;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

export function compare(comparator: string, left: ValueBinding, right: Value, refuse: Refuse, at: Range | undefined): boolean {
  let order: number;
  if (isNumericType(left.valueType) && isNumericType(right.valueType)) {
    order = compareNumeric(toNumeric(left.valueType, left.value, refuse, at), toNumeric(right.valueType, right.text, refuse, at));
  } else if (ORDERED_TEMPORAL.has(left.valueType) && ORDERED_TEMPORAL.has(right.valueType)) {
    // 🔴 By instant, not by text: `2020-01-01T00:00:00` and `…:00.000` are one instant and two
    // texts (review, round 11), and a date is its midnight (modifiers.feature L458).
    order = compareStrings(temporalKey(left.value), temporalKey(right.text));
  } else if (TEMPORAL_TYPES.has(left.valueType) || TEMPORAL_TYPES.has(right.valueType)) {
    // A zoned datetime or a duration is refused by NAME, equality included — their comparison needs
    // zone and calendar arithmetic, and a text equality answering nothing is the silent shape
    // ADR-002 D7 forbids.
    return refuse(DiagnosticCode.notImplemented, `TypeDBLite does not compare ${TEMPORAL_TYPES.has(left.valueType) ? left.valueType : right.valueType} values yet.`, at);
  } else if (left.valueType === right.valueType && left.valueType === 'string') {
    order = compareStrings(left.value, right.text);
  } else if (left.valueType === right.valueType && left.valueType === 'boolean') {
    // A boolean has equality and no order (review, round 4).
    if (comparator !== '==' && comparator !== '!=') {
      return refuse(DiagnosticCode.valueTypeConflict, `Cannot order booleans: '${comparator}' is not defined for them.`, at);
    }
    order = left.value === right.text ? 0 : 1;
  } else {
    // 🔴 Reached only when the static check could not know the types — `has $r` may hold a string
    // or an integer, row by row. A declared conflict is refused before any row (`checkComparison`);
    // a value that merely turns out to be of another kind is not equal to it, and orders against it
    // not at all: TypeDB answers `not { $r == 55; }` for the strings (negation.feature L436).
    return comparator === '!=';
  }
  switch (comparator) {
    case '==': return order === 0;
    case '!=': return order !== 0;
    case '<': return order < 0;
    case '<=': return order <= 0;
    case '>': return order > 0;
    case '>=': return order >= 0;
  }
  return refuse(DiagnosticCode.notImplemented, `Unknown comparator '${comparator}'.`, at);
}

/**
 * The value type an expression will carry, from its shape alone — what the `sum` of an empty set
 * of `let` values is `0` of (reduce.feature L331; review, round 1). `variableType` says what a
 * variable carries: an attribute's declared type, or an earlier `let`'s inferred one.
 */
export function inferValueType(expression: Expression, variableType: (variable: string) => string | undefined): string | undefined {
  if (isLiteralExpression(expression)) {
    const literal = expression.literal;
    if (isIntLiteral(literal)) return 'integer';
    if (isDoubleLiteral(literal)) return 'double';
    if (isDecimalLiteral(literal)) return 'decimal';
    if (isStringLiteral(literal)) return 'string';
    if (isBooleanLiteral(literal)) return 'boolean';
    if (isDateLiteral(literal)) return 'date';
    if (isDatetimeLiteral(literal)) return 'datetime';
    if (isDatetimeTzLiteral(literal)) return 'datetime-tz';
    if (isDurationLiteral(literal)) return 'duration';
    return undefined;
  }
  if (isVariableExpression(expression)) return variableType(expression.variable);
  if (isNegationExpression(expression)) return inferValueType(expression.operand, variableType);
  if (isBinaryExpression(expression)) {
    const left = inferValueType(expression.left, variableType);
    const right = inferValueType(expression.right, variableType);
    if (left !== undefined && right !== undefined && (TEMPORAL_TYPES.has(left) || TEMPORAL_TYPES.has(right))) {
      return temporalResultType(expression.operator, left, right);
    }
    if (expression.operator === '/' || expression.operator === '^') return 'double';
    if (left === 'string' || right === 'string') return 'string';
    if (left === 'double' || right === 'double') return 'double';
    if (left === 'decimal' || right === 'decimal') return 'decimal';
    return left === undefined || right === undefined ? undefined : 'integer';
  }
  if (isSchemaCall(expression)) return 'string';
  if (isFunctionExpression(expression)) {
    const separator = expression.function.lastIndexOf('::');
    const bare = separator < 0 ? expression.function : expression.function.slice(separator + 2);
    if (bare === 'ceil' || bare === 'floor' || bare === 'round' || bare === 'len') return 'integer';
    if (bare === 'log10') return 'double';
    const [first] = expression.arguments;
    return first === undefined ? undefined : inferValueType(first, variableType);
  }
  return undefined;
}

/**
 * What an expression can be refused for WITHOUT a value — an unknown function, a wrong arity, an
 * operand kind an operator cannot take — checked once from the operands' inferred types, so a
 * match that binds nothing refuses `$a + "x"` as one with rows does (review, round 14). A type
 * the shape cannot infer is left to evaluation.
 */
export function checkExpression(expression: Expression, variableType: (variable: string) => string | undefined, refuse: Refuse, facts?: SchemaFacts): void {
  const at = rangeOf(expression);
  if (isLiteralExpression(expression)) {
    // A literal outside its range "fails to parse" (expression.feature L654–684) — a refusal
    // that cannot wait for a row (QA, A4): the same reader as evaluation, with no value needed.
    evaluateNumeric(expression, () => undefined, refuse);
    return;
  }
  if (isLabelExpression(expression)) {
    refuse(DiagnosticCode.valueTypeConflict, `'${expression.label}' is a type, not a value, and cannot be an operand.`, at);
    return;
  }
  if (isSchemaCall(expression) && isFunctionExpression(expression)) {
    // Refused before any row, as every other expression is (QA, A3): `get_fun_…` by NAME, so
    // metadata.feature L833 does not pass on an empty match for the wrong reason; the arity, the
    // argument kinds, and an unknown label from their shapes. A variable's binding is per row.
    const shapes = expression.arguments.map((argument): ArgumentShape => {
      if (isLabelExpression(argument)) return { kind: 'label', label: argument.label };
      if (isVariableExpression(argument)) return { kind: 'variable' };
      checkExpression(argument, variableType, refuse, facts);
      return { kind: 'value', valueType: inferValueType(argument, variableType) };
    });
    checkSchemaCall(expression.function, shapes, facts, refuse, at);
    return;
  }
  if (isFunctionExpression(expression)) {
    const separator = expression.function.lastIndexOf('::');
    const bare = separator < 0 ? expression.function : expression.function.slice(separator + 2);
    const known = Object.prototype.hasOwnProperty.call(BUILTINS, bare) ? BUILTINS[bare] : undefined;
    if (known === undefined || (expression.function.includes('::') && expression.function !== `${known.namespace}::${bare}`)) {
      refuse(DiagnosticCode.unknownFunction, `Unknown function '${expression.function}'.`, at);
      return;
    }
    if (expression.arguments.length !== known.arity) {
      refuse(DiagnosticCode.functionArity, `Function '${bare}' expects '${known.arity}' arguments but received '${expression.arguments.length}'.`, at);
    }
    for (const argument of expression.arguments) checkExpression(argument, variableType, refuse, facts);
    // The argument kinds, as `builtin` checks them with a value (review, round 15).
    const kinds = expression.arguments.map((argument) => inferValueType(argument, variableType));
    const qualified = `${known.namespace}::${bare}`;
    const [first, second] = kinds;
    for (const kind of kinds) {
      if (kind !== undefined && TEMPORAL_TYPES.has(kind)) refuse(DiagnosticCode.valueTypeConflict, `Built-in function '${qualified}' cannot be applied to arguments of type '${kind}'.`, at);
    }
    if (bare === 'len') {
      if (first !== undefined && first !== 'string') refuse(DiagnosticCode.valueTypeConflict, `Built-in function '${qualified}' cannot be applied to arguments of type '${first}'.`, at);
    } else if (first !== undefined && !isNumericType(first)) {
      refuse(DiagnosticCode.valueTypeConflict, `Built-in function '${qualified}' cannot be applied to arguments of type '${first}'.`, at);
    } else if ((bare === 'ceil' || bare === 'floor' || bare === 'round') && (first === 'integer' || first === 'long')) {
      refuse(DiagnosticCode.valueTypeConflict, `Built-in function '${qualified}' cannot be applied to arguments of type 'integer'.`, at);
    } else if ((bare === 'max' || bare === 'min') && first !== undefined && second !== undefined && normaliseType(first) !== normaliseType(second)) {
      refuse(DiagnosticCode.valueTypeConflict, `Function '${bare}' expects matching argument types.`, at);
    }
    return;
  }
  if (isNegationExpression(expression)) {
    // `-9223372036854775808` is one signed literal, read whole — never its operand alone.
    if (isLiteralExpression(expression.operand)) {
      evaluateNumeric(expression, () => undefined, refuse);
      return;
    }
    checkExpression(expression.operand, variableType, refuse, facts);
    const type = inferValueType(expression.operand, variableType);
    if (type !== undefined && !isNumericType(type)) refuse(DiagnosticCode.valueTypeConflict, `A ${type} is not a number and cannot be negated.`, at);
    return;
  }
  if (isBinaryExpression(expression)) {
    checkExpression(expression.left, variableType, refuse, facts);
    checkExpression(expression.right, variableType, refuse, facts);
    const left = inferValueType(expression.left, variableType);
    const right = inferValueType(expression.right, variableType);
    if (left === undefined || right === undefined) return;
    if (expression.operator === '+' && left === 'string' && right === 'string') return;
    if (TEMPORAL_TYPES.has(left) || TEMPORAL_TYPES.has(right)) {
      if (temporalResultType(expression.operator, left, right) === undefined) {
        refuse(DiagnosticCode.valueTypeConflict, `There is no '${expression.operator}' for a ${left} and a ${right}.`, at);
      }
      return;
    }
    for (const type of [left, right]) {
      if (!isNumericType(type)) refuse(DiagnosticCode.valueTypeConflict, `A ${type} is not a number and cannot be an operand here.`, at);
    }
  }
}

/** A comparison's two sides can be compared at all — checked from their inferred types (review, round 14). */
export function checkComparison(comparison: ComparisonPattern, variableType: (variable: string) => string | undefined, refuse: Refuse, facts?: SchemaFacts): void {
  checkExpression(comparison.right, variableType, refuse, facts);
  const left = variableType(comparison.left);
  const right = inferValueType(comparison.right, variableType);
  if (left === undefined || right === undefined) return;
  const at = rangeOf(comparison);
  if (ORDERED_TEMPORAL.has(left) && ORDERED_TEMPORAL.has(right)) return;
  if (TEMPORAL_TYPES.has(left) || TEMPORAL_TYPES.has(right)) {
    refuse(DiagnosticCode.notImplemented, `TypeDBLite does not compare ${TEMPORAL_TYPES.has(left) ? left : right} values yet.`, at);
  }
  if (isNumericType(left) && isNumericType(right)) return;
  if (left === right && left === 'string') return;
  if (left === right && left === 'boolean') {
    if (comparison.comparator !== '==' && comparison.comparator !== '!=') {
      refuse(DiagnosticCode.valueTypeConflict, `Cannot order booleans: '${comparison.comparator}' is not defined for them.`, at);
    }
    return;
  }
  refuse(DiagnosticCode.valueTypeConflict, `Cannot compare a ${left} with a ${right}.`, at);
}

// ── the match's value statements ─────────────────────────────────────────────

/** The `let`s of a match in evaluation order, with its comparisons — see `orderValueStatements`. */
export interface ValueStatements {
  readonly lets: readonly LetPattern[];
  readonly comparisons: readonly ComparisonPattern[];
}

/**
 * The `let`s and comparisons of a match, checked as `expression.feature` requires **before any
 * combination is evaluated** — a match with no answers still fails these, as TypeDB's does at
 * compile time:
 *
 * - a value variable is assigned once — *"Variable 'v' cannot be assigned to multiple times in the
 *   same branch."*;
 * - it never shares a name with a concept variable — *"cannot be declared as both a 'Value' and as
 *   a 'Attribute'"*;
 * - every variable an expression reads is bound by something — a concept pattern or another
 *   `let` — or *"The variable 'v' must be bound to a value before it's used."*;
 * - the `let`s admit a dependency order; `let`s that wait on each other are *"The required input
 *   variables for the following constraints could not be satisfied (there may be a circular
 *   dependency)"*.
 *
 * `bound` is every variable the match's concept patterns bind (things, attributes, types).
 */
export function orderValueStatements(
  patterns: readonly Pattern[],
  bound: ReadonlySet<string>,
  refuse: Refuse,
  conceptOf: (variable: string) => 'thing' | 'type' | undefined = () => undefined,
  attributeType: (variable: string) => string | undefined = () => undefined,
  /** The applied schema, so a schema call's label is checked before any row. */
  facts?: SchemaFacts,
  /** What earlier stages bound — a `let` may not reassign one (given.feature L153). */
  previous: ReadonlySet<string> = new Set(),
): ValueStatements {
  const lets = patterns.filter(isLetPattern);
  const comparisons = patterns.filter(isComparisonPattern);
  const assigned = new Set<string>();
  // The operands' types, from the schema and the `let`s' shapes, for the checks that need no value.
  const letOf = new Map(lets.map((l) => [l.variable, l.expression] as const));
  const variableType = (variable: string, seen: ReadonlySet<string> = new Set()): string | undefined => {
    const declared = attributeType(variable);
    if (declared !== undefined) return declared;
    const expression = letOf.get(variable);
    if (expression === undefined || seen.has(variable)) return undefined;
    return inferValueType(expression, (v) => variableType(v, new Set([...seen, variable])));
  };
  // A thing or a type read as an operand is refused HERE, before any combination — a match with
  // no answers refuses it too (review, round 11). A schema call's own argument may be a type
  // (`get_doc($ty)`), and is checked when it is called.
  for (const statement of [...lets, ...comparisons]) {
    const expression = isLetPattern(statement) ? statement.expression : statement.right;
    const typeArguments = new Set(typeArgumentsOf(expression));
    const reads = isLetPattern(statement) ? variablesOf(statement.expression) : [statement.left, ...variablesOf(statement.right)];
    for (const variable of reads) {
      if (typeArguments.has(variable) && conceptOf(variable) === 'type') continue;
      const concept = conceptOf(variable);
      if (concept !== undefined) {
        refuse(DiagnosticCode.valueTypeConflict, `The variable '${variable.slice(1)}' is a ${concept}, not a value, and cannot be an operand.`, rangeOf(statement));
      }
    }
  }
  for (const statement of lets) {
    checkLetShape(statement, refuse);
    for (const variable of letVariables(statement)) {
      if (assigned.has(variable)) {
        refuse(
          DiagnosticCode.valueAssignedTwice,
          `Variable '${variable.slice(1)}' cannot be assigned to multiple times in the same branch.`,
          rangeOf(statement),
        );
      }
      assigned.add(variable);
      if (previous.has(variable)) {
        refuse(
          DiagnosticCode.valueAssignedTwice,
          `The variable '${variable.slice(1)}' may not be assigned to, as it was already bound in a previous stage.`,
          rangeOf(statement),
        );
      }
      if (bound.has(variable)) {
        refuse(
          DiagnosticCode.mixedPattern,
          `The variable '${variable.slice(1)}' cannot be declared as both a 'Value' and as a 'Attribute'.`,
          rangeOf(statement),
        );
      }
    }
  }
  const reads = (statement: LetPattern | ComparisonPattern): string[] =>
    isLetPattern(statement) ? variablesOf(statement.expression) : [statement.left, ...variablesOf(statement.right)];
  for (const statement of [...lets, ...comparisons]) {
    for (const variable of reads(statement)) {
      if (!bound.has(variable) && !assigned.has(variable)) {
        refuse(
          DiagnosticCode.unboundValue,
          `The variable '${variable.slice(1)}' must be bound to a value before it's used.`,
          rangeOf(statement),
        );
      }
    }
  }
  for (const statement of lets) checkExpression(statement.expression, variableType, refuse, facts);
  for (const comparison of comparisons) checkComparison(comparison, variableType, refuse, facts);
  // Dependency order: a `let` is ready when everything it reads is a concept variable or an
  // already-ordered `let`. Nothing ready while some remain is a cycle.
  const ordered: LetPattern[] = [];
  const pending = [...lets];
  const ready = new Set(bound);
  while (pending.length > 0) {
    const index = pending.findIndex((statement) => variablesOf(statement.expression).every((v) => ready.has(v)));
    if (index < 0) {
      return refuse(
        DiagnosticCode.valueCycle,
        'The required input variables for the following constraints could not be satisfied (there may be a circular dependency).',
        rangeOf(pending[0]),
      );
    }
    const [statement] = pending.splice(index, 1);
    ordered.push(statement);
    for (const variable of letVariables(statement)) ready.add(variable);
  }
  return { lets: ordered, comparisons };
}

/** Every variable a `let` binds — one for `let $v = …`, the whole tuple for `let $k, $v in …`. */
export const letVariables = (statement: LetPattern): string[] => [statement.variable, ...statement.others];

/**
 * A `let` binds as many variables as its expression answers values: `let $doc = get_doc(…)` one,
 * `let $k, $v in get_all_meta(…)` two. 🔴 `in` iterates — over a schema call's tuples here; over a
 * list it is not implemented, and refused by name rather than read as `=`.
 */
function checkLetShape(statement: LetPattern, refuse: Refuse): void {
  const at = rangeOf(statement);
  const width = letVariables(statement).length;
  const call = isSchemaCall(statement.expression) && isFunctionExpression(statement.expression) ? statement.expression : undefined;
  if (statement.iterate && call === undefined) {
    refuse(DiagnosticCode.notImplemented, 'TypeDBLite does not evaluate `let … in` over anything but a schema function yet.', at);
  }
  if (!statement.iterate && width > 1) {
    refuse(DiagnosticCode.mixedPattern, '`let $a, $b = …` assigns one value; a tuple is bound with `let $a, $b in …`.', at);
  }
  if (call !== undefined) {
    const answers = schemaFunctionWidth(bareName(call.function));
    if (answers !== width) {
      refuse(DiagnosticCode.valueTypeConflict, `'${call.function}' answers ${answers} value(s) per row, and ${width} variable(s) are bound to it.`, at);
    }
  }
}

/**
 * Apply the value statements to one combination: each `let` (already in dependency order) binds
 * its variables; each comparison filters. Answers every extension that survives — none when a
 * comparison does not hold or a schema call answers nothing, several when one answers several
 * tuples (`let $k, $v in get_all_meta(person)`). A concept variable read as a value must carry
 * one — a thing or a type is refused, except as a schema call's own argument.
 */
export function applyValueStatements(
  statements: ValueStatements,
  bindings: ReadonlyMap<string, ValueBinding>,
  concept: (variable: string) => 'thing' | 'type' | undefined,
  refuse: Refuse,
  schema?: SchemaContext,
): Array<Map<string, ValueBinding>> {
  const envOf = (values: ReadonlyMap<string, ValueBinding>): Environment => (variable) => {
    const bound = values.get(variable);
    if (bound === undefined) {
      const kind = concept(variable);
      if (kind !== undefined) {
        return refuse(
          DiagnosticCode.valueTypeConflict,
          `The variable '${variable.slice(1)}' is a ${kind}, not a value, and cannot be an operand.`,
          undefined,
        );
      }
    }
    return bound;
  };
  const bind = (values: Map<string, ValueBinding>, variables: readonly string[], tuple: ReadonlyArray<Value>): Map<string, ValueBinding> => {
    const next = new Map(values);
    variables.forEach((variable, i) => next.set(variable, { kind: 'value', valueType: tuple[i].valueType, value: tuple[i].text }));
    return next;
  };
  let rows: Array<Map<string, ValueBinding>> = [new Map(bindings)];
  for (const statement of statements.lets) {
    rows = rows.flatMap((values) => {
      const env = envOf(values);
      if (isSchemaCall(statement.expression)) {
        return schemaTuples(statement.expression, env, refuse, schema).map((tuple) => bind(values, letVariables(statement), tuple));
      }
      return [bind(values, [statement.variable], [evaluate(statement.expression, env, refuse, schema)])];
    });
  }
  return rows.filter((values) => {
    const env = envOf(values);
    for (const comparison of statements.comparisons) {
      const left = env(comparison.left);
      if (left === undefined) {
        return refuse(
          DiagnosticCode.unboundValue,
          `The variable '${comparison.left.slice(1)}' must be bound to a value before it's used.`,
          rangeOf(comparison),
        );
      }
      const right = evaluate(comparison.right, env, refuse, schema);
      if (!compare(comparison.comparator, left, right, refuse, rangeOf(comparison))) return false;
    }
    return true;
  });
}

export { arithmetic as operate, compareNumeric as compareValues, toNumeric as numericOf, toValue as valueOf };
export type { Numeric };
