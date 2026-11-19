import { describe, expect, it } from 'vitest';

import { classifyStatement, locateStatements, splitStatements } from '../src/index.js';

describe('classifyStatement', () => {
  it.each([
    ['', 'empty'],
    ['   \n', 'empty'],
    ['define entity person;', 'define'],
    ['  DEFINE entity person;', 'define'],
    ['match $p isa person; select $p;', 'read'],
    ['match $p isa person;', 'read'],
    ['insert $p isa person;', 'write'],
    ['match $p isa person; delete $p;', 'write'],
    ['match $p isa person; update $p has age 3;', 'write'],
    ['put $p isa person;', 'write'],
  ])('%j is %s', (text, kind) => {
    expect(classifyStatement(text)).toBe(kind);
  });

  it('does not take a write keyword inside a string for a write', () => {
    expect(classifyStatement('match $p isa person, has note "please insert this"; select $p;')).toBe('read');
    expect(classifyStatement("match $p isa person, has note 'delete me'; select $p;")).toBe('read');
    expect(classifyStatement('match $p isa person, has note "a \\" insert"; select $p;')).toBe('read');
  });
});

describe('splitStatements', () => {
  it('keeps a match/insert pipeline whole and separates independent statements', () => {
    expect(splitStatements('match $s isa project;\ninsert $x isa task;\ninsert $y isa task;')).toEqual([
      'match $s isa project;\ninsert $x isa task;',
      'insert $y isa task;',
    ]);
  });

  it('keeps a define block whole, up to the pipeline that follows it', () => {
    expect(splitStatements('define entity a; entity b;\ninsert $x isa a;')).toEqual(['define entity a; entity b;', 'insert $x isa a;']);
  });

  it('drops comment lines and keeps an unterminated tail', () => {
    expect(splitStatements('# note\ninsert $a isa a;\ninsert $b isa b')).toEqual(['insert $a isa a;', 'insert $b isa b']);
  });
});

describe('splitStatements keeps a statement whole', () => {
  it('across a fetch sub-query and a block, whose semicolons are their own', () => {
    const fetch = 'match $p isa person, has name $n;\nfetch { "n": $n, "others": [ match $p has name $o; $o != $n; fetch { "o": $o }; ] };';
    expect(splitStatements(`${fetch}\ninsert $x isa a;`)).toEqual([fetch, 'insert $x isa a;']);
    const negated = 'match $p isa person; not { $p has age $a; $a < 20; }; select $p;';
    expect(splitStatements(negated)).toEqual([negated]);
  });

  it('across the patterns of one write: no statement begins with a variable or a role list', () => {
    const insert = 'insert $a isa person, has name "Ann";\n  $b isa person, has name "Bob";\n  (friend: $a, friend: $b) isa friendship;';
    expect(splitStatements(`${insert}\ninsert $c isa person;`)).toEqual([insert, 'insert $c isa person;']);
  });

  it('across a semicolon in a string, or in a comment at the end of a line', () => {
    expect(splitStatements('insert $n isa note, has text "a; b";\ninsert $m isa note;')).toEqual(['insert $n isa note, has text "a; b";', 'insert $m isa note;']);
    expect(splitStatements("insert $n isa note, has text 'it\\'s; here';")).toEqual(["insert $n isa note, has text 'it\\'s; here';"]);
    expect(splitStatements('match $p isa person; # one; two\nselect $p;')).toEqual(['match $p isa person; # one; two\nselect $p;']);
  });
});

describe('locateStatements', () => {
  const SOURCES = [
    'match $s isa project;\ninsert $x isa task;\ninsert $y isa task;',
    'define entity a; entity b;\ninsert $x isa a;',
    '# a heading\n\nmatch $p isa person;\n  # why this filter\n  $p has age $a;\nselect $a;\n\n  insert $q isa person;',
    'match $p isa person; select $p; sort $p; limit 1;\nmatch $q isa person; reduce $n = count;',
    'insert $x isa a;\n\n   insert $y isa b; # trailing\n',
    '',
  ];

  it('finds the statements splitStatements finds, comment lines aside', () => {
    for (const source of SOURCES) {
      const withoutComments = (text: string): string => text.replace(/^\s*#[^\n]*$/gm, '');
      expect(locateStatements(source).map((statement) => withoutComments(statement.text))).toEqual(splitStatements(source).map(withoutComments));
    }
  });

  it('says where each starts, and keeps the comments inside one as written', () => {
    expect(locateStatements(SOURCES[2]!)).toEqual([
      { text: 'match $p isa person;\n  # why this filter\n  $p has age $a;\nselect $a;', line: 2, character: 0 },
      { text: 'insert $q isa person;', line: 7, character: 2 },
    ]);
  });

  it('places each statement at its own text in the source', () => {
    for (const source of SOURCES) {
      const lines = source.split('\n');
      for (const statement of locateStatements(source)) {
        const first = statement.text.split('\n')[0]!;
        expect(lines[statement.line]!.slice(statement.character, statement.character + first.length)).toBe(first);
      }
    }
  });
});
