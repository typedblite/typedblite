/**
 * One of several processes rewriting records in a shared file database for a fixed time, starting at
 * a shared instant — `write-lock-contention.test.ts`. Prints `{ ops, failures, error }` as JSON.
 *
 * Each write is a match, a delete and an insert: the pipeline READS before it writes, which is what
 * upgrades a deferred transaction's read lock to a write lock — the step that fails at once under
 * contention instead of waiting out the busy timeout.
 */
import { TypeDBLiteInterpreter } from '../../src/interpreter.js';

const [, , dbPath, prefix, startAtText, durationText] = process.argv;
const db = new TypeDBLiteInterpreter(dbPath);
const startAt = Number(startAtText);
while (Date.now() < startAt) {
  // Spin until the shared start, so every process contends from the same moment.
}
const end = Date.now() + Number(durationText);
let ops = 0;
let failures = 0;
let error: string | undefined;
for (let i = 0; Date.now() < end; i += 1) {
  const key = `${prefix}-${i % 20}`;
  try {
    db.execute(`match $r isa record, has record-id "${key}"; delete $r;`);
    db.execute(`insert $r isa record, has record-id "${key}", has revision ${i};`);
    ops += 1;
  } catch (caught) {
    failures += 1;
    error ??= String((caught as Error).message);
  }
}
db.close();
console.log(JSON.stringify({ ops, failures, error }));
