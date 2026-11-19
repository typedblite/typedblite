import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { TypeQLiteDebugSession } from '@typedblite/debugger';
import { DebugClient } from '@vscode/debugadapter-testsupport';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HostClient } from '../src/host/host-client';

/**
 * The debug adapter over the real engine host: the bundle the `.vsix` ships (`out/host/sidecar.cjs`), a `node` with
 * `node:sqlite`, real files, and a DAP client. This is the route ADR-014 B2 and B3 decide: the adapter in the
 * extension's process, the engine in the host's, and `session.debug` between them.
 */
const BUNDLE = resolve(__dirname, '../out/host/sidecar.cjs');

let host: HostClient;
let server: Server;
let client: DebugClient;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'typeqlite-debug-'));
  host = new HostClient({ sidecarPath: BUNDLE, configuredNode: () => process.execPath });
  server = createServer((socket) => {
    const session = new TypeQLiteDebugSession(host, { readFile: (path) => readFile(path, 'utf8') });
    session.setRunAsServer(true);
    session.start(socket, socket);
  }).listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  client = new DebugClient('node', 'unused', 'typeqlite');
  await client.start((server.address() as AddressInfo).port);
});

afterEach(async () => {
  await client.stop().catch(() => undefined);
  await new Promise((done) => server.close(done));
  await host.stop();
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, text: string): string => {
  writeFileSync(join(dir, name), text);
  return join(dir, name);
};

/** Every file in the folder, by name, with its hash: what a session must leave exactly as it was. */
const snapshot = (): Record<string, string> =>
  Object.fromEntries(readdirSync(dir).map((name) => [name, createHash('sha256').update(readFileSync(join(dir, name))).digest('hex')]));

const SCHEMA = 'define attribute title, value string; entity book, owns title;';
const PROGRAM = 'insert $b isa book, has title "Dune";\n\nmatch $b isa book, has title $t;\nselect $t;\n';

describe('the debug adapter, through the engine host', () => {
  it('launches a file, stops on entry, steps over each statement, and ends with exit code 0', async () => {
    write('schema.tql', SCHEMA);
    const program = write('program.tql', PROGRAM);
    const printed: string[] = [];
    client.on('output', (event) => printed.push(event.body.output));

    await Promise.all([client.configurationSequence(), client.launch({ program, schema: ['schema.tql'], stopOnEntry: true }), client.assertStoppedLocation('entry', { line: 1 })]);
    await Promise.all([client.nextRequest({ threadId: 1 }), client.assertStoppedLocation('step', { line: 3 })]);
    const exited = client.waitForEvent('exited');
    await Promise.all([client.nextRequest({ threadId: 1 }), client.waitForEvent('terminated')]);
    expect((await exited).body.exitCode).toBe(0);
    // The read saw what the insert wrote, and printed it.
    expect(printed.find((text) => text.startsWith('Line 3:'))).toMatch(/t\s*\n-+\s*\nDune/);
  });

  it('🔴 a program that writes, in a folder of files, leaves every file byte for byte as it was', async () => {
    write('schema.tql', SCHEMA);
    write('seed.tql', 'insert $b isa book, has title "Emma";');
    const program = write('program.tql', 'insert $b isa book, has title "Dune";\nmatch $b isa book; delete $b;\n');
    // A store beside the program, which a debugger must never open.
    write('store.db', 'not touched');
    const before = snapshot();
    await Promise.all([client.configurationSequence(), client.launch({ program, schema: ['schema.tql'], seed: ['seed.tql'] }), client.waitForEvent('terminated')]);
    expect(snapshot()).toEqual(before);
  });

  it('stops at a refusal, the engine`s own message, and exits 1', async () => {
    write('schema.tql', SCHEMA);
    const program = write('program.tql', 'insert $b isa book, has title "Dune";\ninsert $x isa nothing-of-the-kind;\n');
    // Listening before the launch: the stop can come before the launch's answer is read.
    const [, , stopped] = await Promise.all([client.configurationSequence(), client.launch({ program, schema: ['schema.tql'] }), client.waitForEvent('stopped')]);
    expect(stopped.body).toMatchObject({ reason: 'exception', text: expect.stringMatching(/nothing-of-the-kind/) });
    const exited = client.waitForEvent('exited');
    await Promise.all([client.continueRequest({ threadId: 1 }), client.waitForEvent('terminated')]);
    expect((await exited).body.exitCode).toBe(1);
  });

  it('runs without debugging, and fails a launch whose schema is refused', async () => {
    write('schema.tql', 'define entity book, owns nothing;');
    const program = write('program.tql', PROGRAM);
    await Promise.all([
      client.configurationSequence(),
      expect(client.launch({ program, schema: ['schema.tql'], noDebug: true })).rejects.toThrow(/The schema file .*schema\.tql was refused at line 1/),
    ]);
  });
  it('stops at a breakpoint on a stage`s line, and shows that stage`s rows (Phase 03)', async () => {
    write('schema.tql', SCHEMA);
    const program = write('program.tql', PROGRAM);
    await client.initializeRequest();
    await client.setBreakpointsRequest({ source: { path: program }, breakpoints: [{ line: 4 }] });
    await Promise.all([client.configurationDoneRequest(), client.launchRequest({ program, schema: ['schema.tql'] } as never), client.assertStoppedLocation('breakpoint', { line: 4 })]);
    const [frame] = (await client.stackTraceRequest({ threadId: 1 })).body.stackFrames;
    expect(frame!.name).toBe('select · 1 → 1 row(s)');
    const [rows] = (await client.scopesRequest({ frameId: frame!.id })).body.scopes;
    const [row] = (await client.variablesRequest({ variablesReference: rows!.variablesReference })).body.variables;
    expect(row!.value).toBe('{ $t: title "Dune" }');
  });
  it('stops at a breakpoint on a comparison`s line, at the step that holds it, with what it dropped (Phase 04)', async () => {
    write('schema.tql', 'define attribute title, value string; attribute pages, value integer; entity book, owns title, owns pages;');
    write('seed.tql', 'insert $a isa book, has title "Dune", has pages 412;\ninsert $b isa book, has title "Emma", has pages 90;');
    const program = write('program.tql', 'match\n  $b isa book, has pages $n;\n  $n > 100;\nselect $b;\n');
    await client.initializeRequest();
    await client.setBreakpointsRequest({ source: { path: program }, breakpoints: [{ line: 3 }] });
    await Promise.all([client.configurationDoneRequest(), client.launchRequest({ program, schema: ['schema.tql'], seed: ['seed.tql'] } as never), client.assertStoppedLocation('breakpoint', { line: 3 })]);
    const [frame] = (await client.stackTraceRequest({ threadId: 1 })).body.stackFrames;
    expect(frame!.name).toBe('$n > 100 · 2 → 1 row(s)');
    const scopes = (await client.scopesRequest({ frameId: frame!.id })).body.scopes;
    const values = scopes.find((scope) => scope.name === 'Lets and comparisons')!;
    expect((await client.variablesRequest({ variablesReference: values.variablesReference })).body.variables.map((v) => [v.name, v.value])).toEqual([['$n > 100', '2 → 1 kept, 1 dropped here']]);
  });
  it('🔴 a query whose rows disappear at a comparison stops at that comparison under "when a step empties" (Phase 05)', async () => {
    write('schema.tql', 'define attribute title, value string; attribute pages, value integer; entity book, owns title, owns pages;');
    write('seed.tql', 'insert $a isa book, has title "Dune", has pages 412;\ninsert $b isa book, has title "Emma", has pages 90;');
    const program = write('program.tql', 'match\n  $b isa book, has title $t;\n  $b has pages $n;\n  $n > 1000;\nselect $t;\n');
    await client.initializeRequest();
    await client.setExceptionBreakpointsRequest({ filters: ['refusal', 'empty'] });
    const [, , stopped] = await Promise.all([
      client.configurationDoneRequest(),
      client.launchRequest({ program, schema: ['schema.tql'], seed: ['seed.tql'] } as never),
      client.waitForEvent('stopped'),
    ]);
    expect(stopped.body).toMatchObject({ reason: 'exception', text: '$n > 1000: 2 row(s) in, none out.' });
    const [frame] = (await client.stackTraceRequest({ threadId: 1 })).body.stackFrames;
    // The third pattern of the match, on its own line: where the rows ran out.
    expect(frame).toMatchObject({ name: '$n > 1000 · 2 → 0 row(s)', line: 4 });
  });
});
