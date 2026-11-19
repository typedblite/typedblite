import 'reflect-metadata';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import type { ControlResult, DebugResult, LocatedStatement, RunResult, StatementKind } from '@typedblite/session';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BeginTransactionCommand,
  ClassifyStatementQuery,
  CloseSessionCommand,
  CommitTransactionCommand,
  DebugStatementCommand,
  EngineHostModule,
  GetSchemaQuery,
  GetSessionQuery,
  HostError,
  ListSessionsQuery,
  LocateStatementsQuery,
  OpenSessionCommand,
  RestartSessionCommand,
  RollbackTransactionCommand,
  RunStatementCommand,
  SplitStatementsQuery,
  type SessionInfo,
} from '../src/index.js';

const SCHEMA =
  'define attribute name, value string; attribute code, value string; entity person, owns name, owns code @key;';
const insert = (name: string) => `insert $p isa person, has name "${name}", has code "${name}";`;

let app: TestingModule;
let commands: CommandBus;
let queries: QueryBus;
const files: string[] = [];

beforeEach(async () => {
  app = await Test.createTestingModule({ imports: [EngineHostModule] }).compile();
  await app.init();
  commands = app.get(CommandBus);
  queries = app.get(QueryBus);
});
afterEach(async () => {
  await app.close();
  for (const file of files.splice(0)) for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(file + suffix, { force: true });
});

const open = (location?: string, schema?: string) => commands.execute<OpenSessionCommand, SessionInfo>(new OpenSessionCommand(location, schema));
const run = (id: string, statement: string) => commands.execute<RunStatementCommand, RunResult>(new RunStatementCommand(id, statement));
const control = (command: BeginTransactionCommand | CommitTransactionCommand | RollbackTransactionCommand | RestartSessionCommand) =>
  commands.execute<typeof command, ControlResult>(command);
const info = (id: string) => queries.execute<GetSessionQuery, SessionInfo>(new GetSessionQuery(id));
const names = async (id: string): Promise<string[]> => {
  const result = await run(id, 'match $p isa person, has name $n; select $n;');
  if (result.kind !== 'rows') throw new Error(JSON.stringify(result));
  return result.rows.map((row) => row['n'] as string).sort();
};
const tempFile = (): string => {
  const path = join(tmpdir(), `typedblite-host-${Math.random().toString(36).slice(2)}.db`);
  files.push(path);
  return path;
};
const rejection = async (work: Promise<unknown>): Promise<HostError> => {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(HostError);
    return error as HostError;
  }
  throw new Error('expected a HostError');
};

