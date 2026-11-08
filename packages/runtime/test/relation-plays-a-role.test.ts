import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';

/**
 * 🔴 A relation variable already bound by an outer pattern must constrain the inner match.
 *
 * `relationBindings` joins `role_player` and reads `t.iid` out of it; if the relation's own
 * variable is already in the combination it must pin `t.iid` to it, or the second pattern matches
 * a *different* relation of the same type and then overwrites the binding with it.
 *
 * ⚠️ No schema shipped in this repository has a relation playing a role, so nothing exercises this
 * — but binding free players is exactly what makes it reachable, and the engine schema for the
 * PouchDB migration relates a workflow to its steps and those steps to their payload entries.
 */
const SCHEMA = [
  'define',
  'attribute node-id, value string;',
  'attribute edge-id, value string;',
  'attribute note, value string;',
  'entity node, owns node-id @key, plays link:source, plays link:target;',
  'relation link, relates source, relates target, owns edge-id @key, plays annotation:subject;',
  'entity remark, owns note @key, plays annotation:author;',
  'relation annotation, relates subject, relates author;',
].join('\n');

let engine: TypeDBLiteInterpreter;

beforeEach(() => {
  engine = new TypeDBLiteInterpreter(':memory:');
  engine.define(SCHEMA);
  engine.execute('insert $n isa node, has node-id "a";');
  engine.execute('insert $n isa node, has node-id "b";');
  engine.execute('insert $r isa remark, has note "reviewed";');
  engine.execute(
    'match $s isa node, has node-id "a"; $t isa node, has node-id "b";' +
      ' insert $l isa link, links (source: $s, target: $t), has edge-id "annotated";',
  );
  engine.execute(
    'match $s isa node, has node-id "b"; $t isa node, has node-id "a";' +
      ' insert $l isa link, links (source: $s, target: $t), has edge-id "bare";',
  );
  engine.execute(
    'match $l isa link, has edge-id "annotated"; $r isa remark, has note "reviewed";' +
      ' insert $a isa annotation, links (subject: $l, author: $r);',
  );
});

describe('a relation that plays a role', () => {
  it('constrains the link when the annotation is what bound it', () => {
    // Ordering is the whole case. `$a` is processed first and binds `$l` as its subject; `$l`'s
    // own relation pattern is processed second, and must be pinned to the link already bound —
    // not re-query every link and overwrite it with the last one found.
    const { rows } = engine.query(
      'match $a isa annotation, links (subject: $l, author: $r);' +
        ' $l isa link, links (source: $s, target: $t), has edge-id $x; select $x;',
    );
    assert.deepEqual(
      rows.map((row) => row['x']?.asString()),
      ['annotated'],
      'only the annotated link is a subject; the bare one must not come back',
    );
  });

  it('still works in the other order, where the link is bound as a player', () => {
    const { rows } = engine.query(
      'match $l isa link, has edge-id $x;' +
        ' $a isa annotation, links (subject: $l, author: $r); select $x;',
    );
    assert.deepEqual(rows.map((row) => row['x']?.asString()), ['annotated']);
  });
});
