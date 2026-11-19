import type { DebugClient } from '@vscode/debugadapter-testsupport';
import { afterEach, describe, expect, it } from 'vitest';

import { InProcessHost } from './support/in-process-host.js';
import { connect } from './support/dap.js';
import { PEOPLE, SCHEMA, standardFiles, WORK } from './support/fixtures.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const LAUNCH = { program: `${WORK}/program.tql`, schema: ['schema.tql'], seed: ['seed.tql'] };

async function open(program?: string, seed?: string, schema?: string): Promise<{ client: DebugClient; host: InProcessHost }> {
  const host = new InProcessHost();
  const files = standardFiles(program, seed);
  const connected = await connect(host, schema === undefined ? files : { readFile: async (path) => (path.endsWith('schema.tql') ? schema : files.readFile(path)) });
  close = connected.close;
  return { client: connected.client, host };
}

const line = async (client: DebugClient): Promise<number | undefined> =>
  (await client.stackTraceRequest({ threadId: 1 })).body.stackFrames[0]?.line;

describe('the TypeQLite debug adapter over DAP', () => {
  it('says what it supports', async () => {
    const { client } = await open();
    const { body } = await client.initializeRequest();
    expect(body).toMatchObject({ supportsConfigurationDoneRequest: true, supportsTerminateRequest: true });
  });

  it('stops on entry at the first statement, and steps over each statement, line by line', async () => {
    const { client } = await open();
    await Promise.all([client.configurationSequence(), client.launch({ ...LAUNCH, stopOnEntry: true }), client.assertStoppedLocation('entry', { line: 2 })]);
    expect((await client.threadsRequest()).body.threads).toEqual([{ id: 1, name: 'TypeQLite' }]);

    await Promise.all([client.nextRequest({ threadId: 1 }), client.assertStoppedLocation('step', { line: 3 })]);
    await Promise.all([client.nextRequest({ threadId: 1 }), client.assertStoppedLocation('step', { line: 5 })]);
    const frame = (await client.stackTraceRequest({ threadId: 1 })).body.stackFrames[0]!;
    expect(frame).toMatchObject({ name: 'match $p isa person, has name $n;', source: { name: 'program.tql', path: '/work/program.tql' }, column: 1 });
  });

  it('shows a statement`s status and text, before and after it runs', async () => {
    const { client } = await open();
    await Promise.all([client.configurationSequence(), client.launch({ ...LAUNCH, stopOnEntry: true }), client.waitForEvent('stopped')]);
    const values = async () => {
      const frame = (await client.stackTraceRequest({ threadId: 1 })).body.stackFrames[0]!;
      const [scope] = (await client.scopesRequest({ frameId: frame.id })).body.scopes;
      return Object.fromEntries((await client.variablesRequest({ variablesReference: scope!.variablesReference })).body.variables.map((v) => [v.name, v.value]));
    };
    expect(await values()).toEqual({ status: 'not run yet', text: 'insert $a isa person, has name "Ann", has age 30;' });
    await Promise.all([client.nextRequest({ threadId: 1 }), client.waitForEvent('stopped')]);
    await Promise.all([client.nextRequest({ threadId: 1 }), client.waitForEvent('stopped')]);
    await Promise.all([client.stepOutRequest({ threadId: 1 }), client.waitForEvent('terminated')]);
  });

  it('runs to the end on continue, printing each answer, and exits 0', async () => {
    const { client } = await open();
    const exited = client.waitForEvent('exited');
    // Listening before the launch: output arrives while it runs.
    const printed: string[] = [];
    client.on('output', (event) => printed.push(event.body.output));
    await Promise.all([client.configurationSequence(), client.launch(LAUNCH), client.waitForEvent('terminated')]);
    expect((await exited).body.exitCode).toBe(0);
    expect(printed[0]).toBe('Ran the schema file /work/schema.tql: 1 statement(s).\n');
    expect(printed.find((text) => text.startsWith('Line 5: match $p isa person, has name $n;'))).toMatch(/Cid\s*\nAnn\s*\nBob/);
  });

  it('stops at a refusal with its message, and ends with exit code 1 on the next move', async () => {
    const { client } = await open('insert $a isa person, has name "Ann";\nmatch $p isa person, has age $a; $a > "x"; select $a;');
    // Listening before the launch: the stop can come before the launch's answer is read.
    const [, , stopped] = await Promise.all([client.configurationSequence(), client.launch(LAUNCH), client.waitForEvent('stopped')]);
    expect(stopped.body).toMatchObject({ reason: 'exception', description: 'Refused by TypeQLite', text: 'Cannot compare a integer with a string.' });
    expect(await line(client)).toBe(2);
    const exited = client.waitForEvent('exited');
    await Promise.all([client.continueRequest({ threadId: 1 }), client.waitForEvent('terminated')]);
    expect((await exited).body.exitCode).toBe(1);
  });

  it('runs without debugging through session.run, recording nothing', async () => {
    const { client, host } = await open();
    await Promise.all([client.configurationSequence(), client.launch({ ...LAUNCH, noDebug: true }), client.waitForEvent('terminated')]);
    expect(host.operations()).not.toContain('session.debug');
    expect(host.operations()).toContain('session.run');
  });

  it('fails a launch whose seed is refused, saying where', async () => {
    const { client } = await open();
    await Promise.all([client.configurationSequence(), expect(client.launch({ ...LAUNCH, seed: ['missing.tql'] })).rejects.toThrow(/Cannot read \/work\/missing.tql/)]);
  });

  it('closes the host session on disconnect', async () => {
    const { client, host } = await open();
    await Promise.all([client.configurationSequence(), client.launch({ ...LAUNCH, stopOnEntry: true }), client.waitForEvent('stopped')]);
    await client.disconnectRequest();
    expect(host.operations().at(-1)).toBe('session.close');
  });
});

