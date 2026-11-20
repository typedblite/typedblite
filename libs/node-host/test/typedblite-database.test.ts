import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as runtime from '@typedblite/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  openSchemaDatabase,
  requiredRowNumber,
  requiredRowString,
  rowNumber,
  TypeDBLiteDatabase,
  type EmbeddedDatabase,
  type WriteOutcome,
} from '../src/typedblite-database.js';

/** One diagnostic, as the runtime types it. */
type ExecutionDiagnostic = WriteOutcome['diagnostics'][number];

describe('result row readers', () => {
  it('reads integer and double attributes and falls back when integer extraction fails', () => {
    expect(rowNumber({ value: { asInteger: () => 5 } }, 'value')).toBe(5);
    expect(
      rowNumber(
        {
          value: {
            asInteger: () => {
              throw new Error('not integer');
            },
            asDouble: () => 5.5,
          },
        },
        'value',
      ),
    ).toBe(5.5);
    expect(rowNumber({}, 'value')).toBeNull();
  });

  it('refuses required values that are absent or of the wrong kind', () => {
    expect(() => requiredRowNumber({}, 'value')).toThrow(
      /no numeric variable 'value'/,
    );
    expect(() => requiredRowString({}, 'value')).toThrow(/no variable 'value'/);
  });
});

/**
 * The adapter's `define` hands back what the engine reported, exactly as `execute` does.
 *
 * 🔴 The engine carries a fact it can only raise at construction (*"Could not enable WAL"*) to
 * the FIRST report it produces, and for a store opener that report is `define`'s: each opens
 * the store and applies its schema before anything else. Dropping that report would mean the fact
 * reaches nobody. The failure condition itself is not portably reproducible (whatever blocks the
 * PRAGMA blocks the DDL too), so the engine is a fake that reports the diagnostic the real one emits:
 * `collector.fact(...)`, which is severity 3 (Information) over the whole document, **not** a warning,
 * whatever the prose calls it.
 */
describe('TypeDBLiteDatabase.define', () => {
  const journalMode: ExecutionDiagnostic = {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    severity: 3,
    code: 'typedblite.journal-mode',
    message:
      "Could not enable WAL on '/nfs/store.db': SQLite reports journal_mode='delete'.",
    source: 'typedblite',
  };

  const engineReporting = (
    diagnostics: readonly ExecutionDiagnostic[],
  ): EmbeddedDatabase => ({
    define: async () => ({ diagnostics }),
    execute: async () => ({ diagnostics: [] }),
    query: async () => ({ rows: [] }),
    persist: async () => undefined,
    close: async () => undefined,
  });

  it("returns the engine's report, so the first-report journal-mode fact reaches the caller", async () => {
    const database = await TypeDBLiteDatabase.open({
      name: 'probe',
      engine: engineReporting([journalMode]),
    });

    const outcome = await database.define('define entity thing;');

    expect(outcome).toEqual({ diagnostics: [journalMode] });
  });

  it('answers an empty diagnostics list, never undefined, for an engine that reports nothing', async () => {
    const silent: EmbeddedDatabase = {
      ...engineReporting([]),
      define: async () => undefined,
    };
    const database = await TypeDBLiteDatabase.open({
      name: 'probe',
      engine: silent,
    });

    expect(await database.define('define entity thing;')).toEqual({
      diagnostics: [],
    });
  });
});

/**
 * The shared opener a store opener delegates to: a caller reads `report` off the return value,
 * rather than each opener applying the schema and throwing the outcome away itself.
 */
describe('openSchemaDatabase', () => {
  const fakeEngine = (
    diagnostics: readonly ExecutionDiagnostic[],
  ): EmbeddedDatabase => ({
    define: async () => ({ diagnostics }),
    execute: async () => ({ diagnostics: [] }),
    query: async () => ({ rows: [] }),
    persist: async () => undefined,
    close: async () => undefined,
  });

  it('applies the schema and returns its report alongside the database', async () => {
    const journalMode: ExecutionDiagnostic = {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
      severity: 3,
      code: 'typedblite.journal-mode',
      message:
        "Could not enable WAL on '/nfs/store.db': SQLite reports journal_mode='delete'.",
      source: 'typedblite',
    };

    const { database, report } = await openSchemaDatabase(
      { name: 'probe', engine: fakeEngine([journalMode]) },
      'define entity thing;',
    );

    expect(report).toEqual({ diagnostics: [journalMode] });
    expect(database).toBeInstanceOf(TypeDBLiteDatabase);
  });

  it('creates a missing storagePath when ensureDirectory is set', async () => {
    const root = mkdtempSync(join(tmpdir(), 'node-host-open-schema-database-'));
    const storagePath = join(root, 'nested', 'store');
    try {
      expect(existsSync(storagePath)).toBe(false);

      await openSchemaDatabase(
        {
          name: 'probe',
          storagePath,
          engine: fakeEngine([]),
          ensureDirectory: true,
        },
        'define entity thing;',
      );

      expect(existsSync(storagePath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never creates storagePath when ensureDirectory is omitted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'node-host-open-schema-database-'));
    const storagePath = join(root, 'nested', 'store');
    try {
      await openSchemaDatabase(
        { name: 'probe', storagePath, engine: fakeEngine([]) },
        'define entity thing;',
      );

      expect(existsSync(storagePath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('openSchemaDatabase when the schema is refused', () => {
  afterEach(() => vi.restoreAllMocks());

  it('closes an engine it created before rethrowing, so a failed open leaks no connection', async () => {
    const close = vi.spyOn(runtime.SqliteEngine.prototype, 'close');

    await expect(openSchemaDatabase({ name: 'bad' }, 'define this is not typeqlite;')).rejects.toThrow();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('still reports the schema error when closing the engine it created fails too', async () => {
    const close = vi.spyOn(runtime.SqliteEngine.prototype, 'close').mockRejectedValue(new Error('close failed'));

    const failure = await openSchemaDatabase({ name: 'bad' }, 'define this is not typeqlite;').catch(
      (error: unknown) => error,
    );

    expect(close).toHaveBeenCalledTimes(1);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toMatch(/close failed/);
  });

  it("leaves an engine the caller passed in open, because it is the caller's to retry with", async () => {
    const refusal = new Error('schema refused');
    let closed = 0;
    const engine: EmbeddedDatabase = {
      define: async () => {
        throw refusal;
      },
      execute: async () => ({ diagnostics: [] }),
      query: async () => ({ rows: [] }),
      persist: async () => undefined,
      close: async () => {
        closed += 1;
      },
    };

    await expect(openSchemaDatabase({ name: 'bad', engine }, 'define nonsense;')).rejects.toBe(refusal);

    expect(closed).toBe(0);
  });

  it('lets a caller retry on the real engine it passed in, after a refused schema', async () => {
    const engine = new runtime.SqliteEngine(':memory:');

    await expect(openSchemaDatabase({ name: 'kept', engine }, 'define this is not typeqlite;')).rejects.toThrow();
    const { database } = await openSchemaDatabase(
      { name: 'kept', engine },
      'define attribute code, value string; entity item, owns code @key;',
    );
    await database.execute('insert $i isa item, has code "after-retry";');
    const { rows } = await database.query('match $i isa item, has code $c; select $c;');

    expect(requiredRowString(rows[0], 'c')).toBe('after-retry');
    await database.close();
  });
});
