import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { attachDiagnostic, DiagnosticCode, TypeDBLiteInterpreter, TypeDBLiteValue } from '@typedblite/runtime';
import { identifierMatches, parseIdentifier, uniquelyIdentify } from '../src/identify.js';
import { runFeature, validateDeviations } from '../src/runner.js';
import { checkSums, regressions, renderFailureDigest, reportCard, unraised } from '../src/report.js';
import type { SpecFeature, SpecScenario, SpecStep } from '../src/spec.js';
import { findStep, UndefinedStep } from '../src/steps.js';
import { World } from '../src/world.js';

/**
 * 🔴 The harness is tested against the failure mode it exists to prevent: a scenario that passes
 * without proving anything. Every test here is a way the score could be flattered, and a check
 * that it is not.
 */
/** An engine that answers every read with no rows and no `projected` fact — the shape the guards refuse. */
class SilentEngine extends TypeDBLiteInterpreter {
  constructor() {
    super(':memory:');
  }
  override query(): ReturnType<TypeDBLiteInterpreter['query']> {
    return { rows: [], diagnostics: [] };
  }
}

const step = (text: string, extra: Partial<SpecStep> = {}): SpecStep => ({
  text,
  fromBackground: false,
  line: 0,
  ...extra,
});

const scenario = (name: string, steps: SpecStep[]): SpecScenario => ({
  feature: 'query/language/probe.feature',
  name,
  line: 0,
  steps,
});

const feature = (...scenarios: SpecScenario[]): SpecFeature => ({
  path: 'query/language/probe.feature',
  scenarios,
});

const noDeclarations = { deviations: [], notApplicable: [], ownerResolves: () => true };

// ⚠️ Not the spec's form. TypeDB 3 accepts `attribute name value string;`; TypeDBLite parses only
// the comma form (`d-20260911-the-typeql-grammar-requires-a-comma`) and refuses `name` as reserved
// (`d-20260911-the-validator-reserves-ten-identifiers-typedb`). These tests are of the harness, and
// the fixture must be a schema the engine applies, or every "passes" below would be a grammar test.
const SCHEMA = `define
attribute ref, value integer;
attribute full-name, value string;
entity person, owns ref @key, owns full-name;`;

const open = (kind: string) => [
  step('connection create database: typedb'),
  step(`connection open ${kind} transaction for database: typedb`),
];