describe('stages and rows over DAP (Phase 03)', () => {
  it('step in shows the stage inside its statement, and its rows, paged', async () => {
    const { client } = await open();
    await Promise.all([client.configurationSequence(), client.launch({ ...LAUNCH, stopOnEntry: true }), client.waitForEvent('stopped')]);
    for (const _ of [1, 2]) await Promise.all([client.nextRequest({ threadId: 1 }), client.waitForEvent('stopped')]);
    await Promise.all([client.stepInRequest({ threadId: 1 }), client.assertStoppedLocation('step', { line: 5 })]);
    const frames = (await client.stackTraceRequest({ threadId: 1 })).body.stackFrames;
    expect(frames.map((f) => [f.name, f.line])).toEqual([
      ['match · 1 → 3 row(s)', 5],
      ['match $p isa person, has name $n;', 5],
    ]);
    const scopes = (await client.scopesRequest({ frameId: frames[0]!.id })).body.scopes;
    expect(scopes.map((s) => [s.name, s.indexedVariables])).toEqual([
      ['Rows', 3],
      ['Stage', undefined],
      ['Scope', undefined],
    ]);
    const page = (await client.variablesRequest({ variablesReference: scopes[0]!.variablesReference, filter: 'indexed', start: 1, count: 2 })).body.variables;
    expect(page.map((v) => v.name)).toEqual(['2', '3']);
    // A row opens to its bindings, and a thing to its attributes.
    const bindings = (await client.variablesRequest({ variablesReference: page[0]!.variablesReference })).body.variables;
    expect(bindings.map((v) => v.name)).toEqual(['$p', '$n']);
    const thing = (await client.variablesRequest({ variablesReference: bindings[0]!.variablesReference })).body.variables;
    expect(thing.map((v) => [v.name, v.value])).toContainEqual(['name', '"Ann"']);
  });

  it('breakpoints set before the launch are answered after it, and continue stops at a stage`s line', async () => {
    const { client } = await open();
    const changed: Array<[number | undefined, boolean]> = [];
    client.on('breakpoint', (event) => changed.push([event.body.breakpoint.line, event.body.breakpoint.verified]));
    await client.initializeRequest();
    const set = await client.setBreakpointsRequest({ source: { path: `${WORK}/program.tql` }, breakpoints: [{ line: 7 }, { line: 4 }] });
    expect(set.body.breakpoints.map((b) => [b.line, b.verified, b.message])).toEqual([
      [7, false, 'Checked when the program starts.'],
      [4, false, 'Checked when the program starts.'],
    ]);
    await Promise.all([client.configurationDoneRequest(), client.launchRequest({ ...LAUNCH } as never), client.assertStoppedLocation('breakpoint', { line: 7 })]);
    // Line 4 is blank; line 7 waited for its statement, and held once it ran.
    expect(changed).toEqual([
      [7, false],
      [4, false],
      [7, true],
    ]);
    const exited = client.waitForEvent('exited');
    await Promise.all([client.continueRequest({ threadId: 1 }), client.waitForEvent('terminated')]);
    expect((await exited).body.exitCode).toBe(0);
  });

  it('a breakpoint in another file does not hold', async () => {
    const { client } = await open();
    await Promise.all([client.configurationSequence(), client.launch({ ...LAUNCH, stopOnEntry: true }), client.waitForEvent('stopped')]);
    const set = await client.setBreakpointsRequest({ source: { path: `${WORK}/schema.tql` }, breakpoints: [{ line: 1 }] });
    expect(set.body.breakpoints[0]).toMatchObject({ verified: false, message: 'Only the launched program stops: this file is not it.' });
  });
});

