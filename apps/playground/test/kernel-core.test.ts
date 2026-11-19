import { openNodeSqlite, type SqliteOpener } from '@typedblite/runtime';
import type { RunResult } from '@typedblite/session';
import { describe, expect, it } from 'vitest';

import { createKernel, KernelError } from '../src/notebook/kernel-core';

const SCHEMA = 'define attribute title, value string; entity book, owns title;';
const insert = (title: string) => `insert $b isa book, has title "${title}";`;

const rejection = async (work: Promise<unknown>): Promise<KernelError> => {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(KernelError);
    return error as KernelError;
  }
  throw new Error('expected a KernelError');
};

describe('the browser notebook\'s kernel, over the real session', () => {
  it('splits a source into statements with the language library\'s own splitter', async () => {
    const kernel = createKernel();
    expect(await kernel.call('statement.split', { source: 'define entity a;\ninsert $x isa a;\nmatch $x isa a; select $x;' })).toEqual({
      statements: ['define entity a;', 'insert $x isa a;', 'match $x isa a; select $x;'],
    });
  });

  it('opens a session in memory, runs a schema, a write and a read, and says what it holds', async () => {
    const kernel = createKernel();
    const opened = (await kernel.call('session.open', { location: ':memory:' })) as { id: string; hasSchema: boolean; closed: boolean };
    expect(opened).toMatchObject({ id: 's1', hasSchema: false, closed: false });

    const run = (statement: string) => kernel.call('session.run', { session: opened.id, statement }) as Promise<RunResult>;
    expect(await run(SCHEMA)).toMatchObject({ kind: 'ok', statement: 'define' });
    expect(await run(insert('Dune'))).toMatchObject({ kind: 'ok', statement: 'write' });
    expect(await run('match $b isa book, has title $t; select $t;')).toMatchObject({ kind: 'rows', rows: [{ t: 'Dune' }] });
  });

  it('answers an engine refusal as data, with the engine\'s own message, as the host does', async () => {
    const kernel = createKernel();
    const { id } = (await kernel.call('session.open')) as { id: string };
    await kernel.call('session.run', { session: id, statement: SCHEMA });
    expect(await kernel.call('session.run', { session: id, statement: 'insert $x isa nonexistent-type;' })).toMatchObject({
      kind: 'refused',
      reason: 'engine',
      message: expect.stringContaining('nonexistent-type'),
    });
    expect(await kernel.call('session.run', { session: (await kernel.call('session.open') as { id: string }).id, statement: 'insert $x isa book;' })).toMatchObject({ kind: 'refused', reason: 'no-schema' });
  });

  it('gives each session a store of its own', async () => {
    const kernel = createKernel();
    const a = ((await kernel.call('session.open')) as { id: string }).id;
    const b = ((await kernel.call('session.open')) as { id: string }).id;
    expect(a).not.toBe(b);
    await kernel.call('session.run', { session: a, statement: SCHEMA });
    expect(await kernel.call('session.run', { session: b, statement: 'match $x isa book; select $x;' })).toMatchObject({ kind: 'refused', reason: 'no-schema' });
  });

  it('restarts a session to an empty store, and closes it so it refuses every run', async () => {
    const kernel = createKernel();
    const { id } = (await kernel.call('session.open')) as { id: string };
    await kernel.call('session.run', { session: id, statement: SCHEMA });
    expect(await kernel.call('session.restart', { session: id })).toEqual({ kind: 'ok' });
    expect(await kernel.call('session.run', { session: id, statement: 'match $x isa book; select $x;' })).toMatchObject({ kind: 'refused', reason: 'no-schema' });
    expect(await kernel.call('session.close', { session: id })).toMatchObject({ id, closed: true });
    expect(await kernel.call('session.run', { session: id, statement: 'match $x isa book;' })).toMatchObject({ kind: 'refused', reason: 'closed' });
  });

  it('says an unknown session is unknown, with the host\'s own code, so the notebook can reopen one', async () => {
    const kernel = createKernel();
    for (const operation of ['session.run', 'session.restart', 'session.close']) {
      expect(await rejection(kernel.call(operation, { session: 'nope', statement: 'x' }))).toMatchObject({ code: 'SESSION_NOT_FOUND' });
    }
  });

  it('runs in memory only, and says so: a file is not available in a browser', async () => {
    expect(await rejection(createKernel().call('session.open', { location: '/some/file.db' }))).toMatchObject({ code: 'OPEN_FAILED', message: expect.stringContaining('in memory') });
  });

  it('refuses an operation it does not have', async () => {
    expect(await rejection(createKernel().call('session.commit', { session: 's1' }))).toMatchObject({ code: 'UNKNOWN_OPERATION' });
  });

  it('opens its stores with the opener it is given (WASM in the browser, node:sqlite here)', async () => {
    const opened: string[] = [];
    const openDatabase: SqliteOpener = (location) => {
      opened.push(location);
      return openNodeSqlite(location);
    };
    const kernel = createKernel({ openDatabase });
    await kernel.call('session.open');
    expect(opened).toEqual([':memory:']);
  });
});
