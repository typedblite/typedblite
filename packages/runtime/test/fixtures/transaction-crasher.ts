/**
 * A producer's state-plus-event write in one transaction, as its own process, killed on purpose.
 *
 * SIGKILL rather than `process.exit`: exit runs handlers and could let SQLite tidy up, which would
 * test a graceful close. Modes:
 *   kill-between  state written, killed before the event is written
 *   kill-before-commit  state and event written, killed before COMMIT
 *   commit        both written and committed (the control: the pair is distinguishable from a crash)
 */
import { SqliteEngine } from '../../src/sqlite-engine.js';

const [, , dbPath, mode] = process.argv;
const engine = new SqliteEngine(dbPath);

const insert = (id: string) =>
  `insert $s isa skill, has skill-id "${id}", has skill-name "${id}";`;

await engine.transaction(async () => {
  await engine.execute(insert('state-1'));
  if (mode === 'kill-between') process.kill(process.pid, 'SIGKILL');
  await engine.execute(insert('event-1'));
  if (mode === 'kill-before-commit') process.kill(process.pid, 'SIGKILL');
});
await engine.close();
