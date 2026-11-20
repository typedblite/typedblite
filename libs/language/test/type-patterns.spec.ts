import { describe, expect, it } from 'vitest';
import { parse } from './parse.js';

/**
 * Type variables in `match` — Phase 05 of the conformance feature. Every form the behavior spec
 * writes, pinned to parse; what a form ANSWERS is the interpreter's and the report card's.
 */
const parses = (text: string): boolean => {
  const { lexerErrors, parserErrors } = parse(text);
  return lexerErrors.length === 0 && parserErrors.length === 0;
};

describe('type patterns', () => {
  it.each([
    'match $x sub person;',
    'match $x sub! person;',
    'match $x owns name;',
    'match $x label dog;',
    'match $x label number-of-cows; attribute $x;',
    'match $x plays employment:employee;',
    'match $x relates employee;',
    'match entity $0_leading_digit_allowed;',
    'match employment relates $x;',
    'match person plays $x;',
    'match person owns $x;',
    'match writer sub $x;',
    'match relation $t; $r isa $t;',
    'match entity $t; $x isa $t; select $x;',
    'match $x isa $y;',
    'match relation $x label connection;',
    'match $x label child, owns $y;',
    'match $x label part-time-employment, relates $r;',
    'match $name label super-name; $location label location-name, sub super-name;',
    'match $x owns name; $x plays income:earner; entity $x;',
    'match $a isa! first-name;',
    'match $x label number-of; $x-cows sub! $x; attribute $x; attribute $x-cows;',
  ])('parses %s', (text) => expect(parses(text)).toBe(true));

  it('still parses the thing forms every repository writes', () => {
    expect(
      parses(
        'match $p isa person, has person-id "s"; $p has person-id $id, has person-kind $type;',
      ),
    ).toBe(true);
    expect(
      parses('match $r isa task-dependency (dependent: $d, prerequisite: $p);'),
    ).toBe(true);
  });
});
