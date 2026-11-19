import { NotebookSessions, runCell } from '@typedblite/notebook';
import { describe, expect, it } from 'vitest';

import { createKernel } from '../src/notebook/kernel-core';

/**
 * The shared notebook code (`@typedblite/notebook`, which the VS Code extension runs on the engine host) running on the
 * browser's kernel, unchanged: the same runner, the same sessions, the same refusals. This is what makes a cell answer in
 * the browser as it does in the editor.
 */
const SCHEMA = 'define attribute title, value string; entity book, owns title;';

function notebook() {
  const kernel = createKernel();
  const sessions = new NotebookSessions(kernel);
  const run = (source: string) => runCell(source, kernel, sessions.runnerFor('nb'), { maxRows: 1000, unavailableTitle: 'The engine stopped' });
  return { kernel, sessions, run };
}

describe('the notebook\'s runner on the browser kernel', () => {
  it('a later cell sees what an earlier cell defined and inserted', async () => {
    const { run } = notebook();
    expect((await run(SCHEMA)).outputs[0]).toEqual({ kind: 'text', text: 'Schema applied.' });
    await run('insert $b isa book, has title "Dune";');
    const read = await run('match $b isa book, has title $t; select $t;');
    expect(read.outputs[0]).toEqual({ kind: 'table', columns: ['t'], rows: [['Dune']], total: 1 });
  });

  it('stops a cell at its first refusal, with the engine\'s own message, and keeps what ran before it', async () => {
    const { run } = notebook();
    await run(SCHEMA);
    const result = await run('insert $b isa book, has title "Kept";\ninsert $x isa nonexistent-type;\ninsert $b isa book, has title "Never";');
    expect(result.failed).toBe(true);
    expect(result.outputs.find((o) => o.kind === 'refusal')).toMatchObject({ title: 'TypeQLite refused this statement', message: expect.stringContaining('nonexistent-type') });
    expect((await run('match $b isa book, has title $t; select $t;')).outputs[0]).toMatchObject({ rows: [['Kept']] });
  });

  it('restart gives an empty store, and a cell that needs the schema is refused', async () => {
    const { run, sessions } = notebook();
    await run(SCHEMA);
    expect(await sessions.restart('nb')).toBe('restarted');
    expect((await run('match $b isa book; select $b;')).outputs.find((o) => o.kind === 'refusal')).toMatchObject({ title: 'No schema yet' });
  });

  it('opens a new session and says so when the engine was reset under the notebook (a timed-out statement)', async () => {
    const { run, kernel } = notebook();
    await run(SCHEMA);
    // What terminating a stuck worker does: the next worker has no sessions.
    (kernel as unknown as { call: typeof kernel.call }).call = createKernel().call;
    const result = await run('match $b isa book; select $b;');
    expect(result.outputs[0]).toMatchObject({ kind: 'text', text: expect.stringContaining('session was opened again') });
  });

  it('names an unreachable engine as the browser does', async () => {
    const sessions = new NotebookSessions({ call: async () => { throw new Error('the worker failed'); } });
    const result = await runCell('define entity a;', { call: async () => { throw new Error('the worker failed'); } }, sessions.runnerFor('nb'), { maxRows: 10, unavailableTitle: 'The engine stopped' });
    expect(result).toEqual({ outputs: [{ kind: 'refusal', title: 'The engine stopped', message: 'the worker failed' }], failed: true });
  });
});
