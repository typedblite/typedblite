/**
 * Opens a transaction on the file, writes, says it is holding the write lock, waits, then commits.
 * The parent's own write must wait for this commit rather than fail with SQLITE_BUSY.
 */
import { SqliteEngine } from '../../src/sqlite-engine.js';

const [, , dbPath] = process.argv;
const engine = new SqliteEngine(dbPath);

await engine.transaction(async () => {
  await engine.execute('insert $s isa skill, has skill-id "held", has skill-name "held";');
  process.stdout.write('holding\n');
  await new Promise((resolve) => setTimeout(resolve, 800));
});
await engine.close();
