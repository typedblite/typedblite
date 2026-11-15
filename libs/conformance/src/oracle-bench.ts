import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TypeDBLiteInterpreter } from '@typedblite/runtime';
import { REPOSITORY_ROOT } from './conformance.js';
import { TypeDBServer } from './typedb-oracle.js';

/**
 * `tsx src/oracle-bench.ts [--growth=100,400,1000] [--relations=200,1000] [--out=results.md]` — the load
 * test's `growth` and `relations` workloads (`libs/runtime/bench`) on TypeDBLite and on a live TypeDB
 * (`TYPEDB_URL`, default `http://localhost:8000`), the same statements on the same fixture schemas.
 * Sizes are in sprints and in projects. It needs a server, so it is never part of the routine suite.
 *
 * Reading the numbers means knowing what they are not. TypeDBLite runs in this process; TypeDB is a server
 * reached over HTTP, and an HTTP call costs about 2 ms whatever the query is. So a raw comparison measures
 * the embedding, and three things take the network out of it:
 *
 * - **One open read transaction.** TypeDB's reads go through a single read transaction, reopened after
 *   writes (it is a snapshot), so no transaction is opened and closed per query.
 * - **Count-only reads.** Every read is also run as `reduce $answers = count`, which ships one number, so no
 *   rows are serialised or transferred, and the size of the answer drops out of the transport.
 * - **A floor per engine.** A lookup that finds nothing is timed on each engine, on the store of the size
 *   being measured, and subtracted: "above floor" is what a query costs beyond a trivial one. A cost under
 *   `NOISE_MS` is indistinguishable from the floor and is shown as `~0`.
 *
 * Writes are not adjusted: a write is one HTTP call inside a transaction, so TypeDB's cost per write is
 * almost all transport, and the two engines' writes are not comparable here. The row counts of every read
 * must agree between the engines, and between the row and the count runs, or its row says so.
 *
 * ⚠️ One schema change, for both engines: the tracker's `owns log-field` has no `@card`, which TypeDB reads
 * as `@card(0..1)` and TypeDBLite does not enforce (ADR-007), while the generator writes two per task. The
 * run states the intent, `@card(0..)`, so TypeDB accepts the data.
 */

const NOISE_MS = 0.15;
const ENGINES = ['TypeDBLite', 'TypeDB'] as const;
type EngineName = (typeof ENGINES)[number];

const option = (name: string, fallback: string): string => process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const sizes = (name: string, fallback: string): number[] => option(name, fallback).split(',').map(Number);
const growthSizes = sizes('growth', '100,400,1000');
const relationSizes = sizes('relations', '200,1000');
const outFile = option('out', '');

const SCHEMAS = join(REPOSITORY_ROOT, 'test-fixtures', 'schemas');
const schema = (file: string): string => readFileSync(join(SCHEMAS, file), 'utf8');
const trackerSchema = (): string => schema('tracker.schema.typeqlite').replace(/owns log-field,/g, 'owns log-field @card(0..),');
const str = (s: string): string => JSON.stringify(s);
const STATUSES = ['pending', 'in-progress', 'completed', 'blocked', 'abandoned', 'escalated'];

/** What the workloads need of a database, whichever engine is behind it. */
interface Db {
  define(text: string): void;
  write(text: string): void;
  begin(): void;
  commit(): void;
  /** Rows a `match … select …` answers. */
  rows(match: string, select: string): number;
  /** The same answer counted by the engine, so nothing is transferred. */
  count(match: string): number;
  close(): void;
}

class LiteDb implements Db {
  private readonly engine: TypeDBLiteInterpreter;
  constructor(file: string) {
    this.engine = new TypeDBLiteInterpreter(file);
  }
  define(text: string): void {
    this.engine.define(text);
  }
  write(text: string): void {
    this.engine.execute(text);
  }
  begin(): void {
    this.engine.beginTransaction();
  }
  commit(): void {
    this.engine.commitTransaction();
  }
  rows(match: string, select: string): number {
    return this.engine.query(`${match} select ${select};`).rows.length;
  }
  count(match: string): number {
    const [row] = this.engine.query(`${match} reduce $answers = count;`).rows;
    return Number(row?.['answers']?.asString());
  }
  close(): void {
    this.engine.close();
  }
}

interface Answers {
  readonly answers: ReadonlyArray<{ readonly data: Record<string, { readonly value?: unknown } | null> }> | null;
}

class TypeDbDb implements Db {
  private static counter = 0;
  private readonly name = `oracle_bench_${process.pid}_${(TypeDbDb.counter += 1)}`;
  private writeTransaction: string | undefined;
  private readTransaction: string | undefined;

