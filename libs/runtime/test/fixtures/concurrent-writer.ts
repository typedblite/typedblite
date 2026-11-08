/**
 * Inserts a run of skills into a shared file database, as its own OS process.
 *
 * 🔴 Separate processes are the point. PouchDB's memory adapter shares a database between
 * same-named instances in one process, and the same class of mistake here — two interpreters on one
 * database handle — would prove nothing about concurrency.
 */
import { TypeDBLiteInterpreter } from '../../src/interpreter.js';
import { readKeyedSkillsSchema } from './keyed-skills-schema.js';

const [, , dbPath, schemaPath, prefix, countText] = process.argv;
const db = new TypeDBLiteInterpreter(dbPath);
db.define(readKeyedSkillsSchema(schemaPath));
for (let i = 0; i < Number(countText); i += 1) {
  db.execute(
    `insert $s isa skill, has skill-id "${prefix}-${i}", has skill-name "${prefix}";`,
  );
}
db.close();
