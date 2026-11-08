import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode } from '../src/diagnostics.js';

/**
 * 🔴 Owning a value twice is one ownership, not two.
 *
 * TypeQLite quantifies a write over its match, and a match can legitimately answer N times for one
 * owner: `match $s …; $l isa link, links (source: $s, target: $t); insert $s has tag "T";` answers
 * once per link. Before relations bound their role players a named relation collapsed to a single
 * answer, so this never showed — the extra answers are **correct**, and inserting per answer wrote
 * `tag "T"` twice and read it back twice.
 *
 * ⚠️ `attr` carries no unique constraint on `(owner, type, value)`, so nothing in the store catches
 * it. This is the same family as the two 2026-09-05 defects from the other side: what
 * `combinations()` returns decides how many times a write runs.
 */
const SCHEMA = [
  'define',
  'attribute node-id, value string;',
  'attribute edge-id, value string;',
  'attribute tag, value string;',
  'entity node, owns node-id @key, owns tag, plays link:source, plays link:target;',
  'relation link, relates source, relates target, owns edge-id @key;',
].join('\n');

let engine: TypeDBLiteInterpreter;

beforeEach(() => {
  engine = new TypeDBLiteInterpreter(':memory:');
  engine.define(SCHEMA);
  engine.execute('insert $n isa node, has node-id "a";');
  engine.execute('insert $n isa node, has node-id "b";');
  for (const id of ['e1', 'e2']) {
    engine.execute(
      'match $s isa node, has node-id "a"; $t isa node, has node-id "b";' +
        ` insert $l isa link, links (source: $s, target: $t), has edge-id "${id}";`,
    );
  }
});

const tags = (): string[] =>
  engine
    .query('match $s isa node, has tag $t; select $t;')
    .rows.map((row) => row['t']?.asString() ?? '');

describe('attribute ownership is a set', () => {
  it('writes one ownership when the match answers twice for one owner', () => {
    const report = engine.execute(
      'match $s isa node, has node-id "a"; $t isa node, has node-id "b";' +
        ' $l isa link, links (source: $s, target: $t); insert $s has tag "T";',
    );

    const wrote = report.diagnostics.find((d) => d.code === DiagnosticCode.wrote);
    assert.ok(wrote);
    assert.match(wrote.message, /1 attribute\(s\)/, 'two links, one tag');
    assert.deepEqual(tags(), ['T']);
  });

  it('is idempotent across separate statements too', () => {
    engine.execute('match $s isa node, has node-id "a"; insert $s has tag "T";');
    engine.execute('match $s isa node, has node-id "a"; insert $s has tag "T";');
    assert.deepEqual(tags(), ['T']);
  });

  // 🔴 A write that changed nothing must LOG nothing. `touched` drives `changeLog.recordWrite`,
  // so marking the owner before the dedupe made a fully-deduped insert append a replicated
  // revision for an unchanged entity — and re-run the deferred-edge pass and FTS reindex with it.
  it('does not append a change-log revision when nothing changed', () => {
    engine.execute('match $s isa node, has node-id "a"; insert $s has tag "T";');
    const winner = engine.changeLog.winnerOf('node/a');
    assert.ok(winner);

    engine.execute('match $s isa node, has node-id "a"; insert $s has tag "T";');
    assert.equal(
      engine.changeLog.winnerOf('node/a')?.rev,
      winner.rev,
      're-inserting the same value must leave the revision untouched',
    );
  });

  // 🔴 The guard. Two DIFFERENT values of one attribute are two ownerships — a Skill step owning
  // two `output-field`s is the live case, and collapsing those would lose data.
  it('still keeps two different values of the same attribute', () => {
    engine.execute('match $s isa node, has node-id "a"; insert $s has tag "T";');
    engine.execute('match $s isa node, has node-id "a"; insert $s has tag "U";');
    assert.deepEqual(tags().sort(), ['T', 'U']);
  });
});
