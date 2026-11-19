import type { DebugClient } from '@vscode/debugadapter-testsupport';
import { afterEach, describe, expect, it } from 'vitest';

import { InProcessHost } from './support/in-process-host.js';
import { connect } from './support/dap.js';
import { standardFiles, WORK } from './support/fixtures.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const LAUNCH = { program: `${WORK}/program.tql`, schema: ['schema.tql'], seed: ['seed.tql'] };

async function open(program?: string): Promise<{ client: DebugClient; host: InProcessHost }> {
  const host = new InProcessHost();
  const connected = await connect(host, standardFiles(program));
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
