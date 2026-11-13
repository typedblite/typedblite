/**
 * Results files side by side, as Markdown tables — the first is the baseline the speed-up is
 * measured from, the last is the run it is measured to:
 *
 *   npx tsx --tsconfig ../../tsconfig.base.json bench/compare.ts <before.json> [<middle.json> …] <after.json>
 *
 * An operation a run did not measure (an older harness) shows as `—`.
 */
import { readFileSync } from 'node:fs';
import { ms, type Results, type Row } from './harness.js';

const paths = process.argv.slice(2);
if (paths.length < 2) throw new Error('usage: compare.ts <before.json> [<middle.json> …] <after.json>');
const runs = paths.map((p) => JSON.parse(readFileSync(p, 'utf8')) as Results);
const first = runs[0] as Results;
const last = runs[runs.length - 1] as Results;

const speedup = (b: number | undefined, a: number | undefined): string => (b !== undefined && a !== undefined && a > 0 ? `${(b / a).toFixed(1)}×` : '—');
const cell = (v: number | string | undefined): string => (v === undefined ? '—' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : ms(v)) : v);
const lines: string[] = [`Runs: ${runs.map((r) => `${r.label} (\`${r.commit}\`)`).join(', ')}. ${last.machine}.`, ''];

// Every operation any run measured, in the order the runs first measured them.
const suites = [...new Set(runs.flatMap((r) => r.measurements.map((m) => m.suite)))];
for (const suite of suites) {
  const names = [...new Set(runs.flatMap((r) => r.measurements.filter((m) => m.suite === suite).map((m) => m.name)))];
  lines.push(`### ${suite}`, '', `| Operation | Rows | ${runs.map((r) => `${r.label} p50`).join(' | ')} | ${first.label} → ${last.label} (p50) |`, `| --- | ---: | ${runs.map(() => '---:').join(' | ')} | ---: |`);
  for (const name of names) {
    const found = runs.map((r) => r.measurements.find((m) => m.suite === suite && m.name === name));
    const rows = [...found].reverse().find((m) => m?.rows !== undefined)?.rows;
    lines.push(`| ${name} | ${rows === undefined ? '' : rows.toFixed(0)} | ${found.map((m) => cell(m?.p50)).join(' | ')} | ${speedup(found[0]?.p50, found[found.length - 1]?.p50)} |`);
  }
  lines.push('');
}

for (const name of [...new Set(runs.flatMap((r) => Object.keys(r.tables)))]) {
  const tables: Row[][] = runs.map((r) => r.tables[name] ?? []);
  const [key, ...columns] = Object.keys(tables.find((t) => t.length > 0)?.[0] ?? {});
  if (key === undefined) continue;
  lines.push(`### ${name}`, '', `| ${key} | ${columns.join(' | ')} |`, `| --- | ${columns.map(() => '---:').join(' | ')} |`);
  const keys = [...new Set(tables.flatMap((t) => t.map((row) => row[key])))];
  for (const k of keys) {
    const matches = tables.map((t) => t.find((row) => row[key] === k));
    lines.push(`| ${cell(k)} | ${columns.map((c) => matches.map((m) => cell(m?.[c])).join(' → ')).join(' | ')} |`);
  }
  lines.push('');
}
console.log(lines.join('\n'));