  constructor(private readonly server: TypeDBServer) {
    server.call('POST', `/v1/databases/${this.name}`);
  }
  private oneShot(transactionType: 'schema' | 'write', query: string): void {
    this.server.call('POST', '/v1/query', { databaseName: this.name, transactionType, query, commit: true });
  }
  /** A read sees the snapshot of when its transaction opened, so a write drops it. */
  private dropSnapshot(): void {
    const id = this.readTransaction;
    this.readTransaction = undefined;
    if (id !== undefined) this.closeTransaction(id);
  }
  private closeTransaction(id: string): void {
    try {
      this.server.call('POST', `/v1/transactions/${id}/close`);
    } catch {
      // Closed by the server already.
    }
  }
  private read(query: string): Answers {
    if (this.readTransaction === undefined) {
      const opened = this.server.call('POST', '/v1/transactions/open', { databaseName: this.name, transactionType: 'read' }) as { transactionId: string };
      this.readTransaction = opened.transactionId;
    }
    return this.server.call('POST', `/v1/transactions/${this.readTransaction}/query`, { query }) as Answers;
  }
  define(text: string): void {
    this.oneShot('schema', text);
  }
  write(text: string): void {
    this.dropSnapshot();
    if (this.writeTransaction === undefined) this.oneShot('write', text);
    else this.server.call('POST', `/v1/transactions/${this.writeTransaction}/query`, { query: text });
  }
  begin(): void {
    this.dropSnapshot();
    const opened = this.server.call('POST', '/v1/transactions/open', { databaseName: this.name, transactionType: 'write' }) as { transactionId: string };
    this.writeTransaction = opened.transactionId;
  }
  commit(): void {
    const id = this.writeTransaction;
    this.writeTransaction = undefined;
    if (id !== undefined) this.server.call('POST', `/v1/transactions/${id}/commit`);
  }
  rows(match: string, select: string): number {
    return this.read(`${match} select ${select};`).answers?.length ?? 0;
  }
  count(match: string): number {
    return Number(this.read(`${match} reduce $answers = count;`).answers?.[0]?.data['answers']?.value);
  }
  close(): void {
    this.dropSnapshot();
    const id = this.writeTransaction;
    this.writeTransaction = undefined;
    if (id !== undefined) this.closeTransaction(id);
    try {
      this.server.call('DELETE', `/v1/databases/${this.name}`);
    } catch {
      // Gone already.
    }
  }
}

const work = mkdtempSync(join(tmpdir(), 'oracle-bench-'));
const server = new TypeDBServer({ url: process.env['TYPEDB_URL'] });
let fileCounter = 0;
const open = (engine: EngineName): Db => (engine === 'TypeDBLite' ? new LiteDb(join(work, `${(fileCounter += 1)}.db`)) : new TypeDbDb(server));

// ── measuring ───────────────────────────────────────────────────────────────────────────────────────────

interface Cell {
  readonly p50: number;
  readonly answers: number | string;
}
/** One row per operation; a cell per engine and per way of reading (`rows` or `count`). */
const table: Array<{ suite: string; name: string; cells: Map<string, Cell> }> = [];
const ms = (x: number): string => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2));

/** Time `operation` once per input, after one untimed run; its return value, a count of answers, is averaged. */
function measure(key: string, suite: string, name: string, inputs: readonly number[], operation: (input: number) => number | void): void {
  let cell: Cell;
  try {
    operation(inputs[0] ?? 0);
    const samples: number[] = [];
    let sum = 0;
    let counted = 0;
    for (const input of inputs) {
      const start = performance.now();
      const answers = operation(input);
      samples.push(performance.now() - start);
      if (typeof answers === 'number') {
        sum += answers;
        counted += 1;
      }
    }
    samples.sort((a, b) => a - b);
    cell = { p50: samples[Math.min(samples.length - 1, Math.floor(samples.length / 2))] ?? 0, answers: counted > 0 ? sum / counted : '' };
  } catch (error) {
    cell = { p50: Number.NaN, answers: `ERR ${String((error as Error).message).split('\n')[0]?.slice(0, 90)}` };
  }
  let row = table.find((r) => r.suite === suite && r.name === name);
  if (row === undefined) table.push((row = { suite, name, cells: new Map() }));
  row.cells.set(key, cell);
  console.log(`  ${key.padEnd(16)} ${suite}: ${name.padEnd(46)} p50 ${Number.isNaN(cell.p50) ? '—' : ms(cell.p50).padStart(7)} ms  answers ${cell.answers}`);
}

