/**
 * An empty answer explains itself (`noCandidates`) without reading the type into memory.
 *
 * 🔴 The fact states two counts, and they used to be taken by running `candidates()` again and
 * taking `.length` — every instance of the type read into rows, on every empty answer. Empty
 * answers are routine: a production application reads each optional attribute with a query of its own, and most
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

  it('🔴 does not read every relation of a type to explain an empty answer that joins through one', () => {
    // Found by the load test: a project's sub-projects took 0.9 ms when there was one and 21 ms when there
    // was none, at 3,000 projects. Explaining the empty answer asked "does any relation of this type
    // exist?" by reading all of them. It now stops at the first.
    const db = new TypeDBLiteInterpreter(':memory:', 5000, { trace: true });
    db.define(
      'define entity project, owns project-id @key, plays holds:owner, plays nests:child; entity task, owns task-id @key, plays holds:task, plays nests:parent;' +
        ' relation holds, relates owner, relates task; relation nests, relates parent, relates child; attribute project-id, value string; attribute task-id, value string;',
    );
    db.beginTransaction();
    for (let p = 0; p < 60; p++) {
      db.execute(`insert $p isa project, has project-id "p${p}";`);
      for (let t = 0; t < 5; t++) {
        db.execute(`match $p isa project, has project-id "p${p}"; insert $t isa task, has task-id "p${p}:${t}"; (owner: $p, task: $t) isa holds;`);
      }
      // Every project but the first nests the one before it, so `p0` has tasks and no nested project.
      if (p > 0) db.execute(`match $t isa task, has task-id "p${p}:0"; $c isa project, has project-id "p${p - 1}"; insert (parent: $t, child: $c) isa nests;`);
    }
    db.commitTransaction();

    const nested = (id: string): string =>
      `match $p isa project, has project-id "${id}"; $t isa task, has task-id $i; (owner: $p, task: $t) isa holds; $c isa project, has project-id $cid; $r isa nests (parent: $t, child: $c); select $i, $cid;`;
    assert.equal(db.query(nested('p7')).rows.length, 1);
    const found = db.lastQueryTrace()?.relationRows ?? Number.NaN;
    assert.equal(db.query(nested('p0')).rows.length, 0);
    const empty = db.lastQueryTrace()?.relationRows ?? Number.NaN;
    // 300 `holds` and 59 `nests` relations exist. The empty answer may read a few more rows than the
    // matching one, to explain itself, but nothing near a whole relation type.
    assert.ok(empty <= found + 4, `relation rows read: ${empty} for the empty answer, ${found} for a matching one`);
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
