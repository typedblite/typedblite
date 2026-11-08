import { beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode } from '../src/diagnostics.js';

/**
 * 🔴 A relation excluded only by its OWN role constraints answers zero rows with no diagnostic at
 * all (d-20260910-an-empty-result-caused-only-by).
 *
 * `query()`'s `noCandidates` block iterates every constraint and calls `candidates(constraint)` —
 * which builds SQL from `type`, `literals` and `bindings` and never reads `roles`. `relationBindings`
 * added three role-based rejection rules that `candidates()` cannot see: same-role distinctness
 * (`links (source: $x, source: $y)` needs two different players), a relation's own subtype closure,
 * and the already-bound-relation pin. `candidates()` finds the link fine — it exists, of the right
 * type, owning the right attribute — so the loop's `continue` fires before anything relation-shaped
 * is checked, and a rejection from any of the three rules looks identical to `emptyMatch`.
 *
 * This asserts the same-role case, matching the defect's own reproducer: a link with one source
 * cannot satisfy `links (source: $x, source: $y)`, which needs two.
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

describe('a relation excluded only by its own role constraints is diagnosed', () => {
  it('reports a no-candidates fact when one source cannot fill two distinct role slots', () => {
    const { rows, diagnostics } = engine.query(
      'match $l isa link, links (source: $x, source: $y), has edge-id $id; select $id;',
    );
    assert.equal(rows.length, 0, 'the stored link has exactly one source');

    const fact = diagnostics.find((d) => d.code === DiagnosticCode.noCandidates);
    assert.ok(
      fact,
      'a relation candidates() finds by type and attribute alone, but whose OWN role ' +
        'constraints exclude every row, must not answer as silently as a genuine emptyMatch',
    );
    assert.match(fact!.message, /matched 1 candidate/);
    assert.match(fact!.message, /role constraints/);
    assert.match(fact!.message, /and 0 after/);
  });

  // 🔴 The negative control: a relation that plays no role at all still gets the ordinary
  // thing-shaped fact, unchanged — this fix must not touch that path.
  it('still reports the ordinary fact for a relation with no matching attribute', () => {
    const { rows, diagnostics } = engine.query(
      'match $l isa link, has edge-id "absent"; select $l;',
    );
    assert.equal(rows.length, 0);
    const fact = diagnostics.find((d) => d.code === DiagnosticCode.noCandidates);
    assert.ok(fact);
    // The ONE link of type `link` exists — its edge-id just isn't "absent" — so the count before
    // the literal is 1, matching the ordinary (non-role) shape this fix must not disturb.
    assert.match(fact!.message, /matched 1 candidate/);
    assert.doesNotMatch(fact!.message, /role constraints/);
  });

  // 🔴 The other side: a relation whose role constraints DO admit an answer must stay silent —
  // this is `emptyMatch`'s own territory (an outer pattern excluded it), and inventing a role
  // rejection that never happened would be worse than the silence this fixes.
  it('stays silent when the relation exists but an unrelated pattern excludes it', () => {
    const { rows, diagnostics } = engine.query(
      'match $l isa link, links (source: $x, target: $y), has edge-id "e";' +
        ' $x has node-id "nope"; select $x;',
    );
    assert.equal(rows.length, 0, 'no node has node-id "nope"');
    const fact = diagnostics.find((d) => d.code === DiagnosticCode.noCandidates);
    assert.equal(fact, undefined, 'the relation itself is satisfiable; $x is the excluded one');
  });

  // 🔴 QA's adversarial pass found this: the diagnostic probes `relationBindings` with an EMPTY
  // combination, so when the relation's own variable is itself a role player of another relation
  // (`relation-plays-a-role.test.ts`'s shape — the schema below is copied from it), the probe
  // cannot know which instance the outer pattern actually pinned. An unrelated relation of the
  // same type elsewhere in the store can satisfy the unconstrained probe while the PINNED one is
  // the one actually excluded — silently suppressing the diagnostic for exactly the row that
  // needed it. Declining to guess here, rather than probing wrongly, is the fix.
  describe('when the relation is itself pinned by an outer relation', () => {
    const NESTED_SCHEMA = [
      'define',
      'attribute node-id, value string;',
      'attribute edge-id, value string;',
      'attribute note, value string;',
      'entity node, owns node-id @key, plays link:source, plays link:target;',
      'relation link, relates source, relates target, owns edge-id @key, plays annotation:subject;',
      'entity remark, owns note @key, plays annotation:author;',
      'relation annotation, relates subject, relates author;',
    ].join('\n');

    const query = () =>
      engine.query(
        'match $a isa annotation, links (subject: $l, author: $r);' +
          ' $l isa link, links (source: $x, source: $y), has edge-id $id; select $id;',
      );

    it('stays silent rather than risk a wrong diagnosis, even with an unrelated same-type relation elsewhere', () => {
      engine = new TypeDBLiteInterpreter(':memory:');
      engine.define(NESTED_SCHEMA);
      engine.execute('insert $n isa node, has node-id "a";');
      engine.execute('insert $n isa node, has node-id "b";');
      engine.execute('insert $r isa remark, has note "reviewed";');
      // l1: exactly one source — this is the one the annotation pins.
      engine.execute(
        'match $s isa node, has node-id "a"; $t isa node, has node-id "b";' +
          ' insert $l isa link, links (source: $s, target: $t), has edge-id "l1";',
      );
      // l2: two sources, but never annotated by anything — the unrelated relation that must not
      // make the probe answer for l1.
      engine.execute('insert $n isa node, has node-id "c";');
      engine.execute('insert $n isa node, has node-id "d";');
      engine.execute(
        'match $c isa node, has node-id "c"; $d isa node, has node-id "d";' +
          ' insert $l isa link, links (source: $c, source: $d), has edge-id "l2";',
      );
      engine.execute(
        'match $l isa link, has edge-id "l1"; $r isa remark, has note "reviewed";' +
          ' insert $a isa annotation, links (subject: $l, author: $r);',
      );

      const { rows, diagnostics } = query();
      assert.equal(rows.length, 0, 'l1, the annotated link, has only one source');
      const fact = diagnostics.find((d) => d.code === DiagnosticCode.noCandidates);
      assert.equal(
        fact,
        undefined,
        "l2's two sources must not make the probe claim l1's role constraints are satisfiable",
      );
    });

    it('stays silent even with no ambiguous relation present — the scope this fix narrowed to, not lifted', () => {
      engine = new TypeDBLiteInterpreter(':memory:');
      engine.define(NESTED_SCHEMA);
      engine.execute('insert $n isa node, has node-id "a";');
      engine.execute('insert $n isa node, has node-id "b";');
      engine.execute('insert $r isa remark, has note "reviewed";');
      engine.execute(
        'match $s isa node, has node-id "a"; $t isa node, has node-id "b";' +
          ' insert $l isa link, links (source: $s, target: $t), has edge-id "l1";',
      );
      engine.execute(
        'match $l isa link, has edge-id "l1"; $r isa remark, has note "reviewed";' +
          ' insert $a isa annotation, links (subject: $l, author: $r);',
      );

      const { rows, diagnostics } = query();
      assert.equal(rows.length, 0);
      // 🔴 Silence here is correct too: `$l` is still bound by the outer `annotation` pattern, so
      // this stays declined rather than guessed — the scope this fix narrowed to, not lifted.
      assert.equal(diagnostics.find((d) => d.code === DiagnosticCode.noCandidates), undefined);
    });
  });
});