describe('the row model cannot flatter an identification', () => {
  const row = {
    n: TypeDBLiteValue.attribute('name', 'Alice'),
    r: TypeDBLiteValue.attribute('ref', '1'),
    p: TypeDBLiteValue.entity(7, 'person'),
    f: TypeDBLiteValue.relation(9, 'friendship'),
  };
  // The driver's getHas, as a fixture: thing 7 owns ref 1 and nothing else; thing 9 owns nothing.
  const has = (iid: number, attribute: string) =>
    iid === 7 && attribute === 'ref' ? [TypeDBLiteValue.attribute('ref', '1')] : [];

  it('key: matches a thing by an attribute the engine says it owns, and nothing else', () => {
    assert.equal(identifierMatches(parseIdentifier('key:ref:1'), row, 'p', has), true);
    assert.equal(identifierMatches(parseIdentifier('key:ref:2'), row, 'p', has), false);
    // The thing owns no `email`: a non-match, never a match.
    assert.equal(identifierMatches(parseIdentifier('key:email:1'), row, 'p', has), false);
    // A relation with no attributes at all.
    assert.equal(identifierMatches(parseIdentifier('key:ref:1'), row, 'f', has), false);
    // 🔴 An attribute cell is not a thing, whatever its value — `ref 1` the attribute is not
    // `key:ref:1` the person.
    assert.equal(identifierMatches(parseIdentifier('key:ref:1'), row, 'r', has), false);
  });

  it('attr: reads the type from the cell itself, not from the query', () => {
    assert.equal(identifierMatches(parseIdentifier('attr:name:Alice'), row, 'n', has), true);
    assert.equal(identifierMatches(parseIdentifier('attr:email:Alice'), row, 'n', has), false);
    // By value when the attribute's value type is known, as a driver parses the literal (given.feature L100).
    const decimal = { d: TypeDBLiteValue.attribute('price', '1.5') };
    const typed = () => 'decimal';
    assert.equal(identifierMatches(parseIdentifier('attr:price:1.50dec'), decimal, 'd', has, typed), true);
    assert.equal(identifierMatches(parseIdentifier('attr:price:1.51dec'), decimal, 'd', has, typed), false);
    const zoned = { z: TypeDBLiteValue.attribute('at', '2024-09-20T16:40:05.000000001+01:00') };
    assert.equal(identifierMatches(parseIdentifier('attr:at:2024-09-20T16:40:05.000000001+0100'), zoned, 'z', has, () => 'datetime-tz'), true);
    assert.equal(identifierMatches(parseIdentifier('attr:name:Bob'), row, 'n', has), false);
    // 🔴 The subtype case the old query-text reading could not close: a `first-name` answered for
    // `has name $n` is a `first-name` cell, and `attr:name:` does not match it.
    const sub = { n: TypeDBLiteValue.attribute('first-name', 'Alice') };
    assert.equal(identifierMatches(parseIdentifier('attr:name:Alice'), sub, 'n', has), false);
    assert.equal(identifierMatches(parseIdentifier('attr:first-name:Alice'), sub, 'n', has), true);
    // A thing is not an attribute.
    assert.equal(identifierMatches(parseIdentifier('attr:person:Alice'), row, 'p', has), false);
  });

  it('value: compares by the declared value type, and a thing is never a value', () => {
    assert.equal(identifierMatches(parseIdentifier('value:integer:1'), row, 'r', has), true);
    assert.equal(identifierMatches(parseIdentifier('value:integer:01'), row, 'r', has), true);
    assert.equal(identifierMatches(parseIdentifier('value:string:1'), row, 'r', has), true);
    assert.equal(identifierMatches(parseIdentifier('value:integer:2'), row, 'r', has), false);
    assert.equal(identifierMatches(parseIdentifier('value:integer:x'), row, 'n', has), false);
    assert.equal(identifierMatches(parseIdentifier('value:integer:7'), row, 'p', has), false);
  });

  it('value: requires a value cell\'s value type to be the identifier\'s — Phase 06 review, round 6', () => {
    const cells = { i: TypeDBLiteValue.value('integer', '752'), d: TypeDBLiteValue.value('double', '752.0') };
    assert.equal(identifierMatches(parseIdentifier('value:double:752.0'), cells, 'i', has), false);
    assert.equal(identifierMatches(parseIdentifier('value:integer:752'), cells, 'i', has), true);
    assert.equal(identifierMatches(parseIdentifier('value:double:752.0'), cells, 'd', has), true);
    assert.equal(identifierMatches(parseIdentifier('value:integer:752'), cells, 'd', has), false);
  });

  it('value:integer: is exact to the digit at 64 bits — Phase 06 review, round 4', () => {
    const edge = { i: TypeDBLiteValue.value('integer', '9223372036854775807') };
    assert.equal(identifierMatches(parseIdentifier('value:integer:9223372036854775807'), edge, 'i', has), true);
    assert.equal(identifierMatches(parseIdentifier('value:integer:9223372036854775806'), edge, 'i', has), false);
  });

  it('value:decimal: is exact, the dec suffix and trailing zeros aside — Phase 06', () => {
    const cells = { d: TypeDBLiteValue.value('decimal', '18.00'), s: TypeDBLiteValue.value('decimal', '173.1'), z: TypeDBLiteValue.value('decimal', '-0.0') };
    assert.equal(identifierMatches(parseIdentifier('value:decimal:18.0dec'), cells, 'd', has), true);
    assert.equal(identifierMatches(parseIdentifier('value:decimal:18dec'), cells, 'd', has), true);
    assert.equal(identifierMatches(parseIdentifier('value:decimal:18.01dec'), cells, 'd', has), false);
    // 🔴 Never through a float: a float would read `173.1` as `173.10000000000002` here or there.
    assert.equal(identifierMatches(parseIdentifier('value:decimal:173.1dec'), cells, 's', has), true);
    assert.equal(identifierMatches(parseIdentifier('value:decimal:0.0dec'), cells, 'z', has), true);
    assert.equal(identifierMatches(parseIdentifier('value:decimal:abc'), cells, 'd', has), false);
  });

  it('label: matches a type cell by its label, and never a thing of that type — Phase 05', () => {
    assert.equal(identifierMatches(parseIdentifier('label:person'), row, 'p', has), false);
    assert.equal(identifierMatches(parseIdentifier('label:name'), row, 'n', has), false);
    const types = { t: TypeDBLiteValue.type('person'), r: TypeDBLiteValue.type('employment:employee') };
    assert.equal(identifierMatches(parseIdentifier('label:person'), types, 't', has), true);
    assert.equal(identifierMatches(parseIdentifier('label:writer'), types, 't', has), false);
    assert.equal(identifierMatches(parseIdentifier('label:employment:employee'), types, 'r', has), true);
    assert.equal(identifierMatches(parseIdentifier('key:ref:1'), types, 't', has), false, 'a type is not a thing');
    assert.throws(() => types.t.asString(), /Cannot extract string from type/);
  });

  it('a variable absent from the row never matches', () => {
    assert.equal(identifierMatches(parseIdentifier('value:integer:1'), row, 'missing', has), false);
  });

  it('none matches an absent variable and nothing present — Phase 06', () => {
    assert.equal(identifierMatches(parseIdentifier('none'), row, 'missing', has), true);
    assert.equal(identifierMatches(parseIdentifier('none'), row, 'r', has), false);
    assert.equal(identifierMatches(parseIdentifier('none'), row, 'p', has), false);
  });

  it('value:double: meets the spec\'s four written decimals, relatively, and no looser — reduce L203', () => {
    const mean = { m: TypeDBLiteValue.value('double', '16.666666666666668'), z: TypeDBLiteValue.value('double', '0.00004') };
    assert.equal(identifierMatches(parseIdentifier('value:double:16.6667'), mean, 'm', has), true);
    assert.equal(identifierMatches(parseIdentifier('value:double:16.667'), mean, 'm', has), false);
    assert.equal(identifierMatches(parseIdentifier('value:double:16.6666'), mean, 'm', has), false);
    // An expected zero is not met by a small non-zero (review, round 10).
    assert.equal(identifierMatches(parseIdentifier('value:double:0.0'), mean, 'z', has), false);
  });

  it('uniquely identify is a bijection, not a subset', () => {
    const answers = { rows: [row, { ...row }], query: 'match $p isa person, has name $n, has ref $r;', has };
    // Two identical answers, one table row: the row identifies two answers — refused.
    assert.throws(() => uniquelyIdentify([['n'], ['attr:name:Alice']], answers), /expected 1 answer/);
    assert.throws(
      () => uniquelyIdentify([['n'], ['attr:name:Alice'], ['attr:name:Alice']], answers),
      /identifies 2 answer/,
    );
  });
});

