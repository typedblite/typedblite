/**
 * Writes into an open transaction, then kills itself before COMMIT.
 *
 * SIGKILL rather than `process.exit`: exit runs handlers and could let SQLite tidy up, which would
 * test a graceful close instead of a crash. The point is that a process which dies mid-write leaves
 * neither the data nor its log row behind — they are in one transaction, so they cannot disagree.
 */
import { TypeDBLiteInterpreter } from '../../src/interpreter.js';
import { readKeyedSkillsSchema } from './keyed-skills-schema.js';
import { killSelf } from './kill-self.js';

const [, , dbPath, schemaPath] = process.argv;
const db = new TypeDBLiteInterpreter(dbPath);
db.define(readKeyedSkillsSchema(schemaPath));
db.execute('insert $s isa skill, has skill-id "before-crash", has skill-name "A";');

// Open a transaction, write inside it, and die before it closes.
const raw = (db as unknown as { db: { exec(sql: string): void } }).db;
raw.exec('BEGIN');
raw.exec("INSERT INTO thing(type) VALUES ('skill')");
raw.exec("INSERT INTO change_log(entity_id, rev, deleted) VALUES ('skill/crashed', '1-dead', 0)");
killSelf();
