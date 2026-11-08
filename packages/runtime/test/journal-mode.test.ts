import { afterEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';

/**
 * Read the journal mode through a SEPARATE connection.
 *
 * 🔴 Deliberately not `engine.db` — that field is `private`, and this project has no `typecheck`
 * target to notice a test reaching past it. It is also the weaker assertion: WAL is a property of
 * the database FILE, so observing it from another connection is what actually proves it, and is
 * exactly how a second process would see it.
 */
const journalModeOf = (path: string): string => {
  const db = new DatabaseSync(path);
  try {
    const rows = db.prepare('PRAGMA journal_mode').all() as Array<{
      journal_mode: string;
    }>;
    return String(rows[0]?.journal_mode ?? '').toLowerCase();
  } finally {
    db.close();
  }
};

/**
 * 🔴 WAL is only real on a file-backed database, and only the file-backed suites exercise it.
 *
 * `:memory:` cannot do WAL — SQLite reports `memory` and carries on — so every `:memory:` test runs
 * under the default rollback journal however this is configured. A green routine suite therefore
 * says nothing about the journal mode, which is the same discipline the CouchDB oracles carry.
 * These assertions read the PRAGMA and the files on disk rather than trusting the setup.
 */
const SCHEMA = [
  'define',
  'attribute node-id, value string;',
  'entity node, owns node-id @key;',
].join('\n');

let directory: string | undefined;

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

const store = (): string => {
  directory = mkdtempSync(join(tmpdir(), 'typedblite-wal-'));
  return join(directory, 'store.db');
};

describe('journal mode', () => {
  it('puts a file-backed database into WAL', () => {
    const path = store();
    const engine = new TypeDBLiteInterpreter(path);
    engine.define(SCHEMA);
    engine.close();
    assert.equal(journalModeOf(path), 'wal');
  });

  // 🔴 WAL is a property of the FILE, not the connection. If it were per-connection, every process
  // would have to set it and one that forgot would quietly contend — which is the failure this
  // exists to prevent, and is invisible from inside the process that did set it.
  it('persists across reopening, without being set again', () => {
    const path = store();
    const first = new TypeDBLiteInterpreter(path);
    first.define(SCHEMA);
    first.execute('insert $n isa node, has node-id "a";');
    first.close();

    const second = new TypeDBLiteInterpreter(path);
    const rows = second.query('match $n isa node, has node-id $id; select $id;').rows;
    second.close();

    assert.equal(journalModeOf(path), 'wal');
    assert.deepEqual(rows.map((row) => row['id']?.asString()), ['a']);
  });

  it('writes the -wal sidecar SQLite needs', () => {
    const path = store();
    const engine = new TypeDBLiteInterpreter(path);
    engine.define(SCHEMA);
    engine.execute('insert $n isa node, has node-id "a";');
    const present = existsSync(`${path}-wal`);
    engine.close();
    assert.ok(present, 'a WAL database writes alongside the main file, not into it');
  });

  // ⚠️ `:memory:` reports `memory` and that is correct, not a failure — asserted so nobody
  // "fixes" it into an error and breaks every in-memory test.
  // 🔴 A warning written in the CONSTRUCTOR must survive to a report somebody reads. `define`,
  // `execute` and `query` each replace the diagnostic collector, so the first version of this
  // warning was discarded before anything could see it — a guard that looked active and was not.
  // `freshDiagnostics` carries it forward exactly once.
  //
  // ⚠️ **The failing half is not portably reproducible, and this test does not pretend to cover
  // it.** Every condition that stops `PRAGMA journal_mode = WAL` — a reader holding the database,
  // a filesystem that cannot host the `-shm` file — also stops `ChangeLog.ensureSchema`'s DDL two
  // lines later, so the constructor never reaches the report. Attempting it with a held read
  // transaction fails in `ensureSchema`, not in `applyJournalMode`.
  //
  // What IS testable is the realistic failure: warning when WAL actually worked. A false positive
  // here would appear on every report from every store, and that is what this asserts against.
  it('says nothing about the journal when WAL was enabled', () => {
    const path = store();
    const engine = new TypeDBLiteInterpreter(path);
    const defined = engine.define(SCHEMA);
    const written = engine.execute('insert $n isa node, has node-id "a";');
    const read = engine.query('match $n isa node, has node-id $id; select $id;');
    engine.close();

    assert.equal(journalModeOf(path), 'wal');
    for (const [name, diagnostics] of [
      ['define', defined.diagnostics],
      ['execute', written.diagnostics],
      ['query', read.diagnostics],
    ] as const) {
      assert.equal(
        diagnostics.filter((d) => d.code === 'typedblite.journal-mode').length,
        0,
        `${name} must not warn about a journal mode that was applied`,
      );
    }
  });

  it('leaves an in-memory database alone', () => {
    // Nothing to read from a second connection — an in-memory database is not shared — so this one
    // asserts the outcome that matters: it opens, it works, and it is not treated as a failure.
    const engine = new TypeDBLiteInterpreter(':memory:');
    engine.define(SCHEMA);
    const report = engine.execute('insert $n isa node, has node-id "a";');
    const rows = engine.query('match $n isa node, has node-id $id; select $id;').rows;
    engine.close();
    assert.deepEqual(rows.map((row) => row['id']?.asString()), ['a']);
    assert.ok(
      !report.diagnostics.some((d) => d.code === 'typedblite.journal-mode'),
      'reporting a journal-mode problem for :memory: would be noise on every in-memory test',
    );
  });
});

/**
 * 🔴 The property WAL was added for, demonstrated rather than assumed.
 *
 * ⚠️ **The durability suite does not show this.** Its concurrent writers pass with WAL and without
 * it — WAL does not make writes parallel, SQLite still permits one writer at a time.
 *
 * ⚠️ **And the obvious test does not show it either.** "Read while a write is open" succeeds under
 * BOTH modes: a rollback-journal writer holds only RESERVED while it inserts, and readers are
 * admitted until it commits. That version was written first and its control passed, which is the
 * only reason this one exists.
 *
 * The real asymmetry is the reverse. A rollback-journal writer must take EXCLUSIVE **to commit**,
 * and an open reader denies it — so the WRITER fails. Under WAL it appends instead, and the reader
 * keeps its snapshot. Both modes are driven through identical steps, so the mode is the variable.
 */
describe('what WAL actually buys', () => {
  const commitDuringOpenRead = (path: string): 'committed' | string => {
    const reader = new DatabaseSync(path);
    const writer = new DatabaseSync(path);
    // Without this the writer waits for the reader instead of reporting the contention, which is
    // the distinction being measured.
    writer.exec('PRAGMA busy_timeout = 0');
    try {
      reader.exec('BEGIN');
      reader.prepare('SELECT count(*) AS n FROM thing').all();
      try {
        writer.exec('BEGIN IMMEDIATE');
        writer.exec("INSERT INTO thing(type) VALUES ('node')");
        writer.exec('COMMIT');
        return 'committed';
      } catch (error) {
        try {
          writer.exec('ROLLBACK');
        } catch {
          // The failed commit already ended the transaction.
        }
        return (error as { errstr?: string }).errstr ?? (error as Error).message;
      } finally {
        reader.exec('ROLLBACK');
      }
    } finally {
      reader.close();
      writer.close();
    }
  };

  it('lets a writer commit while a reader is open, where the rollback journal does not', () => {
    const path = store();
    const engine = new TypeDBLiteInterpreter(path);
    engine.define(SCHEMA);
    engine.close();

    assert.equal(journalModeOf(path), 'wal');
    assert.equal(
      commitDuringOpenRead(path),
      'committed',
      'under WAL a writer appends and the reader keeps its snapshot',
    );

    // The same database, the same steps, WAL turned off — the control that makes the assertion
    // above mean anything. Without it this test passes whether or not WAL is enabled at all.
    const off = new DatabaseSync(path);
    off.exec('PRAGMA journal_mode = DELETE');
    off.close();

    assert.equal(journalModeOf(path), 'delete');
    assert.notEqual(
      commitDuringOpenRead(path),
      'committed',
      'without WAL the open reader denies the writer its EXCLUSIVE lock',
    );
  });
});
