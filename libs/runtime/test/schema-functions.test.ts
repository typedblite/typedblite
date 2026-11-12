import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode, diagnosticOf } from '../src/diagnostics.js';

/**
 * Schema functions — `get_doc`, `get_meta`, `get_all_meta`, their `get_<owns|plays|relates|sub>_…`
 * forms, and `label`. Each `it` names the metadata.feature line it answers; the conformance card
 * is the acceptance suite, this says what each call answers, row by row.
 */
const SCHEMA = [
  'define',
  'attribute id @doc("an id") @meta("k", "attr"), value string;',
  'relation base @doc("a base"), relates arole @doc("a role") @meta("r", "role");',
  'relation person, sub base @doc("is a base"), relates dummy, owns id @doc("owned id") @meta("k1", "v1") @meta("k2", "v2"), plays base:arole @meta("p", "plays");',
  'entity company @meta("k1", "v1") @meta("k2", "v2");',
].join('\n');

const values = (engine: TypeDBLiteInterpreter, query: string): Array<Record<string, string>> =>
  engine.query(query).rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v.isType() ? `type:${v.label}` : `${v.type}:${v.asString()}`])),
  );

const refusal = (attempt: () => void): string => {
  try {
    attempt();
  } catch (error) {
    return String(diagnosticOf(error)?.code);
  }
  throw new Error('expected a refusal');
};

describe('schema functions', () => {
  let engine: TypeDBLiteInterpreter;

  beforeEach(() => {
    engine = new TypeDBLiteInterpreter(':memory:');
    engine.define(SCHEMA);
  });

  afterEach(() => engine.close());

  it('get_doc reads a type’s and a role’s @doc — L15, L43, L73', () => {
    assert.deepEqual(values(engine, 'match let $a = get_doc(id); let $b = get_doc(base); let $c = get_doc(base:arole);'), [
      { a: 'string:an id', b: 'string:a base', c: 'string:a role' },
    ]);
  });

  it('a type with no @doc answers the empty string, not no row — L266', () => {
    assert.deepEqual(values(engine, 'match let $d = get_doc(company);'), [{ d: 'string:' }]);
  });

  it('get_meta reads one key; a missing key is the empty string — L312, L550', () => {
    assert.deepEqual(values(engine, 'match let $a = get_meta("k", id); let $b = get_meta("missing", id);'), [
      { a: 'string:attr', b: 'string:' },
    ]);
  });

  it('get_all_meta answers a (key, value) row per @meta, and none when there are none — L613, L731', () => {
    const rows = values(engine, 'match let $k, $v in get_all_meta(company);');
    assert.deepEqual(rows.sort((x, y) => x.k.localeCompare(y.k)), [
      { k: 'string:k1', v: 'string:v1' },
      { k: 'string:k2', v: 'string:v2' },
    ]);
    assert.deepEqual(values(engine, 'match let $k, $v in get_all_meta(base);'), []);
  });

  it('the capability forms read the capability’s annotations — L228, L482, L704', () => {
    assert.deepEqual(
      values(engine, 'match let $o = get_owns_doc(person, id); let $s = get_sub_doc(person, base); let $p = get_plays_meta("p", person, base:arole); let $r = get_relates_meta("r", base, base:arole);'),
      [{ o: 'string:owned id', s: 'string:is a base', p: 'string:plays', r: 'string:role' }],
    );
    assert.equal(values(engine, 'match let $k, $v in get_owns_all_meta(person, id);').length, 2);
  });

  it('a capability that does not exist answers no row — L854, L923', () => {
    for (const query of [
      'match let $d = get_owns_doc(company, id);',
      'match let $d = get_sub_doc(company, person);',
      'match let $d = get_relates_doc(person, base:arole);',
      'match let $d = get_plays_doc(company, base:arole);',
      'match let $d = get_owns_doc(person, person);',
    ]) {
      assert.deepEqual(values(engine, query), [], query);
    }
  });

  it('a type variable is read as its label — L1121, L1139', () => {
    assert.deepEqual(values(engine, 'match $t label base:arole; let $d = get_doc($t); let $l = label($t);'), [
      { t: 'type:base:arole', d: 'string:a role', l: 'string:base:arole' },
    ]);
  });

  it('a schema call’s value computes like any string', () => {
    assert.deepEqual(values(engine, 'match let $d = get_doc(id) + "!";'), [{ d: 'string:an id!' }]);
  });

  it('refuses before any row: an unknown label, a value for a type, a type for a value, a tuple of the wrong width', () => {
    assert.equal(refusal(() => engine.query('match let $d = get_doc(nonesuch);')), DiagnosticCode.unknownType);
    assert.equal(refusal(() => engine.query('match let $d = get_doc("person");')), DiagnosticCode.valueTypeConflict);
    assert.equal(refusal(() => engine.query('match let $d = get_meta(id, id);')), DiagnosticCode.valueTypeConflict);
    assert.equal(refusal(() => engine.query('match let $d = get_all_meta(id);')), DiagnosticCode.valueTypeConflict);
    assert.equal(refusal(() => engine.query('match let $a, $b in get_doc(id);')), DiagnosticCode.valueTypeConflict);
    // A bare label outside a function's arguments does not parse — `let $a = P524287Y;` must not
    // reach the engine as a label and fail for the wrong reason (expression.feature L825).
    assert.equal(refusal(() => engine.query('match let $d = id;')), DiagnosticCode.parseFailed);
  });

  it('a type variable is still not an operand outside a schema call', () => {
    assert.equal(refusal(() => engine.query('match $t label id; let $d = $t + "x";')), DiagnosticCode.valueTypeConflict);
  });

  it('get_fun_… of a function the schema does not define is refused by name — L833', () => {
    assert.equal(refusal(() => engine.query('match let $d = get_fun_doc("f");')), DiagnosticCode.unknownFunction);
  });
});
