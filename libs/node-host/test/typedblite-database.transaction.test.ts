import { describe, expect, it } from 'vitest';

import { TypeDBLiteDatabase, type EmbeddedDatabase } from '../src/typedblite-database.js';

/**
 * `TypeDBLiteDatabase.transaction`: atomic against one store, serialized on one handle, and a refusal, never a
 * silent non-atomic run, on an engine that cannot do it.
 */
const schema = `define
  entity skill,
    owns skill-id @key;
  attribute skill-id, value string;`;

const insert = (label: string) =>
  `insert $x isa skill, has skill-id "${label}";`;

const labels = async (db: TypeDBLiteDatabase): Promise<string[]> => {
  const { rows } = await db.query(
    'match $x isa skill, has skill-id $l; select $l;',
  );
  return rows
    .map((row) => {
      const value = row['l'] as { asString?: () => string } | string;
      return typeof value === 'string'
        ? value
        : (value.asString?.() ?? String(value));
    })
    .sort();
};

const open = async () => {
  const db = await TypeDBLiteDatabase.open({ name: 'txn' });
  await db.define(schema);
  return db;
};

describe('TypeDBLiteDatabase.transaction', () => {
  it('commits the work and returns its result', async () => {
    const db = await open();

    const result = await db.transaction(async (tx) => {
      await tx.execute(insert('a'));
      await tx.execute(insert('b'));
      return 'done';
    });

    expect(result).toBe('done');
    expect(await labels(db)).toEqual(['a', 'b']);
  });

  it('🔴 rolls back when the work throws, and rethrows the same error', async () => {
    const db = await open();
    const boom = new Error('boom');

    await expect(
      db.transaction(async (tx) => {
        await tx.execute(insert('a'));
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(await labels(db)).toEqual([]);
  });

  it('lets the work read its own uncommitted writes through the handle', async () => {
    const db = await open();

    const seen = await db.transaction(async (tx) => {
      await tx.execute(insert('a'));
      const { rows } = await tx.query(
        'match $x isa skill, has skill-id $l; select $l;',
      );
      return rows.length;
    });

    expect(seen).toBe(1);
  });

  it('🔴 a second transaction waits for the first, so the two never interleave', async () => {
    const db = await open();
    const order: string[] = [];

    const first = db.transaction(async (tx) => {
      order.push('first:start');
      await tx.execute(insert('a'));
      await new Promise((resolve) => setTimeout(resolve, 40));
      order.push('first:end');
    });
    const second = db.transaction(async (tx) => {
      order.push('second:start');
      await tx.execute(insert('b'));
      order.push('second:end');
    });
    await Promise.all([first, second]);

    expect(order).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ]);
  });

  it('🔴 a plain execute on the handle waits for an open transaction and lands after it', async () => {
    const db = await open();
    const order: string[] = [];

    const transaction = db.transaction(async (tx) => {
      await tx.execute(insert('in-transaction'));
      await new Promise((resolve) => setTimeout(resolve, 40));
      order.push('transaction:end');
    });
    // Let the transaction start before the outsider arrives.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const outsider = db
      .execute(insert('outside'))
      .then(() => order.push('outside:done'));
    await Promise.all([transaction, outsider]);

    expect(order).toEqual(['transaction:end', 'outside:done']);
    expect(await labels(db)).toEqual(['in-transaction', 'outside']);
  });

  it('a rolled-back transaction does not strand the next one', async () => {
    const db = await open();

    await expect(
      db.transaction(async () => {
        throw new Error('first fails');
      }),
    ).rejects.toThrow('first fails');
    await db.transaction(async (tx) => {
      await tx.execute(insert('after'));
    });

    expect(await labels(db)).toEqual(['after']);
  });

  it('🔴 refuses (rather than hangs) when the work calls the database instead of the handle', async () => {
    const db = await open();

    await expect(
      db.transaction(async () => {
        await db.execute(insert('wrong-handle'));
      }),
    ).rejects.toThrow(/inside a transaction.*handle/i);

    expect(await labels(db)).toEqual([]);
  });

  it('🔴 refuses (rather than deadlocks) a transaction started inside a transaction', async () => {
    const db = await open();

    await expect(
      db.transaction(async () => {
        await db.transaction(async () => undefined);
      }),
    ).rejects.toThrow(/nested/i);
  });

  it('does not mistake an unrelated caller for being inside the transaction', async () => {
    const db = await open();
    const other = await open();

    await db.transaction(async () => {
      await other.execute(insert('elsewhere'));
    });

    expect(await labels(other)).toEqual(['elsewhere']);
  });

  it('🔴 a plain write queued behind a transaction never lands inside the NEXT transaction', async () => {
    const db = await open();

    const first = db.transaction(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const plain = db.execute(insert('plain'));
    const second = db
      .transaction(async (tx) => {
        await tx.execute(insert('t2'));
        throw new Error('rolls back');
      })
      .catch(() => 'rolled back');
    await Promise.all([first, second, plain]);

    // The plain write was acknowledged, so it must survive the second transaction's rollback.
    expect(await labels(db)).toEqual(['plain']);
  });

  it('🔴 an interleaving of plain writes and transactions loses no acknowledged plain write', async () => {
    const db = await open();
    const acknowledged: string[] = [];
    const calls: Promise<unknown>[] = [];

    for (let i = 0; i < 30; i += 1) {
      if (i % 5 === 0) {
        calls.push(
          db
            .transaction(async (tx) => {
              await tx.execute(insert(`t${i}`));
              await new Promise((resolve) => setTimeout(resolve, 1));
              if (i % 10 === 0) throw new Error('rolls back');
            })
            .catch(() => undefined),
        );
      } else {
        calls.push(
          db.execute(insert(`p${i}`)).then(() => acknowledged.push(`p${i}`)),
        );
      }
    }
    await Promise.all(calls);

    const stored = await labels(db);
    for (const label of acknowledged) expect(stored).toContain(label);
  });

  it('🔴 the transaction handle stops working once its transaction has ended', async () => {
    const db = await open();
    let leaked!: { execute(query: string): Promise<unknown> };

    await db.transaction(async (tx) => {
      leaked = tx;
    });

    await expect(leaked.execute(insert('late'))).rejects.toThrow(
      /transaction has ended/i,
    );
    expect(await labels(db)).toEqual([]);
  });

  it('a callback that outlives its transaction is an ordinary caller, not "inside" it', async () => {
    const db = await open();
    let late!: () => Promise<unknown>;

    await db.transaction(async (tx) => {
      await tx.execute(insert('in'));
      late = () => db.execute(insert('after'));
    });
    await late();

    expect(await labels(db)).toEqual(['after', 'in']);
  });

  it('🔴 the producer pattern: a failing event write rolls back the state change in the same transaction', async () => {
    const db = await open();
    await db.execute(insert('event-1')); // an event with this id already exists

    await expect(
      db.transaction(async (tx) => {
        await tx.execute(insert('state-1')); // the state change
        await tx.execute(insert('event-1')); // its event record: refused as a duplicate
      }),
    ).rejects.toThrow();

    expect(await labels(db)).toEqual(['event-1']);
  });

  it('🔴 define on the database is refused from inside a transaction, not waited on', async () => {
    const db = await open();

    await expect(
      db.transaction(async () => {
        await db.define(schema);
      }),
    ).rejects.toThrow(/inside a transaction/i);
  });

  it('🔴 refuses on an engine with no transaction capability, and never runs the work', async () => {
    const engine: EmbeddedDatabase = {
      define: async () => undefined,
      execute: async () => undefined,
      query: async () => ({ rows: [] }),
      persist: async () => undefined,
      close: async () => undefined,
    };
    const db = await TypeDBLiteDatabase.open({ name: 'no-txn', engine });
    let ran = false;

    await expect(
      db.transaction(async () => {
        ran = true;
      }),
    ).rejects.toThrow(/does not support transactions/i);

    expect(ran).toBe(false);
  });
});
