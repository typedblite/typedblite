import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { HostClient } from '../src/host/host-client';
import { parseNotebook } from '../src/notebook/format';
import type { RunResult } from '../src/notebook/host-types';
import { NotebookSessions } from '../src/notebook/notebook-sessions';

/**
 * The guide as a notebook (`docs/guides/reading-list.tql.md`) is the TypeQLite half of the five-minute tour, and it runs:
 * every cell is run through the real engine host, with no VS Code, and its answers are the tour's. The notebook's statements
 * are the tour's own (read from it here), so neither can drift from the other.
 */
const ROOT = resolve(__dirname, '../../..');
const tour = readFileSync(resolve(ROOT, 'docs/guides/five-minute-tour.md'), 'utf8');
const guide = readFileSync(resolve(ROOT, 'docs/guides/reading-list.tql.md'), 'utf8');
const cells = parseNotebook(guide).cells.filter((cell) => cell.kind === 'code').map((cell) => cell.value);

/** The tour's blocks, found by the markers `npm run tour` runs them by. */
const tourSchema = /<!-- tour:file schema\.tql -->\n```typeql\n([\s\S]*?)\n```/.exec(tour)![1]!;
const tourExecs = [...tour.matchAll(/--exec '([^']*)'/g)].map((m) => m[1]!);
const tourOutputs = [...tour.matchAll(/<!-- tour:output -->\n```text\n([\s\S]*?)\n```/g)].map((m) => m[1]!);

const host = new HostClient({ sidecarPath: resolve(__dirname, '../out/host/sidecar.cjs'), configuredNode: () => process.execPath });
afterAll(async () => {
  await host.stop();
});

/** Every cell, run in order as Run All does, each statement's raw answer kept. */
async function runGuide(): Promise<RunResult[]> {
  const run = new NotebookSessions(host).runnerFor('guide');
  const answers: RunResult[] = [];
  for (const cell of cells) {
    const { statements } = await host.call<{ statements: string[] }>('statement.split', { source: cell });
    for (const statement of statements) answers.push((await run.run(statement)).result);
  }
  return answers;
}

const rows = (result: RunResult | undefined) => (result && 'rows' in result ? result.rows : []);
const line = (row: Readonly<Record<string, string>>) => `${row['s'] === 'done' ? '[x]' : '[ ]'} ${row['t']} by ${row['a']}`;

describe('the reading list guide, as a notebook', () => {
  it('is a notebook: Markdown around nine TypeQLite cells', () => {
    expect(cells).toHaveLength(9);
    expect(parseNotebook(guide).cells.some((cell) => cell.kind === 'markup')).toBe(true);
  });

  it('uses the tour\'s own statements', () => {
    expect(cells[0]).toBe(tourSchema);
    // The tour inserts Dune and asks for it from the command line; the notebook does the same, word for word.
    expect(cells[1]).toBe(tourExecs[0]);
    expect(cells[2]).toBe(tourExecs[1]);
    // And looks at what is finished, as the tour's last step does.
    expect(cells[6]).toBe(tourExecs[2]);
  });

  it('runs to completion, and the answers are the tour\'s', async () => {
    const answers = await runGuide();

    // Every statement before the deliberate refusal answered.
    const refused = answers.filter((answer) => answer.kind === 'refused');
    expect(refused).toHaveLength(1);
    expect(answers.at(-1)?.kind).toBe('refused');

    // The tour's first query, the last two lines of its first output: `t=Dune  a=Frank Herbert  s=to-read` and `(1 row)`.
    const first = rows(answers[2]);
    expect(first).toHaveLength(1);
    expect(`t=${first[0]!['t']}  a=${first[0]!['a']}  s=${first[0]!['s']}\n(${first.length} row)`).toBe(tourOutputs[0]!.split('\n').slice(2).join('\n'));

    // The tour's list after adding Piranesi and finishing Dune: the last two `[ ]` lines of its program's output.
    const list = rows(answers[5]).map(line);
    expect(list.join('\n')).toBe(tourOutputs[1]!.split('\n').filter((l) => l.startsWith('[')).slice(-2).join('\n'));

    // The tour's last step: `t=Dune (1 row)`.
    const done = rows(answers[6]);
    expect(`t=${done[0]!['t']}\n(${done.length} row)`).toBe(tourOutputs.at(-1));
  });

  it('shows the two refusals the tour shows: nothing to update says so, and a repeated key is refused by the engine', async () => {
    const answers = await runGuide();
    // "No book called ..." in the tour is the `typedblite.empty-match` fact.
    const nothing = answers.at(-2)!;
    expect(nothing).toMatchObject({ kind: 'ok', diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'typedblite.empty-match' })]) });
    // "Already on the list" in the tour is `DiagnosticCode.constraintViolated`.
    const duplicate = answers.at(-1)!;
    expect(duplicate).toMatchObject({ kind: 'refused', reason: 'engine', diagnostics: [expect.objectContaining({ code: 'typedblite.constraint-violated' })] });
  });
});