describe('a scenario cannot pass without reaching its assertion', () => {
  it('fails on an undefined step, and says which', () => {
    const [result] = runFeature(feature(scenario('x', [step('typedb starts'), step('typeql delete')])), noDeclarations);
    assert.equal(result.outcome, 'fail');
    assert.equal(result.failure?.undefinedStep, true);
    assert.equal(result.failure?.step.text, 'typeql delete');
  });

  it('fails in the Background, attributed to the Background step', () => {
    const bg = step('connection open schema transaction for database: nope', { fromBackground: true });
    const [result] = runFeature(feature(scenario('x', [bg, step('answer size is: 0')])), noDeclarations);
    assert.equal(result.outcome, 'fail');
    assert.equal(result.failure?.step.fromBackground, true);
  });

  it('a "fails" step passes only when the query actually throws', () => {
    const passes = scenario('throws', [
      ...open('schema'),
      step('typeql schema query', { docString: SCHEMA }),
      // A refusal the engine makes AFTER parsing — an attribute the schema never defined. Not a
      // parse error (see the next test), and not an undefined supertype, which TypeDBLite applies
      // silently (`d-20260911-define-accepts-a-supertype-that-does`) — a finding, not a fixture.
      step('typeql read query; fails', { docString: 'match $p isa person, has no-such-thing $x; select $x;' }),
    ]);
    const doesNot = scenario('does not throw', [
      ...open('schema'),
      step('typeql schema query; fails', { docString: SCHEMA }),
    ]);
    const [a, b] = runFeature(feature(passes, doesNot), noDeclarations);
    assert.equal(a.outcome, 'pass');
    assert.equal(b.outcome, 'fail');
    assert.match(b.failure?.reason ?? '', /expected the query to fail/);
  });

  it('a "fails" step is NOT satisfied by a parse failure — that is what "parsing fails" is for', () => {
    // The first report card had three "passes" of exactly this shape: `let $doc = get_fun_doc(…)`
    // fails on TypeDB because the function does not exist, and "failed" here because the parser
    // stopped at `let`. Both failed; only one of them is the behaviour the scenario specifies.
    const [result] = runFeature(
      feature(scenario('x', [...open('schema'), step('typeql schema query; fails', { docString: 'define entity;' })])),
      noDeclarations,
    );
    assert.equal(result.outcome, 'fail');
    assert.match(result.failure?.reason ?? '', /failed to parse/);
  });

  it('a "fails" step is NOT satisfied by the engine refusing a stage it does not implement', () => {
    // Phase 04 added `undefine` and `redefine` to the grammar before the interpreter had them.
    // The statement parses and TypeDB would evaluate it; "not implemented" is a refusal of the
    // engine's, not the failure the scenario specifies — the same species as a parse failure.
    // Both stages are implemented now, so the refusal comes from a stub that throws the code —
    // the `SilentEngine` shape the evaluated-nothing guards are proved against.
    class UnimplementingEngine extends TypeDBLiteInterpreter {
      constructor() {
        super(':memory:');
      }
      override define(): ReturnType<TypeDBLiteInterpreter['define']> {
        const message = 'TypeDBLite does not implement `undefine` yet';
        throw attachDiagnostic(new Error(message), {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          severity: 1,
          code: DiagnosticCode.notImplemented,
          message,
          source: 'typedblite',
        });
      }
    }
    const world = new World(() => new UnimplementingEngine());
    world.createDatabase('typedb');
    world.openTransaction('schema', 'typedb');
    const fails = findStep('typeql schema query; fails');
    assert.throws(
      () => fails.definition.run(world, fails.match, step('typeql schema query; fails', { docString: 'undefine person;' })),
      /does not implement this statement/,
    );
  });

  it('a "parsing fails" step is NOT satisfied by a parser that does not know the statement at all', () => {
    // Checkpoint 2 of Phase 01 had eleven `redefine` scenarios passing their `parsing fails`
    // steps because TypeDBLite had no `redefine` — the parser stopped at the first token, not at
    // the construct the scenario is about. TypeDB's parse failure is inside a statement it knows.
    // ⚠️ `redefine` was the fixture until Phase 04 gave the grammar the stage. A word the grammar
    // lacks still lexes as an ID (`fun f()` fails at `f`), so the fixture opens with a character
    // the lexer has no token for — a block `{`, which the parser stops on at offset 0.
    const unknownStatement = scenario('block', [
      ...open('schema'),
      step('typeql schema query; parsing fails', { docString: '{ $x isa person; };' }),
    ]);
    const genuine = scenario('inside define', [
      ...open('schema'),
      step('typeql schema query; parsing fails', { docString: 'define entity person plays company;' }),
    ]);
    const leadingComment = scenario('leading comment', [
      ...open('schema'),
      step('typeql schema query; parsing fails', { docString: '# a comment first\n  { $x isa person; };' }),
    ]);
    const [a, b, c] = runFeature(feature(unknownStatement, genuine, leadingComment), noDeclarations);
    assert.equal(a.outcome, 'fail');
    assert.match(a.failure?.reason ?? '', /does not know this statement/);
    assert.equal(b.outcome, 'pass', b.failure?.reason);
    assert.equal(c.outcome, 'fail');
    assert.match(c.failure?.reason ?? '', /does not know this statement/);
  });

  it('a scenario with no steps is not-applicable, never a pass', () => {
    // `negation.feature` has `Scenario: Nested negations` with a `# TODO` and nothing else. Gherkin
    // gives it a pickle with no steps, and a pass for running nothing would be a hollow one.
    const [result] = runFeature(feature(scenario('empty', [])), noDeclarations);
    assert.equal(result.outcome, 'not-applicable');
  });

  it('a query with no open transaction fails, as it would at the server', () => {
    const [result] = runFeature(
      feature(scenario('x', [step('connection create database: typedb'), step('typeql schema query', { docString: SCHEMA })])),
      noDeclarations,
    );
    assert.equal(result.outcome, 'fail');
    assert.match(result.failure?.reason ?? '', /no open transaction/);
  });

  it('a write in a read transaction fails, as it would at the server', () => {
    const [result] = runFeature(
      feature(scenario('x', [...open('read'), step('typeql write query', { docString: 'insert $p isa person;' })])),
      noDeclarations,
    );
    assert.equal(result.outcome, 'fail');
    assert.match(result.failure?.reason ?? '', /not permitted in a read transaction/);
  });

  it('a read that evaluated nothing is a failure, not an empty answer set', () => {
    // `d-20260911-a-match-pipeline-with-no-select`: query() used to skip a select-less pipeline,
    // and 114 scenarios assert `answer size is: 0` and nothing else — an empty set from a skipped
    // query would have passed every one of them hollowly. The skip is fixed; the guard is not
    // relaxed. It is proved here against an engine that projects nothing and says nothing.
    const world = new World(() => new SilentEngine());
    world.createDatabase('typedb');
    world.openTransaction('read', 'typedb');
    assert.throws(() => world.readQuery('match $p isa person;'), /evaluated nothing/);
  });

  it('a write that evaluated nothing is a failure too', () => {
    // execute() skips a pipeline with no write stage the same way.
    const [result] = runFeature(
      feature(scenario('x', [
        ...open('schema'),
        step('typeql schema query', { docString: SCHEMA }),
        step('typeql write query', { docString: 'match $p isa person;' }),
      ])),
      noDeclarations,
    );
    assert.equal(result.outcome, 'fail');
    assert.match(result.failure?.reason ?? '', /evaluated nothing/);
  });

  it('answers of a write are the engine\'s — the row it wrote, never an invented empty set', () => {
    const run = (size: number) =>
      runFeature(
        feature(scenario('x', [
          ...open('schema'),
          step('typeql schema query', { docString: SCHEMA }),
          step('get answers of typeql write query', { docString: 'insert $p isa person, has ref 1;' }),
          step(`answer size is: ${size}`),
        ])),
        noDeclarations,
      )[0];
    assert.equal(run(1).outcome, 'pass');
    // 🔴 The shape this test used to guard: `update.feature` asserts `answer size is: 0` after a
    // write, which an invented empty set would satisfy. The insert answered one row.
    assert.equal(run(0).outcome, 'fail');
  });

  it('"evaluated nothing" does not satisfy a "fails" step either — the hollow pass must not move over', () => {
    // Round 2 found the guard above turned `typeql read query; fails` on a select-less match into a
    // pass: the harness threw, and expectFailure took any non-parse throw as the specified failure.
    // The read half runs against the silent engine; the write half against the real one, whose
    // execute() still skips a pipeline with no write stage.
    const world = new World(() => new SilentEngine());
    world.createDatabase('typedb');
    world.openTransaction('read', 'typedb');
    const read = findStep('typeql read query; fails');
    assert.throws(
      () => read.definition.run(world, read.match, step('typeql read query; fails', { docString: 'match $p isa person;' })),
      /evaluated nothing/,
    );

    const [write] = runFeature(
      feature(
        scenario('write', [
          ...open('schema'),
          step('typeql schema query', { docString: SCHEMA }),
          step('typeql write query; fails', { docString: 'match $p isa person;' }),
        ]),
      ),
      noDeclarations,
    );
    assert.equal(write.outcome, 'fail');
    assert.match(write.failure?.reason ?? '', /evaluated nothing/);
  });

  it('a write whose match bound nothing ran zero times — which is a success, as on TypeDB', () => {
    const [result] = runFeature(
      feature(scenario('x', [
        ...open('schema'),
        step('typeql schema query', { docString: SCHEMA }),
        step('typeql write query', { docString: 'match $p isa person, has full-name "nobody"; insert $p has full-name "x";' }),
      ])),
      noDeclarations,
    );
    assert.equal(result.outcome, 'pass', result.failure?.reason);
  });

  it('the whole vocabulary that survey found is defined, except what is deliberately not', () => {
    for (const text of [
      'typedb starts',
      'connection opens with default authentication',
      'connection has 0 databases',
      'connection create database: typedb',
      'connection open schema transaction for database: typedb',
      'typeql schema query',
      'typeql schema query; fails',
      'typeql schema query; parsing fails',
      'typeql schema query; fails with a message containing: "x"',
      'transaction commits',
      'transaction commits; fails',
      'transaction closes',
      'get answers of typeql read query',
      'get answers of typeql write query',
      'answer size is: 3',
      'uniquely identify answer concepts',
      'order of answer concepts is',
      "result is a single row with variable 'count': value:integer:6",
      'verify answer set is equivalent for query',
      'answer contains document:',
      'set time-zone: Europe/London',
      // The five `given rows` forms — given.feature.
      'set query given rows',
      'get answers of typeql read query with given rows',
      'get answers of typeql write query with given rows',
      'typeql read query with given rows; fails with a message containing: "x"',
      'typeql write query with given rows; fails with a message containing: "x"',
      // The templated steps — `<answer.x.iid>` replaced as TypeDB's `apply_query_template` does.
      'each answer satisfies',
      'get answers of templated typeql read query',
    ]) {
      assert.doesNotThrow(() => findStep(text), text);
    }
    for (const text of ['typeql delete']) {
      assert.throws(() => findStep(text), UndefinedStep, text);
    }
  });
});

