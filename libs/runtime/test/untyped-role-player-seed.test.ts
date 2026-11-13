/**
 * A relation path through a role player with no type of its own is seeded, not enumerated.
 *
 * 🔴 In `$a … ; (dependent: $a, prerequisite: $b) isa step-dependency; (dependent: $b, prerequisite:
 * $c) isa step-dependency; $c has step-id $y;`, `$b` has no constraint of its own, so it is bound only
 * when the relations bind — after `$c`, which was therefore enumerated whole: every step in the store
 * for one answer (1.3 s at 21,000 steps; docs/development/performance.md, finding 6). `relationSeed`
 * now nests `$b`'s seed into `$c`'s. Counted, not timed: the trace is deterministic.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';

const SCHEMA = 'define entity step, owns step-id @key, plays dependency:dependent, plays dependency:prerequisite; attribute step-id, value string; relation dependency, relates dependent, relates prerequisite;';

/** 300 steps in chains of ten: `s{n}` depends on `s{n-1}` within each chain. */
const graph = (planJoins = true): TypeDBLiteInterpreter => {
  const db = new TypeDBLiteInterpreter(':memory:', 5000, { trace: true, planJoins });
  db.define(SCHEMA);
  db.beginTransaction();
  for (let n = 0; n < 300; n++) db.execute(`insert $s isa step, has step-id "s${n}";`);
  for (let n = 0; n < 300; n++) {
    if (n % 10 === 0) continue;
    db.execute(`match $d isa step, has step-id "s${n}"; $p isa step, has step-id "s${n - 1}"; insert (dependent: $d, prerequisite: $p) isa dependency;`);
  }
  db.commitTransaction();
  return db;
};

const TWO_HOP = 'match $a isa step, has step-id "s155"; (dependent: $a, prerequisite: $b) isa dependency; (dependent: $b, prerequisite: $c) isa dependency; $c has step-id $y; select $y;';
const THREE_HOP = 'match $a isa step, has step-id "s157"; (dependent: $a, prerequisite: $b) isa dependency; (dependent: $b, prerequisite: $c) isa dependency; (dependent: $c, prerequisite: $d) isa dependency; $d has step-id $y; select $y;';
const values = (db: TypeDBLiteInterpreter, text: string): string[] => db.query(text).rows.map((r) => r['y']?.asString() ?? '?');

describe('an untyped role player in a relation path', () => {
  it('🔴 seeds the far end of a two-hop path through it, instead of enumerating every step', () => {
    const db = graph();
    assert.deepEqual(values(db, TWO_HOP), ['s153']);
    const trace = db.lastQueryTrace();
    assert.ok((trace?.combinationsCreated ?? Infinity) <= 10, `combinations: ${trace?.combinationsCreated}`);
    assert.ok((trace?.candidateRows ?? Infinity) <= 5, `candidate rows: ${trace?.candidateRows}`);
    db.close();
  });

  it('🔴 and three hops, through two untyped players', () => {
    const db = graph();
    assert.deepEqual(values(db, THREE_HOP), ['s154']);
    const trace = db.lastQueryTrace();
    assert.ok((trace?.combinationsCreated ?? Infinity) <= 12, `combinations: ${trace?.combinationsCreated}`);
    db.close();
  });

  it('answers what the unplanned engine answers, and what the typed path answers', () => {
    const planned = graph();
    const original = graph(false);
    const typed = 'match $a isa step, has step-id "s155"; (dependent: $a, prerequisite: $b) isa dependency; $b isa step; (dependent: $b, prerequisite: $c) isa dependency; $c isa step, has step-id $y; select $y;';
    for (const text of [TWO_HOP, THREE_HOP]) assert.deepEqual(values(planned, text), values(original, text), text);
    assert.deepEqual(values(planned, TWO_HOP), values(planned, typed));
    // A path that leaves the chain answers nothing, from either engine.
    const offEnd = TWO_HOP.replace('s155', 's151');
    assert.deepEqual(values(planned, offEnd), []);
    assert.deepEqual(values(original, offEnd), []);
    planned.close();
    original.close();
  });
});
