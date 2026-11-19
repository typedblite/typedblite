import 'reflect-metadata';
import { assertInputSchemaAgreesWithValidate, probeInput } from '@devx-micro/app-runtime';
import { describe, expect, it } from 'vitest';

import { createHostOperations } from '../src/index.js';

const operations = createHostOperations();
const named = (name: string) => {
  const found = operations.find((operation) => operation.name === name);
  if (!found) throw new Error(`no operation ${name}`);
  return found;
};

// One valid input per operation, supplying every property its schema declares.
const EXAMPLES: Record<string, Record<string, unknown>> = {
  'session.open': { location: ':memory:', schema: 'define entity a;' },
  'session.run': { session: 's1', location: ':memory:', statement: 'match $a isa a;' },
  'session.begin': { session: 's1' },
  'session.commit': { session: 's1' },
  'session.rollback': { session: 's1' },
  'session.restart': { session: 's1' },
  'session.close': { session: 's1' },
  'session.get': { session: 's1' },
  'session.list': {},
  'schema.get': { session: 's1' },
  'statement.classify': { statement: 'insert $a isa a;' },
  'statement.split': { source: 'insert $a isa a;' },
};

describe('the operation list', () => {
  it('names the twelve operations of ADR-011 D4, once each', () => {
    expect(operations.map((o) => o.name).sort()).toEqual(Object.keys(EXAMPLES).sort());
  });

  it.each(Object.keys(EXAMPLES))('%s declares an input schema, and it agrees with its validate hook', (name) => {
    const operation = named(name);
    expect(operation.inputSchema).toBeDefined();
    if (name === 'session.run') {
      // validate refuses both `session` and `location` at once; the schema cannot say "exactly one". Each form agrees.
      expect(() => assertInputSchemaAgreesWithValidate(operation, EXAMPLES[name]!)).toThrow(/exactly one/);
      return;
    }
    assertInputSchemaAgreesWithValidate(operation, EXAMPLES[name]!);
  });

  it('reads and writes the right bus', () => {
    const commands = ['session.open', 'session.run', 'session.begin', 'session.commit', 'session.rollback', 'session.restart', 'session.close'];
    for (const operation of operations) expect(operation.kind).toBe(commands.includes(operation.name) ? 'command' : 'query');
  });
});

describe('session.run input', () => {
  const run = named('session.run');
  const validate = (input: Record<string, unknown>) => run.validate!(probeInput(input).input);

  it('takes a session or a location, and builds the one request', () => {
    expect(run.createRequest(validate({ session: 's1', statement: 'x' }))).toMatchObject({ sessionId: 's1', statement: 'x' });
    expect(run.createRequest(validate({ location: 'a.db', statement: 'x' }))).toMatchObject({ sessionId: undefined, location: 'a.db' });
  });

  it('refuses neither, and both', () => {
    expect(() => validate({ statement: 'x' })).toThrow(/exactly one/);
    expect(() => validate({ session: 's1', location: 'a.db', statement: 'x' })).toThrow(/exactly one/);
  });
});
