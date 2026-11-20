import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode } from '../src/diagnostics.js';

/**
 * An annotation the runtime does not enforce is applied AND reported — the third outcome.
 *
 * 🔴 Until 2026-09-11 `define` REFUSED `@card` and `@unique` as "parsed but not implemented", on
 * the rule that unsupported TypeQLite never silently succeeds. The rule stands; the refusal was the
 * wrong side of it — a documentation store's schema could not be applied, and every Background in TypeDB's
 * behavior spec was turned away (ADR-005, Phase 01). Founder decision: accept, and report. So the
 * language layer emits the diagnostic below error severity, and this interpreter forwards it as a
 * FACT in the report of the call that applied it — ADR-004's returned report, where a reader who
 * looks sees *"`@card` is parsed and not enforced"*, and one who does not is not lied to by a
 * constraint that silently does nothing: the report said so.
 */
describe('an unenforced annotation is applied and reported', () => {
  it('applies the schema and reports the annotation as a fact', () => {
    const engine = new TypeDBLiteInterpreter(':memory:');
    const report = engine.define(
      'define attribute doc-tag, value string; entity doc, owns doc-tag @card(0..);',
    );
    const facts = report.diagnostics.filter((d) => d.code === DiagnosticCode.annotationNotEnforced);
    assert.equal(facts.length, 1, JSON.stringify(report.diagnostics));
    assert.equal(facts[0].severity, 3, 'a fact, not an error');
    assert.match(facts[0].message, /`@card` is parsed and not enforced/);

    // Applied: the schema is usable.
    engine.execute('insert $d isa doc, has doc-tag "a", has doc-tag "b";');
    const { rows } = engine.query('match $d isa doc, has doc-tag $t; select $t;');
    engine.close();
    assert.deepEqual(rows.map((r) => r['t']?.asString()).sort(), ['a', 'b']);
  });

  it('reports every unenforced annotation in the statement, once each', () => {
    const engine = new TypeDBLiteInterpreter(':memory:');
    const report = engine.define(
      [
        'define',
        'attribute age @independent, value integer;',
        'attribute email value string @regex("^.*@.*$");',
        'entity person @abstract, owns age @card(0..), owns email @unique;',
      ].join('\n'),
    );
    engine.close();
    const named = report.diagnostics
      .filter((d) => d.code === DiagnosticCode.annotationNotEnforced)
      .map((d) => /`(@[a-z]+)`/.exec(d.message)?.[1])
      .sort();
    // No `@unique` and no `@abstract`: enforced since Phase 03 of the conformance feature —
    // `unique-ownership.test.ts`, `abstract-types.test.ts`.
    assert.deepEqual(named, ['@card', '@independent', '@regex']);
  });

  it('reports the facts of what define DID even when the annotations alone would fill the cap', () => {
    // Round 1 of the Phase 01 review: the not-enforced facts were pushed during parse(), before
    // define pushed schema-applied and keys-registered, and the collector drops facts past its
    // cap — so a define with 50+ annotations lost the two facts describing what it actually did.
    const attributes = Array.from({ length: 60 }, (_, i) => `attribute a${i} @independent, value string;`);
    const engine = new TypeDBLiteInterpreter(':memory:');
    const report = engine.define(['define', ...attributes, 'entity e;'].join('\n'));
    engine.close();
    const codes = report.diagnostics.map((d) => d.code);
    assert.ok(codes.includes(DiagnosticCode.schemaApplied), 'schema-applied survives the cap');
    assert.ok(codes.includes(DiagnosticCode.keysRegistered), 'keys-registered survives the cap');
    assert.ok(codes.includes(DiagnosticCode.truncated), 'and the truncation is itself reported');
  });

  it('does not report @key, which is enforced', () => {
    const engine = new TypeDBLiteInterpreter(':memory:');
    const report = engine.define('define attribute id, value string; entity e, owns id @key;');
    engine.close();
    assert.equal(
      report.diagnostics.filter((d) => d.code === DiagnosticCode.annotationNotEnforced).length,
      0,
    );
  });
});
