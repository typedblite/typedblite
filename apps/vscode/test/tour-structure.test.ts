import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- a plain ES module with no declarations, shared with tools/tour.mjs.
import { CELL_LANGUAGES, headingsOf, parseTour } from '../../../tools/tour-doc.mjs';
import { FENCE_LANGUAGES } from '../src/markdown/protocol';
import { parseNotebook, serializeNotebook } from '../src/notebook/format';
import { describeStore } from '../src/notebook/notebook-sessions';

/**
 * The shape of the five-minute tour (`docs/guides/five-minute-tour.tql.md`): that every block in it is accounted for, that a
 * reader is never told to do something the tour has not made possible, and that it stays a tour. The answers it prints are
 * held against what runs by `tour-journey.test.ts`; this holds the page itself.
 */
const ROOT = resolve(__dirname, '../../..');
const FILE = resolve(ROOT, 'docs/guides/five-minute-tour.tql.md');
const markdown = readFileSync(FILE, 'utf8');
const { steps, problems } = parseTour(markdown) as { steps: { kind: string; line: number; [key: string]: unknown }[]; problems: string[] };
const kinds = steps.map((step) => step.kind);
/** The page's text with lines joined, for phrases that the file wraps across a line. */
const flat = markdown.replace(/\s+/g, ' ');

describe('the tour is marked up completely', () => {
  it('has no marker without its block, and no block left unclosed', () => {
    expect(problems).toEqual([]);
  });

  // 🔴 A fenced block that is none of these could be mistaken for something to run, or could rot unchecked.
  it('has no fenced block that is only prose: every block is a cell, a printed answer, or a step', () => {
    expect(steps.filter((step) => step.kind === 'prose').map((step) => `line ${step.line}: ${step['language']}`)).toEqual([]);
  });

  it('knows a TypeQLite cell exactly as the notebook does', () => {
    expect([...CELL_LANGUAGES].sort()).toEqual([...FENCE_LANGUAGES].sort());
    const cells = parseNotebook(markdown).cells.filter((cell) => cell.kind === 'code').map((cell) => cell.value);
    expect(steps.filter((step) => step.kind === 'cell').map((step) => step['source'])).toEqual(cells);
    // The page opens as a notebook and is written back byte for byte.
    expect(serializeNotebook(parseNotebook(markdown))).toBe(markdown);
  });

  it('shows the answer under every cell, so a reader without VS Code sees what it prints', () => {
    steps.forEach((step, i) => {
      if (step.kind === 'cell') expect(kinds[i + 1], `the cell at line ${step.line}`).toBe('expect');
    });
  });

  it('shows the output of every command that has one, and runs every bash block and saves every file', () => {
    // Only a block marked `tour:run` or `tour:file` is run, so an unmarked one would never be tested: none exist (see above).
    const runs = steps.filter((step) => step.kind === 'run');
    expect(runs.length).toBeGreaterThanOrEqual(5);
    for (const step of steps.filter((s) => s.kind === 'output')) {
      expect(kinds[steps.indexOf(step) - 1], `the output at line ${step.line}`).toBe('run');
    }
  });

  it('puts the notebook\'s file store before any command reads that file', () => {
    const store = kinds.indexOf('store');
    expect(store).toBeGreaterThan(-1);
    const firstRead = steps.findIndex((step) => step.kind === 'run' && String(step['body']).includes('--database readlist.db'));
    expect(store).toBeLessThan(firstRead);
    // The notebook runs the cells again on the file, so every cell before it has an answer to be held to.
    expect(steps.slice(0, store).filter((step) => step.kind === 'cell').length).toBeGreaterThanOrEqual(2);
  });
});

