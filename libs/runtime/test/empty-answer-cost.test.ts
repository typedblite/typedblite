/**
 * An empty answer explains itself (`noCandidates`) without reading the type into memory.
 *
 * 🔴 The fact states two counts, and they used to be taken by running `candidates()` again and
 * taking `.length` — every instance of the type read into rows, on every empty answer. Empty
 * answers are routine: downstream-app reads each optional attribute with a query of its own, and most
 * rows lack most of them. At 125,000 entities that was 27 ms per empty read
 * (docs/development/performance.md). The counts are now SQL `COUNT(*)`, and these tests hold the
 * message to the same numbers.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { DiagnosticCode } from '../src/diagnostics.js';

const store = (): TypeDBLiteInterpreter => {
  const db = new TypeDBLiteInterpreter(':memory:', 5000, { trace: true });
  db.define('define entity entry, owns entry-id @key, owns owner-ref, owns note; attribute entry-id, value string; attribute owner-ref, value string; attribute note, value string;');
  db.beginTransaction();
  for (let i = 0; i < 300; i++) db.execute(`insert $e isa entry, has entry-id "e${i}", has owner-ref "w${i % 10}"${i === 0 ? ', has note "only one"' : ''};`);
  db.commitTransaction();
  return db;
};

const facts = (report: { diagnostics: readonly { code?: unknown; message: string }[] }): string[] =>
  report.diagnostics.filter((d) => d.code === DiagnosticCode.noCandidates).map((d) => d.message);

describe('an empty answer is explained without reading the type', () => {
  it('🔴 reads no candidate rows beyond the query itself for an optional attribute most rows lack', () => {
    const db = store();
    const report = db.query('match $e isa entry, has entry-id $id, has owner-ref "w3", has note $n; select $id, $n;');
    assert.equal(report.rows.length, 0);
    const trace = db.lastQueryTrace();
    // The query's own lookup reads nothing (no `w3` entry has a note). The 300 entries are counted, not read.
    assert.equal(trace?.candidateRows, 0, `candidate rows read: ${trace?.candidateRows}`);
    assert.deepEqual(facts(report), ["`isa entry` matched 300 candidate(s) before the constraints on '$e', and 0 after."]);
    db.close();
  });

  it('states the same counts as before: nothing of the type, and a type its pattern excluded', () => {
    const db = store();
    db.define('define entity other, owns note;');
    assert.deepEqual(facts(db.query('match $o isa other, has note $n; select $n;')), ["`isa other` matched 0 candidate(s) before the constraints on '$o', and 0 after."]);
    assert.deepEqual(facts(db.query('match $e isa entry, has entry-id "absent"; select $e;')), ["`isa entry` matched 300 candidate(s) before the constraints on '$e', and 0 after."]);
    db.close();
  });
});
