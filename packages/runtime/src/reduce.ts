import type { ReduceStage, Reduction } from '@typedblite/language';
import type { Range } from 'vscode-languageserver';
import { DiagnosticCode, rangeOf } from './diagnostics.js';
import { compareStrings, compareValues, numericOf, operate, valueOf, type Numeric } from './expressions.js';
import { TypeDBLiteValue } from './interpreter.js';
import type { Refuse } from './schema-rules.js';

/**
 * The `reduce` stage — Phase 06 of the conformance feature. It runs over the rows the stages
 * before it answered (a `select` narrows what it can see, not what it counts: reduce.feature
 * L253, L556), and answers one row, or one per `groupby` group, of value cells.
 *
 * The reducers and what they answer, off the pin:
 *
 * | reducer     | over                               | answers                           | empty set           |
 * |-------------|------------------------------------|-----------------------------------|---------------------|
 * | `count`     | rows, or rows binding `$v`         | integer                           | `0`                 |
 * | `sum`       | numbers                            | the operands' promoted type       | `0` of the type     |
 * | `max`/`min` | numbers, strings, dates, datetimes | the winning value                 | `none`              |
 * | `mean`      | numbers                            | double; decimal stays decimal     | `none`              |
 * | `median`    | numbers                            | double; decimal stays decimal     | `none`              |
 * | `std`       | numbers                            | double, sample standard deviation | `none` (also for 1) |
 *
 * `none` is the variable **absent from the row** — reduce.feature L331 and L665 write it as
 * `none` — and the harness's `none` identifier matches exactly that. The `?` on `$m? = max($y)`
 * declares the variable may be absent; the pin never shows a fallible reducer without it, so this
 * engine treats the two spellings alike rather than invent a refusal.
 *
 * Refusals, all before a row is read: an argument the stage cannot see (*"not available"*), a
 * reduction's own variable grouped on or reduced (L694), a reducer over a thing or a type (L405),
 * and — while reading — a value type the reducer cannot take (L420: `sum` of strings).
 */
export type Row = Record<string, TypeDBLiteValue>;

const REDUCERS = new Set(['count', 'sum', 'max', 'min', 'mean', 'median', 'std']);
const NUMERIC = new Set(['integer', 'long', 'double', 'decimal']);
const COMPARABLE_AS_TEXT = new Set(['string', 'date', 'datetime', 'datetime-tz']);
/** Group keys join on the unit separator — no cell renders it. */
const SEP = String.fromCharCode(31);

/**
 * Check the stage against the variables the stages before it bind, before any row is read — an
 * empty answer set has to fail these too.
 */
/** Whether a reducer can take a value of this type at all — the same table `reduceOne` applies per operand. */
const reducerTakes = (reducer: string, valueType: string): boolean => {
  if (reducer === 'count') return true;
  if (reducer === 'max' || reducer === 'min') return NUMERIC.has(valueType) || COMPARABLE_AS_TEXT.has(valueType);
  return NUMERIC.has(valueType);
};

