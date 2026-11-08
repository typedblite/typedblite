import type { TypeDBLiteValue } from '@typedblite/runtime';
import type { AnswerRow, Answers } from './world.js';

/**
 * The spec's answer identifiers — `key:ref:1`, `attr:name:Alice`, `value:integer:5`,
 * `label:person` — resolved against what TypeDBLite actually returned.
 *
 * 🔴 **A cell is a concept** — an entity or relation with an `iid` and its actual type, an
 * attribute with its actual type and value, or a bare value. Every matcher below is written so
 * that missing information is a *non-match*, never a match: the failure mode this file is built
 * against is a row that "matches" because the comparison could not see enough to disagree.
 *
 * - `key:` names a thing by its `@key`. It matches a thing cell whose `<type>` attribute, read from
 *   the engine by iid — the driver's `getHas`, never anything the cell carries — has the value. A
 *   thing that owns no such attribute is a non-match.
 * - `attr:` matches an attribute cell by its **actual** type and value. Until Phase 02 the type was
 *   read from the query text (`has name $n` → `name`), which could not tell `name` from a
 *   `first-name` answered for it; the cell says which it is now.
 * - `value:` compares an attribute or value cell by the declared value type — an integer as an
 *   integer, a double within a tolerance, a string exactly. A thing is a non-match.
 * - `label:` matches a *type* cell whose label is the literal — `person`, or a role type as
 *   `relation:role`. Until Phase 05 no cell was a type and this never matched, honestly.
 * - `none` matches a variable absent from the row — what an optional reduction answers over an
 *   empty set (Phase 06). Any cell there is a non-match.
 */
export interface Identifier {
  readonly kind: 'key' | 'attr' | 'value' | 'label' | 'none';
  readonly type: string;
  readonly literal: string;
}

export const parseIdentifier = (cell: string): Identifier => {
  const trimmed = cell.trim();
  // `none` — the variable is ABSENT from the row: an optional reduction over an empty set
  // (reduce.feature L331), a standard deviation of one value (L665). A row that carries the
  // variable with any cell is a non-match.
  if (trimmed === 'none') return { kind: 'none', type: 'none', literal: 'none' };
  const first = trimmed.indexOf(':');
  const kind = trimmed.slice(0, first);
  if (kind === 'label') return { kind, type: 'label', literal: trimmed.slice(first + 1) };
  if (kind !== 'key' && kind !== 'attr' && kind !== 'value') {
    throw new Error(`unknown answer identifier '${cell}'`);
  }
  const second = trimmed.indexOf(':', first + 1);
  if (second < 0) throw new Error(`malformed answer identifier '${cell}'`);
  return { kind, type: trimmed.slice(first + 1, second), literal: trimmed.slice(second + 1) };
};

const unquote = (literal: string): string =>
  literal.length >= 2 && literal.startsWith('"') && literal.endsWith('"')
    ? literal.slice(1, -1)
    : literal;

const normaliseValueType = (type: string): string => (type === 'long' ? 'integer' : type);

/** A decimal's canonical text — sign, integer part, fraction without trailing zeros — or undefined. */
const decimalOf = (text: string): string | undefined => {
  const match = /^(-?)(\d+)(?:\.(\d*))?(?:dec)?$/.exec(text.trim());
  if (!match) return undefined;
  const [, sign, whole, fraction = ''] = match;
  const trimmed = fraction.replace(/0+$/, '');
  const integer = whole.replace(/^0+(?=\d)/, '');
  const zero = integer === '0' && trimmed === '';
  return `${zero ? '' : sign}${integer}${trimmed === '' ? '' : `.${trimmed}`}`;
};

const valueMatches = (valueType: string, literal: string, actual: string): boolean => {
  switch (valueType) {
    case 'integer':
      // As digits, not through `parseInt`: two 64-bit values within ~1024 of each other are one
      // `number`, and the boundary scenarios (L656) could not fail off by one (review, round 4).
      return /^-?\d+$/.test(actual) && /^-?\d+$/.test(literal.trim()) && BigInt(actual) === BigInt(literal.trim());
    case 'double': {
      const expected = Number.parseFloat(literal);
      const got = Number.parseFloat(actual);
      if (Number.isNaN(expected) || Number.isNaN(got)) return false;
      // The spec writes a computed double to four decimals — `mean` of 6, 30, 14 is `16.6667`
      // (reduce.feature L203), `std` is `31.0537` (L250) — so the tolerance is RELATIVE: three
      // parts in 10^6 admits `16.6667` for 16.66666… (2e-6 off) and refuses `16.6666` (4e-6 off),
      // with a floor only for rounding noise, so an expected `0.0` is not met by `0.00004`
      // (review, round 10).
      return Math.abs(expected - got) <= Math.max(1e-9, Math.abs(expected) * 3e-6);
    }
    case 'boolean':
      return (literal === 'true' || literal === 'false') && actual === literal;
    case 'string':
      return unquote(actual) === unquote(literal);
    case 'decimal': {
      // `value:decimal:9.0dec` against the engine's `9.0` (or `9`): equal as exact decimals, the
      // `dec` suffix and trailing zeros aside. Never through a float — `173.1dec` is exact.
      const expected = decimalOf(literal);
      const got = decimalOf(actual);
      return expected !== undefined && got !== undefined && expected === got;
    }
    default:
      // datetime, datetime-tz, date, duration: compared as written. A representation TypeDBLite
      // renders differently is a non-match, and that is a finding, not a tolerance.
      return actual.trim() === literal.trim();
  }
};

