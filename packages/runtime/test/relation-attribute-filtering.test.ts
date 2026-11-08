import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';

/**
 * 🔴 An attribute constraint on a **relation** must filter it, exactly as it does on an entity.
 *
 * `combinations()` splits constraints into `things` (no roles) and `relations` (roles), and only
 * `things` are passed to `candidates()` — which is the sole place `literals` and `bindings` become
 * SQL. So `has edge-id "absent"` on a relation was parsed, carried, and never applied: the match
 * answered the link anyway.
 *
 * ⚠️ **It was masked by the role-player defect** (d-20260910-a-relation-match-whose-role-players-2)
 * and surfaced the moment that was fixed. Before, the natural query answered nothing for the wrong
 * reason, so a literal that changed nothing looked like it was working.
 */
const SCHEMA = [
  'define',
  'attribute node-id, value string;',
  'attribute edge-id, value string;',
  'attribute weight, value string;',
  'entity node, owns node-id @key, plays link:source, plays link:target;',
  'relation link, relates source, relates target, owns edge-id @key, owns weight;',
].join('\n');

let engine: TypeDBLiteInterpreter;

beforeEach(() => {
  engine = new TypeDBLiteInterpreter(':memory:');
  engine.define(SCHEMA);
  engine.execute('insert $n isa node, has node-id "a";');
  engine.execute('insert $n isa node, has node-id "b";');
  engine.execute(
    'match $s isa node, has node-id "a"; $t isa node, has node-id "b";' +
      ' insert $l isa link, links (source: $s, target: $t), has edge-id "e", has weight "heavy";',
  );
});

describe('an attribute constraint on a relation filters it', () => {
  it('excludes a relation whose literal does not match', () => {
    const { rows } = engine.query(
      'match $s isa node, has node-id $sid; $t isa node;' +
        ' $l isa link, links (source: $s, target: $t), has edge-id "absent"; select $sid;',
    );
    assert.equal(rows.length, 0, 'the literal names an edge-id no link holds');
  });

  it('keeps a relation whose literal does match', () => {
    const { rows } = engine.query(
      'match $s isa node, has node-id $sid; $t isa node;' +
        ' $l isa link, links (source: $s, target: $t), has edge-id "e"; select $sid;',
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.['sid']?.asString(), 'a');
  });

  it('requires a relation to own an attribute it binds', () => {
    // A binding is an ownership requirement, not a value test — the same rule `candidates()`
    // applies to an entity.
    engine.execute(
      'match $s isa node, has node-id "b"; $t isa node, has node-id "a";' +
        ' insert $l isa link, links (source: $s, target: $t), has edge-id "bare";',
    );
    const { rows } = engine.query(
      'match $l isa link, links (source: $s, target: $t), has weight $w, has edge-id $x; select $x;',
    );
    assert.deepEqual(
      rows.map((row) => row['x']?.asString()),
      ['e'],
      'only the link that owns a weight qualifies',
    );
  });

  it('applies two literals conjunctively', () => {
    const { rows } = engine.query(
      'match $l isa link, links (source: $s, target: $t), has edge-id "e", has weight "light";' +
        ' $s has node-id $sid; select $sid;',
    );
    assert.equal(rows.length, 0, 'the edge-id matches but the weight does not');
  });
});
