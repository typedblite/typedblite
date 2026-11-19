import { describe, expect, it } from 'vitest';

import type { HostCaller, RunResult } from '../src/host-types.js';
import { describeStore, NotebookSessions } from '../src/notebook-sessions.js';

/** A host that numbers the sessions it opens, remembers which are alive, and can be told to fail an operation once. */
function fakeHost() {
  const calls: string[] = [];
  const alive = new Set<string>();
  const failNext = new Map<string, Error>();
  let counter = 0;
  const answers: Record<string, (input: Record<string, unknown>) => unknown> = {
    'session.open': (input) => {
      if (input['location'] === '/nope') throw Object.assign(new Error('cannot open'), { code: 'OPEN_FAILED' });
      const id = `s${++counter}`;
      alive.add(id);
      return { id };
    },
    'session.run': () => ({ kind: 'rows', rows: [], diagnostics: [] }) satisfies RunResult,
    'session.restart': () => ({ kind: 'ok' }),
    'session.begin': () => ({ kind: 'ok' }),
    'session.commit': () => ({ kind: 'ok' }),
    'session.rollback': () => ({ kind: 'ok' }),
    'session.close': (input) => void alive.delete(String(input['session'])),
  };
  const host: HostCaller = {
    async call<T>(operation: string, input: Record<string, unknown> = {}): Promise<T> {
      calls.push(`${operation}${input['session'] ? ` ${String(input['session'])}` : input['location'] ? ` ${String(input['location'])}` : ''}`);
      const error = failNext.get(operation);
      if (error) {
        failNext.delete(operation);
        throw error;
      }
      const session = input['session'];
      if (session !== undefined && operation !== 'session.close' && !alive.has(String(session))) throw Object.assign(new Error('gone'), { code: 'SESSION_NOT_FOUND' });
      return answers[operation]!(input) as T;
    },
  };
  return { host, calls, alive, answers, failNext, forget: (id: string) => alive.delete(id) };
}
const notFound = () => Object.assign(new Error('gone'), { code: 'SESSION_NOT_FOUND' });

describe('describing a store', () => {
  it('says memory, or the file and when a write becomes permanent', () => {
    expect(describeStore(undefined)).toBe('In-memory store');
    expect(describeStore({ location: '/a/b/readlist.db', mode: 'auto' })).toBe('readlist.db · commits each statement');
    expect(describeStore({ location: 'C:\\x\\r.db', mode: 'manual' })).toBe('r.db · holds changes until you commit');
  });
});

describe('a notebook\'s session', () => {
  it('opens in memory on the first run and runs every later statement on the same session', async () => {
    const { host, calls } = fakeHost();
    const sessions = new NotebookSessions(host);
    expect(sessions.has('n')).toBe(false);
    const runner = sessions.runnerFor('n');
    expect((await runner.run('a;')).reopened).toBe(false);
    await runner.run('b;');
    expect(calls).toEqual(['session.open :memory:', 'session.run s1', 'session.run s1']);
    expect(sessions.has('n')).toBe(true);
    expect(sessions.storeOf('n')).toBeUndefined();
  });

  it('opens a new empty session and says so when the host lost the one it had', async () => {
    const { host, calls, forget } = fakeHost();
    const sessions = new NotebookSessions(host);
    await sessions.runnerFor('n').run('a;');
    forget('s1');
    expect((await sessions.runnerFor('n').run('b;')).reopened).toBe(true);
    expect(calls.slice(-2)).toEqual(['session.open :memory:', 'session.run s2']);
  });

  it('passes on any other failure of a run', async () => {
    const { host, failNext } = fakeHost();
    const sessions = new NotebookSessions(host);
    await sessions.runnerFor('n').run('a;');
    failNext.set('session.run', new Error('boom'));
    await expect(sessions.runnerFor('n').run('b;')).rejects.toThrow('boom');
  });

  it('keeps two notebooks apart, and runs one notebook\'s statements one at a time, in order', async () => {
    const { host, calls } = fakeHost();
    const sessions = new NotebookSessions(host);
    await Promise.all([sessions.runnerFor('a').run('1;'), sessions.runnerFor('a').run('2;'), sessions.runnerFor('b').run('3;')]);
    expect(calls.filter((c) => c.startsWith('session.open'))).toHaveLength(2);
    expect(sessions.has('a') && sessions.has('b')).toBe(true);
  });
});

