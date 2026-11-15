/**
 * Relations at scale: the Skills schema (`test-fixtures/schemas/skills.schema.typeqlite`) generated at
 * multiples of a production application's real catalog (217 skill versions, 1,482 steps). Each skill has 7 steps
 * (`skill-composition`), a `step-dependency` chain between consecutive steps, and one step in ten
 * nests the previous skill (`sub-workflow`).
 *
 * The anchored joins should cost the same at every size — their trace counts are constant. What
 * grows is a scan.
 */
import { readFileSync } from 'node:fs';
import { measure, open, removeStore, str, table, type Row } from './harness.js';

const SUITE = 'relations';
const SCHEMA = new URL('../../../test-fixtures/schemas/skills.schema.typeqlite', import.meta.url);

export function run(work: string, sizes: readonly number[]): void {
  const generation: Row[] = [];
  for (const skills of sizes) {
    const file = `${work}/relations-${skills}.db`;
    removeStore(file);
    const db = open(file);
    db.define(readFileSync(SCHEMA, 'utf8'));
    const start = performance.now();
    let writes = 0;
    for (let s = 0; s < skills; s++) {
      const id = `skill-${s}`;
      db.beginTransaction();
      db.execute(`insert $s isa skill, has skill-version-key ${str(`${id}@r1`)}, has skill-id ${str(id)}, has revision ${str(`r1-${id}`)}, has skill-name ${str(`Skill ${s}`)}, has skill-description "generated";`);
      writes++;
      for (let k = 0; k < 7; k++) {
        db.execute(`match $s isa skill, has skill-version-key ${str(`${id}@r1`)}; insert $st isa skill-step, has skill-step-key ${str(`${id}@r1:${k}`)}, has step-id ${str(`${id}:${k}`)}, has skill-id ${str(id)}, has revision ${str(`r1-${id}`)}, has ordinal ${k}, has step-kind "task", has output-field "summary", has output-field "evidence"; (owner: $s, step: $st) isa skill-composition;`);
        writes++;
        if (k > 0) {
          db.execute(`match $d isa skill-step, has skill-step-key ${str(`${id}@r1:${k}`)}; $p isa skill-step, has skill-step-key ${str(`${id}@r1:${k - 1}`)}; insert (dependent: $d, prerequisite: $p) isa step-dependency;`);
          writes++;
        }
        if (s > 0 && (s * 7 + k) % 10 === 0) {
          db.execute(`match $st isa skill-step, has skill-step-key ${str(`${id}@r1:${k}`)}; $c isa skill, has skill-version-key ${str(`skill-${s - 1}@r1`)}; insert (parent-step: $st, child-skill: $c) isa sub-workflow;`);
          writes++;
        }
      }
      db.commitTransaction();
    }
    const seconds = (performance.now() - start) / 1000;
    generation.push({ skills, steps: skills * 7, writes, seconds, msPerWrite: (seconds * 1000) / writes });
    console.log(`\n## relations — ${skills} skills, ${skills * 7} steps (generated in ${seconds.toFixed(0)} s, ${((seconds * 1000) / writes).toFixed(2)} ms per write)`);

    const sample = Array.from({ length: 60 }, (_, i) => `skill-${Math.floor((i * skills) / 60)}`);
    const pinned = (id: string): string => `$s isa skill, has skill-id ${str(id)}, has revision ${str(`r1-${id}`)};`;
    const rows = (text: string): number => db.query(text).rows.length;
    measure(SUITE, `${skills}: steps via skill-composition`, sample, (id) => rows(`match ${pinned(id)} $st isa skill-step, has step-id $i, has ordinal $o, has step-kind $k; (owner: $s, step: $st) isa skill-composition; select $i, $o, $k;`));
    measure(SUITE, `${skills}: step dependencies (2 relations)`, sample, (id) => rows(`match ${pinned(id)} $st isa skill-step, has step-id $i; (owner: $s, step: $st) isa skill-composition; $p isa skill-step, has step-id $pid; (dependent: $st, prerequisite: $p) isa step-dependency; select $i, $pid;`));
    measure(SUITE, `${skills}: sub-workflow children (2 relations)`, sample, (id) => rows(`match ${pinned(id)} $st isa skill-step, has step-id $i; (owner: $s, step: $st) isa skill-composition; $child isa skill, has skill-id $cid; $r isa sub-workflow (parent-step: $st, child-skill: $child); select $i, $cid;`));
    measure(SUITE, `${skills}: output fields (multi-valued)`, sample, (id) => rows(`match ${pinned(id)} $st isa skill-step, has step-id $i, has output-field $f; (owner: $s, step: $st) isa skill-composition; select $i, $f;`));
    // A key and a value every step shares: the broad literal must not set the cost (finding 5).
    measure(SUITE, `${skills}: a key and a broad value`, sample, (id) => rows(`match $st isa skill-step, has step-kind "task", has step-id ${str(`${id}:3`)}, has ordinal $o; select $o;`));
    measure(SUITE, `${skills}: every dependency edge`, [0, 1], () => rows(`match $a isa skill-step, has step-id $x; $b isa skill-step, has step-id $y; (dependent: $a, prerequisite: $b) isa step-dependency; select $x, $y;`));
    // `$b` has no `isa`: seeded through the first relation since finding 6 was fixed; before, `$c`
    // was enumerated whole.
    measure(SUITE, `${skills}: 2-hop, untyped middle`, sample.slice(0, 10), (id) => rows(`match $a isa skill-step, has step-id ${str(`${id}:6`)}; (dependent: $a, prerequisite: $b) isa step-dependency; (dependent: $b, prerequisite: $c) isa step-dependency; $c has step-id $y; select $y;`));
    measure(SUITE, `${skills}: 2-hop, typed middle`, sample.slice(0, 10), (id) => rows(`match $a isa skill-step, has step-id ${str(`${id}:6`)}; $r1 isa step-dependency (dependent: $a, prerequisite: $b); $b isa skill-step; $r2 isa step-dependency (dependent: $b, prerequisite: $c); $c isa skill-step, has step-id $y; select $y;`));
    db.close();
    removeStore(file);
  }
  table('relations-generation', generation);
}
