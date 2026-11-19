import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';

import { TypeQLiteNotebookSerializer } from '../src/notebook/serializer';

const serializer = new TypeQLiteNotebookSerializer();
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (data: Uint8Array): string => new TextDecoder('utf-8', { ignoreBOM: true }).decode(data);
const open = (source: string) => serializer.deserializeNotebook(bytes(source));
const save = (data: vscode.NotebookData) => text(serializer.serializeNotebook(data));

const SOURCE = '# Reading list\n\nA schema:\n\n```typeql\ndefine attribute title, value string;\n```\n\nThen a query:\n\n```typeql\nmatch $b isa book;\n```\n';

describe('opening a notebook', () => {
  it('makes a Markdown cell of the prose and a TypeQLite code cell of each fence', () => {
    const data = open(SOURCE);
    expect(data.cells.map((c) => [c.kind, c.languageId, c.value])).toEqual([
      [vscode.NotebookCellKind.Markup, 'markdown', '# Reading list\n\nA schema:'],
      [vscode.NotebookCellKind.Code, 'typeqlite', 'define attribute title, value string;'],
      [vscode.NotebookCellKind.Markup, 'markdown', 'Then a query:'],
      [vscode.NotebookCellKind.Code, 'typeqlite', 'match $b isa book;'],
    ]);
  });

  it('has no outputs', () => {
    for (const cell of open(SOURCE).cells) expect(cell.outputs ?? []).toEqual([]);
  });

  it('keeps what the cells do not show in metadata, and the file\'s line ending on the notebook', () => {
    const data = open('a\r\n\r\n```typeql\r\nx\r\n```\r\n');
    expect(data.metadata).toEqual({ head: '', eol: '\r\n' });
    expect(data.cells[1]!.metadata).toEqual({ open: '```typeql\r\n', close: '```\r\n', tail: '\r\n', gap: '' });
  });
});

describe('saving a notebook', () => {
  it.each([
    ['the sample', SOURCE],
    ['CRLF', SOURCE.replace(/\n/g, '\r\n')],
    ['a byte order mark', `﻿${SOURCE}`],
    ['no final newline', SOURCE.trimEnd()],
    ['an unclosed fence', '```typeql\nmatch $b isa book;\n'],
    ['nothing', ''],
  ])('writes an unchanged notebook back byte for byte: %s', (_name, source) => {
    expect(save(open(source))).toBe(source);
  });

  it('writes the guide that the five-minute tour is, byte for byte', () => {
    const tour = readFileSync(resolve(__dirname, '../../../docs/guides/five-minute-tour.tql.md'), 'utf8');
    const data = open(tour);
    // The tour is mostly shell and TypeScript, and has one TypeQLite fence; making it a runnable notebook is Phase 06.
    expect(data.cells.filter((c) => c.kind === vscode.NotebookCellKind.Code).length).toBeGreaterThanOrEqual(1);
    expect(save(data)).toBe(tour);
  });

  // 🔴 Feature invariant 4: running a notebook must not change the file.
  it('writes no output, however many a cell holds', () => {
    const data = open(SOURCE);
    data.cells[1]!.outputs = [{ items: [{ mime: 'text/plain', data: bytes('42 rows') }] }];
    expect(save(data)).toBe(SOURCE);
  });

  it('changes only the cell that was edited', () => {
    const data = open(SOURCE);
    data.cells[3]!.value = 'match $b isa book, has title $t;';
    expect(save(data)).toBe(SOURCE.replace('match $b isa book;', 'match $b isa book, has title $t;'));
  });

  it('writes a cell added in the editor, which has no metadata, the way the guides write one', () => {
    const data = open(SOURCE);
    data.cells.splice(2, 0, new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'insert $b isa book;', 'typeqlite'));
    expect(save(data)).toBe(SOURCE.replace('Then a query:', '```typeql\ninsert $b isa book;\n```\n\nThen a query:'));
  });

  it('writes a new notebook, with no metadata at all, as a valid file', () => {
    const data = new vscode.NotebookData([
      new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, '# Hello', 'markdown'),
      new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'define entity a;', 'typeqlite'),
    ]);
    expect(save(data)).toBe('# Hello\n\n```typeql\ndefine entity a;\n```\n');
  });

  it('a cell appended after the last one is set off by a blank line, and ends the file with one line ending', () => {
    const data = open('# Title\n\n```typeql\ndefine entity a;\n```\n');
    data.cells.push(new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'match $x isa a;', 'typeqlite'));
    expect(save(data)).toBe('# Title\n\n```typeql\ndefine entity a;\n```\n\n```typeql\nmatch $x isa a;\n```\n');

    const prose = open('Just prose');
    prose.cells.push(new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, 'More prose', 'markdown'));
    expect(save(prose)).toBe('Just prose\n\nMore prose\n');
  });

  it('a code cell turned into Markdown leaves its fence lines behind', () => {
    const data = open(SOURCE);
    const cell = data.cells[1]!;
    cell.kind = vscode.NotebookCellKind.Markup;
    cell.languageId = 'markdown';
    expect(save(data)).toBe(SOURCE.replace('```typeql\ndefine attribute title, value string;\n```\n\n', 'define attribute title, value string;\n\n'));
  });

  it('a Markdown cell turned into code is fenced', () => {
    const data = open(SOURCE);
    data.cells[2]!.kind = vscode.NotebookCellKind.Code;
    expect(save(data)).toContain('```typeql\nThen a query:\n```\n');
  });
});
