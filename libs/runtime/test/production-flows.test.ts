import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { TypeDBLiteInterpreter, type TypeDBLiteValue } from '../src/interpreter.js';

/**
 * Whole flows lifted from the repositories, not single statements.
 *
 * The single-statement tests in `interpreter.test.ts` pass while a flow can still be broken — a
 * `put` that inserts twice, an update that leaves both old and new values, a three-role relation
 * that binds two of them. These are the sequences the repositories actually issue.
 */

const SCHEMAS = fileURLToPath(new URL('../../../test-fixtures/schemas/', import.meta.url));
const read = (name: string) => readFileSync(join(SCHEMAS, name), 'utf8');
const skillsSchema = read('tracker.schema.typeqlite');
const iamSchema = read('people.schema.typeqlite');

const value = (row: Record<string, TypeDBLiteValue>, name: string) =>
  row[name]?.asString() ?? null;

describe('people and team flows', () => {
  let db: TypeDBLiteInterpreter;
  beforeEach(() => {
    db = new TypeDBLiteInterpreter();
    db.define(iamSchema);
  });

  // `put $o isa team, has team-id "x";` — match-or-insert. Running it twice must leave ONE
  // team, or the @key would have been violated and the repository would see a spurious
  // duplicate error on an operation whose whole point is idempotence.
  it('put is idempotent', () => {
    db.execute('put $o isa team, has team-id "org-1";');
    assert.doesNotThrow(() =>
      db.execute('put $o isa team, has team-id "org-1";'),
    );
    const { rows } = db.query(
      'match $o isa team, has team-id $id;\nselect $id;',
    );
    assert.equal(rows.length, 1);
  });

  // The update shape: detach the old attribute, then insert the new one. Two separate pipelines,
  // exactly as a real repository issues them.
  it('updates an attribute by delete-then-insert, leaving one value', () => {
    db.execute(
      'insert $p isa person, has person-id "u-1", has person-kind "user";',
    );
    db.execute(
      'match $p isa person, has person-id "u-1", has person-kind $old;\ndelete $old of $p;',
    );
    db.execute(
      'match $p isa person, has person-id "u-1";\ninsert $p has person-kind "admin";',
    );
    const { rows } = db.query(
      'match $p isa person, has person-id "u-1", has person-kind $type;\nselect $type;',
    );
    assert.equal(rows.length, 1, 'exactly one person-kind must remain');
    assert.equal(value(rows[0], 'type'), 'admin');
  });

  // `links` with two roles, plus attributes on the relation itself.
  it('inserts a membership relation with links and its own attributes', () => {
    db.execute(
      'insert $p isa person, has person-id "u-1", has person-kind "user";',
    );
    db.execute('put $o isa team, has team-id "org-1";');
    db.execute(
      'match\n  $p isa person, has person-id "u-1";\n  $o isa team, has team-id "org-1";\ninsert $m isa membership, links (member: $p, team: $o), has membership-key "u-1::org-1", has role-name "owner";',
    );
    const { rows } = db.query(
      'match $m isa membership, has membership-key "u-1::org-1", has role-name $role;\nselect $role;',
    );
    assert.equal(rows.length, 1);
    assert.equal(value(rows[0], 'role'), 'owner');
  });
});

describe('task-log projection flows', () => {
  let db: TypeDBLiteInterpreter;
  beforeEach(() => {
    db = new TypeDBLiteInterpreter();
    db.define(skillsSchema);
  });

  // 🔴 a projection's idempotency: delete then insert, re-run on every
  // redelivered change. A change is redelivered whenever the process stops between `persist` and
  // the checkpoint — the SAFE side of that ordering, so this is the normal path, not the edge.
  it('delete-then-insert an iteration is idempotent across replays', () => {
    for (let replay = 0; replay < 3; replay++) {
      db.execute(
        'match $i isa iteration, has iteration-id "wf-1";\ndelete $i;',
      );
      db.execute('insert $i isa iteration, has iteration-id "wf-1";');
    }
    const { rows } = db.query(
      'match $i isa iteration, has iteration-id $id;\nselect $id;',
    );
    assert.equal(rows.length, 1, 'three replays must leave one iteration');
  });

  // The three-role relation, which nothing had exercised.
  it('inserts a three-role relation and traverses it', () => {
    db.execute('insert $i isa iteration, has iteration-id "wf-1";');
    db.execute(
      'insert $st isa task, has task-id "s-1", has ordinal 1, has task-kind "operation";',
    );
    db.execute(
      'insert $r isa log-entry, has log-key "wf-1::s-1::f", has log-field "f", has log-value "v";',
    );
    db.execute(
      'match\n  $r isa log-entry, has log-key "wf-1::s-1::f";\n  $i isa iteration, has iteration-id "wf-1";\n  $st isa task, has task-id "s-1";\ninsert (record: $r, iteration: $i, task: $st) isa task-log;',
    );
    const { rows } = db.query(
      'match\n  $i isa iteration, has iteration-id "wf-1";\n  $st isa task, has task-id "s-1";\n  $r isa log-entry, has log-key $k, has log-value $v;\n  (record: $r, iteration: $i, task: $st) isa task-log;\nselect $k, $v;',
    );
    assert.equal(rows.length, 1);
    assert.equal(value(rows[0], 'v'), 'v');
  });

  // Deleting a thing that still plays a role: TypeDB removes the relation with it. Without that,
  // the role_player foreign key refuses the delete and the replay above breaks on its second pass.
  it('deleting a thing removes the relations it played a role in', () => {
    db.execute('insert $i isa iteration, has iteration-id "wf-1";');
    db.execute(
      'insert $st isa task, has task-id "s-1", has ordinal 1, has task-kind "operation";',
    );
    db.execute(
      'insert $r isa log-entry, has log-key "k", has log-field "f", has log-value "v";',
    );
    db.execute(
      'match\n  $r isa log-entry, has log-key "k";\n  $i isa iteration, has iteration-id "wf-1";\n  $st isa task, has task-id "s-1";\ninsert (record: $r, iteration: $i, task: $st) isa task-log;',
    );
    assert.doesNotThrow(() =>
      db.execute('match $i isa iteration, has iteration-id "wf-1";\ndelete $i;'),
    );
    const { rows } = db.query(
      'match $i isa iteration, has iteration-id $id;\nselect $id;',
    );
    assert.equal(rows.length, 0);
  });

  // A match with two independently-bound variables joined by a relation must not produce a
  // cross-product — the wrong step would come back attached to the wrong project.
  it('a relation constrains which combination of bindings survives', () => {
    for (const [project, step] of [
      ['website-relaunch', 'ss-1'],
      ['content-migration', 'mvp-1'],
    ]) {
      db.execute(
        `insert $s isa project, has project-id "${project}", has project-name "n", has project-summary "d";`,
      );
      db.execute(
        `insert $st isa task, has task-id "${step}", has ordinal 1, has task-kind "operation";`,
      );
      db.execute(
        `match\n  $s isa project, has project-id "${project}";\n  $st isa task, has task-id "${step}";\ninsert (owner: $s, task: $st) isa project-task;`,
      );
    }
    const { rows } = db.query(
      'match\n  $s isa project, has project-id "website-relaunch";\n  $st isa task, has task-id $id;\n  (owner: $s, task: $st) isa project-task;\nselect $id;',
    );
    assert.equal(rows.length, 1, 'only the step composed into that project');
    assert.equal(value(rows[0], 'id'), 'ss-1');
  });
});

