/**
 * Several processes writing one store must wait for the write lock, never fail for it.
 *
 * 🔴 `execute()` opened its transaction with a plain (deferred) `BEGIN`. A write pipeline reads
 * before it writes, so it held a read snapshot and then had to upgrade it; when another process had
 * committed in between, SQLite returned SQLITE_BUSY at once, and `busy_timeout` does not apply to
 * that upgrade. Two downstream-app processes sharing `.mvp/` lost ~30% of their writes this way
 * (docs/development/performance.md). `BEGIN IMMEDIATE` takes the write lock first, so the wait is
 * an ordinary busy wait.
 *
 * Real child processes, started at a shared instant: an in-process pair shares a connection's
 * lock and proves nothing (`durability.test.ts`).
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/contending-writer.ts', import.meta.url));

interface Report {
  ops: number;
  failures: number;
  error?: string;
}

const writer = (path: string, prefix: string, startAt: number, durationMs: number): Promise<Report> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE, path, prefix, String(startAt), String(durationMs)]);
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += String(chunk)));
    child.stderr.on('data', (chunk) => (err += String(chunk)));
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`writer ${prefix} exited ${code}: ${err}`));
      else resolve(JSON.parse(out.trim().split('\n').pop() ?? '{}') as Report);
    });
  });

describe('write-lock contention between processes', () => {
  it('🔴 every write waits for the lock and none fails, with four processes rewriting at once', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'typedblite-contention-')), 'store.db');
    const setup = new TypeDBLiteInterpreter(path);
    setup.define('define entity record, owns record-id @key, owns revision; attribute record-id, value string; attribute revision, value integer;');
    setup.close();

    // Far enough ahead for every child to have started tsx and opened the store.
    const startAt = Date.now() + 4000;
    const reports = await Promise.all(['a', 'b', 'c', 'd'].map((prefix) => writer(path, prefix, startAt, 2000)));

    for (const [index, report] of reports.entries()) {
      assert.ok(report.ops > 0, `writer ${index} made no progress`);
      assert.equal(report.failures, 0, `writer ${index} failed ${report.failures} of ${report.ops + report.failures} writes: ${report.error}`);
    }
    // Each writer cycles through 20 keys of its own, deleting and re-inserting: every key it reached
    // is there exactly once — waiting lost no write and doubled none.
    const reader = new TypeDBLiteInterpreter(path);
    const ids = reader.query('match $r isa record, has record-id $id; select $id;').rows.map((row) => row['id']?.asString());
    assert.equal(new Set(ids).size, ids.length, 'a key is held twice');
    assert.equal(ids.length, reports.reduce((sum, r) => sum + Math.min(20, r.ops), 0));
    reader.close();
  }, 30_000);
});
