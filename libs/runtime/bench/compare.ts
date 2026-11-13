/**
 * Two results files side by side, as Markdown tables:
 *
 *   npx tsx --tsconfig ../../tsconfig.base.json bench/compare.ts <before.json> <after.json>
 */
import { readFileSync } from 'node:fs';
import { ms, type Measurement, type Results, type Row } from './harness.js';

const [beforePath, afterPath] = process.argv.slice(2);
if (beforePath === undefined || afterPath === undefined) throw new Error('usage: compare.ts <before.json> <after.json>');
const before = JSON.parse(readFileSync(beforePath, 'utf8')) as Results;
const after = JSON.parse(readFileSync(afterPath, 'utf8')) as Results;

const speedup = (b: number, a: number): string => (a > 0 ? `${(b / a).toFixed(1)}×` : '—');
const lines: string[] = [`Before: \`${before.commit}\` (${before.label}). After: \`${after.commit}\` (${after.label}). ${after.machine}.`, ''];

for (const suite of [...new Set(before.measurements.map((m) => m.suite))]) {
  lines.push(`#### ${suite}`, '', '| Operation | Rows | Before p50 | After p50 | Before p95 | After p95 | Speed-up (p50) |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const b of before.measurements.filter((m) => m.suite === suite)) {
    const a: Measurement | undefined = after.measurements.find((m) => m.suite === suite && m.name === b.name);
    if (a === undefined) continue;
    lines.push(`| ${b.name} | ${a.rows === undefined ? '' : a.rows.toFixed(0)} | ${ms(b.p50)} | ${ms(a.p50)} | ${ms(b.p95)} | ${ms(a.p95)} | ${speedup(b.p50, a.p50)} |`);
  }
  lines.push('');
}

const cell = (v: number | string | undefined): string => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : ms(v)) : (v ?? ''));
for (const name of Object.keys(before.tables)) {
  const b: Row[] = before.tables[name] ?? [];
  const a: Row[] = after.tables[name] ?? [];
  const [key, ...columns] = Object.keys(b[0] ?? {});
  if (key === undefined) continue;
  lines.push(`#### ${name}`, '', `| ${key} | ${columns.map((c) => `${c} before → after`).join(' | ')} |`, `| --- | ${columns.map(() => '---:').join(' | ')} |`);
  for (const row of b) {
    const match = a.find((r) => r[key] === row[key]);
    lines.push(`| ${cell(row[key])} | ${columns.map((c) => `${cell(row[c])} → ${cell(match?.[c])}`).join(' | ')} |`);
  }
  lines.push('');
}
console.log(lines.join('\n'));
