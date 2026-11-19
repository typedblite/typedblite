import { TypeDBLiteInterpreter } from '../../src/interpreter.js';

/**
 * The join-planning corpus: a schema of nodes, links and triangles, random stores over it, and reads that put
 * relations before, between and after their players. Shared by the join-planning differential test and the step
 * hook's, so both prove their claim over the same queries.
 */
export const JOIN_SCHEMA = [
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

export const buildJoinStore = (planJoins: boolean, seed: number): TypeDBLiteInterpreter => {
  const engine = new TypeDBLiteInterpreter(':memory:', 5000, { planJoins });
  engine.define(JOIN_SCHEMA);
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

export const JOIN_READS = [
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
