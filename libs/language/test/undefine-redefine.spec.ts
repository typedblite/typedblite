import { describe, expect, it } from 'vitest';
import { parse, validate } from './parse.js';
import { TypeQLiteValidationCode } from '../src/typeqlite-validation-codes.js';

/**
 * The two schema stages Phase 04 of the conformance feature added, pinned both ways — what
 * parses, and what the behaviour spec calls a PARSING failure. `undefine` admits only its
 * targeted forms; `redefine` exactly one change. Whether an undefine names something defined,
 * or a redefine changes anything, is the interpreter's question, not this file's.
 */
const parses = (text: string): boolean => {
  const { lexerErrors, parserErrors } = parse(text);
  return lexerErrors.length === 0 && parserErrors.length === 0;
};

describe('undefine', () => {
  it.each([
    'undefine',
    'undefine person;',
    'undefine sub person from child;',
    'undefine owns name from person;',
    'undefine plays employment:employee from person;',
    'undefine relates employee from employment;',
    'undefine value string from name;',
    'undefine @card from person owns name;',
    'undefine @regex from email value string;',
    'undefine @meta("key") from player;',
    'undefine @abstract from fathership;',
    'undefine as parent from fathership relates father;',
    'undefine @card from player plays employment:employee;',
    'undefine @key from person owns email;',
  ])('parses %s', (text) => expect(parses(text)).toBe(true));

  // undefine.feature L42: "cannot use untargeted define-like syntax in undefine" — parsing fails.
  it.each([
    'undefine entity person;',
    'undefine person plays employment:employee;',
    'undefine person owns name;',
    'undefine person, owns name;',
    'undefine person owns email @key;',
    'undefine name @independent;',
    'undefine name value string;',
    'undefine name value string @regex(".+");',
  ])('refuses define-like %s at parse', (text) =>
    expect(parses(text)).toBe(false),
  );
});

describe('redefine', () => {
  it.each([
    'redefine',
    'redefine entity person owns name @card(0..1);',
    'redefine entity person owns name @card(0..1) @regex("^[a-z]+$");',
    'redefine child sub person;',
    'redefine entity child sub person;',
    'redefine attribute email value integer;',
    'redefine attribute description value string @regex("val");',
    'redefine entity before-rename label after-rename;',
    'redefine relation-of-rename:before-rename label sibling-role;',
    'redefine player @abstract;',
    'redefine relation parentship @doc("also docs");',
    'redefine person plays parentship:child @card(0..1);',
    'redefine employment relates employee @card(1..);',
    'redefine entity person value double;', // parses; the interpreter refuses it (redefine.feature L327 says `; fails`)
  ])('parses %s', (text) => expect(parses(text)).toBe(true));

  // redefine.feature: "cannot be redefined" / "parsing fails if multiple statements" / variables.
  it.each([
    'redefine entity person;',
    'redefine entity person owns phone-nr @unique, owns name @regex("^.*$");',
    'redefine attribute email @independent, value string @regex("^.*@.*$");',
    'redefine relation part-time-employment relates part-time-role, sub empty-relation;',
    'redefine $p isa person;',
    'redefine $p has name "Loch Ness Monster";',
    'redefine entity $x;',
  ])('refuses %s at parse', (text) => expect(parses(text)).toBe(false));

  it('runs the admissibility table on a redefine', async () => {
    const found = (
      await validate('redefine entity player @card(1..1);')
    ).filter((d) => d.code === TypeQLiteValidationCode.annotationNotAdmitted);
    expect(found).toHaveLength(1);
    expect(await validate('redefine relation parentship @abstract;')).toEqual(
      expect.arrayContaining([]),
    );
    expect(
      (await validate('redefine entity person value double;')).map(
        (d) => d.code,
      ),
    ).toContain(TypeQLiteValidationCode.valueTypeOnThing);
  });

  it('refuses a redefine to a value type TypeDB does not have, listing the ones it does', async () => {
    const [diagnostic, ...rest] = await validate('redefine attribute age value strng;');
    expect(rest).toEqual([]);
    expect(diagnostic?.code).toBe(TypeQLiteValidationCode.unknownValueType);
    expect(diagnostic?.message).toBe(
      "'strng' is not a value type. TypeDB 3 has: string, integer, double, decimal, boolean, datetime-tz, datetime, date, duration.",
    );
  });
});
