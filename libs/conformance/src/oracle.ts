import { join } from 'node:path';
import { PROJECT_ROOT, SPEC_ROOT } from './conformance.js';
import { loadDeviations, runSpec, type ScenarioResult } from './runner.js';
import { featureName, loadSpec } from './spec.js';
import { TypeDBServer } from './typedb-oracle.js';

/**
 * `tsx src/oracle.ts [feature[:line,…] …]` — the differential oracle (ADR-005): every named scenario
 * run twice through the same steps, on TypeDBLite and on a live TypeDB (`TYPEDB_URL`, default
 * `http://localhost:8000`; `docker run -p 8000:8000 typedb/typedb:<PIN version>`), and the
 * disagreements printed. Never part of the routine suite: it needs a server.
 *
 * - **TypeDB passes, TypeDBLite fails** — a real gap.
 * - **both fail** — TypeDB's own reason is printed: the scenario, or this harness, is what disagrees.
 * - **TypeDB fails, TypeDBLite passes** — TypeDBLite accepts what TypeDB does not, or the harness
 *   cannot drive TypeDB there (given rows); read before believing either.
 */
const filters = process.argv.slice(2).map((arg) => {
  const [feature, lines] = arg.split(':');
  return { feature, lines: lines === undefined ? undefined : new Set(lines.split(',').map(Number)) };
});
const spec = loadSpec(SPEC_ROOT)
  .map((feature) => {
    const name = featureName(feature.path);
    const wanted = filters.filter((f) => f.feature === name);
    if (filters.length > 0 && wanted.length === 0) return undefined;
    const lines = filters.length === 0 || wanted.some((f) => f.lines === undefined) ? undefined : new Set(wanted.flatMap((f) => [...(f.lines ?? [])]));
    return { ...feature, scenarios: feature.scenarios.filter((s) => lines === undefined || lines.has(s.line)) };
  })
  .filter((f): f is NonNullable<typeof f> => f !== undefined);

const base = { deviations: loadDeviations(join(PROJECT_ROOT, 'deviations.yaml')), notApplicable: [], ownerResolves: () => true };
const server = new TypeDBServer({ url: process.env.TYPEDB_URL });
const key = (r: ScenarioResult): string => `${r.feature}:${r.scenario.line}`;
const oracle = new Map(runSpec(spec, { ...base, open: () => server.open() }).map((r) => [key(r), r] as const));
server.close();
const lite = runSpec(spec, base);

const failed = (r: ScenarioResult | undefined): boolean => r !== undefined && (r.outcome === 'fail' || r.outcome === 'deviation');
const reason = (r: ScenarioResult | undefined): string => (r?.failure ? `@L${r.failure.step.line} ${r.failure.reason.replace(/\s+/g, ' ').slice(0, 400)}` : '');
const groups = { gap: [] as string[], both: [] as string[], liteOnly: [] as string[] };
let agree = 0;
for (const r of lite) {
  const o = oracle.get(key(r));
  const line = `${key(r)} [${r.scenario.name}]`;
  if (failed(r) && !failed(o)) groups.gap.push(`${line}\n    TypeDBLite ${reason(r)}`);
  else if (failed(r) && failed(o)) groups.both.push(`${line}\n    TypeDB     ${reason(o)}\n    TypeDBLite ${reason(r)}`);
  else if (!failed(r) && failed(o)) groups.liteOnly.push(`${line}\n    TypeDB     ${reason(o)}`);
  else agree += 1;
}
console.log(`${lite.length} scenario(s): ${agree} pass on both`);
console.log(`\n── TypeDB passes, TypeDBLite fails (${groups.gap.length}) ──\n${groups.gap.join('\n')}`);
console.log(`\n── both fail (${groups.both.length}) ──\n${groups.both.join('\n')}`);
console.log(`\n── TypeDB fails, TypeDBLite passes (${groups.liteOnly.length}) ──\n${groups.liteOnly.join('\n')}`);
