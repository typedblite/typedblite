import { describe, expect, it } from 'vitest';

import { DebugProgram, LaunchError, type OutputCategory } from '../src/program.js';
import { InProcessHost } from './support/in-process-host.js';
import { PEOPLE, SCHEMA, standardFiles, WORK } from './support/fixtures.js';

const SCHEMA_WITH_FUNCTION = `${SCHEMA}\nfun adult_ages() -> { integer }:\n  match $p isa person, has age $a; $a >= 18;\n  return { $a };`;

const launch = async (program?: string, extra: Record<string, unknown> = {}, seed?: string) => {
  const host = new InProcessHost();
  const output: Array<[string, OutputCategory]> = [];
  const debug = await DebugProgram.launch(
    { program: `${WORK}/program.tql`, schema: ['schema.tql'], seed: ['seed.tql'], ...extra },
    host,
    standardFiles(program, seed),
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

describe('stages (Phase 03)', () => {
  it('in: from a statement into its stages, each a frame inside the statement`s, at its own line', async () => {
    const { debug } = await launch();
    await debug.move('over');
    await debug.move('over');
    // At the read, lines 4-6: in runs it and stops at its first stage.
    expect(await debug.move('in')).toEqual({ kind: 'stopped', reason: 'step' });
    expect(debug.frames().map((f) => [f.name, f.line])).toEqual([
      ['match · 1 → 3 row(s)', 4],
      ['match $p isa person, has name $n;', 4],
    ]);
    expect(await debug.move('over')).toEqual({ kind: 'stopped', reason: 'step' });
    expect(debug.frames()[0]).toMatchObject({ name: 'select · 3 → 3 row(s)', line: 6 });
    expect(await debug.move('out')).toEqual({ kind: 'ended', exitCode: 0 });
  });

  it('shows a stage`s rows, its counts and its scope', async () => {
    const { debug } = await launch();
    await debug.move('over');
    await debug.move('over');
    await debug.move('in');
    const [rows, stage, scope] = debug.scopes(debug.frames()[0]!);
    expect(rows!.node).toMatchObject({ name: 'Rows', value: '3 row(s)', indexed: 3 });
    const first = rows!.node.children!()[0]!;
    expect(first.value).toMatch(/^\{ \$p: person 0x1e\w+, \$n: name "Cid" \}$/);
    expect(stage!.node.children!().map((n) => [n.name, n.value])).toEqual([
      ['stage', 'match'],
      ['rows in', '1'],
      ['rows out', '3'],
    ]);
    expect(scope!.node.children!().map((n) => n.name)).toEqual(['$p', '$n']);
    // The statement's own frame shows what it did.
    expect(debug.scopes(debug.frames()[1]!)[0]!.node.value).toBe('3 row(s)');
  });

  it('over, at a statement, does not stop in its stages', async () => {
    const { debug } = await launch();
    await debug.move('over');
    await debug.move('over');
    expect(debug.timeline.current.kind).toBe('statement');
    expect(await debug.move('over')).toEqual({ kind: 'ended', exitCode: 0 });
  });
});

describe('line breakpoints (Phase 03)', () => {
  it('a statement`s first line holds at once; a line in no statement never does; another line waits for its statement', async () => {
    const { debug } = await launch();
    expect(debug.setBreakpoints([2, 6, 3, 9]).map((b) => [b.line, b.verified, b.message])).toEqual([
      [2, true, undefined],
      [6, false, 'Checked when its statement runs.'],
      [3, false, 'No statement is on this line.'],
      [9, false, 'No statement is on this line.'],
    ]);
  });

  it('continue stops at each, and a waiting one is settled, and reported, when its statement runs', async () => {
    const { debug } = await launch();
    const settled: Array<[number, boolean]> = [];
    debug.breakpointChanged = (b) => settled.push([b.line, b.verified]);
    debug.setBreakpoints([2, 6]);
    expect(await debug.start()).toEqual({ kind: 'stopped', reason: 'breakpoint' });
    expect(debug.frames()[0]!.line).toBe(2);
    expect(await debug.move('continue')).toEqual({ kind: 'stopped', reason: 'breakpoint' });
    expect(debug.frames()[0]).toMatchObject({ name: 'select · 3 → 3 row(s)', line: 6 });
    expect(settled).toEqual([[6, true]]);
    expect(await debug.move('continue')).toEqual({ kind: 'ended', exitCode: 0 });
  });

  it('a line with no stage or step on it (a comment) is settled as not holding', async () => {
    const { debug } = await launch();
    const settled: Array<[number, boolean, string | undefined]> = [];
    debug.breakpointChanged = (b) => settled.push([b.line, b.verified, b.message]);
    debug.setBreakpoints([5]);
    expect(await debug.start()).toEqual({ kind: 'ended', exitCode: 0 });
    expect(settled).toEqual([[5, false, 'No stage or step of this statement is on this line.']]);
  });

  it('stops once in a statement on a line: before it runs, not again at its first stage on the same line', async () => {
    const { debug } = await launch();
    debug.setBreakpoints([4]);
    expect(await debug.start()).toEqual({ kind: 'stopped', reason: 'breakpoint' });
    expect(debug.timeline.current.kind).toBe('statement');
    expect(await debug.move('continue')).toEqual({ kind: 'ended', exitCode: 0 });
  });

  it('start stops at a breakpoint on the first statement, before anything runs', async () => {
    const { host, debug } = await launch();
    debug.setBreakpoints([1]);
    expect(await debug.start()).toEqual({ kind: 'stopped', reason: 'breakpoint' });
    expect(host.operations()).not.toContain('session.debug');
  });

  it('a step stops at a breakpoint it passes', async () => {
    const { debug } = await launch();
    await debug.move('over');
    await debug.move('over');
    debug.setBreakpoints([6]);
    // Over the read would end the program; the breakpoint on its select stops it there.
    expect(await debug.move('over')).toEqual({ kind: 'stopped', reason: 'breakpoint' });
    expect(debug.frames()[0]!.line).toBe(6);
  });
});

/** A read whose `isa` is on a later line than the step that runs first (lines from 0). */
const OUT_OF_ORDER = ['match', '  $p has age $a;', '  $a > 20;', '  $p isa person;', 'select $p;'].join('\n');

/** Step in until the stop's first frame is named as given, and return the frames there. */
const stepInTo = async (debug: DebugProgram, name: RegExp) => {
  for (let i = 0; i < 40; i += 1) {
    const frames = debug.frames();
    if (name.test(frames[0]?.name ?? '')) return frames;
    const outcome = await debug.move('in');
    if (outcome.kind === 'ended') break;
  }
  throw new Error(`never reached ${name}`);
};

describe('inside a match (Phase 04)', () => {
  it('in: through each step, in the order they ran, not the order of the lines', async () => {
    const { debug } = await launch(OUT_OF_ORDER, {}, PEOPLE);
    const seen: Array<[string, number]> = [];
    for (;;) {
      const outcome = await debug.move('in');
      if (outcome.kind === 'ended') break;
      seen.push([debug.frames()[0]!.name, debug.frames()[0]!.line]);
    }
    expect(seen).toEqual([
      ['match · 1 → 2 row(s)', 0],
      // `$p`'s step consumes lines 1 and 3, and runs first.
      ['thing $p · 1 → 3 row(s)', 1],
      ['$p has age $a · 3 → 3 row(s)', 1],
      ['$a > 20 · 3 → 2 row(s)', 2],
      ['select · 2 → 2 row(s)', 4],
    ]);
    expect(debug.linesOf({ statement: 0, depth: 2, kind: 'step', path: debug.timeline.at(2)!.path })).toEqual([1, 3]);
  });

  it('a breakpoint on any line a step consumes stops at that step: line 3 stops before line 2`s comparison runs', async () => {
    const { debug } = await launch(OUT_OF_ORDER, {}, PEOPLE);
    debug.setBreakpoints([3, 2]);
    expect(await debug.start()).toEqual({ kind: 'stopped', reason: 'breakpoint' });
    expect(debug.frames()[0]!.name).toBe('thing $p · 1 → 3 row(s)');
    expect(await debug.move('continue')).toEqual({ kind: 'stopped', reason: 'breakpoint' });
    expect(debug.frames()[0]!.name).toBe('$a > 20 · 3 → 2 row(s)');
  });

  it('shows a step`s rows, its counts, each comparison`s, and its breakdown by incoming row', async () => {
    const { debug } = await launch('match $p isa person, has name $n;\nmatch $p has age $a; $a < 40;\nselect $n;', {}, PEOPLE);
    const frames = await stepInTo(debug, /^\$a < 40/);
    const scopes = debug.scopes(frames[0]!);
    expect(scopes.map((s) => s.name)).toEqual(['Rows', 'Step', 'Lets and comparisons', 'By incoming row']);
    expect(scopes[0]!.node.value).toBe('2 row(s)');
    expect(scopes[2]!.node.children!().map((n) => [n.name, n.value])).toEqual([['$a < 40', '3 → 2 kept, 1 dropped here']]);
    // The second match ran once per row the first passed on: three calls, one of which the comparison emptied.
    expect(scopes[3]!.node.children!().map((n) => n.value)).toEqual(['1 → 1', '1 → 1', '1 → 0']);
    expect(scopes[1]!.node.children!().find((n) => n.name === 'incoming rows')?.value).toBe('3');
  });

  it('in: into a not block, whose steps are inside the step that ran them', async () => {
    const { debug } = await launch('match $p isa person, has name $n; not { $p has age $a; $a < 20; };\nselect $n;', {}, PEOPLE);
    const frames = await stepInTo(debug, /^\$a < 20/);
    expect(frames.map((f) => f.name.split(' · ')[0])).toEqual(['$a < 20', 'not', 'match', 'match $p isa person, has name $n; not { $p has age $a; $a <…']);
    expect(debug.timeline.current.depth).toBe(3);
    // Out of the block, back to the step after `not`: here, the next stage.
    expect(await debug.move('out')).toEqual({ kind: 'stopped', reason: 'step' });
    expect(debug.frames()[0]!.name).toMatch(/^select/);
  });

  it('a function defined in the schema has no place in the program`s file: no line, and no breakpoint stops in it', async () => {
    const host = new InProcessHost();
    const files = standardFiles('match let $g in adult_ages(); $g > 40;\nselect $g;', PEOPLE);
    const schema = { ...files, readFile: async (path: string) => (path.endsWith('schema.tql') ? `${SCHEMA_WITH_FUNCTION}` : files.readFile(path)) };
    const debug = await DebugProgram.launch({ program: `${WORK}/program.tql`, schema: ['schema.tql'], seed: ['seed.tql'] }, host, schema, () => undefined);
    const frames = await stepInTo(debug, /^\$a >= 18/);
    expect(frames.map((f) => [f.name.split(' · ')[0], f.placed])).toEqual([
      ['$a >= 18', false],
      ['match', false],
      ['adult_ages()', true],
      ['let $g in adult_ages(); $g > 40', true],
      ['match', true],
      ['match let $g in adult_ages(); $g > 40;', true],
    ]);
    expect(debug.linesOf(debug.timeline.current)).toEqual([]);
  });

  it('a fetch sub-query is a frame inside the fetch stage', async () => {
    const { debug } = await launch('match $p isa person, has name $n;\nfetch { "n": $n, "names": [ match $p has name $o; fetch { "o": $o }; ] };', {}, PEOPLE);
    const frames = await stepInTo(debug, /^\$p has name \$o/);
    expect(frames.map((f) => f.name.split(' · ')[0])).toEqual(['$p has name $o', 'match', 'fetch', 'fetch', 'match $p isa person, has name $n;']);
    expect(frames[2]!.name).toBe('fetch · 3 call(s)');
  });
});
