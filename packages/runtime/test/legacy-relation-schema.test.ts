import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode, diagnosticOf } from '../src/diagnostics.js';

/**
 * A database written before `schema_relation` existed records a relation's kind nowhere but in the
 * data: `schema_element` says `type`, and only a relation instance's `role_player` rows say more.
 * Reopening it must not read every relation as an entity, or the authoritative schema's `relation`
 * declaration is refused as a kind change before the metadata can be recreated.
 */
const SCHEMA = [
  'define',
  'entity node plays edge:source, plays edge:target;',
  'relation edge relates source, relates target;',
  'relation unused relates left, relates right;',
  'entity bystander;',
].join('\n');

const withDatabase = (run: (path: string) => void): void => {
  const directory = mkdtempSync(join(tmpdir(), 'typedblite-legacy-relation-'));
  try {
    run(join(directory, 'db.sqlite'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const codeOf = (attempt: () => void): string | undefined => {
  try {
    attempt();
  } catch (error) {
    return String(diagnosticOf(error)?.code);
  }
  return undefined;
};

const count = (path: string, sql: string): number => {
  const raw = new DatabaseSync(path);
  try {
    return (raw.prepare(sql).get() as { n: number }).n;
  } finally {
    raw.close();
  }
};

const legacyDatabase = (path: string): void => {
  const first = new TypeDBLiteInterpreter(path);
  first.define(SCHEMA);
  first.execute('insert $a isa node; $b isa node; (source: $a, target: $b) isa edge;');
  first.close();
  const raw = new DatabaseSync(path);
  raw.exec('DROP TABLE schema_relation;');
  raw.close();
};

describe('a database from before schema_relation', () => {
  it('reopens and re-defines a relation that has instances, keeping every row', () => {
    withDatabase((path) => {
      legacyDatabase(path);
      const before = [
        count(path, 'SELECT COUNT(*) AS n FROM thing'),
        count(path, 'SELECT COUNT(*) AS n FROM role_player'),
      ];
      const second = new TypeDBLiteInterpreter(path);
      try {
        assert.equal(codeOf(() => second.define(SCHEMA.replace('relation unused relates left, relates right;', ''))), undefined);
      } finally {
        second.close();
      }
      assert.deepEqual(
        [count(path, 'SELECT COUNT(*) AS n FROM thing'), count(path, 'SELECT COUNT(*) AS n FROM role_player')],
        before,
      );
      assert.equal(count(path, "SELECT COUNT(*) AS n FROM schema_relation WHERE name = 'edge'"), 1);
    });
  });

  it('keeps refusing an entity-to-relation conversion for a type with no relation instance', () => {
    withDatabase((path) => {
      legacyDatabase(path);
      const second = new TypeDBLiteInterpreter(path);
      try {
        // `bystander` has instances' worth of nothing and no role_player rows: it is an entity.
        assert.equal(codeOf(() => second.define('define relation bystander relates side;')), DiagnosticCode.kindChanged);
        // `unused` was a relation once, but nothing in the data can say so — still strict.
        assert.equal(codeOf(() => second.define(SCHEMA)), DiagnosticCode.kindChanged);
      } finally {
        second.close();
      }
    });
  });

  it('does not read a current database\'s entity with instances as a relation', () => {
    const engine = new TypeDBLiteInterpreter(':memory:');
    try {
      engine.define('define entity thing-a; entity thing-b;');
      engine.execute('insert $a isa thing-a;');
      assert.equal(codeOf(() => engine.define('define relation thing-a relates side;')), DiagnosticCode.kindChanged);
    } finally {
      engine.close();
    }
  });

  it('recovers the parent of a sub-relation whose only instances are of the subtype', () => {
    // QA probe 4 (2026-10-30): the data says only that `fat-edge` is a relation. Its parent `edge` has
    // no instance of its own, but a subtype of a relation is a relation, so `edge` must be recovered
    // too, or re-applying the same schema is refused as `edge` becoming a relation.
    const schema = [
      'define',
      'entity node plays edge:source, plays edge:target;',
      'relation edge relates source, relates target;',
      'relation fat-edge sub edge;',
    ].join('\n');
    withDatabase((path) => {
      const first = new TypeDBLiteInterpreter(path);
      first.define(schema);
      first.execute('insert $a isa node; $b isa node; (source: $a, target: $b) isa fat-edge;');
      first.close();
      const raw = new DatabaseSync(path);
      raw.exec('DROP TABLE schema_relation;');
      raw.close();

      const second = new TypeDBLiteInterpreter(path);
      try {
        assert.equal(codeOf(() => second.define(schema)), undefined);
      } finally {
        second.close();
      }
      assert.equal(count(path, "SELECT COUNT(*) AS n FROM schema_relation WHERE name IN ('edge', 'fat-edge')"), 2);
    });
  });

  it('recovers a subtype of a relation that has instances, even a subtype with no instance of its own', () => {
    // A subtype of a relation is a relation. `thin-edge` has no instance and no role_player rows, but
    // its parent `edge` does, so the data does say what `thin-edge` is; stopping at `edge` would refuse
    // `relation thin-edge sub edge` as an entity becoming a relation. A type with no relation ancestor
    // and no instance (`unused-entity` below) is still not guessed at.
    const schema = [
      'define',
      'entity node plays edge:source, plays edge:target;',
      'relation edge relates source, relates target;',
      'relation thin-edge sub edge;',
      'entity unused-entity;',
    ].join('\n');
    withDatabase((path) => {
      const first = new TypeDBLiteInterpreter(path);
      first.define(schema);
      first.execute('insert $a isa node; $b isa node; (source: $a, target: $b) isa edge;');
      first.close();
      const raw = new DatabaseSync(path);
      raw.exec('DROP TABLE schema_relation;');
      raw.close();

      const second = new TypeDBLiteInterpreter(path);
      try {
        assert.equal(codeOf(() => second.define(schema)), undefined);
        assert.equal(codeOf(() => second.define('define relation unused-entity relates side;')), DiagnosticCode.kindChanged);
      } finally {
        second.close();
      }
      assert.equal(count(path, "SELECT COUNT(*) AS n FROM schema_relation WHERE name IN ('edge', 'thin-edge')"), 2);
      assert.equal(count(path, "SELECT COUNT(*) AS n FROM schema_relation WHERE name = 'unused-entity'"), 0);
    });
  });
});