describe('choosing a store', () => {
  it('opens the file now, ends the memory session, and tells whoever listens', async () => {
    const { host, calls } = fakeHost();
    const sessions = new NotebookSessions(host);
    const changed: string[] = [];
    const listener = sessions.onDidChangeStore((key) => changed.push(key));
    await sessions.runnerFor('n').run('a;');
    await sessions.useStore('n', { location: '/r.db', mode: 'auto' });
    expect(calls.slice(2)).toEqual(['session.open /r.db', 'session.close s1']);
    expect(sessions.storeOf('n')).toEqual({ location: '/r.db', mode: 'auto' });
    listener.dispose();
    await sessions.useStore('n', undefined);
    expect(changed).toEqual(['n']);
    expect(sessions.storeOf('n')).toBeUndefined();
    expect(sessions.has('n')).toBe(false);
  });

  it('holds a transaction open from the start in manual mode', async () => {
    const { host, calls } = fakeHost();
    const sessions = new NotebookSessions(host);
    await sessions.useStore('n', { location: '/r.db', mode: 'manual' });
    expect(calls).toEqual(['session.open /r.db', 'session.begin s1']);
  });

  it('ends the session on the same file before opening it again, because it may hold the write lock', async () => {
    const { host, calls } = fakeHost();
    const sessions = new NotebookSessions(host);
    await sessions.useStore('n', { location: '/r.db', mode: 'auto' });
    await sessions.useStore('n', { location: '/r.db', mode: 'manual' });
    expect(calls.slice(1)).toEqual(['session.close s1', 'session.open /r.db', 'session.begin s2']);
  });

  it('keeps the store it had when the file will not open', async () => {
    const { host } = fakeHost();
    const sessions = new NotebookSessions(host);
    await sessions.runnerFor('n').run('a;');
    await expect(sessions.useStore('n', { location: '/nope', mode: 'auto' })).rejects.toThrow('cannot open');
    expect(sessions.has('n')).toBe(true);
    expect(sessions.storeOf('n')).toBeUndefined();
  });

  it('closes a session it could not begin a transaction on, and passes the failure on', async () => {
    const { host, calls, failNext } = fakeHost();
    const sessions = new NotebookSessions(host);
    failNext.set('session.begin', new Error('no transaction'));
    await expect(sessions.useStore('n', { location: '/r.db', mode: 'manual' })).rejects.toThrow('no transaction');
    expect(calls).toEqual(['session.open /r.db', 'session.begin s1', 'session.close s1']);
  });
});

describe('commit and rollback', () => {
  it('say nothing happened before there is a session or when changes are not held', async () => {
    const { host } = fakeHost();
    const sessions = new NotebookSessions(host);
    expect(await sessions.commit('n')).toEqual({ kind: 'none' });
    await sessions.useStore('n', { location: '/r.db', mode: 'auto' });
    expect(await sessions.commit('n')).toEqual({ kind: 'not-manual' });
    expect(await sessions.rollback('n')).toEqual({ kind: 'not-manual' });
  });

  it('end a held transaction and hold a new one', async () => {
    const { host, calls } = fakeHost();
    const sessions = new NotebookSessions(host);
    await sessions.useStore('n', { location: '/r.db', mode: 'manual' });
    expect(await sessions.commit('n')).toEqual({ kind: 'done' });
    expect(await sessions.rollback('n')).toEqual({ kind: 'done' });
    expect(calls.slice(2)).toEqual(['session.commit s1', 'session.begin s1', 'session.rollback s1', 'session.begin s1']);
  });

  it('report the engine\'s refusal of a commit, with a new transaction held all the same', async () => {
    const { host, answers, calls } = fakeHost();
    const sessions = new NotebookSessions(host);
    await sessions.useStore('n', { location: '/r.db', mode: 'manual' });
    answers['session.commit'] = () => ({ kind: 'refused', message: 'a check failed' });
    expect(await sessions.commit('n')).toEqual({ kind: 'refused', message: 'a check failed' });
    answers['session.commit'] = () => ({ kind: 'refused' });
    expect(await sessions.commit('n')).toEqual({ kind: 'refused', message: 'The commit was refused.' });
    expect(calls.filter((c) => c === 'session.begin s1')).toHaveLength(3);
  });
});

describe('restart', () => {
  it('has nothing to do before a first run', async () => {
    const { host } = fakeHost();
    expect(await new NotebookSessions(host).restart('n')).toBe('none');
  });

  it('restarts the session, and holds a new transaction when the store holds its changes', async () => {
    const { host, calls } = fakeHost();
    const sessions = new NotebookSessions(host);
    await sessions.runnerFor('n').run('a;');
    expect(await sessions.restart('n')).toBe('restarted');
    await sessions.useStore('m', { location: '/r.db', mode: 'manual' });
    expect(await sessions.restart('m')).toBe('restarted');
    expect(calls.slice(-2)).toEqual(['session.restart s2', 'session.begin s2']);
  });

  it('opens a new session when the host lost the one it had, and refuses to pretend when the host refuses', async () => {
    const { host, forget, answers, failNext } = fakeHost();
    const sessions = new NotebookSessions(host);
    await sessions.runnerFor('n').run('a;');
    forget('s1');
    expect(await sessions.restart('n')).toBe('restarted');
    failNext.set('session.restart', notFound());
    expect(await sessions.restart('n')).toBe('restarted');
    answers['session.restart'] = () => ({ kind: 'refused', message: 'locked' });
    await expect(sessions.restart('n')).rejects.toThrow('locked');
    answers['session.restart'] = () => ({ kind: 'refused' });
    await expect(sessions.restart('n')).rejects.toThrow('The store could not be restarted.');
  });
});

describe('closing', () => {
  it('closes one notebook\'s session, or all of them, and forgets a close the host could not do', async () => {
    const { host, alive, failNext } = fakeHost();
    const sessions = new NotebookSessions(host);
    await sessions.runnerFor('a').run('1;');
    await sessions.runnerFor('b').run('2;');
    await sessions.close('a');
    expect(sessions.has('a')).toBe(false);
    expect(alive.size).toBe(1);
    await sessions.close('never-opened');
    failNext.set('session.close', new Error('host gone'));
    await sessions.closeAll();
    expect(sessions.has('b')).toBe(false);
  });
});
