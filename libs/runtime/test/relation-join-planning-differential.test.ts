import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { buildJoinStore as build, JOIN_READS as READS } from './fixtures/join-corpus.js';

/**
 * Join planning must change the cost of a query and nothing else: the same rows, in the same
 * order, from the same store. This runs the original engine (`planJoins: false`) and the planned
 * one over identical random stores and compares what each answers -- rows AND row order, and the
 * state a write leaves behind -- for queries that put relations before, between and after their
 * players, repeat a variable in two roles, chain relations, use type variables and subtypes, and
 * hold several relation instances over the same players (which makes row order observable).
 */

const outcome = (engine: TypeDBLiteInterpreter, text: string): string => {
  try {
    const { rows, diagnostics } = engine.query(text);
    return JSON.stringify({ rows, diagnostics });
  } catch (error) {
    return `threw: ${error instanceof Error ? error.message : String(error)}`;
  }
};

const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1);

describe('planned joins answer exactly what the original engine answers', () => {
  it.each(SEEDS)('reads, in row order, on random store %i', (seed) => {
    const original = build(false, seed);
    const planned = build(true, seed);
    for (const query of READS) {
      assert.equal(outcome(planned, query), outcome(original, query), `seed ${seed}: ${query}`);
    }
  });

  it('is not vacuous: most queries answer rows, and none throws', () => {
    const answered = new Map<string, number>();
    for (const seed of SEEDS) {
      const engine = build(true, seed);
      for (const query of READS) {
        const result = outcome(engine, query);
        assert.ok(!result.startsWith('threw'), `${query} -> ${result}`);
        if (!result.startsWith('{"rows":[]')) answered.set(query, (answered.get(query) ?? 0) + 1);
      }
    }
    const silent = READS.filter((query) => (answered.get(query) ?? 0) < 10);
    // Only the deliberately empty query (an unknown node-id) may be silent.
    assert.deepEqual(silent, [READS.find((q) => q.includes('n99'))], `queries that rarely answered: ${silent.join('\n')}`);
  });

  it('actually exercises multi-instance relations (row order is observable)', () => {
    let multi = 0;
    let answered = 0;
    for (const seed of SEEDS) {
      const rows = build(false, seed).query('match $a isa node; $b isa node; $r isa link (source: $a, target: $b); select $a, $b, $r;').rows;
      answered += rows.length > 0 ? 1 : 0;
      multi += rows.length > 4 ? 1 : 0;
    }
    assert.ok(answered >= 20, `only ${answered} stores had a link`);
    assert.ok(multi >= 10, `only ${multi} stores had more than four link rows`);
  });

  const WRITES = [
    'match $a isa node; $b isa node; $r isa link (source: $a, target: $b); delete $r;',
    'match $a isa node, has tag "l0"; $b isa node; (source: $a, target: $b) isa link; delete $b;',
    'match $a isa node; $b isa node; (source: $a, target: $b) isa link; insert $a has tag "touched";',
    'match $a isa node; $b isa node; (source: $a, target: $b) isa link; insert (source: $b, target: $a) isa strong-link;',
  ];
  const DUMP = 'match $n isa node, has node-id $i, has tag $g; select $i, $g;';
  const DUMP_LINKS = 'match $r isa link (source: $a, target: $b); $a has node-id $x; $b has node-id $y; select $r, $x, $y;';

  it.each(SEEDS.slice(0, 15))('writes leave the same store behind on random store %i', (seed) => {
    for (const write of WRITES) {
      const original = build(false, seed);
      const planned = build(true, seed);
      const run = (engine: TypeDBLiteInterpreter): string => {
        try {
          const report = engine.execute(write);
          return JSON.stringify(report);
        } catch (error) {
          return `threw: ${error instanceof Error ? error.message : String(error)}`;
        }
      };
      const a = run(original);
      const b = run(planned);
      assert.equal(b.replace(/"duration[^,}]*[,}]/g, ''), a.replace(/"duration[^,}]*[,}]/g, ''), `seed ${seed}: ${write}`);
      for (const dump of [DUMP, DUMP_LINKS]) {
        assert.equal(outcome(planned, dump), outcome(original, dump), `seed ${seed} after ${write}`);
      }
    }
  });
});