const indices = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/** A read, measured by rows and by count. `match` may depend on the input. */
function read(engine: EngineName, db: Db, suite: string, name: string, inputs: readonly number[], match: (input: number) => string, select: string): void {
  measure(engine, suite, name, inputs, (i) => db.rows(match(i), select));
  measure(`${engine} count`, suite, name, inputs, (i) => db.count(match(i)));
}

const loads: Array<{ engine: EngineName; entities: number; msPerEntity: number }> = [];
const generations: Array<{ engine: EngineName; projects: number; writes: number; seconds: number }> = [];

// ── growth: a sprint board built from empty ───────────────────────────────────────────────────────────

function sprintWriter(db: Db) {
  const state = { sprints: 0, entities: 0 };
  return {
    state,
    next(): void {
      const w = `sprint-${state.sprints++}`;
      db.write(`insert $w isa sprint, has sprint-id ${str(w)}, has sprint-goal ${str(JSON.stringify({ goal: w }))}, has sprint-ticket-order ${str(JSON.stringify(Array.from({ length: 7 }, (_, i) => `step-${i}`)))};`);
      for (let s = 0; s < 7; s++) {
        db.write(`insert $s isa ticket, has ticket-id ${str(`${w}::step-${s}`)}, has ticket-sprint ${str(w)}, has ticket-name ${str(`step-${s}`)}, has ticket-status ${str(STATUSES[s % 6] ?? 'pending')}${s % 3 === 0 ? `, has ticket-notes ${str(JSON.stringify({ pr: state.sprints }))}` : ''};`);
      }
      for (let h = 0; h < 20; h++) {
        db.write(`insert $h isa ticket-event, has ticket-event-id ${str(`${w}::${h}`)}, has ticket-event-sprint ${str(w)}, has ticket-event-ticket ${str(`step-${h % 7}`)}, has ticket-event-from "pending", has ticket-event-to "completed", has ticket-event-at 2026-11-${String(1 + (h % 28)).padStart(2, '0')}T10:${String(h).padStart(2, '0')}:00;`);
      }
      state.entities += 28;
    },
  };
}

function growth(engine: EngineName): void {
  console.log(`\n## growth on ${engine}`);
  const db = open(engine);
  try {
    db.define(schema('sprint.schema.typeqlite'));
    const writer = sprintWriter(db);
    let loadMs = 0;
    let loaded = 0;
    for (const sprints of growthSizes) {
      while (writer.state.sprints < sprints) {
        const before = writer.state.entities;
        const start = performance.now();
        db.begin();
        for (let i = 0; i < 40 && writer.state.sprints < sprints; i++) writer.next();
        db.commit();
        loadMs += performance.now() - start;
        loaded += writer.state.entities - before;
      }
      loads.push({ engine, entities: writer.state.entities, msPerEntity: loadMs / loaded });
      loadMs = 0;
      loaded = 0;
      const w = `sprint-${Math.floor(writer.state.sprints / 2)}`;
      const size = `${writer.state.entities.toLocaleString('en')} entities`;
      read(engine, db, 'floor', `${size}: floor`, indices(60), () => 'match $w isa sprint, has sprint-id "none", has sprint-goal $g;', '$g');
      read(engine, db, 'growth', `${size}: keyed lookup`, indices(20), () => `match $w isa sprint, has sprint-id ${str(w)}, has sprint-goal $i;`, '$i');
      read(engine, db, 'growth', `${size}: one sprint's column`, indices(20), () => `match $x isa ticket-event, has ticket-event-id $id, has ticket-event-sprint ${str(w)}, has ticket-event-at $v;`, '$id, $v');
      read(engine, db, 'growth', `${size}: empty optional attribute`, indices(10), () => `match $x isa ticket-event, has ticket-event-id $id, has ticket-event-sprint ${str(w)}, has ticket-event-correlation $v;`, '$id, $v');
      read(engine, db, 'growth', `${size}: list every sprint`, indices(3), () => 'match $w isa sprint, has sprint-id $id;', '$id');
      measure(engine, 'growth', `${size}: ticket update (delete + insert)`, indices(10), () => {
        db.write(`match $s isa ticket, has ticket-id ${str(`${w}::step-1`)}; delete $s;`);
        db.write(`insert $s isa ticket, has ticket-id ${str(`${w}::step-1`)}, has ticket-sprint ${str(w)}, has ticket-name "step-1", has ticket-status "completed";`);
      });
    }
  } finally {
    db.close();
  }
}

// ── relations: a project tracker at several sizes ─────────────────────────────────────────────────────

