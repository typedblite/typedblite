import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runConformance, SPEC_ROOT } from './conformance.js';
import { renderCard, renderFailureDigest } from './report.js';

/**
 * `nx run typedblite-conformance:report` — the report card, the failure digest, and the exit code
 * the standard specifies: 1 on a regression, 0 otherwise. An improvement whose baseline was not
 * raised is printed, and exits 0 here; the routine `test` target refuses it, so it cannot merge.
 */
const run = runConformance();
const pin = readFileSync(join(SPEC_ROOT, 'PIN'), 'utf8').match(/^commit: (\w+)/m)?.[1] ?? '?';

console.log(`TypeDBLite conformance — typedb-behaviour query/language @ ${pin.slice(0, 7)} — ${new Date().toISOString().slice(0, 10)}`);
console.log('');
console.log(renderCard(run.card));
console.log('');
console.log(renderFailureDigest(run.results));
if (run.ownerCaveat) console.log(`\n⚠️  ${run.ownerCaveat}`);
for (const r of run.deviationsNowPassing) {
  console.log(`\n✅ deviation now passing — remove its entry: ${r.feature}: ${r.scenario.name}`);
}
if (run.unraised.length > 0) {
  console.log('\n⬆ above baseline — raise it in this commit:');
  for (const line of run.unraised) console.log(`  ${line}`);
}
if (run.regressions.length > 0) {
  console.log('\n🔴 below baseline:');
  for (const line of run.regressions) console.log(`  ${line}`);
  process.exit(1);
}
