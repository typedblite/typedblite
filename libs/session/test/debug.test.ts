import { describe, expect, it } from 'vitest';

import { Session } from '../src/index.js';

/** `Session.debug` (ADR-014 B1): one statement, run as `run` runs it, with a recording of what it did. */
describe('Session.debug', () => {
  const ready = async (): Promise<Session> => {
    const session = new Session(':memory:');
    await session.run('define attribute name, value string; attribute age, value integer; entity person, owns name, owns age;');
    await session.run('insert $a isa person, has name "Ann", has age 30; $b isa person, has name "Bob", has age 17;');
    return session;
  };

  it('answers what run answers, and records the statement', async () => {
    const session = await ready();
    const query = 'match $p isa person, has age $a; $a > 20; select $p;';
    const { result, recording } = await session.debug(query);
    expect(result).toEqual(await session.run(query));
    expect(recording.frames).toHaveLength(1);
    expect(recording.frames[0].stages.map((stage) => [stage.kind, stage.rowsIn, stage.rowsOut])).toEqual([
      ['match', 1, 1],
      ['select', 1, 1],
    ]);
    expect(recording.refusal).toBeUndefined();
  });

  it('records a write, which a later run sees, as any run would leave it', async () => {
    const session = await ready();
    const { result, recording } = await session.debug('match $p isa person, has name "Bob"; insert $p has age 18;');
    expect(result.kind).toBe('ok');
    expect(recording.frames[0].stages.map((stage) => stage.kind)).toEqual(['match', 'insert']);
    expect((await session.run('match $p isa person, has age 18; select $p;')).kind === 'rows').toBe(true);
  });

  it('records a refusal with its code, and leaves nothing attached afterwards', async () => {
    const session = await ready();
    const { result, recording } = await session.debug('match $p isa person, has age $a; $a > "x"; select $a;');
    expect(result.kind).toBe('refused');
    expect(recording.refusal?.code).toBe('typedblite.value-type-conflict');
    expect(recording.refusal?.range).toBeDefined();
    // A later run is not recorded into anything: the result is the plain one.
    expect((await session.run('match $p isa person; select $p;')).kind).toBe('rows');
  });

  it('records nothing for a define, and refuses on a closed session', async () => {
    const session = await ready();
    expect((await session.debug('define attribute email, value string;')).recording.frames).toEqual([]);
    await session.close();
    const closed = await session.debug('match $p isa person; select $p;');
    expect(closed.result).toMatchObject({ kind: 'refused', reason: 'closed' });
    expect(closed.recording.frames).toEqual([]);
  });

  it('passes its caps to the recorder', async () => {
    const session = await ready();
    const { recording } = await session.debug('match $p isa person; select $p;', { rowsPerStep: 1 });
    expect(recording.limits.rowsPerStep).toBe(1);
    expect(recording.frames[0].stages[0].rows).toHaveLength(1);
    expect(recording.frames[0].stages[0].rowsDropped).toBe(1);
  });
});
