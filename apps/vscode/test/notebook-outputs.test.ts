import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';

import { toCellOutput } from '../src/notebook/cell-output';

const text = (item: vscode.NotebookCellOutputItem) => new TextDecoder().decode(item.data);

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

