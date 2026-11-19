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
