/**
 * Growth: a sprint-board store built from empty — per sprint, 1 `sprint`, 7 `ticket`s and
 * 20 `ticket-event`s — measuring at each
 * checkpoint what a write and the common reads cost at that size. A cost that rises with the store
 * when the answer does not is a scan somewhere.
 */
import { readFileSync } from 'node:fs';
import { open, removeStore, str, table, timeMean, type Row } from './harness.js';

const SCHEMA = new URL('../../../test-fixtures/schemas/sprint.schema.typeqlite', import.meta.url);
const STATUSES = ['pending', 'in-progress', 'completed', 'blocked', 'abandoned', 'escalated'];

/** A sprint-board store of `count` sprints at `file`: the concurrency suite's source. */
export function seedStore(file: string, count: number): void {
  removeStore(file);
  const db = open(file);
  db.define(readFileSync(SCHEMA, 'utf8'));
  const insert = sprintWriter(db);
  for (let i = 0; i < count; i += 40) {
    db.beginTransaction();
    for (let j = i; j < Math.min(count, i + 40); j++) insert.next();
    db.commitTransaction();
  }
  db.close();
}

const sprintId = (n: number): string => `sprint-${n}`;

/** Writes one sprint with its tickets and their events per `next()`; counts what it wrote. */
function sprintWriter(db: ReturnType<typeof open>) {
  const state = { sprints: 0, entities: 0, next: () => {} };
  state.next = (): void => {
    const w = sprintId(state.sprints++);
    db.execute(`insert $w isa sprint, has sprint-id ${str(w)}, has sprint-goal ${str(JSON.stringify({ goal: w }))}, has sprint-ticket-order ${str(JSON.stringify(Array.from({ length: 7 }, (_, i) => `step-${i}`)))};`);
    for (let s = 0; s < 7; s++) {
      db.execute(`insert $s isa ticket, has ticket-id ${str(`${w}::step-${s}`)}, has ticket-sprint ${str(w)}, has ticket-name ${str(`step-${s}`)}, has ticket-status ${str(STATUSES[s % 6] ?? 'pending')}${s % 3 === 0 ? `, has ticket-notes ${str(JSON.stringify({ pr: state.sprints }))}` : ''};`);
    }
    for (let h = 0; h < 20; h++) {
      db.execute(`insert $h isa ticket-event, has ticket-event-id ${str(`${w}::${h}`)}, has ticket-event-sprint ${str(w)}, has ticket-event-ticket ${str(`step-${h % 7}`)}, has ticket-event-from "pending", has ticket-event-to "completed", has ticket-event-at 2026-11-${String(1 + (h % 28)).padStart(2, '0')}T10:${String(h).padStart(2, '0')}:00;`);
    }
    state.entities += 28;
  };
  return state;
}

export function run(work: string, target: number, every: number): void {
  console.log(`\n## growth — sprint board, to ${target.toLocaleString()} entities`);
  const file = `${work}/growth.db`;
  removeStore(file);
  const db = open(file);
  db.define(readFileSync(SCHEMA, 'utf8'));
  const writer = sprintWriter(db);
  const id = sprintId;
  const rows: Row[] = [];
  let loadMs = 0;
  let loaded = 0;
  let next = every;
  const started = performance.now();
  console.log('  entities  load ms/entity  keyed  column  empty-optional  list-all  ticketUpdate   (ms)');
  while (writer.entities < target) {
    // 40 sprints per transaction: batching is what a bulk load would do, so per-entity cost here
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

    const w = id(Math.floor(writer.sprints / 2));
    const row: Row = {
      entities: writer.entities,
      loadPerEntity: loadMs / loaded,
      keyed: timeMean(() => db.query(`match $w isa sprint, has sprint-id ${str(w)}, has sprint-goal $i; select $i;`), 20),
      column: timeMean(() => db.query(`match $x isa ticket-event, has ticket-event-id $id, has ticket-event-sprint ${str(w)}, has ticket-event-at $v; select $id, $v;`), 20),
      // An attribute no history entry has: an empty answer, which the engine explains (`no-candidates`).
      emptyOptional: timeMean(() => db.query(`match $x isa ticket-event, has ticket-event-id $id, has ticket-event-sprint ${str(w)}, has ticket-event-correlation $v; select $id, $v;`), 10),
      listAll: timeMean(() => db.query(`match $w isa sprint, has sprint-id $id; select $id;`), 2),
      ticketUpdate: timeMean(() => {
        db.execute(`match $s isa ticket, has ticket-id ${str(`${w}::step-1`)}; delete $s;`);
        db.execute(`insert $s isa ticket, has ticket-id ${str(`${w}::step-1`)}, has ticket-sprint ${str(w)}, has ticket-name "step-1", has ticket-status "completed";`);
      }, 10),
    };
    rows.push(row);
    const f = (k: string, width: number): string => (row[k] as number).toFixed(2).padStart(width);
    console.log(`  ${String(writer.entities).padStart(8)} ${f('loadPerEntity', 15)} ${f('keyed', 6)} ${f('column', 7)} ${f('emptyOptional', 15)} ${f('listAll', 9)} ${f('ticketUpdate', 9)}   ${((performance.now() - started) / 1000).toFixed(0)} s`);
    loadMs = 0;
    loaded = 0;
  }
  table('growth', rows);
  db.close();
  removeStore(file);
}
