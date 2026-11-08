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

const LIBS = fileURLToPath(new URL('../../../..', import.meta.url));
const read = (path: string) => readFileSync(join(LIBS, path), 'utf8');
const skillsSchema = read(
  'platform/skills/infrastructure/src/lib/skills.schema.typeqlite',
);
const iamSchema = read('platform/iam/infrastructure/src/lib/iam.schema.typeqlite');

const value = (row: Record<string, TypeDBLiteValue>, name: string) =>
  row[name]?.asString() ?? null;

describe('IAM flows', () => {
  let db: TypeDBLiteInterpreter;
  beforeEach(() => {
    db = new TypeDBLiteInterpreter();
    db.define(iamSchema);
  });

  // `put $o isa organization, has org-id "x";` — match-or-insert. Running it twice must leave ONE
  // organization, or the @key would have been violated and the repository would see a spurious
  // duplicate error on an operation whose whole point is idempotence.
  it('put is idempotent', () => {
    db.execute('put $o isa organization, has org-id "org-1";');
    assert.doesNotThrow(() =>
      db.execute('put $o isa organization, has org-id "org-1";'),
    );
    const { rows } = db.query(
      'match $o isa organization, has org-id $id;\nselect $id;',
    );
    assert.equal(rows.length, 1);
  });

  // The update shape: detach the old attribute, then insert the new one. Two separate pipelines,
  // exactly as `typedblite-principal.repository.ts` issues them.
  it('updates an attribute by delete-then-insert, leaving one value', () => {
    db.execute(
      'insert $p isa principal, has principal-id "u-1", has principal-type "user";',
    );
    db.execute(
      'match $p isa principal, has principal-id "u-1", has principal-type $old;\ndelete $old of $p;',
    );
    db.execute(
      'match $p isa principal, has principal-id "u-1";\ninsert $p has principal-type "admin";',
    );
    const { rows } = db.query(
      'match $p isa principal, has principal-id "u-1", has principal-type $type;\nselect $type;',
    );
    assert.equal(rows.length, 1, 'exactly one principal-type must remain');
    assert.equal(value(rows[0], 'type'), 'admin');
  });

  // `links` with two roles, plus attributes on the relation itself.
  it('inserts a membership relation with links and its own attributes', () => {
    db.execute(
      'insert $p isa principal, has principal-id "u-1", has principal-type "user";',
    );
    db.execute('put $o isa organization, has org-id "org-1";');
    db.execute(
      'match\n  $p isa principal, has principal-id "u-1";\n  $o isa organization, has org-id "org-1";\ninsert $m isa membership, links (member: $p, org: $o), has membership-key "u-1::org-1", has role-name "owner";',
    );
    const { rows } = db.query(
      'match $m isa membership, has membership-key "u-1::org-1", has role-name $role;\nselect $role;',
    );
    assert.equal(rows.length, 1);
    assert.equal(value(rows[0], 'role'), 'owner');
  });
});

