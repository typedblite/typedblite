/**
 * A spoke: writes locally, then replicates duplex against the hub's database file.
 *
 * 🔴 A real OS process. Two spokes in one process would share nothing but would also contend on
 * nothing, and the hub-and-spoke claim is about contention as much as convergence.
 *
 * There is no transport yet — Phase 04 adds one. A spoke reaches the hub by opening its SQLite
 * file directly, which is a genuine second writer and exercises the busy-timeout path.
 */
import { TypeDBLiteInterpreter } from '../../src/interpreter.js';
import { replicateOnce } from '../../src/replicator.js';
import { readKeyedTrackerSchema } from './keyed-tracker-schema.js';

const [, , spokePath, hubPath, schemaPath, prefix, countText] = process.argv;
const schema = readKeyedTrackerSchema(schemaPath);

const spoke = new TypeDBLiteInterpreter(spokePath);
spoke.define(schema);
for (let i = 0; i < Number(countText); i += 1) {
  spoke.execute(
    `insert $s isa project, has project-id "${prefix}-${i}", has project-name "${prefix}";`,
  );
}

const hub = new TypeDBLiteInterpreter(hubPath);
hub.define(schema);
replicateOnce(spoke.changeLog, hub.changeLog, { direction: 'duplex' });
hub.close();
spoke.close();
