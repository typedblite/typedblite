import { describe, expect, it } from 'vitest';

import { DebugProgram, LaunchError, type OutputCategory } from '../src/program.js';
import { InProcessHost } from './support/in-process-host.js';
import { standardFiles, WORK } from './support/fixtures.js';

const launch = async (program?: string, extra: Record<string, unknown> = {}) => {
  const host = new InProcessHost();
  const output: Array<[string, OutputCategory]> = [];
  const debug = await DebugProgram.launch(
    { program: `${WORK}/program.tql`, schema: ['schema.tql'], seed: ['seed.tql'], ...extra },
    host,
    standardFiles(program),
    (text, category) => output.push([text, category]),
  );
  return { host, debug, output, text: () => output.map(([text]) => text).join('') };
};

describe('a launch', () => {
  it('opens a :memory: session, runs the schema then the seed, and locates the program`s statements', async () => {
    const { host, debug, text } = await launch();
    expect(host.calls.filter((c) => c.operation === 'session.open')).toEqual([{ operation: 'session.open', input: { location: ':memory:' } }]);
    expect(text()).toContain('Ran the schema file /work/schema.tql: 1 statement(s).');
    expect(text()).toContain('Ran the seed file /work/seed.tql: 1 statement(s).');
    expect(debug.statements.map((s) => [s.line, s.character])).toEqual([[1, 0], [2, 0], [4, 0]]);
    // The comment inside the read is kept: what runs is what was written.
    expect(debug.statements[2]!.text).toBe('match $p isa person, has name $n;\n  # only the names\nselect $n;');
  });

  it('fails, naming the file and line, when a seed statement is refused, and closes the session', async () => {
    const host = new InProcessHost();
    const files = standardFiles();
    const failing = { ...files, readFile: async (path: string) => (path.endsWith('seed.tql') ? 'insert $x isa person;\ninsert $y isa nobody;' : files.readFile(path)) };
    const launched = DebugProgram.launch({ program: `${WORK}/program.tql`, schema: ['schema.tql'], seed: ['seed.tql'] }, host, failing, () => undefined);
    await expect(launched).rejects.toBeInstanceOf(LaunchError);
    await expect(launched).rejects.toThrow(/^The seed file \/work\/seed.tql was refused at line 2: Unknown type 'nobody'/);
    expect(host.operations().at(-1)).toBe('session.close');
    expect([...host.sessions.values()].every((session) => session.closed)).toBe(true);
  });

  it('fails when a file cannot be read, before opening anything', async () => {
    const host = new InProcessHost();
    await expect(DebugProgram.launch({ program: `${WORK}/missing.tql` }, host, standardFiles(), () => undefined)).rejects.toThrow(/Cannot read \/work\/missing.tql/);
    expect(host.calls).toEqual([]);
  });
});

describe('moving through a program', () => {
  it('over: runs the statement it leaves, with a recording, and stops at the next', async () => {
    const { host, debug, text } = await launch();
    expect(await debug.move('over')).toEqual({ kind: 'stopped', reason: 'step' });
    expect(debug.timeline.current.statement).toBe(1);
    expect(debug.statements[0]!.result?.kind).toBe('ok');
    expect(debug.statements[0]!.recording?.frames[0]?.stages[0]?.kind).toBe('insert');
    expect(debug.statements[1]!.result).toBeUndefined();
    expect(host.operations().filter((o) => o === 'session.debug')).toHaveLength(1);
    expect(text()).toContain('Line 2: insert $a isa person, has name "Ann", has age 30;');
  });

  it('continue: runs to the end, and the last read sees what every statement before it wrote', async () => {
    const { debug, text } = await launch();
    expect(await debug.move('continue')).toEqual({ kind: 'ended', exitCode: 0 });
    expect(debug.statements[2]!.result).toMatchObject({ kind: 'rows', rows: [{ n: 'Cid' }, { n: 'Ann' }, { n: 'Bob' }] });
    expect(debug.timeline.current.kind).toBe('end');
    expect(text()).toMatch(/n\s*\n-+\s*\nCid\s*\nAnn\s*\nBob/);
    // At the end, a move stays there.
    expect(await debug.move('over')).toEqual({ kind: 'ended', exitCode: 0 });
  });

  it('stops at a refused statement, and the next move ends the program with exit code 1, running nothing more', async () => {
    const program = 'insert $a isa person, has name "Ann";\nmatch $p isa person, has age $a; $a > "x"; select $a;\ninsert $b isa person, has name "Bob";';
    const { host, debug, output } = await launch(program);
    await debug.move('over');
    const refused = await debug.move('over');
    expect(refused).toEqual({ kind: 'stopped', reason: 'exception', text: 'Cannot compare a integer with a string.' });
    expect(debug.timeline.current.statement).toBe(1);
    expect(output.at(-1)![1]).toBe('stderr');
    expect(await debug.move('continue')).toEqual({ kind: 'ended', exitCode: 1 });
    expect(debug.statements[2]!.result).toBeUndefined();
    expect(host.operations().filter((o) => o === 'session.debug')).toHaveLength(2);
  });
});

describe('Run Without Debugging', () => {
  it('runs every statement through session.run, recording nothing', async () => {
    const { host, debug } = await launch();
    expect(await debug.runAll()).toBe(0);
    expect(host.operations()).not.toContain('session.debug');
    expect(debug.statements.every((s) => s.result !== undefined && s.recording === undefined)).toBe(true);
  });

  it('stops at the first refusal, with exit code 1', async () => {
    const { debug } = await launch('insert $x isa nobody;\ninsert $a isa person, has name "Ann";');
    expect(await debug.runAll()).toBe(1);
    expect(debug.statements[1]!.result).toBeUndefined();
  });
});

describe('closing', () => {
  it('closes the host session once, however often it is asked', async () => {
    const { host, debug } = await launch();
    await debug.close();
    await debug.close();
    expect(host.operations().filter((o) => o === 'session.close')).toHaveLength(1);
  });
});
