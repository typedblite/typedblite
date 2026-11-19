import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { NotebookSessions, plainOutput, runCell, type OutputBlock } from '@typedblite/notebook';
import { afterAll, describe, expect, it } from 'vitest';

import { createKernel } from '../src/notebook/kernel-core';
// The one player of the tour's document, shared with the VS Code extension's tests.
import { playTour, recorded, type Kernel, type Piece } from '../../vscode/test/support/tour-player';

/**
 * The browser notebook's document (`docs/guides/try-it.tql.md`), played top to bottom on the browser's kernel: every cell
 * is run by the shared notebook code on the shared session, and every answer the page prints is held to what ran.
 * (`test-browser/notebook.test.ts` plays the same document in Chromium, on WASM SQLite, through the page itself.)
 *
 * `TOUR_RECORD=1` rewrites the printed answers to what ran, for an author who changed the guide or the engine on purpose.
 */
const ROOT = resolve(__dirname, '../../..');
const FILE = join(ROOT, 'docs/guides/try-it.tql.md');
const work = mkdtempSync(join(tmpdir(), 'typedblite-try-it-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function kernel(): Kernel {
  const engine = createKernel();
  const sessions = new NotebookSessions(engine);
  const runner = sessions.runnerFor('try');
  return {
    async run(source) {
      const result = await runCell(source, engine, runner, { maxRows: 1000, unavailableTitle: 'The engine stopped' });
      return result.outputs.map((block: OutputBlock): Piece => ({ kind: block.kind === 'facts' ? 'facts' : 'other', text: plainOutput([block]) }));
    },
    useStore: () => Promise.reject(new Error('the browser notebook has no store to choose')),
  };
}

describe('the browser notebook\'s document, played as a reader plays it', () => {
  it('every answer it prints is the one that runs', async () => {
    const { readFileSync } = await import('node:fs');
    const markdown = readFileSync(FILE, 'utf8');
    const report = await playTour(markdown, kernel(), work, ROOT);
    if (process.env['TOUR_RECORD'] && report.corrections.length > 0) writeFileSync(FILE, recorded(markdown, report.corrections));
    expect(report.failures.join('\n\n')).toBe('');
    expect(report.cells).toBe(9);
    // No shell steps: everything happens in the notebook.
    expect(report.commands).toBe(0);
    expect(report.files).toBe(0);
  }, 120_000);
});
