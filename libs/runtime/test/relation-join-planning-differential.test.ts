import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';

/**
 * Join planning must change the cost of a query and nothing else: the same rows, in the same
 * order, from the same store. This runs the original engine (`planJoins: false`) and the planned
 * one over identical random stores and compares what each answers -- rows AND row order, and the
 * state a write leaves behind -- for queries that put relations before, between and after their
 * players, repeat a variable in two roles, chain relations, use type variables and subtypes, and
 * hold several relation instances over the same players (which makes row order observable).
 */
const SCHEMA = [
  'define',
  'attribute node-id, value string;',
  'attribute tag, value string;',
  'entity node, owns node-id @key, owns tag, plays link:source, plays link:target, plays tri:a, plays tri:b, plays tri:c;',
  'entity special sub node;',
  'relation link, relates source, relates target;',
  'relation strong-link sub link;',
  'relation tri, relates a, relates b, relates c;',
].join('\n');

/** A small deterministic PRNG, so a failing seed is reproducible. */
const prng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
};

const build = (planJoins: boolean, seed: number): TypeDBLiteInterpreter => {
  const engine = new TypeDBLiteInterpreter(':memory:', 5000, { planJoins });
  engine.define(SCHEMA);
  const random = prng(seed);
  const count = 5 + Math.floor(random() * 5);
  // Insertion order is shuffled by the seed, so iid order is not id order.
  const ids = Array.from({ length: count }, (_, i) => i).sort(() => random() - 0.5);
  for (const i of ids) {
    const type = random() < 0.35 ? 'special' : 'node';
    engine.execute(`insert $n isa ${type}, has node-id "n${i}", has tag "l${i % 3}";`);
  }
  const pick = (): number => Math.floor(random() * count);
  const links = Math.floor(random() * 14);
  for (let k = 0; k < links; k++) {
    const type = random() < 0.3 ? 'strong-link' : 'link';
    const [s, t] = random() < 0.15 ? [pick(), pick()].map((x, _, a) => (random() < 0.5 ? (a[0] as number) : x)) : [pick(), pick()];
    engine.execute(
      `match $s isa node, has node-id "n${s}"; $t isa node, has node-id "n${t}"; insert $r isa ${type} (source: $s, target: $t);`,
    );
  }
  for (let k = 0; k < Math.floor(random() * 6); k++) {
    engine.execute(
      `match $a isa node, has node-id "n${pick()}"; $b isa node, has node-id "n${pick()}"; $c isa node, has node-id "n${pick()}"; ` +
        `insert $r isa tri (a: $a, b: $b, c: $c);`,
    );
  }
  return engine;
};

const READS = [
  'match $a isa node; $b isa node; (source: $a, target: $b) isa link; select $a, $b;',
  'match $a isa node; $b isa node; $r isa link (source: $a, target: $b); select $a, $b, $r;',
  'match $r isa link (source: $a, target: $b); $a isa node; $b isa node; select $a, $b, $r;',
  'match (source: $a, target: $b) isa link; $b isa node; $a isa node; select $a, $b;',
  'match $b isa node; (source: $a, target: $b) isa link; $a isa node; select $a, $b;',
  'match $a isa node, has tag "l1"; $b isa node; $r isa link (source: $a, target: $b); select $a, $b, $r;',
  'match $a isa node, has tag $g; $b isa node; (source: $a, target: $b) isa link; select $g, $b;',
  'match $a isa node; (source: $a, target: $a) isa link; select $a;',
  'match $a isa node; $b isa node; $c isa node; $r isa tri (a: $a, b: $b, c: $c); select $a, $b, $c, $r;',
  'match $a isa node; $b isa node; $c isa node; (a: $a, b: $b) isa tri; (source: $b, target: $c) isa link; select $a, $b, $c;',
  'match $a isa node; $b isa node; $c isa node; (source: $a, target: $b) isa link; (source: $b, target: $c) isa link; select $a, $b, $c;',
  'match $c isa node; $b isa node; $a isa node; (source: $a, target: $b) isa link; (source: $b, target: $c) isa link; select $a, $b, $c;',
  'match $x isa $t; $y isa node; (source: $x, target: $y) isa link; select $x, $t, $y;',
  'match $a isa node; $b isa node; $r isa $t (source: $a, target: $b); select $a, $b, $r, $t;',
  'match $a isa special; $b isa node; (source: $a, target: $b) isa link; select $a, $b;',
  'match $a isa! node; $b isa node; (source: $a, target: $b) isa link; select $a, $b;',
  'match $a isa node; $b isa node; $r isa! link (source: $a, target: $b); select $a, $b;',
  'match $a isa node; $b isa node; (source: $a, target: $b) isa strong-link; select $a, $b;',
  'match $a isa node, has node-id "n2"; $b isa node; (source: $a, target: $b) isa link; select $b;',
  'match $a isa node; $b isa node; (source: $a, target: $b) isa link; (source: $b, target: $a) isa link; select $a, $b;',
  'match $a isa node; $b isa node; $c isa node; (source: $a, target: $b) isa link; (target: $c, source: $b) isa link; $c isa special; select $a, $b, $c;',
  'match $a isa node; $b isa node; (source: $a, target: $b) isa link; select $a;',
  'match $a isa node; $b isa node; select $a, $b;',
  'match $a isa node, has node-id "n99"; $b isa node; (source: $a, target: $b) isa link; select $b;',
  // Untyped players in the middle of a path: seeded through each other (finding 6 in
  // docs/development/performance.md), so they must answer the same rows in the same order.
  'match $a isa node, has tag "l0"; (source: $a, target: $b) isa link; (source: $b, target: $c) isa link; $c has node-id $i; select $a, $b, $i;',
  'match $a isa node; (source: $a, target: $b) isa link; (source: $b, target: $c) isa link; (source: $c, target: $d) isa link; $d has tag $g; select $a, $d, $g;',
  'match $c isa node; (source: $a, target: $b) isa link; (source: $b, target: $c) isa link; $a has tag "l2"; select $a, $b, $c;',
  // Two literals on one variable: one drives, the other is probed (finding 5).
  'match $a isa node, has tag "l1", has node-id $i; $b isa node, has tag "l1"; (source: $a, target: $b) isa link; select $i, $b;',
];

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
