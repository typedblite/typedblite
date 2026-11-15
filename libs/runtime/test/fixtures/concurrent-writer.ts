/**
 * Inserts a run of projects into a shared file database, as its own OS process.
 *
 * 🔴 Separate processes are the point. PouchDB's memory adapter shares a database between
 * same-named instances in one process, and the same class of mistake here — two interpreters on one
 * database handle — would prove nothing about concurrency.
 */
import { TypeDBLiteInterpreter } from '../../src/interpreter.js';
import { readKeyedTrackerSchema } from './keyed-tracker-schema.js';

const [, , dbPath, schemaPath, prefix, countText] = process.argv;
const db = new TypeDBLiteInterpreter(dbPath);
db.define(readKeyedTrackerSchema(schemaPath));
for (let i = 0; i < Number(countText); i += 1) {
  db.execute(
    `insert $s isa project, has project-id "${prefix}-${i}", has project-name "${prefix}";`,
  );
}
db.close();
