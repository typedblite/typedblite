import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import type { INestApplication } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createHostTool } from '../src/host-tool.js';
import { createMcpServer } from '../src/mcp.js';
import { runApi, runCli, runRepl, runSidecar } from '../src/main.js';

/** What every transport answers, with the one field that is a fresh id each time left out. */
interface Answer {
  readonly operation: string;
  readonly kind: string;
  readonly status: string;
  readonly exitCode: number;
  readonly data?: unknown;
  readonly error?: { code: string };
}
type Send = (operation: string, input: Record<string, string>) => Promise<Answer>;

const normal = (envelope: Record<string, unknown>): Answer => {
  const { correlationId: _id, schemaVersion: _version, error, ...rest } = envelope;
  return { ...rest, ...(error ? { error: { code: (error as { code: string }).code } } : {}) } as unknown as Answer;
};

/** The CLI: one operation as flags, one envelope on stdout, an exit code. */
const cli: Send = async (operation, input) => {
  let out = '';
  const flags = Object.entries(input).flatMap(([key, value]) => [`--${key}`, value]);
  const code = await runCli([operation, ...flags], undefined, { stdout: (text) => (out += text), stderr: () => undefined });
  const envelope = JSON.parse(out.trim().split('\n').at(-1)!) as Record<string, unknown>;
  expect(envelope['exitCode']).toBe(code);
  return normal(envelope);
};

/** Drives an entry point that reads lines from a stream: feeds it one request, ends the input, collects the output. */
const throughStreams = async (run: (input: PassThrough, output: PassThrough) => Promise<void>, request: string): Promise<string> => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk: Buffer) => (text += chunk.toString()));
  const done = run(input, output);
  input.end(`${request}\n`);
  await done;
  return text;
};

/** The sidecar: one JSON request per line, one envelope per line. */
const sidecar: Send = async (operation, input) => {
  const text = await throughStreams((i, o) => runSidecar(i, o), JSON.stringify({ operation, input }));
  return normal(JSON.parse(text.trim().split('\n').at(-1)!) as Record<string, unknown>);
};

/** The REPL answers in prose with a DATA block of JSON; the parts that are the envelope are read back out of it. */
const repl: Send = async (operation, input) => {
  const text = await throughStreams((i, o) => runRepl(i, o), JSON.stringify({ operation, input }));
  const response = text.slice(text.lastIndexOf('CQRS-TOOL(1)'));
  const field = (heading: string): string | undefined => response.match(new RegExp(`\\n${heading}\\n    (.*)`))?.[1];
  const data = response.match(/\nDATA\n((?: {4}.*\n?)+)/)?.[1];
  const error = field('ERROR');
  const status = field('STATUS')!.toLowerCase();
  return {
    operation: field('OPERATION')!,
    status,
    // The prose carries no kind or exit code. They are what the other transports say, so they are compared there.
    kind: undefined as unknown as string,
    exitCode: undefined as unknown as number,
    ...(data ? { data: JSON.parse(data.replace(/^ {4}/gm, '')) } : {}),
    ...(error ? { error: { code: error.split(':')[0]! } } : {}),
  };
};

let httpApp: INestApplication;
let mcpTool: Awaited<ReturnType<typeof createHostTool>>;
let mcpClient: Client;
beforeAll(async () => {
  mcpTool = await createHostTool();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ runtime: mcpTool.runtime, tier: 'write' }).connect(serverSide);
  mcpClient = new Client({ name: 'parity', version: '0' });
  await mcpClient.connect(clientSide);
  vi.stubEnv('TYPEDBLITE_HOST_PORT', '0');
  httpApp = await runApi();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await httpApp.close();
  await mcpClient.close();
  await mcpTool.close();
});

/** MCP, in the write tier: a tool call per operation. The text is the operation's data, or a fault's code. */
const mcp: Send = async (operation, input) => {
  const result = (await mcpClient.callTool({ name: operation, arguments: input })) as { isError?: boolean; content: { text: string }[] };
  const body = JSON.parse(result.content[0]!.text) as { code?: string };
  return {
    operation,
    kind: undefined as unknown as string,
    exitCode: undefined as unknown as number,
    ...(result.isError ? { status: 'error', error: { code: body.code! } } : { status: 'success', data: body }),
  };
};

