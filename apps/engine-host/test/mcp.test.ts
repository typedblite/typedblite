import 'reflect-metadata';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppToolHandle } from '@devx-micro/app-main';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Session } from '@typedblite/session';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createHostOperations, createHostTool, createMcpServer, READ_TIER, toolsFor, type McpTier } from '../src/index.js';

const SCHEMA = 'define attribute name, value string; entity person, owns name;';
const dir = mkdtempSync(join(tmpdir(), 'typedblite-mcp-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let tool: AppToolHandle;
const clients: Client[] = [];
beforeAll(async () => {
  tool = await createHostTool();
});
afterAll(async () => {
  await tool.close();
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

/** A client connected to a host's MCP server in memory: the protocol, with no process. */
async function connect(tier: McpTier, operations?: ReturnType<typeof createHostOperations>): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ runtime: tool.runtime, tier, operations }).connect(serverSide);
  const client = new Client({ name: 'spec', version: '0' });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

type Called = { isError: boolean; text: string; json: any };
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Called> {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  const text = result.content[0]!.text;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: result.isError === true, text, json };
}

/** A store with a schema and one person, made by the host's own session, for the read tier to look at. */
async function seeded(name: string): Promise<string> {
  const location = join(dir, `${name}.db`);
  const session = new Session(location);
  await session.run(SCHEMA);
  await session.run('insert $p isa person, has name "Ada";');
  await session.close();
  return location;
}
const names = async (location: string): Promise<string[]> => {
  const session = new Session(location);
  const result = await session.run('match $p isa person, has name $n; select $n;');
  await session.close();
  return result.kind === 'rows' ? result.rows.map((row) => row['n']!).sort() : [];
};

describe('the tools a tier offers', () => {
  it('the read tier lists the read operations, each with the input schema of its descriptor', async () => {
    const { tools } = await (await connect('read')).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TIER].sort());
    for (const listed of tools) {
      expect(listed.inputSchema.type).toBe('object');
      expect(listed.annotations?.readOnlyHint).toBe(true);
    }
    expect(tools.find((t) => t.name === 'session.run')!.inputSchema).toMatchObject({ required: ['statement'] });
  });

  it('the write tier lists every operation, and marks the commands as not read-only', async () => {
    const { tools } = await (await connect('write')).listTools();
    expect(tools).toHaveLength(12);
    expect(tools.find((t) => t.name === 'session.open')!.annotations?.readOnlyHint).toBe(false);
    expect(tools.find((t) => t.name === 'schema.get')!.annotations?.readOnlyHint).toBe(true);
  });

  it('lists only operations that declare an input schema', async () => {
    const operations = createHostOperations().map((operation) => (operation.name === 'session.list' ? { ...operation, inputSchema: undefined } : operation));
    expect(toolsFor('write', operations).map((o) => o.name)).not.toContain('session.list');
    expect(toolsFor('write', operations)).toHaveLength(11);
    const { tools } = await (await connect('write', operations)).listTools();
    expect(tools.map((t) => t.name)).not.toContain('session.list');
  });
});