describe('the session lifecycle, through the bus', () => {
  it('opens, defines, writes, reads, commits, rolls back, restarts and closes', async () => {
    const { id } = await open();
    expect(await info(id)).toEqual({ id, location: ':memory:', mode: 'auto', hasSchema: false, closed: false });

    expect(await run(id, SCHEMA)).toMatchObject({ kind: 'ok', statement: 'define' });
    expect((await info(id)).hasSchema).toBe(true);

    await control(new BeginTransactionCommand(id));
    expect((await info(id)).mode).toBe('manual');
    await run(id, insert('gone'));
    await control(new RollbackTransactionCommand(id));
    expect(await names(id)).toEqual([]);

    await control(new BeginTransactionCommand(id));
    await run(id, insert('kept'));
    expect(await control(new CommitTransactionCommand(id))).toEqual({ kind: 'ok' });
    expect(await names(id)).toEqual(['kept']);

    expect(await control(new RestartSessionCommand(id))).toEqual({ kind: 'ok' });
    expect((await info(id)).hasSchema).toBe(false);

    expect(await commands.execute(new CloseSessionCommand(id))).toMatchObject({ id, closed: true });
  });

  it('applies a schema at open, and fails the open, without a session, when the schema is refused', async () => {
    const { id } = await open(':memory:', SCHEMA);
    expect((await info(id)).hasSchema).toBe(true);

    const refused = await rejection(open(':memory:', 'define entity;'));
    expect(refused).toMatchObject({ code: 'SCHEMA_REFUSED', exitCode: 2 });
    const all = await queries.execute<ListSessionsQuery, SessionInfo[]>(new ListSessionsQuery());
    expect(all.filter((s) => !s.closed)).toHaveLength(1);
  });

  it('a closed session refuses every run, and says so as data', async () => {
    const { id } = await open();
    await commands.execute(new CloseSessionCommand(id));
    expect(await run(id, 'match $x isa thing;')).toMatchObject({ kind: 'refused', reason: 'closed' });
    expect(await control(new BeginTransactionCommand(id))).toMatchObject({ kind: 'refused', reason: 'closed' });
    expect(await rejection(queries.execute(new GetSchemaQuery(id)))).toMatchObject({ code: 'SESSION_CLOSED', exitCode: 3 });
  });

  it('an unknown session id is an error with a code to branch on', async () => {
    expect(await rejection(run('nope', 'match $x isa thing;'))).toMatchObject({ code: 'SESSION_NOT_FOUND', exitCode: 5 });
    expect(await rejection(queries.execute(new GetSessionQuery('nope')))).toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  it('a file that cannot be opened is an infrastructure error', async () => {
    expect(await rejection(open('/no/such/directory/x.db'))).toMatchObject({ code: 'OPEN_FAILED', exitCode: 10 });
  });
});

describe('what a run answers', () => {
  it('returns the engine\'s own refusal as data, and diagnostics with a run', async () => {
    const { id } = await open(':memory:', SCHEMA);
    const refused = await run(id, 'insert $p isa nonexistent-type;');
    expect(refused).toMatchObject({ kind: 'refused', reason: 'engine' });
    expect((refused as { message: string }).message).toMatch(/nonexistent-type/);

    const written = await run(id, insert('ada'));
    expect(written.kind).toBe('ok');
    expect(Array.isArray(written.diagnostics)).toBe(true);
  });

  it('refuses a statement before any schema, as no-schema', async () => {
    const { id } = await open();
    expect(await run(id, 'insert $p isa person;')).toMatchObject({ kind: 'refused', reason: 'no-schema' });
  });

  it('answers the schema of a store', async () => {
    const { id } = await open(':memory:', SCHEMA);
    expect(await queries.execute(new GetSchemaQuery(id))).toMatchObject({ types: ['person'], attributes: ['code', 'name'] });
  });
});

describe('sessions', () => {
  it('keep separate stores, and are listed', async () => {
    const a = await open(':memory:', SCHEMA);
    const b = await open(':memory:', SCHEMA);
    await run(a.id, insert('only-a'));
    expect(await names(b.id)).toEqual([]);
    expect(a.id).not.toBe(b.id);
    const all = await queries.execute<ListSessionsQuery, SessionInfo[]>(new ListSessionsQuery());
    expect(all.map((s) => s.id)).toEqual([a.id, b.id]);
  });

  it('two sessions on one file: the second writer is refused as locked while the first holds a transaction', async () => {
    const path = tempFile();
    const a = await open(path, SCHEMA);
    await run(a.id, insert('committed'));
    const b = await open(path);
    await control(new BeginTransactionCommand(a.id));
    await run(a.id, insert('pending'));
    expect(await names(b.id)).toEqual(['committed']);
    await control(new CommitTransactionCommand(a.id));
    expect(await names(b.id)).toEqual(['committed', 'pending']);
  });

  it('shutting the host down releases every file', async () => {
    const path = tempFile();
    const { id } = await open(path, SCHEMA);
    await run(id, insert('persisted'));
    await app.close();
    app = await Test.createTestingModule({ imports: [EngineHostModule] }).compile();
    await app.init();
    commands = app.get(CommandBus);
    queries = app.get(QueryBus);
    const reopened = await open(path);
    expect(reopened.hasSchema).toBe(true);
    expect(await names(reopened.id)).toEqual(['persisted']);
  });
});

describe('the classifier', () => {
  it.each<[string, StatementKind]>([
    ['define entity a;', 'define'],
    ['match $a isa a; select $a;', 'read'],
    ['insert $a isa a;', 'write'],
    ['', 'empty'],
  ])('classifies %j as %s without a session', async (statement, kind) => {
    expect(await queries.execute(new ClassifyStatementQuery(statement))).toEqual({ kind });
  });

  it('splits a source into statements', async () => {
    expect(await queries.execute(new SplitStatementsQuery('define entity a;\ninsert $x isa a;\ninsert $y isa a;'))).toEqual({
      statements: ['define entity a;', 'insert $x isa a;', 'insert $y isa a;'],
    });
  });
});

describe('the debugger\'s operations (ADR-014)', () => {
  const debug = (id: string, statement: string, limits = {}) =>
    commands.execute<DebugStatementCommand, DebugResult>(new DebugStatementCommand(id, statement, limits));

  it('session.debug answers what session.run would, and a recording of it', async () => {
    const { id } = await open(':memory:', SCHEMA);
    await run(id, insert('Ada'));
    const { result, recording } = await debug(id, 'match $p isa person, has name $n; select $n;');
    expect(result).toMatchObject({ kind: 'rows', rows: [{ n: 'Ada' }] });
    expect(recording.frames[0]!.stages.map((stage) => stage.kind)).toEqual(['match', 'select']);
  });

  it('session.debug passes its caps to the recorder, and records a refusal', async () => {
    const { id } = await open(':memory:', SCHEMA);
    await run(id, insert('Ada'));
    await run(id, insert('Bo'));
    const capped = await debug(id, 'match $p isa person; select $p;', { rowsPerStep: 1 });
    expect(capped.recording.frames[0]!.stages[0]).toMatchObject({ rowsOut: 2, rowsDropped: 1 });
    const refused = await debug(id, 'match $p isa nothing-of-the-kind; select $p;');
    expect(refused.result.kind).toBe('refused');
    expect(refused.recording.refusal?.message).toMatch(/nothing-of-the-kind/);
  });

  it('🔴 session.debug is refused on a session that is not at :memory:, and nothing runs', async () => {
    const file = join(tmpdir(), `debug-refused-${process.pid}.db`);
    files.push(file);
    const { id } = await open(file, SCHEMA);
    await expect(debug(id, insert('Ada'))).rejects.toMatchObject({ code: 'NOT_IN_MEMORY' });
    expect(await run(id, 'match $p isa person; select $p;')).toMatchObject({ kind: 'rows', rows: [] });
  });

  it('statement.locate answers each statement as written, and where it starts', async () => {
    const source = '# setup\ninsert $a isa person, has name "A", has code "A";\n\n  match $p isa person;\n  # why\n  select $p;';
    const { statements } = await queries.execute<LocateStatementsQuery, { statements: LocatedStatement[] }>(new LocateStatementsQuery(source));
    expect(statements).toEqual([
      { text: 'insert $a isa person, has name "A", has code "A";', line: 1, character: 0 },
      { text: 'match $p isa person;\n  # why\n  select $p;', line: 3, character: 2 },
    ]);
  });
});
