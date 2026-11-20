/**
 * TypeQLite literals for values a host interpolates into a query, beside the database handle so that every
 * repository and projector escapes the same way.
 */

// The C0 control range and DEL, minus tab/newline/carriage-return which are escaped by name below. Written as code
// points because the literal characters are invisible in a diff.
const UNPRINTABLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Escape a value for interpolation into a TypeQLite string literal.
 *
 * The backslash must be replaced first: doing quotes first would then escape the backslashes this step introduces,
 * doubling them.
 *
 * Control characters are handled too. A raw newline inside a TypeQLite string literal terminates it, which turns a
 * value carrying one into a syntax error at best and an injected clause at worst, and a projector interpolates values
 * nobody wrote by hand.
 */
export function escapeTypeQLite(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(UNPRINTABLE, '');
}

/** A value that has no TypeQLite literal: a structure, `null`, `undefined`, a non-finite number or an invalid date. */
export class TypeQLiteValueError extends Error {
  /** A stable code to branch on. */
  public readonly code = 'typeqlite-unrepresentable-value' as const;
  /** Carries the value that was refused. */
  public constructor(
    /** The value that was refused. */
    public readonly value: unknown,
  ) {
    super(
      `Cannot interpolate a ${describeValue(value)} into TypeQLite. Attributes hold strings, ` +
        `numbers and booleans; a structure has to be modeled as entities and relations, or ` +
        `serialized deliberately by the caller.`,
    );
    this.name = 'TypeQLiteValueError';
  }
}

/**
 * Render an arbitrary value as a TypeQLite literal, or refuse.
 *
 * `null` and `undefined` throw as well. TypeDB has no null attribute value; the way to say "absent" is to not write
 * the attribute, which is a decision for the caller's mapping function.
 *
 * @throws TypeQLiteValueError for a value with no TypeQLite literal.
 *
 * @privateRemarks
 * 🔴 **The refusal is the point.** Interpolating with `String(value)` turns an object into the literal
 * `"[object Object]"`: a write that succeeds, produces a queryable-looking attribute, and is garbage. The only way not
 * to do that is to make the case throw.
 */
export function typeQLiteValue(value: unknown): string {
  if (typeof value === 'string') return `"${escapeTypeQLite(value)}"`;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeQLiteValueError(value);
    return String(value);
  }
  throw new TypeQLiteValueError(value);
}

const describeValue = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return `non-finite number (${value})`;
  return typeof value;
};

/**
 * A `Date` as a TypeQLite datetime literal: `YYYY-MM-DDTHH:MM:SS`, **unquoted**.
 *
 * **Seconds precision, no fraction, no zone: exactly one spelling per instant**, matching the grammar's `DATETIME`
 * terminal. `attr.value` is compared as text, so a second spelling would simply never match the first.
 *
 * @throws TypeQLiteValueError for an invalid date.
 *
 * @privateRemarks
 * 🔴 **Its own function rather than a branch in `typeQLiteValue`.** A `Date` is not a value type the caller can be
 * vague about: quoting it produces a *string* attribute that silently never matches a datetime one, and both are
 * `string` in TypeScript by the time they reach the query.
 */
export function typeQLiteDatetime(value: Date): string {
  if (Number.isNaN(value.getTime())) throw new TypeQLiteValueError(value);
  // 🔴 Strip the fraction and the zone by shape, not by length: outside the years 0000-9999 `toISOString` writes a
  // six-digit signed year (`+010000-...`), so cutting at a fixed 19 characters drops the seconds and stores a
  // different instant than the one given.
  return value.toISOString().replace(/\.\d{3}Z$/, '');
}
