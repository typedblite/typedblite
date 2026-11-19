import { describe, expect, it } from 'vitest';

import { runCell, type StatementRunner } from '../src/cell-runner.js';
import type { HostCaller, RunResult } from '../src/host-types.js';
import { NotebookSessions } from '../src/notebook-sessions.js';

/** A scripted host: what it was asked, and what it answers. */
function scripted(answers: Record<string, (input: Record<string, unknown>) => unknown>) {
  const calls: { operation: string; input: Record<string, unknown> }[] = [];
  const host: HostCaller = {
    async call<T>(operation: string, input: Record<string, unknown> = {}): Promise<T> {
      calls.push({ operation, input });
      const answer = answers[operation];
      if (!answer) throw new Error(`unexpected operation ${operation}`);
      const result = answer(input);
      if (result instanceof Error) throw result;
      return result as T;
    },
  };
  return { host, calls };
}
const failure = (code: string, message = code) => Object.assign(new Error(message), { code });
const rows = (...r: Record<string, string>[]): RunResult => ({ kind: 'rows', rows: r, diagnostics: [] });
const ok = (statement: 'define' | 'write', diagnostics: RunResult['diagnostics'] = []): RunResult => ({ kind: 'ok', statement, rows: [], diagnostics });
const refused = (message: string, range?: [number, number], reason = 'engine'): RunResult => ({
  kind: 'refused',
  reason,
  message,
  diagnostics: range ? [{ range: { start: { line: range[0], character: range[1] }, end: { line: range[0], character: range[1] + 1 } }, severity: 1, message }] : [],
});
const runner = (results: RunResult[], reopened = false): StatementRunner & { ran: string[] } => {
  const ran: string[] = [];
  return { ran, run: async (statement) => ({ result: results[ran.push(statement) - 1]!, reopened: reopened && ran.length === 1 }) };
};
const split = (statements: string[]) => ({ 'statement.split': () => ({ statements }) });
const options = { maxRows: 1000 };

