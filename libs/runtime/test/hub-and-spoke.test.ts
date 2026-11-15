/**
 * Hub and spokes as separate OS processes, converging.
 *
 * Phase 03 has no transport — that is Phase 04 — so a spoke reaches the hub by opening its SQLite
 * file directly. That is a genuine second writer, which is the property being tested: convergence
 * under real contention rather than convergence in one process's imagination.
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { TypeDBLiteInterpreter } from '../src/interpreter.js';
import { replicateOnce } from '../src/replicator.js';
import { readKeyedTrackerSchema } from './fixtures/keyed-tracker-schema.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCHEMAS = fileURLToPath(new URL('../../../test-fixtures/schemas/', import.meta.url));
const SCHEMA = join(SCHEMAS, 'tracker.schema.typeqlite');

const runSpoke = (args: string[]) =>
  new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      join(HERE, 'fixtures', 'spoke.ts'),
      ...args,
    ]);
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('close', (code) => resolve({ code, stderr }));
  });

describe('hub and spokes converge', () => {
  it('🔴 three spoke processes replicating concurrently all reach the hub', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'typedblite-hub-'));
    const hubPath = join(dir, 'hub.db');

    const setup = new TypeDBLiteInterpreter(hubPath);
    setup.define(readKeyedTrackerSchema(SCHEMA));
    setup.close();

    const spokes = ['alpha', 'beta', 'gamma'];
    const perSpoke = 4;
    // All three start before any finishes, so they contend for the hub's write lock.
    const results = await Promise.all(
      spokes.map((prefix) =>
        runSpoke([
          join(dir, `${prefix}.db`),
          hubPath,
          SCHEMA,
          prefix,
          String(perSpoke),
        ]),
      ),
    );
    for (const [index, result] of results.entries()) {
      assert.equal(result.code, 0, `spoke ${spokes[index]} failed: ${result.stderr}`);
    }

    const hub = new TypeDBLiteInterpreter(hubPath);
    const ids = hub
      .query('match $s isa project, has project-id $id; select $id;')
      .rows.map((row) => row['id']?.asString())
      .sort();

    assert.equal(
      ids.length,
      spokes.length * perSpoke,
      'every spoke’s writes must reach the hub',
    );
    for (const prefix of spokes) {
      assert.equal(
        ids.filter((id) => id?.startsWith(`${prefix}-`)).length,
        perSpoke,
        `${prefix} lost writes to contention`,
      );
    }
    hub.close();
  });

  it('a spoke that pulls afterwards sees every other spoke’s work', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'typedblite-hub2-'));
    const hubPath = join(dir, 'hub.db');
    const schema = readKeyedTrackerSchema(SCHEMA);

    const setup = new TypeDBLiteInterpreter(hubPath);
    setup.define(schema);
    setup.close();

    const spokes = ['alpha', 'beta'];
    await Promise.all(
      spokes.map((prefix) =>
        runSpoke([join(dir, `${prefix}.db`), hubPath, SCHEMA, prefix, '3']),
      ),
    );

    // A late spoke joins and pulls: it should end up holding both other spokes' work.
    const late = new TypeDBLiteInterpreter(join(dir, 'late.db'));
    late.define(schema);
    const hub = new TypeDBLiteInterpreter(hubPath);
    const outcome = replicateOnce(late.changeLog, hub.changeLog, { direction: 'pull' });

    const ids = late
      .query('match $s isa project, has project-id $id; select $id;')
      .rows.map((row) => row['id']?.asString())
      .sort();

    assert.equal(outcome.applied, 6);
    assert.equal(ids.length, 6, 'a late spoke must catch up in one pull');
    late.close();
    hub.close();
  });
});
