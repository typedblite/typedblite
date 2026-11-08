import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';

/**
 * 🔴 Two role slots in one pattern must be satisfied by two *different* edges.
 *
 * `links (source: $x, source: $y)` asks for a link with two sources. Both joins were free to match
 * the same `role_player` row, so a link with a single source answered it with `$x` and `$y` bound
 * to that one player — a false positive, and the mirror of the repeated-*variable* case
 * `seenAtRole` already handles.
 *
 * ⚠️ Distinct **players**, and that is not a choice: `PRIMARY KEY (rel, role, player)` makes an
 * edge unique per player, so a thing cannot play one role twice in one relation — it is
 * unrepresentable, not merely excluded. An earlier version of this header claimed the rule was
 * distinct *edges* and that `$x === $y` was a legitimate answer; both are false against that key.
 *
 * ⚠️ Two slots naming the **same variable** are a different case and carry no inequality at all.
 * `constraintsOf` merges roles by variable across patterns, so restating a role list arrives here
 * as two identical slots — a redundant restatement, not a demand for two players.
 */
const SCHEMA = [
  'define',
  'attribute node-id, value string;',
  'attribute edge-id, value string;',
  'entity node, owns node-id @key, plays link:source, plays link:target;',
  'relation link, relates source, relates target, owns edge-id @key;',
].join('\n');

let engine: TypeDBLiteInterpreter;

beforeEach(() => {
  engine = new TypeDBLiteInterpreter(':memory:');
  engine.define(SCHEMA);
  engine.execute('insert $n isa node, has node-id "a";');
  engine.execute('insert $n isa node, has node-id "b";');
  engine.execute(
    'match $s isa node, has node-id "a"; $t isa node, has node-id "b";' +
      ' insert $l isa link, links (source: $s, target: $t), has edge-id "e";',
  );
});

describe('a repeated role name needs two players', () => {
  it('does not satisfy both slots from one edge', () => {
    const { rows } = engine.query(
      'match $l isa link, links (source: $x, source: $y), has edge-id $id;' +
        ' $x has node-id $xid; select $id, $xid;',
    );
    assert.equal(rows.length, 0, 'the stored link has exactly one source');
  });

  // 🔴 The guard that stops the fix becoming a blanket refusal. Written as ONE insert because
  // `insert $l links (source: $b);` against an existing relation writes nothing and reports
  // success — d-20260910-adding-a-role-player-to-an-existing-relation.
  it('answers when the relation really does have two players in that role', () => {
    engine.execute('insert $n isa node, has node-id "c";');
    engine.execute(
      'match $a isa node, has node-id "a"; $b isa node, has node-id "b";' +
        ' $c isa node, has node-id "c";' +
        ' insert $l isa link, links (source: $a, source: $b, target: $c), has edge-id "two";',
    );
    const { rows } = engine.query(
      'match $l isa link, links (source: $x, source: $y), has edge-id $id; select $id;',
    );
    // 🔴 Exactly two rows: the two orderings of the two sources, ($a,$b) and ($b,$a). Asserting
    // `length > 0` would pass on one row and on ten, which is the shape-not-content trap.
    assert.deepEqual(
      rows.map((row) => row['id']?.asString()),
      ['two', 'two'],
    );
  });

  // 🔴 Inequality is not transitive, so chaining each slot to the previous one only is not enough:
  // `$z <> $y` and `$y <> $x` still permits `$x === $z`. A two-source link answered a three-source
  // pattern until every earlier slot was compared.
  it('needs three players for three slots, not two', () => {
    engine.execute('insert $n isa node, has node-id "c";');
    engine.execute(
      'match $a isa node, has node-id "a"; $b isa node, has node-id "b";' +
        ' $c isa node, has node-id "c";' +
        ' insert $l isa link, links (source: $a, source: $b, target: $c), has edge-id "two";',
    );
    const { rows } = engine.query(
      'match $l isa link, links (source: $x, source: $y, source: $z), has edge-id $id; select $id;',
    );
    assert.equal(rows.length, 0, 'only two sources exist, so three distinct slots cannot be filled');
  });

  // ⚠️ `constraintsOf` merges roles by variable ACROSS patterns, so restating a role list arrives
  // as two identical slots. Constraining those to differ made a redundant restatement
  // unsatisfiable, where the single-pattern equivalent answers.
  it('treats a restated role list as redundant, not contradictory', () => {
    const single = engine.query(
      'match $l isa link, links (source: $s), has edge-id $x; select $x;',
    );
    const restated = engine.query(
      'match $l isa link, links (source: $s); $l links (source: $s), has edge-id $x; select $x;',
    );
    assert.deepEqual(single.rows.map((r) => r['x']?.asString()), ['e']);
    assert.deepEqual(
      restated.rows.map((r) => r['x']?.asString()),
      ['e'],
      'saying the same thing twice must not make it unsatisfiable',
    );
  });

  // 🔴 The rule must not reach across merged statements. `constraintsOf` merges roles by variable
  // over every pattern, so two statements each naming ONE source arrive indistinguishable from one
  // statement asking for two — and requiring them to differ rejected a query TypeQLite answers.
  // Silently, because `candidates()` ignores `roles`, so no `noCandidates` fact fires either.
  it('does not demand two players when two statements each name one', () => {
    const single = engine.query(
      'match $l isa link, links (source: $x), has edge-id $id; select $id;',
    );
    const split = engine.query(
      'match $l isa link, links (source: $x); $l links (source: $y), has edge-id $id;' +
        ' $x has node-id $xid; select $id;',
    );
    assert.deepEqual(single.rows.map((r) => r['id']?.asString()), ['e']);
    assert.deepEqual(
      split.rows.map((r) => r['id']?.asString()),
      ['e'],
      'one source satisfies both statements; only one links list can demand two',
    );
  });

  // 🔴 One PATTERN can carry two role lists, and they are one statement. `$l isa link (source: $x),
  // links (source: $y)` got two ids while the id was minted per `rolesOf` call, so both slots
  // escaped the rule and `$x` and `$y` bound to the same player — the false positive the rule
  // exists to close, reintroduced through the fix for its opposite.
  it('applies within one pattern however its role lists are written', () => {
    const inOneList = engine.query(
      'match $l isa link, links (source: $x, source: $y), has edge-id $id; select $id;',
    );
    const acrossTwoLists = engine.query(
      'match $l isa link (source: $x), links (source: $y), has edge-id $id; select $id;',
    );
    assert.equal(inOneList.rows.length, 0, 'the stored link has one source');
    assert.equal(
      acrossTwoLists.rows.length,
      0,
      'splitting the same pattern across two role lists must not change the answer',
    );
  });

  it('still matches distinct roles from distinct edges', () => {
    const { rows } = engine.query(
      'match $l isa link, links (source: $s, target: $t), has edge-id $id; select $id;',
    );
    assert.deepEqual(rows.map((row) => row['id']?.asString()), ['e']);
  });
});