describe('inside a match over DAP (Phase 04)', () => {
  it('step in walks a match`s steps in the order they ran', async () => {
    const { client } = await open(['match', '  $p has age $a;', '  $a > 20;', '  $p isa person;', 'select $p;'].join('\n'), PEOPLE);
    await Promise.all([client.configurationSequence(), client.launch({ ...LAUNCH, stopOnEntry: true }), client.waitForEvent('stopped')]);
    const names: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      await Promise.all([client.stepInRequest({ threadId: 1 }), client.waitForEvent('stopped')]);
      const [top] = (await client.stackTraceRequest({ threadId: 1 })).body.stackFrames;
      names.push(`${top!.line}: ${top!.name}`);
    }
    expect(names).toEqual(['1: match · 1 → 2 row(s)', '2: thing $p · 1 → 3 row(s)', '2: $p has age $a · 3 → 3 row(s)', '3: $a > 20 · 3 → 2 row(s)']);
  });

  it('a frame inside a function defined in the schema is shown with no source', async () => {
    const schema = `${SCHEMA}\nfun adult_ages() -> { integer }:\n  match $p isa person, has age $a; $a >= 18;\n  return { $a };`;
    const { client } = await open('match let $g in adult_ages(); $g > 40;\nselect $g;', PEOPLE, schema);
    await Promise.all([client.configurationSequence(), client.launch({ ...LAUNCH, stopOnEntry: true }), client.waitForEvent('stopped')]);
    for (let i = 0; i < 4; i += 1) await Promise.all([client.stepInRequest({ threadId: 1 }), client.waitForEvent('stopped')]);
    const frames = (await client.stackTraceRequest({ threadId: 1 })).body.stackFrames;
    expect(frames[0]).toMatchObject({ name: 'thing $p · 1 → 3 row(s)', presentationHint: 'subtle' });
    expect(frames[0]!.source).toBeUndefined();
    expect(frames[2]).toMatchObject({ name: 'adult_ages() · 1 call(s)', source: { path: '/work/program.tql' } });
    // Out of the function, and of the step that called it: on to the next stage, on its own line.
    await Promise.all([client.stepOutRequest({ threadId: 1 }), client.assertStoppedLocation('step', { line: 2 })]);
    expect((await client.stackTraceRequest({ threadId: 1 })).body.stackFrames[0]!.name).toBe('select · 1 → 1 row(s)');
  });
});

describe('breakpoints that matter over DAP (Phase 05)', () => {
  const EMPTIED = ['match', '  $p isa person, has age $a;', '  $a > 100;', 'select $p;'].join('\n');

  it('offers conditional breakpoints, step back, exception info and the two exception filters', async () => {
    const { client } = await open();
    const { body } = await client.initializeRequest();
    expect(body).toMatchObject({ supportsConditionalBreakpoints: true, supportsStepBack: true, supportsExceptionInfoRequest: true });
    expect(body!.exceptionBreakpointFilters!.map((f) => [f.filter, f.default])).toEqual([
      ['refusal', true],
      ['empty', false],
    ]);
  });

  it('when a step empties, set before the launch: stops at the comparison, and says why', async () => {
    const { client } = await open(EMPTIED, PEOPLE);
    await client.initializeRequest();
    await client.setExceptionBreakpointsRequest({ filters: ['refusal', 'empty'] });
    const [, , stopped] = await Promise.all([client.configurationDoneRequest(), client.launchRequest({ ...LAUNCH } as never), client.waitForEvent('stopped')]);
    expect(stopped.body).toMatchObject({ reason: 'exception', text: '$a > 100: 3 row(s) in, none out.' });
    expect(await line(client)).toBe(3);
    const info = await client.exceptionInfoRequest({ threadId: 1 });
    expect(info.body).toMatchObject({ exceptionId: 'emptied', description: '$a > 100: 3 row(s) in, none out.', breakMode: 'always' });
  });

  it('a conditional breakpoint, and step back to the step before it', async () => {
    const { client } = await open(EMPTIED, PEOPLE);
    await client.initializeRequest();
    await client.setBreakpointsRequest({ source: { path: `${WORK}/program.tql` }, breakpoints: [{ line: 2, condition: 'rowsOut == 0' }, { line: 3, condition: 'rowsOut == 0' }] });
    await Promise.all([client.configurationDoneRequest(), client.launchRequest({ ...LAUNCH } as never), client.assertStoppedLocation('breakpoint', { line: 3 })]);
    await Promise.all([client.stepBackRequest({ threadId: 1 }), client.assertStoppedLocation('step', { line: 2 })]);
    const [top] = (await client.stackTraceRequest({ threadId: 1 })).body.stackFrames;
    expect(top!.name).toBe('$p has age $a · 3 → 3 row(s)');
    await Promise.all([client.reverseContinueRequest({ threadId: 1 }), client.assertStoppedLocation('entry', { line: 1 })]);
  });
});
