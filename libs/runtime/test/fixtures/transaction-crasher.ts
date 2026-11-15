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
import { killSelf } from './kill-self.js';

const [, , dbPath, mode] = process.argv;
const engine = new SqliteEngine(dbPath);

const insert = (id: string) =>
  `insert $s isa project, has project-id "${id}", has project-name "${id}";`;

await engine.transaction(async () => {
  await engine.execute(insert('state-1'));
  if (mode === 'kill-between') killSelf();
  await engine.execute(insert('event-1'));
  if (mode === 'kill-before-commit') killSelf();
});
await engine.close();
