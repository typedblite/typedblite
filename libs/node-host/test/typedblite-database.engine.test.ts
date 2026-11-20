import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isUniqueConstraintViolation,
  requiredRowString,
  rowString,
  TypeDBLiteDatabase,
} from '../src/typedblite-database.js';

/**
 * The database handle over the real engine, with no fake: in memory and on disk.
 *
 * These run in an ordinary test run with no daemon, no container and no port, which is the point of an
 * embedded engine.
 */

const SCHEMA = `
define

entity widget,
    owns widget-id @key,
    owns widget-label;

attribute widget-id, value string;
attribute widget-label, value string;
`;

describe('TypeDBLiteDatabase in memory', () => {
  let db: TypeDBLiteDatabase;

  beforeEach(async () => {
    db = await TypeDBLiteDatabase.open({ name: 'mem' });
    await db.define(SCHEMA);
  });

  afterEach(async () => {
    await db.close();
  });

  it('inserts and reads back', async () => {
    await db.execute('insert $w isa widget, has widget-id "w1", has widget-label "first";');
    const result = await db.query(
      'match $w isa widget, has widget-id $id, has widget-label $l; select $id, $l;');
    assert.equal(result.rows.length, 1);
    assert.equal(requiredRowString(result.rows[0], 'id'), 'w1');
    assert.equal(requiredRowString(result.rows[0], 'l'), 'first');
  });

  it('🔴 refuses a duplicate @key — the reason this feature exists', async () => {
    await db.execute('insert $w isa widget, has widget-id "w1", has widget-label "first";');
    // Application code cannot make this guarantee under concurrency. The database can.
    await assert.rejects(async () =>
      db.execute('insert $w isa widget, has widget-id "w1", has widget-label "second";'),
    );
  });

  it('returns no rows rather than throwing when nothing matches', async () => {
    const result = await db.query('match $w isa widget, has widget-id $id; select $id;');
    assert.equal(result.rows.length, 0);
  });
});

describe('constraint-violation detection', () => {
  it('matches a real violation, scoped to the attribute', async () => {
    const db = await TypeDBLiteDatabase.open({
      name: 'cnt',
    });
    try {
      await db.define(SCHEMA);
      await db.execute('insert $w isa widget, has widget-id "dup", has widget-label "a";');
      let caught: unknown;
      try {
        await db.execute('insert $w isa widget, has widget-id "dup", has widget-label "b";');
      } catch (error) {
        caught = error;
      }
      assert.ok(caught !== undefined);
      assert.equal(isUniqueConstraintViolation(caught, 'widget-id'), true);
      // 🔴 The scoping is the point: [CNT9] is emitted for every @key and @unique violation, so
      // an unscoped match would report an unrelated constraint as this one.
      assert.equal(isUniqueConstraintViolation(caught, 'some-other-attribute'), false);
    } finally {
      await db.close();
    }
  });

  it('does not match an unrelated failure', async () => {
    assert.equal(isUniqueConstraintViolation(new Error('[QEX8] Error analysing query.'), 'x'), false);
    assert.equal(isUniqueConstraintViolation('not an error', 'x'), false);
    assert.equal(isUniqueConstraintViolation(undefined, 'x'), false);
  });
});

describe('durability', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'typedblite-durable-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('survives close and reopen', async () => {
    const name = `durable-${Math.random().toString(36).slice(2)}`;
    const first = await TypeDBLiteDatabase.open({ name, storagePath: dir });
    await first.define(SCHEMA);
    await first.execute('insert $w isa widget, has widget-id "kept", has widget-label "value";');
    await first.persist();
    await first.close();

    // 🔴 Assert the database is genuinely on disk before reopening. Without this the test would
    // pass identically against an in-memory fallback and prove nothing about durability.
    //
    // `<name>.db`, not a snapshot: TypeDBLite writes through to SQLite as it goes, so `persist()`
    // has nothing to flush. What is proved is unchanged.
    const path = join(dir, `${name}.db`);
    assert.equal(existsSync(path), true);
    assert.ok(readFileSync(path).length > 0);

    const second = await TypeDBLiteDatabase.open({ name, storagePath: dir });
    try {
      const result = await second.query(
        'match $w isa widget, has widget-id $id, has widget-label $l; select $id, $l;');
      assert.equal(result.rows.length, 1);
      assert.equal(rowString(result.rows[0], 'l'), 'value');
    } finally {
      await second.close();
    }
  });
});
