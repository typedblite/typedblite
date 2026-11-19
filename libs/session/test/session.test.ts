import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Session, SessionClosedError, type RunResult } from '../src/index.js';

const SCHEMA =
  'define attribute name, value string; attribute code, value string; entity person, owns name, owns code @key;';

const open: Session[] = [];
const files: string[] = [];
const track = (session: Session): Session => {
  open.push(session);
  return session;
};
const tempFile = (): string => {
  const path = join(tmpdir(), `typedblite-session-${Math.random().toString(36).slice(2)}.db`);
  files.push(path);
  return path;
};
afterEach(async () => {
  for (const session of open.splice(0)) await session.close();
  for (const file of files.splice(0)) for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(file + suffix, { force: true });
});

const names = async (session: Session): Promise<string[]> => {
  const result = await session.run('match $p isa person, has name $n; select $n;');
  if (result.kind !== 'rows') throw new Error(`expected rows, got ${JSON.stringify(result)}`);
  return result.rows.map((row) => row['n'] as string).sort();
};
const insert = (name: string) => `insert $p isa person, has name "${name}", has code "${name}";`;
const ok = (result: { kind: string }): void => expect(result.kind).toBe('ok');

describe('a session', () => {
  it('opens, defines, writes, reads, and says what it holds', async () => {
    const session = track(new Session());
    expect(session.location).toBe(':memory:');
    expect(session.mode).toBe('auto');
    expect(session.hasSchema).toBe(false);

    ok(await session.run(SCHEMA));
    expect(session.hasSchema).toBe(true);
    expect(session.schema().types).toContain('person');
    ok(await session.run(insert('ada')));
    expect(await names(session)).toEqual(['ada']);
  });

  it('refuses a statement before any schema, without leaking SQLite', async () => {
    const session = track(new Session());
    const result = await session.run('insert $p isa person;');
    expect(result).toMatchObject({ kind: 'refused', reason: 'no-schema' });
    expect((result as { message: string }).message).not.toMatch(/no such table/);
  });

  it('returns the engine\'s own refusal as data and stays usable', async () => {
    const session = track(new Session());
    await session.run(SCHEMA);
    const result = await session.run('insert $p isa nonexistent-type;');
    expect(result).toMatchObject({ kind: 'refused', reason: 'engine' });
    expect((result as { message: string }).message).toMatch(/nonexistent-type/);
    ok(await session.run(insert('after')));
  });

  it('treats an empty statement as nothing to do', async () => {
    const session = track(new Session());
    expect(await session.run('  ')).toMatchObject({ kind: 'ok', rows: [] });
  });

  it('returns execution diagnostics with a run', async () => {
    const session = track(new Session());
    await session.run(SCHEMA);
    const result = (await session.run(insert('ada'))) as Extract<RunResult, { kind: 'ok' }>;
    expect(Array.isArray(result.diagnostics)).toBe(true);
  });
});

describe('transactions', () => {
  it('auto mode: a statement is permanent when it succeeds', async () => {
    const session = track(new Session());
    await session.run(SCHEMA);
    await session.run(insert('ada'));
    expect(session.mode).toBe('auto');
    expect(await names(session)).toEqual(['ada']);
  });

  it('a write in manual mode is gone after rollback and present after commit', async () => {
    const session = track(new Session());
    await session.run(SCHEMA);

    ok(await session.begin());
    expect(session.mode).toBe('manual');
    await session.run(insert('gone'));
    expect(await names(session)).toEqual(['gone']);
    ok(await session.rollback());
    expect(session.mode).toBe('auto');
    expect(await names(session)).toEqual([]);

    ok(await session.begin());
    await session.run(insert('kept'));
    ok(await session.commit());
    expect(session.mode).toBe('auto');
    expect(await names(session)).toEqual(['kept']);
  });

  it('a refused statement inside a transaction leaves the transaction open', async () => {
    const session = track(new Session());
    await session.run(SCHEMA);
    await session.begin();
    await session.run(insert('one'));
    expect(await session.run('insert $p isa nonexistent-type;')).toMatchObject({ kind: 'refused' });
    expect(session.mode).toBe('manual');
    ok(await session.commit());
    expect(await names(session)).toEqual(['one']);
  });

  it('a schema change in a transaction is undone by rollback', async () => {
    const session = track(new Session());
    await session.begin();
    ok(await session.run(SCHEMA));
    await session.rollback();
    expect(session.hasSchema).toBe(false);
  });

  it('refuses begin inside a transaction, and commit or rollback with none', async () => {
    const session = track(new Session());
    await session.run(SCHEMA);
    expect(await session.commit()).toMatchObject({ kind: 'refused', reason: 'transaction' });
    expect(await session.rollback()).toMatchObject({ kind: 'refused', reason: 'transaction' });
    ok(await session.begin());
    expect(await session.begin()).toMatchObject({ kind: 'refused', reason: 'transaction' });
  });

  it('a commit that fails rolls back and returns to auto, saying why', async () => {
    const session = track(new Session());
    await session.run(SCHEMA);
    await session.begin();
    // A @key attribute must be held exactly once: an owner with none fails TypeDB's commit check.
    await session.run('insert $p isa person, has name "nokey";');
    const result = await session.commit();
    expect(result).toMatchObject({ kind: 'refused', reason: 'engine' });
    expect((result as { message: string }).message).toMatch(/key/i);
    expect(session.mode).toBe('auto');
    expect(await names(session)).toEqual([]);
  });
});

