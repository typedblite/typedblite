import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';

/**
 * A `has` after a relation nobody named binds that relation's value (typedblite#119). It was dropped: the variable
 * was never bound, `fetch` answered `null` with nothing to say so, and `select` claimed the `match` never named it.
 *
 * The relation itself stays unnamed, so two relations that bind the same answers are one answer
 * (`anonymous-relation-duplicates.test.ts`).
 */
const SCHEMA = `define
  attribute name, value string;
  attribute discount, value double;
  attribute note, value string;
  entity promotion, owns name, plays inclusion:promotion;
  entity item, owns name @key, plays inclusion:item;
  relation inclusion, relates promotion, relates item, owns discount, owns note @card(0..);`;

let engine: TypeDBLiteInterpreter;

const include = (item: string, extra: string) =>
  engine.execute(`match $p isa promotion; $i isa item, has name "${item}"; insert (promotion: $p, item: $i) isa inclusion${extra};`);

beforeEach(() => {
  engine = new TypeDBLiteInterpreter(':memory:');
  engine.define(SCHEMA);
  engine.execute('insert $p isa promotion, has name "sale"; $a isa item, has name "a"; $b isa item, has name "b"; $c isa item, has name "c";');
  include('a', ', has discount 0.25, has note "x"');
  include('b', ', has discount 0.5');
  include('c', '');
});

/** Both ways of writing a relation with no variable, and both places the players can come from. */
const FORMS = [
  'inclusion (promotion: $p, item: $i), has discount $d;',
  '(promotion: $p, item: $i) isa inclusion, has discount $d;',
  '(promotion: $p, item: $i), has discount $d;',
];
const strings = (rows: ReturnType<TypeDBLiteInterpreter['query']>['rows'], ...names: string[]) =>
  rows.map((row) => names.map((name) => String(row[name]?.asString?.() ?? row[name]?.asDouble?.())).join(' ')).sort();

describe('a value read from an unnamed relation', () => {
  for (const form of FORMS) {
    it(`is bound by \`${form}\``, () => {
      const { rows } = engine.query(`match $p isa promotion; $i isa item, has name $n; ${form} select $n, $d;`);
      assert.deepEqual(strings(rows, 'n', 'd'), ['a 0.25', 'b 0.5']);
    });

    it(`is bound by \`${form}\` when the relation alone names the players`, () => {
      const { rows } = engine.query(`match ${form} $i has name $n; select $n, $d;`);
      assert.deepEqual(strings(rows, 'n', 'd'), ['a 0.25', 'b 0.5']);
    });
  }

  it('is fetched, not answered as null', () => {
    const answer = engine.query(`match $p isa promotion; ${FORMS[0]} fetch { "discount": $d };`) as unknown as {
      documents?: { discount: unknown }[];
      rows: { discount: unknown }[];
    };
    assert.deepEqual((answer.documents ?? answer.rows).map((document) => document.discount).sort(), [0.25, 0.5]);
  });

  it('can be used in arithmetic and a comparison', () => {
    const { rows } = engine.query(`match $p isa promotion; ${FORMS[0]} $d > 0.3; let $x = $d * 2; select $x;`);
    assert.deepEqual(strings(rows, 'x'), ['1.0']);
  });

  it('reads two values from one relation, never one from each', () => {
    // A second relation between the same players, holding only the other value.
    include('b', ', has note "y"');
    include('a', ', has note "z"');
    const { rows } = engine.query('match $p isa promotion; inclusion (promotion: $p, item: $i), has discount $d, has note $t; select $d, $t;');
    assert.deepEqual(strings(rows, 'd', 't'), ['0.25 x']);
  });

  it('is bound inside a negation and a disjunction', () => {
    const negated = engine.query('match $i isa item, has name $n; not { inclusion (item: $i), has discount $d; $d > 0.3; }; select $n;');
    assert.deepEqual(strings(negated.rows, 'n'), ['a', 'c']);
    const either = engine.query('match { inclusion (item: $i), has discount $d; $d > 0.3; } or { inclusion (item: $i), has note $t; }; $i has name $n; select $n;');
    assert.deepEqual(strings(either.rows, 'n'), ['a', 'b']);
  });

  it('answers once for two relations that bind the same values, and twice when they differ', () => {
    include('a', ', has discount 0.25');
    const same = engine.query('match $i isa item, has name "a"; inclusion (item: $i), has discount $d; select $d;');
    assert.deepEqual(strings(same.rows, 'd'), ['0.25']);
    include('a', ', has discount 0.75');
    const differing = engine.query('match $i isa item, has name "a"; inclusion (item: $i), has discount $d; select $d;');
    assert.deepEqual(strings(differing.rows, 'd'), ['0.25', '0.75']);
  });

  it('keeps to a value bound before it', () => {
    // `$d` is `b`'s discount. `a` is included at another, so it must not match merely for having one.
    const { rows } = engine.query(
      'match $other isa item, has name "b"; inclusion (item: $other), has discount $d; $i isa item, has name "a"; inclusion (item: $i), has discount $d; select $i;',
    );
    assert.deepEqual(rows, []);
  });

  it('is aggregated once for each distinct answer, unlike a named relation', () => {
    include('a', ', has discount 0.25');
    const total = (relation: string) => {
      const { rows } = engine.query(`match $i isa item, has name "a"; ${relation} (item: $i), has discount $d; reduce $c = count;`);
      return Number(rows[0]?.['c']?.asInteger?.());
    };
    // TypeDB 3.10.4 does the same, checked on a server on 2026-11-27.
    assert.equal(total('inclusion'), 1);
    assert.equal(total('$r isa inclusion'), 2);
  });

  it('sums once for each distinct answer, as TypeDB does', () => {
    // Checked on a TypeDB 3.10.4 server: quantities 2, 2 on one item and 2, 3 on another give 9 and 4 through a
    // named relation, 5 and 2 through an unnamed one, and 7 and 3 when the item is named as well.
    const other = new TypeDBLiteInterpreter(':memory:');
    other.define(`define attribute qty, value integer; attribute name, value string;
      entity promotion, plays inclusion:promotion; entity item, owns name @key, plays inclusion:item;
      relation inclusion, relates promotion, relates item, owns qty;`);
    other.execute(`insert $p isa promotion; $a isa item, has name "a"; $b isa item, has name "b";
      inclusion (promotion: $p, item: $a), has qty 2; inclusion (promotion: $p, item: $a), has qty 2;
      inclusion (promotion: $p, item: $b), has qty 2; inclusion (promotion: $p, item: $b), has qty 3;`);
    const totals = (pattern: string) => {
      const { rows } = other.query(`match ${pattern}, has qty $q; reduce $s = sum($q), $c = count;`);
      return [Number(rows[0]?.['s']?.asInteger?.()), Number(rows[0]?.['c']?.asInteger?.())];
    };
    assert.deepEqual(totals('$r isa inclusion (promotion: $p)'), [9, 4]);
    assert.deepEqual(totals('inclusion (promotion: $p)'), [5, 2]);
    assert.deepEqual(totals('inclusion (promotion: $p, item: $i)'), [7, 3]);
  });

  it('writes what it read', () => {
    engine.execute('match $i isa item, has name "b"; $r isa inclusion (item: $i); inclusion (item: $i), has discount $d; insert $r has note "seen";');
    const { rows } = engine.query('match $r isa inclusion, has note "seen", has discount $d; select $d;');
    assert.deepEqual(strings(rows, 'd'), ['0.5']);
  });
});
