/**
 * Checking for FTS5 neither writes to the store nor blames FTS5 for an unrelated failure.
 *
 * 🔴 `FullTextIndex.assertAvailable` created and dropped a probe table in the MAIN database on every
 * open: a write, so every open took the write lock, and on a read-only connection the write failed
 * and was reported as "This SQLite build has no FTS5" — which sends a reader to their SQLite build
 * for a fault in their file permissions. The probe now runs in the `temp` schema, a separate
 * database that a read-only connection can still write, and only "no such module: fts5" is
 * reported as a missing FTS5.
 */
import { afterEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FullTextIndex } from '../src/full-text.js';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import type { SqliteDatabase, SqliteStatement } from '../src/sqlite-database.js';

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'typedblite-fts5-probe-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A connection whose `exec` fails with `message`: what a binding reports when the probe cannot run. */
const failing = (message: string): SqliteDatabase => ({
  exec: () => {
    throw new Error(message);
  },
  prepare: (): SqliteStatement => {
    throw new Error('not used');
  },
  close: () => {},
});

const thrown = (run: () => void): string => {
  try {
    run();
  } catch (error) {
    return String((error as Error).message);
  }
  return '(nothing thrown)';
};

// A store written through the default opener and reopened through a second, read-only `DatabaseSync`
// on the same file: a binding limit under WASM, where the store is memdb (vitest.wasm.config.ts).
// Every other test opens stores, and each open runs the probe, so WASM still exercises it.
const onFile = it.skipIf(process.env['TYPEDBLITE_SQLITE'] === 'wasm');

describe('the FTS5 availability check', () => {
  it('reports a missing FTS5 when SQLite has no such module', () => {
    const message = thrown(() => FullTextIndex.assertAvailable(failing('no such module: fts5')));
    assert.match(message, /has no FTS5/);
    assert.match(message, /no such module: fts5/);
  });

  it('🔴 does not blame FTS5 for a failure that is not about FTS5', () => {
    const message = thrown(() => FullTextIndex.assertAvailable(failing('disk I/O error')));
    assert.doesNotMatch(message, /no FTS5/, message);
    assert.match(message, /disk I\/O error/);
  });

  onFile('🔴 runs on a read-only connection, and leaves nothing behind in the store', () => {
    const dir = tempDir();
    const path = join(dir, 'store.db');
    const setup = new TypeDBLiteInterpreter(path);
    setup.define('define entity person, owns name @key; attribute name, value string;');
    setup.execute('insert $p isa person, has name "Ada";');
    setup.close();

    const readOnly = new DatabaseSync(path, { readOnly: true });
    FullTextIndex.assertAvailable(readOnly);
    const probes = readOnly.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%probe%'").all();
    readOnly.close();
    assert.deepEqual(probes, []);
  });

  onFile('🔴 lets an up-to-date store open and answer on a read-only connection', () => {
    const dir = tempDir();
    const path = join(dir, 'store.db');
    const setup = new TypeDBLiteInterpreter(path);
    setup.define('define entity person, owns name @key; attribute name, value string;');
    setup.execute('insert $p isa person, has name "Ada";');
    setup.close();
    // A copy no process has open, so nothing but this connection touches it.
    const copy = join(dir, 'copy.db');
    copyFileSync(path, copy);

    const db = new TypeDBLiteInterpreter(copy, 5000, { openDatabase: (location) => new DatabaseSync(location, { readOnly: true }) });
    assert.deepEqual(db.query('match $p isa person, has name $n; select $n;').rows.map((r) => r['n']?.asString()), ['Ada']);
    assert.equal(db.changeLog.fullText.search('Ada').length, 1);
    db.close();
  });
});
