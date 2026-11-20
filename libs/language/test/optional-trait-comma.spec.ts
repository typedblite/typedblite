import { describe, expect, it } from 'vitest';
import { parse } from './parse.js';

/**
 * The comma after a type or attribute label is optional — as it is on TypeDB.
 *
 * 🔴 This grammar required it, and every Background in TypeDB's own behavior spec is written
 * without it: `entity person plays employment:employee, owns name @card(0..);` and `attribute ref
 * value integer;`. Both forms were verified `answerType: ok` on `typedb/typedb:3.10.4` on
 * 2026-09-11, on a scratch database. Between traits the comma stays required.
 * `d-20260911-the-typeql-grammar-requires-a-comma`.
 */
const clean = (text: string) => {
  const result = parse(text);
  return [...result.lexerErrors, ...result.parserErrors].map((e) => e.message);
};

describe('the comma after a label is optional, as on TypeDB', () => {
  it.each([
    [
      'entity, no comma',
      'define attribute ref, value integer; entity person owns ref @key;',
    ],
    [
      'entity, comma',
      'define attribute ref, value integer; entity person, owns ref @key;',
    ],
    ['attribute, no comma', 'define attribute ref value integer;'],
    ['attribute, comma', 'define attribute ref, value integer;'],
    [
      'relation, no comma',
      'define relation employment relates employee, relates employer;',
    ],
    [
      "the spec's Background",
      [
        'define',
        'entity person',
        '  plays friendship:friend,',
        '  owns name @card(0..),',
        '  owns ref @key;',
        'relation friendship',
        '  relates friend @card(0..),',
        '  owns ref @key;',
        'attribute name value string;',
        'attribute ref value integer;',
      ].join('\n'),
    ],
  ])('parses %s', (_label, text) => {
    expect(clean(text)).toEqual([]);
  });

  it('still requires the comma BETWEEN traits', () => {
    expect(
      clean(
        'define attribute ref, value integer; entity person owns ref @key plays x:y;',
      ),
    ).not.toEqual([]);
  });
});
