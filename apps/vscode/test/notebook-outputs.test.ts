import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';

import { toCellOutput } from '../src/notebook/controller';
import { markdownTable, notShown, plainTable } from '../src/notebook/outputs';

const text = (item: vscode.NotebookCellOutputItem) => new TextDecoder().decode(item.data);

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

describe('an output block as VS Code output items', () => {
  const items = (block: Parameters<typeof toCellOutput>[0]) => toCellOutput(block).items.map((item) => [item.mime, text(item)]);

  it('a table is Markdown first and plain text second, with the count of rows not shown', () => {
    const [markdown, plain] = items({ kind: 'table', columns: ['n'], rows: [['Ada']], total: 3 });
    expect(markdown![0]).toBe('text/markdown');
    expect(markdown![1]).toContain('| n |');
    expect(markdown![1]).toContain('2 more rows are not shown (3 in all).');
    expect(plain![0]).toBe('text/plain');
    expect(plain![1]).toContain('2 more rows are not shown (3 in all).');
  });

  it('documents are JSON: one is itself, several are an array', () => {
    expect(items({ kind: 'json', documents: [{ a: 1 }] })).toEqual([['application/json', '{"a":1}']]);
    expect(items({ kind: 'json', documents: [{ a: 1 }, { a: 2 }] })).toEqual([['application/json', '[{"a":1},{"a":2}]']]);
  });

  it('facts are standard output, one per line', () => {
    expect(items({ kind: 'facts', lines: ['Wrote 1 thing(s).', 'warning: x'] })).toEqual([['application/vnd.code.notebook.stdout', 'Wrote 1 thing(s).\nwarning: x\n']]);
  });

  it('a refusal is an error output with the engine\'s message, its place in the cell, and no stack', () => {
    const [mime, body] = items({ kind: 'refusal', title: 'TypeQLite refused this statement', message: 'nope', line: 3, column: 7 })[0]!;
    expect(mime).toBe('application/vnd.code.notebook.error');
    expect(JSON.parse(body!)).toEqual({ name: 'TypeQLite refused this statement', message: 'nope (line 3, column 7)', stack: '' });
  });

  it('a refusal with no place says none', () => {
    expect(JSON.parse(items({ kind: 'refusal', title: 'T', message: 'm' })[0]![1]!).message).toBe('m');
  });
});
