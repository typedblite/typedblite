import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';

/**
 * 🔴 QA of the join-planning fix: a seeded candidate lookup (`relationSeed`) and `findRelations` both look a
 * relation up by `(player, role)`, and `role_player` only had `PRIMARY KEY (rel, role, player)`, so each lookup
 * scanned the whole table. In a query whose first variable is unconstrained and whose second is pinned, that made
 * the planned engine 1.6 to 2x SLOWER than the cartesian one. `role_player_by_player` fixes the lookup; a store
 * created before it existed gets it the next time it is opened.
 */
const SCHEMA = [
  'define',
  'attribute node-id, value string;',
  'entity node, owns node-id @key, plays link:source, plays link:target;',
  'relation link, relates source, relates target;',
].join('\n');

const indexesOf = (file: string): string[] => {
  const raw = new DatabaseSync(file);
  try {
    return (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'role_player'").all() as Array<{ name: string }>).map((row) => row.name);
  } finally {
    raw.close();
  }
};

const planOf = (file: string, sql: string, ...params: Array<string | number>): string => {
  const raw = new DatabaseSync(file);
  try {
    return (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((row) => row.detail).join(' | ');
  } finally {
    raw.close();
  }
};

describe('the role_player lookup index', () => {
  it('exists in a store created by define, and the (player, role) lookup uses it instead of scanning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tq-index-'));
    const file = join(dir, 'a.db');
    try {
      const engine = new TypeDBLiteInterpreter(file);
      engine.define(SCHEMA);
      engine.execute('insert $a isa node, has node-id "a"; $b isa node, has node-id "b"; (source: $a, target: $b) isa link;');
      assert.ok(indexesOf(file).includes('role_player_by_player'), `indexes: ${indexesOf(file).join(', ')}`);
      const plan = planOf(file, 'SELECT rel FROM role_player WHERE role = ? AND player = ?', 'source', 1);
      assert.match(plan, /USING (COVERING )?INDEX/, plan);
      assert.doesNotMatch(plan, /SCAN role_player/, plan);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is added when an existing store without it is opened, and opening twice is harmless', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tq-index-'));
    const file = join(dir, 'b.db');
    try {
      new TypeDBLiteInterpreter(file).define(SCHEMA);
      const raw = new DatabaseSync(file);
      raw.exec('DROP INDEX IF EXISTS role_player_by_player');
      raw.close();
      assert.ok(!indexesOf(file).includes('role_player_by_player'));
      new TypeDBLiteInterpreter(file);
      assert.ok(indexesOf(file).includes('role_player_by_player'));
      new TypeDBLiteInterpreter(file);
      assert.equal(indexesOf(file).filter((name) => name === 'role_player_by_player').length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not stop a database with no role_player table opening', () => {
    assert.doesNotThrow(() => new TypeDBLiteInterpreter(':memory:'));
  });
});
