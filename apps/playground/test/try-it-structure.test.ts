import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseNotebook, serializeNotebook } from '@typedblite/notebook';
import { describe, expect, it } from 'vitest';

// @ts-expect-error -- a plain ES module with no declarations, shared with tools/tour.mjs.
import { headingsOf, parseTour } from '../../../tools/tour-doc.mjs';

/**
 * The shape of the browser notebook's document (`docs/guides/try-it.tql.md`): that it is marked up completely, that every cell
 * shows its answer, and that it never tells a reader to do something a page in a browser cannot. What the answers are is held
 * to what runs by `try-it-journey.test.ts`, and in Chromium by `test-browser/notebook.test.ts`.
 */
const markdown = readFileSync(resolve(__dirname, '../../../docs/guides/try-it.tql.md'), 'utf8');
const { steps, problems } = parseTour(markdown) as { steps: { kind: string; line: number; [key: string]: unknown }[]; problems: string[] };
const kinds = steps.map((step) => step.kind);
const flat = markdown.replace(/\s+/g, ' ');

describe('the browser notebook\'s document is marked up completely', () => {
  it('has no marker without its block, and no fenced block that is only prose', () => {
    expect(problems).toEqual([]);
    expect(steps.filter((step) => step.kind === 'prose').map((step) => `line ${step.line}`)).toEqual([]);
  });

  it('shows the answer under every cell, so a reader sees what a cell prints before running it', () => {
    steps.forEach((step, i) => {
      if (step.kind === 'cell') expect(kinds[i + 1], `the cell at line ${step.line}`).toBe('expect');
    });
  });

  it('opens as a notebook of nine cells and is written back byte for byte', () => {
    const cells = parseNotebook(markdown).cells.filter((cell) => cell.kind === 'code');
    expect(cells).toHaveLength(9);
    expect(steps.filter((step) => step.kind === 'cell').map((step) => step['source'])).toEqual(cells.map((cell) => cell.value));
    expect(serializeNotebook(parseNotebook(markdown))).toBe(markdown);
  });
});

describe('it asks nothing of a browser that a browser cannot do', () => {
  it('has no shell step, saved file or store to choose: everything happens in a cell', () => {
    expect(kinds.filter((kind) => ['run', 'output', 'file', 'store'].includes(kind))).toEqual([]);
  });

  it('never sends a reader to a command line, an editor or a file it cannot open here, before it says where next', () => {
    // "Where next" is where it points to the tour, which does use them.
    expect(flat.slice(0, flat.indexOf('## Where next'))).not.toMatch(/\bnpx\b|\bnpm\b|\bnode\b|VS Code|--database|\.db\b/i);
  });

  it('is a page with a title, numbered steps in order, and somewhere to go next', () => {
    const headings = headingsOf(markdown) as { level: number; text: string }[];
    expect(headings.filter((h) => h.level === 1)).toHaveLength(1);
    const numbered = headings.filter((h) => h.level === 2 && /^\d+\./.test(h.text)).map((h) => Number.parseInt(h.text, 10));
    expect(numbered).toEqual([1, 2, 3, 4, 5]);
    expect(headings.at(-1)?.text).toBe('Where next');
  });

  it('ends on the refusal, so Run all stops there on purpose and says so', () => {
    expect(flat).toMatch(/stops at the last cell, which is refused on purpose/);
  });
});