export function checkReduce(
  stage: ReduceStage,
  available: ReadonlySet<string>,
  conceptOf: (variable: string) => 'thing' | 'type' | undefined,
  declaredTypeOf: (variable: string) => string | undefined,
  refuse: Refuse,
): void {
  const produced = new Set<string>();
  for (const reduction of stage.reductions) {
    // `$c = count, $c = sum($a)` — one variable, assigned once (QA, D1; expression.feature L55's rule).
    if (produced.has(reduction.variable)) {
      refuse(DiagnosticCode.valueAssignedTwice, `Variable '${reduction.variable.slice(1)}' cannot be assigned to multiple times in the same branch.`, rangeOf(reduction));
    }
    produced.add(reduction.variable);
  }
  for (const reduction of stage.reductions) {
    if (!REDUCERS.has(reduction.reducer)) {
      refuse(DiagnosticCode.reducer, `Unknown reducer '${reduction.reducer}'.`, rangeOf(reduction));
    }
    if (reduction.argument === undefined) {
      if (reduction.reducer !== 'count') {
        refuse(DiagnosticCode.reducer, `Reducer '${reduction.reducer}' needs a variable to reduce over.`, rangeOf(reduction));
      }
      continue;
    }
    if (produced.has(reduction.argument)) {
      refuse(DiagnosticCode.reducer, `The variable '${reduction.argument.slice(1)}' was not available for use in the reduce.`, rangeOf(reduction));
    }
    if (!available.has(reduction.argument)) {
      refuse(DiagnosticCode.unboundValue, `The variable '${reduction.argument.slice(1)}' was not available for use in the reduce: nothing before this stage binds it.`, rangeOf(reduction));
    }
    // Over a thing or a type, refused here — before a row is read, so an empty answer set is
    // refused too, not answered `0` (L405; review, round 3).
    const concept = conceptOf(reduction.argument);
    if (reduction.reducer !== 'count' && concept !== undefined) {
      refuse(DiagnosticCode.reducer, `Reducer '${reduction.reducer}' can only be applied to attributes or values; '${reduction.argument}' is a ${concept}.`, rangeOf(reduction));
    }
    // And a declared value type the reducer cannot take, before any row — `max` of a boolean
    // over an empty set is the refusal L451 gives with rows (QA, A1).
    const declared = reduction.argument === undefined ? undefined : declaredTypeOf(reduction.argument);
    if (declared !== undefined && !reducerTakes(reduction.reducer, declared)) {
      refuse(DiagnosticCode.reducer, `Reducer '${reduction.reducer}' cannot be applied to values of type '${declared}'.`, rangeOf(reduction));
    }
  }
  for (const group of stage.groups) {
    if (produced.has(group)) {
      refuse(DiagnosticCode.reducer, `The variable '${group.slice(1)}' was not available for use in the groupby.`, rangeOf(stage));
    }
    if (!available.has(group)) {
      refuse(DiagnosticCode.unboundValue, `The variable '${group.slice(1)}' was not available for use in the groupby: nothing before this stage binds it.`, rangeOf(stage));
    }
  }
}

/**
 * A cell's identity for grouping: kind, type and rendering — an attribute's `toString()` is its
 * raw text alone, and a `first-name "Bob"` is not a `last-name "Bob"` (review, round 3).
 */
const groupKey = (cell: TypeDBLiteValue | undefined): string =>
  cell === undefined
    ? ''
    : `${cell.isType() ? 'type' : cell.isThing() ? 'thing' : cell.isAttribute() ? 'attribute' : 'value'}:${cell.type}:${String(cell)}`;

/**
 * Evaluate the stage over the rows. `attributeValueType(type)` resolves an attribute cell's own
 * type to the value type it holds; `valueTypeOf(variable)` is what the schema says a variable
 * carries when there are no rows — the `sum` of an empty set is `0` of that type (L331: `income`
 * is a double, so `value:double:0`).
 */
export function applyReduce(
  stage: ReduceStage,
  rows: readonly Row[],
  valueTypeOf: (variable: string) => string | undefined,
  attributeValueType: (attribute: string) => string | undefined,
  refuse: Refuse,
): Row[] {
  const groups = new Map<string, { cells: Row; rows: Row[] }>();
  for (const row of rows) {
    const cells: Row = {};
    for (const group of stage.groups) {
      const cell = row[group.slice(1)];
      if (cell !== undefined) cells[group.slice(1)] = cell;
    }
    const key = stage.groups.map((g) => groupKey(row[g.slice(1)])).join(SEP);
    const existing = groups.get(key);
    if (existing) existing.rows.push(row);
    else groups.set(key, { cells, rows: [row] });
  }
  // No `groupby` answers exactly one row, over every row — an empty set included.
  if (stage.groups.length === 0 && groups.size === 0) groups.set('', { cells: {}, rows: [] });

  return [...groups.values()].map(({ cells, rows: members }) => {
    const answer: Row = { ...cells };
    for (const reduction of stage.reductions) {
      const cell = reduceOne(reduction, members, valueTypeOf, attributeValueType, refuse);
      if (cell !== undefined) answer[reduction.variable.slice(1)] = cell;
    }
    return answer;
  });
}