describe('running a cell', () => {
  it('splits the source with the host, and runs each statement in order against one session', async () => {
    const { host, calls } = scripted(split(['define entity a;', 'insert $x isa a;', 'match $x isa a; select $x;']));
    const session = runner([ok('define'), ok('write', [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 3, message: 'Wrote 1 thing(s).' }]), rows({ x: 'entity:a:#1' })]);
    const result = await runCell('define entity a;\ninsert $x isa a;\nmatch $x isa a; select $x;', host, session, options);

    expect(calls.map((c) => c.operation)).toEqual(['statement.split']);
    expect(session.ran).toEqual(['define entity a;', 'insert $x isa a;', 'match $x isa a; select $x;']);
    expect(result.failed).toBe(false);
    expect(result.outputs).toEqual([
      { kind: 'heading', text: 'Statement 1 of 3' },
      { kind: 'text', text: 'Schema applied.' },
      { kind: 'heading', text: 'Statement 2 of 3' },
      { kind: 'text', text: 'OK.' },
      { kind: 'facts', lines: ['Wrote 1 thing(s).'] },
      { kind: 'heading', text: 'Statement 3 of 3' },
      { kind: 'table', columns: ['x'], rows: [['entity:a:#1']], total: 1 },
    ]);
  });

  it('a cell with one statement has no heading', async () => {
    const { host } = scripted(split(['match $x isa a; select $x;']));
    const result = await runCell('match $x isa a; select $x;', host, runner([rows()]), options);
    expect(result.outputs).toEqual([{ kind: 'text', text: '(no rows)' }]);
  });

  // ADR-012 N6: stop at the first refusal; what ran before it stays committed.
  it('stops at the first refusal, with the engine\'s own message, and does not run the rest', async () => {
    const { host } = scripted(split(['insert $x isa a;', 'insert $y isa nope;', 'insert $z isa a;']));
    const session = runner([ok('write'), refused('No type nope.')]);
    const result = await runCell('insert $x isa a;\ninsert $y isa nope;\ninsert $z isa a;', host, session, options);

    expect(result.failed).toBe(true);
    expect(session.ran).toEqual(['insert $x isa a;', 'insert $y isa nope;']);
    const refusal = result.outputs.find((o) => o.kind === 'refusal');
    expect(refusal).toMatchObject({ title: 'TypeQLite refused this statement', message: 'No type nope.' });
    expect(result.outputs.at(-1)).toEqual({ kind: 'text', text: 'Stopped at statement 2 of 3. The statement before it stays committed.' });
  });

  it('says how many statements stay committed', async () => {
    const { host } = scripted(split(['a;', 'b;', 'c;']));
    const result = await runCell('a;\nb;\nc;', host, runner([ok('write'), ok('write'), refused('no')]), options);
    expect(result.outputs.at(-1)).toEqual({ kind: 'text', text: 'Stopped at statement 3 of 3. The 2 statements before it stay committed.' });
  });

  it('says nothing about earlier statements when the first is refused', async () => {
    const { host } = scripted(split(['a;', 'b;']));
    const result = await runCell('a;\nb;', host, runner([refused('no')]), options);
    expect(result.outputs.map((o) => o.kind)).toEqual(['heading', 'refusal']);
  });

  describe('where a refusal is', () => {
    it('is the line and column in the cell: the statement\'s place plus the engine\'s range within it', async () => {
      const source = 'define entity a;\n\ninsert $x isa a,\n  has oops 1;';
      const { host } = scripted(split(['define entity a;', 'insert $x isa a,\n  has oops 1;']));
      const result = await runCell(source, host, runner([ok('define'), refused('unknown attribute', [1, 6])]), options);
      expect(result.outputs.find((o) => o.kind === 'refusal')).toMatchObject({ line: 4, column: 7 });
    });

    it('counts the column from the statement\'s own start when it begins mid-line, and only on its first line', async () => {
      const { host } = scripted(split(['a;', 'bad;']));
      const result = await runCell('a; bad;', host, runner([ok('write'), refused('x', [0, 2])]), options);
      expect(result.outputs.find((o) => o.kind === 'refusal')).toMatchObject({ line: 1, column: 6 });
    });

    it('is left out when the engine gave no range, or the statement is not in the cell', async () => {
      const { host } = scripted(split(['insert $x isa nope;']));
      const none = await runCell('insert $x isa nope;', host, runner([refused('no range')]), options);
      expect(none.outputs.find((o) => o.kind === 'refusal')).not.toHaveProperty('line');
      // The host split a copy without comment lines, so a statement with a comment inside is not found as written.
      const commented = await runCell('insert $x # why\n isa nope;', host, runner([refused('x', [0, 0])]), options);
      expect(commented.outputs.find((o) => o.kind === 'refusal')).not.toHaveProperty('line');
    });
  });

  it.each([
    ['no-schema', 'No schema yet'],
    ['locked', 'The store is locked'],
    ['closed', 'The session is closed'],
    ['something-new', 'Refused'],
  ])('titles a %s refusal', async (reason, title) => {
    const { host } = scripted(split(['x;']));
    const result = await runCell('x;', host, runner([refused('m', undefined, reason)]), options);
    expect(result.outputs.find((o) => o.kind === 'refusal')).toMatchObject({ title });
  });

  it('shows documents of a fetch as JSON, and a write that answers rows as a table', async () => {
    const { host } = scripted(split(['a;', 'b;']));
    const result = await runCell('a;\nb;', host, runner([{ kind: 'rows', rows: [], documents: [{ n: 'Ada' }], diagnostics: [] }, { kind: 'ok', statement: 'write', rows: [{ x: '1' }], diagnostics: [] }]), options);
    expect(result.outputs.filter((o) => o.kind !== 'heading')).toEqual([
      { kind: 'json', documents: [{ n: 'Ada' }] },
      { kind: 'table', columns: ['x'], rows: [['1']], total: 1 },
    ]);
  });

  it('takes the columns from every row, in the order they first appear', async () => {
    const { host } = scripted(split(['q;']));
    const result = await runCell('q;', host, runner([rows({ a: '1' }, { b: '2', a: '3' })]), options);
    expect(result.outputs[0]).toEqual({ kind: 'table', columns: ['a', 'b'], rows: [['1', ''], ['3', '2']], total: 2 });
  });

  it('shows warnings among the facts, marked', async () => {
    const { host } = scripted(split(['q;']));
    const d = (severity: number, message: string) => ({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity, message });
    const result = await runCell('q;', host, runner([{ kind: 'ok', statement: 'write', rows: [], diagnostics: [d(3, 'Wrote 1.'), d(2, 'odd')] }]), options);
    expect(result.outputs[1]).toEqual({ kind: 'facts', lines: ['Wrote 1.', 'warning: odd'] });
  });

  // Feature invariant 6.
  it('shows a page of a long answer and counts the rest', async () => {
    const { host } = scripted(split(['q;']));
    const many = Array.from({ length: 2500 }, (_, i) => ({ n: String(i) }));
    const result = await runCell('q;', host, runner([rows(...many)]), { maxRows: 100 });
    expect(result.outputs[0]).toMatchObject({ kind: 'table', total: 2500 });
    expect((result.outputs[0] as unknown as { rows: unknown[] }).rows).toHaveLength(100);
  });

  it('has nothing to run for a cell with no statement', async () => {
    const { host } = scripted(split([]));
    const result = await runCell('# only a comment', host, runner([]), options);
    expect(result).toEqual({ outputs: [{ kind: 'text', text: 'Nothing to run: this cell has no statement.' }], failed: false });
  });

  it('can be cancelled between statements, and says where it stopped', async () => {
    const { host } = scripted(split(['a;', 'b;']));
    let stop = false;
    const session: StatementRunner = { run: async () => { stop = true; return { result: ok('write'), reopened: false }; } };
    const result = await runCell('a;\nb;', host, session, { maxRows: 10, cancelled: () => stop });
    expect(result.outputs.at(-1)).toEqual({ kind: 'text', text: 'Stopped before statement 2 of 2.' });
    expect(result.failed).toBe(false);
  });

  it('says so when the store was gone and a new one was opened', async () => {
    const { host } = scripted(split(['q;']));
    const result = await runCell('q;', host, runner([rows()], true), options);
    expect(result.outputs[0]).toMatchObject({ kind: 'text', text: expect.stringContaining('session was opened again') });
  });

  it('answers an unreachable host as an output, not a throw, and stops', async () => {
    const { host } = scripted({ 'statement.split': () => new Error('No node on PATH') });
    expect(await runCell('x;', host, runner([]), options)).toEqual({ outputs: [{ kind: 'refusal', title: 'The engine host is not available', message: 'No node on PATH' }], failed: true });

    const { host: ok2 } = scripted(split(['x;']));
    const dead: StatementRunner = { run: async () => { throw new Error('the sidecar exited'); } };
    expect((await runCell('x;', ok2, dead, options)).failed).toBe(true);
  });

  // The browser has no "engine host", so it names what stopped in its own words, on both ways a cell can find the engine gone.
  it('titles an unreachable engine with the caller\'s words when it has some', async () => {
    const title = 'The engine stopped';
    const { host } = scripted({ 'statement.split': () => new Error('worker gone') });
    expect((await runCell('x;', host, runner([]), { ...options, unavailableTitle: title })).outputs).toEqual([{ kind: 'refusal', title, message: 'worker gone' }]);

    const { host: ok } = scripted(split(['x;']));
    const dead: StatementRunner = { run: async () => { throw new Error('worker gone'); } };
    expect((await runCell('x;', ok, dead, { ...options, unavailableTitle: title })).outputs.at(-1)).toEqual({ kind: 'refusal', title, message: 'worker gone' });
  });

  // 🔴 Feature invariant 1: a cell is run by the host and by nothing else.
  it('asks the host for nothing but splitting; the statements go through the session', async () => {
    const { host, calls } = scripted(split(['a;', 'b;']));
    await runCell('a;\nb;', host, runner([ok('write'), ok('write')]), options);
    expect(calls.map((c) => c.operation)).toEqual(['statement.split']);
  });
});