export const identifierMatches = (
  identifier: Identifier,
  row: AnswerRow,
  variable: string,
  has: Answers['has'],
): boolean => {
  const cell: TypeDBLiteValue | undefined = row[variable];
  if (identifier.kind === 'none') return cell === undefined;
  if (cell === undefined) return false;
  switch (identifier.kind) {
    case 'key':
      return (
        cell.isThing() &&
        has(cell.iid, identifier.type).some((a) => unquote(a.asString()) === unquote(identifier.literal))
      );
    case 'attr':
      return (
        cell.isAttribute() &&
        cell.type === identifier.type &&
        unquote(cell.asString()) === unquote(identifier.literal)
      );
    case 'value':
      // 🔴 A VALUE cell carries its value type, and the identifier's must be it — an integer `752`
      // is not `value:double:752.0`, and `valueMatches` alone could not tell (Phase 06 review,
      // round 6: `^` answered integers where the pin says doubles, and the card did not move). An
      // attribute cell's `type` is its attribute type, which this file cannot resolve to a value
      // type; there the text comparison is what there is.
      if (cell.isValue() && normaliseValueType(cell.type) !== normaliseValueType(identifier.type)) return false;
      return !cell.isThing() && !cell.isType() && valueMatches(identifier.type, identifier.literal, cell.asString());
    case 'label':
      return cell.isType() && cell.label === identifier.literal;
  }
};

/** Which answer rows a table row identifies — for `uniquely identify`, exactly one must. */
const matchesOf = (
  header: ReadonlyArray<string>,
  cells: ReadonlyArray<string>,
  answers: Answers,
): number[] => {
  const identifiers = cells.map(parseIdentifier);
  const matched: number[] = [];
  answers.rows.forEach((row, index) => {
    const all = header.every((variable, i) => identifierMatches(identifiers[i], row, variable, answers.has));
    if (all) matched.push(index);
  });
  return matched;
};

/**
 * `Then uniquely identify answer concepts` — the table and the answers are in bijection: every
 * table row identifies exactly one answer, every answer is identified by exactly one table row.
 */
export const uniquelyIdentify = (
  table: ReadonlyArray<ReadonlyArray<string>>,
  answers: Answers,
): void => {
  const [header, ...rows] = table;
  if (answers.rows.length !== rows.length) {
    throw new Error(`expected ${rows.length} answer(s), got ${answers.rows.length}`);
  }
  const taken = new Set<number>();
  rows.forEach((cells, i) => {
    const matched = matchesOf(header, cells, answers);
    if (matched.length !== 1) {
      throw new Error(`table row ${i + 1} (${cells.join(' | ')}) identifies ${matched.length} answer(s), not 1`);
    }
    if (taken.has(matched[0])) throw new Error(`table row ${i + 1} identifies an answer already taken`);
    taken.add(matched[0]);
  });
};

/** `Then order of answer concepts is` — positional, not a bijection. */
export const orderedIdentify = (
  table: ReadonlyArray<ReadonlyArray<string>>,
  answers: Answers,
): void => {
  const [header, ...rows] = table;
  if (answers.rows.length !== rows.length) {
    throw new Error(`expected ${rows.length} answer(s), got ${answers.rows.length}`);
  }
  rows.forEach((cells, i) => {
    const identifiers = cells.map(parseIdentifier);
    const row = answers.rows[i];
    const ok = header.every((variable, j) => identifierMatches(identifiers[j], row, variable, answers.has));
    if (!ok) throw new Error(`answer ${i + 1} is not (${cells.join(' | ')})`);
  });
};

/** `Then result is a single row with variable 'count': value:integer:6`. */
export const singleRowVariable = (variable: string, cell: string, answers: Answers): void => {
  if (answers.rows.length !== 1) throw new Error(`expected 1 row, got ${answers.rows.length}`);
  const ok = identifierMatches(parseIdentifier(cell), answers.rows[0], variable, answers.has);
  if (!ok) throw new Error(`variable '${variable}' is not ${cell}`);
};

/**
 * A row rendered for set comparison — `verify answer set is equivalent for query`. `toString()`
 * renders every kind: a thing by kind, type and iid, so two rows carrying the same thing agree.
 */
export const rowKey = (row: AnswerRow): string =>
  Object.keys(row)
    .sort()
    .map((k) => `${k}=${String(row[k])}`)
    .join('\u0000');
