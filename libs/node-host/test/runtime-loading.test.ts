import { describe, expect, it } from 'vitest';

import * as runtime from '@typedblite/runtime';

import { createSqliteEngine, loadTypeDbLiteRuntime, TypeDBLiteDatabase } from '../src/typedblite-database.js';

describe('loadTypeDbLiteRuntime', () => {
  it('answers the engine, the replicator and the change-stream handler of the one runtime', async () => {
    const loaded = await loadTypeDbLiteRuntime();

    expect(loaded.SqliteEngine).toBe(runtime.SqliteEngine);
    expect(loaded.TypeDBLiteReplicator).toBe(runtime.TypeDBLiteReplicator);
    expect(loaded.createChangeStreamHandler).toBe(runtime.createChangeStreamHandler);
  });
});

describe('createSqliteEngine', () => {
  it('builds the default engine, in memory when given no location, for a root that keeps hold of it', async () => {
    const engine = await createSqliteEngine();

    expect(engine).toBeInstanceOf(runtime.SqliteEngine);
    // The composition root holds the engine so that it can reach its change log.
    expect((engine as InstanceType<typeof runtime.SqliteEngine>).changeLog).toBeDefined();

    const database = await TypeDBLiteDatabase.open({ name: 'held', engine });
    await database.define('define attribute code, value string; entity item, owns code @key;');
    await database.execute('insert $i isa item, has code "a";');
    const { rows } = await database.query('match $i isa item, has code $c; select $c;');
    expect(rows).toHaveLength(1);
    expect(database.durable).toBe(false);
    await database.close();
  });
});
