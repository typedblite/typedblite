/**
 * Relations at scale: the project tracker (`test-fixtures/schemas/tracker.schema.typeqlite`) generated at
 * several sizes. Each project has 7 tasks (`project-task`), a `task-dependency` chain between consecutive
 * tasks, and one task in ten nests the previous project (`subproject`).
 *
 * The anchored joins should cost the same at every size — their trace counts are constant. What
 * grows is a scan.
 */
import { readFileSync } from 'node:fs';
import { measure, open, removeStore, str, table, type Row } from './harness.js';

const SUITE = 'relations';
const SCHEMA = new URL('../../../test-fixtures/schemas/tracker.schema.typeqlite', import.meta.url);

export function run(work: string, sizes: readonly number[]): void {
  const generation: Row[] = [];
  for (const projects of sizes) {
    const file = `${work}/relations-${projects}.db`;
    removeStore(file);
    const db = open(file);
    db.define(readFileSync(SCHEMA, 'utf8'));
    const start = performance.now();
    let writes = 0;
    for (let s = 0; s < projects; s++) {
      const id = `project-${s}`;
      db.beginTransaction();
      db.execute(`insert $s isa project, has project-key ${str(`${id}@r1`)}, has project-id ${str(id)}, has revision ${str(`r1-${id}`)}, has project-name ${str(`Project ${s}`)}, has project-summary "generated";`);
      writes++;
      for (let k = 0; k < 7; k++) {
        db.execute(`match $s isa project, has project-key ${str(`${id}@r1`)}; insert $st isa task, has task-key ${str(`${id}@r1:${k}`)}, has task-id ${str(`${id}:${k}`)}, has project-id ${str(id)}, has revision ${str(`r1-${id}`)}, has ordinal ${k}, has task-kind "task", has log-field "summary", has log-field "evidence"; (owner: $s, task: $st) isa project-task;`);
        writes++;
        if (k > 0) {
          db.execute(`match $d isa task, has task-key ${str(`${id}@r1:${k}`)}; $p isa task, has task-key ${str(`${id}@r1:${k - 1}`)}; insert (dependent: $d, prerequisite: $p) isa task-dependency;`);
          writes++;
        }
        if (s > 0 && (s * 7 + k) % 10 === 0) {
          db.execute(`match $st isa task, has task-key ${str(`${id}@r1:${k}`)}; $c isa project, has project-key ${str(`project-${s - 1}@r1`)}; insert (parent-task: $st, child-project: $c) isa subproject;`);
          writes++;
        }
      }
      db.commitTransaction();
    }
    const seconds = (performance.now() - start) / 1000;
    generation.push({ projects, tasks: projects * 7, writes, seconds, msPerWrite: (seconds * 1000) / writes });
    console.log(`\n## relations — ${projects} projects, ${projects * 7} tasks (generated in ${seconds.toFixed(0)} s, ${((seconds * 1000) / writes).toFixed(2)} ms per write)`);

    const sample = Array.from({ length: 60 }, (_, i) => `project-${Math.floor((i * projects) / 60)}`);
    const pinned = (id: string): string => `$s isa project, has project-id ${str(id)}, has revision ${str(`r1-${id}`)};`;
    const rows = (text: string): number => db.query(text).rows.length;
    measure(SUITE, `${projects}: tasks via project-task`, sample, (id) => rows(`match ${pinned(id)} $st isa task, has task-id $i, has ordinal $o, has task-kind $k; (owner: $s, task: $st) isa project-task; select $i, $o, $k;`));
    measure(SUITE, `${projects}: task dependencies (2 relations)`, sample, (id) => rows(`match ${pinned(id)} $st isa task, has task-id $i; (owner: $s, task: $st) isa project-task; $p isa task, has task-id $pid; (dependent: $st, prerequisite: $p) isa task-dependency; select $i, $pid;`));
    measure(SUITE, `${projects}: subproject children (2 relations)`, sample, (id) => rows(`match ${pinned(id)} $st isa task, has task-id $i; (owner: $s, task: $st) isa project-task; $child isa project, has project-id $cid; $r isa subproject (parent-task: $st, child-project: $child); select $i, $cid;`));
    measure(SUITE, `${projects}: log fields (multi-valued)`, sample, (id) => rows(`match ${pinned(id)} $st isa task, has task-id $i, has log-field $f; (owner: $s, task: $st) isa project-task; select $i, $f;`));
    // A key and a value every task shares: the broad literal must not set the cost (finding 5).
    measure(SUITE, `${projects}: a key and a broad value`, sample, (id) => rows(`match $st isa task, has task-kind "task", has task-id ${str(`${id}:3`)}, has ordinal $o; select $o;`));
    measure(SUITE, `${projects}: every dependency edge`, [0, 1], () => rows(`match $a isa task, has task-id $x; $b isa task, has task-id $y; (dependent: $a, prerequisite: $b) isa task-dependency; select $x, $y;`));
    // `$b` has no `isa`: seeded through the first relation since finding 6 was fixed; before, `$c`
    // was enumerated whole.
    measure(SUITE, `${projects}: 2-hop, untyped middle`, sample.slice(0, 10), (id) => rows(`match $a isa task, has task-id ${str(`${id}:6`)}; (dependent: $a, prerequisite: $b) isa task-dependency; (dependent: $b, prerequisite: $c) isa task-dependency; $c has task-id $y; select $y;`));
    measure(SUITE, `${projects}: 2-hop, typed middle`, sample.slice(0, 10), (id) => rows(`match $a isa task, has task-id ${str(`${id}:6`)}; $r1 isa task-dependency (dependent: $a, prerequisite: $b); $b isa task; $r2 isa task-dependency (dependent: $b, prerequisite: $c); $c isa task, has task-id $y; select $y;`));
    db.close();
    removeStore(file);
  }
  table('relations-generation', generation);
}
