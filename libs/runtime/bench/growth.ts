/**
 * Growth: a workflow-engine store built from empty with `scm/ladder.db`'s real shape — per workflow,
 * 1 `workflow`, 7 `workflow-step-record`s and 20 `workflow-history-entry`s — measuring at each
 * checkpoint what a write and the common reads cost at that size. A cost that rises with the store
 * when the answer does not is a scan somewhere.
 */
import { readFileSync } from 'node:fs';
import { open, removeStore, str, table, timeMean, type Row } from './harness.js';

const SCHEMA = new URL('../../../test-fixtures/schemas/workflow-engine.schema.typeqlite', import.meta.url);
const STATUSES = ['pending', 'in-progress', 'completed', 'blocked', 'abandoned', 'escalated'];

/** A workflow-engine store of `count` workflows at `file` — the concurrency suite's source when no real store is given. */
export function seedStore(file: string, count: number): void {
  removeStore(file);
  const db = open(file);
  db.define(readFileSync(SCHEMA, 'utf8'));
  const insert = workflowWriter(db);
  for (let i = 0; i < count; i += 40) {
    db.beginTransaction();
    for (let j = i; j < Math.min(count, i + 40); j++) insert.next();
    db.commitTransaction();
  }
  db.close();
}

const workflowId = (n: number): string => `scm-branch-close:feat/load-${n}->dev`;

/** Writes one workflow with its steps and history per `next()`; counts what it wrote. */
function workflowWriter(db: ReturnType<typeof open>) {
  const state = { workflows: 0, entities: 0, next: () => {} };
  state.next = (): void => {
    const w = workflowId(state.workflows++);
    db.execute(`insert $w isa workflow, has workflow-id ${str(w)}, has workflow-input ${str(JSON.stringify({ branch: w }))}, has workflow-step-order ${str(JSON.stringify(Array.from({ length: 7 }, (_, i) => `step-${i}`)))};`);
    for (let s = 0; s < 7; s++) {
      db.execute(`insert $s isa workflow-step-record, has workflow-step-id ${str(`${w}::step-${s}`)}, has workflow-step-workflow ${str(w)}, has workflow-step-name ${str(`step-${s}`)}, has workflow-step-status ${str(STATUSES[s % 6] ?? 'pending')}${s % 3 === 0 ? `, has workflow-step-outputs ${str(JSON.stringify({ pr: state.workflows }))}` : ''};`);
    }
    for (let h = 0; h < 20; h++) {
      db.execute(`insert $h isa workflow-history-entry, has workflow-history-id ${str(`${w}::${h}`)}, has workflow-history-workflow ${str(w)}, has workflow-history-step ${str(`step-${h % 7}`)}, has workflow-history-from "pending", has workflow-history-to "completed", has workflow-history-at 2026-11-${String(1 + (h % 28)).padStart(2, '0')}T10:${String(h).padStart(2, '0')}:00;`);
    }
    state.entities += 28;
  };
  return state;
}

export function run(work: string, target: number, every: number): void {
  console.log(`\n## growth — workflow engine, to ${target.toLocaleString()} entities`);
  const file = `${work}/growth.db`;
  removeStore(file);
  const db = open(file);
  db.define(readFileSync(SCHEMA, 'utf8'));
  const writer = workflowWriter(db);
  const id = workflowId;
  const rows: Row[] = [];
  let loadMs = 0;
  let loaded = 0;
  let next = every;
  const started = performance.now();
  console.log('  entities  load ms/entity  keyed  column  empty-optional  list-all  saveStep   (ms)');
  while (writer.entities < target) {
    // 40 workflows per transaction: batching is what a bulk load would do, so per-entity cost here
    // is the engine's own and not one fsync per insert.
    const before = writer.entities;
    const start = performance.now();
    db.beginTransaction();
    for (let i = 0; i < 40; i++) writer.next();
    db.commitTransaction();
    loadMs += performance.now() - start;
    loaded += writer.entities - before;
    if (writer.entities < next && writer.entities < target) continue;
    next += every;

    const w = id(Math.floor(writer.workflows / 2));
    const row: Row = {
      entities: writer.entities,
      loadPerEntity: loadMs / loaded,
      keyed: timeMean(() => db.query(`match $w isa workflow, has workflow-id ${str(w)}, has workflow-input $i; select $i;`), 20),
      column: timeMean(() => db.query(`match $x isa workflow-history-entry, has workflow-history-id $id, has workflow-history-workflow ${str(w)}, has workflow-history-at $v; select $id, $v;`), 20),
      // An attribute no history entry has: an empty answer, which the engine explains (`no-candidates`).
      emptyOptional: timeMean(() => db.query(`match $x isa workflow-history-entry, has workflow-history-id $id, has workflow-history-workflow ${str(w)}, has workflow-history-correlation $v; select $id, $v;`), 10),
      listAll: timeMean(() => db.query(`match $w isa workflow, has workflow-id $id; select $id;`), 2),
      saveStep: timeMean(() => {
        db.execute(`match $s isa workflow-step-record, has workflow-step-id ${str(`${w}::step-1`)}; delete $s;`);
        db.execute(`insert $s isa workflow-step-record, has workflow-step-id ${str(`${w}::step-1`)}, has workflow-step-workflow ${str(w)}, has workflow-step-name "step-1", has workflow-step-status "completed";`);
      }, 10),
    };
    rows.push(row);
    const f = (k: string, width: number): string => (row[k] as number).toFixed(2).padStart(width);
    console.log(`  ${String(writer.entities).padStart(8)} ${f('loadPerEntity', 15)} ${f('keyed', 6)} ${f('column', 7)} ${f('emptyOptional', 15)} ${f('listAll', 9)} ${f('saveStep', 9)}   ${((performance.now() - started) / 1000).toFixed(0)} s`);
    loadMs = 0;
    loaded = 0;
  }
  table('growth', rows);
  db.close();
  removeStore(file);
}
