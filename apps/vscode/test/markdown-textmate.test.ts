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

/** Each token as its text and its scopes. */
const tokens = (text: string, grammar: RawGrammar = GRAMMAR) =>
  tokenizeTextMate(grammar, text).map((token) => [text.slice(token.offset, token.offset + token.length), ...token.scopes]);

describe('the TextMate layer, on the grammar the editor uses', () => {
  it('scopes keywords and strings, and leaves labels and variables to the semantic layer', () => {
    expect(tokens('match $p isa person, has name "Ann";')).toEqual([
      ['match', KEYWORD],
      ['isa', KEYWORD],
      ['has', KEYWORD],
      ['"Ann"', DOUBLE],
    ]);
  });

  it('scopes annotations as keywords', () => {
    expect(tokens('entity person, owns email @key;')).toEqual([
      ['entity', KEYWORD],
      ['owns', KEYWORD],
      ['@key', KEYWORD],
    ]);
  });

  it('ends a line comment at the end of its line', () => {
    expect(tokens('# people\nmatch $p isa person;')).toEqual([
      ['# people', 'comment.line.typeqlite'],
      ['match', KEYWORD],
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

  it('steps past a zero-width match instead of matching it forever', () => {
    expect(tokens('aaa', grammar({ match: '(?=a)', name: 'x' }))).toEqual([]);
  });
});
