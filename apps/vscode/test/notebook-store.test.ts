import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { HostClient } from '../src/host/host-client';
import { NotebookSessions, describeStore, runCell, type CellResult, type RunResult } from '@typedblite/notebook';

/**
 * A notebook's store, through the real engine host with no VS Code (ADR-012 N5, feature invariant 3): in memory until a
 * file is chosen; a file in either of two modes; and what a writer in each mode leaves for a reader on the same file.
 */
const BUNDLE = resolve(__dirname, '../out/host/sidecar.cjs');
const dir = mkdtempSync(join(tmpdir(), 'typedblite-notebook-store-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let host: HostClient | undefined;
afterEach(async () => {
  await host?.stop();
  host = undefined;
});
let counter = 0;
const file = () => join(dir, `store-${(counter += 1)}.db`);

function setup() {
  host = new HostClient({ sidecarPath: BUNDLE, configuredNode: () => process.execPath });
  const sessions = new NotebookSessions(host);
  const run = (source: string, key = 'nb'): Promise<CellResult> => runCell(source, host!, sessions.runnerFor(key), { maxRows: 100 });
  /** What a second connection to the file sees: only what has been committed. */
  const readerSees = async (location: string): Promise<RunResult> =>
    host!.call<RunResult>('session.run', { location, statement: 'match $b isa book, has title $t; select $t;' });
  return { host, sessions, run, readerSees };
}

const SCHEMA = 'define attribute title, value string; entity book, owns title;';
const insert = (title: string) => `insert $b isa book, has title "${title}";`;
const rowsOf = (result: RunResult): string[] => (result.kind === 'rows' ? result.rows.map((r) => r['t']!) : []);

describe('a notebook\'s store', () => {
  it('is in memory until a file is chosen, and the status says so', async () => {
    const { sessions, run } = setup();
    await run(SCHEMA);
    expect(sessions.storeOf('nb')).toBeUndefined();
    expect(describeStore(undefined)).toBe('In-memory store');
  });

  it('says which file, and when a write is permanent', () => {
    expect(describeStore({ location: '/home/me/books.db', mode: 'auto' })).toBe('books.db · commits each statement');
    expect(describeStore({ location: 'C:\\data\\books.db', mode: 'manual' })).toBe('books.db · holds changes until you commit');
  });

  it('a file store in auto mode keeps what a cell writes, for a notebook that opens it later', async () => {
    const { sessions, run } = setup();
    const location = file();
    await sessions.useStore('first', { location, mode: 'auto' });
    await run(SCHEMA, 'first');
    await run(insert('Dune'), 'first');
    await sessions.close('first');

    await sessions.useStore('second', { location, mode: 'auto' });
    const read = await run('match $b isa book, has title $t; select $t;', 'second');
    expect(read.outputs[0]).toMatchObject({ kind: 'table', rows: [['Dune']] });
  });

  it('opening a file is announced to whoever listens, once', async () => {
    const { sessions } = setup();
    const seen: string[] = [];
    const listener = sessions.onDidChangeStore((key) => seen.push(key));
    await sessions.useStore('nb', { location: file(), mode: 'auto' });
    listener.dispose();
    await sessions.useStore('nb', undefined);
    expect(seen).toEqual(['nb']);
  });

  it('going back to memory gives a fresh, empty store', async () => {
    const { sessions, run } = setup();
    await sessions.useStore('nb', { location: file(), mode: 'auto' });
    await run(SCHEMA);
    await sessions.useStore('nb', undefined);
    expect(sessions.storeOf('nb')).toBeUndefined();
    expect((await run('match $b isa book; select $b;')).failed).toBe(true);
  });

  it('a file that will not open is refused now, and the notebook keeps the store it had', async () => {
    const { sessions, run } = setup();
    await run(SCHEMA);
    await run(insert('Kept'));
    await expect(sessions.useStore('nb', { location: '/no/such/directory/x.db', mode: 'auto' })).rejects.toThrow(/Could not open/);
    expect(sessions.storeOf('nb')).toBeUndefined();
    expect((await run('match $b isa book, has title $t; select $t;')).outputs[0]).toMatchObject({ rows: [['Kept']] });
  });

  it('choosing the file it already has ends the old session first, so a held transaction does not lock the new one', async () => {
    const { sessions, run } = setup();
    const location = file();
    await sessions.useStore('nb', { location, mode: 'manual' });
    await run(SCHEMA);
    await sessions.useStore('nb', { location, mode: 'auto' });
    expect(sessions.storeOf('nb')).toEqual({ location, mode: 'auto' });
    // What the manual session held was not committed, so the schema is gone and a cell that needs it is refused.
    expect((await run(insert('x'))).failed).toBe(true);
  });

  it('no file is opened unless a store was chosen: running cells in a new notebook touches no file', async () => {
    const { sessions, run } = setup();
    await run(SCHEMA);
    expect(sessions.storeOf('nb')).toBeUndefined();
  });
});

// 🔴 Feature invariant 3: "a write to it commits only in the mode the user picked".
describe('when a write to a file becomes permanent', () => {
  it('in auto mode, at once: another reader sees it', async () => {
    const { sessions, run, readerSees } = setup();
    const location = file();
    await sessions.useStore('nb', { location, mode: 'auto' });
    await run(SCHEMA);
    await run(insert('Dune'));
    expect(rowsOf(await readerSees(location))).toEqual(['Dune']);
  });

  it('in manual mode, only on commit: until then another reader sees nothing', async () => {
    const { sessions, run, readerSees } = setup();
    const location = file();
    await sessions.useStore('nb', { location, mode: 'manual' });
    await run(SCHEMA);
    await run(insert('Dune'));
    // Neither the schema nor the row is permanent: the other connection has no schema to read against.
    expect(await readerSees(location)).toMatchObject({ kind: 'refused', reason: 'no-schema' });
    // The notebook itself sees its own changes.
    expect((await run('match $b isa book, has title $t; select $t;')).outputs[0]).toMatchObject({ rows: [['Dune']] });

    expect(await sessions.commit('nb')).toEqual({ kind: 'done' });
    expect(rowsOf(await readerSees(location))).toEqual(['Dune']);
  });

  it('after a commit it holds the next changes too', async () => {
    const { sessions, run, readerSees } = setup();
    const location = file();
    await sessions.useStore('nb', { location, mode: 'manual' });
    await run(SCHEMA);
    await sessions.commit('nb');
    await run(insert('Later'));
    expect(rowsOf(await readerSees(location))).toEqual([]);
    await sessions.commit('nb');
    expect(rowsOf(await readerSees(location))).toEqual(['Later']);
  });

  it('a rollback discards what was held, and the notebook holds the next changes', async () => {
    const { sessions, run, readerSees } = setup();
    const location = file();
    await sessions.useStore('nb', { location, mode: 'manual' });
    await run(SCHEMA);
    await sessions.commit('nb');
    await run(insert('Discarded'));
    expect(await sessions.rollback('nb')).toEqual({ kind: 'done' });
    expect((await run('match $b isa book; select $b;')).outputs[0]).toMatchObject({ kind: 'text', text: '(no rows)' });

    await run(insert('Kept'));
    await sessions.commit('nb');
    expect(rowsOf(await readerSees(location))).toEqual(['Kept']);
  });

  it('closing the notebook without committing makes nothing permanent', async () => {
    const { sessions, run, readerSees } = setup();
    const location = file();
    await sessions.useStore('nb', { location, mode: 'manual' });
    await run(SCHEMA);
    await sessions.commit('nb');
    await run(insert('Never'));
    await sessions.close('nb');
    expect(rowsOf(await readerSees(location))).toEqual([]);
  });

  it('restart drops what was held and still holds the next changes', async () => {
    const { sessions, run, readerSees } = setup();
    const location = file();
    await sessions.useStore('nb', { location, mode: 'manual' });
    await run(SCHEMA);
    await sessions.commit('nb');
    await run(insert('Dropped'));
    expect(await sessions.restart('nb')).toBe('restarted');
    await run(insert('After'));
    expect(rowsOf(await readerSees(location))).toEqual([]);
    await sessions.commit('nb');
    expect(rowsOf(await readerSees(location))).toEqual(['After']);
  });

  it('a commit the engine refuses is rolled back, says why, and the notebook goes on holding changes', async () => {
    const { sessions, run } = setup();
    const location = file();
    await sessions.useStore('nb', { location, mode: 'manual' });
    await run('define attribute code, value string; entity part, owns code @key;');
    await sessions.commit('nb');
    // A `@key` attribute must be held exactly once: an owner with none fails TypeDB's commit check.
    await run('insert $p isa part;');
    const outcome = await sessions.commit('nb');
    expect(outcome).toMatchObject({ kind: 'refused', message: expect.stringMatching(/key/i) });
    expect((await run('match $p isa part; select $p;')).outputs[0]).toMatchObject({ text: '(no rows)' });
    expect(await sessions.commit('nb')).toEqual({ kind: 'done' });
  });

  it('there is nothing to commit in auto mode or in memory, or before a first cell', async () => {
    const { sessions, run } = setup();
    expect(await sessions.commit('nb')).toEqual({ kind: 'none' });
    await run(SCHEMA);
    expect(await sessions.commit('nb')).toEqual({ kind: 'not-manual' });
    expect(await sessions.rollback('nb')).toEqual({ kind: 'not-manual' });
    await sessions.useStore('nb', { location: file(), mode: 'auto' });
    expect(await sessions.commit('nb')).toEqual({ kind: 'not-manual' });
  });

  it('a notebook that holds its changes, whose host process was restarted, opens the file again in the same mode and says so', async () => {
    const { host: client, sessions, run, readerSees } = setup();
    const location = file();
    await sessions.useStore('nb', { location, mode: 'manual' });
    await run(SCHEMA);
    await sessions.commit('nb');
    await run(insert('Lost'));
    await client.stop();

    const after = await run(insert('Again'));
    expect(after.outputs[0]).toMatchObject({ kind: 'text', text: expect.stringContaining('session was opened again') });
    expect(rowsOf(await readerSees(location))).toEqual([]);
    await sessions.commit('nb');
    expect(rowsOf(await readerSees(location))).toEqual(['Again']);
  });
});
