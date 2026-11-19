import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { HostClient } from '../src/host/host-client';
import { runCell } from '../src/notebook/cell-runner';
import { NotebookSessions } from '../src/notebook/notebook-sessions';
import { plainOutput, type OutputBlock } from '../src/notebook/outputs';
import { playTour, readTour, recorded, type Kernel, type Piece } from './support/tour-player';

/**
 * The five-minute tour, played top to bottom as a reader would play it (ADR-012): the notebook's cells on the notebook's own
 * kernel and the real engine host, and the shell and Node steps in a real shell with the real command line, on the same
 * files, in one timeline. Every answer the tour prints must be the one that ran.
 *
 * `TOUR_RECORD=1` rewrites the printed answers to what ran, for an author who has changed the tour or the engine on purpose.
 */
const ROOT = resolve(__dirname, '../../..');
const work = mkdtempSync(join(tmpdir(), 'typedblite-tour-journey-'));
const host = new HostClient({ sidecarPath: resolve(__dirname, '../out/host/sidecar.cjs'), configuredNode: () => process.execPath });
afterAll(async () => {
  await host.stop();
  rmSync(work, { recursive: true, force: true });
});

/** The notebook's kernel, as the extension builds it: one session per notebook, a store the reader chooses. */
function notebookKernel(sessions: NotebookSessions): Kernel {
  const runner = sessions.runnerFor('tour');
  return {
    async run(source) {
      const result = await runCell(source, host, runner, { maxRows: 1000 });
      return result.outputs.map((block: OutputBlock): Piece => ({ kind: block.kind === 'facts' ? 'facts' : 'other', text: plainOutput([block]) }));
    },
    useStore: (location, mode) => sessions.useStore('tour', { location, mode }),
  };
}

describe('the five-minute tour, played as a reader plays it', () => {
  it('every answer it prints is the one that runs', async () => {
    const markdown = readTour(ROOT);
    const sessions = new NotebookSessions(host);
    const report = await playTour(markdown, notebookKernel(sessions), work, ROOT);
    if (process.env['TOUR_RECORD'] && report.corrections.length > 0) {
      writeFileSync(join(ROOT, 'docs/guides/five-minute-tour.tql.md'), recorded(markdown, report.corrections));
    }
    expect(report.failures.join('\n\n')).toBe('');
    // The tour is a real journey: cells, command blocks and a program, not a stub.
    expect(report.cells).toBeGreaterThanOrEqual(7);
    expect(report.commands).toBeGreaterThanOrEqual(5);
    expect(report.files).toBe(1);

    // The tour's last claim: close the notebook, which closes its store, and `readlist.db` ALONE is the whole database. While the
    // notebook holds the store open its writes may still be in SQLite's write-ahead log, which is why the tour says to close first.
    await sessions.close('tour');
    const project = join(work, 'readlist');
    expect(existsSync(join(project, 'readlist.db-wal')), 'the write-ahead log is gone once the store is closed').toBe(false);
    const elsewhere = join(work, 'another-machine');
    mkdirSync(elsewhere);
    copyFileSync(join(project, 'readlist.db'), join(elsewhere, 'readlist.db'));
    const read = spawnSync(process.execPath, [join(ROOT, 'apps/cli/out/main.js'), '--database', join(elsewhere, 'readlist.db'), '--exec', 'match $b isa book, has title $t; select $t; sort $t;'], { encoding: 'utf8' });
    expect(read.stdout).toContain('t=Dune');
    expect(read.stdout).toContain('t=Emma');
    expect(read.stdout).toContain('t=Piranesi');
    expect(read.stdout).toContain('(3 rows)');
  }, 240_000);
});
