/**
 * TypeQLite literals for values a host interpolates into a query, beside the database handle so that every
 * repository and projector escapes the same way.
 */
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
export declare function escapeTypeQLite(value: string): string;
/** A value that has no TypeQLite literal: a structure, `null`, `undefined`, a non-finite number or an invalid date. */
export declare class TypeQLiteValueError extends Error {
    /** The value that was refused. */
    readonly value: unknown;
    /** A stable code to branch on. */
    readonly code: "typeqlite-unrepresentable-value";
    /** Carries the value that was refused. */
    constructor(
    /** The value that was refused. */
    value: unknown);
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
export declare function typeQLiteValue(value: unknown): string;
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
export declare function typeQLiteDatetime(value: Date): string;
//# sourceMappingURL=typeqlite.d.ts.map