describe('the tour is a tour', () => {
  const headings = headingsOf(markdown) as { level: number; text: string; line: number }[];
  const numbered = headings.filter((h) => h.level === 2 && /^\d+\./.test(h.text));

  it('has one title and numbered steps 1, 2, 3 in order, then the closing sections', () => {
    expect(headings.filter((h) => h.level === 1)).toHaveLength(1);
    expect(numbered.map((h) => Number.parseInt(h.text, 10))).toEqual(numbered.map((_, i) => i + 1));
    expect(headings.filter((h) => h.level === 2 && !/^\d+\./.test(h.text)).map((h) => h.text)).toEqual(['How this tour is tested', 'Where next']);
  });

  it('refers to its own steps by the number they have', () => {
    // The program tells the reader to run "the notebook cells in step 2", and step 2 must be where the schema is.
    const step2 = numbered.find((h) => h.text.startsWith('2.'))!;
    expect(step2.text).toMatch(/Describe your data/);
    expect(flat).toContain('run the notebook cells in step 2');
    expect(flat).toContain('which you will do in step 4');
    expect(numbered.find((h) => h.text.startsWith('4.'))!.text).toMatch(/file/i);
  });

  it('is five minutes: a short page with a few cells and a few commands', () => {
    const prose = markdown.replace(/```[\s\S]*?```/g, '');
    const words = prose.split(/\s+/).filter(Boolean).length;
    expect(words, 'words of prose').toBeLessThanOrEqual(1500);
    expect(numbered.length, 'steps').toBeLessThanOrEqual(10);
    expect(steps.filter((s) => s.kind === 'cell').length, 'cells').toBeLessThanOrEqual(10);
    expect(steps.filter((s) => s.kind === 'run').length, 'command blocks').toBeLessThanOrEqual(8);
  });

  it('asks for the Node the engine needs, and nothing else', () => {
    const engines = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).engines.node as string;
    const needed = />=(\d+\.\d+)/.exec(engines)![1]!;
    expect(flat).toContain(`**Node.js ${needed} or later**`);
  });

  it('says plainly what is not published, and where to get it instead', () => {
    expect(flat).toMatch(/not published yet/);
    expect(markdown).toContain('[Getting started](getting-started.md)');
  });

  // Found by looking at the tour in a real notebook (the assertions did not): the store action is in the toolbar's overflow menu
  // and the status bar, not an icon; switching asks for a confirmation; and the toolbar's Run All is the wrong button for the tour.
  it('points the reader at the controls that are there: the status bar, the overflow menu, the confirmation, and not Run All', () => {
    expect(flat).toContain(`**${describeStore(undefined)}**`);
    expect(flat).toContain("toolbar's **…** menu");
    expect(flat).not.toMatch(/database icon/i);
    const source = readFileSync(resolve(ROOT, 'apps/vscode/src/notebook/store-commands.ts'), 'utf8');
    expect(source).toContain("'Switch'");
    expect(flat).toContain('choose **Switch**');
    expect(flat).toContain("the toolbar's **Run All** would run cells that need the command line first");
    // The status bar says which file and mode once a store is chosen, as the tour tells the reader it will.
    expect(describeStore({ location: '/x/readlist.db', mode: 'auto' })).toBe('readlist.db · commits each statement');
    expect(flat).toContain('`readlist.db · commits each statement`');
  });

  it('starts from an empty folder called readlist, and every later step works in it', () => {
    expect(flat).toContain('Make an empty folder called `readlist`');
    expect(flat).toContain('Open a terminal in the `readlist` folder');
    // The store is saved there, so the command line, which runs in that folder, finds `readlist.db`.
    expect(flat).toContain('save it as `readlist.db` in the `readlist` folder');
  });

  it('names the notebook controls by the names the extension gives them', () => {
    const manifest = JSON.parse(readFileSync(resolve(ROOT, 'apps/vscode/package.json'), 'utf8'));
    const title = manifest.contributes.commands.find((c: { command: string }) => c.command === 'typedblite.notebook.openStore').title as string;
    expect(flat).toContain(`**${title}**`);
    // The choices the dialogs offer, as the reader reads them.
    const source = readFileSync(resolve(ROOT, 'apps/vscode/src/notebook/store-commands.ts'), 'utf8');
    for (const label of ['Create a new store file…', 'Commit each statement']) {
      expect(source, label).toContain(label);
      expect(flat, label).toContain(label);
    }
  });
});

describe('the links in the tour go somewhere', () => {
  const links = [...markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]!).filter((target) => !/^https?:/.test(target));
  const slug = (text: string) => text.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

  it('has some', () => {
    expect(links.length).toBeGreaterThan(5);
  });

  it.each(links)('%s exists, and so does its anchor', (target) => {
    const [path, anchor] = target.split('#') as [string, string | undefined];
    const file = path === '' ? FILE : resolve(dirname(FILE), path);
    expect(existsSync(file), `${path} (from the tour)`).toBe(true);
    if (anchor) {
      const headings = (headingsOf(readFileSync(file, 'utf8')) as { text: string }[]).map((h) => slug(h.text));
      expect(headings, `#${anchor} in ${path || 'the tour'}`).toContain(anchor);
    }
  });
});
