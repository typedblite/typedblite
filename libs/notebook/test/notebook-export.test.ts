import { describe, expect, it } from 'vitest';

import { exportMarkdown, exportScript, type ExportCell } from '../src/export.js';
import { parseNotebook } from '../src/format.js';

const md = (value: string): ExportCell => ({ kind: 'markup', value });
const tql = (value: string): ExportCell => ({ kind: 'code', value });

describe('export as a TypeQLite script', () => {
  it('is the code cells only, in order, one blank line apart, ending in one line ending', () => {
    expect(exportScript([md('# Title'), tql('define entity a;'), md('Some prose.'), tql('insert $x isa a;'), tql('match $x isa a;\nselect $x;')])).toBe(
      'define entity a;\n\ninsert $x isa a;\n\nmatch $x isa a;\nselect $x;\n',
    );
  });

  it('leaves a cell\'s text as written, and drops trailing blank space', () => {
    expect(exportScript([tql('define\n  entity a;\n\n\n')])).toBe('define\n  entity a;\n');
  });

  it('skips empty code cells, and is empty for a notebook with no code', () => {
    expect(exportScript([tql('  \n'), md('only prose')])).toBe('');
    expect(exportScript([])).toBe('');
    expect(exportScript([tql('a;'), tql(''), tql('b;')])).toBe('a;\n\nb;\n');
  });

  it('keeps the comments a cell has', () => {
    expect(exportScript([tql('# the schema\ndefine entity a;')])).toBe('# the schema\ndefine entity a;\n');
  });
});

describe('export as Markdown', () => {
  it('is the prose as written and each code cell as a fenced typeql block', () => {
    expect(exportMarkdown([md('# Title\n\nSome prose.'), tql('define entity a;'), md('Then:'), tql('match $x isa a;')])).toBe(
      '# Title\n\nSome prose.\n\n```typeql\ndefine entity a;\n```\n\nThen:\n\n```typeql\nmatch $x isa a;\n```\n',
    );
  });

  it('ends the file with one line ending, after prose or after code', () => {
    expect(exportMarkdown([tql('a;'), md('The end.')])).toBe('```typeql\na;\n```\n\nThe end.\n');
    expect(exportMarkdown([md('Intro.'), tql('a;')])).toBe('Intro.\n\n```typeql\na;\n```\n');
  });

  it('writes the guides\' spelling whatever fence the notebook file used', () => {
    const notebook = parseNotebook('~~~tql\nx\n~~~\n\n````typeqlite\ny\n````\n');
    const exported = exportMarkdown(notebook.cells.map((c) => ({ kind: c.kind, value: c.value })));
    expect(exported).toBe('```typeql\nx\n```\n\n```typeql\ny\n```\n');
  });

  it('a notebook already in the guides\' spelling comes back unchanged', () => {
    const source = '# Reading list\n\nA schema:\n\n```typeql\ndefine attribute title, value string;\n```\n\nThen a query:\n\n```typeql\nmatch $b isa book;\n```\n';
    const notebook = parseNotebook(source);
    expect(exportMarkdown(notebook.cells.map((c) => ({ kind: c.kind, value: c.value })))).toBe(source);
  });

  it('uses the notebook\'s line ending', () => {
    expect(exportMarkdown([tql('a;')], '\r\n')).toBe('```typeql\r\na;\r\n```\r\n');
  });

  it('a cell holding a closing-fence line is written inside a longer fence, and reads back whole', () => {
    const out = exportMarkdown([tql('a;\n```\nb;')]);
    expect(parseNotebook(out).cells).toMatchObject([{ kind: 'code', value: 'a;\n```\nb;' }]);
  });

  it('has no outputs: the exports are of the cells\' text only', () => {
    expect(exportMarkdown([tql('a;')])).not.toMatch(/stdout|output/i);
  });
});