interface Operand {
  readonly valueType: string;
  readonly text: string;
}

const normalise = (valueType: string): string => (valueType === 'long' ? 'integer' : valueType);

function reduceOne(
  reduction: Reduction,
  rows: readonly Row[],
  valueTypeOf: (variable: string) => string | undefined,
  attributeValueType: (attribute: string) => string | undefined,
  refuse: Refuse,
): TypeDBLiteValue | undefined {
  const at = rangeOf(reduction);
  const argument = reduction.argument as string;
  const key = reduction.argument?.slice(1);
  if (reduction.reducer === 'count') {
    const counted = key === undefined ? rows.length : rows.filter((row) => row[key] !== undefined).length;
    return TypeDBLiteValue.value('integer', String(counted));
  }
  const operands: Operand[] = [];
  for (const row of rows) {
    const cell = row[key as string];
    if (cell === undefined) continue;
    if (cell.isThing() || cell.isType()) {
      return refuse(
        DiagnosticCode.reducer,
        `Reducer '${reduction.reducer}' can only be applied to attributes or values; '${argument}' is a ${cell.isType() ? 'type' : 'thing'}.`,
        at,
      );
    }
    // An attribute cell's `type` is its ACTUAL attribute type — a `height` answered for `has
    // measure $m` — and the schema resolves that, not the label the pattern wrote (review, round
    // 8). `valueTypeOf(variable)` is the declared label's, for the empty set alone.
    operands.push({ valueType: cell.isValue() ? cell.type : (attributeValueType(cell.type) ?? cell.type), text: cell.asString() });
  }
  const inapplicable = (valueType: string): never =>
    refuse(DiagnosticCode.reducer, `Reducer '${reduction.reducer}' cannot be applied to values of type '${valueType}'.`, at);
  const numbers = (): Numeric[] =>
    operands.map((o) => (NUMERIC.has(o.valueType) ? numericOf(o.valueType, o.text, refuse, at) : inapplicable(o.valueType)));

  switch (reduction.reducer) {
    case 'sum': {
      const terms = numbers();
      if (terms.length === 0) {
        const declared = normalise(valueTypeOf(argument) ?? 'integer');
        return NUMERIC.has(declared) ? TypeDBLiteValue.value(declared, declared === 'double' ? '0.0' : '0') : inapplicable(declared);
      }
      return cellOf(terms.reduce((acc, n) => operate('+', acc, n, refuse, at)));
    }
    case 'max':
    case 'min': {
      // A boolean has no order (L451) — refused with one operand as with many.
      for (const operand of operands) {
        if (!NUMERIC.has(operand.valueType) && !COMPARABLE_AS_TEXT.has(operand.valueType)) inapplicable(operand.valueType);
      }
      if (operands.length === 0) return undefined;
      const wantMax = reduction.reducer === 'max';
      let best = operands[0];
      for (const candidate of operands.slice(1)) {
        const order = compareOperands(candidate, best, refuse, at, inapplicable);
        if (wantMax ? order > 0 : order < 0) best = candidate;
      }
      return TypeDBLiteValue.value(normalise(best.valueType), best.text);
    }
    case 'mean': {
      const terms = numbers();
      if (terms.length === 0) return undefined;
      // A double mean is summed as doubles — two near-MAX integers are not an overflow on the
      // way to it, as for the median (review, round 5); a decimal mean stays exact.
      if (!terms.every((n) => n.kind === 'decimal')) return doubleCell(terms.reduce((acc, n) => acc + toDouble(n), 0) / terms.length, refuse, at);
      return cellOf(divideDecimal(terms.reduce<Numeric>((acc, n) => operate('+', acc, n, refuse, at), { kind: 'decimal', unscaled: BigInt(0), scale: 0 }), terms.length));
    }
    case 'median': {
      const sorted = numbers().sort((a, b) => compareValues(a, b));
      if (sorted.length === 0) return undefined;
      const decimal = sorted.every((n) => n.kind === 'decimal');
      const middle = Math.floor(sorted.length / 2);
      if (sorted.length % 2 === 1) return decimal ? cellOf(sorted[middle]) : doubleCell(toDouble(sorted[middle]), refuse, at);
      // The double median is halfway between two doubles — two near-MAX integers are not an
      // overflow on the way to it (review, round 2); the decimal one stays exact.
      if (!decimal) return doubleCell((toDouble(sorted[middle - 1]) + toDouble(sorted[middle])) / 2, refuse, at);
      return cellOf(divideDecimal(operate('+', sorted[middle - 1], sorted[middle], refuse, at), 2));
    }
    case 'std': {
      // Sample standard deviation (L223); one value has no spread and answers `none` (L665).
      const values = numbers().map(toDouble);
      if (values.length < 2) return undefined;
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
      return doubleCell(Math.sqrt(variance), refuse, at);
    }
  }
  return refuse(DiagnosticCode.reducer, `Unknown reducer '${reduction.reducer}'.`, at);
}

