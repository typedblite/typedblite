import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';

import { FENCE_LANGUAGES, fenceLanguage } from '../src/fences.js';
import { newCodeCell, newMarkupCell, parseNotebook, serializeNotebook, type CodeCell, type Notebook } from '../src/format.js';

const ROOT = resolve(__dirname, '../../..');

/** Parse, then write: the bytes must come back unchanged. */
const roundTrip = (source: string): string => serializeNotebook(parseNotebook(source));
const codeCells = (notebook: Notebook): CodeCell[] => notebook.cells.filter((cell): cell is CodeCell => cell.kind === 'code');
const kinds = (source: string): string[] => parseNotebook(source).cells.map((cell) => cell.kind);

describe('which fences are cells', () => {
  const doc = ['# Title', '', 'Some prose.', '', '```typeql', 'define entity person;', '```', '', 'More prose.', '', '```typeql', 'match $p isa person;', '```', ''].join('\n');

  it('a typeql fence is a code cell, and the text around it is Markdown cells', () => {
    const notebook = parseNotebook(doc);
    expect(kinds(doc)).toEqual(['markup', 'code', 'markup', 'code']);
    expect(notebook.cells.map((c) => c.value)).toEqual(['# Title\n\nSome prose.', 'define entity person;', 'More prose.', 'match $p isa person;']);
  });

  it.each(['typeql', 'typeqlite', 'tql', 'TypeQL', 'typeql title="schema"'])('the fence language %j is TypeQLite', (info) => {
    expect(kinds(`\`\`\`${info}\nx\n\`\`\`\n`)).toEqual(['code']);
  });

  it.each(['', 'ts', 'bash', 'markdown', 'sql', 'typeqlx'])('the fence language %j is not', (info) => {
    expect(kinds(`\`\`\`${info}\nx\n\`\`\`\n`)).toEqual(['markup']);
  });

  it('a tilde fence, and a fence longer than three, are cells; a close needs the same character and at least as many', () => {
    expect(kinds('~~~typeql\nx\n~~~\n')).toEqual(['code']);
    expect(parseNotebook('````typeql\na\n```\nb\n````\n').cells[0]).toMatchObject({ kind: 'code', value: 'a\n```\nb' });
    // A tilde does not close a backtick fence.
    expect(parseNotebook('```typeql\na\n~~~\nb\n```\n').cells[0]).toMatchObject({ value: 'a\n~~~\nb' });
  });

  it('an unclosed fence runs to the end of the file', () => {
    const cell = parseNotebook('intro\n\n```typeql\nmatch $p isa person;\nselect $p;\n').cells[1];
    expect(cell).toMatchObject({ kind: 'code', value: 'match $p isa person;\nselect $p;', close: '' });
  });

  it('a typeql fence inside another fenced block stays text', () => {
    const source = '````markdown\n```typeql\ndefine entity a;\n```\n````\n';
    expect(kinds(source)).toEqual(['markup']);
    expect(kinds('```ts\n```typeql\nx\n```\n')).toEqual(['markup']);
  });

  it('a fence in a block quote, or indented (a list), is text', () => {
    expect(kinds('> ```typeql\n> define entity a;\n> ```\n')).toEqual(['markup']);
    expect(kinds('- item\n\n  ```typeql\n  define entity a;\n  ```\n')).toEqual(['markup']);
    expect(kinds('    ```typeql\n    x\n    ```\n')).toEqual(['markup']);
  });

  it('a backtick fence whose info string holds a backtick is not a fence', () => {
    expect(kinds('```typeql `x`\ny\n```\n')).toEqual(['markup']);
  });

  it('HTML comments and front matter before a fence are Markdown', () => {
    expect(kinds('---\ntitle: x\n---\n\n<!-- tour:file -->\n```typeql\nx\n```\n')).toEqual(['markup', 'code']);
  });

  it('blank lines between two code cells are not an empty Markdown cell', () => {
    const notebook = parseNotebook('```typeql\na\n```\n\n```typeql\nb\n```\n');
    expect(kinds('```typeql\na\n```\n\n```typeql\nb\n```\n')).toEqual(['code', 'code']);
    expect(codeCells(notebook)[0]!.gap).toBe('\n');
  });

  it('blank lines before the first cell are the head, and a file with no cells is all head', () => {
    expect(parseNotebook('\n\n```typeql\na\n```\n').head).toBe('\n\n');
    expect(parseNotebook('  \n\n')).toMatchObject({ head: '  \n\n', cells: [] });
    expect(parseNotebook('')).toMatchObject({ head: '', cells: [] });
  });
});