describe('restart and close', () => {
  it('restart gives a :memory: session an empty store and ends a transaction', async () => {
    const session = track(new Session());
    await session.run(SCHEMA);
    await session.begin();
    await session.run(insert('ada'));
    ok(await session.restart());
    expect(session.mode).toBe('auto');
    expect(session.hasSchema).toBe(false);
    expect(session.closed).toBe(false);
  });

  it('restart keeps a file as it was last committed', async () => {
    const session = track(new Session(tempFile()));
    await session.run(SCHEMA);
    await session.run(insert('committed'));
    await session.begin();
    await session.run(insert('uncommitted'));
    ok(await session.restart());
    expect(session.hasSchema).toBe(true);
    expect(await names(session)).toEqual(['committed']);
  });

  it('a closed session refuses every run and control, and its data accessors throw', async () => {
    const session = new Session();
    await session.run(SCHEMA);
    await session.close();
    expect(session.closed).toBe(true);
    expect(await session.run('match $p isa person;')).toMatchObject({ kind: 'refused', reason: 'closed' });
    for (const result of [await session.begin(), await session.commit(), await session.rollback(), await session.restart()]) {
      expect(result).toMatchObject({ kind: 'refused', reason: 'closed' });
    }
    expect(() => session.schema()).toThrow(SessionClosedError);
    await session.close();
  });

  it('close rolls back an open transaction', async () => {
    const path = tempFile();
    const first = new Session(path);
    await first.run(SCHEMA);
    await first.begin();
    await first.run(insert('lost'));
    await first.close();
    const second = track(new Session(path));
    expect(await names(second)).toEqual([]);
  });
});

describe('two sessions', () => {
  it('keep separate stores', async () => {
    const a = track(new Session());
    const b = track(new Session());
    await a.run(SCHEMA);
    await a.run(insert('only-a'));
    expect(b.hasSchema).toBe(false);
    await b.run(SCHEMA);
    expect(await names(b)).toEqual([]);
  });

  // ADR-011 D5: SQLite arbitrates two sessions on one file, through the engine's own BEGIN IMMEDIATE.
  it('on one file: a second writer is refused as locked while the first holds a transaction, and reads see committed rows', async () => {
    const path = tempFile();
    const a = track(new Session(path));
    await a.run(SCHEMA);
    await a.run(insert('committed'));
    const b = track(new Session(path, { busyTimeoutMs: 50 }));

    ok(await a.begin());
    await a.run(insert('pending'));

    expect(await b.run(insert('blocked'))).toMatchObject({ kind: 'refused', reason: 'locked' });
    expect(await b.begin()).toMatchObject({ kind: 'refused', reason: 'locked' });
    expect(await names(b)).toEqual(['committed']);

    ok(await a.commit());
    ok(await b.run(insert('after')));
    expect(await names(a)).toEqual(['after', 'committed', 'pending']);
  });

  // 🔴 Found by the lock test above, first written the other way round. The interpreter loads a file's schema
  // when it opens, so a session opened BEFORE another session's `define` does not see it, and refuses with
  // `no-schema`. A restart reopens and sees it. The host reports this; it does not paper over it (invariant 2).
  it('on one file: a session opened before another\'s define does not see that schema until it restarts', async () => {
    const path = tempFile();
    const early = track(new Session(path));
    const definer = track(new Session(path));
    await definer.run(SCHEMA);
    expect(early.hasSchema).toBe(false);
    expect(await early.run(insert('x'))).toMatchObject({ kind: 'refused', reason: 'no-schema' });
    ok(await early.restart());
    expect(early.hasSchema).toBe(true);
  });
});