function compareOperands(
  a: Operand,
  b: Operand,
  refuse: Refuse,
  at: Range | undefined,
  inapplicable: (valueType: string) => never,
): number {
  if (NUMERIC.has(a.valueType) && NUMERIC.has(b.valueType)) {
    return compareValues(numericOf(a.valueType, a.text, refuse, at), numericOf(b.valueType, b.text, refuse, at));
  }
  if (COMPARABLE_AS_TEXT.has(a.valueType) && a.valueType === b.valueType) {
    if (a.valueType === 'datetime-tz') {
      // A datetime WITH an offset compares as an instant; one `Date.parse` cannot read (a named
      // zone) compares as written, which is the same order for the pin's fixtures. A zoneless
      // datetime or a date is fixed-width ISO text and orders as text — `Date.parse` would read
      // it in the host's zone, and a DST gap inverts it (review, round 15).
      const x = Date.parse(a.text);
      const y = Date.parse(b.text);
      if (!Number.isNaN(x) && !Number.isNaN(y)) return x < y ? -1 : x > y ? 1 : 0;
    }
    return compareStrings(a.text, b.text);
  }
  return inapplicable(NUMERIC.has(a.valueType) || COMPARABLE_AS_TEXT.has(a.valueType) ? b.valueType : a.valueType);
}

// ── numeric helpers, over `expressions.ts`'s Numeric ────────────────────────
// ⚠️ No bigint literals and no `**` on a bigint here either — see `expressions.ts`.

const ZERO = BigInt(0);
const TEN = BigInt(10);
const pow10 = (n: number): bigint => BigInt(`1${'0'.repeat(n)}`);

const toDouble = (n: Numeric): number =>
  n.kind === 'double' ? n.value : n.kind === 'integer' ? Number(n.value) : Number(n.unscaled) / Number(pow10(n.scale));


/**
 * A decimal divided by a count, exactly where it terminates: the scale grows until the remainder
 * is zero or nineteen fractional digits are reached — TypeDB's decimal precision.
 */
function divideDecimal(n: Numeric, by: number): Numeric {
  const { unscaled, scale } =
    n.kind === 'decimal' ? n : { unscaled: n.kind === 'integer' ? n.value : BigInt(Math.round(n.value)), scale: 0 };
  const divisor = BigInt(by);
  let numerator = unscaled;
  let resultScale = scale;
  while (numerator % divisor !== ZERO && resultScale < 19) {
    numerator = numerator * TEN;
    resultScale += 1;
  }
  return { kind: 'decimal', unscaled: numerator / divisor, scale: resultScale };
}

const cellOf = (n: Numeric): TypeDBLiteValue => {
  const value = valueOf(n);
  return TypeDBLiteValue.value(value.valueType, value.text);
};

/** A double result, refused rather than answered when it is not finite (review, round 6). */
const doubleCell = (value: number, refuse: Refuse, at: Range | undefined): TypeDBLiteValue =>
  Number.isFinite(value)
    ? cellOf({ kind: 'double', value })
    : refuse(DiagnosticCode.valueOutOfRange, 'Double overflow: the result is outside the 64-bit range.', at);
