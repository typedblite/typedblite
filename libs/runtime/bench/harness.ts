/**
 * The load-test harness: timing, sampling and recording. Every suite drives the engine from SOURCE
 * (`libs/runtime/src`, through `tsconfig.base.json`'s path aliases) — never the built `out/`, which
 * other checkouts may be loading as their live engine.
 *
 * Timings, not counts: this is the complement of the query trace (`lastQueryTrace()`), which the
 * test suite asserts on because counts are deterministic. A benchmark answers "how long, on this
 * machine", so its numbers belong in a results file, never in a test.
 */
import { execSync } from 'node:child_process';
import { copyFileSync, rmSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { TypeDBLiteInterpreter, openNodeSqlite, type SqliteOpener } from '@typedblite/runtime';

/** One measured operation, in milliseconds. */
export interface Measurement {
  suite: string;
  name: string;
  n: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
  /** Mean rows the operation returned, when it returns any. */
  rows?: number;
}

/** A row of a table a suite reports whole (a growth checkpoint, a concurrency configuration). */
export type Row = Record<string, number | string>;

export interface Results {
  label: string;
  commit: string;
  date: string;
  machine: string;
  measurements: Measurement[];
  tables: Record<string, Row[]>;
}

export const results: Results = {
  label: process.env['BENCH_LABEL'] ?? 'unlabeled',
  commit: gitCommit(),
  date: new Date().toISOString(),
  machine: `${platform()} ${release()}, ${cpus()[0]?.model ?? 'unknown CPU'} ×${cpus().length}, Node ${process.version}`,
  measurements: [],
  tables: {},
};

function gitCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export const open = (location: string, options: { trace?: boolean; openDatabase?: SqliteOpener } = {}): TypeDBLiteInterpreter =>
  new TypeDBLiteInterpreter(location, 5000, { openDatabase: options.openDatabase ?? openNodeSqlite, trace: options.trace ?? false });

const percentile = (sorted: readonly number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;

/**
 * Time `operation` once per input. When it returns a number, that is read as a row count and
 * averaged — a latency means little without the size of the answer it bought.
 */
export function measure<T>(suite: string, name: string, inputs: readonly T[], operation: (input: T) => number | void): Measurement {
  const samples: number[] = [];
  let rowSum = 0;
  let rowCount = 0;
  for (const input of inputs) {
    const start = performance.now();
    const rows = operation(input);
    samples.push(performance.now() - start);
    if (typeof rows === 'number') {
      rowSum += rows;
      rowCount += 1;
    }
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const total = samples.reduce((a, b) => a + b, 0);
  const m: Measurement = {
    suite,
    name,
    n: samples.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? 0,
    mean: total / Math.max(1, samples.length),
    ...(rowCount > 0 ? { rows: rowSum / rowCount } : {}),
  };
  results.measurements.push(m);
  console.log(formatMeasurement(m));
  return m;
}

export const measureOnce = (suite: string, name: string, operation: () => number | void): Measurement => measure(suite, name, [0], () => operation());

export function formatMeasurement(m: Measurement): string {
  const f = (x: number): string => ms(x).padStart(8);
  return `  ${m.name.padEnd(52)} n=${String(m.n).padStart(4)}  p50${f(m.p50)}  p95${f(m.p95)}  max${f(m.max)} ms${m.rows !== undefined ? `  rows≈${m.rows.toFixed(1)}` : ''}`;
}

export const ms = (x: number): string => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2));

export function table(name: string, rows: Row[]): void {
  results.tables[name] = rows;
}

/** Mean milliseconds per call of `operation`, over `times` calls. */
export function timeMean(operation: () => unknown, times = 1): number {
  const start = performance.now();
  for (let i = 0; i < times; i++) operation();
  return (performance.now() - start) / times;
}

/** Keys sampled straight from a store with raw SQL, so choosing inputs costs the engine nothing. */
export function sampleValues(file: string, sql: string, n: number): string[] {
  const db = new DatabaseSync(file, { readOnly: true });
  const all = db.prepare(sql).all().map((row) => String(Object.values(row)[0]));
  db.close();
  return shuffle(all).slice(0, n);
}

// A fixed-seed generator: two runs sample the same keys, so a before/after comparison measures the
// engine and not the luck of the draw.
let seed = 42;
const random = (): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
export function shuffle<T>(xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [xs[i], xs[j]] = [xs[j] as T, xs[i] as T];
  }
  return xs;
}

/** A TypeQLite string literal. */
export const str = (s: string): string => JSON.stringify(s);

/**
 * A fresh working copy of `source` at `target`. 🔴 The `-wal` and `-shm` files go too: copying
 * only the main file over an old copy leaves the previous run's WAL beside it, which SQLite replays
 * on open — the second run then starts with the first run's writes in it.
 */
export function freshCopy(source: string, target: string): string {
  removeStore(target);
  copyFileSync(source, target);
  return target;
}

export function removeStore(file: string): void {
  for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
}