describe('parse then serialize is the identity', () => {
  const cases: Record<string, string> = {
    'an empty file': '',
    'whitespace only': ' \n\n\t\n',
    'no final newline': 'prose\n\n```typeql\na\n```',
    'an unclosed fence': 'prose\n\n```typeql\na\nb',
    'an unclosed fence with no final newline': '```typeql\na',
    'a fence with an empty body': '```typeql\n```\n',
    'CRLF line endings': 'prose\r\n\r\n```typeql\r\ndefine entity a;\r\n```\r\n\r\nmore\r\n',
    'mixed line endings': 'one\r\ntwo\n```typeql\r\nx\ny\r\n```\n',
    'CR line endings': 'one\r```typeql\rx\r```\r',
    'a byte order mark': '﻿# Title\n\n```typeql\na\n```\n',
    'a longer fence and tildes': '````typeql\n```\n````\n\n~~~tql\nz\n~~~\n',
    'info strings with attributes': '```typeql title="x" {1}\na\n```   \n',
    'a closing fence with trailing spaces': '```typeql\na\n```  \ntext\n',
    'text with trailing blank lines': '```typeql\na\n```\n\ntext\n\n\n\n',
    'leading blank lines before prose': '\n\n  indented prose\n\n```typeql\na\n```\n',
    'adjacent fences with no blank line': '```typeql\na\n```\n```typeql\nb\n```\n',
    'non-TypeQLite fences': '```ts\nconst a = 1;\n```\n\n```bash\nls\n```\n',
    'a nested typeql fence': '````markdown\n```typeql\nx\n```\n````\n',
    'non-ASCII text': '# Größe\n\n```typeql\nmatch $n has name "Zoë";\n```\n',
  };
  it.each(Object.entries(cases))('%s', (_name, source) => {
    expect(roundTrip(source)).toBe(source);
  });

  it('and parsing what was written gives the same notebook', () => {
    for (const source of Object.values(cases)) {
      const first = parseNotebook(source);
      expect(parseNotebook(serializeNotebook(first))).toEqual(first);
    }
  });
});

