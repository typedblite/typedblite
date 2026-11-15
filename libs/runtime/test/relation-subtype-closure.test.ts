import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';

/**
 * 🔴 `isa` on a relation must resolve through the subtype closure, exactly as it does on an entity.
 *
 * `candidates()` matches a type through a recursive CTE over `type_parent`, so `isa doc` also
 * matches `adr` — a documentation store depends on it. `relationBindings` filtered with an exact `t.type = ?`,
 * so naming a role list silently dropped every subtype instance: the same query answered rows
 * without `links (...)` and nothing with it, at exit code 0, and `noCandidates` did not fire
 * because the *entity* path applies the closure correctly.
 *
 * ⚠️ Latent rather than live — no shipped schema defines a relation subtype — and inherited from
 * the `findRelation` this branch replaced. Fixed here because the function was rewritten anyway,
 * and because the whole point of the rewrite was to stop relations answering nothing quietly.
 */
const SCHEMA = [
  'define',
  'attribute node-id, value string;',
  'attribute edge-id, value string;',
  'entity node, owns node-id @key, plays link:source, plays link:target;',
  'relation link, relates source, relates target, owns edge-id @key;',
  'relation strong-link sub link;',
].join('\n');

let engine: TypeDBLiteInterpreter;

beforeEach(() => {
  engine = new TypeDBLiteInterpreter(':memory:');
  engine.define(SCHEMA);
  engine.execute('insert $n isa node, has node-id "a";');
  engine.execute('insert $n isa node, has node-id "b";');
  engine.execute(
    'match $s isa node, has node-id "a"; $t isa node, has node-id "b";' +
      ' insert $l isa strong-link, links (source: $s, target: $t), has edge-id "strong";',
  );
});

describe('a relation isa resolves through its subtypes', () => {
  it('matches a subtype instance when the role list is named', () => {
    // 🔴 The comparison is the point: the same `isa link` answers the row without `links (...)`.
    const withoutRoles = engine.query('match $l isa link, has edge-id $x; select $x;');
    const withRoles = engine.query(
      'match $l isa link, links (source: $s, target: $t), has edge-id $x; select $x;',
    );

    assert.deepEqual(withoutRoles.rows.map((row) => row['x']?.asString()), ['strong']);
    assert.deepEqual(
      withRoles.rows.map((row) => row['x']?.asString()),
      ['strong'],
      'naming the roles must not narrow `isa link` to the exact type',
    );
  });

  it('matches the subtype named directly, too', () => {
    const { rows } = engine.query(
      'match $l isa strong-link, links (source: $s, target: $t), has edge-id $x; select $x;',
    );
    assert.deepEqual(rows.map((row) => row['x']?.asString()), ['strong']);
  });

  it('does not match a sibling type', () => {
    engine.define('define\nrelation weak-link sub link;');
    const { rows } = engine.query(
      'match $l isa weak-link, links (source: $s, target: $t), has edge-id $x; select $x;',
    );
    assert.equal(rows.length, 0, 'the closure runs downward, never sideways or up');
  });
});
