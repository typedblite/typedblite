/**
 * The engine-level transaction: `BEGIN IMMEDIATE`, commit on success, roll back on a throw, and a savepoint for each write
 * pipeline inside it, because SQLite rejects a nested `BEGIN`.
 *
 * Each case is a claim the ADR makes. The cross-process case spawns a real child: an in-process
 * second handle would block the event loop on the first's write lock and prove nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { SqliteEngine } from '../src/sqlite-engine';

const HERE = fileURLToPath(new URL('.', import.meta.url));

const schema = `define
  entity project,
    owns project-id @key,
    owns project-name;
  attribute project-id, value string;
  attribute project-name, value string;`;

const insert = (id: string) =>
  `insert $s isa project, has project-id "${id}", has project-name "${id}";`;

const ids = async (engine: SqliteEngine): Promise<string[]> => {
  const { rows } = await engine.query('match $s isa project, has project-id $i; select $i;');
  return rows
    .map((row) => {
      const value = row['i'] as { asString?: () => string } | string;
      return typeof value === 'string' ? value : (value.asString?.() ?? String(value));
    })
    .sort();
};

const fresh = async (location?: string) => {
  const engine = new SqliteEngine(location);
  await engine.define(schema);
  return engine;
};

const tempDb = () => join(mkdtempSync(join(tmpdir(), 'typedblite-txn-')), 'store.db');

describe('SqliteEngine.transaction', () => {
  it('commits the work, and returns what the work returned', async () => {
    const engine = await fresh();

    const result = await engine.transaction(async () => {
      await engine.execute(insert('a'));
      await engine.execute(insert('b'));
      return 42;
    });

    expect(result).toBe(42);
    expect(await ids(engine)).toEqual(['a', 'b']);
  });

  it('🔴 rolls back every write when the work throws, and rethrows the same error', async () => {
    const engine = await fresh();
    const boom = new Error('boom');

    await expect(
      engine.transaction(async () => {
        await engine.execute(insert('a'));
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(await ids(engine)).toEqual([]);
  });

  it('🔴 is atomic across statements: a second statement failing leaves neither', async () => {
    const engine = await fresh();

    await expect(
      engine.transaction(async () => {
        await engine.execute(insert('a'));
        await engine.execute(insert('a'));
      }),
    ).rejects.toThrow();

    expect(await ids(engine)).toEqual([]);
  });

  it('🔴 a failing pipeline inside rolls back only itself (a savepoint, not a nested BEGIN)', async () => {
    const engine = await fresh();

    await engine.transaction(async () => {
      await engine.execute(insert('a'));
      await expect(engine.execute(insert('a'))).rejects.toThrow();
      await engine.execute(insert('b'));
    });

    expect(await ids(engine)).toEqual(['a', 'b']);
  });

  it('is visible after a reopen of the file, once committed', async () => {
    const path = tempDb();
    const first = await fresh(path);
    await first.transaction(async () => {
      await first.execute(insert('kept'));
    });
    await first.close();

    const second = new SqliteEngine(path);

    expect(await ids(second)).toEqual(['kept']);
  });

  it('records the change log only when the transaction commits', async () => {
    const engine = await fresh();

    await expect(
      engine.transaction(async () => {
        await engine.execute(insert('gone'));
        throw new Error('no');
      }),
    ).rejects.toThrow();
    expect(engine.changeLog.since(0)).toHaveLength(0);

    await engine.transaction(async () => {
      await engine.execute(insert('stays'));
    });
    expect(engine.changeLog.since(0)).toHaveLength(1);
  });

  it('runs define inside a transaction, which commits or rolls back with the writes beside it', async () => {
    // TypeDB's schema transaction: a define and the writes beside it stand or fall together. The
    // schema change is a savepoint inside the caller's transaction, not a transaction of its own.
    const engine = await fresh();

    await expect(
      engine.transaction(async () => {
        await engine.execute(insert('a'));
        await engine.define(schema);
        throw new Error('abandoned');
      }),
    ).rejects.toThrow('abandoned');
    expect(await ids(engine)).toEqual([]);

    await engine.transaction(async () => {
      await engine.define(schema);
      await engine.execute(insert('b'));
    });
    expect(await ids(engine)).toEqual(['b']);
  });

  it('🔴 reports the real error when SQLite has already ended the transaction under a failing pipeline', async () => {
    const engine = await fresh();
    const interpreter = (
      engine as unknown as {
        interpreter: { db: { exec(sql: string): void }; runInsert: (...args: unknown[]) => void };
      }
    ).interpreter;
    // As SQLITE_FULL or SQLITE_IOERR do: the engine rolls the whole transaction back, then the
    // pipeline's own error reaches the unwind, where `ROLLBACK TO` finds no savepoint.
    vi.spyOn(interpreter, 'runInsert').mockImplementation(() => {
      interpreter.db.exec('ROLLBACK');
      throw new Error('disk full');
    });

    const error = await engine
      .transaction(async () => {
        await engine.execute(insert('a'));
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect((error as Error).message).toBe('disk full');
  });

  it('🔴 a rollback-to-savepoint that fails while the transaction is alive is NOT swallowed, and nothing from the failed pipeline survives', async () => {
    const engine = await fresh();
    const interpreter = (
      engine as unknown as {
        interpreter: { db: { exec(sql: string): void }; runInsert: (...args: unknown[]) => void };
      }
    ).interpreter;
    const realExec = interpreter.db.exec.bind(interpreter.db);
    vi.spyOn(interpreter, 'runInsert').mockImplementation(() => {
      throw new Error('pipeline error');
    });
    vi.spyOn(interpreter.db, 'exec').mockImplementation((sql: string) => {
      if (sql.startsWith('ROLLBACK TO')) throw new Error('rollback-to failed');
      realExec(sql);
    });

    let seen: unknown = null;
    await engine.transaction(async () => {
      seen = await engine.execute(insert('a')).then(
        () => null,
        (caught: unknown) => caught,
      );
    });
    vi.restoreAllMocks();

    // The work is told the rollback failed, instead of "pipeline error" with the failed pipeline's
    // writes possibly still in the transaction.
    expect((seen as Error | null)?.message).toMatch(/rollback-to failed/);
    expect(await ids(engine)).toEqual([]);
  });

  it('🔴 work that carries on after the engine ended the transaction cannot write outside it', async () => {
    const engine = await fresh();
    const interpreter = (
      engine as unknown as {
        interpreter: { db: { exec(sql: string): void }; runInsert: (...args: unknown[]) => void };
      }
    ).interpreter;
    const spy = vi.spyOn(interpreter, 'runInsert').mockImplementationOnce(() => {
      interpreter.db.exec('ROLLBACK');
      throw new Error('disk full');
    });

    const error = await engine
      .transaction(async () => {
        await engine.execute(insert('a')).catch(() => undefined);
        spy.mockRestore();
        await engine.execute(insert('b'));
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect((error as Error).message).toMatch(/ended by the database/i);
    expect(await ids(engine)).toEqual([]);
  });

  it('behaves as before outside a transaction: a write commits on its own', async () => {
    const engine = await fresh();

    await engine.execute(insert('a'));

    expect(await ids(engine)).toEqual(['a']);
  });

  it('🔴 a second process waits for the write lock instead of failing at once', async () => {
    const path = tempDb();
    const engine = await fresh(path);
    await engine.close();

    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      join(HERE, 'fixtures', 'transaction-holder.ts'),
      path,
    ]);
    let stdout = '';
    const ready = new Promise<void>((resolve) =>
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
        if (stdout.includes('holding')) resolve();
      }),
    );
    const closed = new Promise<number | null>((resolve) => child.on('close', resolve));

    await ready;
    const second = new SqliteEngine(path);
    await second.execute(insert('after-the-holder'));
    expect(await closed).toBe(0);

    expect(await ids(second)).toEqual(['after-the-holder', 'held']);
  }, 30_000);
});