describe('documents are compared as TypeDB compares them', () => {
  // `typedb/typedb` tests/behaviour/steps/util.rs, `jsons_equal_up_to_reorder` — read 2026-11-11.
  const FETCH = `define
attribute ref, value integer;
attribute nick, value string;
attribute karma, value double;
entity person, owns ref @key, owns nick @card(0..), owns karma;`;
  const outcome = (fetch: string, assertion: string, expected: string) =>
    runFeature(
      feature(scenario('x', [
        ...open('schema'),
        step('typeql schema query', { docString: FETCH }),
        step('typeql write query', { docString: 'insert $p isa person, has ref 1, has nick "a", has nick "b", has karma 123.4567891;' }),
        step('get answers of typeql read query', { docString: fetch }),
        step(assertion, { docString: expected }),
      ])),
      noDeclarations,
    )[0];

  it('a number is within 1e-10, absolutely — f64 arithmetic is not the written decimal', () => {
    const fetch = 'match $p isa person, has karma $k; fetch { "k": $k - 100 };';
    assert.equal(outcome(fetch, 'answer contains document:', '{ "k": 23.4567891 }').outcome, 'pass');
    assert.equal(outcome(fetch, 'answer contains document:', '{ "k": 23.4567892 }').outcome, 'fail');
  });

  it('a list is a multiset; an object’s keys are unordered', () => {
    const fetch = 'match $p isa person; fetch { "r": $p.ref, "n": [ $p.nick ] };';
    assert.equal(outcome(fetch, 'answer contains document:', '{ "n": [ "b", "a" ], "r": 1 }').outcome, 'pass');
    assert.equal(outcome(fetch, 'answer contains document:', '{ "n": [ "a", "a" ], "r": 1 }').outcome, 'fail');
    assert.equal(outcome(fetch, 'answer does not contain document:', '{ "n": [ "a" ], "r": 1 }').outcome, 'pass');
  });

  it('a document assertion is never satisfied by rows — "does not contain" would be vacuous', () => {
    const result = outcome('match $p isa person;', 'answer does not contain document:', '{ "r": 1 }');
    assert.equal(result.outcome, 'fail');
    assert.match(result.failure?.reason ?? '', /rows, not documents/);
  });
});

