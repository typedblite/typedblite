import { describe, expect, it } from 'vitest';

import { markdownTable, notShown, plainOutput, plainTable } from '../src/outputs.js';

describe('a table as Markdown', () => {
  it('has a header, a rule and a row per answer', () => {
    expect(markdownTable(['p', 'n'], [['entity:person:#1', 'Ada']])).toBe('| p | n |\n| --- | --- |\n| entity:person:\\#1 | Ada |');
  });

  // 🔴 A value is data. Nothing in an answer may change the table or become markup in the notebook.
  it.each([
    ['a pipe', 'a|b', 'a\\|b'],
    ['a dollar, which a renderer reads as math', '$x$', '\\$x\\$'],
    ['HTML', '<script>alert(1)</script>', '\\<script\\>alert\\(1\\)\\</script\\>'],
    ['emphasis', '*bold* _it_', '\\*bold\\* \\_it\\_'],
    ['a link', '[x](http://e.example)', '\\[x\\]\\(http://e\\.example\\)'],
    ['a backslash', 'a\\b', 'a\\\\b'],
    ['a newline', 'one\ntwo', 'one two'],
    ['an entity', '&lt;', '\\&lt;'],
  ])('makes %s literal', (_name, value, expected) => {
    expect(markdownTable(['v'], [[value]]).split('\n')[2]).toBe(`| ${expected} |`);
  });

  it('escapes a column name the same way', () => {
    expect(markdownTable(['a|b'], [])).toContain('a\\|b');
  });
});

describe('a table as plain text', () => {
  it('pads columns to the widest value', () => {
    expect(plainTable(['p', 'name'], [['entity:person:#1', 'Ada'], ['x', 'Grace Hopper']])).toBe(
      ['p                 name', '----------------  ------------', 'entity:person:#1  Ada', 'x                 Grace Hopper'].join('\n'),
    );
  });
});

describe('what was not shown', () => {
  const block = (rows: number, total: number) => ({ kind: 'table' as const, columns: ['x'], rows: Array.from({ length: rows }, () => ['v']), total });
  it('says how many rows were cut, with the total', () => {
    expect(notShown(block(2, 5))).toBe('3 more rows are not shown (5 in all).');
    expect(notShown(block(4, 5))).toBe('1 more row is not shown (5 in all).');
  });
  it('says nothing when everything is shown', () => {
    expect(notShown(block(5, 5))).toBeUndefined();
  });
});

describe('a cell\'s output as plain text', () => {
  const table = { kind: 'table' as const, columns: ['t'], rows: [['Dune']], total: 1 };
  const facts = { kind: 'facts' as const, lines: ['Matched 1 row(s).'] };

  it('is the blocks in order, a blank line apart', () => {
    expect(plainOutput([table, facts])).toBe('t\n----\nDune\n\nMatched 1 row(s).');
  });

  it('can leave out the engine\'s facts, and keeps everything else', () => {
    expect(plainOutput([table, facts], { facts: false })).toBe('t\n----\nDune');
    expect(plainOutput([{ kind: 'text', text: 'OK.' }, facts], { facts: false })).toBe('OK.');
  });

  it('says how many rows were not shown, under the table', () => {
    expect(plainOutput([{ ...table, total: 3 }])).toBe('t\n----\nDune\n\n2 more rows are not shown (3 in all).');
  });

  it('shows a refusal as its title, the engine\'s message and its place', () => {
    expect(plainOutput([{ kind: 'refusal', title: 'TypeQLite refused this statement', message: 'nope', line: 2, column: 5 }])).toBe(
      'TypeQLite refused this statement: nope (line 2, column 5)',
    );
    expect(plainOutput([{ kind: 'refusal', title: 'T', message: 'm' }])).toBe('T: m');
  });

  it('shows documents as JSON, and a heading as its text', () => {
    expect(plainOutput([{ kind: 'json', documents: [{ a: 1 }] }])).toBe('{\n  "a": 1\n}');
    expect(plainOutput([{ kind: 'heading', text: 'Statement 1 of 2' }, { kind: 'text', text: '(no rows)' }])).toBe('Statement 1 of 2\n\n(no rows)');
  });

  it('is empty for a cell that shows nothing', () => {
    expect(plainOutput([])).toBe('');
  });
});
