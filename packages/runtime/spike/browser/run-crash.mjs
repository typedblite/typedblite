// SPIKE — kill the browser mid-transaction and see what OPFS keeps.
//
//   node spike/browser/run-crash.mjs
//
// Mirrors test/transaction-crash.test.ts (a crash leaves both rows or neither, and the store stays
// writable) with a real SIGKILL of the whole Chromium process tree, and adds a case whose
// transaction is large enough to spill past SQLite's page cache, so a hot journal exists on OPFS
// at the moment of the kill.
import { killBrowser, startHarness, tempProfile } from './harness.mjs';
import { rmSync } from 'node:fs';

const PAGE = `<!doctype html><meta charset="utf-8"><title>crash</title><script>
const worker = new Worker('/owner-worker.js', { type: 'module' });
let next = 0; const waiting = new Map();
worker.onmessage = (e) => { const done = waiting.get(e.data.id); waiting.delete(e.data.id); done(e.data); };
worker.onerror = (e) => { for (const done of waiting.values()) done({ ok: false, error: 'worker error: ' + e.message }); };
window.rpc = (message) => new Promise((resolve) => { const id = ++next; waiting.set(id, resolve); worker.postMessage({ id, ...message }); });
</script>`;

const SCHEMA = `define
  entity skill, owns skill-id @key, owns skill-name;
  attribute skill-id, value string;
  attribute skill-name, value string;`;
const insert = (id, name = 'x') =>
  `insert $s isa skill, has skill-id "${id}", has skill-name "${name}";`;
const BASE = ['base-1', 'base-2', 'base-3'];

const harness = await startHarness({
  entries: { 'owner-worker.js': 'owner-worker.ts' },
  pages: { '/crash.html': PAGE },
  port: 8766,
});

const open = async (context) => {
  const page = await context.newPage();
  await page.goto(`${harness.origin}/crash.html`);
  return page;
};
const rpc = (page, message) => page.evaluate((m) => window.rpc(m), message);
const must = async (page, message) => {
  const reply = await rpc(page, message);
  if (!reply.ok) throw new Error(`${message.op} failed: ${reply.error}`);
  return reply;
};
const ids = async (page) =>
  (
    await must(page, {
      op: 'query',
      text: 'match $s isa skill, has skill-id $i; select $i;',
    })
  ).rows
    .map((r) => r.i)
    .sort();

// What the unfinished transaction does before the kill, and what must be there afterwards.
const scenarios = [
  {
    name: 'kill-between',
    note: 'first insert of a pair done, second not started',
    run: async (page) => {
      await must(page, { op: 'begin' });
      await must(page, { op: 'execute', text: insert('state-1') });
    },
    expect: BASE,
  },
  {
    name: 'kill-before-commit',
    note: 'both inserts done, COMMIT not sent',
    run: async (page) => {
      await must(page, { op: 'begin' });
      await must(page, { op: 'execute', text: insert('state-1') });
      await must(page, { op: 'execute', text: insert('event-1') });
    },
    expect: BASE,
  },
  {
    name: 'kill-spilled',
    note: '1,500 uncommitted rows with a 5-page cache, so pages and a hot journal reach OPFS',
    run: async (page) => {
      await must(page, { op: 'pragma', text: 'PRAGMA cache_size = 5' });
      await must(page, { op: 'begin' });
      for (let i = 0; i < 1500; i++)
        await must(page, {
          op: 'execute',
          text: insert(`spill-${i}`, 'y'.repeat(200)),
        });
    },
    expect: BASE,
    wantHotJournal: true,
  },
  {
    name: 'commit-then-kill',
    note: 'COMMIT acknowledged, then killed: committed data must survive',
    run: async (page) => {
      await must(page, { op: 'begin' });
      await must(page, { op: 'execute', text: insert('state-1') });
      await must(page, { op: 'execute', text: insert('event-1') });
      await must(page, { op: 'commit' });
    },
    expect: [...BASE, 'event-1', 'state-1'].sort(),
  },
];

const results = [];
for (const scenario of scenarios) {
  const profile = tempProfile();
  const result = { scenario: scenario.name, note: scenario.note };
  try {
    // Session 1: committed baseline, then the unfinished transaction, then the kill.
    const first = await harness.launch(profile);
    const page = await open(first);
    await must(page, { op: 'init', wipe: true, schema: SCHEMA });
    for (const id of BASE)
      await must(page, { op: 'execute', text: insert(id) });
    await scenario.run(page);
    const pool = (await must(page, { op: 'info' })).pool;
    result.poolFilesAtKill = pool.files;
    result.killed = killBrowser(profile);
    await first.close().catch(() => undefined);

    // Session 2: a new browser on the same profile.
    const second = await harness.launch(profile);
    const reopened = await open(second);
    const init = await must(reopened, { op: 'init', schema: SCHEMA });
    result.hadSchema = init.hadSchema;
    result.survivors = await ids(reopened);
    result.integrity = (
      await must(reopened, { op: 'pragma', text: 'PRAGMA integrity_check' })
    ).rows.map((r) => r.integrity_check);
    await must(reopened, { op: 'execute', text: insert('after-crash') });
    result.writableAfter = (await ids(reopened)).includes('after-crash');
    await second.close();

    result.hotJournalAtKill = pool.files.some((f) => f.includes('journal'));
    result.pass =
      result.killed > 0 &&
      result.hadSchema === true &&
      JSON.stringify(result.survivors) === JSON.stringify(scenario.expect) &&
      result.integrity.length === 1 &&
      result.integrity[0] === 'ok' &&
      result.writableAfter &&
      (!scenario.wantHotJournal || result.hotJournalAtKill);
  } catch (error) {
    result.pass = false;
    result.error = String(error.message ?? error).slice(0, 300);
  } finally {
    killBrowser(profile);
    rmSync(profile, { recursive: true, force: true });
  }
  results.push(result);
  console.log(JSON.stringify(result));
}

harness.stop();
const failed = results.filter((r) => !r.pass);
console.log(
  `\n${results.length - failed.length}/${results.length} scenarios pass`,
);
process.exit(failed.length === 0 ? 0 : 2);
