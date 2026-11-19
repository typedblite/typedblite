import {
  invalidInput,
  optionalString,
  requiredString,
  type OperationInputSchema,
  type ToolOperationDescriptor,
} from '@devx-micro/app-runtime';

import {
  BeginTransactionCommand,
  CloseSessionCommand,
  CommitTransactionCommand,
  DebugStatementCommand,
  OpenSessionCommand,
  RestartSessionCommand,
  RollbackTransactionCommand,
  RunStatementCommand,
} from './commands.js';
import {
  ClassifyStatementQuery,
  GetSchemaQuery,
  GetSessionQuery,
  ListSessionsQuery,
  LocateStatementsQuery,
  SplitStatementsQuery,
} from './queries.js';

/**
 * The host's operations, each declared once. Every transport (CLI, REPL, sidecar, and later HTTP and MCP) reads
 * this list and sends the request it builds through the buses, so an operation behaves the same however it is
 * reached (feature invariant 5). A transport that implements an operation itself has failed that invariant.
 *
 * 🔴 `validate` and `inputSchema` say the same thing twice, and a spec proves they agree
 * (`assertInputSchemaAgreesWithValidate`). Unknown input keys are refused by name.
 */
export function createHostOperations(): ToolOperationDescriptor<any>[] {
  const string = (): OperationInputSchema => ({ type: 'string', minLength: 1 });
  const bySession = <T>(
    name: string,
    summary: string,
    kind: 'command' | 'query',
    create: (session: string) => T,
  ): ToolOperationDescriptor<{ session: string }> => ({
    name,
    summary,
    kind,
    validate: (input) => ({ session: requiredString(input, 'session', name) }),
    createRequest: ({ session }) => create(session),
    inputSchema: { type: 'object', properties: { session: string() }, required: ['session'] },
  });

  const open: ToolOperationDescriptor<{ location?: string; schema?: string }> = {
    name: 'session.open',
    summary: "Open a store (':memory:' or a file) as a session, optionally applying a schema. Returns the session.",
    kind: 'command',
    validate: (input) => ({
      location: optionalString(input, 'location', 'session.open'),
      schema: optionalString(input, 'schema', 'session.open'),
    }),
    createRequest: ({ location, schema }) => new OpenSessionCommand(location, schema),
    inputSchema: { type: 'object', properties: { location: string(), schema: string() } },
  };

  const run: ToolOperationDescriptor<{ session?: string; location?: string; statement: string }> = {
    name: 'session.run',
    summary:
      'Run one statement. Name a session, or a location to open, run and close in one call. A refusal is returned as data.',
    kind: 'command',
    validate: (input) => {
      const session = optionalString(input, 'session', 'session.run');
      const location = optionalString(input, 'location', 'session.run');
      const statement = requiredString(input, 'statement', 'session.run');
      if ((session === undefined) === (location === undefined)) {
        invalidInput("session.run needs exactly one of 'session' and 'location'.");
      }
      return { session, location, statement };
    },
    createRequest: ({ session, location, statement }) => new RunStatementCommand(session, statement, location),
    inputSchema: {
      type: 'object',
      properties: { session: string(), location: string(), statement: string() },
      required: ['statement'],
    },
  };

  const LIMITS = ['rowsPerStep', 'callsPerSite', 'bytes'] as const;
  const debug: ToolOperationDescriptor<{ session: string; statement: string; limits?: Record<string, number> }> = {
    name: 'session.debug',
    summary: "Run one statement as session.run does, on a session at ':memory:', and answer a recording of what it did.",
    kind: 'command',
    validate: (input) => {
      const session = requiredString(input, 'session', 'session.debug');
      const statement = requiredString(input, 'statement', 'session.debug');
      const raw = input['limits'];
      if (raw === undefined) return { session, statement };
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) invalidInput("session.debug's 'limits' must be an object.");
      const limits: Record<string, number> = {};
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!(LIMITS as readonly string[]).includes(key)) invalidInput(`session.debug's 'limits' has no '${key}'.`);
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) invalidInput(`session.debug's 'limits.${key}' must be a whole number, 0 or more.`);
        limits[key] = value;
      }
      return { session, statement, limits };
    },
    createRequest: ({ session, statement, limits }) => new DebugStatementCommand(session, statement, limits),
    inputSchema: {
      type: 'object',
      properties: {
        session: string(),
        statement: string(),
        limits: {
          type: 'object',
          properties: Object.fromEntries(LIMITS.map((key) => [key, { type: 'integer', minimum: 0 }])),
        },
      },
      required: ['session', 'statement'],
    },
  };

  return [
    open,
    run,
    debug,
    bySession('session.begin', 'Open a transaction: statements join it until commit or rollback.', 'command', (s) => new BeginTransactionCommand(s)),
    bySession('session.commit', "Make the transaction's writes permanent.", 'command', (s) => new CommitTransactionCommand(s)),
    bySession('session.rollback', "Discard the transaction's writes.", 'command', (s) => new RollbackTransactionCommand(s)),
    bySession('session.restart', 'Close the store and open it again from the same location.', 'command', (s) => new RestartSessionCommand(s)),
    bySession('session.close', 'Release the store. A closed session refuses every run.', 'command', (s) => new CloseSessionCommand(s)),
    bySession('session.get', 'The state of one session: location, mode, whether it has a schema.', 'query', (s) => new GetSessionQuery(s)),
    {
      name: 'session.list',
      summary: 'The state of every session.',
      kind: 'query',
      validate: () => ({}),
      createRequest: () => new ListSessionsQuery(),
      inputSchema: { type: 'object', properties: {} },
    },
    bySession('schema.get', "The schema applied to a session's store.", 'query', (s) => new GetSchemaQuery(s)),
    {
      name: 'statement.classify',
      summary: 'What a statement is (define, read or write), without running it.',
      kind: 'query',
      validate: (input) => ({ statement: requiredString(input, 'statement', 'statement.classify') }),
      createRequest: ({ statement }: { statement: string }) => new ClassifyStatementQuery(statement),
      inputSchema: { type: 'object', properties: { statement: string() }, required: ['statement'] },
    },
    {
      name: 'statement.locate',
      summary: 'The statements statement.split finds, each as written and where it starts (line and character, from 0).',
      kind: 'query',
      validate: (input) => ({ source: requiredString(input, 'source', 'statement.locate') }),
      createRequest: ({ source }: { source: string }) => new LocateStatementsQuery(source),
      inputSchema: { type: 'object', properties: { source: string() }, required: ['source'] },
    },
    {
      name: 'statement.split',
      summary: 'Split a source into statements that session.run can run one at a time.',
      kind: 'query',
      validate: (input) => ({ source: requiredString(input, 'source', 'statement.split') }),
      createRequest: ({ source }: { source: string }) => new SplitStatementsQuery(source),
      inputSchema: { type: 'object', properties: { source: string() }, required: ['source'] },
    },
  ];
}
