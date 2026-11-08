import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';

/**
 * 🔴 A relation's role players must be **bound by the relation**, not required to exist already.
 *
 * `combinations()` seeds its cartesian product from constraints with no roles, so a variable named
 * only inside `links (...)` never enters it — and `findRelation` then reads
 * `combination[$s] ?? -1`, which matches nothing. The query answers **zero rows at exit code 0**,
 * with no diagnostic, against a store that holds the relation.
 *
 * ⚠️ **The workaround hid it.** Every existing repository query gives each player its own `isa`
 * pattern, which puts it in `things` and makes the match work — so the whole suite was green while
 * the natural form of the query returned nothing. Reading a relation to discover who plays its
 * roles is the *normal* case, and it was the broken one.
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

describe('a relation binds its role players', () => {
  it('answers when the players carry no isa pattern of their own', () => {
    const { rows } = engine.query(
      'match $l isa link, links (source: $s, target: $t), has edge-id $x; select $x;',
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.['x']?.asString(), 'e');
  });

  it('projects an attribute of a player the relation bound', () => {
    // 🔴 The case the whole fix is for: read the relation to discover WHO plays a role. Requiring
    // an `isa` for `$s` first means you must already know what you are asking.
    const { rows } = engine.query(
      'match $l isa link, links (source: $s, target: $t), has edge-id "e"; $s has node-id $sid; select $sid;',
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.['sid']?.asString(), 'a');
  });

  it('still answers when the players DO carry their own isa — the shape every repository uses', () => {
    const { rows } = engine.query(
      'match $s isa node; $t isa node; $l isa link, links (source: $s, target: $t), has edge-id $x; select $x;',
    );
    assert.equal(rows.length, 1);
  });

  it('still refuses a link that is not there, rather than inventing one', () => {
    // 🔴 The opposite failure. Binding players from the relation must not make every relation
    // match — an absent edge must still answer nothing.
    const { rows } = engine.query(
      'match $l isa link, links (source: $s, target: $t), has edge-id "absent";' +
        ' $s has node-id $sid; select $sid;',
    );
    assert.equal(rows.length, 0);
  });

  // 🔴 One variable in two roles must join to ITSELF, not be bound twice with the last winning.
  // A false positive is worse than the zero-row class this file exists to close: a caller acting
  // on the row acts on a relation that does not hold.
  it('requires a variable playing two roles to be the same thing in both', () => {
    const { rows } = engine.query(
      'match $l isa link, links (source: $x, target: $x), has edge-id $id; select $id;',
    );
    assert.equal(rows.length, 0, 'the stored link runs a->b, so nothing is its own source and target');
  });

  it('answers when a thing really does play both roles', () => {
    engine.execute(
      'match $s isa node, has node-id "a";' +
        ' insert $l isa link, links (source: $s, target: $s), has edge-id "self";',
    );
    const { rows } = engine.query(
      'match $l isa link, links (source: $x, target: $x), has edge-id $id; select $id;',
    );
    assert.deepEqual(rows.map((row) => row['id']?.asString()), ['self']);
  });

  it('binds a partially-constrained relation from the constrained end', () => {
    engine.execute('insert $n isa node, has node-id "c";');
    engine.execute(
      'match $s isa node, has node-id "a"; $t isa node, has node-id "c";' +
        ' insert $l isa link, links (source: $s, target: $t), has edge-id "e2";',
    );
    // `$s` is pinned to "a", `$t` is free — two links qualify, so two rows.
    const { rows } = engine.query(
      'match $s isa node, has node-id "a"; $l isa link, links (source: $s, target: $t), has edge-id $x; select $x;',
    );
    assert.deepEqual(
      rows.map((row) => row['x']?.asString()).sort(),
      ['e', 'e2'],
    );
  });
});