describe('every Markdown file in the repository', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--', '*.md'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);

  it('is a lot of files, including the guides', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain('docs/guides/five-minute-tour.tql.md');
  });

  it('round-trips byte for byte', () => {
    const changed = files.filter((file) => {
      const source = readFileSync(resolve(ROOT, file), 'utf8');
      return roundTrip(source) !== source;
    });
    expect(changed).toEqual([]);
  });

  // The cells must be what the Markdown engine the preview uses calls a TypeQLite fence, or the notebook and the
  // preview would disagree about a guide. An indented fence is a list item's, which a notebook leaves as text.
  it('has as its code cells exactly the TypeQLite fences markdown-it finds at the top level', () => {
    const md = new MarkdownIt();
    const disagreements: string[] = [];
    let cells = 0;
    for (const file of files) {
      const source = readFileSync(resolve(ROOT, file), 'utf8').replace(/\r\n?/g, '\n');
      const lines = source.split('\n');
      const expected = md
        .parse(source, {})
        .filter((token) => token.type === 'fence' && token.level === 0 && FENCE_LANGUAGES.has(fenceLanguage(token.info)) && /^[`~]/.test(lines[token.map![0]!]!))
        .map((token) => token.content);
      const actual = codeCells(parseNotebook(source)).map((cell) => (cell.value === '' && cell.tail === '' ? '' : `${cell.value}${cell.tail}`));
      cells += actual.length;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) disagreements.push(file);
    }
    expect(disagreements).toEqual([]);
    expect(cells).toBeGreaterThan(20);
  });
});

describe('editing', () => {
  const source = '# Title\n\nProse.\n\n```typeql\ndefine entity person;\n```\n\nMore.\n\n```typeql\nmatch $p isa person;\n```\n';

  it('changing one cell changes only that cell\'s lines', () => {
    const notebook = parseNotebook(source);
    const edited: Notebook = { ...notebook, cells: notebook.cells.map((cell, i) => (i === 1 ? { ...cell, value: 'define entity person, owns name;' } : cell)) };
    expect(serializeNotebook(edited)).toBe(source.replace('define entity person;', 'define entity person, owns name;'));
  });

  it('a cell with a new line at the end of its value gets a blank line, not a broken fence', () => {
    const notebook = parseNotebook(source);
    const edited: Notebook = { ...notebook, cells: notebook.cells.map((cell, i) => (i === 3 ? { ...cell, value: 'match $p isa person;\nselect $p;' } : cell)) };
    expect(parseNotebook(serializeNotebook(edited)).cells[3]).toMatchObject({ kind: 'code', value: 'match $p isa person;\nselect $p;' });
  });

  it('an added cell is written the way the guides write one, with a blank line after', () => {
    const notebook = parseNotebook(source);
    const added: Notebook = { ...notebook, cells: [...notebook.cells.slice(0, 2), newCodeCell('insert $p isa person;', notebook.eol), ...notebook.cells.slice(2)] };
    expect(serializeNotebook(added)).toBe(
      '# Title\n\nProse.\n\n```typeql\ndefine entity person;\n```\n\n```typeql\ninsert $p isa person;\n```\n\nMore.\n\n```typeql\nmatch $p isa person;\n```\n',
    );
  });

  it('a notebook built from nothing is a valid file that parses back to the same cells', () => {
    const eol = '\n';
    const built: Notebook = { head: '', eol, cells: [newMarkupCell('# New', eol), newCodeCell('define entity a;', eol), newMarkupCell('Done.', eol)] };
    const text = serializeNotebook(built);
    expect(text).toBe('# New\n\n```typeql\ndefine entity a;\n```\n\nDone.\n\n');
    expect(parseNotebook(text).cells.map((c) => [c.kind, c.value])).toEqual([['markup', '# New'], ['code', 'define entity a;'], ['markup', 'Done.']]);
  });

  it('a new cell is written with the notebook\'s line endings', () => {
    const notebook = parseNotebook('a\r\n\r\n```typeql\r\nx\r\n```\r\n');
    const added: Notebook = { ...notebook, cells: [...notebook.cells, newCodeCell('y', notebook.eol)] };
    expect(serializeNotebook(added)).not.toMatch(/(^|[^\r])\n/);
  });

  // 🔴 A value that holds a line of three backticks would close the fence early, and the next read would split the
  // cell. The fence is made longer than any such run.
  it('a value that contains a closing-fence line is written inside a longer fence, and reads back whole', () => {
    const notebook = parseNotebook('```typeql\na\n```\n');
    const value = 'match $x isa t;\n```\nnot a close\n````';
    const text = serializeNotebook({ ...notebook, cells: [{ ...notebook.cells[0]!, value }] });
    expect(text.startsWith('`````typeql\n')).toBe(true);
    expect(parseNotebook(text).cells).toHaveLength(1);
    expect(parseNotebook(text).cells[0]).toMatchObject({ kind: 'code', value });
  });

  it('a fence that is already long enough is not rewritten', () => {
    const source4 = '````typeql\na\n```\nb\n````\n';
    expect(roundTrip(source4)).toBe(source4);
  });

  it('an unclosed cell that is followed by another cell is closed, so the next cell is not written inside it', () => {
    const notebook = parseNotebook('```typeql\na\n');
    const text = serializeNotebook({ ...notebook, cells: [...notebook.cells, newMarkupCell('after', notebook.eol)] });
    expect(parseNotebook(text).cells.map((c) => [c.kind, c.value])).toEqual([['code', 'a'], ['markup', 'after']]);
  });

  it('text at the end of the file that lost its line ending does not run into the next cell\'s fence', () => {
    const notebook = parseNotebook('prose');
    const text = serializeNotebook({ ...notebook, cells: [...notebook.cells, newCodeCell('x', notebook.eol)] });
    expect(parseNotebook(text).cells.map((c) => c.kind)).toEqual(['markup', 'code']);
  });
});