describe('the four outcomes', () => {
  const failing = () =>
    scenario('fails by design', [...open('schema'), step('typeql schema query; fails', { docString: SCHEMA })]);

  it('a declared deviation with a resolving owner is a deviation; without one it is a fail', () => {
    const deviation = { feature: 'query/language/probe.feature', scenario: 'fails by design', reason: 'r', owner: 'adr-002' };
    const [resolved] = runFeature(feature(failing()), { deviations: [deviation], notApplicable: [], ownerResolves: () => true });
    const [unresolved] = runFeature(feature(failing()), { deviations: [deviation], notApplicable: [], ownerResolves: () => false });
    assert.equal(resolved.outcome, 'deviation');
    assert.equal(unresolved.outcome, 'fail');
  });

  it('a deviation that passes is reported as now passing', () => {
    const passing = scenario('fails by design', [...open('schema'), step('typeql schema query', { docString: SCHEMA })]);
    const deviation = { feature: 'query/language/probe.feature', scenario: 'fails by design', reason: 'r', owner: 'adr-002' };
    const [result] = runFeature(feature(passing), { deviations: [deviation], notApplicable: [], ownerResolves: () => true });
    assert.equal(result.outcome, 'pass');
    assert.equal(result.deviationNowPassing, true);
  });

  it('a deviation must name a scenario that exists, unambiguously', () => {
    const twice = feature(failing(), failing());
    const entry = { feature: 'query/language/probe.feature', scenario: 'fails by design', reason: 'r', owner: 'adr-002' };
    assert.throws(() => validateDeviations([twice], [entry]), /names 2 scenarios/);
    assert.throws(
      () => validateDeviations([twice], [{ ...entry, scenario: 'no such scenario' }]),
      /names no scenario/,
    );
    assert.doesNotThrow(() => validateDeviations([feature(failing())], [entry]));
    // Duplicate names exist in the pin (fetch, define, update, the redefine outlines): a line
    // disambiguates, and must itself match.
    const withLines = feature({ ...failing(), line: 10 }, { ...failing(), line: 20 });
    assert.doesNotThrow(() => validateDeviations([withLines], [{ ...entry, line: 10 }]));
    assert.throws(() => validateDeviations([withLines], [{ ...entry, line: 30 }]), /names no scenario/);
  });

  it('not-applicable is decided by step pattern, before running', () => {
    const [result] = runFeature(feature(failing()), {
      deviations: [],
      notApplicable: [{ pattern: '^connection create database', reason: 'r' }],
      ownerResolves: () => true,
    });
    assert.equal(result.outcome, 'not-applicable');
    assert.equal(result.failure, undefined);
  });

  it('the sum rule refuses a card whose outcomes do not add up', () => {
    assert.throws(
      () => checkSums({ features: [{ feature: 'x', pass: 1, fail: 0, deviation: 0, notApplicable: 0, total: 2 }], totals: { feature: 'total', pass: 1, fail: 0, deviation: 0, notApplicable: 0, total: 1 } }),
      /outcomes sum to 1, scenario count is 2/,
    );
  });

  it('a regression is a pass count below baseline, or a feature the baseline forgot', () => {
    const card = reportCard(runFeature(feature(failing()), noDeclarations));
    assert.deepEqual(regressions(card, { probe: 0 }), []);
    assert.deepEqual(regressions(card, { probe: 1 }), ['probe: 0 pass, baseline 1']);
    assert.deepEqual(regressions(card, {}), ['probe: no baseline entry']);
    assert.deepEqual(regressions(card, { probe: 0, ghost: 0 }), ['ghost: in the baseline, but no such feature ran']);
  });

  it('an improvement that did not raise the baseline is reported, not absorbed by the floor', () => {
    const passes = scenario('passes', [...open('schema'), step('typeql schema query', { docString: SCHEMA })]);
    const card = reportCard(runFeature(feature(passes), noDeclarations));
    assert.deepEqual(unraised(card, { probe: 1 }), []);
    assert.deepEqual(unraised(card, { probe: 0 }), ['probe: 1 pass, baseline 0 — raise it']);
    // A missing entry is a regression's business, not this one's.
    assert.deepEqual(unraised(card, {}), []);
  });
});