describe('Skills projection flows', () => {
  let db: TypeDBLiteInterpreter;
  beforeEach(() => {
    db = new TypeDBLiteInterpreter();
    db.define(skillsSchema);
  });

  // 🔴 `skills-projection-target.ts`'s idempotency: delete then insert, re-run on every
  // redelivered change. A change is redelivered whenever the process stops between `persist` and
  // the checkpoint — the SAFE side of that ordering, so this is the normal path, not the edge.
  it('delete-then-insert an invocation is idempotent across replays', () => {
    for (let replay = 0; replay < 3; replay++) {
      db.execute(
        'match $i isa invocation, has workflow-id "wf-1";\ndelete $i;',
      );
      db.execute('insert $i isa invocation, has workflow-id "wf-1";');
    }
    const { rows } = db.query(
      'match $i isa invocation, has workflow-id $id;\nselect $id;',
    );
    assert.equal(rows.length, 1, 'three replays must leave one invocation');
  });

  // The three-role relation, which nothing had exercised.
  it('inserts a three-role relation and traverses it', () => {
    db.execute('insert $i isa invocation, has workflow-id "wf-1";');
    db.execute(
      'insert $st isa skill-step, has step-id "s-1", has ordinal 1, has step-kind "operation";',
    );
    db.execute(
      'insert $r isa output-record, has output-key "wf-1::s-1::f", has output-field "f", has output-value "v";',
    );
    db.execute(
      'match\n  $r isa output-record, has output-key "wf-1::s-1::f";\n  $i isa invocation, has workflow-id "wf-1";\n  $st isa skill-step, has step-id "s-1";\ninsert (record: $r, invocation: $i, step: $st) isa step-output;',
    );
    const { rows } = db.query(
      'match\n  $i isa invocation, has workflow-id "wf-1";\n  $st isa skill-step, has step-id "s-1";\n  $r isa output-record, has output-key $k, has output-value $v;\n  (record: $r, invocation: $i, step: $st) isa step-output;\nselect $k, $v;',
    );
    assert.equal(rows.length, 1);
    assert.equal(value(rows[0], 'v'), 'v');
  });

  // Deleting a thing that still plays a role: TypeDB removes the relation with it. Without that,
  // the role_player foreign key refuses the delete and the replay above breaks on its second pass.
  it('deleting a thing removes the relations it played a role in', () => {
    db.execute('insert $i isa invocation, has workflow-id "wf-1";');
    db.execute(
      'insert $st isa skill-step, has step-id "s-1", has ordinal 1, has step-kind "operation";',
    );
    db.execute(
      'insert $r isa output-record, has output-key "k", has output-field "f", has output-value "v";',
    );
    db.execute(
      'match\n  $r isa output-record, has output-key "k";\n  $i isa invocation, has workflow-id "wf-1";\n  $st isa skill-step, has step-id "s-1";\ninsert (record: $r, invocation: $i, step: $st) isa step-output;',
    );
    assert.doesNotThrow(() =>
      db.execute('match $i isa invocation, has workflow-id "wf-1";\ndelete $i;'),
    );
    const { rows } = db.query(
      'match $i isa invocation, has workflow-id $id;\nselect $id;',
    );
    assert.equal(rows.length, 0);
  });

  // A match with two independently-bound variables joined by a relation must not produce a
  // cross-product — the wrong step would come back attached to the wrong skill.
  it('a relation constrains which combination of bindings survives', () => {
    for (const [skill, step] of [
      ['start-session', 'ss-1'],
      ['start-mvp-iteration', 'mvp-1'],
    ]) {
      db.execute(
        `insert $s isa skill, has skill-id "${skill}", has skill-name "n", has skill-description "d";`,
      );
      db.execute(
        `insert $st isa skill-step, has step-id "${step}", has ordinal 1, has step-kind "operation";`,
      );
      db.execute(
        `match\n  $s isa skill, has skill-id "${skill}";\n  $st isa skill-step, has step-id "${step}";\ninsert (owner: $s, step: $st) isa skill-composition;`,
      );
    }
    const { rows } = db.query(
      'match\n  $s isa skill, has skill-id "start-session";\n  $st isa skill-step, has step-id $id;\n  (owner: $s, step: $st) isa skill-composition;\nselect $id;',
    );
    assert.equal(rows.length, 1, 'only the step composed into that skill');
    assert.equal(value(rows[0], 'id'), 'ss-1');
  });
});

describe('unsupported TypeQLite throws rather than silently succeeding', () => {
  // 🔴 ADR-018 Decision 7's third layer. The Langium validator runs from the interpreter, because
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
        'define attribute skill-id, value string; entity skill, owns skill-id @key;',
      ),
    );
  });
});

describe('correctness details the flows above do not reach', () => {
  it('subtypes match their supertype — downstream-store\'s `entity adr sub doc`', () => {
    const db = new TypeDBLiteInterpreter();
    db.define(
      'define attribute doc-id, value string; entity doc, owns doc-id @key; entity adr sub doc;',
    );
    db.execute('insert $a isa adr, has doc-id "adr-018";');
    const asAdr = db.query('match $a isa adr, has doc-id $id;\nselect $id;');
    const asDoc = db.query('match $d isa doc, has doc-id $id;\nselect $id;');
    assert.equal(asAdr.rows.length, 1);
    assert.equal(asDoc.rows.length, 1, '`isa doc` must also match an `adr`');
  });

  it('a variable with no value is absent, so the caller\'s required-reader can throw', () => {
    const db = new TypeDBLiteInterpreter();
    db.define(skillsSchema);
    db.execute(
      'insert $s isa skill, has skill-id "s", has skill-name "n", has skill-description "d";',
    );
    const { rows } = db.query(
      'match $s isa skill, has skill-id "s", has skill-name $n;\nselect $n;',
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
      'insert $p isa principal, has principal-id "u-1", has principal-type "user";',
    );
    assert.throws(() =>
      db.execute(
        'insert $p isa principal, has principal-id "u-1", has principal-type "user";',
      ),
    );
    const { rows } = db.query(
      'match $p isa principal, has principal-type $t;\nselect $t;',
    );
    assert.equal(rows.length, 1, 'the failed insert must not have left a partial principal');
  });
});
