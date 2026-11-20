import { describe, expect, it } from 'vitest';

import { escapeTypeQLite, typeQLiteDatetime, TypeQLiteValueError, typeQLiteValue } from '../src/typeqlite.js';

describe('escapeTypeQLite', () => {
  it('escapes the backslash before the quote, so backslashes are not doubled twice', () => {
    // Quotes-first would then escape the backslashes this step introduces. Order is load-bearing.
    expect(escapeTypeQLite('a\\"b')).toBe('a\\\\\\"b');
  });

  it('escapes a newline rather than letting it terminate the literal', () => {
    expect(escapeTypeQLite('one\ntwo')).toBe('one\\ntwo');
    expect(escapeTypeQLite('a\r\tb')).toBe('a\\r\\tb');
  });

  it('strips control characters that have no escape sequence', () => {
    expect(escapeTypeQLite('a\u0000b\u001fc\u007f')).toBe('abc');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeTypeQLite('start-the-review')).toBe('start-the-review');
  });
});

describe('typeQLiteValue', () => {
  it('quotes and escapes a string', () => {
    expect(typeQLiteValue('a"b')).toBe('"a\\"b"');
  });

  it('renders numbers and booleans unquoted', () => {
    expect(typeQLiteValue(42)).toBe('42');
    expect(typeQLiteValue(-1.5)).toBe('-1.5');
    expect(typeQLiteValue(true)).toBe('true');
  });

  it('🔴 refuses an object instead of writing "[object Object]"', () => {
    // String(value) would succeed here, write a queryable-looking attribute, and be garbage.
    expect(() => typeQLiteValue({ a: 1 })).toThrow(TypeQLiteValueError);
    expect(() => typeQLiteValue({ a: 1 })).toThrow(
      /Cannot interpolate a object/,
    );
    expect(() => typeQLiteValue([1, 2])).toThrow(/Cannot interpolate a array/);
  });

  it('refuses null and undefined — absent means "do not write the attribute"', () => {
    expect(() => typeQLiteValue(null)).toThrow(/Cannot interpolate a null/);
    expect(() => typeQLiteValue(undefined)).toThrow(
      /Cannot interpolate a undefined/,
    );
  });

  it('refuses non-finite numbers, which have no TypeQLite literal', () => {
    for (const value of [Number.NaN, Infinity, -Infinity]) {
      expect(() => typeQLiteValue(value)).toThrow(/non-finite number/);
    }
  });

  it('carries the offending value on the error, for a diagnosable failure', () => {
    expect.assertions(2);
    try {
      typeQLiteValue({ nested: true });
    } catch (error) {
      expect((error as TypeQLiteValueError).value).toEqual({ nested: true });
      expect((error as TypeQLiteValueError).code).toBe(
        'typeqlite-unrepresentable-value',
      );
    }
  });
});

describe('typeQLiteDatetime', () => {
  it('renders seconds precision, unquoted, with no zone', () => {
    expect(typeQLiteDatetime(new Date('2026-09-03T10:00:00.500Z'))).toBe(
      '2026-09-03T10:00:00',
    );
  });

  it('produces exactly one spelling per instant', () => {
    // 🔴 `attr.value` is compared as text. Two renderings of one moment would never match.
    const withMillis = typeQLiteDatetime(new Date('2026-09-03T10:00:00.000Z'));
    const withoutMillis = typeQLiteDatetime(new Date('2026-09-03T10:00:00Z'));

    expect(withMillis).toBe(withoutMillis);
  });

  it('matches the grammar DATETIME terminal exactly', () => {
    expect(typeQLiteDatetime(new Date('2026-01-02T03:04:05Z'))).toMatch(
      /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$/,
    );
  });

  it('refuses an invalid date rather than emitting "Invalid Date"', () => {
    expect(() => typeQLiteDatetime(new Date('nonsense'))).toThrow(
      TypeQLiteValueError,
    );
  });
});