describe('the world', () => {
  it('closes its engines', () => {
    const world = new World();
    world.createDatabase('a');
    world.createDatabase('b');
    assert.equal(world.databaseCount(), 2);
    assert.throws(() => world.createDatabase('a'), /already exists/);
    world.close();
    assert.equal(world.databaseCount(), 0);
  });
});

/**
 * 🔴 Every step's own refusal, driven. Conformance passes, so on a green run none of these branches
 * ever runs, and a step that cannot fail would score a scenario it never checked. Each scenario here
 * is built so its step must fail, and is checked to fail for the step's own reason.
 */
describe('every check the steps make can fail', () => {
  const failsWith = (steps: SpecStep[], reason: RegExp) => {
    const [result] = runFeature(feature(scenario('x', steps)), noDeclarations);
    assert.equal(result.outcome, 'fail', `expected a failure matching ${reason}`);
    assert.match(result.failure?.reason ?? '', reason);
  };
  const schema = [...open('schema'), step('typeql schema query', { docString: SCHEMA }), step('transaction commits')];

  it('connection has N databases refuses another count', () => {
    failsWith([step('connection create database: typedb'), step('connection has 2 databases')], /expected 2 database\(s\), have 1/);
  });

  it('parsing fails refuses a query that parses and fails for another reason', () => {
    failsWith(
      [...schema, ...open('write').slice(1), step('typeql write query; parsing fails', { docString: 'insert $p isa nobody;' })],
      /expected a parse failure/,
    );
  });

  it('fails with a message containing refuses a failure with another message', () => {
    failsWith(
      [...schema, ...open('write').slice(1), step('typeql write query; fails with a message containing: "zebra"', { docString: 'insert $p isa nobody;' })],
      /expected a failure containing "zebra"/,
    );
  });

  it('answers do not contain variable refuses an answer that contains it', () => {
    failsWith(
      [
        ...schema,
        ...open('write').slice(1),
        step('typeql write query', { docString: 'insert $p isa person, has ref 1, has full-name "Ann";' }),
        step('get answers of typeql read query', { docString: 'match $p isa person, has full-name $n; select $n;' }),
        step('answers do not contain variable: n'),
      ],
      /an answer contains variable 'n'/,
    );
  });

  it('a templated query refuses to template from anything but exactly one answer', () => {
    failsWith(
      [
        ...schema,
        ...open('read').slice(1),
        step('get answers of typeql read query', { docString: 'match $p isa person; select $p;' }),
        step('get answers of templated typeql read query', { docString: 'match $p isa person; select $p;' }),
      ],
      /expected a single answer to template from, found 0/,
    );
  });
});