describe('the read tier', () => {
  it('runs a read against an existing store, and the answer is the operation\'s data', async () => {
    const location = await seeded('read');
    const answer = await call(await connect('read'), 'session.run', { location, statement: 'match $p isa person, has name $n; select $n;' });
    expect(answer).toMatchObject({ isError: false, json: { kind: 'rows', rows: [{ n: 'Ada' }] } });
  });

  it('refuses a write and a define, says why, and leaves the store as it was', async () => {
    const location = await seeded('write-refused');
    const client = await connect('read');
    for (const statement of ['insert $p isa person, has name "Eve";', 'match $p isa person; delete $p;', 'define entity extra;']) {
      const answer = await call(client, 'session.run', { location, statement });
      expect(answer.isError).toBe(true);
      expect(answer.text).toMatch(/read tier runs reads only/);
      expect(answer.text).toContain('--mcp-write');
    }
    expect(await names(location)).toEqual(['Ada']);
  });

  it('a statement that mentions a write word only in a string is still a read', async () => {
    const location = await seeded('string');
    const answer = await call(await connect('read'), 'session.run', { location, statement: 'match $p isa person, has name "please insert delete"; select $p;' });
    expect(answer.isError).toBe(false);
  });

  // The classifier that gates a call is the one that routes it: a `read` goes to the interpreter's `query`, which
  // cannot write. `undefine` is classified as a read today (Phase 01's finding), so it reaches `query` and is refused.
  it('an undefine is routed as a read, so it cannot change the schema either', async () => {
    const location = await seeded('undefine');
    const answer = await call(await connect('read'), 'session.run', { location, statement: 'undefine entity person;' });
    expect(answer.json).toMatchObject({ kind: 'refused', reason: 'engine' });
    const session = new Session(location);
    expect(session.schema().types).toContain('person');
    await session.close();
  });

  it('does not create a store: a location that does not exist is refused, and no file appears', async () => {
    const location = join(dir, 'missing.db');
    const answer = await call(await connect('read'), 'session.run', { location, statement: 'match $p isa person; select $p;' });
    expect(answer.isError).toBe(true);
    expect(answer.text).toMatch(/does not create stores/);
    expect(existsSync(location)).toBe(false);
  });

  it('an existing store is byte for byte as it was after a read', async () => {
    const { readFileSync } = await import('node:fs');
    const location = await seeded('bytes');
    const before = readFileSync(location);
    await call(await connect('read'), 'session.run', { location, statement: 'match $p isa person; select $p;' });
    expect(Buffer.compare(before, readFileSync(location))).toBe(0);
  });

  it('refuses an operation outside the tier by name, and an unknown tool differently', async () => {
    const client = await connect('read');
    for (const name of ['session.open', 'session.begin', 'session.commit', 'session.rollback', 'session.restart', 'session.close']) {
      const answer = await call(client, name, { session: 's1' });
      expect(answer.isError).toBe(true);
      expect(answer.text).toContain('not available in the read tier');
    }
    expect((await call(client, 'no.such.tool')).text).toBe("There is no tool 'no.such.tool'.");
  });

  it('lets bad input through, so the caller gets the validator\'s own message', async () => {
    const answer = await call(await connect('read'), 'session.run', { statement: 'match $x isa y;' });
    expect(answer).toMatchObject({ isError: true, json: { code: 'INVALID_INPUT' } });
  });

  it('answers the other reads', async () => {
    const client = await connect('read');
    expect((await call(client, 'statement.classify', { statement: 'insert $a isa a;' })).json).toEqual({ kind: 'write' });
    expect((await call(client, 'statement.split', { source: 'insert $a isa a;\ninsert $b isa a;' })).json.statements).toHaveLength(2);
    expect((await call(client, 'session.get', { session: 'nope' }))).toMatchObject({ isError: true, json: { code: 'SESSION_NOT_FOUND' } });
  });
});

describe('the write tier, opted into', () => {
  it('opens a session, writes, reads, and rolls back', async () => {
    const client = await connect('write');
    const opened = await call(client, 'session.open', { schema: SCHEMA });
    const session = opened.json.id as string;
    expect(opened.json).toMatchObject({ hasSchema: true });

    await call(client, 'session.begin', { session });
    await call(client, 'session.run', { session, statement: 'insert $p isa person, has name "Gone";' });
    await call(client, 'session.rollback', { session });
    const read = await call(client, 'session.run', { session, statement: 'match $p isa person; select $p;' });
    expect(read.json).toMatchObject({ kind: 'rows', rows: [] });
    await call(client, 'session.close', { session });
  });

  it('writes to a store by location', async () => {
    const location = join(dir, 'created.db');
    const client = await connect('write');
    await call(client, 'session.run', { location, statement: SCHEMA });
    await call(client, 'session.run', { location, statement: 'insert $p isa person, has name "Made";' });
    expect(await names(location)).toEqual(['Made']);
  });
});
