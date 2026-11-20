// SPIKE: run TypeDBLite in a Durable Object (`wrangler dev`: local workerd, SQLite-backed objects) and check it
// against node:sqlite. Prints one line per check, then the numbers. Exits 1 if any check fails.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { programs, runOnNode } from './dist/node-baseline.mjs';

const here = new URL('.', import.meta.url).pathname;
const root = join(here, '../..');
const persist = mkdtempSync(join(tmpdir(), 'typedblite-do-'));
const results = [];
const numbers = {};

function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const port = 8799;

/** `wrangler dev` on the built Worker, its Durable Object storage in `persist`. Resolves when it is ready. */
function start() {
  const child = spawn(
    join(here, 'node_modules/.bin/wrangler'),
    ['dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist, '--log-level', 'warn'],
    { cwd: here, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
  );
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const ready = (async () => {
    for (let i = 0; i < 120; i++) {
      if (child.exitCode !== null) throw new Error(`wrangler dev exited:\n${log}`);
      try {
        await fetch(`http://127.0.0.1:${port}/`);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw new Error(`wrangler dev did not start:\n${log}`);
  })();
  return {
    ready,
    log: () => log,
    async dispose() {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGINT');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

let mf = start();
await mf.ready;
async function call(store, operation, text, extra = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/store/${store}/${operation}`, {
    method: operation === 'stats' ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: operation === 'stats' ? undefined : JSON.stringify({ text, ...extra }),
  });
  return response.json();
}

/** The first path at which two values differ, for a failing parity check. */
function firstDifference(a, b, path = '$') {
  if (isDeepStrictEqual(a, b)) return undefined;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return `${path}: node ${JSON.stringify(a)?.slice(0, 160)} vs DO ${JSON.stringify(b)?.slice(0, 160)}`;
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = firstDifference(a[key], b[key], `${path}.${key}`);
    if (d) return d;
  }
  return `${path}: differ`;
}

try {
  // 1. Parity: the playground's examples and the two notebooks, on node:sqlite and in a Durable Object.
  let n = 0;
  for (const program of programs(root)) {
    const node = runOnNode(program.source);
    const answer = await call(`parity-${n++}`, 'program', program.source);
    const steps = node.steps.length;
    const failed = node.steps.find((s) => s.error);
    const detail = answer.ok
      ? firstDifference(node, answer.result) ?? `${steps} statements${failed ? `, both stop at line ${failed.line}` : ''}`
      : `DO threw ${answer.error.name}: ${answer.error.message}`;
    check(`parity  ${program.name}`, answer.ok && isDeepStrictEqual(node, answer.result), detail);
  }

  // 2. A schema, writes and reads over the engine's own calls.
  const schema = `define
    entity person, owns name @key, owns bio;
    attribute name, value string;
    attribute bio, value string;`;
  let r = await call('people', 'define', schema);
  check('define a schema', r.ok, r.ok ? `${r.statements} SQL statements` : r.error?.message);
  r = await call('people', 'execute', 'insert $p isa person, has name "Ada", has bio "Wrote the first program for an engine";');
  check('insert', r.ok, r.ok ? `${r.statements} SQL statements` : r.error?.message);
  r = await call('people', 'query', 'match $p isa person, has name $n; select $n;');
  check('query', r.ok && r.result.rows.length === 1 && r.result.rows[0].n.includes('Ada'), r.ok ? `${r.statements} SQL statements` : r.error?.message);

  // 3. A duplicate @key is reported as one (errcode 2067 restored from the message), and nothing of it is kept.
  r = await call('people', 'execute', 'insert $p isa person, has name "Ada";');
  check('duplicate @key is refused', !r.ok, r.ok ? 'it was accepted' : r.error.message.slice(0, 120));
  // 4. A pipeline that fails partway leaves nothing behind: two inserts, the second a duplicate key.
  r = await call(
    'people',
    'execute',
    'insert $a isa person, has name "Grace"; insert $b isa person, has name "Ada";',
  );
  const after = await call('people', 'query', 'match $p isa person, has name $n; select $n;');
  check(
    'a write that fails partway leaves nothing',
    !r.ok && after.ok && after.result.rows.length === 1,
    `${after.result?.rows?.length} person(s) after the failed write`,
  );

  // 4b. Several writes in one request, as one transaction: all kept, or none.
  r = await call('people', 'transaction', '', {
    statements: ['insert $p isa person, has name "Grace";', 'insert $p isa person, has name "Ada";'],
  });
  let count = (await call('people', 'query', 'match $p isa person, has name $n; select $n;')).result.rows.length;
  check('a transaction whose last write fails keeps none of it', !r.ok && count === 1, `${count} person(s)`);
  r = await call('people', 'transaction', '', {
    statements: ['insert $p isa person, has name "Grace";', 'insert $p isa person, has name "Linus";'],
  });
  count = (await call('people', 'query', 'match $p isa person, has name $n; select $n;')).result.rows.length;
  check('a transaction that succeeds keeps all of it', r.ok && count === 3, `${count} person(s)`);

  // 5. Full-text search over FTS5, kept by the change log.
  r = await call('people', 'search', 'engine');
  check('full-text search (FTS5)', r.ok && r.result.length === 1, r.ok ? `${r.result.length} hit(s)` : r.error?.message);

  // The binding's ledger lives in the object's memory, so read it before the restart below clears it.
  numbers.peopleBeforeRestart = (await call('people', 'stats')).result;

  // 6. Durable: stop the runtime, start a new one on the same storage, and read the store back.
  await mf.dispose();
  mf = start();
  await mf.ready;
  r = await call('people', 'query', 'match $p isa person, has name $n; select $n;');
  check('survives a restart', r.ok && r.result.rows.length === 3, r.ok ? `${r.result.rows.length} person(s)` : r.error?.message);

  // 7. Load: 200 writes and 200 reads over HTTP, timed from outside (local workerd, not production latency).
  await call('load', 'define', 'define entity task, owns title @key, owns done; attribute title, value string; attribute done, value boolean;');
  let t = performance.now();
  for (let i = 0; i < 200; i++) await call('load', 'execute', `insert $t isa task, has title "task ${i}", has done false;`);
  numbers.writeMsEach = (performance.now() - t) / 200;
  const writeStatements = (await call('load', 'execute', 'insert $t isa task, has title "one more", has done true;')).statements;
  t = performance.now();
  for (let i = 0; i < 200; i++) await call('load', 'query', `match $t isa task, has title "task ${i}", has done $d; select $d;`);
  numbers.readMsEach = (performance.now() - t) / 200;
  const readStatements = (await call('load', 'query', 'match $t isa task, has title "task 7", has done $d; select $d;')).statements;
  numbers.sqlPerWrite = writeStatements;
  numbers.sqlPerRead = readStatements;
  const all = await call('load', 'query', 'match $t isa task, has done $d; select $d;');
  numbers.sqlPerScan201 = all.statements;

  // 8. The binding's own ledger, across everything above.
  const stats = (await call('load', 'stats')).result;
  const people = numbers.peopleBeforeRestart;
  numbers.load = stats;
  check(
    'the failed writes were rolled back by the platform',
    people.unitsRolledBack === 3,
    `${people.unitsRolledBack} unit(s) of work rolled back`,
  );
  check('no partial rollbacks', stats.partialRollbacks === 0 && people.partialRollbacks === 0);
  check('no throw after a commit', stats.throwsAfterCommit === 0 && people.throwsAfterCommit === 0);
} catch (error) {
  check('the check ran to the end', false, `${error.stack ?? String(error)}\n--- wrangler ---\n${mf.log().slice(-3000)}`);
} finally {
  await mf.dispose();
  rmSync(persist, { recursive: true, force: true });
}

console.log('\nNumbers (local workerd via wrangler dev; times include the HTTP round trip):');
console.log(JSON.stringify(numbers, null, 2));
const passed = results.filter(Boolean).length;
console.log(`\n${passed} of ${results.length} checks pass`);
process.exit(passed === results.length ? 0 : 1);