describe('the failure digest', () => {
  it('counts an undefined step under its own heading, apart from the steps that failed', () => {
    const results = runFeature(
      feature(scenario('a', [step('typedb starts'), step('typeql delete')]), scenario('b', [step('typedb starts'), step('typeql delete')])),
      noDeclarations,
    );
    const digest = renderFailureDigest(results);
    assert.match(digest, /Undefined steps \(2 scenario\(s\)\)\n {5}2 {2}typeql delete/);
    assert.match(digest, /Stopped in a scenario step \(0 scenario\(s\)\)/);
  });
});

describe('the answer identifiers cannot be misread', () => {
  it('refuses an identifier kind it does not know', () => {
    assert.throws(() => parseIdentifier('iid:0x1'), /unknown answer identifier 'iid:0x1'/);
  });

  it('refuses a table whose row count differs from the answers', () => {
    assert.throws(() => uniquelyIdentify([['p'], ['key:ref:1'], ['key:ref:2']], { rows: [], has: () => [] }), /expected 2 answer\(s\), got 0/);
  });

  it('compares durations by value, as the driver does', () => {
    const row = { d: TypeDBLiteValue.attribute('span', 'P462D') };
    const typed = () => 'duration';
    assert.equal(identifierMatches(parseIdentifier('attr:span:P66W'), row, 'd', () => [], typed), true);
    assert.equal(identifierMatches(parseIdentifier('attr:span:P67W'), row, 'd', () => [], typed), false);
  });
});
