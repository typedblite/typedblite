import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tokenizeTextMate, type RawGrammar } from '../src/language-server/textmate';

/**
 * The preview's TextMate layer runs the grammar the editor runs: the copy `sync-grammar` puts beside
 * the manifest, which `build` (and so `test`) refreshes first.
 */
const GRAMMAR: RawGrammar = JSON.parse(
  readFileSync(resolve(__dirname, '../syntaxes/typeqlite.tmLanguage.json'), 'utf8'),
);

const KEYWORD = 'keyword.control.typeqlite';
const DOUBLE = 'string.quoted.double.typeqlite';
const VARIABLE = 'variable.parameter.typeqlite';
const OPERATOR = 'keyword.operator.typeqlite';
const NUMBER = 'constant.numeric.typeqlite';

/** Each token as its text and its scopes. */
const tokens = (text: string, grammar: RawGrammar = GRAMMAR) =>
  tokenizeTextMate(grammar, text).map((token) => [text.slice(token.offset, token.offset + token.length), ...token.scopes]);

describe('the TextMate layer, on the grammar the editor uses', () => {
  it('scopes keywords, variables and strings, and leaves labels to the semantic layer', () => {
    expect(tokens('match $p isa person, has name "Ann";')).toEqual([
      ['match', KEYWORD],
      ['$p', VARIABLE],
      ['isa', KEYWORD],
      ['has', KEYWORD],
      ['"Ann"', DOUBLE],
    ]);
  });

  it("scopes each kind of keyword as TypeDB's TypeQL grammar does, so a theme colours them apart", () => {
    expect(tokens('define entity person, owns email @key; attribute email, value string;')).toEqual([
      ['define', KEYWORD],
      ['entity', 'storage.type.typeqlite'],
      ['owns', KEYWORD],
      ['@key', 'keyword.annotations.typeqlite'],
      ['attribute', 'storage.type.typeqlite'],
      ['value', KEYWORD],
      ['string', 'storage.modifier.typeqlite'],
    ]);
    expect(tokens('not { $x == true; } or { $x like "a"; };')).toEqual([
      ['not', 'keyword.operator.words.typeqlite'],
      ['$x', VARIABLE],
      ['==', OPERATOR],
      ['true', 'constant.language.typeqlite'],
      ['or', 'keyword.operator.words.typeqlite'],
      ['$x', VARIABLE],
      ['like', 'keyword.operator.words.typeqlite'],
      ['"a"', DOUBLE],
    ]);
  });

  it('reads a hyphen as part of a name, never as a keyword boundary or an operator', () => {
    // `value-type` is a label, not `value`; `skill-id` has no operator in it; `$start-date` is one variable.
    expect(tokens('$x isa value-type, has skill-id $start-date;')).toEqual([
      ['$x', VARIABLE],
      ['isa', KEYWORD],
      ['has', KEYWORD],
      ['$start-date', VARIABLE],
    ]);
    expect(tokens('let $y = $a - 1;')).toEqual([
      ['let', KEYWORD],
      ['$y', VARIABLE],
      ['=', OPERATOR],
      ['$a', VARIABLE],
      ['-', OPERATOR],
      ['1', NUMBER],
    ]);
  });

  it('does not read a keyword in a path or a name, and scopes numbers in a range', () => {
    expect(tokens('fetch { "v": $p.value }; limit 10; @card(1..3)')).toEqual([
      ['fetch', KEYWORD],
      ['"v"', DOUBLE],
      ['$p', VARIABLE],
      ['limit', KEYWORD],
      ['10', NUMBER],
      ['@card', 'keyword.annotations.typeqlite'],
      ['1', NUMBER],
      ['..', OPERATOR],
      ['3', NUMBER],
    ]);
  });

  it('ends a line comment at the end of its line', () => {
    expect(tokens('# people\nmatch $p isa person;')).toEqual([
      ['# people', 'comment.line.number-sign.typeqlite'],
      ['match', KEYWORD],
      ['$p', VARIABLE],
      ['isa', KEYWORD],
    ]);
  });

  it('nests an escape inside its string, and keeps a string that spans lines as one run', () => {
    expect(tokens('"a\\"b"')).toEqual([
      ['"a', DOUBLE],
      ['\\"', DOUBLE, 'constant.character.escape.typeqlite'],
      ['b"', DOUBLE],
    ]);
    expect(tokens("'one\ntwo'")).toEqual([["'one\ntwo'", 'string.quoted.single.typeqlite']]);
  });
});

describe('a grammar construct this tokenizer does not implement is refused, never skipped', () => {
  const grammar = (rule: object): RawGrammar => ({ scopeName: 'source.test', patterns: [rule as never] });

  it('refuses a rule key it does not know', () => {
    expect(() => tokens('x', grammar({ begin: 'a', while: 'b' }))).toThrow(/Unsupported TextMate rule key\(s\): while/);
  });

  it('refuses an include from another grammar', () => {
    expect(() => tokens('x', grammar({ include: 'source.js' }))).toThrow(/Unsupported TextMate include 'source.js'/);
  });

  it('refuses an end that back-references its begin', () => {
    expect(() => tokens('x', grammar({ begin: '(<<)', end: '\\1' }))).toThrow(/back-reference/);
  });

  it('refuses a regex JavaScript cannot run', () => {
    expect(() => tokens('x', grammar({ match: '\\h+' }))).toThrow(/A TextMate regex JavaScript cannot run/);
  });

  it('follows $self into a nested rule, and does not recurse into a grammar that includes itself', () => {
    const nesting: RawGrammar = {
      scopeName: 'source.test',
      patterns: [{ include: '$self' }, { begin: '\\(', end: '\\)', name: 'group', patterns: [{ include: '$self' }] }, { match: 'x', name: 'x' }],
    };
    expect(tokens('(x)', nesting)).toEqual([['(', 'group'], ['x', 'group', 'x'], [')', 'group']]);
  });

  it('scopes captures inside their match, and ignores a capture group the match does not have', () => {
    const captured = grammar({ match: '(@)(\\w+)', name: 'annotation', captures: { '1': { name: 'sigil' }, '3': { name: 'none' } } });
    expect(tokens('@key', captured)).toEqual([['@', 'annotation', 'sigil'], ['key', 'annotation']]);
  });

  it('refuses a rule that is not a match, a begin, an include or a list of patterns', () => {
    expect(() => tokens('x', grammar({ name: 'empty' }))).toThrow(/A TextMate rule with no match, begin, include or patterns/);
  });

  it('refuses a grammar that would never advance past a position', () => {
    // A zero-width begin and a zero-width end at the same place: push, pop, push, pop, forever.
    expect(() => tokens('ab', grammar({ begin: '(?=b)', end: '(?=b)', name: 'stuck' }))).toThrow(/does not advance/);
  });

  it('steps past a zero-width match instead of matching it forever', () => {
    expect(tokens('aaa', grammar({ match: '(?=a)', name: 'x' }))).toEqual([]);
  });
});
