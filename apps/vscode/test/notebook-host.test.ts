import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCell, type CellResult } from '../src/notebook/cell-runner';
import { HostClient } from '../src/host/host-client';
import { NotebookSessions } from '../src/notebook/notebook-sessions';
import type { OutputBlock } from '../src/notebook/outputs';

/**
 * Cells run through the real engine host, with no VS Code: the bundle the `.vsix` ships (`out/host/sidecar.cjs`), a
 * `node` that has `node:sqlite`, and the notebook's own session and runner. This is the proof that a later cell sees
 * what an earlier one defined and inserted, that restart empties the store, and that a refusal is the engine's own.
 */
const BUNDLE = resolve(__dirname, '../out/host/sidecar.cjs');

let host: HostClient | undefined;
afterEach(async () => {
  await host?.stop();
  host = undefined;
});

function notebook(key = 'nb') {
  host = new HostClient({ sidecarPath: BUNDLE, configuredNode: () => process.execPath });
  const sessions = new NotebookSessions(host);
  const run = (source: string, k = key): Promise<CellResult> => runCell(source, host!, sessions.runnerFor(k), { maxRows: 1000 });
  return { host, sessions, run };
}

const kinds = (result: CellResult) => result.outputs.map((o) => o.kind);
const refusal = (result: CellResult) => result.outputs.find((o): o is Extract<OutputBlock, { kind: 'refusal' }> => o.kind === 'refusal');
const table = (result: CellResult) => result.outputs.find((o): o is Extract<OutputBlock, { kind: 'table' }> => o.kind === 'table');

const SCHEMA = 'define attribute title, value string; entity book, owns title;';

describe('cells through the engine host', () => {
  it('a later cell sees what an earlier cell defined and inserted', async () => {
    const { run } = notebook();
    const defined = await run(SCHEMA);
    expect(defined.outputs[0]).toEqual({ kind: 'text', text: 'Schema applied.' });
    expect(defined.outputs[1]).toMatchObject({ kind: 'facts', lines: [expect.stringContaining('applied 2 new definition(s)'), expect.anything()] });

    // An insert answers what it made, as a table, and says what it wrote.
    const inserted = await run('insert $b isa book, has title "Dune";');
    expect(inserted.failed).toBe(false);
    expect(table(inserted)).toEqual({ kind: 'table', columns: ['b'], rows: [['entity:book:#1']], total: 1 });
    expect(inserted.outputs[1]).toMatchObject({ kind: 'facts', lines: [expect.stringContaining('Wrote 1 thing')] });

    const read = await run('match $b isa book, has title $t; select $t;');
    expect(table(read)).toEqual({ kind: 'table', columns: ['t'], rows: [['Dune']], total: 1 });
  });

  it('a cell of several statements shows each answer, and a later statement sees an earlier one', async () => {
    const { run } = notebook();
    const result = await run(`${SCHEMA}\ninsert $b isa book, has title "Emma";\nmatch $b isa book, has title $t; select $t;`);
    expect(result.failed).toBe(false);
    expect(kinds(result)).toEqual(['heading', 'text', 'facts', 'heading', 'table', 'facts', 'heading', 'table', 'facts']);
    // The last statement's table, the one that read what the one before it inserted.
    expect(result.outputs.filter((o) => o.kind === 'table').at(-1)).toMatchObject({ columns: ['t'], rows: [['Emma']] });
  });

  it('stops at the first refusal with the engine\'s own message, and what ran before it stays committed', async () => {
    const { run } = notebook();
    await run(SCHEMA);
    const result = await run('insert $b isa book, has title "Kept";\ninsert $x isa nonexistent-type;\ninsert $b isa book, has title "Never";');
    expect(result.failed).toBe(true);
    expect(refusal(result)).toMatchObject({ title: 'TypeQLite refused this statement', message: expect.stringContaining('nonexistent-type') });
    expect(result.outputs.at(-1)).toMatchObject({ kind: 'text', text: expect.stringContaining('stays committed') });

    const read = await run('match $b isa book, has title $t; select $t;');
    expect(table(read)!.rows).toEqual([['Kept']]);
  });

  it('puts the refusal at its place in the cell', async () => {
    const { run } = notebook();
    await run(SCHEMA);
    const result = await run('\n\ninsert $x isa nonexistent-type;');
    const found = refusal(result)!;
    // The host's own range for the statement, on the third line of the cell.
    expect(found.line).toBe(3);
    expect(found.column).toBeGreaterThanOrEqual(1);
  });

  it('a cell that needs a schema before there is one is refused with the engine\'s own message', async () => {
    const { run } = notebook();
    const result = await run('insert $b isa book, has title "Dune";');
    expect(refusal(result)).toMatchObject({ title: 'No schema yet', message: expect.stringContaining('no schema has been applied') });
  });

  it('restart gives an empty store, and a cell that needs the schema is then refused', async () => {
    const { run, sessions } = notebook();
    await run(SCHEMA);
    await run('insert $b isa book, has title "Dune";');
    expect(table(await run('match $b isa book; select $b;'))!.total).toBe(1);

    expect(await sessions.restart('nb')).toBe('restarted');
    const after = await run('match $b isa book; select $b;');
    expect(after.failed).toBe(true);
    expect(refusal(after)).toMatchObject({ title: 'No schema yet' });
  });

  it('two notebooks have stores of their own', async () => {
    const { run } = notebook();
    await run(SCHEMA, 'one');
    await run('insert $b isa book, has title "Only one";', 'one');
    expect((await run('match $b isa book; select $b;', 'two')).failed).toBe(true);
    expect(table(await run('match $b isa book; select $b;', 'one'))!.total).toBe(1);
  });

  it('shows the documents of a fetch as JSON', async () => {
    const { run } = notebook();
    await run(SCHEMA);
    await run('insert $b isa book, has title "Dune";');
    const result = await run('match $b isa book, has title $t; fetch { "title": $t };');
    expect(result.outputs[0]).toEqual({ kind: 'json', documents: [{ title: 'Dune' }] });
    expect(result.failed).toBe(false);
  });

  it('a comment-only cell has nothing to run', async () => {
    const { run } = notebook();
    expect(await run('# nothing here')).toEqual({ outputs: [{ kind: 'text', text: 'Nothing to run: this cell has no statement.' }], failed: false });
  });

  it('opens a new store, and says so, when the host process has been restarted under the notebook', async () => {
    const { run, host: client } = notebook();
    await run(SCHEMA);
    await client.stop();
    const result = await run('match $b isa book; select $b;');
    expect(result.outputs[0]).toMatchObject({ kind: 'text', text: expect.stringContaining('new, empty store') });
    expect(refusal(result)).toMatchObject({ title: 'No schema yet' });
  });

  it('shows a page of a long answer and counts the rest', async () => {
    const { host: client, sessions } = notebook();
    await runCell(`${SCHEMA}\n${Array.from({ length: 30 }, (_, i) => `insert $b isa book, has title "t${i}";`).join('\n')}`, client, sessions.runnerFor('nb'), { maxRows: 5 });
    const read = await runCell('match $b isa book, has title $t; select $t;', client, sessions.runnerFor('nb'), { maxRows: 5 });
    expect(table(read)).toMatchObject({ total: 30 });
    expect(table(read)!.rows).toHaveLength(5);
  });
});
