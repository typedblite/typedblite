import { describe, expect, it } from 'vitest';
import { parse } from './parse.js';
import {
  isBooleanLiteral,
  isDateLiteral,
  isDatetimeLiteral,
  isDatetimeTzLiteral,
  isDoubleLiteral,
  isHasProperty,
  isIntLiteral,
  isStringLiteral,
  isThingPattern,
} from '../src/generated/ast.js';
import type { Literal } from '../src/generated/ast.js';

/**
 * Boolean and datetime literals.
 *
 * 🔴 `ValueType` has admitted `boolean` and `datetime` since day one, and nothing could ever *write*
 * one: `Literal` was `StringLiteral | IntLiteral`. A downstream application's schema declares two of each,
 * and its real call sites emit `has is-latest true` and `has created-at 2026-09-03T10:00:00`.
 */

/** The first `has` property's literal, or `undefined` if the query did not parse to one. */
function firstLiteral(text: string): {
  literal: Literal | undefined;
  errors: number;
} {
  const result = parse(text);
  const errors = result.lexerErrors.length + result.parserErrors.length;
  const clause = result.value.clauses?.[0];
  const first = clause && 'stages' in clause ? clause.stages[0] : undefined;
  const pattern = first && 'patterns' in first ? first.patterns[0] : undefined;
  if (!pattern || !isThingPattern(pattern))
    return { literal: undefined, errors };
  const property = pattern.properties.find(isHasProperty);
  return { literal: property?.value, errors };
}

const clean = (text: string) => {
  const { literal, errors } = firstLiteral(text);
  expect(errors).toBe(0);
  return literal;
};

describe('boolean literals', () => {
  it.each(['true', 'false'])('parses `has is-latest %s`', (word) => {
    const literal = clean(
      `match $v isa prompt-version, has is-latest ${word};`,
    );

    expect(isBooleanLiteral(literal)).toBe(true);
    expect(literal).toMatchObject({ value: word });
  });

  it('keeps `true` distinguishable from the string "true"', () => {
    // 🔴 Both store the text `true`, so only the AST tells them apart. If a later change makes the
    // grammar treat one as the other, this is what notices.
    expect(
      isBooleanLiteral(
        clean('match $v isa prompt-version, has is-latest true;'),
      ),
    ).toBe(true);
    expect(
      isStringLiteral(
        clean('match $v isa prompt-version, has is-latest "true";'),
      ),
    ).toBe(true);
  });

  it('does not swallow an identifier that merely starts with a keyword', () => {
    // Langium gives keyword tokens `longer_alt: ID`. Without it, `truest-flag` would lex as the
    // keyword `true` followed by `st-flag` and the query would fail for an unreadable reason.
    const literal = clean('match $v isa prompt-version, has truest-flag "x";');

    expect(isStringLiteral(literal)).toBe(true);
  });
});

describe('datetime literals', () => {
  it('parses the exact form this repository emits', () => {
    // `d.toISOString().replace('Z', '').slice(0, 19)`
    const literal = clean(
      'match $p isa prompt, has created-at 2026-09-03T10:00:00;',
    );

    expect(isDatetimeLiteral(literal)).toBe(true);
    expect(literal).toMatchObject({ value: '2026-09-03T10:00:00' });
  });

  it('🔴 lexes as a datetime, not as the integer 2026', () => {
    // The whole reason DATETIME is declared before INT in terminals.langium. Chevrotain takes the
    // first pattern that matches, not the longest — with INT first this is `2026` and a pile of
    // syntax errors.
    const literal = clean(
      'match $p isa prompt, has created-at 2026-09-03T10:00:00;',
    );

    expect(isIntLiteral(literal)).toBe(false);
  });

  it('still lexes a bare number as an integer', () => {
    const literal = clean('match $v isa prompt-version, has version-number 3;');

    expect(isIntLiteral(literal)).toBe(true);
    expect(literal).toMatchObject({ value: 3 });
  });

  describe('🔴 one spelling per instant, with the two the behavior spec forced open', () => {
    // `attr.value` is compared as text. A grammar accepting several spellings of one moment
    // stores several texts that never match each other — so these must fail, and fail here.
    //
    // ⚠️ Two spellings were admitted 2026-09-11 because `fetch.feature`'s Background writes them
    // (ADR-005: the spec is a caller): fractional seconds, and a date-only literal — which is a
    // DateLiteral, a different literal kind, not a datetime spelling. Both are pinned below. The
    // text-comparison caveat stands: `…:13` and `…:13.000` still never match each other.
    it('accepts fractional seconds, stored as written', () => {
      const literal = clean(
        'match $p isa prompt, has created-at 2020-01-01T13:13:13.999;',
      );
      expect(isDatetimeLiteral(literal)).toBe(true);
      expect(literal).toMatchObject({ value: '2020-01-01T13:13:13.999' });
    });

    it('lexes a date-only literal as a DateLiteral, not a datetime and not an integer', () => {
      const literal = clean(
        'match $e isa employment, has end-date 2021-01-01;',
      );
      expect(isDateLiteral(literal)).toBe(true);
      expect(isDatetimeLiteral(literal)).toBe(false);
      expect(isIntLiteral(literal)).toBe(false);
      expect(literal).toMatchObject({ value: '2021-01-01' });
    });

    it('lexes a decimal number as a DoubleLiteral, stored as written', () => {
      const literal = clean('match $p isa person, has karma 123.4567891;');
      expect(isDoubleLiteral(literal)).toBe(true);
      expect(isIntLiteral(literal)).toBe(false);
      expect(literal).toMatchObject({ value: '123.4567891' });
    });

    // TypeDB accepts minutes without seconds (expression.feature L704, modifiers.feature L458); it was
    // refused here until the temporal phase. The engine stores it with `:00`, one spelling per instant.
    it('accepts no seconds (2026-09-03T10:00) as a datetime', () => {
      const { literal, errors } = firstLiteral('match $p isa prompt, has created-at 2026-09-03T10:00;');
      expect(errors).toBe(0);
      expect(isDatetimeLiteral(literal)).toBe(true);
    });

    // A zone makes it a DatetimeTzLiteral — TypeDB's `datetime-tz` value type, a different kind,
    // as the date-only case is — not a second spelling of a datetime. `define.feature`'s
    // annotation tables write all three zone forms (Phase 03 of the conformance feature).
    it.each([
      ['a trailing Z', '2026-09-03T10:00:00Z'],
      ['an offset', '2024-06-04T00:00:00+0010'],
      ['an IANA zone', '2024-06-04T00:00:00 Europe/Belfast'],
      [
        'a three-part zone',
        '2024-06-04T00:00:00 America/Argentina/Buenos_Aires',
      ],
      ['a zone with a sign', '2024-06-04T00:00:00 Etc/GMT+1'],
    ])(
      'lexes %s (%s) as a DatetimeTzLiteral, not a datetime',
      (_label, value) => {
        const literal = clean(`match $p isa prompt, has created-at ${value};`);
        expect(isDatetimeTzLiteral(literal)).toBe(true);
        expect(isDatetimeLiteral(literal)).toBe(false);
        expect(literal).toMatchObject({ value });
      },
    );

    it('accepts the quoted form as a plain string, which is a different thing', () => {
      // Not an error — it is a string attribute value. Worth pinning: it is how someone would
      // work around a missing datetime literal, and it must not be mistaken for one.
      expect(
        isStringLiteral(
          clean('match $p isa prompt, has created-at "2026-09-03T10:00";'),
        ),
      ).toBe(true);
    });
  });
});