describe('a notebook\'s session', () => {
  const sessionHost = (script: (operation: string, input: Record<string, unknown>) => unknown) => {
    const calls: { operation: string; input: Record<string, unknown> }[] = [];
    const host: HostCaller = {
      async call<T>(operation: string, input: Record<string, unknown> = {}): Promise<T> {
        calls.push({ operation, input });
        const result = script(operation, input);
        if (result instanceof Error) throw result;
        return result as T;
      },
    };
    return { host, calls };
  };

  it('opens an in-memory store on the first statement, and keeps it for the rest', async () => {
    let opened = 0;
    const { host, calls } = sessionHost((op) => (op === 'session.open' ? { id: `s${(opened += 1)}` } : ok('write')));
    const sessions = new NotebookSessions(host);
    const run = sessions.runnerFor('nb');
    await run.run('a;');
    await run.run('b;');
    expect(calls.map((c) => [c.operation, c.input])).toEqual([
      ['session.open', { location: ':memory:' }],
      ['session.run', { session: 's1', statement: 'a;' }],
      ['session.run', { session: 's1', statement: 'b;' }],
    ]);
  });

  it('gives each notebook a session of its own', async () => {
    let opened = 0;
    const { host, calls } = sessionHost((op) => (op === 'session.open' ? { id: `s${(opened += 1)}` } : ok('write')));
    const sessions = new NotebookSessions(host);
    await sessions.runnerFor('one').run('a;');
    await sessions.runnerFor('two').run('a;');
    expect(calls.filter((c) => c.operation === 'session.run').map((c) => c.input['session'])).toEqual(['s1', 's2']);
  });

  it('opens a new session, and says so, when the host lost the old one', async () => {
    let opened = 0;
    const { host } = sessionHost((op, input) => {
      if (op === 'session.open') return { id: `s${(opened += 1)}` };
      return input['session'] === 's1' ? failure('SESSION_NOT_FOUND') : ok('write');
    });
    const run = new NotebookSessions(host).runnerFor('nb');
    expect((await run.run('a;')).reopened).toBe(true);
    expect((await run.run('b;')).reopened).toBe(false);
  });

  it('does not hide any other fault', async () => {
    const { host } = sessionHost((op) => (op === 'session.open' ? { id: 's1' } : failure('HANDLER_FAILURE', 'boom')));
    await expect(new NotebookSessions(host).runnerFor('nb').run('a;')).rejects.toThrow('boom');
  });

  it('restarts the session it has, and has nothing to restart before a first run', async () => {
    const { host, calls } = sessionHost((op) => (op === 'session.open' ? { id: 's1' } : ok('write')));
    const sessions = new NotebookSessions(host);
    expect(await sessions.restart('nb')).toBe('none');
    await sessions.runnerFor('nb').run('a;');
    expect(await sessions.restart('nb')).toBe('restarted');
    expect(calls.at(-1)).toEqual({ operation: 'session.restart', input: { session: 's1' } });
  });

  it('opens a new session when asked to restart one the host lost', async () => {
    let opened = 0;
    const { host } = sessionHost((op) => {
      if (op === 'session.open') return { id: `s${(opened += 1)}` };
      return op === 'session.restart' ? failure('SESSION_NOT_FOUND') : ok('write');
    });
    const sessions = new NotebookSessions(host);
    await sessions.runnerFor('nb').run('a;');
    expect(await sessions.restart('nb')).toBe('restarted');
    expect(opened).toBe(2);
  });

  it('closes a notebook\'s session, and forgets it', async () => {
    const { host, calls } = sessionHost((op) => (op === 'session.open' ? { id: 's1' } : ok('write')));
    const sessions = new NotebookSessions(host);
    await sessions.runnerFor('nb').run('a;');
    expect(sessions.has('nb')).toBe(true);
    await sessions.close('nb');
    expect(sessions.has('nb')).toBe(false);
    expect(calls.at(-1)).toEqual({ operation: 'session.close', input: { session: 's1' } });
    await sessions.close('nb');
  });

  it('runs one thing at a time for a notebook, in the order asked', async () => {
    const order: string[] = [];
    const { host } = sessionHost((op, input) => {
      if (op === 'session.open') return { id: 's1' };
      order.push(String(input['statement']));
      return ok('write');
    });
    const run = new NotebookSessions(host).runnerFor('nb');
    await Promise.all([run.run('1;'), run.run('2;'), run.run('3;')]);
    expect(order).toEqual(['1;', '2;', '3;']);
  });
});
