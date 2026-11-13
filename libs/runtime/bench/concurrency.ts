/**
 * Several processes on one store file — the shape downstream-app runs in (two `mvp --mcp` processes
 * share `.mvp/`). Writers run the workflow engine's `saveStep()` on disjoint partitions of the steps,
 * so every failure is the engine's and none is a logical conflict; readers run `find()`-style reads.
 *
 * The parent spawns each worker as `node --import tsx concurrency.ts worker …`.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freshCopy, open, sampleValues, str, table, type Row } from './harness.js';

const CONFIGURATIONS: ReadonlyArray<readonly [writers: number, readers: number]> = [
  [1, 0],
  [2, 0],
  [4, 0],
  [2, 2],
  [4, 4],
];

interface WorkerReport {
  role: 'writer' | 'reader';
  ops: number;
  errors: number;
  messages: Record<string, number>;
  p50: number;
  p99: number;
  max: number;
}

export async function run(source: string, work: string, seconds: number): Promise<void> {
  console.log(`\n## concurrency — processes sharing ${source.split('/').pop()}, ${seconds} s per configuration`);
  const file = `${work}/concurrency.db`;
  const rows: Row[] = [];
  for (const [writers, readers] of CONFIGURATIONS) {
    freshCopy(source, file);
    open(file).close(); // open-time setup happens once, before the race
    const roles = [
      ...Array.from({ length: writers }, (_, i) => ['writer', i, writers] as const),
      ...Array.from({ length: readers }, (_, i) => ['reader', i, readers] as const),
    ];
    const reports = await Promise.all(roles.map(([role, index, of]) => worker(file, role, index, of, seconds)));
    const of = (role: string): WorkerReport[] => reports.filter((r) => r.role === role);
    const sum = (rs: WorkerReport[], k: 'ops' | 'errors'): number => rs.reduce((a, r) => a + r[k], 0);
    const worst = (rs: WorkerReport[], k: 'p50' | 'p99' | 'max'): number => Math.max(0, ...rs.map((r) => r[k]));
    const row: Row = {
      configuration: `${writers}W+${readers}R`,
      saveStepsPerSecond: sum(of('writer'), 'ops') / seconds,
      writerP50: worst(of('writer'), 'p50'),
      writerP99: worst(of('writer'), 'p99'),
      writerErrors: sum(of('writer'), 'errors'),
      readsPerSecond: sum(of('reader'), 'ops') / seconds,
      readerP99: worst(of('reader'), 'p99'),
      readerErrors: sum(of('reader'), 'errors'),
    };
    rows.push(row);
    console.log(`  ${String(row['configuration']).padEnd(6)} saveStep/s ${(row['saveStepsPerSecond'] as number).toFixed(0).padStart(4)}  writer p50 ${(row['writerP50'] as number).toFixed(1).padStart(6)}  p99 ${(row['writerP99'] as number).toFixed(0).padStart(5)} ms  errors ${String(row['writerErrors']).padStart(5)}   reads/s ${(row['readsPerSecond'] as number).toFixed(0).padStart(5)}  reader p99 ${(row['readerP99'] as number).toFixed(1)} ms  errors ${row['readerErrors']}`);
    for (const r of reports) if (r.errors > 0) console.log(`    ${r.role}: ${JSON.stringify(r.messages)}`);
  }
  table('concurrency', rows);
}

function worker(file: string, role: string, index: number, of: number, seconds: number): Promise<WorkerReport> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), 'worker', file, role, String(index), String(of), String(seconds)], { env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL('./tsconfig.json', import.meta.url)) } });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    child.on('close', (code) => {
      const last = out.trim().split('\n').pop();
      if (code !== 0 || last === undefined) reject(new Error(`worker exited ${code}`));
      else resolve(JSON.parse(last) as WorkerReport);
    });
  });
}

function workerMain([file, role, index, of, seconds]: string[]): void {
  if (file === undefined || role === undefined) throw new Error('usage: concurrency.ts worker <file> <role> <index> <of> <seconds>');
  const db = open(file);
  const latencies: number[] = [];
  const messages: Record<string, number> = {};
  let errors = 0;
  const steps = sampleValues(file, `SELECT value FROM attribute WHERE type = 'workflow-step-id' ORDER BY value`, 1_000_000).filter((_, i) => i % Number(of) === Number(index));
  const workflows = sampleValues(file, `SELECT value FROM attribute WHERE type = 'workflow-id'`, 500);
  const end = performance.now() + Number(seconds) * 1000;
  for (let i = 0; performance.now() < end; i++) {
    const start = performance.now();
    try {
      if (role === 'writer') {
        const step = steps[i % steps.length] ?? '';
        const [workflow, name = 'x'] = step.split('::') as [string, string?];
        db.execute(`match $s isa workflow-step-record, has workflow-step-id ${str(step)}; delete $s;`);
        db.execute(`insert $s isa workflow-step-record, has workflow-step-id ${str(step)}, has workflow-step-workflow ${str(workflow)}, has workflow-step-name ${str(name)}, has workflow-step-status "completed";`);
        db.execute(`insert $h isa workflow-history-entry, has workflow-history-id ${str(`${workflow}::c${index}-${i}`)}, has workflow-history-workflow ${str(workflow)}, has workflow-history-step ${str(name)}, has workflow-history-from "a", has workflow-history-to "b", has workflow-history-at 2026-11-12T10:00:00;`);
      } else {
        const workflow = workflows[i % workflows.length] ?? '';
        db.query(`match $w isa workflow, has workflow-id ${str(workflow)}, has workflow-input $input; select $input;`);
        for (const c of ['workflow-step-name', 'workflow-step-status']) {
          db.query(`match $x isa workflow-step-record, has workflow-step-id $id, has workflow-step-workflow ${str(workflow)}, has ${c} $value; select $id, $value;`);
        }
      }
      latencies.push(performance.now() - start);
    } catch (error) {
      errors++;
      const message = String((error as Error).message).slice(0, 80);
      messages[message] = (messages[message] ?? 0) + 1;
    }
  }
  latencies.sort((a, b) => a - b);
  const at = (p: number): number => latencies[Math.floor(latencies.length * p)] ?? 0;
  const report: WorkerReport = { role: role as WorkerReport['role'], ops: latencies.length, errors, messages, p50: at(0.5), p99: at(0.99), max: latencies.at(-1) ?? 0 };
  console.log(JSON.stringify(report));
  db.close();
}

if (process.argv[2] === 'worker') workerMain(process.argv.slice(3));
