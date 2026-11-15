import { afterEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';

/**
 * The query trace: a per-`query()` account of the work the engine
 * did, so a regression test can assert COUNTS rather than a wall-clock time. Off by default, and
 * `lastQueryTrace()` answers `undefined` then — a disabled trace must not look like a zero one.
 */
const SCHEMA = [
  'define',
  'attribute node-id, value string;',
  'entity node, owns node-id @key, plays link:source, plays link:target;',
  'relation link, relates source, relates target;',
].join('\n');

const seed = (engine: TypeDBLiteInterpreter): void => {
  engine.define(SCHEMA);
  engine.execute('insert $n isa node, has node-id "a";');
  engine.execute('insert $n isa node, has node-id "b";');
  engine.execute('match $s isa node, has node-id "a"; $t isa node, has node-id "b"; insert (source: $s, target: $t) isa link;');
};
const QUERY = 'match $s isa node; $t isa node; (source: $s, target: $t) isa link; select $s, $t;';

const saved = process.env['TYPEDBLITE_TRACE'];
afterEach(() => {
  if (saved === undefined) delete process.env['TYPEDBLITE_TRACE'];
  else process.env['TYPEDBLITE_TRACE'] = saved;
});

describe('the query trace', () => {
  it('is absent when not enabled', () => {
    delete process.env['TYPEDBLITE_TRACE'];
    const engine = new TypeDBLiteInterpreter(':memory:');
    seed(engine);
    engine.query(QUERY);
    assert.equal(engine.lastQueryTrace(), undefined);
  });

  it('counts the last query only, when enabled by option', () => {
    delete process.env['TYPEDBLITE_TRACE'];
    const engine = new TypeDBLiteInterpreter(':memory:', 5000, { trace: true });
    seed(engine);
    const { rows } = engine.query(QUERY);
    assert.equal(rows.length, 1);
    const trace = engine.lastQueryTrace();
    assert.ok(trace);
    assert.ok(trace.candidatesCalls >= 2, 'one candidate lookup per thing variable');
    assert.ok(trace.candidateRows >= 2);
    assert.ok(trace.relationHoldsCalls >= 1, 'the relation constraint is evaluated');
    assert.ok(trace.statementsPrepared >= 1 && trace.statementsExecuted >= trace.statementsPrepared);
    assert.ok(trace.stages.length >= 2);
    assert.equal(trace.combinationsCreated, trace.stages.reduce((n, s) => n + s.combinations, 0));
    // A second query replaces the first's counts rather than adding to them.
    engine.query('match $n isa node; select $n;');
    const second = engine.lastQueryTrace();
    assert.ok(second);
    assert.equal(second.relationHoldsCalls, 0);
    assert.ok(second.candidatesCalls < trace.candidatesCalls + 1);
  });

  it('is enabled by TYPEDBLITE_TRACE=1', () => {
    process.env['TYPEDBLITE_TRACE'] = '1';
    const engine = new TypeDBLiteInterpreter(':memory:');
    seed(engine);
    engine.query(QUERY);
    assert.ok(engine.lastQueryTrace());
  });
});
