/**
 * The load test. `npm exec nx -- run typedblite-runtime:bench`, or directly from `libs/runtime`:
 *
 *   npx tsx --tsconfig ../../tsconfig.base.json bench/run.ts [suite …] [--out results.json]
 *
 * Suites: `real-stores` (needs BENCH_STORES), `growth`, `relations`, `concurrency`. With none named,
 * every suite runs and `real-stores` is skipped when BENCH_STORES is unset. See `bench/README.md`.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as concurrency from './concurrency.js';
import * as growth from './growth.js';
import { results } from './harness.js';
import * as realStores from './real-stores.js';
import * as relations from './relations.js';

const env = (name: string, fallback: string): string => process.env[name] ?? fallback;
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
const named = args.filter((a, i) => !a.startsWith('--') && (outIndex < 0 || i !== outIndex + 1));
const suites = named.length > 0 ? named : ['real-stores', 'growth', 'relations', 'concurrency'];
const unknown = suites.filter((s) => !['real-stores', 'growth', 'relations', 'concurrency'].includes(s));
if (unknown.length > 0) throw new Error(`Unknown suite(s): ${unknown.join(', ')}`);

const stores = process.env['BENCH_STORES'] === undefined ? undefined : resolve(process.env['BENCH_STORES']);
const work = process.env['BENCH_WORK'] === undefined ? mkdtempSync(join(tmpdir(), 'typedblite-bench-')) : resolve(process.env['BENCH_WORK']);
mkdirSync(work, { recursive: true });
console.log(`TypeDBLite load test — ${results.label} @ ${results.commit}\n${results.machine}\nworking files: ${work}`);

for (const suite of suites) {
  if (suite === 'real-stores') {
    if (stores === undefined) console.log('\n## real-stores — skipped: set BENCH_STORES to a directory of store snapshots (bench/snapshot.ts)');
    else realStores.run(stores, work);
  }
  if (suite === 'growth') growth.run(work, Number(env('BENCH_GROWTH_TARGET', '100000')), Number(env('BENCH_GROWTH_EVERY', '20000')));
  if (suite === 'relations') relations.run(work, env('BENCH_RELATION_SIZES', '200,1000,3000').split(',').map(Number));
  if (suite === 'concurrency') {
    const ladder = stores === undefined ? undefined : `${stores}/scm__ladder.db`;
    let source = ladder;
    if (source === undefined || !existsSync(source)) {
      source = `${work}/concurrency-source.db`;
      growth.seedStore(source, 400);
    }
    await concurrency.run(source, work, Number(env('BENCH_CONCURRENCY_SECONDS', '10')));
  }
}

if (out !== undefined) {
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\nresults: ${out}`);
}
if (process.env['BENCH_WORK'] === undefined) rmSync(work, { recursive: true, force: true });