/** HTTP: a POST per operation. The body is the operation's data, and the status stands for the exit code. */
const http: Send = async (operation, input) => {
  const { port } = httpApp.getHttpServer().address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${port}/api/typedblite-host/ops/${operation}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = (await response.json()) as { code?: string };
  return {
    operation,
    // The status line carries no kind or exit code either: those are compared between the CLI and the sidecar.
    kind: undefined as unknown as string,
    exitCode: undefined as unknown as number,
    ...(response.ok ? { status: 'success', data: body } : { status: 'error', error: { code: body.code! } }),
  };
};

const dir = mkdtempSync(join(tmpdir(), 'typedblite-host-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SCHEMA = 'define attribute name, value string; entity person, owns name;';

/** The same flow in a transport, against a file of its own, every step through the operation `session.run`. */
const flow = async (send: Send, name: string): Promise<Answer[]> => {
  const location = join(dir, `${name}.db`);
  const at = (statement: string) => send('session.run', { location, statement });
  return [
    await at(SCHEMA),
    await at('insert $p isa person, has name "Ada";'),
    await at('match $p isa person, has name $n; select $n;'),
    await at('insert $p isa nonexistent-type;'),
    await send('statement.classify', { statement: 'match $p isa person; delete $p;' }),
    await send('statement.split', { source: 'insert $a isa person;\ninsert $b isa person;' }),
    await send('session.get', { session: 's404' }),
    await send('session.run', { statement: 'x' }),
  ];
};

describe('one operation, five transports: the same answer', () => {
  it('the CLI, the sidecar, the REPL, HTTP and MCP answer the same flow the same way', async () => {
    const [viaCli, viaSidecar, viaRepl, viaHttp, viaMcp] = await Promise.all([
      flow(cli, 'cli'),
      flow(sidecar, 'sidecar'),
      flow(repl, 'repl'),
      flow(http, 'http'),
      flow(mcp, 'mcp'),
    ]);

    // The data and the status are the same in all three, step by step.
    const reduce = (answers: Answer[]) => answers.map(({ operation, status, data, error }) => ({ operation, status, data, error }));
    expect(reduce(viaSidecar)).toEqual(reduce(viaCli));
    expect(reduce(viaRepl)).toEqual(reduce(viaCli));
    expect(reduce(viaHttp)).toEqual(reduce(viaCli));
    expect(reduce(viaMcp)).toEqual(reduce(viaCli));
    // The CLI and the sidecar also agree on the exit code and the kind, which the REPL's prose does not carry.
    expect(viaSidecar).toEqual(viaCli);
  });

  it('is the flow we meant: a write, a read, an engine refusal as data, and two faults with codes', async () => {
    const answers = await flow(cli, 'meaning');
    expect(answers[1]).toMatchObject({ status: 'success', data: { kind: 'ok', statement: 'write' } });
    expect(answers[2]).toMatchObject({ status: 'success', data: { kind: 'rows', rows: [{ n: 'Ada' }] } });
    expect(answers[3]).toMatchObject({ status: 'success', exitCode: 0, data: { kind: 'refused', reason: 'engine' } });
    expect(answers[4]).toMatchObject({ data: { kind: 'write' } });
    expect(answers[5]).toMatchObject({ data: { statements: ['insert $a isa person;', 'insert $b isa person;'] } });
    expect(answers[6]).toMatchObject({ status: 'error', exitCode: 5, error: { code: 'SESSION_NOT_FOUND' } });
    expect(answers[7]).toMatchObject({ status: 'error', exitCode: 2, error: { code: 'INVALID_INPUT' } });
  });

  it('a session lives for the process that holds it: the sidecar and the REPL keep one across requests', async () => {
    const requests = [
      { operation: 'session.open', input: { schema: SCHEMA } },
      { operation: 'session.run', input: { session: 's1', statement: 'insert $p isa person, has name "Ada";' } },
      { operation: 'session.run', input: { session: 's1', statement: 'match $p isa person, has name $n; select $n;' } },
    ];
    for (const run of [(i: PassThrough, o: PassThrough) => runSidecar(i, o), (i: PassThrough, o: PassThrough) => runRepl(i, o)]) {
      const input = new PassThrough();
      const output = new PassThrough();
      let text = '';
      output.on('data', (chunk: Buffer) => (text += chunk.toString()));
      const done = run(input, output);
      for (const request of requests) input.write(`${JSON.stringify(request)}\n`);
      input.end();
      await done;
      expect(text).toMatch(/"id":\s*"s1"/);
      expect(text).toMatch(/"n":\s*"Ada"/);
    }
  });
});