describe('unsupported TypeQLite throws rather than silently succeeding', () => {
  // 🔴 ADR-002 Decision 7's third layer. The Langium validator runs from the interpreter, because
  // nothing forces a caller to run it — a repository hands the interpreter a string. A validator
  // ERROR throws here. ⚠️ `@card` and `@unique` were this block's first two cases, as refusals;
  // since 2026-09-11 an unenforced annotation is applied and REPORTED instead —
  // `annotation-not-enforced.test.ts` — so the case that still throws is a reserved keyword.
  it('rejects a reserved keyword as a label, as TypeDB does with [DEX31]', () => {
    const db = new TypeDBLiteInterpreter();
    assert.throws(() => db.define('define attribute fetch, value string;'), /reserved/);
  });

  it('accepts a schema using only implemented constructs', () => {
    const db = new TypeDBLiteInterpreter();
    assert.doesNotThrow(() =>
      db.define(
        'define attribute project-id, value string; entity project, owns project-id @key;',
      ),
    );
  });
});

describe('correctness details the flows above do not reach', () => {
  it('subtypes match their supertype — a documentation store\'s `entity adr sub doc`', () => {
    const db = new TypeDBLiteInterpreter();
    db.define(
      'define attribute doc-id, value string; entity doc, owns doc-id @key; entity adr sub doc;',
    );
    db.execute('insert $a isa adr, has doc-id "adr-002";');
    const asAdr = db.query('match $a isa adr, has doc-id $id;\nselect $id;');
    const asDoc = db.query('match $d isa doc, has doc-id $id;\nselect $id;');
    assert.equal(asAdr.rows.length, 1);
    assert.equal(asDoc.rows.length, 1, '`isa doc` must also match an `adr`');
  });

  it('a variable with no value is absent, so the caller\'s required-reader can throw', () => {
    const db = new TypeDBLiteInterpreter();
    db.define(skillsSchema);
    db.execute(
      'insert $s isa project, has project-id "s", has project-name "n", has project-summary "d";',
    );
    const { rows } = db.query(
      'match $s isa project, has project-id "s", has project-name $n;\nselect $n;',
    );
    assert.equal(rows[0]['nonexistent'], undefined);
  });

  // 🔴 TypeDB's `execute` is atomic per statement. Here one TypeQL insert becomes several SQL
  // statements — the thing, then each attribute, then each role — so a @key violation on the
  // second attribute must not leave the thing row behind.
  //
  // **This assertion is indirect, and honestly so.** An attribute-less thing is invisible to every
  // TypeQLite query, because they all filter on an attribute — so no query this test could write
  // would detect the orphan it is guarding against. What actually prevents it is the transaction
  // in `execute`; this test only proves nothing VISIBLE survived. Unobservable is not harmless,
  // and a future change that drops the transaction would not be caught here.
  it('a failed insert leaves no visible partial state', () => {
    const db = new TypeDBLiteInterpreter();
    db.define(iamSchema);
    db.execute(
      'insert $p isa person, has person-id "u-1", has person-kind "user";',
    );
    assert.throws(() =>
      db.execute(
        'insert $p isa person, has person-id "u-1", has person-kind "user";',
      ),
    );
    const { rows } = db.query(
      'match $p isa person, has person-kind $t;\nselect $t;',
    );
    assert.equal(rows.length, 1, 'the failed insert must not have left a partial person');
  });
});