function relations(engine: EngineName, projects: number): void {
  console.log(`\n## relations on ${engine}: ${projects} projects`);
  const db = open(engine);
  try {
    db.define(trackerSchema());
    const start = performance.now();
    let writes = 0;
    for (let s = 0; s < projects; s++) {
      const id = `project-${s}`;
      db.begin();
      db.write(`insert $s isa project, has project-key ${str(`${id}@r1`)}, has project-id ${str(id)}, has revision ${str(`r1-${id}`)}, has project-name ${str(`Project ${s}`)}, has project-summary "generated";`);
      writes++;
      for (let k = 0; k < 7; k++) {
        db.write(`match $s isa project, has project-key ${str(`${id}@r1`)}; insert $st isa task, has task-key ${str(`${id}@r1:${k}`)}, has task-id ${str(`${id}:${k}`)}, has project-id ${str(id)}, has revision ${str(`r1-${id}`)}, has ordinal ${k}, has task-kind "task", has log-field "summary", has log-field "evidence"; (owner: $s, task: $st) isa project-task;`);
        writes++;
        if (k > 0) {
          db.write(`match $d isa task, has task-key ${str(`${id}@r1:${k}`)}; $p isa task, has task-key ${str(`${id}@r1:${k - 1}`)}; insert (dependent: $d, prerequisite: $p) isa task-dependency;`);
          writes++;
        }
        if (s > 0 && (s * 7 + k) % 10 === 0) {
          db.write(`match $st isa task, has task-key ${str(`${id}@r1:${k}`)}; $c isa project, has project-key ${str(`project-${s - 1}@r1`)}; insert (parent-task: $st, child-project: $c) isa subproject;`);
          writes++;
        }
      }
      db.commit();
    }
    const seconds = (performance.now() - start) / 1000;
    generations.push({ engine, projects, writes, seconds });
    console.log(`  generated in ${seconds.toFixed(1)} s`);

    const sample = Array.from({ length: 60 }, (_, i) => `project-${Math.floor((i * projects) / 60)}`);
    const id = (i: number): string => sample[i] ?? '';
    const pinned = (project: string): string => `$s isa project, has project-id ${str(project)}, has revision ${str(`r1-${project}`)};`;
    const label = (name: string): string => `${projects}: ${name}`;
    read(engine, db, 'floor', label('floor'), indices(60), () => 'match $s isa project, has project-id "none", has project-name $name;', '$name');
    read(engine, db, 'relations', label('tasks via project-task'), indices(60), (i) => `match ${pinned(id(i))} $st isa task, has task-id $i, has ordinal $o, has task-kind $k; (owner: $s, task: $st) isa project-task;`, '$i, $o, $k');
    read(engine, db, 'relations', label('task dependencies (2 relations)'), indices(60), (i) => `match ${pinned(id(i))} $st isa task, has task-id $i; (owner: $s, task: $st) isa project-task; $p isa task, has task-id $pid; (dependent: $st, prerequisite: $p) isa task-dependency;`, '$i, $pid');
    read(engine, db, 'relations', label('subproject children (2 relations)'), indices(60), (i) => `match ${pinned(id(i))} $st isa task, has task-id $i; (owner: $s, task: $st) isa project-task; $child isa project, has project-id $cid; $r isa subproject (parent-task: $st, child-project: $child);`, '$i, $cid');
    read(engine, db, 'relations', label('log fields (multi-valued)'), indices(60), (i) => `match ${pinned(id(i))} $st isa task, has task-id $i, has log-field $f; (owner: $s, task: $st) isa project-task;`, '$i, $f');
    read(engine, db, 'relations', label('a key and a broad value'), indices(60), (i) => `match $st isa task, has task-kind "task", has task-id ${str(`${id(i)}:3`)}, has ordinal $o;`, '$o');
    read(engine, db, 'relations', label('every dependency edge'), [0, 1], () => 'match $a isa task, has task-id $x; $b isa task, has task-id $y; (dependent: $a, prerequisite: $b) isa task-dependency;', '$x, $y');
    read(engine, db, 'relations', label('2-hop, untyped middle'), indices(10), (i) => `match $a isa task, has task-id ${str(`${id(i)}:6`)}; (dependent: $a, prerequisite: $b) isa task-dependency; (dependent: $b, prerequisite: $c) isa task-dependency; $c has task-id $y;`, '$y');
    read(engine, db, 'relations', label('2-hop, typed middle'), indices(10), (i) => `match $a isa task, has task-id ${str(`${id(i)}:6`)}; $r1 isa task-dependency (dependent: $a, prerequisite: $b); $b isa task; $r2 isa task-dependency (dependent: $b, prerequisite: $c); $c isa task, has task-id $y;`, '$y');
  } finally {
    db.close();
  }
}

// ── the report ────────────────────────────────────────────────────────────────────────────────────────

function report(): string {
  const lines: string[] = [];
  const cell = (row: (typeof table)[number], key: string): Cell | undefined => row.cells.get(key);
  const floorOf = (row: (typeof table)[number], engine: EngineName): number => {
    const floor = table.find((r) => r.suite === 'floor' && r.name === `${row.name.split(': ')[0]}: floor`);
    return floor?.cells.get(`${engine} count`)?.p50 ?? Number.NaN;
  };
  const above = (c: Cell | undefined, floor: number): number | undefined => (c === undefined || Number.isNaN(c.p50) || Number.isNaN(floor) ? undefined : Math.max(0, c.p50 - floor));
  const show = (x: number | undefined): string => (x === undefined ? '—' : x < NOISE_MS ? '~0' : ms(x));

  lines.push('### floors (a lookup that finds nothing, count-only, p50, on the store of that size)', '', '| store | TypeDBLite (ms, in process) | TypeDB (ms, HTTP, one open read transaction) |', '| --- | ---: | ---: |');
  for (const row of table.filter((r) => r.suite === 'floor')) {
    lines.push(`| ${row.name.replace(': floor', '').replace(/^(\d+)$/, '$1 projects')} | ${ms(cell(row, 'TypeDBLite count')?.p50 ?? Number.NaN)} | ${ms(cell(row, 'TypeDB count')?.p50 ?? Number.NaN)} |`);
  }
  lines.push('', `"Above floor" is each engine's count-only p50 minus its own floor on the same store. Under ${NOISE_MS} ms it is shown as "~0", and no ratio is given.`, '');
  for (const suite of ['growth', 'relations']) {
    lines.push(`### ${suite}`, '', '| Operation | answers | TypeDBLite above floor (ms) | TypeDB above floor (ms) | TypeDB ÷ TypeDBLite | answers agree | raw, rows returned (TypeDBLite / TypeDB ms) |', '| --- | ---: | ---: | ---: | ---: | :---: | ---: |');
    for (const row of table.filter((r) => r.suite === suite)) {
      const [liteCount, dbCount, liteRows, dbRows] = [cell(row, 'TypeDBLite count'), cell(row, 'TypeDB count'), cell(row, 'TypeDBLite'), cell(row, 'TypeDB')];
      const lite = above(liteCount, floorOf(row, 'TypeDBLite'));
      const typedb = above(dbCount, floorOf(row, 'TypeDB'));
      const reference = Number(liteRows?.answers);
      const agree = [liteCount, dbCount, liteRows, dbRows].every((c) => c !== undefined && Math.abs(Number(c.answers) - reference) < 1e-9);
      const ratio = lite !== undefined && typedb !== undefined && lite >= NOISE_MS && typedb >= NOISE_MS ? `${(typedb / lite).toFixed(1)}×` : '—';
      const answers = liteRows === undefined || liteRows.answers === '' ? '' : Number.isInteger(reference) ? String(reference) : reference.toFixed(2);
      const raw = `${liteRows === undefined ? '—' : ms(liteRows.p50)} / ${dbRows === undefined || Number.isNaN(dbRows.p50) ? '—' : ms(dbRows.p50)}`;
      lines.push(`| ${row.name} | ${answers} | ${show(lite)} | ${show(typedb)} | ${ratio} | ${liteCount === undefined ? 'n/a (write)' : agree ? 'yes' : '**NO**'} | ${raw} |`);
    }
    lines.push('');
  }
  lines.push('### writes (not network-adjusted)', '', '| engine | entities | ms per entity |', '| --- | ---: | ---: |', ...loads.map((l) => `| ${l.engine} | ${l.entities} | ${ms(l.msPerEntity)} |`), '');
  lines.push('| engine | projects | writes | seconds | ms per write |', '| --- | ---: | ---: | ---: | ---: |', ...generations.map((g) => `| ${g.engine} | ${g.projects} | ${g.writes} | ${g.seconds.toFixed(1)} | ${ms((g.seconds * 1000) / g.writes)} |`), '');
  return lines.join('\n');
}

try {
  for (const engine of ENGINES) growth(engine);
  for (const projects of relationSizes) for (const engine of ENGINES) relations(engine, projects);
} finally {
  server.close();
  rmSync(work, { recursive: true, force: true });
}
const markdown = report();
console.log(`\n${markdown}`);
if (outFile !== '') writeFileSync(outFile, `${markdown}\n`);
